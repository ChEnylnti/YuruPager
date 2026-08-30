import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  MemberSummary,
  WorkstationAccessMutationResult,
  WorkspaceInviteCreateResult,
  WorkspaceKind,
  WorkspaceMemberMutationResult,
  WorkspaceMutationResult,
  WorkspaceRole,
  WorkspaceSummary,
} from "@yurupager/shared";

import { withUserTransaction } from "./database.js";
import { HttpError } from "./errors.js";

type Row = Record<string, unknown>;

export async function createWorkspace(
  pool: Pool,
  userId: string,
  idempotencyKey: string,
  name: string,
  kind: WorkspaceKind,
): Promise<WorkspaceMutationResult> {
  validateKey(idempotencyKey);
  const cleanName = boundedText(name, "workspace_name", 240);
  if (!["personal", "company", "team"].includes(kind)) {
    throw new HttpError(400, "invalid_workspace_kind", "Workspace kind is invalid");
  }
  return withUserTransaction(pool, userId, null, async (client) => {
    const payloadHash = hashPayload({ name: cleanName, kind });
    const existing = await client.query<Row>(
      `SELECT w.id, w.name, w.slug, w.kind, w.create_idempotency_key,
              m.role, count(r.id) FILTER (WHERE r.status = 'pending')::int AS pending_count
         FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $1
         LEFT JOIN agent_requests r ON r.workspace_id = w.id
        WHERE w.created_by_user_id = $1 AND w.create_idempotency_key = $2
        GROUP BY w.id, m.role`,
      [userId, idempotencyKey],
    );
    if (existing.rows[0] !== undefined) {
      const row = existing.rows[0];
      if (row.name !== cleanName || row.kind !== kind) {
        throw new HttpError(409, "idempotency_key_reused", "This key is bound to another workspace");
      }
      return { workspace: mapWorkspace(row), replayed: true };
    }
    const slug = await uniqueSlug(client, cleanName);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO workspaces (id, created_by_user_id, create_idempotency_key, name, slug, kind)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [randomUUID(), userId, idempotencyKey, cleanName, slug, kind],
    );
    const workspaceId = inserted.rows[0]?.id;
    if (workspaceId === undefined) throw new Error("Workspace insert did not return an id");
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [workspaceId, userId],
    );
    await client.query(
      `INSERT INTO audit_events
        (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, next_state, metadata)
       VALUES ($1, $2, 'user', 'workspace.created', 'workspace', $3, 'active', $4::jsonb)`,
      [workspaceId, userId, workspaceId, JSON.stringify({ kind, payloadHash })],
    );
    const row = await getWorkspace(client, workspaceId, userId);
    return { workspace: row, replayed: false };
  });
}

