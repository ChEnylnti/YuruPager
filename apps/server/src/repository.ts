import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
  sessionImageLimits,
  type AuditSummary,
  type DecisionInput,
  type DecisionResult,
  type MemberSummary,
  type PreviewCapability,
  type RequestSummary,
  type SessionCommandAttachment,
  type SessionCommandAttachmentInput,
  type SessionCommandResult,
  type SessionCommandSummary,
  type SessionSummary,
  type Snapshot,
  type UsageSummary,
  type WorkstationSummary,
  type WorkspaceSummary,
} from "@yurupager/shared";

import { readAttachmentTicket } from "./attachment-ticket.js";
import { withUserTransaction } from "./database.js";
import { HttpError } from "./errors.js";
import { listWorkstationPreviews } from "./preview-repository.js";

type DbRow = Record<string, unknown>;

export interface AuthorizedSessionStream {
  sessionId: string;
  workspaceId: string;
  workstationId: string;
  threadId: string;
}

export interface AuthorizedSessionUpload extends AuthorizedSessionStream {
  userId: string;
}

export interface AuthorizedSessionTitle {
  sessionId: string;
  threadId: string;
}

export async function authorizeSessionTitles(
  pool: Pool,
  userId: string,
  workspaceId: string,
  workstationId: string,
  threadIds: string[],
): Promise<AuthorizedSessionTitle[]> {
  if (threadIds.length === 0) return [];
  return withUserTransaction(pool, userId, workspaceId, async (client) => {
    const result = await client.query<DbRow>(
      `SELECT s.id, s.thread_id
         FROM agent_sessions s
        WHERE s.workspace_id = $1
          AND s.workstation_id = $2
          AND s.sync_state <> 'stale'
          AND s.thread_id = ANY($3::text[])
          AND app_can_view_workstation(s.workspace_id, s.workstation_id)
        ORDER BY s.updated_at DESC`,
      [workspaceId, workstationId, threadIds],
    );
    return result.rows.map((row) => ({
      sessionId: stringValue(row.id),
      threadId: stringValue(row.thread_id),
    }));
  });
}

export async function authorizeSessionStream(
  pool: Pool,
  userId: string,
  sessionId: string,
): Promise<AuthorizedSessionStream> {
  return withUserTransaction(pool, userId, null, async (client) => {
    const result = await client.query<DbRow>(
      `SELECT s.id, s.workspace_id, s.workstation_id, s.thread_id,
              app_can_view_workstation(s.workspace_id, s.workstation_id) AS can_view
         FROM agent_sessions s
        WHERE s.id = $1
          AND s.sync_state <> 'stale'`,
      [sessionId],
    );
    const row = result.rows[0];
    if (row === undefined || row.can_view !== true) {
      throw new HttpError(404, "session_not_available", "Session is not available");
    }
    return {
      sessionId: stringValue(row.id),
      workspaceId: stringValue(row.workspace_id),
      workstationId: stringValue(row.workstation_id),
      threadId: stringValue(row.thread_id),
    };
  });
}

export async function authorizeSessionUpload(
  pool: Pool,
  userId: string,
  sessionId: string,
): Promise<AuthorizedSessionUpload> {
  return withUserTransaction(pool, userId, null, async (client) => {
    const result = await client.query<DbRow>(
      `SELECT s.id, s.workspace_id, s.workstation_id, s.thread_id,
              app_can_respond(s.workspace_id, s.workstation_id, false) AS can_respond
         FROM agent_sessions s
        WHERE s.id = $1
          AND s.sync_state <> 'stale'`,
      [sessionId],
    );
    const row = result.rows[0];
    if (row === undefined || row.can_respond !== true) {
      throw new HttpError(403, "permission_denied", "You cannot send images to this session");
    }
    return {
      userId,
      sessionId: stringValue(row.id),
      workspaceId: stringValue(row.workspace_id),
      workstationId: stringValue(row.workstation_id),
      threadId: stringValue(row.thread_id),
    };
  });
}

