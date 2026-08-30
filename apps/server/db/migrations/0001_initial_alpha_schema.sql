CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yurupager_app') THEN
    CREATE ROLE yurupager_app LOGIN PASSWORD 'yurupager_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yurupager_connector') THEN
    CREATE ROLE yurupager_connector LOGIN PASSWORD 'yurupager_connector' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS local_credentials (
  user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS web_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE CHECK (
    char_length(endpoint) BETWEEN 12 AND 2048
    AND endpoint LIKE 'https://%'
    AND endpoint !~ '[[:cntrl:]]'
  ),
  p256dh text NOT NULL CHECK (
    char_length(p256dh) BETWEEN 40 AND 256
    AND p256dh ~ '^[A-Za-z0-9_-]+$'
  ),
  auth text NOT NULL CHECK (
    char_length(auth) BETWEEN 16 AND 128
    AND auth ~ '^[A-Za-z0-9_-]+$'
  ),
  expiration_time timestamptz,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_failure_code text CHECK (
    last_failure_code IS NULL OR char_length(last_failure_code) BETWEEN 1 AND 40
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_id
  ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  create_idempotency_key text,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 240),
  slug text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('personal', 'company', 'team')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL;
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS create_idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_create_idempotency_unique
  ON workspaces(created_by_user_id, create_idempotency_key)
  WHERE created_by_user_id IS NOT NULL AND create_idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS workspace_invites (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_by_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  create_idempotency_key text NOT NULL CHECK (char_length(create_idempotency_key) BETWEEN 8 AND 200),
  token_hash text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  expires_at timestamptz NOT NULL,
  joined_by_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  joined_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (id),
  UNIQUE (workspace_id, create_idempotency_key)
);

CREATE TABLE IF NOT EXISTS workstations (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 240),
  platform text NOT NULL,
  connector_version text NOT NULL,
  public_key text,
  credential_hash text,
  status text NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'degraded')),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (id)
);

