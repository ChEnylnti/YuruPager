-- Workflow permissions and dispatch delivery (ADR-036). Add-only.

ALTER TABLE workstation_access
  ADD COLUMN IF NOT EXISTS can_orchestrate boolean NOT NULL DEFAULT false;

ALTER TABLE connector_outbox
  ADD COLUMN IF NOT EXISTS run_id text;

-- The connector reports workflow run/node status; grant the connector role
-- the UPDATE it needs on the state-machine tables.
GRANT SELECT, UPDATE ON workflow_runs, workflow_node_runs TO yurupager_connector;
