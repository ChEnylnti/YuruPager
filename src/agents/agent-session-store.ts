import { DatabaseSync } from "node:sqlite";

export interface PersistedAgentSession {
  threadId: string;
  /** The agent's native session identifier (ACP sessionId, Cursor session_id, ...). */
  nativeSessionId: string;
  createdAt: string;
}

/**
 * Durable binding between YuruPager session ids and agent-native session ids
 * (ADR-025): own-sessions agents (ACP, Cursor, ...) are resumed after a
 * Connector restart instead of being silently duplicated. Stores identifiers
 * only.
 */
export class AgentSessionStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agent_sessions_binding (
        thread_id TEXT PRIMARY KEY,
        native_session_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  list(): PersistedAgentSession[] {
    const rows = this.#database
      .prepare("SELECT thread_id, native_session_id, created_at FROM agent_sessions_binding ORDER BY created_at")
      .all() as Array<{ thread_id: string; native_session_id: string; created_at: string }>;
    return rows.map((row) => ({
      threadId: row.thread_id,
      nativeSessionId: row.native_session_id,
      createdAt: row.created_at,
    }));
  }

  bind(threadId: string, nativeSessionId: string): void {
    this.#database
      .prepare("INSERT INTO agent_sessions_binding (thread_id, native_session_id, created_at) VALUES (?, ?, ?) ON CONFLICT (thread_id) DO NOTHING")
      .run(threadId, nativeSessionId, new Date().toISOString());
  }

  close(): void {
    this.#database.close();
  }
}
