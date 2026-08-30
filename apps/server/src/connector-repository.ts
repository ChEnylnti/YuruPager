import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
  sessionImageLimits,
  sessionImageMimeTypes,
  type ConnectorPayload,
  type DecisionInput,
  type SessionCommandAttachment,
  type TransportEnvelope,
} from "@yurupager/shared";

import { withServiceTransaction } from "./database.js";
import { HttpError } from "./errors.js";

export interface ConnectorIdentity {
  workspaceId: string;
  workstationId: string;
}

export interface ConnectorProcessResult {
  duplicate: boolean;
  sequence: number;
  workspaceId: string;
  pushRequest?: {
    workspaceId: string;
    workstationId: string;
    requestId: string;
    occurredAt: string;
  };
}

export async function findConnectorIdentity(
  pool: Pool,
  token: string,
): Promise<ConnectorIdentity | null> {
  const credentialHash = createHash("sha256").update(token).digest("hex");
  const result = await pool.query<{ workspace_id: string; id: string }>(
    `SELECT workspace_id, id FROM workstations
      WHERE credential_hash = $1 AND revoked_at IS NULL
      LIMIT 1`,
    [credentialHash],
  );
  const row = result.rows[0];
  return row === undefined ? null : { workspaceId: row.workspace_id, workstationId: row.id };
}

export async function findPairedConnectorIdentity(
  pool: Pool,
  token: string,
): Promise<ConnectorIdentity | null> {
  const credentialHash = createHash("sha256").update(token).digest("hex");
  const result = await pool.query<{ workspace_id: string; id: string }>(
    `SELECT w.workspace_id, w.id
       FROM workstations w
      WHERE w.credential_hash = $1
        AND w.revoked_at IS NULL
        AND EXISTS (
          SELECT 1
            FROM workstation_pairings p
           WHERE p.workspace_id = w.workspace_id
             AND p.workstation_id = w.id
             AND p.status = 'approved'
        )
      LIMIT 1`,
    [credentialHash],
  );
  const row = result.rows[0];
  return row === undefined ? null : { workspaceId: row.workspace_id, workstationId: row.id };
}

export interface OutboxDecision {
  messageId: string;
  sequence: number;
  requestId: string;
  decisionId: string;
  decision: DecisionInput;
}

export interface OutboxSessionCommand {
  messageId: string;
  sequence: number;
  commandId: string;
  threadId: string;
  text: string;
  attachments: SessionCommandAttachment[];
}

export async function processConnectorEnvelope(
  pool: Pool,
  identity: ConnectorIdentity,
  envelope: TransportEnvelope<ConnectorPayload>,
): Promise<ConnectorProcessResult> {
  return withServiceTransaction(pool, identity.workspaceId, async (client) => {
    const inserted = await client.query(
      `INSERT INTO connector_inbox
         (workspace_id, workstation_id, message_id, connection_epoch, sequence, idempotency_key, payload_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_id, workstation_id, message_id) DO NOTHING
       RETURNING id`,
      [identity.workspaceId, identity.workstationId, envelope.messageId, envelope.connectionEpoch, envelope.sequence, envelope.idempotencyKey, envelope.payload.type],
    );
    if (inserted.rowCount === 0) {
      return { duplicate: true, sequence: envelope.sequence, workspaceId: identity.workspaceId };
    }

    const effects: { pushRequest?: ConnectorProcessResult["pushRequest"] } = {};
    await applyPayload(client, identity, envelope, effects);
    await client.query(
      `UPDATE connector_inbox SET processed_at = now()
       WHERE workspace_id = $1 AND workstation_id = $2 AND message_id = $3`,
      [identity.workspaceId, identity.workstationId, envelope.messageId],
    );
    return {
      duplicate: false,
      sequence: envelope.sequence,
      workspaceId: identity.workspaceId,
      ...(effects.pushRequest === undefined ? {} : { pushRequest: effects.pushRequest }),
    };
  });
}

export async function getConnectorCursor(
  pool: Pool,
  identity: ConnectorIdentity,
): Promise<number> {
  return withServiceTransaction(pool, identity.workspaceId, async (client) => {
    const result = await client.query<{ sequence: string }>(
      `SELECT COALESCE(max(sequence), 0)::text AS sequence FROM connector_inbox
       WHERE workspace_id = $1 AND workstation_id = $2`,
      [identity.workspaceId, identity.workstationId],
    );
    return Number(result.rows[0]?.sequence ?? 0);
  });
}

