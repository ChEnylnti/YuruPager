import { DatabaseSync } from "node:sqlite";

import type { WorkflowDefinitionSnapshot, WorkflowNodeRunStatus } from "@yurupager/shared";

export interface JournalRunEntry {
  runId: string;
  definition: WorkflowDefinitionSnapshot;
  currentNodeIndex: number;
  nodeStatus: WorkflowNodeRunStatus;
  attempts: number;
  sessionId: string | null;
}

/**
 * Connector-side workflow run journal (ADR-032). Survives Connector restarts
 * so in-flight runs can be marked interrupted and re-dispatched per policy.
 * Stores state machine metadata only — never hand-off text or agent output.
 */
export class WorkflowRunJournal {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS workflow_run_journal (
        run_id TEXT PRIMARY KEY,
        definition_json TEXT NOT NULL,
        current_node_index INTEGER NOT NULL,
        node_status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        session_id TEXT
      ) STRICT;
    `);
  }

  list(): JournalRunEntry[] {
    const rows = this.#database
      .prepare("SELECT run_id, definition_json, current_node_index, node_status, attempts, session_id FROM workflow_run_journal")
      .all() as Array<{
      run_id: string;
      definition_json: string;
      current_node_index: number;
      node_status: string;
      attempts: number;
      session_id: string | null;
    }>;
    return rows.map((row) => ({
      runId: row.run_id,
      definition: JSON.parse(row.definition_json) as WorkflowDefinitionSnapshot,
      currentNodeIndex: row.current_node_index,
      nodeStatus: row.node_status as WorkflowNodeRunStatus,
      attempts: row.attempts,
      sessionId: row.session_id,
    }));
  }

  upsert(entry: JournalRunEntry): void {
    this.#database
      .prepare(`INSERT INTO workflow_run_journal (run_id, definition_json, current_node_index, node_status, attempts, session_id)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (run_id) DO UPDATE SET
                  definition_json = excluded.definition_json,
                  current_node_index = excluded.current_node_index,
                  node_status = excluded.node_status,
                  attempts = excluded.attempts,
                  session_id = excluded.session_id`)
      .run(
        entry.runId,
        JSON.stringify(entry.definition),
        entry.currentNodeIndex,
        entry.nodeStatus,
        entry.attempts,
        entry.sessionId,
      );
  }

  remove(runId: string): void {
    this.#database.prepare("DELETE FROM workflow_run_journal WHERE run_id = ?").run(runId);
  }

  close(): void {
    this.#database.close();
  }
}
