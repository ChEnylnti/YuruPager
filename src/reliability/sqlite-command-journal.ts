import { DatabaseSync, type StatementSync } from "node:sqlite";

export type CommandDeliveryState = "prepared" | "sent_unknown" | "delivered" | "failed";

export interface CommandDeliveryRecord {
  commandId: string;
  threadId: string;
  payloadHash: string;
  state: CommandDeliveryState;
  turnId: string | null;
  errorCode: string | null;
  updatedAt: string;
}

interface CommandRow {
  command_id: string;
  thread_id: string;
  payload_hash: string | null;
  state: string;
  turn_id: string | null;
  error_code: string | null;
  updated_at: string;
}

export class SqliteCommandJournal {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;
  readonly #get: StatementSync;
  readonly #insert: StatementSync;
  readonly #transition: StatementSync;
  readonly #listByState: StatementSync;
  readonly #bindLegacyHash: StatementSync;

  constructor(path: string, now: () => Date = () => new Date()) {
    this.#now = now;
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS session_command_delivery (
        command_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        payload_hash TEXT,
        state TEXT NOT NULL CHECK (state IN ('prepared', 'sent_unknown', 'delivered', 'failed')),
        turn_id TEXT,
        error_code TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    const columns = this.#database.prepare("PRAGMA table_info(session_command_delivery)").all() as Array<{ name?: unknown }>;
    if (!columns.some((column) => column.name === "payload_hash")) {
      this.#database.exec("ALTER TABLE session_command_delivery ADD COLUMN payload_hash TEXT");
    }
    this.#get = this.#database.prepare("SELECT * FROM session_command_delivery WHERE command_id = ?");
    this.#insert = this.#database.prepare(`
      INSERT INTO session_command_delivery
        (command_id, thread_id, payload_hash, state, turn_id, error_code, updated_at)
      VALUES (?, ?, ?, 'prepared', NULL, NULL, ?)
      ON CONFLICT(command_id) DO NOTHING
    `);
    this.#transition = this.#database.prepare(`
      UPDATE session_command_delivery
         SET state = ?, turn_id = ?, error_code = ?, updated_at = ?
       WHERE command_id = ? AND state = ?
    `);
    this.#listByState = this.#database.prepare(
      "SELECT * FROM session_command_delivery WHERE state = ? ORDER BY updated_at",
    );
    this.#bindLegacyHash = this.#database.prepare(`
      UPDATE session_command_delivery SET payload_hash = ? WHERE command_id = ? AND payload_hash IS NULL
    `);
  }

  prepare(commandId: string, threadId: string, payloadHash: string): CommandDeliveryRecord {
    requireText(commandId, "commandId");
    requireText(threadId, "threadId");
    requirePayloadHash(payloadHash);
    this.#insert.run(commandId, threadId, payloadHash, this.#now().toISOString());
    this.#bindLegacyHash.run(payloadHash, commandId);
    const record = this.#require(commandId);
    if (record.threadId !== threadId) throw new Error("Session command is bound to another thread");
    if (record.payloadHash !== payloadHash) throw new Error("Session command payload does not match its idempotency key");
    return record;
  }

  beginDispatch(commandId: string): CommandDeliveryRecord {
    return this.#mark(commandId, "prepared", "sent_unknown", null, null);
  }

  markDelivered(commandId: string, turnId: string): CommandDeliveryRecord {
    requireText(turnId, "turnId");
    return this.#mark(commandId, "sent_unknown", "delivered", turnId, null);
  }

  markFailed(commandId: string, errorCode: string): CommandDeliveryRecord {
    requireText(errorCode, "errorCode");
    return this.#mark(commandId, "prepared", "failed", null, errorCode);
  }

  get(commandId: string): CommandDeliveryRecord | undefined {
    requireText(commandId, "commandId");
    const row = readRow(this.#get.get(commandId));
    return row === undefined ? undefined : toRecord(row);
  }

  listByState(state: CommandDeliveryState): CommandDeliveryRecord[] {
    return this.#listByState.all(state).map((value) => toRecord(requireRow(value)));
  }

  close(): void {
    this.#database.close();
  }

  #mark(
    commandId: string,
    expected: CommandDeliveryState,
    next: CommandDeliveryState,
    turnId: string | null,
    errorCode: string | null,
  ): CommandDeliveryRecord {
    requireText(commandId, "commandId");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#transition.run(
        next,
        turnId,
        errorCode,
        this.#now().toISOString(),
        commandId,
        expected,
      );
      if (result.changes !== 1) {
        const current = this.get(commandId);
        throw new Error(`Session command transition ${expected} -> ${next} rejected (current=${current?.state ?? "missing"})`);
      }
      this.#database.exec("COMMIT");
      return this.#require(commandId);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #require(commandId: string): CommandDeliveryRecord {
    const record = this.get(commandId);
    if (record === undefined) throw new Error(`Missing session command delivery: ${commandId}`);
    return record;
  }
}

function requireText(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} is required`);
}

function requireRow(value: unknown): CommandRow {
  const row = readRow(value);
  if (row === undefined) throw new Error("Missing session command row");
  return row;
}

function readRow(value: unknown): CommandRow | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) throw new Error("Invalid session command row");
  const row = value as Record<string, unknown>;
  if (
    typeof row.command_id !== "string" ||
    typeof row.thread_id !== "string" ||
    (row.payload_hash !== null && typeof row.payload_hash !== "string") ||
    typeof row.state !== "string" ||
    (row.turn_id !== null && typeof row.turn_id !== "string") ||
    (row.error_code !== null && typeof row.error_code !== "string") ||
    typeof row.updated_at !== "string"
  ) {
    throw new Error("Invalid session command row fields");
  }
  return {
    command_id: row.command_id,
    thread_id: row.thread_id,
    payload_hash: row.payload_hash,
    state: row.state,
    turn_id: row.turn_id,
    error_code: row.error_code,
    updated_at: row.updated_at,
  };
}

function toRecord(row: CommandRow): CommandDeliveryRecord {
  if (!isState(row.state)) throw new Error(`Invalid session command state: ${row.state}`);
  if (row.payload_hash === null) throw new Error("Session command payload hash is missing");
  requirePayloadHash(row.payload_hash);
  return {
    commandId: row.command_id,
    threadId: row.thread_id,
    payloadHash: row.payload_hash,
    state: row.state,
    turnId: row.turn_id,
    errorCode: row.error_code,
    updatedAt: row.updated_at,
  };
}

function requirePayloadHash(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("payloadHash must be a lowercase SHA-256 digest");
}

function isState(value: string): value is CommandDeliveryState {
  return value === "prepared" || value === "sent_unknown" || value === "delivered" || value === "failed";
}
