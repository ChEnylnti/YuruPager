-- Multi-agent support (ADR-024/026): sessions gain an owning agent.
-- Add-only for data; the unique constraint swap is an explicitly planned
-- change from the multi-agent goal (thread ids are agent-namespaced, so no
-- data can violate the new key that did not already violate the old one).

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS agent text NOT NULL DEFAULT 'codex';

-- Existing rows were produced by the Codex-only connector.
UPDATE agent_sessions SET agent = 'codex' WHERE agent IS DISTINCT FROM 'codex' AND agent IS NULL;

ALTER TABLE agent_sessions
  DROP CONSTRAINT IF EXISTS agent_sessions_workspace_id_workstation_id_thread_id_key;
ALTER TABLE agent_sessions
  ADD CONSTRAINT agent_sessions_workspace_id_workstation_id_agent_thread_id_key
  UNIQUE (workspace_id, workstation_id, agent, thread_id);