export async function createWorkspaceInvite(
  pool: Pool,
  userId: string,
  workspaceId: string,
  idempotencyKey: string,
  role: Exclude<WorkspaceRole, "owner">,
  secret: string,
): Promise<WorkspaceInviteCreateResult> {
  validateKey(idempotencyKey);
  if (role !== "admin" && role !== "member") throw new HttpError(400, "invalid_member_role", "Invite role is invalid");
  return withUserTransaction(pool, userId, workspaceId, async (client) => {
    await requireWorkspaceManager(client, workspaceId);
    const token = deriveInviteToken(secret, workspaceId, userId, idempotencyKey);
    const tokenHash = hashSecret(token);
    const existing = await client.query<Row>(
      `SELECT i.workspace_id, w.name AS workspace_name, i.role, i.expires_at, i.token_hash
         FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id
        WHERE i.workspace_id = $1 AND i.create_idempotency_key = $2
        FOR UPDATE`,
      [workspaceId, idempotencyKey],
    );
    if (existing.rows[0] !== undefined) {
      const row = existing.rows[0];
      if (row.role !== role || row.token_hash !== tokenHash) {
        throw new HttpError(409, "idempotency_key_reused", "This key is bound to another invite");
      }
      return {
        workspaceId,
        workspaceName: String(row.workspace_name),
        role,
        token,
        expiresAt: dateValue(row.expires_at),
        replayed: true,
      };
    }
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
    await client.query(
      `INSERT INTO workspace_invites
        (workspace_id, created_by_user_id, create_idempotency_key, token_hash, role, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [workspaceId, userId, idempotencyKey, tokenHash, role, expiresAt],
    );
    await audit(client, workspaceId, userId, "workspace.invite_created", "workspace_invite", idempotencyKey, null, "active", { role });
    const workspace = await getWorkspace(client, workspaceId, userId);
    return { workspaceId, workspaceName: workspace.name, role, token, expiresAt: expiresAt.toISOString(), replayed: false };
  });
}

export async function joinWorkspaceInvite(
  pool: Pool,
  userId: string,
  token: string,
  _secret: string,
): Promise<WorkspaceSummary> {
  const normalized = token.trim();
  if (!/^ypi_[A-Za-z0-9_-]{32,160}$/.test(normalized)) {
    throw new HttpError(400, "invalid_invite_token", "Invite token is invalid");
  }
  const tokenHash = hashSecret(normalized);
  return withUserTransaction(pool, userId, null, async (client) => {
    await client.query("SELECT set_config('app.invite_hash', $1, true)", [tokenHash]);
    const selected = await client.query<Row>(
      `SELECT i.workspace_id, i.role, i.expires_at, i.joined_at
         FROM workspace_invites i
        WHERE i.token_hash = $1
        FOR UPDATE`,
      [tokenHash],
    );
    const invite = selected.rows[0];
    if (invite === undefined || invite.joined_at !== null || new Date(dateValue(invite.expires_at)).getTime() <= Date.now()) {
      throw new HttpError(410, "invite_expired", "Invite is expired or already used");
    }
    const workspaceId = String(invite.workspace_id);
    const member = await client.query("SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId]);
    if (member.rowCount !== 0) {
      await client.query(`UPDATE workspace_invites SET joined_by_user_id = $2, joined_at = now() WHERE workspace_id = $1 AND token_hash = $3`, [workspaceId, userId, tokenHash]);
      return getWorkspace(client, workspaceId, userId);
    }
    await client.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)`, [workspaceId, userId, invite.role]);
    await client.query(`UPDATE workspace_invites SET joined_by_user_id = $2, joined_at = now() WHERE workspace_id = $1 AND token_hash = $3`, [workspaceId, userId, tokenHash]);
    await audit(client, workspaceId, userId, "workspace.joined", "workspace", workspaceId, null, "active", { role: invite.role });
    return getWorkspace(client, workspaceId, userId);
  });
}

export async function updateMemberRole(
  pool: Pool,
  actorUserId: string,
  workspaceId: string,
  memberUserId: string,
  role: Exclude<WorkspaceRole, "owner">,
): Promise<WorkspaceMemberMutationResult> {
  if (role !== "admin" && role !== "member") throw new HttpError(400, "invalid_member_role", "Member role is invalid");
  return withUserTransaction(pool, actorUserId, workspaceId, async (client) => {
    await requireWorkspaceManager(client, workspaceId);
    const selected = await client.query<Row>(`SELECT id, role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`, [workspaceId, memberUserId]);
    const row = selected.rows[0];
    if (row === undefined) throw new HttpError(404, "member_not_found", "Member was not found");
    if (row.role === "owner") throw new HttpError(409, "owner_immutable", "The workspace owner cannot be changed here");
    await client.query(`UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, memberUserId, role]);
    await audit(client, workspaceId, actorUserId, "workspace.member_role_updated", "workspace_member", String(row.id), String(row.role), role, { userId: memberUserId });
    return { member: await getMember(client, workspaceId, memberUserId), replayed: false };
  });
}

export async function removeMember(pool: Pool, actorUserId: string, workspaceId: string, memberUserId: string): Promise<void> {
  return withUserTransaction(pool, actorUserId, workspaceId, async (client) => {
    await requireWorkspaceManager(client, workspaceId);
    const selected = await client.query<Row>(`SELECT id, role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`, [workspaceId, memberUserId]);
    const row = selected.rows[0];
    if (row === undefined) throw new HttpError(404, "member_not_found", "Member was not found");
    if (row.role === "owner") throw new HttpError(403, "permission_denied", "The workspace owner cannot be removed");
    await client.query(`DELETE FROM workstation_access WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, memberUserId]);
    await client.query(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, memberUserId]);
    await audit(client, workspaceId, actorUserId, "workspace.member_removed", "workspace_member", String(row.id), String(row.role), "removed", { userId: memberUserId });
  });
}

