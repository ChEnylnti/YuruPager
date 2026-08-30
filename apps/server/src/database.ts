import { scryptSync } from "node:crypto";

import { Pool, type PoolClient, type QueryResultRow } from "pg";

import type { Config } from "./config.js";
import { runMigrations } from "./migrations.js";

export interface Database {
  admin: Pool;
  app: Pool;
  connector: Pool;
}

export function createDatabase(config: Config): Database {
  return {
    admin: new Pool({ connectionString: config.adminDatabaseUrl, max: 2 }),
    app: new Pool({ connectionString: config.databaseUrl, max: 10 }),
    connector: new Pool({ connectionString: config.connectorDatabaseUrl, max: 4 }),
  };
}

export async function migrateAndSeed(database: Database, alphaPassword = "alpha-demo"): Promise<void> {
  await runMigrations(database.admin);
  await seedAlpha(database.admin, alphaPassword);
}

export async function closeDatabase(database: Database): Promise<void> {
  await Promise.all([database.admin.end(), database.app.end(), database.connector.end()]);
}

export async function withUserTransaction<T>(
  pool: Pool,
  userId: string,
  workspaceId: string | null,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
      [userId, workspaceId ?? ""],
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
}

export async function withServiceTransaction<T>(
  pool: Pool,
  workspaceId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.user_id', '', true), set_config('app.workspace_id', $1, true)",
      [workspaceId],
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
}

