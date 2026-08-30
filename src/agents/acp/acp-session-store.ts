import { DatabaseSync } from "node:sqlite";

export interface PersistedAcpSession {
  threadId: string;
  acpSessionId: string;
  createdAt: string;
}

/**
 * Durable binding between YuruPager session ids and ACP session ids
 * (ADR-025): own-sessions agents are resumed after a Connector restart
 * instead of being silently duplicated. Stores identifiers only.
 */
export class AcpSessionStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS acp_sessions (
        thread_id TEXT PRIMARY KEY,
        acp_session_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  list(): PersistedAcpSession[] {
    const rows = this.#database
      .prepare("SELECT thread_id, acp_session_id, created_at FROM acp_sessions ORDER BY created_at")
      .all() as Array<{ thread_id: string; acp_session_id: string; created_at: string }>;
    return rows.map((row) => ({
      threadId: row.thread_id,
      acpSessionId: row.acp_session_id,
      createdAt: row.created_at,
    }));
  }

  bind(threadId: string, acpSessionId: string): void {
    this.#database
      .prepare("INSERT INTO acp_sessions (thread_id, acp_session_id, created_at) VALUES (?, ?, ?) ON CONFLICT (thread_id) DO NOTHING")
      .run(threadId, acpSessionId, new Date().toISOString());
  }

  close(): void {
    this.#database.close();
  }
}
