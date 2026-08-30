import { DatabaseSync, type StatementSync } from "node:sqlite";

export type ApprovalDeliveryState =
  | "prepared"
  | "sent_unknown"
  | "delivered"
  | "reconciled_completed"
  | "resolved_externally";

export interface ApprovalDeliveryRecord {
  requestId: string;
  state: ApprovalDeliveryState;
  attemptCount: number;
  updatedAt: string;
  resolution: string | null;
}

interface DeliveryRow {
  request_id: string;
  state: string;
  attempt_count: number;
  updated_at: string;
  resolution: string | null;
}

export class AmbiguousDeliveryError extends Error {
  override readonly name = "AmbiguousDeliveryError";
}

export class SqliteApprovalJournal {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;
  readonly #get: StatementSync;
  readonly #prepare: StatementSync;
  readonly #beginDispatch: StatementSync;
  readonly #transition: StatementSync;
  readonly #listByState: StatementSync;

  constructor(path: string, now: () => Date = () => new Date()) {
    this.#now = now;
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS approval_delivery_journal (
        request_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN (
          'prepared',
          'sent_unknown',
          'delivered',
          'reconciled_completed',
          'resolved_externally'
        )),
        attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
        updated_at TEXT NOT NULL,
        resolution TEXT
      ) STRICT;
    `);
    this.#get = this.#database.prepare(
      "SELECT * FROM approval_delivery_journal WHERE request_id = ?",
    );
    this.#prepare = this.#database.prepare(`
      INSERT INTO approval_delivery_journal (
        request_id, state, attempt_count, updated_at, resolution
      ) VALUES (?, 'prepared', 0, ?, NULL)
      ON CONFLICT(request_id) DO NOTHING
    `);
    this.#beginDispatch = this.#database.prepare(`
      UPDATE approval_delivery_journal
      SET state = 'sent_unknown',
          attempt_count = attempt_count + 1,
          updated_at = ?,
          resolution = NULL
      WHERE request_id = ? AND state = 'prepared'
    `);
    this.#transition = this.#database.prepare(`
      UPDATE approval_delivery_journal
      SET state = ?, updated_at = ?, resolution = ?
      WHERE request_id = ? AND state = ?
    `);
    this.#listByState = this.#database.prepare(
      "SELECT * FROM approval_delivery_journal WHERE state = ? ORDER BY updated_at",
    );
  }

  prepare(requestId: string): ApprovalDeliveryRecord {
    requireRequestId(requestId);
    this.#prepare.run(requestId, this.#now().toISOString());
    return this.#require(requestId);
  }

  beginDispatch(requestId: string): ApprovalDeliveryRecord {
    requireRequestId(requestId);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#read(requestId);
      if (existing === undefined) {
        throw new Error("Approval delivery must be prepared before dispatch");
      }
      if (existing.state === "sent_unknown") {
        throw new AmbiguousDeliveryError(
          "Approval response may already have reached Codex; automatic retry is forbidden",
        );
      }
      if (existing.state !== "prepared") {
        throw new Error(`Approval delivery is already final: ${existing.state}`);
      }
      this.#beginDispatch.run(this.#now().toISOString(), requestId);
      this.#database.exec("COMMIT");
      return this.#require(requestId);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  markDelivered(requestId: string): ApprovalDeliveryRecord {
    return this.#mark(
      requestId,
      "sent_unknown",
      "delivered",
      "codex_response_acknowledged",
    );
  }

  markReconciled(
    requestId: string,
    resolution: string,
  ): ApprovalDeliveryRecord {
    return this.#mark(
      requestId,
      "sent_unknown",
      "reconciled_completed",
      resolution,
    );
  }

  markResolvedExternally(
    requestId: string,
    resolution = "decision_unknown",
  ): ApprovalDeliveryRecord {
    const existing = this.#require(requestId);
    if (existing.state !== "prepared" && existing.state !== "sent_unknown") {
      throw new Error(`Cannot mark ${existing.state} as externally resolved`);
    }
    return this.#mark(
      requestId,
      existing.state,
      "resolved_externally",
      resolution,
    );
  }

  get(requestId: string): ApprovalDeliveryRecord | undefined {
    requireRequestId(requestId);
    return this.#read(requestId);
  }

  listByState(state: ApprovalDeliveryState): ApprovalDeliveryRecord[] {
    return this.#listByState.all(state).map((row) => toRecord(requireRow(row)));
  }

  close(): void {
    this.#database.close();
  }

  #mark(
    requestId: string,
    expected: ApprovalDeliveryState,
    state: ApprovalDeliveryState,
    resolution: string,
  ): ApprovalDeliveryRecord {
    requireRequestId(requestId);
    const result = this.#transition.run(
      state,
      this.#now().toISOString(),
      resolution,
      requestId,
      expected,
    );
    if (result.changes !== 1) {
      const existing = this.#read(requestId);
      throw new Error(
        `Approval delivery transition ${expected} -> ${state} rejected (current=${existing?.state ?? "missing"})`,
      );
    }
    return this.#require(requestId);
  }

  #require(requestId: string): ApprovalDeliveryRecord {
    const record = this.#read(requestId);
    if (record === undefined) {
      throw new Error(`Missing approval delivery: ${requestId}`);
    }
    return record;
  }

  #read(requestId: string): ApprovalDeliveryRecord | undefined {
    const row = toRow(this.#get.get(requestId));
    return row === undefined ? undefined : toRecord(row);
  }
}

function requireRow(value: unknown): DeliveryRow {
  const row = toRow(value);
  if (row === undefined) throw new Error("Missing approval delivery row");
  return row;
}

function requireRequestId(requestId: string): void {
  if (requestId.length === 0) {
    throw new Error("requestId is required");
  }
}

function toRow(value: unknown): DeliveryRow | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid approval delivery row");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.request_id !== "string" ||
    typeof row.state !== "string" ||
    typeof row.attempt_count !== "number" ||
    typeof row.updated_at !== "string" ||
    (row.resolution !== null && typeof row.resolution !== "string")
  ) {
    throw new Error("Invalid approval delivery row field type");
  }
  return {
    request_id: row.request_id,
    state: row.state,
    attempt_count: row.attempt_count,
    updated_at: row.updated_at,
    resolution: row.resolution,
  };
}

function toRecord(row: DeliveryRow): ApprovalDeliveryRecord {
  if (!isDeliveryState(row.state)) {
    throw new Error(`Invalid approval delivery state: ${row.state}`);
  }
  return {
    requestId: row.request_id,
    state: row.state,
    attemptCount: row.attempt_count,
    updatedAt: row.updated_at,
    resolution: row.resolution,
  };
}

function isDeliveryState(value: string): value is ApprovalDeliveryState {
  return (
    value === "prepared" ||
    value === "sent_unknown" ||
    value === "delivered" ||
    value === "reconciled_completed" ||
    value === "resolved_externally"
  );
}