export function one<T extends QueryResultRow>(rows: T[], label: string): T {
  const value = rows[0];
  if (value === undefined) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

async function seedAlpha(pool: Pool, password: string): Promise<void> {
  const salt = "yurupager-alpha-v1";
  const passwordHash = hashLocalPassword(password, salt);
  await pool.query(
    `
      INSERT INTO app_users (id, email, display_name) VALUES
        ('10000000-0000-4000-8000-000000000001', 'alice@yurupager.local', 'Alice Chen'),
        ('10000000-0000-4000-8000-000000000002', 'bob@yurupager.local', 'Bob Lin')
      ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name;

      INSERT INTO local_credentials (user_id, password_salt, password_hash) VALUES
        ('10000000-0000-4000-8000-000000000001', '${salt}', '${passwordHash}'),
        ('10000000-0000-4000-8000-000000000002', '${salt}', '${passwordHash}')
      ON CONFLICT (user_id) DO UPDATE SET password_salt = EXCLUDED.password_salt, password_hash = EXCLUDED.password_hash;

      INSERT INTO workspaces (id, name, slug, kind) VALUES
        ('20000000-0000-4000-8000-000000000001', 'Alice Personal', 'alice-personal', 'personal'),
        ('20000000-0000-4000-8000-000000000002', 'Yuru Systems Product Engineering', 'yuru-systems', 'company'),
        ('20000000-0000-4000-8000-000000000003', 'Open Source Maintainers', 'open-source-maintainers', 'team')
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind;

      INSERT INTO workspace_members (workspace_id, id, user_id, role) VALUES
        ('20000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'owner'),
        ('20000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'owner'),
        ('20000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'member'),
        ('20000000-0000-4000-8000-000000000003', '21000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'admin')
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role;

      INSERT INTO workstations (workspace_id, id, name, platform, connector_version, status, last_seen_at, credential_hash) VALUES
        ('20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', 'Levinthal MacBook Pro', 'macOS 15.6 / arm64', '0.1.0-alpha', 'online', now(), encode(digest('alpha-connector-token', 'sha256'), 'hex')),
        ('20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', 'Home Mac mini with a deliberately long workstation label for overflow verification', 'macOS 15.5 / arm64', '0.1.0-alpha', 'offline', now() - interval '38 minutes', NULL)
      ON CONFLICT (workspace_id, id) DO UPDATE SET name = EXCLUDED.name, platform = EXCLUDED.platform, connector_version = EXCLUDED.connector_version;

      INSERT INTO workstation_access (workspace_id, id, workstation_id, user_id, can_view, can_respond, can_approve_high_risk, can_manage) VALUES
        ('20000000-0000-4000-8000-000000000002', '31000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', true, true, true, true),
        ('20000000-0000-4000-8000-000000000002', '31000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', true, true, false, false),
        ('20000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', true, true, true, true)
      ON CONFLICT (workspace_id, workstation_id, user_id) DO UPDATE SET can_view = EXCLUDED.can_view, can_respond = EXCLUDED.can_respond, can_approve_high_risk = EXCLUDED.can_approve_high_risk, can_manage = EXCLUDED.can_manage;

      INSERT INTO agent_sessions (workspace_id, id, workstation_id, initiator_user_id, thread_id, project_key, latest_turn_id, project_name, project_path_hint, model, status, sync_state, started_at, updated_at) VALUES
        ('20000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'thread-alpha-live', encode(digest('~/Documents/YuruPager', 'sha256'), 'hex'), 'turn-alpha-7', 'YuruPager', '~/Documents/YuruPager', 'gpt-5.6-codex', 'waiting', 'live', now() - interval '17 minutes', now()),
        ('20000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'thread-alpha-tests', encode(digest('~/src/connector-reliability-harness-with-an-intentionally-long-project-directory-name', 'sha256'), 'hex'), 'turn-alpha-2', 'Connector Reliability Harness', '~/src/connector-reliability-harness-with-an-intentionally-long-project-directory-name', 'gpt-5.6-codex', 'running', 'live', now() - interval '42 minutes', now() - interval '1 minute')
      ON CONFLICT (workspace_id, workstation_id, agent, thread_id) DO UPDATE SET latest_turn_id = EXCLUDED.latest_turn_id, status = EXCLUDED.status, sync_state = EXCLUDED.sync_state, updated_at = EXCLUDED.updated_at;

      INSERT INTO agent_requests (workspace_id, id, workstation_id, session_id, turn_id, item_id, kind, category, tool, risk, context, status, delivery_status, assigned_to_user_id, requested_at, expires_at) VALUES
        ('20000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'turn-alpha-7', 'item-command-1', 'approval', 'command', 'shell', 'medium', '{"command":"npm run test:all && git status --short","cwd":"~/Documents/YuruPager","reason":"Run the complete verification suite and inspect generated changes before delivery."}', 'pending', 'not_queued', '10000000-0000-4000-8000-000000000001', now() - interval '4 minutes', now() + interval '11 minutes'),
        ('20000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'turn-alpha-7', 'item-command-2', 'approval', 'command', 'shell', 'high', '{"command":"git push origin codex/yurupager-alpha --force-with-lease","cwd":"~/Documents/YuruPager","reason":"The remote branch changed and deployment requires an explicit force-with-lease update."}', 'pending', 'not_queued', NULL, now() - interval '2 minutes', now() + interval '13 minutes'),
        ('20000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'turn-alpha-2', 'item-question-1', 'question', 'userInput', 'request_user_input', 'low', '{"questions":[{"id":"environment","header":"Deploy target","question":"Which environment should receive the Alpha build?","isSecret":false,"options":[{"label":"Staging","description":"Deploy for internal verification only"},{"label":"Do not deploy","description":"Keep the Alpha local"}]}]}', 'pending', 'not_queued', '10000000-0000-4000-8000-000000000002', now() - interval '1 minute', now() + interval '14 minutes'),
        ('20000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'turn-alpha-6', 'item-command-legacy', 'approval', 'command', 'shell', 'high', '{"command":"./scripts/publish-alpha.sh","cwd":"~/Documents/YuruPager","reason":"Connector restarted after submitting the Codex response; execution outcome cannot be proven."}', 'approved', 'sent_unknown', NULL, now() - interval '2 hours', now() - interval '105 minutes')
      ON CONFLICT (workspace_id, id) DO NOTHING;

      INSERT INTO pricing_catalog (provider, model, version, input_micros_per_million, cached_input_micros_per_million, output_micros_per_million, effective_from, source_url) VALUES
        ('openai', 'gpt-5.6-codex', 'alpha-2026-08-01', 1500000, 375000, 6000000, '2026-08-01T00:00:00Z', 'https://openai.com/api/pricing')
      ON CONFLICT (provider, model, version) DO NOTHING;

      INSERT INTO token_usage_rollups (workspace_id, id, workstation_id, session_id, provider, model, latest_sequence, latest_event_id, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, quality, estimated_cost_micros, price_version, updated_at) VALUES
        ('20000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'openai', 'gpt-5.6-codex', 7, 'usage-alpha-7', 184220, 126400, 21860, 9820, 206080, 'provisional', 265290, 'alpha-2026-08-01', now()),
        ('20000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'openai', 'gpt-5.6-codex', 2, 'usage-alpha-tests-2', 80420, 50120, 14770, 4410, 95190, 'final', 152865, 'alpha-2026-08-01', now() - interval '1 minute')
      ON CONFLICT (workspace_id, session_id, model) DO UPDATE SET latest_sequence = EXCLUDED.latest_sequence, latest_event_id = EXCLUDED.latest_event_id, input_tokens = EXCLUDED.input_tokens, cached_input_tokens = EXCLUDED.cached_input_tokens, output_tokens = EXCLUDED.output_tokens, reasoning_tokens = EXCLUDED.reasoning_tokens, total_tokens = EXCLUDED.total_tokens, quality = EXCLUDED.quality, estimated_cost_micros = EXCLUDED.estimated_cost_micros, price_version = EXCLUDED.price_version, updated_at = EXCLUDED.updated_at;

      INSERT INTO audit_events (workspace_id, id, actor_user_id, actor_kind, action, entity_type, entity_id, previous_state, next_state, metadata, occurred_at) VALUES
        ('20000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'user', 'request.assigned', 'request', '50000000-0000-4000-8000-000000000001', NULL, 'assigned', '{"assignee":"Alice Chen"}', now() - interval '4 minutes'),
        ('20000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000002', NULL, 'connector', 'request.delivery_unknown', 'request', '50000000-0000-4000-8000-000000000004', 'sent', 'sent_unknown', '{"automaticRetry":false}', now() - interval '105 minutes')
      ON CONFLICT (workspace_id, id) DO NOTHING;
    `,
  );
}

export function hashLocalPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}