export async function getPendingConnectorDecisions(
  pool: Pool,
  identity: ConnectorIdentity,
): Promise<OutboxDecision[]> {
  return withServiceTransaction(pool, identity.workspaceId, async (client) => {
    const result = await client.query<{
      id: string;
      sequence: string;
      request_id: string;
      payload: { decision?: DecisionInput };
    }>(
      `SELECT o.id, o.sequence::text, o.request_id, o.payload
         FROM connector_outbox o
         JOIN agent_requests r ON r.workspace_id = o.workspace_id AND r.id = o.request_id
        WHERE o.workspace_id = $1 AND o.workstation_id = $2
          AND o.acknowledged_at IS NULL
          AND r.delivery_status <> 'sent_unknown'
        ORDER BY o.sequence`,
      [identity.workspaceId, identity.workstationId],
    );
    return result.rows.map((row) => ({
      messageId: row.id,
      sequence: Number(row.sequence),
      requestId: row.request_id,
      decisionId: row.id,
      decision: requireDecision(row.payload.decision),
    }));
  });
}

export async function getPendingConnectorDecision(
  pool: Pool,
  identity: ConnectorIdentity,
  requestId: string,
): Promise<OutboxDecision | null> {
  const decisions = await getPendingConnectorDecisions(pool, identity);
  return decisions.find((decision) => decision.requestId === requestId) ?? null;
}

export async function getPendingConnectorCommands(
  pool: Pool,
  identity: ConnectorIdentity,
): Promise<OutboxSessionCommand[]> {
  return withServiceTransaction(pool, identity.workspaceId, async (client) => {
    const result = await client.query<{
      id: string;
      sequence: string;
      command_id: string;
      payload: { commandId?: string; threadId?: string; text?: string; attachments?: unknown };
    }>(
      `SELECT o.id, o.sequence::text, o.command_id, o.payload
         FROM connector_outbox o
         JOIN session_commands c
           ON c.workspace_id = o.workspace_id AND c.id = o.command_id
        WHERE o.workspace_id = $1 AND o.workstation_id = $2
          AND o.message_type = 'session.command'
          AND o.acknowledged_at IS NULL
          AND c.status = 'queued'
        ORDER BY o.sequence`,
      [identity.workspaceId, identity.workstationId],
    );
    return result.rows.map((row) => {
      if (
        row.payload.commandId !== row.command_id ||
        typeof row.payload.threadId !== "string" ||
        typeof row.payload.text !== "string"
      ) {
        throw new Error("Session command Outbox payload is invalid");
      }
      return {
        messageId: row.id,
        sequence: Number(row.sequence),
        commandId: row.command_id,
        threadId: row.payload.threadId,
        text: row.payload.text,
        attachments: requireCommandAttachments(row.payload.attachments),
      };
    });
  });
}

export async function getPendingConnectorCommand(
  pool: Pool,
  identity: ConnectorIdentity,
  commandId: string,
): Promise<OutboxSessionCommand | null> {
  const commands = await getPendingConnectorCommands(pool, identity);
  return commands.find((command) => command.commandId === commandId) ?? null;
}

export async function acknowledgeConnectorOutbox(
  pool: Pool,
  identity: ConnectorIdentity,
  messageId: string,
): Promise<void> {
  await withServiceTransaction(pool, identity.workspaceId, async (client) => {
    await client.query(
      `UPDATE connector_outbox
          SET acknowledged_at = COALESCE(acknowledged_at, now()),
              payload = CASE WHEN message_type = 'session.command'
                THEN jsonb_build_object('commandId', command_id, 'redacted', true)
                ELSE payload END
       WHERE workspace_id = $1 AND workstation_id = $2 AND id = $3`,
      [identity.workspaceId, identity.workstationId, messageId],
    );
  });
}

export async function heartbeatWorkstation(
  pool: Pool,
  identity: ConnectorIdentity,
): Promise<void> {
  await withServiceTransaction(pool, identity.workspaceId, async (client) => {
    await client.query(
      `UPDATE workstations SET status = 'online', last_seen_at = now()
       WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL`,
      [identity.workspaceId, identity.workstationId],
    );
  });
}