export async function updateWorkstationAccess(
  pool: Pool,
  actorUserId: string,
  workspaceId: string,
  workstationId: string,
  input: { userId: string; canView: boolean; canRespond: boolean; canApproveHighRisk: boolean; canManage: boolean; canPreview: boolean },
): Promise<WorkstationAccessMutationResult> {
  return withUserTransaction(pool, actorUserId, workspaceId, async (client) => {
    await requireWorkspaceManager(client, workspaceId);
    const checks = await client.query(`SELECT
      EXISTS (SELECT 1 FROM workstations WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL) AS workstation,
      EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $3) AS member`, [workspaceId, workstationId, input.userId]);
    if (checks.rows[0]?.workstation !== true) throw new HttpError(404, "workstation_not_found", "Workstation was not found");
    if (checks.rows[0]?.member !== true) throw new HttpError(404, "member_not_found", "Member was not found");
    const enabled = input.canView || input.canRespond || input.canApproveHighRisk || input.canManage || input.canPreview;
    if (enabled) {
      await client.query(`INSERT INTO workstation_access
        (workspace_id, workstation_id, user_id, can_view, can_respond, can_approve_high_risk, can_manage, can_preview)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (workspace_id, workstation_id, user_id) DO UPDATE SET
          can_view = EXCLUDED.can_view, can_respond = EXCLUDED.can_respond,
          can_approve_high_risk = EXCLUDED.can_approve_high_risk, can_manage = EXCLUDED.can_manage,
          can_preview = EXCLUDED.can_preview`, [workspaceId, workstationId, input.userId, input.canView, input.canRespond, input.canApproveHighRisk, input.canManage, input.canPreview]);
    } else {
      await client.query(`DELETE FROM workstation_access WHERE workspace_id = $1 AND workstation_id = $2 AND user_id = $3`, [workspaceId, workstationId, input.userId]);
    }
    const { userId, ...permissions } = input;
    await audit(client, workspaceId, actorUserId, "workstation.access_updated", "workstation", workstationId, null, enabled ? "authorized" : "revoked", { userId, ...permissions });
    return { workspaceId, workstationId, ...input };
  });
}

export async function revokeWorkstation(pool: Pool, actorUserId: string, workspaceId: string, workstationId: string): Promise<void> {
  return withUserTransaction(pool, actorUserId, workspaceId, async (client) => {
    await requireWorkspaceManager(client, workspaceId);
    const result = await client.query(`UPDATE workstations SET revoked_at = COALESCE(revoked_at, now()), status = 'offline', credential_hash = NULL WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL`, [workspaceId, workstationId]);
    if (result.rowCount !== 1) throw new HttpError(404, "workstation_not_found", "Workstation was not found");
    await audit(client, workspaceId, actorUserId, "workstation.revoked", "workstation", workstationId, "authorized", "revoked", {});
  });
}

async function requireWorkspaceManager(client: PoolClient, workspaceId: string): Promise<void> {
  const result = await client.query<{ allowed: boolean }>("SELECT app_can_manage_workspace($1) AS allowed", [workspaceId]);
  if (result.rows[0]?.allowed !== true) throw new HttpError(403, "permission_denied", "You cannot manage this workspace");
}

async function getWorkspace(client: PoolClient, workspaceId: string, userId: string): Promise<WorkspaceSummary> {
  const result = await client.query<Row>(`SELECT w.id, w.name, w.slug, w.kind, m.role, count(r.id) FILTER (WHERE r.status = 'pending')::int AS pending_count
    FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $2
    LEFT JOIN agent_requests r ON r.workspace_id = w.id WHERE w.id = $1 GROUP BY w.id, m.role`, [workspaceId, userId]);
  if (result.rows[0] === undefined) throw new HttpError(404, "workspace_not_found", "Workspace was not found");
  return mapWorkspace(result.rows[0]);
}

