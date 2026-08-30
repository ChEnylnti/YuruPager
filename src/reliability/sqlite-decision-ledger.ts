import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { ApprovalDecision } from "../codex/domain.js";
import {
  DecisionConflictError,
  type DecisionRecord,
  type DecisionResult,
  decisionFingerprint,
} from "./decision-gate.js";

interface DecisionRow {
  request_id: string;
  idempotency_key: string;
  payload_hash: string;
  decision: string;
  decided_at: string;
}

export class SqliteDecisionLedger {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;
  readonly #getByRequest: StatementSync;
  readonly #getByKey: StatementSync;
  readonly #insert: StatementSync;

  constructor(path: string, now: () => Date = () => new Date()) {
    this.#now = now;
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS approval_decisions (
        request_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('approve', 'deny', 'cancel')),
        decided_at TEXT NOT NULL
      ) STRICT;
    `);
    this.#getByRequest = this.#database.prepare(
      "SELECT * FROM approval_decisions WHERE request_id = ?",
    );
    this.#getByKey = this.#database.prepare(
      "SELECT * FROM approval_decisions WHERE idempotency_key = ?",
    );
    this.#insert = this.#database.prepare(`
      INSERT INTO approval_decisions (
        request_id, idempotency_key, payload_hash, decision, decided_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
  }

  decide(
    requestId: string,
    idempotencyKey: string,
    decision: ApprovalDecision,
  ): DecisionResult {
    if (requestId.length === 0 || idempotencyKey.length === 0) {
      throw new Error("requestId and idempotencyKey are required");
    }
    const payloadHash = decisionFingerprint(requestId, decision);

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = toRow(this.#getByRequest.get(requestId));
      if (existing !== undefined) {
        const record = toRecord(existing);
        if (
          existing.idempotency_key === idempotencyKey &&
          existing.payload_hash === payloadHash &&
          record.decision === decision
        ) {
          this.#database.exec("COMMIT");
          return { accepted: true, replayed: true, record };
        }
        throw new DecisionConflictError(
          "Approval request already has a final decision",
          record,
        );
      }

      const existingKey = toRow(this.#getByKey.get(idempotencyKey));
      if (existingKey !== undefined) {
        throw new Error("Idempotency key is already bound to another payload");
      }

      const record: DecisionRecord = {
        requestId,
        idempotencyKey,
        decision,
        decidedAt: this.#now().toISOString(),
      };
      this.#insert.run(
        requestId,
        idempotencyKey,
        payloadHash,
        decision,
        record.decidedAt,
      );
      this.#database.exec("COMMIT");
      return { accepted: true, replayed: false, record };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  get(requestId: string): DecisionRecord | undefined {
    const row = toRow(this.#getByRequest.get(requestId));
    return row === undefined ? undefined : toRecord(row);
  }

  close(): void {
    this.#database.close();
  }
}

function toRow(value: unknown): DecisionRow | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("request_id" in value) ||
    !("idempotency_key" in value) ||
    !("payload_hash" in value) ||
    !("decision" in value) ||
    !("decided_at" in value)
  ) {
    throw new Error("Invalid decision row returned by SQLite");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.request_id !== "string" ||
    typeof row.idempotency_key !== "string" ||
    typeof row.payload_hash !== "string" ||
    typeof row.decision !== "string" ||
    typeof row.decided_at !== "string"
  ) {
    throw new Error("Invalid decision row field type");
  }
  return {
    request_id: row.request_id,
    idempotency_key: row.idempotency_key,
    payload_hash: row.payload_hash,
    decision: row.decision,
    decided_at: row.decided_at,
  };
}

function toRecord(row: DecisionRow): DecisionRecord {
  if (
    row.decision !== "approve" &&
    row.decision !== "deny" &&
    row.decision !== "cancel"
  ) {
    throw new Error("Invalid decision stored in SQLite");
  }
  return {
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    decision: row.decision,
    decidedAt: row.decided_at,
  };
}

