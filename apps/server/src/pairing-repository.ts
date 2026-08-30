import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  ConnectorPairingClaimResult,
  WorkstationPairingCreateResult,
  WorkstationPairingStatus,
  WorkstationPairingSummary,
} from "@yurupager/shared";

import { withUserTransaction } from "./database.js";
import { HttpError } from "./errors.js";

interface PairingRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  workspace_name: string;
  status: WorkstationPairingStatus;
  device_name: string | null;
  platform: string | null;
  connector_version: string | null;
  public_key: string | null;
  claim_secret_hash?: string | null;
  workstation_id: string | null;
  created_by_name: string;
  approved_by_name: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface PairingClaimInput {
  pairCode: string;
  claimSecret: string;
  deviceName: string;
  platform: string;
  connectorVersion: string;
  publicKey: string;
}

export async function createPairing(
  pool: Pool,
  userId: string,
  workspaceId: string,
  idempotencyKey: string,
  secret: string,
): Promise<WorkstationPairingCreateResult> {
  validateIdempotencyKey(idempotencyKey);
  const pairCode = derivePairCode(secret, userId, idempotencyKey);
  const codeHash = hashSecret(normalizePairCode(pairCode), secret, "pair-code");
  return withUserTransaction(pool, userId, workspaceId, async (client) => {
    const permission = await client.query<{ allowed: boolean }>(
      "SELECT app_can_manage_workstations($1) AS allowed",
      [workspaceId],
    );
    if (permission.rows[0]?.allowed !== true) {
      throw new HttpError(403, "permission_denied", "You cannot add workstations to this workspace");
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO workstation_pairings
         (workspace_id, created_by_user_id, create_idempotency_key, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '10 minutes')
       ON CONFLICT (created_by_user_id, create_idempotency_key) DO NOTHING
       RETURNING id`,
      [workspaceId, userId, idempotencyKey, codeHash],
    );
    const replayed = inserted.rowCount === 0;
    const result = await client.query<PairingRow>(
      `${pairingSelect()}
        WHERE p.created_by_user_id = $1 AND p.create_idempotency_key = $2`,
      [userId, idempotencyKey],
    );
    const row = requireRow(result.rows[0]);
    if (row.workspace_id !== workspaceId) {
      throw new HttpError(409, "idempotency_conflict", "This Idempotency-Key was used for another workspace");
    }
    if (!replayed) {
      await client.query(
        `INSERT INTO audit_events
           (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, next_state, metadata)
         VALUES ($1, $2, 'user', 'workstation.pairing_created', 'workstation_pairing', $3,
                 'waiting_for_device', jsonb_build_object('expiresAt', $4::timestamptz))`,
        [workspaceId, userId, row.id, row.expires_at],
      );
    }
    return { pairing: mapPairing(row), pairCode, replayed };
  });
}

export async function listPairings(
  pool: Pool,
  userId: string,
  workspaceId: string | null,
): Promise<WorkstationPairingSummary[]> {
  return withUserTransaction(pool, userId, workspaceId, async (client) => {
    await expirePairings(client, workspaceId);
    const result = await client.query<PairingRow>(
      `${pairingSelect()}
        WHERE ($1 = '' OR p.workspace_id = $1::uuid)
        ORDER BY p.created_at DESC
        LIMIT 50`,
      [workspaceId ?? ""],
    );
    return result.rows.map(mapPairing);
  });
}

export async function approvePairing(
  pool: Pool,
  userId: string,
  pairingId: string,
  workstationName: string | undefined,
): Promise<WorkstationPairingSummary> {
  return withUserTransaction(pool, userId, null, async (client) => {
    const selected = await client.query<PairingRow>(
      `${pairingSelect()}
        WHERE p.id = $1
        FOR UPDATE OF p`,
      [pairingId],
    );
    const row = selected.rows[0];
    if (row === undefined) throw new HttpError(404, "pairing_not_found", "Pairing was not found");
    if (row.expires_at.getTime() <= Date.now() && row.status !== "approved") {
      await markExpired(client, row);
      throw pairingConflict("pairing_expired", "Pairing has expired", { ...row, status: "expired" });
    }
    if (row.status !== "pending_approval" || row.public_key === null) {
      throw pairingConflict("pairing_not_pending", "Pairing is no longer waiting for approval", row);
    }
    const name = validateDeviceName(workstationName ?? row.device_name ?? "Codex workstation");
    const workstationId = randomUUID();
    await client.query(
      `INSERT INTO workstations
         (workspace_id, id, name, platform, connector_version, public_key, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'offline')`,
      [row.workspace_id, workstationId, name, row.platform, row.connector_version, row.public_key],
    );
    await client.query(
      `INSERT INTO workstation_access
         (workspace_id, workstation_id, user_id, can_view, can_respond,
          can_approve_high_risk, can_manage)
       VALUES ($1, $2, $3, true, true, true, true)
       ON CONFLICT (workspace_id, workstation_id, user_id) DO NOTHING`,
      [row.workspace_id, workstationId, userId],
    );
    await client.query(
      `UPDATE workstation_pairings
          SET status = 'approved', workstation_id = $2, approved_by_user_id = $3,
              approved_at = now(), expires_at = GREATEST(expires_at, now() + interval '10 minutes'),
              updated_at = now()
        WHERE workspace_id = $1 AND id = $4`,
      [row.workspace_id, workstationId, userId, pairingId],
    );
    await client.query(
      `INSERT INTO audit_events
         (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id,
          previous_state, next_state, metadata)
       VALUES ($1, $2, 'user', 'workstation.pairing_approved', 'workstation_pairing', $3,
               'pending_approval', 'approved', jsonb_build_object('workstationId', $4::text, 'fingerprint', $5::text))`,
      [row.workspace_id, userId, pairingId, workstationId, fingerprint(row.public_key)],
    );
    return loadPairingById(client, pairingId);
  });
}

export async function cancelPairing(
  pool: Pool,
  userId: string,
  pairingId: string,
): Promise<WorkstationPairingSummary> {
  return withUserTransaction(pool, userId, null, async (client) => {
    const selected = await client.query<PairingRow>(
      `${pairingSelect()} WHERE p.id = $1 FOR UPDATE OF p`,
      [pairingId],
    );
    const row = selected.rows[0];
    if (row === undefined) throw new HttpError(404, "pairing_not_found", "Pairing was not found");
    if (row.status !== "waiting_for_device" && row.status !== "pending_approval") {
      throw pairingConflict("pairing_not_cancellable", "Pairing is already final", row);
    }
    await client.query(
      `UPDATE workstation_pairings
          SET status = 'cancelled', cancelled_by_user_id = $2, cancelled_at = now(), updated_at = now()
        WHERE workspace_id = $1 AND id = $3`,
      [row.workspace_id, userId, pairingId],
    );
    await client.query(
      `INSERT INTO audit_events
         (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id,
          previous_state, next_state, metadata)
       VALUES ($1, $2, 'user', 'workstation.pairing_cancelled', 'workstation_pairing', $3,
               $4, 'cancelled', '{}'::jsonb)`,
      [row.workspace_id, userId, pairingId, row.status],
    );
    return loadPairingById(client, pairingId);
  });
}

export async function claimPairing(
  pool: Pool,
  input: PairingClaimInput,
  secret: string,
): Promise<ConnectorPairingClaimResult> {
  validateClaimInput(input);
  const codeHash = hashSecret(normalizePairCode(input.pairCode), secret, "pair-code");
  const claimHash = hashSecret(input.claimSecret, secret, "claim-secret");
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const selected = await client.query<PairingRow>(
      `${pairingSelect()} WHERE p.code_hash = $1 FOR UPDATE OF p`,
      [codeHash],
    );
    const row = selected.rows[0];
    if (row === undefined) throw new HttpError(404, "pair_code_invalid", "Pairing code is invalid or expired");
    if (row.expires_at.getTime() <= Date.now() && row.status !== "approved") {
      await markExpired(client, row);
      await client.query("COMMIT");
      committed = true;
      throw new HttpError(410, "pair_code_expired", "Pairing code has expired");
    }
    if (row.status === "waiting_for_device") {
      await client.query(
        `UPDATE workstation_pairings
            SET status = 'pending_approval', device_name = $2, platform = $3,
                connector_version = $4, public_key = $5, claim_secret_hash = $6,
                updated_at = now()
          WHERE workspace_id = $1 AND id = $7`,
        [row.workspace_id, input.deviceName, input.platform, input.connectorVersion, input.publicKey, claimHash, row.id],
      );
      await client.query(
        `INSERT INTO audit_events
           (workspace_id, actor_kind, action, entity_type, entity_id, previous_state, next_state, metadata)
         VALUES ($1, 'connector', 'workstation.pairing_claimed', 'workstation_pairing', $2,
                 'waiting_for_device', 'pending_approval', jsonb_build_object('fingerprint', $3::text))`,
        [row.workspace_id, row.id, fingerprint(input.publicKey)],
      );
      row.status = "pending_approval";
      row.claim_secret_hash = claimHash;
    } else if (!safeEqual(row.claim_secret_hash, claimHash) || row.public_key !== input.publicKey) {
      throw new HttpError(409, "pair_code_claimed", "Pairing code has already been claimed by another device");
    }
    await client.query("COMMIT");
    committed = true;
    return {
      pairingId: row.id,
      status: row.status,
      expiresAt: row.expires_at.toISOString(),
      workspaceId: row.workspace_id,
    };
  } catch (error) {
    if (!committed) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getConnectorPairingResult(
  pool: Pool,
  pairCode: string,
  claimSecret: string,
  secret: string,
): Promise<ConnectorPairingClaimResult> {
  const codeHash = hashSecret(normalizePairCode(pairCode), secret, "pair-code");
  const claimHash = hashSecret(claimSecret, secret, "claim-secret");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<PairingRow>(
      `${pairingSelect()} WHERE p.code_hash = $1 FOR UPDATE OF p`,
      [codeHash],
    );
    const row = selected.rows[0];
    if (row === undefined || !safeEqual(row.claim_secret_hash, claimHash)) {
      throw new HttpError(404, "pairing_not_found", "Pairing is unavailable");
    }
    if (row.status === "approved" && row.expires_at.getTime() <= Date.now()) {
      throw new HttpError(410, "credential_window_expired", "Connector credential delivery window has expired");
    }
    if (row.expires_at.getTime() <= Date.now() && row.status !== "approved") {
      await markExpired(client, row);
      row.status = "expired";
    }
    const result: ConnectorPairingClaimResult = {
      pairingId: row.id,
      status: row.status,
      expiresAt: row.expires_at.toISOString(),
    };
    if (row.status === "approved" && row.workstation_id !== null) {
      const connectorToken = deriveConnectorToken(secret, row.id, claimSecret);
      const credentialHash = createHash("sha256").update(connectorToken).digest("hex");
      await client.query(
        `UPDATE workstations SET credential_hash = COALESCE(credential_hash, $3)
          WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL`,
        [row.workspace_id, row.workstation_id, credentialHash],
      );
      await client.query(
        `UPDATE workstation_pairings SET credential_issued_at = COALESCE(credential_issued_at, now()), updated_at = now()
          WHERE workspace_id = $1 AND id = $2`,
        [row.workspace_id, row.id],
      );
      result.workspaceId = row.workspace_id;
      result.workstationId = row.workstation_id;
      result.connectorToken = connectorToken;
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function expirePairings(client: PoolClient, workspaceId: string | null): Promise<void> {
  const expired = await client.query<{ workspace_id: string; id: string; status: string }>(
    `UPDATE workstation_pairings
        SET status = 'expired', updated_at = now()
      WHERE status IN ('waiting_for_device', 'pending_approval') AND expires_at <= now()
        AND ($1 = '' OR workspace_id = $1::uuid)
      RETURNING workspace_id, id, status`,
    [workspaceId ?? ""],
  );
  for (const row of expired.rows) {
    await client.query(
      `INSERT INTO audit_events
         (workspace_id, actor_kind, action, entity_type, entity_id, previous_state, next_state, metadata)
       VALUES ($1, 'system', 'workstation.pairing_expired', 'workstation_pairing', $2,
               NULL, 'expired', '{}'::jsonb)`,
      [row.workspace_id, row.id],
    );
  }
}

async function markExpired(client: PoolClient, row: PairingRow): Promise<void> {
  if (row.status === "expired") return;
  await client.query(
    `UPDATE workstation_pairings SET status = 'expired', updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND status = $3`,
    [row.workspace_id, row.id, row.status],
  );
  await client.query(
    `INSERT INTO audit_events
       (workspace_id, actor_kind, action, entity_type, entity_id, previous_state, next_state, metadata)
     VALUES ($1, 'system', 'workstation.pairing_expired', 'workstation_pairing', $2,
             $3, 'expired', '{}'::jsonb)`,
    [row.workspace_id, row.id, row.status],
  );
}

async function loadPairingById(client: PoolClient, pairingId: string): Promise<WorkstationPairingSummary> {
  const result = await client.query<PairingRow>(`${pairingSelect()} WHERE p.id = $1`, [pairingId]);
  return mapPairing(requireRow(result.rows[0]));
}

function pairingSelect(): string {
  return `SELECT p.id, p.workspace_id, w.name AS workspace_name, p.status, p.device_name,
                 p.platform, p.connector_version, p.public_key, p.claim_secret_hash,
                 p.workstation_id, creator.display_name AS created_by_name,
                 approver.display_name AS approved_by_name, p.expires_at, p.created_at, p.updated_at
            FROM workstation_pairings p
            JOIN workspaces w ON w.id = p.workspace_id
            JOIN app_users creator ON creator.id = p.created_by_user_id
            LEFT JOIN app_users approver ON approver.id = p.approved_by_user_id`;
}

function mapPairing(row: PairingRow): WorkstationPairingSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    status: row.status,
    deviceName: row.device_name,
    platform: row.platform,
    connectorVersion: row.connector_version,
    fingerprint: row.public_key === null ? null : fingerprint(row.public_key),
    workstationId: row.workstation_id,
    createdByName: row.created_by_name,
    approvedByName: row.approved_by_name,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function pairingConflict(code: string, message: string, row: PairingRow): HttpError {
  return new HttpError(409, code, message, { pairing: mapPairing(row) });
}

function validateClaimInput(input: PairingClaimInput): void {
  normalizePairCode(input.pairCode);
  if (input.claimSecret.length < 32 || input.claimSecret.length > 200) {
    throw new HttpError(400, "invalid_claim", "Claim secret is invalid");
  }
  validateDeviceName(input.deviceName);
  if (input.platform.length < 1 || input.platform.length > 240) {
    throw new HttpError(400, "invalid_platform", "Platform must be 1 to 240 characters");
  }
  if (input.connectorVersion.length < 1 || input.connectorVersion.length > 80) {
    throw new HttpError(400, "invalid_connector_version", "Connector version is invalid");
  }
  if (input.publicKey.length < 64 || input.publicKey.length > 4_000) {
    throw new HttpError(400, "invalid_public_key", "Device public key is invalid");
  }
}

function validateDeviceName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || Array.from(name).length > 240) {
    throw new HttpError(400, "invalid_device_name", "Device name must be 1 to 240 characters");
  }
  return name;
}

function validateIdempotencyKey(value: string): void {
  if (value.length < 8 || value.length > 200) {
    throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be 8 to 200 characters");
  }
}

function normalizePairCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.length !== 12) throw new HttpError(400, "invalid_pair_code", "Pairing code is invalid");
  return normalized;
}

function derivePairCode(secret: string, userId: string, idempotencyKey: string): string {
  const bytes = createHmac("sha256", secret)
    .update("pair-code\0").update(userId).update("\0").update(idempotencyKey).digest();
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = BigInt(`0x${bytes.subarray(0, 8).toString("hex")}`);
  let raw = "";
  for (let index = 0; index < 12; index += 1) {
    raw = alphabet[Number(value & 31n)] + raw;
    value >>= 5n;
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

function deriveConnectorToken(secret: string, pairingId: string, claimSecret: string): string {
  return `ypd_${createHmac("sha256", secret)
    .update("device-credential\0").update(pairingId).update("\0").update(claimSecret)
    .digest("base64url")}`;
}

function hashSecret(value: string, secret: string, purpose: string): string {
  return createHash("sha256").update(purpose).update("\0").update(value).update("\0").update(secret).digest("hex");
}

function fingerprint(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 24).toUpperCase().match(/.{1,4}/g)?.join("-") ?? "";
}

function safeEqual(left: string | null | undefined, right: string): boolean {
  if (left === null || left === undefined) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireRow(row: PairingRow | undefined): PairingRow {
  if (row === undefined) throw new Error("Pairing row is missing");
  return row;
}