export async function getSnapshot(
  pool: Pool,
  userId: string,
  workspaceId: string | null,
  previewCapability: PreviewCapability = {
    enabled: false,
    gatewayOrigin: null,
    command: "yurupager preview <port>",
  },
): Promise<Snapshot> {
  const previews = await listWorkstationPreviews(pool, userId, workspaceId);
  return withUserTransaction(pool, userId, workspaceId, async (client) => {
    const scope = workspaceId ?? "";
    await client.query(
      `WITH expired AS (
         UPDATE agent_requests SET status = 'expired', updated_at = now()
          WHERE status = 'pending' AND expires_at <= now()
            AND ($1 = '' OR workspace_id = $1::uuid)
          RETURNING workspace_id, id
       )
       INSERT INTO audit_events
         (workspace_id, actor_kind, action, entity_type, entity_id, previous_state, next_state, metadata)
       SELECT workspace_id, 'system', 'request.expired', 'request', id::text,
              'pending', 'expired', '{"reason":"deadline_elapsed"}'::jsonb
         FROM expired`,
      [scope],
    );
    const workspaces = await client.query<DbRow>(
          `SELECT w.id, w.name, w.slug, w.kind, m.role,
                  count(r.id) FILTER (WHERE r.status = 'pending')::int AS pending_count
             FROM workspaces w
             JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $1
             LEFT JOIN agent_requests r ON r.workspace_id = w.id
            GROUP BY w.id, m.role ORDER BY w.kind, lower(w.name)`,
          [userId],
        );
    const workstations = await client.query<DbRow>(
          `SELECT w.id, w.workspace_id, ws.name AS workspace_name, w.name, w.platform,
                  w.connector_version, w.status, w.last_seen_at,
                  count(DISTINCT s.id) FILTER (WHERE s.status IN ('running', 'waiting'))::int AS active_session_count,
                  count(DISTINCT r.id) FILTER (WHERE r.status = 'pending')::int AS pending_count
             FROM workstations w
             JOIN workspaces ws ON ws.id = w.workspace_id
             LEFT JOIN agent_sessions s ON s.workspace_id = w.workspace_id AND s.workstation_id = w.id AND s.sync_state <> 'stale'
             LEFT JOIN agent_requests r ON r.workspace_id = w.workspace_id AND r.workstation_id = w.id
            WHERE w.revoked_at IS NULL
              AND ($1 = '' OR w.workspace_id = $1::uuid)
            GROUP BY w.workspace_id, w.id, ws.name ORDER BY w.status DESC, lower(w.name)`,
          [scope],
        );
    const sessions = await client.query<DbRow>(
          `SELECT s.id, s.workspace_id, s.workstation_id, w.name AS workstation_name,
                  u.display_name AS initiator_name, s.agent, s.thread_id, s.project_key, s.project_name,
                  s.project_path_hint, s.model, s.status, s.sync_state, s.started_at, s.updated_at
             FROM agent_sessions s
             JOIN workstations w ON w.workspace_id = s.workspace_id AND w.id = s.workstation_id
             LEFT JOIN app_users u ON u.id = s.initiator_user_id
            WHERE s.sync_state <> 'stale'
              AND ($1 = '' OR s.workspace_id = $1::uuid)
            ORDER BY s.updated_at DESC`,
          [scope],
        );
    const sessionCommands = await client.query<DbRow>(
          `SELECT c.id, c.workspace_id, c.workstation_id, c.session_id,
                  actor.display_name AS actor_name, c.status, c.content_length,
                  count(attachment.attachment_id)::int AS attachment_count,
                  c.turn_id, c.error_code, c.created_at, c.updated_at, c.delivered_at
             FROM session_commands c
             JOIN app_users actor ON actor.id = c.actor_user_id
             LEFT JOIN session_command_attachments attachment
               ON attachment.workspace_id = c.workspace_id AND attachment.command_id = c.id
            WHERE ($1 = '' OR c.workspace_id = $1::uuid)
            GROUP BY c.workspace_id, c.id, actor.display_name
            ORDER BY c.created_at DESC LIMIT 200`,
          [scope],
        );
    const requests = await queryRequests(client, scope);
    const members = await client.query<DbRow>(
          `SELECT m.id, m.workspace_id, m.user_id, u.display_name, u.email, m.role,
                  count(w.id) FILTER (
                    WHERE m.role IN ('owner', 'admin') OR COALESCE(a.can_view, false)
                  )::int AS workstation_count,
                  COALESCE(jsonb_agg(jsonb_build_object(
                    'workstationId', w.id,
                    'workstationName', w.name,
                    'canView', m.role IN ('owner', 'admin') OR COALESCE(a.can_view, false),
                    'canRespond', m.role IN ('owner', 'admin') OR COALESCE(a.can_respond, false),
                    'canApproveHighRisk', m.role IN ('owner', 'admin') OR COALESCE(a.can_approve_high_risk, false),
                    'canManage', m.role IN ('owner', 'admin') OR COALESCE(a.can_manage, false),
                    'canPreview', m.role IN ('owner', 'admin') OR COALESCE(a.can_preview, false)
                  ) ORDER BY lower(w.name)) FILTER (WHERE w.id IS NOT NULL), '[]'::jsonb) AS workstation_access
             FROM workspace_members m
             JOIN app_users u ON u.id = m.user_id
             LEFT JOIN workstations w ON w.workspace_id = m.workspace_id
             LEFT JOIN workstation_access a ON a.workspace_id = m.workspace_id
               AND a.workstation_id = w.id AND a.user_id = m.user_id
            WHERE ($1 = '' OR m.workspace_id = $1::uuid)
            GROUP BY m.workspace_id, m.id, m.user_id, u.display_name, u.email
            ORDER BY m.role, lower(u.display_name)`,
          [scope],
        );
    const usage = await client.query<DbRow>(
          `SELECT t.id, t.workspace_id, t.workstation_id, w.name AS workstation_name,
                  t.session_id, s.project_name, t.model, t.input_tokens, t.cached_input_tokens,
                  t.output_tokens, t.reasoning_tokens, t.total_tokens, t.quality,
                  t.estimated_cost_micros, t.price_version, t.updated_at
             FROM token_usage_rollups t
             JOIN workstations w ON w.workspace_id = t.workspace_id AND w.id = t.workstation_id
             JOIN agent_sessions s ON s.workspace_id = t.workspace_id AND s.id = t.session_id
            WHERE ($1 = '' OR t.workspace_id = $1::uuid)
            ORDER BY t.updated_at DESC`,
          [scope],
        );
    const audit = await client.query<DbRow>(
          `SELECT a.id, a.workspace_id, u.display_name AS actor_name, a.action,
                  a.entity_type, a.entity_id, a.previous_state, a.next_state,
                  a.occurred_at, a.metadata
             FROM audit_events a
             LEFT JOIN app_users u ON u.id = a.actor_user_id
            WHERE ($1 = '' OR a.workspace_id = $1::uuid)
            ORDER BY a.occurred_at DESC LIMIT 200`,
          [scope],
        );

    return {
      generatedAt: new Date().toISOString(),
      scopeWorkspaceId: workspaceId,
      workspaces: workspaces.rows.map(mapWorkspace),
      workstations: workstations.rows.map(mapWorkstation),
      previews,
      previewCapability,
      sessions: sessions.rows.map(mapSession),
      sessionCommands: sessionCommands.rows.map(mapSessionCommand),
      requests: requests.rows.map(mapRequest),
      members: members.rows.map(mapMember),
      usage: usage.rows.map(mapUsage),
      audit: audit.rows.map(mapAudit),
    };
  });
}

