import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  WorkflowDefinitionSnapshot,
  WorkflowNodeRunStatus,
  WorkflowRunStatus,
} from "@yurupager/shared";

import { HttpError } from "./errors.js";
interface DbRow { [key: string]: unknown }

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function dateValue(value: unknown): string {
  return new Date(value as string).toISOString();
}

async function requireWorkspaceMembership(
  client: PoolClient,
  workspaceId: string,
  userId: string,
): Promise<string> {
  const result = await client.query<{ role: string }>(
    "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, userId],
  );
  const role = result.rows[0]?.role;
  if (role === undefined) {
    throw new HttpError(403, "permission_denied", "You are not a member of this workspace");
  }
  return role;
}

async function requireOrchestration(
  client: PoolClient,
  workspaceId: string,
  workstationId: string,
  userId: string,
): Promise<void> {
  await requireWorkspaceMembership(client, workspaceId, userId);
  const result = await client.query<{ can_orchestrate: boolean }>(
    `SELECT a.can_orchestrate
       FROM workstation_access a
      WHERE a.workspace_id = $1 AND a.workstation_id = $2 AND a.user_id = $3
        AND a.can_orchestrate = true`,
    [workspaceId, workstationId, userId],
  );
  if (result.rows[0]?.can_orchestrate !== true) {
    throw new HttpError(403, "orchestration_not_allowed", "You are not allowed to run workflows on this workstation");
  }
}

async function nextOutboxSequence(client: PoolClient, workspaceId: string, workstationId: string): Promise<string> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [workstationId]);
  const result = await client.query<{ next_sequence: string }>(
    `SELECT (COALESCE(max(sequence), 0) + 1)::text AS next_sequence
       FROM connector_outbox WHERE workspace_id = $1 AND workstation_id = $2`,
    [workspaceId, workstationId],
  );
  return result.rows[0]?.next_sequence ?? "1";
}

interface WorkflowRow { [key: string]: unknown }

