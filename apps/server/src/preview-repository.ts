import type { Pool, PoolClient } from "pg";

import {
  previewLimits,
  type ConnectorPreviewRoute,
  type WorkstationPreviewStatus,
  type WorkstationPreviewSummary,
} from "@yurupager/shared";

import type { ConnectorIdentity } from "./connector-repository.js";
import { withServiceTransaction, withUserTransaction } from "./database.js";
import { HttpError } from "./errors.js";

const recentPreviewWindowMs = 24 * 60 * 60_000;
const routeClockToleranceMs = 30_000;

interface PreviewRow {
  id: string;
  workspace_id: string;
  workstation_id: string;
  workstation_name: string;
  route_id: string;
  name: string;
  local_port: number;
  status: WorkstationPreviewStatus;
  started_at: Date;
  last_seen_at: Date;
  stopped_at: Date | null;
  expires_at: Date;
  updated_at: Date;
}

export interface SyncConnectorPreviewOptions {
  now?: Date;
  maxDurationMs?: number;
}

interface ValidatedConnectorPreviewRoute extends Omit<ConnectorPreviewRoute, "expiresAt"> {
  expiresAt: Date;
}

export async function syncConnectorPreviewRoutes(
  pool: Pool,
  identity: ConnectorIdentity,
  routes: ConnectorPreviewRoute[],
  options: SyncConnectorPreviewOptions = {},
): Promise<WorkstationPreviewSummary[]> {
  const now = validDate(options.now ?? new Date(), "Invalid preview synchronization time");
  const maxDurationMs = readMaxDuration(options.maxDurationMs);
  const validated = validateRoutes(routes, now, maxDurationMs);
  if (validated.length === 0) return [];

  return withServiceTransaction(pool, identity.workspaceId, async (client) => {
    await lockActiveWorkstation(client, identity);
    await expirePreviews(client, identity, now);

    const routeIds = validated.map((route) => route.routeId);
    const selected = await client.query<PreviewRow>(
      `${previewSelect()}
        WHERE p.workspace_id = $1 AND p.workstation_id = $2
          AND p.route_id = ANY($3::text[])
        FOR UPDATE OF p`,
      [identity.workspaceId, identity.workstationId, routeIds],
    );
    const existing = new Map(selected.rows.map((row) => [row.route_id, row]));
    await enforceRouteLimit(client, identity, routeIds);

    const ids: string[] = [];
    for (const route of validated) {
      const previous = existing.get(route.routeId);
      if (previous === undefined) {
        const durationMs = route.expiresAt.getTime() - now.getTime();
        if (durationMs < previewLimits.minRouteDurationMs - routeClockToleranceMs) {
          throw new HttpError(
            400,
            "invalid_preview_expiration",
            "A new preview route is shorter than the minimum duration",
          );
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO workstation_previews
             (workspace_id, workstation_id, route_id, name, local_port, status,
              started_at, last_seen_at, expires_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $7)
           RETURNING id`,
          [
            identity.workspaceId,
            identity.workstationId,
            route.routeId,
            route.name,
            route.port,
            route.status,
            now,
            route.expiresAt,
          ],
        );
        const previewId = requireId(inserted.rows[0]);
        ids.push(previewId);
        await insertAudit(
          client,
          identity.workspaceId,
          null,
          "connector",
          "workstation.preview_started",
          previewId,
          null,
          route.status,
        );
        continue;
      }

      if (previous.status === "stopped" || previous.status === "expired") {
        throw new HttpError(
          409,
          "preview_route_final",
          "A stopped or expired preview route ID cannot be reused",
        );
      }
      if (
        previous.name !== route.name ||
        previous.local_port !== route.port ||
        previous.expires_at.getTime() !== route.expiresAt.getTime()
      ) {
        throw new HttpError(
          409,
          "preview_route_mismatch",
          "A preview route cannot change its name, port or expiration after creation",
        );
      }
      await client.query(
        `UPDATE workstation_previews
            SET status = $4,
                last_seen_at = $5,
                stopped_at = NULL,
                updated_at = $5
          WHERE workspace_id = $1 AND workstation_id = $2 AND route_id = $3`,
        [
          identity.workspaceId,
          identity.workstationId,
          route.routeId,
          route.status,
          now,
        ],
      );
      ids.push(previous.id);
      if (previous.status !== route.status) {
        await insertAudit(
          client,
          identity.workspaceId,
          null,
          "connector",
          previous.status === "connector_offline"
            ? "workstation.preview_reconnected"
            : "workstation.preview_status_changed",
          previous.id,
          previous.status,
          route.status,
        );
      }
    }
    return loadPreviewsByIds(client, identity.workspaceId, ids);
  });
}

export async function heartbeatConnectorPreviews(
  pool: Pool,
  identity: ConnectorIdentity,
  routeIds: string[],
  now = new Date(),
): Promise<void> {
  const ids = validateRouteIds(routeIds);
  if (ids.length === 0) return;
  const observedAt = validDate(now, "Invalid preview heartbeat time");
  await withServiceTransaction(pool, identity.workspaceId, async (client) => {
    await client.query(
      `UPDATE workstation_previews
          SET last_seen_at = $4
        WHERE workspace_id = $1 AND workstation_id = $2
          AND route_id = ANY($3::text[])
          AND status IN ('active', 'unreachable', 'connector_offline')`,
      [identity.workspaceId, identity.workstationId, ids, observedAt],
    );
  });
}

export async function setConnectorPreviewRoutesStatus(
  pool: Pool,
  identity: ConnectorIdentity,
  routeIds: string[],
  status: "connector_offline" | "stopped",
  now = new Date(),
): Promise<WorkstationPreviewSummary[]> {
  const ids = validateRouteIds(routeIds);
  if (ids.length === 0) return [];
  const transitionedAt = validDate(now, "Invalid preview transition time");
  return withServiceTransaction(pool, identity.workspaceId, async (client) => {
    const selected = await client.query<PreviewRow>(
      `${previewSelect()}
        WHERE p.workspace_id = $1 AND p.workstation_id = $2
          AND p.route_id = ANY($3::text[])
        FOR UPDATE OF p`,
      [identity.workspaceId, identity.workstationId, ids],
    );
    const eligible = selected.rows.filter((row) => canTransitionConnectorStatus(row.status, status));
    if (eligible.length > 0) {
      await client.query(
        `UPDATE workstation_previews
            SET status = $4,
                stopped_at = CASE WHEN $4 = 'stopped' THEN $5::timestamptz ELSE NULL END,
                updated_at = $5
          WHERE workspace_id = $1 AND workstation_id = $2
            AND id = ANY($3::uuid[])`,
        [identity.workspaceId, identity.workstationId, eligible.map((row) => row.id), status, transitionedAt],
      );
      for (const row of eligible) {
        await insertAudit(
          client,
          identity.workspaceId,
          null,
          "connector",
          status === "stopped" ? "workstation.preview_stopped" : "workstation.preview_connector_offline",
          row.id,
          row.status,
          status,
        );
      }
    }
    return loadPreviewsByIds(
      client,
      identity.workspaceId,
      selected.rows.map((row) => row.id),
    );
  });
}

export async function markConnectorPreviewsOffline(
  pool: Pool,
  identity: ConnectorIdentity,
  routeIds: string[],
  now = new Date(),
): Promise<WorkstationPreviewSummary[]> {
  return setConnectorPreviewRoutesStatus(pool, identity, routeIds, "connector_offline", now);
}

export async function stopConnectorPreviewRoutes(
  pool: Pool,
  identity: ConnectorIdentity,
  routeIds: string[],
  now = new Date(),
): Promise<WorkstationPreviewSummary[]> {
  return setConnectorPreviewRoutesStatus(pool, identity, routeIds, "stopped", now);
}

export async function expireConnectorPreviews(
  pool: Pool,
  identity: ConnectorIdentity,
  now = new Date(),
): Promise<WorkstationPreviewSummary[]> {
  const expiredAt = validDate(now, "Invalid preview expiration time");
  return withServiceTransaction(pool, identity.workspaceId, async (client) => {
    const ids = await expirePreviews(client, identity, expiredAt);
    return loadPreviewsByIds(client, identity.workspaceId, ids);
  });
}

export async function listWorkstationPreviews(
  pool: Pool,
  userId: string,
  workspaceId: string | null = null,
  now = new Date(),
): Promise<WorkstationPreviewSummary[]> {
  const observedAt = validDate(now, "Invalid preview listing time");
  return withUserTransaction(pool, userId, workspaceId, async (client) => {
    await expireVisiblePreviews(client, observedAt);
    const recentSince = new Date(observedAt.getTime() - recentPreviewWindowMs);
    const result = await client.query<PreviewRow>(
      `${previewSelect()}
        WHERE ($1 = '' OR p.workspace_id = $1::uuid)
          AND app_can_preview_workstation(p.workspace_id, p.workstation_id)
          AND (
            p.status IN ('active', 'unreachable', 'connector_offline')
            OR p.updated_at >= $2
          )
        ORDER BY
          CASE p.status
            WHEN 'active' THEN 0
            WHEN 'unreachable' THEN 1
            WHEN 'connector_offline' THEN 2
            WHEN 'stopped' THEN 3
            ELSE 4
          END,
          p.updated_at DESC,
          p.id`,
      [workspaceId ?? "", recentSince],
    );
    return result.rows.map(mapPreview);
  });
}

export async function authorizeWorkstationPreview(
  pool: Pool,
  userId: string,
  previewId: string,
  now = new Date(),
): Promise<WorkstationPreviewSummary> {
  requirePreviewId(previewId);
  const authorizedAt = validDate(now, "Invalid preview authorization time");
  return withUserTransaction(pool, userId, null, async (client) => {
    await expireVisiblePreviews(client, authorizedAt, previewId);
    const result = await client.query<PreviewRow>(
      `${previewSelect()}
        WHERE p.id = $1
          AND app_can_preview_workstation(p.workspace_id, p.workstation_id)
        FOR UPDATE OF p`,
      [previewId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new HttpError(404, "preview_not_found", "Preview is not available");
    }
    if (row.status !== "active" || row.expires_at.getTime() <= authorizedAt.getTime()) {
      throw new HttpError(
        row.status === "expired" || row.status === "stopped" ? 410 : 409,
        "preview_unavailable",
        "Preview is not currently available",
        { preview: mapPreview(row) },
      );
    }
    return mapPreview(row);
  });
}

export async function stopWorkstationPreview(
  pool: Pool,
  userId: string,
  previewId: string,
  now = new Date(),
): Promise<WorkstationPreviewSummary> {
  requirePreviewId(previewId);
  const stoppedAt = validDate(now, "Invalid preview stop time");
  return withUserTransaction(pool, userId, null, async (client) => {
    const selected = await client.query<PreviewRow>(
      `${previewSelect()}
        WHERE p.id = $1
          AND app_can_preview_workstation(p.workspace_id, p.workstation_id)
        FOR UPDATE OF p`,
      [previewId],
    );
    const row = selected.rows[0];
    if (row === undefined) {
      throw new HttpError(404, "preview_not_found", "Preview is not available");
    }
    if (row.status === "stopped") return mapPreview(row);

    await client.query(
      `UPDATE workstation_previews
          SET status = 'stopped', stopped_at = $3, updated_at = $3
        WHERE workspace_id = $1 AND id = $2 AND status <> 'stopped'`,
      [row.workspace_id, row.id, stoppedAt],
    );
    await insertAudit(
      client,
      row.workspace_id,
      userId,
      "user",
      "workstation.preview_stopped",
      row.id,
      row.status,
      "stopped",
    );
    return loadPreviewById(client, row.id);
  });
}

export async function getConnectorPreviewRoute(
  pool: Pool,
  identity: ConnectorIdentity,
  routeId: string,
  now = new Date(),
): Promise<WorkstationPreviewSummary | null> {
  validateRouteId(routeId);
  const observedAt = validDate(now, "Invalid preview lookup time");
  return withServiceTransaction(pool, identity.workspaceId, async (client) => {
    await expirePreviews(client, identity, observedAt, [routeId]);
    const result = await client.query<PreviewRow>(
      `${previewSelect()}
        WHERE p.workspace_id = $1 AND p.workstation_id = $2 AND p.route_id = $3`,
      [identity.workspaceId, identity.workstationId, routeId],
    );
    return result.rows[0] === undefined ? null : mapPreview(result.rows[0]);
  });
}

async function lockActiveWorkstation(client: PoolClient, identity: ConnectorIdentity): Promise<void> {
  const result = await client.query(
    `SELECT id FROM workstations
      WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL
      FOR UPDATE`,
    [identity.workspaceId, identity.workstationId],
  );
  if (result.rowCount !== 1) {
    throw new HttpError(404, "workstation_not_found", "Workstation is not available");
  }
}

async function enforceRouteLimit(
  client: PoolClient,
  identity: ConnectorIdentity,
  incomingRouteIds: string[],
): Promise<void> {
  const result = await client.query<{ count: string }>(
    `SELECT count(DISTINCT route_id)::text AS count
       FROM workstation_previews
      WHERE workspace_id = $1 AND workstation_id = $2
        AND (
          status IN ('active', 'unreachable', 'connector_offline')
          OR route_id = ANY($3::text[])
        )`,
    [identity.workspaceId, identity.workstationId, incomingRouteIds],
  );
  if (Number(result.rows[0]?.count ?? 0) > previewLimits.maxRoutesPerWorkstation) {
    throw new HttpError(
      409,
      "too_many_preview_routes",
      `A workstation can expose at most ${previewLimits.maxRoutesPerWorkstation} previews`,
    );
  }
}

async function expirePreviews(
  client: PoolClient,
  identity: ConnectorIdentity,
  now: Date,
  routeIds?: string[],
): Promise<string[]> {
  const selected = await client.query<PreviewRow>(
    `${previewSelect()}
      WHERE p.workspace_id = $1 AND p.workstation_id = $2
        AND p.status IN ('active', 'unreachable', 'connector_offline')
        AND p.expires_at <= $3
        AND ($4::text[] IS NULL OR p.route_id = ANY($4::text[]))
      FOR UPDATE OF p`,
    [identity.workspaceId, identity.workstationId, now, routeIds ?? null],
  );
  if (selected.rows.length === 0) return [];
  const ids = selected.rows.map((row) => row.id);
  await client.query(
    `UPDATE workstation_previews
        SET status = 'expired', stopped_at = NULL, updated_at = $3
      WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
    [identity.workspaceId, ids, now],
  );
  for (const row of selected.rows) {
    await insertAudit(
      client,
      identity.workspaceId,
      null,
      "system",
      "workstation.preview_expired",
      row.id,
      row.status,
      "expired",
    );
  }
  return ids;
}

async function expireVisiblePreviews(
  client: PoolClient,
  now: Date,
  previewId?: string,
): Promise<void> {
  const selected = await client.query<PreviewRow>(
    `${previewSelect()}
      WHERE p.status IN ('active', 'unreachable', 'connector_offline')
        AND p.expires_at <= $1
        AND ($2::uuid IS NULL OR p.id = $2)
        AND app_can_preview_workstation(p.workspace_id, p.workstation_id)
      FOR UPDATE OF p`,
    [now, previewId ?? null],
  );
  for (const row of selected.rows) {
    await client.query(
      `UPDATE workstation_previews
          SET status = 'expired', stopped_at = NULL, updated_at = $3
        WHERE workspace_id = $1 AND id = $2`,
      [row.workspace_id, row.id, now],
    );
    await insertAudit(
      client,
      row.workspace_id,
      null,
      "system",
      "workstation.preview_expired",
      row.id,
      row.status,
      "expired",
    );
  }
}

async function loadPreviewsByIds(
  client: PoolClient,
  workspaceId: string,
  ids: string[],
): Promise<WorkstationPreviewSummary[]> {
  if (ids.length === 0) return [];
  const result = await client.query<PreviewRow>(
    `${previewSelect()}
      WHERE p.workspace_id = $1 AND p.id = ANY($2::uuid[])
      ORDER BY p.updated_at DESC, p.id`,
    [workspaceId, ids],
  );
  return result.rows.map(mapPreview);
}

async function loadPreviewById(client: PoolClient, previewId: string): Promise<WorkstationPreviewSummary> {
  const result = await client.query<PreviewRow>(`${previewSelect()} WHERE p.id = $1`, [previewId]);
  const row = result.rows[0];
  if (row === undefined) throw new Error("Updated preview could not be loaded");
  return mapPreview(row);
}

function previewSelect(): string {
  return `SELECT p.id, p.workspace_id, p.workstation_id, w.name AS workstation_name,
                 p.route_id, p.name, p.local_port, p.status, p.started_at,
                 p.last_seen_at, p.stopped_at, p.expires_at, p.updated_at
            FROM workstation_previews p
            JOIN workstations w
              ON w.workspace_id = p.workspace_id AND w.id = p.workstation_id`;
}

async function insertAudit(
  client: PoolClient,
  workspaceId: string,
  actorUserId: string | null,
  actorKind: "user" | "connector" | "system",
  action: string,
  previewId: string,
  previousState: string | null,
  nextState: string,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id,
        previous_state, next_state, metadata)
     VALUES ($1, $2, $3, $4, 'workstation_preview', $5, $6, $7, '{}'::jsonb)`,
    [workspaceId, actorUserId, actorKind, action, previewId, previousState, nextState],
  );
}

function validateRoutes(
  routes: ConnectorPreviewRoute[],
  now: Date,
  maxDurationMs: number,
): ValidatedConnectorPreviewRoute[] {
  if (!Array.isArray(routes) || routes.length > previewLimits.maxRoutesPerWorkstation) {
    throw new HttpError(400, "invalid_preview_routes", "Preview route snapshot is too large");
  }
  const routeIds = new Set<string>();
  const ports = new Set<number>();
  return routes.map((route) => {
    if (typeof route !== "object" || route === null || Array.isArray(route)) {
      throw new HttpError(400, "invalid_preview_route", "Preview route is invalid");
    }
    validateRouteId(route.routeId);
    if (routeIds.has(route.routeId)) {
      throw new HttpError(400, "duplicate_preview_route", "Preview route IDs must be unique");
    }
    routeIds.add(route.routeId);
    const name = normalizePreviewName(route.name);
    if (name.length === 0 || name !== route.name) {
      throw new HttpError(400, "invalid_preview_name", "Preview name is not normalized");
    }
    if (
      !Number.isInteger(route.port) ||
      route.port < previewLimits.minLocalPort ||
      route.port > previewLimits.maxLocalPort
    ) {
      throw new HttpError(400, "invalid_preview_port", "Preview port is outside the allowed range");
    }
    if (ports.has(route.port)) {
      throw new HttpError(400, "duplicate_preview_port", "A preview snapshot cannot expose one port twice");
    }
    ports.add(route.port);
    if (route.status !== "active" && route.status !== "unreachable") {
      throw new HttpError(400, "invalid_preview_status", "Connector preview status is invalid");
    }
    const expiresAt = new Date(route.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new HttpError(400, "invalid_preview_expiration", "Preview expiration is invalid");
    }
    const durationMs = expiresAt.getTime() - now.getTime();
    if (durationMs <= 0 || durationMs > maxDurationMs + routeClockToleranceMs) {
      throw new HttpError(
        400,
        "invalid_preview_expiration",
        "Preview expiration is outside the allowed duration",
      );
    }
    return { ...route, name, expiresAt };
  });
}

function validateRouteIds(routeIds: string[]): string[] {
  if (!Array.isArray(routeIds) || routeIds.length > previewLimits.maxRoutesPerWorkstation) {
    throw new HttpError(400, "invalid_preview_routes", "Preview route list is too large");
  }
  const unique = new Set<string>();
  for (const routeId of routeIds) {
    validateRouteId(routeId);
    unique.add(routeId);
  }
  return [...unique];
}

function validateRouteId(routeId: string): void {
  if (
    typeof routeId !== "string" ||
    routeId.length < 1 ||
    routeId.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(routeId)
  ) {
    throw new HttpError(400, "invalid_preview_route", "Preview route ID is invalid");
  }
}

function normalizePreviewName(value: string): string {
  if (typeof value !== "string") return "";
  const withoutBidi = value.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/giu, "");
  const withoutControls = withoutBidi.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  const normalized = withoutControls.replace(/\s+/gu, " ").trim();
  return Array.from(normalized).length <= previewLimits.maxNameCharacters ? normalized : "";
}

function readMaxDuration(value: number | undefined): number {
  const duration = value ?? previewLimits.maxRouteDurationMs;
  if (
    !Number.isSafeInteger(duration) ||
    duration < previewLimits.minRouteDurationMs ||
    duration > previewLimits.maxRouteDurationMs
  ) {
    throw new HttpError(500, "invalid_preview_configuration", "Preview duration configuration is invalid");
  }
  return duration;
}

function canTransitionConnectorStatus(
  previous: WorkstationPreviewStatus,
  next: "connector_offline" | "stopped",
): boolean {
  if (previous === next) return false;
  if (next === "connector_offline") return previous === "active" || previous === "unreachable";
  return previous === "active" || previous === "unreachable" || previous === "connector_offline";
}

function mapPreview(row: PreviewRow): WorkstationPreviewSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workstationId: row.workstation_id,
    workstationName: row.workstation_name,
    routeId: row.route_id,
    name: row.name,
    port: Number(row.local_port),
    status: row.status,
    startedAt: row.started_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    stoppedAt: row.stopped_at?.toISOString() ?? null,
    expiresAt: row.expires_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function requireId(row: { id: string } | undefined): string {
  if (row === undefined) throw new Error("Preview insert did not return an ID");
  return row.id;
}

function requirePreviewId(value: string): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value)) {
    throw new HttpError(404, "preview_not_found", "Preview is not available");
  }
}

function validDate(value: Date, message: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new HttpError(400, "invalid_preview_time", message);
  }
  return value;
}
