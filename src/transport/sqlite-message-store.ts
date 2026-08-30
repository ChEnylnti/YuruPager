import { randomUUID } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { ConnectorPayload, TransportEnvelope } from "@yurupager/shared";

interface OutboxRow {
  message_id: string;
  sequence: number;
  envelope_json: string;
}

export class SqliteMessageStore {
  readonly #database: DatabaseSync;
  readonly #streamId: string;
  readonly #connectionEpoch: string;
  readonly #getMeta: StatementSync;
  readonly #setMeta: StatementSync;
  readonly #insertOutbox: StatementSync;
  readonly #pendingOutbox: StatementSync;
  readonly #ackMessage: StatementSync;
  readonly #ackThrough: StatementSync;
  readonly #insertInbox: StatementSync;
  readonly #getInbox: StatementSync;
  readonly #markInboxProcessed: StatementSync;
  readonly #markInboxProcessedRedacted: StatementSync;
  readonly #latestInboxSequence: StatementSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS transport_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS transport_outbox (
        message_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE CHECK (sequence > 0),
        envelope_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS transport_inbox (
        message_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        processed_at TEXT
      ) STRICT;
    `);
    this.#getMeta = this.#database.prepare("SELECT value FROM transport_meta WHERE key = ?");
    this.#setMeta = this.#database.prepare(
      "INSERT INTO transport_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    this.#insertOutbox = this.#database.prepare(
      `INSERT INTO transport_outbox (message_id, sequence, envelope_json, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    this.#pendingOutbox = this.#database.prepare(
      `SELECT message_id, sequence, envelope_json FROM transport_outbox
       WHERE acknowledged_at IS NULL ORDER BY sequence`,
    );
    this.#ackMessage = this.#database.prepare(
      "UPDATE transport_outbox SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE message_id = ?",
    );
    this.#ackThrough = this.#database.prepare(
      "UPDATE transport_outbox SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE sequence <= ?",
    );
    this.#insertInbox = this.#database.prepare(
      `INSERT INTO transport_inbox (message_id, sequence, payload_json, received_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING`,
    );
    this.#getInbox = this.#database.prepare(
      "SELECT processed_at FROM transport_inbox WHERE message_id = ?",
    );
    this.#markInboxProcessed = this.#database.prepare(
      "UPDATE transport_inbox SET processed_at = COALESCE(processed_at, ?) WHERE message_id = ?",
    );
    this.#markInboxProcessedRedacted = this.#database.prepare(
      `UPDATE transport_inbox
          SET processed_at = COALESCE(processed_at, ?), payload_json = '{"redacted":true}'
        WHERE message_id = ?`,
    );
    this.#latestInboxSequence = this.#database.prepare(
      "SELECT COALESCE(max(sequence), 0) AS sequence FROM transport_inbox WHERE processed_at IS NOT NULL",
    );

    this.#streamId = this.#meta("stream_id") ?? randomUUID();
    this.#connectionEpoch = randomUUID();
    this.#setMeta.run("stream_id", this.#streamId);
    this.#setMeta.run("connection_epoch", this.#connectionEpoch);
  }

  get streamId(): string {
    return this.#streamId;
  }

  get connectionEpoch(): string {
    return this.#connectionEpoch;
  }

  enqueue(payload: ConnectorPayload, idempotencyKey: string = randomUUID()): TransportEnvelope<ConnectorPayload> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = Number(this.#meta("next_sequence") ?? "1");
      if (!Number.isSafeInteger(current) || current < 1) throw new Error("Invalid transport sequence");
      const sequencedPayload: ConnectorPayload =
        payload.type === "token.snapshot" ? { ...payload, sequence: current } : payload;
      const envelope: TransportEnvelope<ConnectorPayload> = {
        type: "event",
        protocolVersion: 1,
        messageId: randomUUID(),
        streamId: this.#streamId,
        connectionEpoch: this.#connectionEpoch,
        sequence: current,
        timestamp: new Date().toISOString(),
        idempotencyKey,
        payload: sequencedPayload,
      };
      this.#insertOutbox.run(envelope.messageId, envelope.sequence, JSON.stringify(envelope), envelope.timestamp);
      this.#setMeta.run("next_sequence", String(current + 1));
      this.#database.exec("COMMIT");
      return envelope;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  pending(): TransportEnvelope<ConnectorPayload>[] {
    return this.#pendingOutbox.all().map((value) => {
      const row = readOutboxRow(value);
      const envelope = JSON.parse(row.envelope_json) as TransportEnvelope<ConnectorPayload>;
      if (envelope.messageId !== row.message_id || envelope.sequence !== row.sequence) {
        throw new Error("Transport outbox envelope does not match indexed identity");
      }
      return envelope;
    });
  }

  acknowledge(messageId: string): void {
    this.#ackMessage.run(new Date().toISOString(), messageId);
  }

  acknowledgeThrough(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid ACK cursor");
    this.#ackThrough.run(new Date().toISOString(), sequence);
  }

  acceptInbound(messageId: string, sequence: number, payload: unknown): boolean {
    this.#insertInbox.run(
      messageId,
      sequence,
      JSON.stringify(payload),
      new Date().toISOString(),
    );
    const row = this.#getInbox.get(messageId);
    if (typeof row !== "object" || row === null || !("processed_at" in row)) {
      throw new Error("Inbound message was not persisted");
    }
    return row.processed_at === null;
  }

  markInboundProcessed(messageId: string, redact = false): void {
    const statement = redact ? this.#markInboxProcessedRedacted : this.#markInboxProcessed;
    statement.run(new Date().toISOString(), messageId);
  }

  latestInboundSequence(): number {
    const value = this.#latestInboxSequence.get();
    if (typeof value !== "object" || value === null || !("sequence" in value)) return 0;
    const sequence = Number(value.sequence);
    return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0;
  }

  close(): void {
    this.#database.close();
  }

  #meta(key: string): string | undefined {
    const value = this.#getMeta.get(key);
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null || !("value" in value) || typeof value.value !== "string") {
      throw new Error("Invalid transport metadata");
    }
    return value.value;
  }
}

function readOutboxRow(value: unknown): OutboxRow {
  if (typeof value !== "object" || value === null) throw new Error("Invalid transport outbox row");
  const row = value as Record<string, unknown>;
  if (typeof row.message_id !== "string" || typeof row.sequence !== "number" || typeof row.envelope_json !== "string") {
    throw new Error("Invalid transport outbox fields");
  }
  return { message_id: row.message_id, sequence: row.sequence, envelope_json: row.envelope_json };
}