async function getMember(client: PoolClient, workspaceId: string, userId: string): Promise<MemberSummary> {
  const result = await client.query<Row>(`SELECT m.id, m.workspace_id, m.user_id, u.display_name, u.email, m.role,
    count(w.id) FILTER (WHERE m.role IN ('owner', 'admin') OR COALESCE(a.can_view, false))::int AS workstation_count,
    COALESCE(jsonb_agg(jsonb_build_object('workstationId', w.id, 'workstationName', w.name,
      'canView', m.role IN ('owner', 'admin') OR COALESCE(a.can_view, false),
      'canRespond', m.role IN ('owner', 'admin') OR COALESCE(a.can_respond, false),
      'canApproveHighRisk', m.role IN ('owner', 'admin') OR COALESCE(a.can_approve_high_risk, false),
      'canManage', m.role IN ('owner', 'admin') OR COALESCE(a.can_manage, false),
      'canPreview', m.role IN ('owner', 'admin') OR COALESCE(a.can_preview, false)) ORDER BY lower(w.name)) FILTER (WHERE w.id IS NOT NULL), '[]'::jsonb) AS workstation_access
    FROM workspace_members m JOIN app_users u ON u.id = m.user_id LEFT JOIN workstations w ON w.workspace_id = m.workspace_id AND w.revoked_at IS NULL
    LEFT JOIN workstation_access a ON a.workspace_id = m.workspace_id AND a.workstation_id = w.id AND a.user_id = m.user_id
    WHERE m.workspace_id = $1 AND m.user_id = $2 GROUP BY m.id, m.workspace_id, m.user_id, u.display_name, u.email`, [workspaceId, userId]);
  if (result.rows[0] === undefined) throw new HttpError(404, "member_not_found", "Member was not found");
  return mapMember(result.rows[0]);
}

async function uniqueSlug(client: PoolClient, name: string): Promise<string> {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "workspace";
  for (let index = 0; index < 10; index += 1) {
    const slug = index === 0 ? `${base}-${randomBytes(3).toString("hex")}` : `${base}-${randomBytes(4).toString("hex")}`;
    const exists = await client.query("SELECT 1 FROM workspaces WHERE slug = $1", [slug]);
    if (exists.rowCount === 0) return slug;
  }
  throw new HttpError(503, "workspace_slug_unavailable", "Could not allocate a workspace slug");
}

function deriveInviteToken(secret: string, workspaceId: string, userId: string, key: string): string {
  return `ypi_${createHmac("sha256", secret).update("invite\\0").update(workspaceId).update("\\0").update(userId).update("\\0").update(key).digest("base64url")}`;
}
function hashSecret(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function hashPayload(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function validateKey(value: string): void { if (value.length < 8 || value.length > 200) throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be 8 to 200 characters"); }
function boundedText(value: string, code: string, max: number): string { const clean = value.trim(); if (clean.length < 1 || Array.from(clean).length > max) throw new HttpError(400, code, "Text is outside the allowed length"); return clean; }
function dateValue(value: unknown): string { if (!(value instanceof Date)) throw new Error("Expected Date database value"); return value.toISOString(); }
function mapWorkspace(row: Row): WorkspaceSummary { return { id: String(row.id), name: String(row.name), slug: String(row.slug), kind: row.kind as WorkspaceKind, role: row.role as WorkspaceRole, pendingCount: Number(row.pending_count ?? 0) }; }
function mapMember(row: Row): MemberSummary {
  const access = Array.isArray(row.workstation_access) ? row.workstation_access : [];
  return { id: String(row.id), workspaceId: String(row.workspace_id), userId: String(row.user_id), name: String(row.display_name), email: String(row.email), role: row.role as MemberSummary["role"], workstationCount: Number(row.workstation_count ?? 0), workstationAccess: access.map((value) => {
    const grant = value as Record<string, unknown>;
    return { workstationId: String(grant.workstationId), workstationName: String(grant.workstationName), canView: grant.canView === true, canRespond: grant.canRespond === true, canApproveHighRisk: grant.canApproveHighRisk === true, canManage: grant.canManage === true, canPreview: grant.canPreview === true };
  }) };
}
async function audit(client: PoolClient, workspaceId: string, actorUserId: string, action: string, entityType: string, entityId: string, previousState: string | null, nextState: string, metadata: Record<string, unknown>): Promise<void> {
  await client.query(`INSERT INTO audit_events (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, previous_state, next_state, metadata) VALUES ($1, $2, 'user', $3, $4, $5, $6, $7, $8::jsonb)`, [workspaceId, actorUserId, action, entityType, entityId, previousState, nextState, JSON.stringify(metadata)]);
}