async function applyPayload(
  client: PoolClient,
  identity: ConnectorIdentity,
  envelope: TransportEnvelope<ConnectorPayload>,
  effects: { pushRequest?: ConnectorProcessResult["pushRequest"] },
): Promise<void> {
  const payload = envelope.payload;
  if (payload.type === "workstation.heartbeat") {
    await client.query(
      `UPDATE workstations SET name = $3, platform = $4, connector_version = $5,
              status = 'online', last_seen_at = now()
       WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL`,
      [identity.workspaceId, identity.workstationId, payload.name, payload.platform, payload.connectorVersion],
    );
    return;
  }

  if (payload.type === "session.upsert") {
    const initiator = payload.initiatedByEmail === undefined
      ? null
      : (await client.query<{ id: string }>("SELECT id FROM app_users WHERE lower(email) = lower($1)", [payload.initiatedByEmail])).rows[0]?.id ?? null;
    await client.query(
      `INSERT INTO agent_sessions
         (workspace_id, workstation_id, agent, initiator_user_id, thread_id, latest_turn_id,
          project_key, project_name, project_path_hint, model, status, sync_state, started_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               COALESCE($12, 'live'), COALESCE($13::timestamptz, now()), COALESCE($14::timestamptz, now()))
       ON CONFLICT (workspace_id, workstation_id, agent, thread_id) DO UPDATE SET
         initiator_user_id = COALESCE(EXCLUDED.initiator_user_id, agent_sessions.initiator_user_id),
         latest_turn_id = COALESCE(EXCLUDED.latest_turn_id, agent_sessions.latest_turn_id),
         project_key = EXCLUDED.project_key,
         project_name = EXCLUDED.project_name,
         project_path_hint = EXCLUDED.project_path_hint,
         model = EXCLUDED.model,
         sync_state = EXCLUDED.sync_state,
         status = CASE
           WHEN EXCLUDED.sync_state = 'historical' THEN 'completed'
           WHEN EXCLUDED.updated_at >= agent_sessions.updated_at THEN EXCLUDED.status
           ELSE agent_sessions.status
         END,
         started_at = LEAST(agent_sessions.started_at, EXCLUDED.started_at),
         updated_at = GREATEST(agent_sessions.updated_at, EXCLUDED.updated_at)`,
      [identity.workspaceId, identity.workstationId, payload.agent ?? "codex", initiator, payload.threadId, payload.turnId ?? null, payload.projectKey, payload.projectName, payload.projectPath, payload.model, payload.status, payload.syncState ?? (payload.status === "waiting" || payload.status === "running" ? "live" : "historical"), payload.startedAt ?? null, payload.updatedAt ?? null],
    );
    return;
  }

  if (payload.type === "session.inventory") {
    const threadIds = payload.threadIds;
    await client.query(
      `UPDATE agent_sessions
          SET sync_state = 'stale'
        WHERE workspace_id = $1
          AND workstation_id = $2
          AND agent = $4
          AND sync_state <> 'stale'
          AND NOT (thread_id = ANY($3::text[]))`,
      [identity.workspaceId, identity.workstationId, threadIds, payload.agent ?? "codex"],
    );
    await client.query(
      `UPDATE agent_sessions
          SET sync_state = CASE WHEN status IN ('running', 'waiting') THEN 'live' ELSE 'historical' END
        WHERE workspace_id = $1
          AND workstation_id = $2
          AND thread_id = ANY($3::text[])`,
      [identity.workspaceId, identity.workstationId, threadIds],
    );
    return;
  }

  if (payload.type === "delivery.updated" || payload.type === "request.resolved") {
    if (payload.type === "request.resolved") {
      await client.query(
        `UPDATE agent_requests SET status = $3, updated_at = now()
         WHERE workspace_id = $1 AND id = $2 AND status = 'pending'`,
        [identity.workspaceId, payload.requestId, payload.status],
      );
      await client.query(
        `INSERT INTO audit_events
           (workspace_id, actor_kind, action, entity_type, entity_id, previous_state, next_state, metadata)
         VALUES ($1, 'connector', 'request.resolved', 'request', $2, 'pending', $3, $4::jsonb)`,
        [identity.workspaceId, payload.requestId, payload.status, JSON.stringify({ reason: payload.reason })],
      );
      return;
    }
    const update = await client.query(
      `UPDATE agent_requests SET delivery_status = $3, updated_at = now()
       WHERE workspace_id = $1 AND id = $2`,
      [identity.workspaceId, payload.requestId, payload.deliveryStatus],
    );
    if (update.rowCount !== 1) {
      throw new HttpError(404, "request_not_found", "Delivery update request does not exist");
    }
    if (payload.deliveryStatus === "sent_unknown") {
      await client.query(
        `UPDATE connector_outbox SET acknowledged_at = COALESCE(acknowledged_at, now())
         WHERE workspace_id = $1 AND request_id = $2`,
        [identity.workspaceId, payload.requestId],
      );
    }
    await client.query(
      `INSERT INTO audit_events
         (workspace_id, actor_kind, action, entity_type, entity_id, previous_state, next_state, metadata)
       VALUES ($1, 'connector', $2, 'request', $3, NULL, $4, $5::jsonb)`,
      [identity.workspaceId, payload.deliveryStatus === "sent_unknown" ? "request.delivery_unknown" : "request.delivery_updated", payload.requestId, payload.deliveryStatus, JSON.stringify({ automaticRetry: payload.deliveryStatus !== "sent_unknown" })],
    );
    return;
  }

  if (payload.type === "session.command.updated") {
    const command = await client.query<{ status: string; thread_id: string; session_id: string }>(
      `SELECT c.status, s.thread_id, c.session_id
         FROM session_commands c
         JOIN agent_sessions s ON s.workspace_id = c.workspace_id AND s.id = c.session_id
        WHERE c.workspace_id = $1 AND c.workstation_id = $2 AND c.id = $3
        FOR UPDATE OF c`,
      [identity.workspaceId, identity.workstationId, payload.commandId],
    );
    const current = command.rows[0];
    if (current === undefined || current.thread_id !== payload.threadId) {
      throw new HttpError(404, "session_command_not_found", "Session command does not exist for this thread");
    }
    if (current.status !== "queued" && current.status !== payload.status) {
      throw new HttpError(409, "session_command_final", "Session command already has another final status");
    }
    if (current.status === "queued") {
      await client.query(
        `UPDATE session_commands
            SET status = $4, turn_id = COALESCE($5, turn_id), error_code = $6,
                delivered_at = CASE WHEN $4 = 'delivered' THEN now() ELSE delivered_at END,
                updated_at = now()
          WHERE workspace_id = $1 AND workstation_id = $2 AND id = $3`,
        [identity.workspaceId, identity.workstationId, payload.commandId, payload.status, payload.turnId ?? null, payload.errorCode ?? null],
      );
      if (payload.status === "delivered" && payload.turnId !== undefined) {
        await client.query(
          `UPDATE agent_sessions SET latest_turn_id = $4, status = 'running', sync_state = 'live', updated_at = now()
            WHERE workspace_id = $1 AND workstation_id = $2 AND id = $3`,
          [identity.workspaceId, identity.workstationId, current.session_id, payload.turnId],
        );
      }
      await client.query(
        `INSERT INTO audit_events
           (workspace_id, actor_kind, action, entity_type, entity_id,
            previous_state, next_state, metadata)
         VALUES ($1, 'connector', 'session.message_delivery_updated', 'session_command', $2,
                 'queued', $3, $4::jsonb)`,
        [identity.workspaceId, payload.commandId, payload.status, JSON.stringify({ turnId: payload.turnId ?? null, errorCode: payload.errorCode ?? null })],
      );
    }
    await client.query(
      `UPDATE connector_outbox
          SET acknowledged_at = COALESCE(acknowledged_at, now()),
              payload = jsonb_build_object('commandId', command_id, 'redacted', true)
        WHERE workspace_id = $1 AND workstation_id = $2 AND command_id = $3`,
      [identity.workspaceId, identity.workstationId, payload.commandId],
    );
    return;
  }

  const session = await client.query<{ id: string }>(
    `SELECT id FROM agent_sessions
     WHERE workspace_id = $1 AND workstation_id = $2 AND thread_id = $3`,
    [identity.workspaceId, identity.workstationId, payload.threadId],
  );
  const sessionId = session.rows[0]?.id;
  if (sessionId === undefined) {
    throw new HttpError(409, "session_missing", "Connector must register the session before sending its events");
  }

  if (payload.type === "request.created") {
    const inserted = await client.query(
      `INSERT INTO agent_requests
         (workspace_id, id, workstation_id, session_id, turn_id, item_id, kind, category,
          tool, risk, context, requested_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
       ON CONFLICT (workspace_id, id) DO NOTHING
       RETURNING id`,
      [identity.workspaceId, payload.requestId, identity.workstationId, sessionId, payload.turnId, payload.itemId, payload.kind, payload.category, payload.tool, payload.risk, JSON.stringify(payload.context), payload.requestedAt, payload.expiresAt],
    );
    await client.query(
      `UPDATE agent_sessions SET status = 'waiting', latest_turn_id = $4, updated_at = now()
       WHERE workspace_id = $1 AND id = $2 AND workstation_id = $3`,
      [identity.workspaceId, sessionId, identity.workstationId, payload.turnId],
    );
    if (inserted.rowCount === 1) {
      effects.pushRequest = {
        workspaceId: identity.workspaceId,
        workstationId: identity.workstationId,
        requestId: payload.requestId,
        occurredAt: payload.requestedAt,
      };
    }
    return;
  }

  if (payload.type === "token.snapshot") {
    const inserted = await client.query(
      `INSERT INTO token_usage_snapshots
         (workspace_id, workstation_id, session_id, event_id, connection_epoch, source_sequence,
          turn_id, provider, model, input_tokens, cached_input_tokens, output_tokens,
          reasoning_tokens, total_tokens, quality, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT DO NOTHING RETURNING id`,
      [identity.workspaceId, identity.workstationId, sessionId, payload.eventId, envelope.connectionEpoch, payload.sequence, payload.turnId, payload.provider ?? "openai", payload.model, payload.inputTokens, payload.cachedInputTokens, payload.outputTokens, payload.reasoningTokens, payload.totalTokens, payload.quality, payload.observedAt],
    );
    if (inserted.rowCount === 1) {
      await client.query(
        `WITH selected_price AS (
           SELECT version, input_micros_per_million, cached_input_micros_per_million,
                  output_micros_per_million
             FROM pricing_catalog
            WHERE provider = $14 AND model = $4
              AND effective_from <= $13::timestamptz
              AND (effective_to IS NULL OR effective_to > $13::timestamptz)
            ORDER BY effective_from DESC LIMIT 1
         ), priced AS (
           SELECT CASE WHEN price.version IS NULL THEN NULL ELSE
                    round((
                      greatest($7::numeric - $8::numeric, 0) * price.input_micros_per_million +
                      $8::numeric * price.cached_input_micros_per_million +
                      $9::numeric * price.output_micros_per_million
                    ) / 1000000)::bigint
                  END AS estimated_cost_micros,
                  price.version
             FROM (SELECT 1) seed LEFT JOIN selected_price price ON true
         )
         INSERT INTO token_usage_rollups
           (workspace_id, workstation_id, session_id, provider, model, latest_sequence, latest_event_id,
            input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, quality,
            estimated_cost_micros, price_version, updated_at)
         SELECT $1, $2, $3, $14, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                priced.estimated_cost_micros, priced.version, $13::timestamptz
           FROM priced
         ON CONFLICT (workspace_id, session_id, model) DO UPDATE SET
           latest_sequence = EXCLUDED.latest_sequence,
           latest_event_id = EXCLUDED.latest_event_id,
           input_tokens = EXCLUDED.input_tokens,
           cached_input_tokens = EXCLUDED.cached_input_tokens,
           output_tokens = EXCLUDED.output_tokens,
           reasoning_tokens = EXCLUDED.reasoning_tokens,
           total_tokens = EXCLUDED.total_tokens,
           quality = CASE WHEN
             token_usage_rollups.input_tokens > EXCLUDED.input_tokens OR
             token_usage_rollups.cached_input_tokens > EXCLUDED.cached_input_tokens OR
             token_usage_rollups.output_tokens > EXCLUDED.output_tokens OR
             token_usage_rollups.reasoning_tokens > EXCLUDED.reasoning_tokens OR
             token_usage_rollups.total_tokens > EXCLUDED.total_tokens
             THEN 'incomplete' ELSE EXCLUDED.quality END,
           estimated_cost_micros = EXCLUDED.estimated_cost_micros,
           price_version = EXCLUDED.price_version,
           updated_at = EXCLUDED.updated_at
         WHERE token_usage_rollups.latest_sequence < EXCLUDED.latest_sequence`,
        [identity.workspaceId, identity.workstationId, sessionId, payload.model, payload.sequence, payload.eventId, payload.inputTokens, payload.cachedInputTokens, payload.outputTokens, payload.reasoningTokens, payload.totalTokens, payload.quality, payload.observedAt, payload.provider ?? "openai"],
      );
    }
    return;
  }

  if (payload.type === "turn.completed") {
    const sessionStatus = payload.status === "completed" ? "completed" : payload.status;
    await client.query(
      `UPDATE agent_sessions SET status = $4, sync_state = 'live', latest_turn_id = $5, updated_at = now(),
              completed_at = CASE WHEN $4 = 'completed' THEN now() ELSE completed_at END
       WHERE workspace_id = $1 AND id = $2 AND workstation_id = $3`,
      [identity.workspaceId, sessionId, identity.workstationId, sessionStatus, payload.turnId],
    );
    await client.query(
      `UPDATE token_usage_rollups rollup
          SET quality = CASE
            WHEN snapshot.turn_id = $4 AND rollup.quality <> 'incomplete' THEN 'final'
            ELSE 'incomplete'
          END,
          updated_at = now()
         FROM token_usage_snapshots snapshot
        WHERE rollup.workspace_id = $1 AND rollup.session_id = $2
          AND rollup.workstation_id = $3
          AND snapshot.workspace_id = rollup.workspace_id
          AND snapshot.workstation_id = rollup.workstation_id
          AND snapshot.event_id = rollup.latest_event_id`,
      [identity.workspaceId, sessionId, identity.workstationId, payload.turnId],
    );
    if (payload.status === "interrupted") {
      const interrupted = await client.query<{ id: string }>(
        `UPDATE agent_requests SET status = 'interrupted', updated_at = now()
         WHERE workspace_id = $1 AND session_id = $2 AND turn_id = $3 AND status = 'pending'
         RETURNING id`,
        [identity.workspaceId, sessionId, payload.turnId],
      );
      for (const request of interrupted.rows) {
        await client.query(
          `INSERT INTO audit_events
             (workspace_id, actor_kind, action, entity_type, entity_id, previous_state, next_state, metadata)
           VALUES ($1, 'connector', 'request.interrupted', 'request', $2, 'pending', 'interrupted', '{"reason":"listener_restart"}')`,
          [identity.workspaceId, request.id],
        );
      }
    }
    return;
  }

}