CREATE TABLE IF NOT EXISTS workstation_access (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workstation_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  can_view boolean NOT NULL DEFAULT true,
  can_respond boolean NOT NULL DEFAULT false,
  can_approve_high_risk boolean NOT NULL DEFAULT false,
  can_manage boolean NOT NULL DEFAULT false,
  can_preview boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, workstation_id, user_id),
  FOREIGN KEY (workspace_id, workstation_id)
    REFERENCES workstations(workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE workstation_access
  ADD COLUMN IF NOT EXISTS can_preview boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS workstation_previews (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workstation_id uuid NOT NULL,
  route_id text NOT NULL CHECK (
    char_length(route_id) BETWEEN 1 AND 128
    AND route_id !~ '[[:cntrl:]]'
  ),
  name text NOT NULL CHECK (
    char_length(name) BETWEEN 1 AND 80
    AND name = btrim(name)
    AND name !~ '[[:cntrl:]]'
  ),
  local_port integer NOT NULL CHECK (local_port BETWEEN 1024 AND 65535),
  status text NOT NULL CHECK (
    status IN ('active', 'unreachable', 'connector_offline', 'stopped', 'expired')
  ),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (id),
  UNIQUE (workspace_id, workstation_id, route_id),
  FOREIGN KEY (workspace_id, workstation_id)
    REFERENCES workstations(workspace_id, id) ON DELETE CASCADE,
  CHECK (
    (status = 'stopped' AND stopped_at IS NOT NULL)
    OR (status <> 'stopped' AND stopped_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS workstation_previews_status_expiry
  ON workstation_previews(workspace_id, workstation_id, status, expires_at);

CREATE TABLE IF NOT EXISTS workstation_pairings (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_by_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  create_idempotency_key text NOT NULL CHECK (char_length(create_idempotency_key) BETWEEN 8 AND 200),
  code_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'waiting_for_device'
    CHECK (status IN ('waiting_for_device', 'pending_approval', 'approved', 'cancelled', 'expired')),
  device_name text,
  platform text,
  connector_version text,
  public_key text,
  claim_secret_hash text,
  workstation_id uuid,
  approved_by_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  cancelled_by_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  credential_issued_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (id),
  UNIQUE (created_by_user_id, create_idempotency_key),
  FOREIGN KEY (workspace_id, workstation_id)
    REFERENCES workstations(workspace_id, id) ON DELETE SET NULL (workstation_id),
  CHECK ((status = 'waiting_for_device' AND claim_secret_hash IS NULL)
    OR status <> 'waiting_for_device')
);

CREATE UNIQUE INDEX IF NOT EXISTS workstations_credential_hash_unique
  ON workstations(credential_hash)
  WHERE credential_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_sessions (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workstation_id uuid NOT NULL,
  initiator_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  thread_id text NOT NULL,
  project_key text NOT NULL,
  latest_turn_id text,
  project_name text NOT NULL,
  project_path_hint text NOT NULL,
  provider text NOT NULL DEFAULT 'openai',
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'interrupted')),
  sync_state text NOT NULL DEFAULT 'stale' CHECK (sync_state IN ('live', 'historical', 'stale')),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, workstation_id, thread_id),
  FOREIGN KEY (workspace_id, workstation_id)
    REFERENCES workstations(workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS project_key text;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS sync_state text NOT NULL DEFAULT 'stale';
UPDATE agent_sessions
   SET project_key = encode(digest(project_path_hint, 'sha256'), 'hex')
 WHERE project_key IS NULL;
ALTER TABLE agent_sessions ALTER COLUMN project_key SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_sessions_sync_state_check'
       AND conrelid = 'agent_sessions'::regclass
  ) THEN
    ALTER TABLE agent_sessions
      ADD CONSTRAINT agent_sessions_sync_state_check
      CHECK (sync_state IN ('live', 'historical', 'stale'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS agent_sessions_visible_updated
  ON agent_sessions(workspace_id, workstation_id, sync_state, updated_at DESC);

CREATE TABLE IF NOT EXISTS session_commands (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workstation_id uuid NOT NULL,
  session_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES app_users(id),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash text NOT NULL,
  content_length integer NOT NULL CHECK (content_length BETWEEN 0 AND 8000),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'delivered', 'failed', 'sent_unknown')),
  turn_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, workstation_id)
    REFERENCES workstations(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, session_id)
    REFERENCES agent_sessions(workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE session_commands
  DROP CONSTRAINT IF EXISTS session_commands_content_length_check;
ALTER TABLE session_commands
  ADD CONSTRAINT session_commands_content_length_check
  CHECK (content_length BETWEEN 0 AND 8000);

CREATE TABLE IF NOT EXISTS session_command_attachments (
  workspace_id uuid NOT NULL,
  workstation_id uuid NOT NULL,
  command_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 3),
  attachment_id text NOT NULL CHECK (char_length(attachment_id) BETWEEN 1 AND 500),
  mime_type text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 5242880),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, command_id, position),
  UNIQUE (workspace_id, workstation_id, attachment_id),
  FOREIGN KEY (workspace_id, workstation_id)
    REFERENCES workstations(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, command_id)
    REFERENCES session_commands(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_requests (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  workstation_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id text NOT NULL,
  item_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('approval', 'question')),
  category text NOT NULL,
  tool text NOT NULL,
  risk text NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled', 'interrupted')),
  delivery_status text NOT NULL DEFAULT 'not_queued' CHECK (delivery_status IN ('not_queued', 'queued', 'sent', 'delivered', 'failed', 'sent_unknown')),
  assigned_to_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  decided_by_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  decision_reason text,
  decision_payload jsonb,
  requested_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, workstation_id)
    REFERENCES workstations(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, session_id)
    REFERENCES agent_sessions(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS request_decisions (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES app_users(id),
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve', 'deny', 'answer')),
  reason text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, request_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, request_id)
    REFERENCES agent_requests(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pricing_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  model text NOT NULL,
  version text NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  input_micros_per_million bigint NOT NULL,
  cached_input_micros_per_million bigint NOT NULL,
  output_micros_per_million bigint NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  source_url text,
  UNIQUE (provider, model, version)
);

CREATE TABLE IF NOT EXISTS token_usage_snapshots (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workstation_id uuid NOT NULL,
  session_id uuid NOT NULL,
  event_id text NOT NULL,
  connection_epoch text NOT NULL,
  source_sequence bigint NOT NULL CHECK (source_sequence >= 0),
  turn_id text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
  cached_input_tokens bigint NOT NULL CHECK (cached_input_tokens >= 0),
  output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
  reasoning_tokens bigint NOT NULL CHECK (reasoning_tokens >= 0),
  total_tokens bigint NOT NULL CHECK (total_tokens >= 0),
  quality text NOT NULL CHECK (quality IN ('provisional', 'final', 'incomplete')),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, workstation_id, event_id),
  UNIQUE (workspace_id, workstation_id, connection_epoch, source_sequence),
  FOREIGN KEY (workspace_id, workstation_id)
    REFERENCES workstations(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, session_id)
    REFERENCES agent_sessions(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS token_usage_rollups (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workstation_id uuid NOT NULL,
  session_id uuid NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  latest_sequence bigint NOT NULL,
  latest_event_id text NOT NULL,
  input_tokens bigint NOT NULL,
  cached_input_tokens bigint NOT NULL,
  output_tokens bigint NOT NULL,
  reasoning_tokens bigint NOT NULL,
  total_tokens bigint NOT NULL,
  quality text NOT NULL CHECK (quality IN ('provisional', 'final', 'incomplete')),
  estimated_cost_micros bigint,
  price_version text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, session_id, model),
  FOREIGN KEY (workspace_id, workstation_id)
    REFERENCES workstations(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, session_id)
    REFERENCES agent_sessions(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_events (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'connector', 'system')),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  previous_state text,
  next_state text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS connector_inbox (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workstation_id uuid NOT NULL,
  message_id text NOT NULL,
  connection_epoch text NOT NULL,
  sequence bigint NOT NULL,
  idempotency_key text NOT NULL,
  payload_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, workstation_id, message_id),
  FOREIGN KEY (workspace_id, workstation_id)
    REFERENCES workstations(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS connector_outbox (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workstation_id uuid NOT NULL,
  request_id uuid,
  message_type text NOT NULL,
  payload jsonb NOT NULL,
  sequence bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  acknowledged_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, workstation_id, sequence),
  FOREIGN KEY (workspace_id, workstation_id)
    REFERENCES workstations(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, request_id)
    REFERENCES agent_requests(workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE connector_outbox ADD COLUMN IF NOT EXISTS command_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'connector_outbox_command_fk'
  ) THEN
    ALTER TABLE connector_outbox
      ADD CONSTRAINT connector_outbox_command_fk
      FOREIGN KEY (workspace_id, command_id)
      REFERENCES session_commands(workspace_id, id) ON DELETE CASCADE;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS connector_outbox_command_unique
  ON connector_outbox(workspace_id, command_id)
  WHERE command_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app_is_service() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT session_user = 'yurupager_connector'
$$;

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_can_manage_workspace(target_workspace uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_is_service() OR EXISTS (
    SELECT 1 FROM workspace_members m
    WHERE m.workspace_id = target_workspace
      AND m.user_id = app_current_user_id()
      AND m.role IN ('owner', 'admin')
  )
$$;

CREATE OR REPLACE FUNCTION app_can_use_invite(target_workspace uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_invites i
    WHERE i.workspace_id = target_workspace
      AND i.token_hash = NULLIF(current_setting('app.invite_hash', true), '')
      AND i.joined_at IS NULL
      AND i.expires_at > now()
  )
$$;

CREATE OR REPLACE FUNCTION app_can_view_workspace(target_workspace uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_is_service() OR EXISTS (
    SELECT 1 FROM workspace_members m
    WHERE m.workspace_id = target_workspace AND m.user_id = app_current_user_id()
  )
$$;

CREATE OR REPLACE FUNCTION app_can_view_workstation(target_workspace uuid, target_workstation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_is_service() OR EXISTS (
    SELECT 1 FROM workspace_members m
    WHERE m.workspace_id = target_workspace
      AND m.user_id = app_current_user_id()
      AND m.role IN ('owner', 'admin')
  ) OR EXISTS (
    SELECT 1 FROM workstation_access a
    WHERE a.workspace_id = target_workspace
      AND a.workstation_id = target_workstation
      AND a.user_id = app_current_user_id()
      AND (a.can_view OR a.can_preview)
  )
$$;

CREATE OR REPLACE FUNCTION app_can_respond(target_workspace uuid, target_workstation uuid, high_risk boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_is_service() OR EXISTS (
    SELECT 1 FROM workspace_members m
    WHERE m.workspace_id = target_workspace
      AND m.user_id = app_current_user_id()
      AND m.role IN ('owner', 'admin')
  ) OR EXISTS (
    SELECT 1 FROM workstation_access a
    WHERE a.workspace_id = target_workspace
      AND a.workstation_id = target_workstation
      AND a.user_id = app_current_user_id()
      AND a.can_respond
      AND (NOT high_risk OR a.can_approve_high_risk)
  )
$$;

CREATE OR REPLACE FUNCTION app_can_manage_workstations(target_workspace uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_is_service() OR EXISTS (
    SELECT 1 FROM workspace_members m
    WHERE m.workspace_id = target_workspace
      AND m.user_id = app_current_user_id()
      AND m.role IN ('owner', 'admin')
  ) OR EXISTS (
    SELECT 1 FROM workstation_access a
    WHERE a.workspace_id = target_workspace
      AND a.user_id = app_current_user_id()
      AND a.can_manage
  )
$$;

CREATE OR REPLACE FUNCTION app_can_preview_workstation(target_workspace uuid, target_workstation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_is_service() OR EXISTS (
    SELECT 1 FROM workspace_members m
    WHERE m.workspace_id = target_workspace
      AND m.user_id = app_current_user_id()
      AND m.role IN ('owner', 'admin')
  ) OR EXISTS (
    SELECT 1 FROM workstation_access a
    WHERE a.workspace_id = target_workspace
      AND a.workstation_id = target_workstation
      AND a.user_id = app_current_user_id()
      AND a.can_preview
  )
$$;

REVOKE ALL ON FUNCTION app_can_view_workspace(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_can_view_workstation(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_can_respond(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_can_manage_workstations(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_can_preview_workstation(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_is_service(), app_current_user_id(), app_can_view_workspace(uuid), app_can_view_workstation(uuid, uuid), app_can_respond(uuid, uuid, boolean), app_can_manage_workstations(uuid), app_can_preview_workstation(uuid, uuid) TO yurupager_app, yurupager_connector;
GRANT EXECUTE ON FUNCTION app_can_manage_workspace(uuid), app_can_use_invite(uuid) TO yurupager_app, yurupager_connector;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspaces', 'workspace_members', 'workspace_invites', 'workstations', 'workstation_access', 'workstation_previews', 'workstation_pairings',
    'push_subscriptions',
    'agent_sessions', 'session_commands', 'session_command_attachments', 'agent_requests', 'request_decisions',
    'token_usage_snapshots', 'token_usage_rollups', 'audit_events',
    'connector_inbox', 'connector_outbox'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
  END LOOP;
END
$$;

CREATE POLICY tenant_isolation ON workspaces
  USING (app_can_view_workspace(id) OR created_by_user_id = app_current_user_id())
  WITH CHECK (app_is_service() OR created_by_user_id = app_current_user_id());
CREATE POLICY tenant_isolation ON push_subscriptions
  USING (app_is_service() OR user_id = app_current_user_id())
  WITH CHECK (app_is_service() OR user_id = app_current_user_id());
CREATE POLICY tenant_isolation ON workspace_members
  USING (app_can_view_workspace(workspace_id) OR app_can_use_invite(workspace_id))
  WITH CHECK (
    app_is_service()
    OR app_can_manage_workspace(workspace_id)
    OR (
      user_id = app_current_user_id()
      AND role = 'owner'
      AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = workspace_id AND w.created_by_user_id = app_current_user_id())
    )
    OR (user_id = app_current_user_id() AND app_can_use_invite(workspace_id))
  );
CREATE POLICY tenant_isolation ON workspace_invites
  USING (app_is_service() OR app_can_manage_workspace(workspace_id) OR app_can_use_invite(workspace_id))
  WITH CHECK (
    app_is_service()
    OR app_can_manage_workspace(workspace_id)
    OR (
      app_can_use_invite(workspace_id)
      AND
      joined_by_user_id = app_current_user_id()
      AND joined_at IS NOT NULL
    )
  );
CREATE POLICY tenant_isolation ON workstations
  USING (app_can_view_workstation(workspace_id, id))
  WITH CHECK (app_is_service() OR app_can_manage_workstations(workspace_id));
CREATE POLICY tenant_isolation ON workstation_access
  USING (app_can_view_workstation(workspace_id, workstation_id))
  WITH CHECK (app_is_service() OR app_can_manage_workstations(workspace_id));
CREATE POLICY tenant_isolation ON workstation_previews
  USING (app_is_service() OR app_can_preview_workstation(workspace_id, workstation_id))
  WITH CHECK (app_is_service() OR app_can_preview_workstation(workspace_id, workstation_id));
CREATE POLICY tenant_isolation ON workstation_pairings
  USING (app_is_service() OR app_can_manage_workstations(workspace_id))
  WITH CHECK (app_is_service() OR app_can_manage_workstations(workspace_id));
CREATE POLICY tenant_isolation ON agent_sessions
  USING (app_can_view_workstation(workspace_id, workstation_id))
  WITH CHECK (app_is_service() OR app_can_view_workstation(workspace_id, workstation_id));
CREATE POLICY tenant_isolation ON session_commands
  USING (app_can_view_workstation(workspace_id, workstation_id))
  WITH CHECK (app_is_service() OR app_can_respond(workspace_id, workstation_id, false));
CREATE POLICY tenant_isolation ON session_command_attachments
  USING (app_can_view_workstation(workspace_id, workstation_id))
  WITH CHECK (app_is_service() OR app_can_respond(workspace_id, workstation_id, false));
CREATE POLICY tenant_isolation ON agent_requests
  USING (app_can_view_workstation(workspace_id, workstation_id))
  WITH CHECK (app_is_service() OR app_can_view_workstation(workspace_id, workstation_id));
CREATE POLICY tenant_isolation ON request_decisions
  USING (app_can_view_workspace(workspace_id))
  WITH CHECK (app_is_service() OR app_can_view_workspace(workspace_id));
CREATE POLICY tenant_isolation ON token_usage_snapshots
  USING (app_can_view_workstation(workspace_id, workstation_id))
  WITH CHECK (app_is_service() OR app_can_view_workstation(workspace_id, workstation_id));
CREATE POLICY tenant_isolation ON token_usage_rollups
  USING (app_can_view_workstation(workspace_id, workstation_id))
  WITH CHECK (app_is_service() OR app_can_view_workstation(workspace_id, workstation_id));
CREATE POLICY tenant_isolation ON audit_events
  USING (app_can_view_workspace(workspace_id))
  WITH CHECK (app_is_service() OR app_can_view_workspace(workspace_id));
CREATE POLICY tenant_isolation ON connector_inbox
  USING (app_is_service()) WITH CHECK (app_is_service());
CREATE POLICY tenant_isolation ON connector_outbox
  USING (app_is_service() OR app_can_view_workstation(workspace_id, workstation_id))
  WITH CHECK (app_is_service() OR app_can_view_workstation(workspace_id, workstation_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO yurupager_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO yurupager_app;
REVOKE INSERT, UPDATE, DELETE ON workstation_previews FROM yurupager_app;
GRANT UPDATE (status, stopped_at, updated_at) ON workstation_previews TO yurupager_app;
GRANT SELECT ON app_users, workspaces, workspace_members, workspace_invites, workstation_access, pricing_catalog, session_command_attachments TO yurupager_connector;
GRANT SELECT, INSERT, UPDATE ON workstations, agent_sessions, session_commands, agent_requests,
  workstation_previews, workstation_pairings, token_usage_snapshots, token_usage_rollups, audit_events, connector_inbox, connector_outbox
  TO yurupager_connector;
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO yurupager_connector;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO yurupager_connector;
