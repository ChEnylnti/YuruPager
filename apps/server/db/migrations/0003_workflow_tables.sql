-- Planning workflows (ADR-032..036). Persisted metadata only: definitions,
-- run/node state machines, and usage aggregation. Hand-off text and agent
-- output are session content and never enter these tables.

CREATE TABLE IF NOT EXISTS workflows (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_by_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name text NOT NULL,
  goal text NOT NULL,
  workstation_id uuid NOT NULL,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, workstation_id)
    REFERENCES workstations(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  workstation_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  definition_snapshot jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
  current_node_index int NOT NULL DEFAULT 0 CHECK (current_node_index >= 0),
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES workflows(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, workstation_id)
    REFERENCES workstations(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workflow_node_runs (
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  node_id text NOT NULL,
  node_index int NOT NULL CHECK (node_index >= 0),
  status text NOT NULL CHECK (status IN (
    'pending', 'starting', 'running', 'verifying', 'waiting_approval',
    'completed', 'failed', 'cancelled', 'interrupted', 'blocked_offline')),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  session_id uuid,
  reason_code text,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, run_id, node_id),
  FOREIGN KEY (workspace_id, run_id)
    REFERENCES workflow_runs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, session_id)
    REFERENCES agent_sessions(workspace_id, id) ON DELETE SET NULL
);

ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_node_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON workflows
  USING (app_can_view_workspace(workspace_id))
  WITH CHECK (app_is_service() OR app_can_manage_workspace(workspace_id));
CREATE POLICY tenant_isolation ON workflow_runs
  USING (app_can_view_workspace(workspace_id))
  WITH CHECK (app_is_service() OR app_can_view_workspace(workspace_id));
CREATE POLICY tenant_isolation ON workflow_node_runs
  USING (app_can_view_workspace(workspace_id))
  WITH CHECK (app_is_service() OR app_can_view_workspace(workspace_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON workflows TO yurupager_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_runs TO yurupager_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_node_runs TO yurupager_app;
GRANT SELECT ON workflows, workflow_runs, workflow_node_runs TO yurupager_connector;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO yurupager_app;

-- workflow_gate requests ride the existing approval flow (ADR-036).
ALTER TABLE agent_requests DROP CONSTRAINT IF EXISTS agent_requests_kind_check;
ALTER TABLE agent_requests
  ADD CONSTRAINT agent_requests_kind_check
  CHECK (kind IN ('approval', 'question', 'workflow_gate'));