function requireDecision(value: DecisionInput | undefined): DecisionInput {
  if (value === undefined) throw new Error("Connector outbox decision is missing");
  return value;
}

function requireCommandAttachments(value: unknown): SessionCommandAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > sessionImageLimits.maxAttachments) {
    throw new Error("Session command Outbox attachments are invalid");
  }
  const attachments = value.map((attachment) => {
    if (typeof attachment !== "object" || attachment === null || Array.isArray(attachment)) {
      throw new Error("Session command Outbox attachment is invalid");
    }
    const record = attachment as Record<string, unknown>;
    if (
      typeof record.attachmentId !== "string" ||
      record.attachmentId.length < 1 ||
      record.attachmentId.length > 500 ||
      !sessionImageMimeTypes.includes(record.mimeType as SessionCommandAttachment["mimeType"]) ||
      !Number.isSafeInteger(record.byteLength) ||
      Number(record.byteLength) < 1 ||
      Number(record.byteLength) > sessionImageLimits.maxAttachmentBytes ||
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(record.sha256)
    ) throw new Error("Session command Outbox attachment is invalid");
    return record as unknown as SessionCommandAttachment;
  });
  if (attachments.reduce((total, attachment) => total + attachment.byteLength, 0) > sessionImageLimits.maxTotalBytes) {
    throw new Error("Session command Outbox attachments are too large");
  }
  return attachments;
}