function mapWorkflow(row: WorkflowRow) {
  return {
    id: stringValue(row.id),
    workspaceId: stringValue(row.workspace_id),
    workstationId: stringValue(row.workstation_id),
    name: stringValue(row.name),
    goal: stringValue(row.goal),
    definition: row.definition as WorkflowDefinitionSnapshot,
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function mapRun(row: WorkflowRow) {
  return {
    id: stringValue(row.id),
    workflowId: stringValue(row.workflow_id),
    workstationId: stringValue(row.workstation_id),
    status: row.status as WorkflowRunStatus,
    currentNodeIndex: Number(row.current_node_index ?? 0),
    reasonCode: nullableString(row.reason_code),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

export interface WorkflowNodeInput {
  id: string;
  agentKind: string;
  model?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  task: string;
  handoffPrompt?: string;
  condition: {
    kind: "agent_confirm" | "criteria_check" | "manual_gate";
    criteriaText?: string;
    maxRetries: number;
    backoffMs: number;
  };
  turnBudget: number;
  timeoutMs: number;
}

export interface WorkflowWriteInput {
  name: string;
  goal: string;
  workstationId: string;
  nodes: WorkflowNodeInput[];
}

function validateDefinition(definition: WorkflowDefinitionSnapshot): void {
  if (definition.version !== 1) throw new HttpError(400, "workflow_definition_version_unsupported", "Workflow definition version is unsupported");
  if (definition.nodes.length === 0) throw new HttpError(400, "workflow_definition_empty", "Workflow needs at least one node");
  const seen = new Set<string>();
  for (const node of definition.nodes) {
    if (typeof node.id !== "string" || node.id.length === 0) throw new HttpError(400, "workflow_node_id_missing", "A node is missing its id");
    if (seen.has(node.id)) throw new HttpError(400, "workflow_node_id_duplicate", "Duplicate node id");
    seen.add(node.id);
    if (typeof node.task !== "string" || node.task.trim().length === 0) throw new HttpError(400, "workflow_node_task_missing", "A node is missing its task");
    if (!Number.isSafeInteger(node.turnBudget) || node.turnBudget < 1) throw new HttpError(400, "workflow_node_turn_budget_invalid", "Turn budget must be a positive integer");
    if (!Number.isSafeInteger(node.timeoutMs) || node.timeoutMs < 1_000) throw new HttpError(400, "workflow_node_timeout_invalid", "Timeout must be at least 1 second");
    if (!Number.isSafeInteger(node.condition.maxRetries) || node.condition.maxRetries < 0) throw new HttpError(400, "workflow_node_retries_invalid", "Max retries must be a non-negative integer");
  }
}

function buildSnapshot(workflowId: string, input: WorkflowWriteInput): WorkflowDefinitionSnapshot {
  const snapshot: WorkflowDefinitionSnapshot = {
    version: 1,
    workflowId,
    goal: input.goal,
    workstationId: input.workstationId,
    nodes: input.nodes.map((node) => ({
      id: node.id,
      agentKind: node.agentKind,
      ...(node.model === undefined ? {} : { model: node.model }),
      ...(node.reasoningEffort === undefined ? {} : { reasoningEffort: node.reasoningEffort }),
      task: node.task,
      ...(node.handoffPrompt === undefined ? {} : { handoffPrompt: node.handoffPrompt }),
      condition: { ...node.condition },
      turnBudget: node.turnBudget,
      timeoutMs: node.timeoutMs,
    })),
  };
  validateDefinition(snapshot);
  return snapshot;
}

export async function createWorkflow(
  pool: Pool,
  userId: string,
  workspaceId: string,
  input: WorkflowWriteInput,
): Promise<ReturnType<typeof mapWorkflow>> {
  const workflowId = randomUUID();
  return withWorkflowTransaction(pool, userId, workspaceId, async (client) => {
    await requireWorkspaceMembership(client, workspaceId, userId);
    const snapshot = buildSnapshot(workflowId, input);
    await client.query(
      `INSERT INTO workflows (workspace_id, id, created_by_user_id, name, goal, workstation_id, definition)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [workspaceId, workflowId, userId, input.name, input.goal, input.workstationId, JSON.stringify(snapshot)],
    );
    await client.query(
      `INSERT INTO audit_events
         (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, previous_state, next_state, metadata)
       VALUES ($1, $2, 'user', 'workflow.created', 'workflow', $3, NULL, 'created', $4::jsonb)`,
      [workspaceId, userId, workflowId, JSON.stringify({ workstationId: input.workstationId, nodeCount: input.nodes.length })],
    );
    return mapWorkflow((await client.query("SELECT * FROM workflows WHERE workspace_id = $1 AND id = $2", [workspaceId, workflowId])).rows[0] as WorkflowRow);
  });
}

function withWorkflowTransaction<T>(
  pool: Pool,
  userId: string,
  workspaceId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return (async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
        [userId, workspaceId],
      );
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  })();
}

async function getWorkflowRow(client: PoolClient, workspaceId: string, workflowId: string): Promise<WorkflowRow> {
  const result = await client.query<DbRow>(
    "SELECT * FROM workflows WHERE workspace_id = $1 AND id = $2",
    [workspaceId, workflowId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new HttpError(404, "workflow_not_found", "Workflow was not found");
  return row;
}

export async function listWorkflows(pool: Pool, userId: string, workspaceId: string): Promise<Array<ReturnType<typeof mapWorkflow>>> {
  return withWorkflowTransaction(pool, userId, workspaceId, async (client) => {
    await requireWorkspaceMembership(client, workspaceId, userId);
    const result = await client.query<DbRow>(
      "SELECT * FROM workflows WHERE workspace_id = $1 ORDER BY updated_at DESC",
      [workspaceId],
    );
    return result.rows.map(mapWorkflow);
  });
}

export async function getWorkflow(pool: Pool, userId: string, workspaceId: string, workflowId: string): Promise<ReturnType<typeof mapWorkflow> & { runs: Array<ReturnType<typeof mapRun>> }> {
  return withWorkflowTransaction(pool, userId, workspaceId, async (client) => {
    await requireWorkspaceMembership(client, workspaceId, userId);
    const row = await getWorkflowRow(client, workspaceId, workflowId);
    const runs = await client.query<DbRow>(
      "SELECT * FROM workflow_runs WHERE workspace_id = $1 AND workflow_id = $2 ORDER BY created_at DESC LIMIT 20",
      [workspaceId, workflowId],
    );
    return { ...mapWorkflow(row), runs: runs.rows.map(mapRun) };
  });
}

export async function updateWorkflow(
  pool: Pool,
  userId: string,
  workspaceId: string,
  workflowId: string,
  input: WorkflowWriteInput,
): Promise<ReturnType<typeof mapWorkflow>> {
  return withWorkflowTransaction(pool, userId, workspaceId, async (client) => {
    const existing = await getWorkflowRow(client, workspaceId, workflowId);
    await requireWorkspaceMembership(client, workspaceId, userId);
    const snapshot = buildSnapshot(workflowId, input);
    const activeRun = await client.query<DbRow>(
      `SELECT 1 FROM workflow_runs
        WHERE workspace_id = $1 AND workflow_id = $2 AND status IN ('pending', 'running')`,
      [workspaceId, workflowId],
    );
    if (activeRun.rowCount !== 0 && String(existing.workstation_id) !== input.workstationId) {
      throw new HttpError(409, "workflow_run_active", "Cannot re-target a workflow with an active run");
    }
    await client.query(
      `UPDATE workflows SET name = $3, goal = $4, workstation_id = $5, definition = $6::jsonb, updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, workflowId, input.name, input.goal, input.workstationId, JSON.stringify(snapshot)],
    );
    await client.query(
      `INSERT INTO audit_events
         (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, previous_state, next_state, metadata)
       VALUES ($1, $2, 'user', 'workflow.updated', 'workflow', $3, 'created', 'updated', $4::jsonb)`,
      [workspaceId, userId, workflowId, JSON.stringify({ nodeCount: input.nodes.length })],
    );
    return mapWorkflow(await getWorkflowRow(client, workspaceId, workflowId));
  });
}

export async function deleteWorkflow(pool: Pool, userId: string, workspaceId: string, workflowId: string): Promise<void> {
  return withWorkflowTransaction(pool, userId, workspaceId, async (client) => {
    await getWorkflowRow(client, workspaceId, workflowId);
    await requireWorkspaceMembership(client, workspaceId, userId);
    const activeRun = await client.query<DbRow>(
      `SELECT 1 FROM workflow_runs
        WHERE workspace_id = $1 AND workflow_id = $2 AND status IN ('pending', 'running')`,
      [workspaceId, workflowId],
    );
    if (activeRun.rowCount !== 0) {
      throw new HttpError(409, "workflow_run_active", "Cancel the active run before deleting the workflow");
    }
    await client.query("DELETE FROM workflows WHERE workspace_id = $1 AND id = $2", [workspaceId, workflowId]);
    await client.query(
      `INSERT INTO audit_events
         (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, previous_state, next_state, metadata)
       VALUES ($1, $2, 'user', 'workflow.deleted', 'workflow', $3, 'created', 'deleted', NULL)`,
      [workspaceId, userId, workflowId],
    );
  });
}

export interface WorkflowRunOutcome {
  run: ReturnType<typeof mapRun>;
  dispatch: { runId: string; definition: WorkflowDefinitionSnapshot };
}

export async function runWorkflow(
  pool: Pool,
  userId: string,
  workspaceId: string,
  workflowId: string,
): Promise<WorkflowRunOutcome> {
  const outcome = await withWorkflowTransaction(pool, userId, workspaceId, async (client) => {
    const row = await getWorkflowRow(client, workspaceId, workflowId);
    const workstationId = stringValue(row.workstation_id);
    await requireOrchestration(client, workspaceId, workstationId, userId);
    const activeRun = await client.query<DbRow>(
      `SELECT id FROM workflow_runs
        WHERE workspace_id = $1 AND workflow_id = $2 AND status IN ('pending', 'running')
        FOR UPDATE`,
      [workspaceId, workflowId],
    );
    if (activeRun.rowCount !== 0) {
      throw new HttpError(409, "workflow_run_active", "This workflow already has an active run");
    }
    const definition = row.definition as WorkflowDefinitionSnapshot;
    const runId = randomUUID();
    await client.query(
      `INSERT INTO workflow_runs (workspace_id, id, workflow_id, workstation_id, created_by_user_id, definition_snapshot, status, current_node_index)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'running', 0)`,
      [workspaceId, runId, workflowId, workstationId, userId, JSON.stringify(definition)],
    );
    for (const [index, node] of definition.nodes.entries()) {
      await client.query(
        `INSERT INTO workflow_node_runs (workspace_id, run_id, node_id, node_index, status, attempts)
         VALUES ($1, $2, $3, $4, 'pending', 0)`,
        [workspaceId, runId, node.id, index],
      );
    }
    const sequence = await nextOutboxSequence(client, workspaceId, workstationId);
    await client.query(
      `INSERT INTO connector_outbox
         (workspace_id, workstation_id, run_id, message_type, payload, sequence)
       VALUES ($1, $2, $3, 'workflow.dispatch', $4::jsonb, $5)`,
      [workspaceId, workstationId, runId, JSON.stringify({ runId, definition }), sequence],
    );
    await client.query(
      `INSERT INTO audit_events
         (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, previous_state, next_state, metadata)
       VALUES ($1, $2, 'user', 'workflow.run', 'workflow_run', $3, NULL, 'running', $4::jsonb)`,
      [workspaceId, userId, runId, JSON.stringify({ workflowId, nodeCount: definition.nodes.length })],
    );
    return {
      run: mapRun((await client.query("SELECT * FROM workflow_runs WHERE workspace_id = $1 AND id = $2", [workspaceId, runId])).rows[0] as WorkflowRow),
      dispatch: { runId, definition },
    };
  });
  return outcome;
}

export async function cancelWorkflowRun(
  pool: Pool,
  userId: string,
  workspaceId: string,
  runId: string,
): Promise<WorkflowRunOutcome> {
  return withWorkflowTransaction(pool, userId, workspaceId, async (client) => {
    const result = await client.query<DbRow>(
      "SELECT * FROM workflow_runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
      [workspaceId, runId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new HttpError(404, "workflow_run_not_found", "Run was not found");
    await requireOrchestration(client, workspaceId, stringValue(row.workstation_id), userId);
    const status = row.status as WorkflowRunStatus;
    if (status !== "pending" && status !== "running") {
      throw new HttpError(409, "workflow_run_finished", "Run is already finished");
    }
    const sequence = await nextOutboxSequence(client, workspaceId, stringValue(row.workstation_id));
    await client.query(
      `INSERT INTO connector_outbox
         (workspace_id, workstation_id, run_id, message_type, payload, sequence)
       VALUES ($1, $2, $3, 'workflow.cancel', $4::jsonb, $5)`,
      [workspaceId, stringValue(row.workstation_id), runId, JSON.stringify({ runId, reason: "user_cancelled" }), sequence],
    );
    await client.query(
      `UPDATE workflow_runs SET status = 'cancelled', reason_code = 'cancel_requested', updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, runId],
    );
    await client.query(
      `UPDATE workflow_node_runs SET status = 'cancelled', reason_code = 'cancel_requested', completed_at = now(), updated_at = now()
        WHERE workspace_id = $1 AND run_id = $2 AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')`,
      [workspaceId, runId],
    );
    await client.query(
      `INSERT INTO audit_events
         (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, previous_state, next_state, metadata)
       VALUES ($1, $2, 'user', 'workflow.cancelled', 'workflow_run', $3, $4, 'cancelled', $5::jsonb)`,
      [workspaceId, userId, runId, status, JSON.stringify({ reason: "user_cancelled" })],
    );
    return {
      run: mapRun((await client.query("SELECT * FROM workflow_runs WHERE workspace_id = $1 AND id = $2", [workspaceId, runId])).rows[0] as WorkflowRow),
      dispatch: { runId, definition: { version: 1, workflowId: stringValue(row.workflow_id), goal: "", workstationId: stringValue(row.workstation_id), nodes: [] } },
    };
  });
}

export async function listWorkflowRuns(pool: Pool, userId: string, workspaceId: string, workflowId: string): Promise<Array<ReturnType<typeof mapRun> & { nodes: Array<{ nodeId: string; status: WorkflowNodeRunStatus; attempts: number; reasonCode: string | null }> }>> {
  return withWorkflowTransaction(pool, userId, workspaceId, async (client) => {
    await requireWorkspaceMembership(client, workspaceId, userId);
    const runs = await client.query<DbRow>(
      "SELECT * FROM workflow_runs WHERE workspace_id = $1 AND workflow_id = $2 ORDER BY created_at DESC LIMIT 20",
      [workspaceId, workflowId],
    );
    const result: Array<ReturnType<typeof mapRun> & { nodes: Array<{ nodeId: string; status: WorkflowNodeRunStatus; attempts: number; reasonCode: string | null }> }> = [];
    for (const row of runs.rows) {
      const nodes = await client.query<DbRow>(
        "SELECT node_id, status, attempts, reason_code FROM workflow_node_runs WHERE workspace_id = $1 AND run_id = $2 ORDER BY node_index",
        [workspaceId, stringValue(row.id)],
      );
      result.push({
        ...mapRun(row),
        nodes: nodes.rows.map((nodeRow) => ({
          nodeId: stringValue(nodeRow.node_id),
          status: nodeRow.status as WorkflowNodeRunStatus,
          attempts: Number(nodeRow.attempts),
          reasonCode: nullableString(nodeRow.reason_code),
        })),
      });
    }
    return result;
  });
}