export async function sendSessionCommand(
  pool: Pool,
  userId: string,
  sessionId: string,
  idempotencyKey: string,
  content: string,
  attachmentInputs: SessionCommandAttachmentInput[],
  ticketSecret: string,
): Promise<SessionCommandResult> {
  const text = content.trim();
  const contentLength = Array.from(text).length;
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be 8 to 200 characters");
  }
  if (contentLength > 8_000) {
    throw new HttpError(400, "invalid_message", "Message must be at most 8,000 characters");
  }
  if (attachmentInputs.length > sessionImageLimits.maxAttachments) {
    throw new HttpError(400, "too_many_attachments", "A message can contain at most four images");
  }
  const decodedTickets = attachmentInputs.map(({ ticket }) => {
    const binding = readAttachmentTicket(ticketSecret, ticket, Date.now(), false);
    if (binding === null) {
      throw new HttpError(400, "invalid_attachment_ticket", "An image attachment ticket is invalid");
    }
    return binding;
  });
  if (contentLength === 0 && decodedTickets.length === 0) {
    throw new HttpError(400, "invalid_message", "A message or image is required");
  }

  return withUserTransaction(pool, userId, null, async (client) => {
    const selected = await client.query<DbRow>(
      `SELECT s.workspace_id, s.workstation_id, s.thread_id,
              app_can_respond(s.workspace_id, s.workstation_id, false) AS can_respond
         FROM agent_sessions s
        WHERE s.id = $1
          AND s.sync_state <> 'stale'
        FOR UPDATE`,
      [sessionId],
    );
    const session = selected.rows[0];
    if (session === undefined) {
      throw new HttpError(404, "session_not_found", "Session was not found or is not accessible");
    }
    if (session.can_respond !== true) {
      throw new HttpError(403, "permission_denied", "You cannot send messages to this session");
    }

    const workspaceId = stringValue(session.workspace_id);
    const workstationId = stringValue(session.workstation_id);
    const threadId = stringValue(session.thread_id);
    if (decodedTickets.some((ticket) =>
      ticket.userId !== userId ||
      ticket.sessionId !== sessionId ||
      ticket.workspaceId !== workspaceId ||
      ticket.workstationId !== workstationId)) {
      throw new HttpError(403, "attachment_ticket_scope_mismatch", "An image attachment is not authorized for this session");
    }
    const attachmentIds = new Set(decodedTickets.map((ticket) => ticket.attachmentId));
    if (attachmentIds.size !== decodedTickets.length) {
      throw new HttpError(400, "duplicate_attachment", "The same image cannot be attached twice");
    }
    const totalAttachmentBytes = decodedTickets.reduce((total, ticket) => total + ticket.byteLength, 0);
    if (totalAttachmentBytes > sessionImageLimits.maxTotalBytes) {
      throw new HttpError(400, "attachments_too_large", "Images can total at most 12 MiB");
    }
    const attachments: SessionCommandAttachment[] = decodedTickets.map((ticket) => ({
      attachmentId: ticket.attachmentId,
      mimeType: ticket.mimeType,
      byteLength: ticket.byteLength,
      sha256: ticket.sha256,
    }));
    const fingerprint = createHash("sha256")
      .update(sessionId)
      .update("\0")
      .update(text)
      .update("\0")
      .update(attachments.map((attachment) =>
        `${attachment.mimeType}:${attachment.byteLength}:${attachment.sha256}`).join("\0"))
      .digest("hex");
    const existing = await client.query<DbRow>(
      `SELECT id, payload_hash, session_id FROM session_commands
        WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey],
    );
    const existingCommand = existing.rows[0];
    if (existingCommand !== undefined) {
      if (
        stringValue(existingCommand.session_id) !== sessionId ||
        stringValue(existingCommand.payload_hash) !== fingerprint
      ) {
        throw new HttpError(409, "idempotency_key_reused", "Idempotency key is bound to another message");
      }
      return {
        command: await getSessionCommand(client, stringValue(existingCommand.id)),
        replayed: true,
      };
    }

    if (decodedTickets.some((ticket) => ticket.expiresAt <= Math.floor(Date.now() / 1_000))) {
      throw new HttpError(410, "attachment_ticket_expired", "An image attachment ticket has expired");
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO session_commands
         (workspace_id, workstation_id, session_id, actor_user_id, idempotency_key,
          payload_hash, content_length)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [workspaceId, workstationId, sessionId, userId, idempotencyKey, fingerprint, contentLength],
    );
    const commandId = inserted.rows[0]?.id;
    if (commandId === undefined) throw new Error("Session command insert did not return an id");

    for (const [position, attachment] of attachments.entries()) {
      const stored = await client.query(
        `INSERT INTO session_command_attachments
           (workspace_id, workstation_id, command_id, position, attachment_id,
            mime_type, byte_length, sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING
         RETURNING attachment_id`,
        [workspaceId, workstationId, commandId, position, attachment.attachmentId,
          attachment.mimeType, attachment.byteLength, attachment.sha256],
      );
      if (stored.rowCount !== 1) {
        throw new HttpError(409, "attachment_already_used", "An image attachment was already used by another message");
      }
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [workstationId]);
    const sequenceResult = await client.query<{ next_sequence: string }>(
      `SELECT (COALESCE(max(sequence), 0) + 1)::text AS next_sequence
         FROM connector_outbox WHERE workspace_id = $1 AND workstation_id = $2`,
      [workspaceId, workstationId],
    );
    await client.query(
      `INSERT INTO connector_outbox
         (workspace_id, workstation_id, command_id, message_type, payload, sequence)
       VALUES ($1, $2, $3, 'session.command', $4::jsonb, $5)`,
      [workspaceId, workstationId, commandId, JSON.stringify({ commandId, threadId, text, attachments }), sequenceResult.rows[0]?.next_sequence ?? "1"],
    );
    await client.query(
      `INSERT INTO audit_events
         (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id,
          previous_state, next_state, metadata)
       VALUES ($1, $2, 'user', 'session.message_queued', 'session_command', $3,
               NULL, 'queued', $4::jsonb)`,
      [workspaceId, userId, commandId, JSON.stringify({
        sessionId,
        workstationId,
        contentLength,
        attachmentCount: attachments.length,
      })],
    );
    return { command: await getSessionCommand(client, commandId), replayed: false };
  });
}

export async function decideRequest(
  pool: Pool,
  userId: string,
  requestId: string,
  idempotencyKey: string,
  input: DecisionInput,
): Promise<DecisionResult> {
  validateDecision(idempotencyKey, input);
  const outcome = await withUserTransaction<DecisionResult | { expired: RequestSummary }>(pool, userId, null, async (client) => {
    const selected = await client.query<DbRow>(
      `SELECT r.*, app_can_respond(r.workspace_id, r.workstation_id, r.risk = 'high') AS can_respond
         FROM agent_requests r WHERE r.id = $1 FOR UPDATE`,
      [requestId],
    );
    const request = selected.rows[0];
    if (request === undefined) {
      throw new HttpError(404, "request_not_found", "Request was not found or is not accessible");
    }
    if (request.can_respond !== true) {
      throw new HttpError(403, "permission_denied", "You cannot handle this request");
    }

    const workspaceId = stringValue(request.workspace_id);
    const fingerprint = decisionFingerprint(requestId, input);
    const existingKey = await client.query<DbRow>(
      `SELECT payload_hash, request_id FROM request_decisions
       WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey],
    );
    const keyRow = existingKey.rows[0];
    if (keyRow !== undefined) {
      if (
        stringValue(keyRow.request_id) !== requestId ||
        stringValue(keyRow.payload_hash) !== fingerprint
      ) {
        throw new HttpError(409, "idempotency_key_reused", "Idempotency key is bound to another decision");
      }
      return { request: await getRequest(client, requestId), replayed: true };
    }

    if (new Date(dateValue(request.expires_at)).getTime() <= Date.now() && request.status === "pending") {
      await client.query(
        `UPDATE agent_requests SET status = 'expired', updated_at = now()
         WHERE workspace_id = $1 AND id = $2 AND status = 'pending'`,
        [workspaceId, requestId],
      );
      await client.query(
        `INSERT INTO audit_events
           (workspace_id, actor_kind, action, entity_type, entity_id, previous_state, next_state, metadata)
         VALUES ($1, 'system', 'request.expired', 'request', $2, 'pending', 'expired',
                 '{"reason":"deadline_elapsed"}'::jsonb)`,
        [workspaceId, requestId],
      );
      return { expired: await getRequest(client, requestId) };
    }
    if (request.status !== "pending") {
      throw await decisionConflict(client, requestId, "Request already has a final result");
    }
    validateDecisionForRequest(request, input);
    if (request.risk === "high" && input.decision === "approve" && input.highRiskConfirmed !== true) {
      throw new HttpError(400, "high_risk_confirmation_required", "High-risk approval requires explicit confirmation");
    }

    const nextStatus = input.decision === "deny" ? "denied" : "approved";
    const update = await client.query(
      `UPDATE agent_requests
          SET status = $3,
              delivery_status = 'queued',
              decided_by_user_id = $4,
              decision_reason = $5,
              decision_payload = $6::jsonb,
              decided_at = now(),
              updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND status = 'pending'
        RETURNING id`,
      [workspaceId, requestId, nextStatus, userId, input.reason ?? null, JSON.stringify(input.answers ?? {})],
    );
    if (update.rowCount !== 1) {
      throw await decisionConflict(client, requestId, "Another collaborator handled this request");
    }

    await client.query(
      `INSERT INTO request_decisions
         (workspace_id, request_id, actor_user_id, idempotency_key, payload_hash, decision, reason, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [workspaceId, requestId, userId, idempotencyKey, fingerprint, input.decision, input.reason ?? null, JSON.stringify(input)],
    );
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [stringValue(request.workstation_id)]);
    const sequenceResult = await client.query<{ next_sequence: string }>(
      `SELECT (COALESCE(max(sequence), 0) + 1)::text AS next_sequence
         FROM connector_outbox WHERE workspace_id = $1 AND workstation_id = $2`,
      [workspaceId, request.workstation_id],
    );
    const sequence = sequenceResult.rows[0]?.next_sequence ?? "1";
    await client.query(
      `INSERT INTO connector_outbox
         (workspace_id, workstation_id, request_id, message_type, payload, sequence)
       VALUES ($1, $2, $3, 'decision', $4::jsonb, $5)`,
      [workspaceId, request.workstation_id, requestId, JSON.stringify({ requestId, decision: input, actorUserId: userId }), sequence],
    );
    await client.query(
      `INSERT INTO audit_events
         (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, previous_state, next_state, metadata)
       VALUES ($1, $2, 'user', $3, 'request', $4, 'pending', $5, $6::jsonb)`,
      [workspaceId, userId, `request.${input.decision}`, requestId, nextStatus, JSON.stringify({ idempotencyKey, deliveryStatus: "queued" })],
    );

    return { request: await getRequest(client, requestId), replayed: false };
  });
  if ("expired" in outcome) {
    throw new HttpError(409, "decision_conflict", "Request has expired", { request: outcome.expired });
  }
  return outcome;
}

async function queryRequests(client: PoolClient, scope: string) {
  return client.query<DbRow>(
    `${requestSelect()}
     WHERE ($1 = '' OR r.workspace_id = $1::uuid)
     ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.requested_at DESC`,
    [scope],
  );
}

async function getRequest(client: PoolClient, requestId: string): Promise<RequestSummary> {
  const result = await client.query<DbRow>(`${requestSelect()} WHERE r.id = $1`, [requestId]);
  const row = result.rows[0];
  if (row === undefined) {
    throw new HttpError(404, "request_not_found", "Request was not found");
  }
  return mapRequest(row);
}

async function getSessionCommand(client: PoolClient, commandId: string): Promise<SessionCommandSummary> {
  const result = await client.query<DbRow>(
    `SELECT c.id, c.workspace_id, c.workstation_id, c.session_id,
            actor.display_name AS actor_name, c.status, c.content_length,
            count(attachment.attachment_id)::int AS attachment_count,
            c.turn_id, c.error_code, c.created_at, c.updated_at, c.delivered_at
       FROM session_commands c
       JOIN app_users actor ON actor.id = c.actor_user_id
       LEFT JOIN session_command_attachments attachment
         ON attachment.workspace_id = c.workspace_id AND attachment.command_id = c.id
      WHERE c.id = $1
      GROUP BY c.workspace_id, c.id, actor.display_name`,
    [commandId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new HttpError(404, "session_command_not_found", "Session command was not found");
  return mapSessionCommand(row);
}

function requestSelect(): string {
  return `SELECT r.id, r.workspace_id, ws.name AS workspace_name, r.workstation_id,
                 w.name AS workstation_name, r.session_id, initiator.display_name AS session_initiator_name,
                 s.project_name, r.kind, r.category, r.tool, r.risk, r.context,
                 r.status, r.delivery_status, assigned.display_name AS assigned_to_name,
                 decided.display_name AS decided_by_name, r.decision_reason,
                 r.requested_at, r.expires_at, r.decided_at
            FROM agent_requests r
            JOIN workspaces ws ON ws.id = r.workspace_id
            JOIN workstations w ON w.workspace_id = r.workspace_id AND w.id = r.workstation_id
            JOIN agent_sessions s ON s.workspace_id = r.workspace_id AND s.id = r.session_id
            LEFT JOIN app_users initiator ON initiator.id = s.initiator_user_id
            LEFT JOIN app_users assigned ON assigned.id = r.assigned_to_user_id
            LEFT JOIN app_users decided ON decided.id = r.decided_by_user_id`;
}

async function decisionConflict(client: PoolClient, requestId: string, message: string): Promise<HttpError> {
  return new HttpError(409, "decision_conflict", message, { request: await getRequest(client, requestId) });
}

function validateDecision(idempotencyKey: string, input: DecisionInput): void {
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be 8 to 200 characters");
  }
  if (!(["approve", "deny", "answer"] as const).includes(input.decision)) {
    throw new HttpError(400, "invalid_decision", "Decision is invalid");
  }
  if (input.decision === "deny" && (input.reason?.trim().length ?? 0) < 3) {
    throw new HttpError(400, "reason_required", "A rejection reason is required");
  }
  if (input.decision === "answer" && Object.keys(input.answers ?? {}).length === 0) {
    throw new HttpError(400, "answers_required", "At least one answer is required");
  }
}

function validateDecisionForRequest(request: DbRow, input: DecisionInput): void {
  const kind = stringValue(request.kind);
  if (kind === "approval" && input.decision === "answer") {
    throw new HttpError(400, "decision_kind_mismatch", "Approval requests cannot be answered");
  }
  if (kind !== "question") return;
  if (input.decision !== "answer") {
    throw new HttpError(400, "decision_kind_mismatch", "Question requests require structured answers");
  }

  const context = (request.context ?? {}) as RequestSummary["context"];
  const questions = context.questions ?? [];
  const answers = input.answers ?? {};
  const questionIds = new Set(questions.map((question) => question.id));
  if (Object.keys(answers).some((id) => !questionIds.has(id))) {
    throw new HttpError(400, "unknown_question", "Answers contain an unknown question identifier");
  }
  for (const question of questions) {
    const values = answers[question.id] ?? [];
    if (values.length === 0 || values.some((value) => value.trim().length === 0)) {
      throw new HttpError(400, "answers_incomplete", "Every question requires an answer");
    }
    if (question.isSecret) {
      throw new HttpError(
        422,
        "secret_answer_local_only",
        "Secret answers must be entered directly at the workstation",
      );
    }
  }
}

function decisionFingerprint(requestId: string, input: DecisionInput): string {
  return createHash("sha256").update(requestId).update("\0").update(stableJson(input)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function mapWorkspace(row: DbRow): WorkspaceSummary {
  return { id: stringValue(row.id), name: stringValue(row.name), slug: stringValue(row.slug), kind: row.kind as WorkspaceSummary["kind"], role: row.role as WorkspaceSummary["role"], pendingCount: numberValue(row.pending_count) };
}
function mapWorkstation(row: DbRow): WorkstationSummary {
  return { id: stringValue(row.id), workspaceId: stringValue(row.workspace_id), workspaceName: stringValue(row.workspace_name), name: stringValue(row.name), platform: stringValue(row.platform), connectorVersion: stringValue(row.connector_version), status: row.status as WorkstationSummary["status"], lastSeenAt: nullableDate(row.last_seen_at), activeSessionCount: numberValue(row.active_session_count), pendingCount: numberValue(row.pending_count) };
}
function mapSession(row: DbRow): SessionSummary {
  return { id: stringValue(row.id), workspaceId: stringValue(row.workspace_id), workstationId: stringValue(row.workstation_id), workstationName: stringValue(row.workstation_name), initiatorName: nullableString(row.initiator_name), agent: stringValue(row.agent ?? "codex"), threadId: stringValue(row.thread_id), projectKey: stringValue(row.project_key), projectName: stringValue(row.project_name), projectPath: stringValue(row.project_path_hint), model: stringValue(row.model), status: row.status as SessionSummary["status"], syncState: row.sync_state as SessionSummary["syncState"], startedAt: dateValue(row.started_at), updatedAt: dateValue(row.updated_at) };
}
function mapSessionCommand(row: DbRow): SessionCommandSummary {
  return { id: stringValue(row.id), workspaceId: stringValue(row.workspace_id), workstationId: stringValue(row.workstation_id), sessionId: stringValue(row.session_id), actorName: stringValue(row.actor_name), status: row.status as SessionCommandSummary["status"], contentLength: numberValue(row.content_length), attachmentCount: numberValue(row.attachment_count), turnId: nullableString(row.turn_id), errorCode: nullableString(row.error_code), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at), deliveredAt: nullableDate(row.delivered_at) };
}
function mapRequest(row: DbRow): RequestSummary {
  return { id: stringValue(row.id), workspaceId: stringValue(row.workspace_id), workspaceName: stringValue(row.workspace_name), workstationId: stringValue(row.workstation_id), workstationName: stringValue(row.workstation_name), sessionId: stringValue(row.session_id), sessionInitiatorName: nullableString(row.session_initiator_name), projectName: stringValue(row.project_name), kind: row.kind as RequestSummary["kind"], category: stringValue(row.category), tool: stringValue(row.tool), risk: row.risk as RequestSummary["risk"], context: (row.context ?? {}) as RequestSummary["context"], status: row.status as RequestSummary["status"], deliveryStatus: row.delivery_status as RequestSummary["deliveryStatus"], assignedToName: nullableString(row.assigned_to_name), decidedByName: nullableString(row.decided_by_name), decisionReason: nullableString(row.decision_reason), requestedAt: dateValue(row.requested_at), expiresAt: dateValue(row.expires_at), decidedAt: nullableDate(row.decided_at) };
}
function mapMember(row: DbRow): MemberSummary {
  const access = Array.isArray(row.workstation_access) ? row.workstation_access : [];
  return {
    id: stringValue(row.id),
    workspaceId: stringValue(row.workspace_id),
    userId: stringValue(row.user_id),
    name: stringValue(row.display_name),
    email: stringValue(row.email),
    role: row.role as MemberSummary["role"],
    workstationCount: numberValue(row.workstation_count),
    workstationAccess: access.map((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected workstation access object");
      }
      const grant = value as Record<string, unknown>;
      return {
        workstationId: stringValue(grant.workstationId),
        workstationName: stringValue(grant.workstationName),
        canView: grant.canView === true,
        canRespond: grant.canRespond === true,
        canApproveHighRisk: grant.canApproveHighRisk === true,
        canManage: grant.canManage === true,
        canPreview: grant.canPreview === true,
      };
    }),
  };
}
function mapUsage(row: DbRow): UsageSummary {
  return { id: stringValue(row.id), workspaceId: stringValue(row.workspace_id), workstationId: stringValue(row.workstation_id), workstationName: stringValue(row.workstation_name), sessionId: stringValue(row.session_id), projectName: stringValue(row.project_name), model: stringValue(row.model), inputTokens: numberValue(row.input_tokens), cachedInputTokens: numberValue(row.cached_input_tokens), outputTokens: numberValue(row.output_tokens), reasoningTokens: numberValue(row.reasoning_tokens), totalTokens: numberValue(row.total_tokens), quality: row.quality as UsageSummary["quality"], estimatedCostMicros: row.estimated_cost_micros === null ? null : numberValue(row.estimated_cost_micros), priceVersion: nullableString(row.price_version), updatedAt: dateValue(row.updated_at) };
}
function mapAudit(row: DbRow): AuditSummary {
  return { id: stringValue(row.id), workspaceId: stringValue(row.workspace_id), actorName: nullableString(row.actor_name), action: stringValue(row.action), entityType: stringValue(row.entity_type), entityId: stringValue(row.entity_id), previousState: nullableString(row.previous_state), nextState: nullableString(row.next_state), occurredAt: dateValue(row.occurred_at), metadata: (row.metadata ?? {}) as Record<string, unknown> };
}

function stringValue(value: unknown): string { if (typeof value !== "string") throw new Error("Expected string database value"); return value; }
function nullableString(value: unknown): string | null { return value === null || value === undefined ? null : stringValue(value); }
function numberValue(value: unknown): number { const parsed = typeof value === "number" ? value : Number(value); if (!Number.isSafeInteger(parsed)) throw new Error("Expected safe integer database value"); return parsed; }
function dateValue(value: unknown): string { if (!(value instanceof Date)) throw new Error("Expected Date database value"); return value.toISOString(); }
function nullableDate(value: unknown): string | null { return value === null || value === undefined ? null : dateValue(value); }
