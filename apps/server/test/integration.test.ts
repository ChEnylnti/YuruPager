import { createHash, randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import ClientWebSocket, { WebSocketServer, type WebSocket } from "ws";

import type { ConnectorPayload, TransportEnvelope } from "@yurupager/shared";
import { PreviewTunnelClient } from "../../../src/preview/client.js";

import { buildApp } from "../src/app.js";
import { issueAttachmentTicket } from "../src/attachment-ticket.js";
import { loadConfig } from "../src/config.js";
import {
  findConnectorIdentity,
  getPendingConnectorCommand,
  getPendingConnectorDecisions,
  processConnectorEnvelope,
} from "../src/connector-repository.js";
import {
  closeDatabase,
  createDatabase,
  migrateAndSeed,
  withUserTransaction,
} from "../src/database.js";
import {
  markConnectorPreviewsOffline,
  stopConnectorPreviewRoutes,
  syncConnectorPreviewRoutes,
} from "../src/preview-repository.js";
import type { PushTransport } from "../src/push-service.js";
import { SessionRelay } from "../src/session-relay.js";

const testVapidPublicKey = "B".repeat(87);
const testVapidPrivateKey = "C".repeat(43);
const pushCalls: Array<{
  endpoint: string;
  payload: string;
  options: Parameters<PushTransport["sendNotification"]>[2];
}> = [];
let pushFailureStatus: number | null = null;
const pushTransport: PushTransport = {
  async sendNotification(subscription, payload, options) {
    pushCalls.push({ endpoint: subscription.endpoint, payload, options });
    if (pushFailureStatus !== null) throw { statusCode: pushFailureStatus };
    return { statusCode: 201, headers: {}, body: "" };
  },
};
const config = loadConfig({
  ...process.env,
  PORT: "4399",
  AUTH_MODE: "local",
  WEB_PUSH_ENABLED: "true",
  WEB_PUSH_VAPID_SUBJECT: "mailto:push-test@yurupager.local",
  WEB_PUSH_VAPID_PUBLIC_KEY: testVapidPublicKey,
  WEB_PUSH_VAPID_PRIVATE_KEY: testVapidPrivateKey,
});
const database = createDatabase(config);
const requestId = "50000000-0000-4000-8000-000000000001";
const highRiskRequestId = "50000000-0000-4000-8000-000000000002";
const questionRequestId = "50000000-0000-4000-8000-000000000003";
const sessionId = "40000000-0000-4000-8000-000000000001";
const identity = {
  workspaceId: "20000000-0000-4000-8000-000000000002",
  workstationId: "30000000-0000-4000-8000-000000000001",
};
let app: Awaited<ReturnType<typeof buildApp>>;
let aliceCookie = "";
let bobCookie = "";

beforeAll(async () => {
  await migrateAndSeed(database);
  app = await buildApp({ config, database, logger: false, pushTransport });
  aliceCookie = await login("alice@yurupager.local");
  bobCookie = await login("bob@yurupager.local");
});

async function resetTestRequests(): Promise<void> {
  await database.admin.query("DELETE FROM push_subscriptions");
  pushCalls.length = 0;
  pushFailureStatus = null;
  await database.admin.query("DELETE FROM workstation_previews");
  await database.admin.query("DELETE FROM workstation_pairings");
  await database.admin.query(
    "DELETE FROM workstations WHERE connector_version = '0.2.0-alpha'",
  );
  await database.admin.query(
    "DELETE FROM session_commands WHERE workspace_id = $1 AND session_id = $2",
    [identity.workspaceId, sessionId],
  );
  await database.admin.query(
    "UPDATE agent_sessions SET latest_turn_id = 'turn-alpha-7', status = 'waiting' WHERE workspace_id = $1 AND id = $2",
    [identity.workspaceId, sessionId],
  );
  await database.admin.query(
    "DELETE FROM connector_outbox WHERE workspace_id = $1 AND request_id IN ($2, $3, $4)",
    [identity.workspaceId, requestId, questionRequestId, highRiskRequestId],
  );
  await database.admin.query(
    "DELETE FROM request_decisions WHERE workspace_id = $1 AND request_id IN ($2, $3, $4)",
    [identity.workspaceId, requestId, questionRequestId, highRiskRequestId],
  );
  await database.admin.query(
    `UPDATE agent_requests SET status = 'pending', delivery_status = 'not_queued',
            decided_by_user_id = NULL, decision_reason = NULL, decision_payload = NULL,
            decided_at = NULL, expires_at = now() + interval '1 hour'
      WHERE workspace_id = $1 AND id IN ($2, $3, $4)`,
    [identity.workspaceId, requestId, questionRequestId, highRiskRequestId],
  );
  await database.admin.query(
    `UPDATE agent_requests
        SET context = '{"questions":[{"id":"environment","header":"Deploy target","question":"Which environment should receive the Alpha build?","isSecret":false,"options":[{"label":"Staging","description":"Deploy for internal verification only"}]}]}'::jsonb
      WHERE workspace_id = $1 AND id = $2`,
    [identity.workspaceId, questionRequestId],
  );
}

beforeEach(async () => {
  await resetTestRequests();
});

afterAll(async () => {
  await resetTestRequests();
  await app.close();
  await closeDatabase(database);
});

describe("tenant isolation", () => {
  it("serves the production application shell as HTML", async () => {
    const productionApp = await buildApp({ config, database, logger: false, serveWeb: true });
    try {
      const response = await productionApp.inject({ method: "GET", url: "/" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain('<div id="root"></div>');
    } finally {
      await productionApp.close();
    }
  });

  it("limits a member to authorized workspaces and workstations under RLS", async () => {
    const visible = await withUserTransaction(
      database.app,
      "10000000-0000-4000-8000-000000000002",
      null,
      async (client) => {
        const workspaces = await client.query("SELECT id FROM workspaces");
        const workstations = await client.query("SELECT id FROM workstations");
        return { workspaceCount: workspaces.rowCount, workstationCount: workstations.rowCount };
      },
    );
    expect(visible).toEqual({ workspaceCount: 1, workstationCount: 1 });
  });

  it("keeps revoked workstation records out of user snapshots", async () => {
    const workstationId = randomUUID();
    await database.admin.query(
      `INSERT INTO workstations
         (workspace_id, id, name, platform, connector_version, status, revoked_at)
       VALUES ($1, $2, 'Merged workstation tombstone', 'macOS / arm64', '0.2.0-alpha', 'offline', now())`,
      [identity.workspaceId, workstationId],
    );
    await database.admin.query(
      `INSERT INTO workstation_access
         (workspace_id, workstation_id, user_id, can_view)
       VALUES ($1, $2, '10000000-0000-4000-8000-000000000001', true)`,
      [identity.workspaceId, workstationId],
    );
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/snapshot",
        headers: { cookie: aliceCookie },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ workstations: Array<{ id: string }> }>().workstations)
        .not.toContainEqual(expect.objectContaining({ id: workstationId }));
      const retained = await database.admin.query(
        "SELECT 1 FROM workstations WHERE workspace_id = $1 AND id = $2",
        [identity.workspaceId, workstationId],
      );
      expect(retained.rowCount).toBe(1);
    } finally {
      await database.admin.query(
        "DELETE FROM workstations WHERE workspace_id = $1 AND id = $2",
        [identity.workspaceId, workstationId],
      );
    }
  });

  it("does not let the web role impersonate the connector with a custom GUC", async () => {
    const visible = await withUserTransaction(
      database.app,
      "10000000-0000-4000-8000-000000000002",
      null,
      async (client) => {
        await client.query("SELECT set_config('app.service_role', 'true', true)");
        const workspaces = await client.query("SELECT id FROM workspaces");
        return workspaces.rowCount;
      },
    );
    expect(visible).toBe(1);
  });

  it("rejects a member without high-risk approval permission", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/requests/${highRiskRequestId}/decision`,
      headers: { cookie: bobCookie, "idempotency-key": `bob-high-${randomUUID()}` },
      payload: { decision: "approve", highRiskConfirmed: true },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("permission_denied");
  });

  it("creates, invites, joins, and manages a workspace through audited atomic mutations", async () => {
    const workspaceKey = `workspace-create-${randomUUID()}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: aliceCookie, "idempotency-key": workspaceKey },
      payload: { name: "Release Operations", kind: "team" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const workspace = created.json<{ workspace: { id: string; role: string }; replayed: boolean }>();
    expect(workspace.workspace.role).toBe("owner");
    const replay = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: aliceCookie, "idempotency-key": workspaceKey },
      payload: { name: "Release Operations", kind: "team" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ replayed: boolean }>().replayed).toBe(true);

    const inviteKey = `invite-create-${randomUUID()}`;
    const inviteResponse = await app.inject({
      method: "POST",
      url: "/api/workspace-invites",
      headers: { cookie: aliceCookie, "idempotency-key": inviteKey },
      payload: { workspaceId: workspace.workspace.id, role: "member" },
    });
    expect(inviteResponse.statusCode, inviteResponse.body).toBe(201);
    const invite = inviteResponse.json<{ token: string }>();
    expect(invite.token).toMatch(/^ypi_[A-Za-z0-9_-]{43}$/);

    const joined = await app.inject({
      method: "POST",
      url: "/api/workspace-invites/join",
      headers: { cookie: bobCookie },
      payload: { token: invite.token },
    });
    expect(joined.statusCode, joined.body).toBe(200);
    expect(joined.json<{ workspace: { id: string; role: string } }>().workspace).toMatchObject({ id: workspace.workspace.id, role: "member" });

    const promoted = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.workspace.id}/members/10000000-0000-4000-8000-000000000002`,
      headers: { cookie: aliceCookie },
      payload: { role: "admin" },
    });
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect(promoted.json<{ member: { role: string } }>().member.role).toBe("admin");

    const forbidden = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspace.workspace.id}/members/10000000-0000-4000-8000-000000000001`,
      headers: { cookie: bobCookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const audit = await database.admin.query<{ actions: string[] }>(
      `SELECT array_agg(action ORDER BY occurred_at) AS actions
         FROM audit_events WHERE workspace_id = $1`,
      [workspace.workspace.id],
    );
    expect(audit.rows[0]?.actions).toEqual(expect.arrayContaining([
      "workspace.created",
      "workspace.invite_created",
      "workspace.joined",
      "workspace.member_role_updated",
    ]));

    await database.admin.query("DELETE FROM workspaces WHERE id = $1", [workspace.workspace.id]);
  });

  it("updates and revokes workstation access without allowing a removed member to retain visibility", async () => {
    const accessUpdate = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${identity.workspaceId}/workstations/${identity.workstationId}/access`,
      headers: { cookie: aliceCookie },
      payload: {
        userId: "10000000-0000-0000-0000-000000000099",
        canView: false,
        canRespond: false,
        canApproveHighRisk: false,
        canManage: false,
        canPreview: false,
      },
    });
    expect(accessUpdate.statusCode).toBe(404);

    const memberAccess = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${identity.workspaceId}/workstations/${identity.workstationId}/access`,
      headers: { cookie: aliceCookie },
      payload: {
        userId: "10000000-0000-4000-8000-000000000002",
        canView: true,
        canRespond: false,
        canApproveHighRisk: false,
        canManage: false,
        canPreview: false,
      },
    });
    expect(memberAccess.statusCode, memberAccess.body).toBe(200);

    const revoked = await app.inject({
      method: "POST",
      url: `/api/workspaces/${identity.workspaceId}/workstations/${identity.workstationId}/revoke`,
      headers: { cookie: aliceCookie },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    const bobSnapshot = await app.inject({ method: "GET", url: "/api/snapshot", headers: { cookie: bobCookie } });
    expect(bobSnapshot.statusCode).toBe(200);
    expect(bobSnapshot.json<{ workstations: Array<{ id: string }> }>().workstations).not.toContainEqual(expect.objectContaining({ id: identity.workstationId }));

    await database.admin.query(
      `UPDATE workstations SET revoked_at = NULL, status = 'online', credential_hash = encode(digest('alpha-connector-token', 'sha256'), 'hex')
        WHERE workspace_id = $1 AND id = $2`,
      [identity.workspaceId, identity.workstationId],
    );
  });
});

describe("PWA Web Push", () => {
  it("registers one account-scoped endpoint under RLS and atomically transfers ownership", async () => {
    const endpoint = `https://push.example.test/send/${randomUUID()}`;
    const unauthorized = await app.inject({ method: "GET", url: "/api/push/config" });
    expect(unauthorized.statusCode).toBe(401);

    const capability = await app.inject({
      method: "GET",
      url: "/api/push/config",
      headers: { cookie: aliceCookie },
    });
    expect(capability.statusCode).toBe(200);
    expect(capability.json()).toEqual({ enabled: true, publicKey: testVapidPublicKey });

    const invalid = await registerPush(aliceCookie, "http://push.example.test/not-secure");
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("invalid_push_subscription");

    const created = await registerPush(aliceCookie, endpoint);
    expect(created.statusCode, created.body).toBe(201);
    expect(await visiblePushEndpoints("10000000-0000-4000-8000-000000000001")).toEqual([endpoint]);
    expect(await visiblePushEndpoints("10000000-0000-4000-8000-000000000002")).toEqual([]);

    const transferred = await registerPush(bobCookie, endpoint);
    expect(transferred.statusCode, transferred.body).toBe(200);
    expect(await visiblePushEndpoints("10000000-0000-4000-8000-000000000001")).toEqual([]);
    expect(await visiblePushEndpoints("10000000-0000-4000-8000-000000000002")).toEqual([endpoint]);

    const wrongOwnerDelete = await unregisterPush(aliceCookie, endpoint);
    expect(wrongOwnerDelete.statusCode).toBe(204);
    expect(await visiblePushEndpoints("10000000-0000-4000-8000-000000000002")).toEqual([endpoint]);
    const removed = await unregisterPush(bobCookie, endpoint);
    expect(removed.statusCode).toBe(204);
    expect(await visiblePushEndpoints("10000000-0000-4000-8000-000000000002")).toEqual([]);

    const audit = await database.admin.query<{ content: string }>(
      "SELECT COALESCE(string_agg(metadata::text, ''), '') AS content FROM audit_events",
    );
    expect(audit.rows[0]?.content).not.toContain(endpoint);
  });

  it("pushes one minimal notification after a committed request and ignores duplicate envelopes", async () => {
    const aliceEndpoint = `https://push.example.test/send/alice-${randomUUID()}`;
    const bobEndpoint = `https://push.example.test/send/bob-${randomUUID()}`;
    await registerPush(aliceCookie, aliceEndpoint);
    await registerPush(bobCookie, bobEndpoint);
    await database.admin.query(
      `UPDATE workstation_access SET can_respond = false
        WHERE workspace_id = $1 AND workstation_id = $2
          AND user_id = '10000000-0000-4000-8000-000000000002'`,
      [identity.workspaceId, identity.workstationId],
    );
    const socket = await app.injectWS("/connector/v1/ws", {
      headers: { authorization: `Bearer ${config.connectorToken}` },
    });
    const connectorMessages: Array<Record<string, unknown>> = [];
    socket.on("message", (data) => connectorMessages.push(JSON.parse(data.toString()) as Record<string, unknown>));
    const requestId = randomUUID();
    const messageId = randomUUID();
    const secret = `do-not-push-${randomUUID()}`;
    const envelope = makeEnvelope(messageId, 20_001, {
      type: "request.created",
      requestId,
      threadId: "thread-alpha-live",
      turnId: `turn-push-${randomUUID()}`,
      itemId: `item-push-${randomUUID()}`,
      kind: "approval",
      category: "command",
      tool: "shell",
      risk: "high",
      context: { command: secret, cwd: "~/private-project", reason: "sensitive reason" },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    try {
      await waitFor(() => socket.readyState === socket.OPEN, "Push test Connector socket to open");
      await settleWebSocket();
      socket.send(JSON.stringify({ type: "hello" }));
      await waitFor(() => connectorMessages.some((message) => message.type === "welcome"), "Push test Connector welcome");
      socket.send(JSON.stringify(envelope));
      await waitFor(() => connectorMessages.some((message) => message.type === "ack" && message.messageId === messageId), "Push request ACK");
      await waitFor(() => pushCalls.length === 1, "one Web Push notification");

      expect(pushCalls[0]?.endpoint).toBe(aliceEndpoint);
      const payload = JSON.parse(pushCalls[0]?.payload ?? "{}") as Record<string, unknown>;
      expect(payload).toEqual({
        v: 1,
        event: "request.created",
        workspaceId: identity.workspaceId,
        requestId,
        occurredAt: envelope.payload.requestedAt,
      });
      expect(JSON.stringify(payload)).not.toContain(secret);
      expect(JSON.stringify(payload)).not.toContain("private-project");
      expect(JSON.stringify(payload)).not.toContain("shell");
      expect(pushCalls[0]?.options.vapidDetails?.privateKey).toBe(testVapidPrivateKey);

      socket.send(JSON.stringify(envelope));
      await settleWebSocket();
      expect(pushCalls).toHaveLength(1);
      const stored = await database.admin.query<{ requests: number; inbox: number }>(
        `SELECT
           (SELECT count(*)::int FROM agent_requests WHERE workspace_id = $1 AND id = $2) AS requests,
           (SELECT count(*)::int FROM connector_inbox WHERE workspace_id = $1 AND message_id = $3) AS inbox`,
        [identity.workspaceId, requestId, messageId],
      );
      expect(stored.rows[0]).toEqual({ requests: 1, inbox: 1 });
    } finally {
      socket.terminate();
      await database.admin.query(
        "DELETE FROM agent_requests WHERE workspace_id = $1 AND id = $2",
        [identity.workspaceId, requestId],
      );
      await database.admin.query(
        "DELETE FROM connector_inbox WHERE workspace_id = $1 AND message_id = $2",
        [identity.workspaceId, messageId],
      );
      await database.admin.query(
        `UPDATE workstation_access SET can_respond = true
          WHERE workspace_id = $1 AND workstation_id = $2
            AND user_id = '10000000-0000-4000-8000-000000000002'`,
        [identity.workspaceId, identity.workstationId],
      );
    }
  });

  it("deletes expired provider endpoints but retains subscriptions after temporary failure", async () => {
    const goneEndpoint = `https://push.example.test/send/gone-${randomUUID()}`;
    await registerPush(aliceCookie, goneEndpoint);
    pushFailureStatus = 410;
    const gone = await createPushRequest(20_101);
    await waitFor(async () => await pushSubscriptionCount(goneEndpoint) === 0, "expired push endpoint cleanup");
    await deletePushRequest(gone);

    const retryEndpoint = `https://push.example.test/send/retry-${randomUUID()}`;
    await registerPush(aliceCookie, retryEndpoint);
    pushFailureStatus = 503;
    const retry = await createPushRequest(20_102);
    await waitFor(async () => await pushFailureCount(retryEndpoint) === 1, "temporary push failure record");
    expect(await pushSubscriptionCount(retryEndpoint)).toBe(1);
    await deletePushRequest(retry);
  });
});

describe("workstation pairing", () => {
  it("stores only a hash and requires explicit approval before WSS authentication", async () => {
    const created = await createTestPairing(aliceCookie);
    expect(created.statusCode).toBe(201);
    const creation = created.json<{ pairing: { id: string }; pairCode: string }>();
    expect(creation.pairCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const stored = await database.admin.query<{ code_hash: string }>(
      "SELECT code_hash FROM workstation_pairings WHERE id = $1",
      [creation.pairing.id],
    );
    expect(stored.rows[0]?.code_hash).toHaveLength(64);
    expect(stored.rows[0]?.code_hash).not.toContain(creation.pairCode.replaceAll("-", ""));

    const claimSecret = `claim-${randomUUID()}-${randomUUID()}`;
    const claimed = await claimTestPairing(creation.pairCode, claimSecret, "PUBLIC KEY ".repeat(10));
    expect(claimed.statusCode, claimed.body).toBe(202);
    const pending = await resultTestPairing(creation.pairCode, claimSecret);
    expect(pending.json<{ status: string; connectorToken?: string }>().status).toBe("pending_approval");
    expect(pending.json<{ connectorToken?: string }>().connectorToken).toBeUndefined();

    const approvals = await Promise.all([
      approveTestPairing(aliceCookie, creation.pairing.id, "Remote build host"),
      approveTestPairing(aliceCookie, creation.pairing.id, "Conflicting name"),
    ]);
    expect(approvals.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const count = await database.admin.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM workstations WHERE connector_version = '0.2.0-alpha'",
    );
    expect(count.rows[0]?.count).toBe("1");

    const approved = await resultTestPairing(creation.pairCode, claimSecret);
    const credential = approved.json<{ status: string; connectorToken: string; workspaceId: string; workstationId: string }>();
    expect(credential.status).toBe("approved");
    expect(credential.connectorToken).toMatch(/^ypd_/);
    const identityFromCredential = await findConnectorIdentity(database.connector, credential.connectorToken);
    expect(identityFromCredential).toEqual({
      workspaceId: credential.workspaceId,
      workstationId: credential.workstationId,
    });
    const credentialRows = await database.admin.query<{ credential_hash: string }>(
      "SELECT credential_hash FROM workstations WHERE id = $1",
      [credential.workstationId],
    );
    expect(credentialRows.rows[0]?.credential_hash).not.toBe(credential.connectorToken);
  });

  it("allows only the first device to claim a single-use code", async () => {
    const creation = (await createTestPairing(aliceCookie)).json<{ pairCode: string }>();
    const claims = await Promise.all([
      claimTestPairing(creation.pairCode, `first-${randomUUID()}-${randomUUID()}`, "FIRST PUBLIC KEY ".repeat(8)),
      claimTestPairing(creation.pairCode, `second-${randomUUID()}-${randomUUID()}`, "SECOND PUBLIC KEY ".repeat(8)),
    ]);
    expect(claims.map((response) => response.statusCode).sort()).toEqual([202, 409]);
  });

  it("rejects expired codes and workspace members without management access", async () => {
    const forbidden = await createTestPairing(bobCookie);
    expect(forbidden.statusCode).toBe(403);

    const creation = (await createTestPairing(aliceCookie)).json<{ pairing: { id: string }; pairCode: string }>();
    await database.admin.query(
      "UPDATE workstation_pairings SET expires_at = now() - interval '1 second' WHERE id = $1",
      [creation.pairing.id],
    );
    const expired = await claimTestPairing(
      creation.pairCode,
      `expired-${randomUUID()}-${randomUUID()}`,
      "EXPIRED PUBLIC KEY ".repeat(8),
    );
    expect(expired.statusCode, expired.body).toBe(410);
    const row = await database.admin.query<{ status: string }>(
      "SELECT status FROM workstation_pairings WHERE id = $1",
      [creation.pairing.id],
    );
    expect(row.rows[0]?.status).toBe("expired");
  });

  it("atomically resolves approval and cancellation competition", async () => {
    const creation = (await createTestPairing(aliceCookie)).json<{ pairing: { id: string }; pairCode: string }>();
    await claimTestPairing(
      creation.pairCode,
      `race-${randomUUID()}-${randomUUID()}`,
      "RACE PUBLIC KEY ".repeat(8),
    );
    const responses = await Promise.all([
      approveTestPairing(aliceCookie, creation.pairing.id, "Race host"),
      app.inject({
        method: "POST",
        url: `/api/workstation-pairings/${creation.pairing.id}/cancel`,
        headers: { cookie: aliceCookie },
        payload: {},
      }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const final = await database.admin.query<{ status: string }>(
      "SELECT status FROM workstation_pairings WHERE id = $1",
      [creation.pairing.id],
    );
    expect(["approved", "cancelled"]).toContain(final.rows[0]?.status);
  });
});

describe("development preview tunnel", () => {
  it("accepts an immutable active route near expiry after a Connector reconnect", async () => {
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + 15 * 60_000);
    const route = {
      routeId: randomUUID(),
      name: "Short reconnect fixture",
      port: 45174,
      status: "active" as const,
      expiresAt: expiresAt.toISOString(),
    };
    await syncConnectorPreviewRoutes(database.connector, identity, [route], {
      now: startedAt,
      maxDurationMs: 240 * 60_000,
    });

    const resumed = await syncConnectorPreviewRoutes(database.connector, identity, [route], {
      now: new Date(expiresAt.getTime() - 5_000),
      maxDurationMs: 240 * 60_000,
    });
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ routeId: route.routeId, port: route.port, status: "active" });

    await expect(syncConnectorPreviewRoutes(database.connector, identity, [{ ...route, port: 45175 }], {
      now: new Date(expiresAt.getTime() - 4_000),
      maxDurationMs: 240 * 60_000,
    })).rejects.toMatchObject({ code: "preview_route_mismatch", statusCode: 409 });
  });

  it("persists Connector offline and stopped transitions with timestamp values", async () => {
    const startedAt = new Date();
    const route = {
      routeId: randomUUID(),
      name: "Connector status fixture",
      port: 45176,
      status: "active" as const,
      expiresAt: new Date(startedAt.getTime() + 60 * 60_000).toISOString(),
    };
    await syncConnectorPreviewRoutes(database.connector, identity, [route], {
      now: startedAt,
      maxDurationMs: 240 * 60_000,
    });

    const offlineAt = new Date(startedAt.getTime() + 1_000);
    const offline = await markConnectorPreviewsOffline(database.connector, identity, [route.routeId], offlineAt);
    expect(offline[0]).toMatchObject({ routeId: route.routeId, status: "connector_offline", stoppedAt: null });

    const stoppedAt = new Date(startedAt.getTime() + 2_000);
    const stopped = await stopConnectorPreviewRoutes(database.connector, identity, [route.routeId], stoppedAt);
    expect(stopped[0]).toMatchObject({ routeId: route.routeId, status: "stopped", stoppedAt: stoppedAt.toISOString() });
  });

  it("relays an explicitly paired loopback route with one-time access and precise permissions", async () => {
    const created = await createTestPairing(aliceCookie);
    const creation = created.json<{ pairing: { id: string }; pairCode: string }>();
    const claimSecret = `preview-${randomUUID()}-${randomUUID()}`;
    await claimTestPairing(creation.pairCode, claimSecret, "PREVIEW PUBLIC KEY ".repeat(8));
    const approved = await approveTestPairing(aliceCookie, creation.pairing.id, "Preview fixture host");
    expect(approved.statusCode, approved.body).toBe(200);
    const result = await resultTestPairing(creation.pairCode, claimSecret);
    const credential = result.json<{
      connectorToken: string;
      workspaceId: string;
      workstationId: string;
    }>();

    const gatewayPort = await availablePort();
    const previewConfig = {
      ...config,
      previewEnabled: true,
      previewGatewayHost: "127.0.0.1",
      previewGatewayPort: gatewayPort,
      previewPublicOrigin: `http://preview.localhost:${gatewayPort}`,
    };
    const previewApp = await buildApp({ config: previewConfig, database, logger: false });
    await previewApp.ready();
    const routeId = randomUUID();
    let connectorSocket: WebSocket | undefined;
    try {
      connectorSocket = await previewApp.injectWS("/connector/v1/preview/ws", {
        headers: { authorization: `Bearer ${credential.connectorToken}` },
      });
      const connectorMessages: Record<string, any>[] = [];
      connectorSocket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, any>;
        connectorMessages.push(message);
        if (message.type === "preview.ws.open") {
          connectorSocket?.send(JSON.stringify({
            type: "preview.stream.error",
            streamId: message.streamId,
            code: "local_connection_failed",
            dispatched: true,
          }));
          return;
        }
        if (message.type !== "preview.http.open") return;
        connectorSocket?.send(JSON.stringify({ type: "preview.http.accepted", streamId: message.streamId }));
        connectorSocket?.send(JSON.stringify({
          type: "preview.http.response.start",
          streamId: message.streamId,
          statusCode: 200,
          headers: [
            ["content-type", "text/html; charset=utf-8"],
            ["set-cookie", "fixture=ready; Domain=localhost; Path=/; SameSite=Lax"],
          ],
        }));
        connectorSocket?.send(JSON.stringify({
          type: "preview.http.response.chunk",
          streamId: message.streamId,
          offset: 0,
          data: Buffer.from("<main>remote-preview-ok</main>").toString("base64"),
        }));
        connectorSocket?.send(JSON.stringify({ type: "preview.http.response.end", streamId: message.streamId }));
      });
      connectorSocket.send(JSON.stringify({
        type: "preview.hello",
        protocolVersion: 1,
        connectionEpoch: randomUUID(),
        routes: [{
          routeId,
          name: "Vite local fixture",
          port: 5173,
          status: "active",
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        }],
      }));
      await waitFor(
        () => connectorMessages.some((message) => message.type === "preview.welcome"),
        "preview connector welcome",
      );

      const snapshot = await previewApp.inject({
        method: "GET",
        url: "/api/snapshot",
        headers: { cookie: aliceCookie },
      });
      expect(snapshot.statusCode, snapshot.body).toBe(200);
      const preview = snapshot.json<{ previews: Array<{ id: string; routeId: string }> }>()
        .previews.find((item) => item.routeId === routeId);
      expect(preview).toBeDefined();

      const bobSnapshot = await previewApp.inject({
        method: "GET",
        url: "/api/snapshot",
        headers: { cookie: bobCookie },
      });
      expect(bobSnapshot.json<{ previews: Array<{ routeId: string }> }>().previews)
        .not.toContainEqual(expect.objectContaining({ routeId }));

      const denied = await previewApp.inject({
        method: "POST",
        url: `/api/previews/${preview?.id}/launch`,
        headers: { cookie: bobCookie },
      });
      expect(denied.statusCode).toBe(404);

      const launch = await previewApp.inject({
        method: "POST",
        url: `/api/previews/${preview?.id}/launch`,
        headers: { cookie: aliceCookie },
      });
      expect(launch.statusCode, launch.body).toBe(200);
      expect(launch.headers["cache-control"]).toBe("no-store");
      const launchBody = launch.json<{ ticket: string; gatewayOrigin: string }>();
      expect(launchBody.gatewayOrigin).toBe(previewConfig.previewPublicOrigin);

      const form = new URLSearchParams({ ticket: launchBody.ticket }).toString();
      const redemption = await gatewayRequest(gatewayPort, {
        method: "POST",
        path: "/__yurupager/open",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(Buffer.byteLength(form)),
        },
        body: form,
      });
      expect(redemption.statusCode).toBe(303);
      expect(redemption.headers.location).toBe("/");
      const contextCookie = redemption.headers["set-cookie"]?.[0]?.split(";", 1)[0];
      expect(contextCookie).toMatch(/^yp_preview_context=/);

      const replay = await gatewayRequest(gatewayPort, {
        method: "POST",
        path: "/__yurupager/open",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(Buffer.byteLength(form)),
        },
        body: form,
      });
      expect(replay.statusCode).toBe(401);

      const proxied = await gatewayRequest(gatewayPort, {
        method: "GET",
        path: "/private-fixture?do-not-persist=traffic-sentinel",
        headers: { cookie: `${contextCookie}; yp_session=must-not-reach-loopback` },
      });
      expect(proxied.statusCode).toBe(200);
      expect(proxied.body).toContain("remote-preview-ok");
      expect(proxied.headers["set-cookie"]?.[0]).toMatch(/^ypv_/);
      const opened = connectorMessages.find((message) => message.type === "preview.http.open");
      expect(opened?.headers).not.toContainEqual(["cookie", expect.stringContaining("yp_session")]);
      expect(opened?.headers).not.toContainEqual(["authorization", expect.any(String)]);

      const serviceWorker = await gatewayRequest(gatewayPort, {
        method: "GET",
        path: "/service-worker.js",
        headers: { cookie: contextCookie ?? "", "service-worker": "script" },
      });
      expect(serviceWorker.statusCode).toBe(403);

      const rejectedSocket = new ClientWebSocket(`ws://127.0.0.1:${gatewayPort}/expected-local-failure`, {
        headers: { cookie: contextCookie ?? "" },
      });
      await waitForWebSocketFailure(rejectedSocket);

      const stop = await previewApp.inject({
        method: "POST",
        url: `/api/previews/${preview?.id}/stop`,
        headers: { cookie: aliceCookie },
      });
      expect(stop.statusCode, stop.body).toBe(200);
      expect(stop.json<{ preview: { status: string } }>().preview.status).toBe("stopped");
      await waitFor(
        () => connectorMessages.some((message) => message.type === "preview.route.stop"),
        "preview route stop",
      );
    } finally {
      connectorSocket?.close();
      await previewApp.close();
    }
  });

  it("carries real Connector HTTP and WebSocket traffic through the relay and gateway", async () => {
    const created = await createTestPairing(aliceCookie);
    const creation = created.json<{ pairing: { id: string }; pairCode: string }>();
    const claimSecret = `preview-live-${randomUUID()}-${randomUUID()}`;
    await claimTestPairing(creation.pairCode, claimSecret, "PREVIEW LIVE KEY ".repeat(10));
    const approved = await approveTestPairing(aliceCookie, creation.pairing.id, "Preview live fixture");
    expect(approved.statusCode, approved.body).toBe(200);
    const pairingResult = await resultTestPairing(creation.pairCode, claimSecret);
    const credential = pairingResult.json<{
      connectorToken: string;
      workspaceId: string;
      workstationId: string;
    }>();

    const localServer = createServer((request, response) => {
      const complete = () => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<main data-path="${request.url ?? ""}">real-preview-ok</main>`);
      };
      if (request.url?.startsWith("/module-") === true) setTimeout(complete, 40);
      else complete();
    });
    const localWebSocket = new WebSocketServer({ server: localServer });
    localWebSocket.on("connection", (socket) => {
      socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
    });
    const localPort = await listenHttpServer(localServer);
    const gatewayPort = await availablePort();
    const apiPort = await availablePort();
    const liveConfig = {
      ...config,
      port: apiPort,
      previewEnabled: true,
      previewGatewayHost: "127.0.0.1",
      previewGatewayPort: gatewayPort,
      previewPublicOrigin: `http://preview.localhost:${gatewayPort}`,
    };
    const previewApp = await buildApp({ config: liveConfig, database, logger: false });
    await previewApp.listen({ host: "127.0.0.1", port: apiPort });
    const routeId = randomUUID();
    const connector = new PreviewTunnelClient({
      url: `ws://127.0.0.1:${apiPort}/connector/v1/preview/ws`,
      token: credential.connectorToken,
      route: {
        routeId,
        name: "Real Vite fixture",
        port: localPort,
        status: "active",
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
      target: { host: "127.0.0.1", port: localPort },
      reconnectMinMs: 10,
      reconnectMaxMs: 10,
      random: () => 0.5,
    });
    let browserSocket: ClientWebSocket | undefined;

    try {
      connector.start();
      await waitFor(() => connector.online, "real preview Connector online");
      const snapshot = await previewApp.inject({
        method: "GET",
        url: "/api/snapshot",
        headers: { cookie: aliceCookie },
      });
      const preview = snapshot.json<{ previews: Array<{ id: string; routeId: string }> }>()
        .previews.find((item) => item.routeId === routeId);
      expect(preview).toBeDefined();

      const launch = await previewApp.inject({
        method: "POST",
        url: `/api/previews/${preview?.id}/launch`,
        headers: { cookie: aliceCookie },
      });
      expect(launch.statusCode, launch.body).toBe(200);
      const form = new URLSearchParams({
        ticket: launch.json<{ ticket: string }>().ticket,
      }).toString();
      const redemption = await gatewayRequest(gatewayPort, {
        method: "POST",
        path: "/__yurupager/open",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(Buffer.byteLength(form)),
        },
        body: form,
      });
      expect(redemption.statusCode).toBe(303);
      const contextCookie = redemption.headers["set-cookie"]?.[0]?.split(";", 1)[0];
      expect(contextCookie).toMatch(/^yp_preview_context=/);

      const html = await gatewayRequest(gatewayPort, {
        method: "GET",
        path: "/vite-entry?fixture=real",
        headers: { cookie: contextCookie ?? "" },
      });
      expect(html.statusCode).toBe(200);
      expect(html.body).toContain('data-path="/vite-entry?fixture=real"');
      expect(html.body).toContain("real-preview-ok");

      await closeHttpServer(localServer);
      const failed = await gatewayRequest(gatewayPort, {
        method: "GET",
        path: "/local-service-offline",
        headers: { cookie: contextCookie ?? "" },
      });
      expect(failed.statusCode).toBe(504);
      expect(connector.online).toBe(true);
      expect(await listenHttpServer(localServer, localPort)).toBe(localPort);

      const recovered = await gatewayRequest(gatewayPort, {
        method: "GET",
        path: "/local-service-recovered",
        headers: { cookie: contextCookie ?? "" },
      });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.body).toContain("real-preview-ok");

      browserSocket = new ClientWebSocket(`ws://127.0.0.1:${gatewayPort}/hmr`, {
        headers: { cookie: contextCookie ?? "" },
      });
      await waitForWebSocketOpen(browserSocket);
      const echoed = waitForWebSocketMessage(browserSocket);
      browserSocket.send("vite-hmr-update");
      expect(await echoed).toBe("vite-hmr-update");

      const [desktopModules, mobileModules] = await Promise.all([
        Promise.all(Array.from({ length: 12 }, (_, index) => gatewayRequest(gatewayPort, {
          method: "GET",
          path: `/module-desktop-${index}.js`,
          headers: { cookie: contextCookie ?? "" },
        }))),
        Promise.all(Array.from({ length: 12 }, (_, index) => gatewayRequest(gatewayPort, {
          method: "GET",
          path: `/module-mobile-${index}.js`,
          headers: { cookie: contextCookie ?? "" },
        }))),
      ]);
      expect([...desktopModules, ...mobileModules].map((response) => response.statusCode))
        .toEqual(Array.from({ length: 24 }, () => 200));
      expect(connector.online).toBe(true);
    } finally {
      browserSocket?.close();
      await connector.stop();
      await previewApp.close();
      await closeWebSocketServer(localWebSocket);
      await closeHttpServer(localServer);
    }
  });
});

describe("atomic request decisions", () => {
  it("accepts exactly one of two opposing collaborator decisions", async () => {
    const [approve, deny] = await Promise.all([
      decide(aliceCookie, `alice-race-${randomUUID()}`, { decision: "approve" }),
      decide(bobCookie, `bob-race-${randomUUID()}`, {
        decision: "deny",
        reason: "Needs a safer command boundary",
      }),
    ]);
    expect([approve.statusCode, deny.statusCode].sort()).toEqual([200, 409]);
    const winner = approve.statusCode === 200 ? approve.json() : deny.json();
    const conflict = approve.statusCode === 409 ? approve.json() : deny.json();
    expect(["approved", "denied"]).toContain(winner.request.status);
    expect(conflict.error.code).toBe("decision_conflict");
    expect(conflict.error.details.request.decidedByName).toBeTruthy();

    const stored = await database.admin.query(
      "SELECT count(*)::int AS count FROM request_decisions WHERE workspace_id = $1 AND request_id = $2",
      [identity.workspaceId, requestId],
    );
    expect(stored.rows[0].count).toBe(1);
  });

  it("replays an identical idempotent submission without another outbox effect", async () => {
    const key = `alice-replay-${randomUUID()}`;
    const first = await decide(aliceCookie, key, { decision: "approve" });
    const replay = await decide(aliceCookie, key, { decision: "approve" });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    const outbox = await database.admin.query(
      "SELECT count(*)::int AS count FROM connector_outbox WHERE workspace_id = $1 AND request_id = $2",
      [identity.workspaceId, requestId],
    );
    expect(outbox.rows[0].count).toBe(1);
  });

  it("requires explicit high-risk confirmation before state changes", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/requests/${highRiskRequestId}/decision`,
      headers: { cookie: aliceCookie, "idempotency-key": `high-${randomUUID()}` },
      payload: { decision: "approve" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("high_risk_confirmation_required");
  });

  it("commits expiration without queuing a Connector side effect", async () => {
    await database.admin.query(
      "UPDATE agent_requests SET expires_at = now() - interval '1 second' WHERE workspace_id = $1 AND id = $2",
      [identity.workspaceId, requestId],
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/requests/${requestId}/decision`,
      headers: { cookie: aliceCookie, "idempotency-key": `expired-${randomUUID()}` },
      payload: { decision: "approve" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.details.request.status).toBe("expired");

    const request = await database.admin.query(
      "SELECT status FROM agent_requests WHERE workspace_id = $1 AND id = $2",
      [identity.workspaceId, requestId],
    );
    const outbox = await database.admin.query(
      "SELECT id FROM connector_outbox WHERE workspace_id = $1 AND request_id = $2",
      [identity.workspaceId, requestId],
    );
    expect(request.rows[0]?.status).toBe("expired");
    expect(outbox.rowCount).toBe(0);
  });

  it("rejects secret answers before they can be persisted", async () => {
    await database.admin.query(
      `UPDATE agent_requests
          SET context = '{"questions":[{"id":"credential","header":"Credential","question":"Enter the deployment credential","isSecret":true,"options":[]}]}'::jsonb
        WHERE workspace_id = $1 AND id = $2`,
      [identity.workspaceId, questionRequestId],
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/requests/${questionRequestId}/decision`,
      headers: { cookie: aliceCookie, "idempotency-key": `secret-${randomUUID()}` },
      payload: { decision: "answer", answers: { credential: ["not-stored"] } },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("secret_answer_local_only");
    const decisions = await database.admin.query(
      "SELECT count(*)::int AS count FROM request_decisions WHERE workspace_id = $1 AND request_id = $2",
      [identity.workspaceId, questionRequestId],
    );
    expect(decisions.rows[0].count).toBe(0);
  });
});

describe("active session messages", () => {
  it("queues one idempotent command without exposing its text in snapshots", async () => {
    const key = `message-${randomUUID()}`;
    const content = "Continue by running the focused unit tests, then report only the result.";
    const first = await sendCommand(aliceCookie, key, content);
    const replay = await sendCommand(aliceCookie, key, content);

    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(replay.json().command.id).toBe(first.json().command.id);

    const stored = await database.admin.query(
      `SELECT c.content_length, o.payload, count(*) OVER ()::int AS command_count
         FROM session_commands c
         JOIN connector_outbox o ON o.workspace_id = c.workspace_id AND o.command_id = c.id
        WHERE c.workspace_id = $1 AND c.session_id = $2`,
      [identity.workspaceId, sessionId],
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0].content_length).toBe(Array.from(content).length);
    expect(stored.rows[0].payload.text).toBe(content);

    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot", headers: { cookie: aliceCookie } });
    const command = snapshot.json().sessionCommands.find((item: { id: string }) => item.id === first.json().command.id);
    expect(command).toBeTruthy();
    expect(command).not.toHaveProperty("content");
    expect(JSON.stringify(command)).not.toContain(content);
  });

  it("rejects messages when the collaborator lacks workstation response permission", async () => {
    await database.admin.query(
      `UPDATE workstation_access SET can_respond = false
        WHERE workspace_id = $1 AND workstation_id = $2
          AND user_id = '10000000-0000-4000-8000-000000000002'`,
      [identity.workspaceId, identity.workstationId],
    );
    try {
      const response = await sendCommand(bobCookie, `message-denied-${randomUUID()}`, "Continue the task.");
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("permission_denied");
    } finally {
      await database.admin.query(
        `UPDATE workstation_access SET can_respond = true
          WHERE workspace_id = $1 AND workstation_id = $2
            AND user_id = '10000000-0000-4000-8000-000000000002'`,
        [identity.workspaceId, identity.workstationId],
      );
    }
  });

  it("redacts transient text and records the Connector delivery result", async () => {
    const content = "Inspect the current failure and stop after explaining the root cause.";
    const queued = await sendCommand(aliceCookie, `message-delivered-${randomUUID()}`, content);
    const commandId = queued.json().command.id as string;
    const envelope = makeEnvelope(randomUUID(), 811, {
      type: "session.command.updated",
      commandId,
      threadId: "thread-alpha-live",
      status: "delivered",
      turnId: "turn-remote-message-1",
    });
    await processConnectorEnvelope(database.connector, identity, envelope);

    const result = await database.admin.query(
      `SELECT c.status, c.turn_id, c.delivered_at, o.acknowledged_at, o.payload,
              s.latest_turn_id, s.status AS session_status
         FROM session_commands c
         JOIN connector_outbox o ON o.workspace_id = c.workspace_id AND o.command_id = c.id
         JOIN agent_sessions s ON s.workspace_id = c.workspace_id AND s.id = c.session_id
        WHERE c.workspace_id = $1 AND c.id = $2`,
      [identity.workspaceId, commandId],
    );
    expect(result.rows[0].status).toBe("delivered");
    expect(result.rows[0].turn_id).toBe("turn-remote-message-1");
    expect(result.rows[0].delivered_at).toBeTruthy();
    expect(result.rows[0].acknowledged_at).toBeTruthy();
    expect(result.rows[0].payload).toEqual({ commandId, redacted: true });
    expect(JSON.stringify(result.rows[0].payload)).not.toContain(content);
    expect(result.rows[0].latest_turn_id).toBe("turn-remote-message-1");
    expect(result.rows[0].session_status).toBe("running");
  });
});

describe("dual-end live session relay", () => {
  it("mirrors one remotely queued turn to desktop and mobile while denying another workspace", async () => {
    const privateSessionId = randomUUID();
    const privateThreadId = `thread-private-${randomUUID()}`;
    const deliveryEventId = randomUUID();
    const turnId = `turn-dual-end-${randomUUID()}`;
    const userMessageId = `user-message-${randomUUID()}`;
    const assistantMessageId = `assistant-message-${randomUUID()}`;
    const activityId = `activity-${randomUUID()}`;
    const commandText = `Continue the dual-end relay check ${randomUUID()}.`;
    const assistantDelta = `The desktop and phone now see turn ${turnId}.`;
    const desktopMessages: Array<Record<string, any>> = [];
    const mobileMessages: Array<Record<string, any>> = [];
    const outsideMessages: Array<Record<string, any>> = [];
    const connectorMessages: Array<Record<string, any>> = [];
    let desktopSocket: WebSocket | undefined;
    let mobileSocket: WebSocket | undefined;
    let outsideSocket: WebSocket | undefined;
    let connectorSocket: WebSocket | undefined;

    await database.admin.query(
      `INSERT INTO agent_sessions
         (workspace_id, id, workstation_id, initiator_user_id, thread_id, project_key,
          project_name, project_path_hint, model, status, sync_state)
       VALUES ($1, $2, $3, $4, $5, $6, 'Private relay probe', '~/private-relay-probe',
               'gpt-5.6-codex', 'waiting', 'live')`,
      [
        "20000000-0000-4000-8000-000000000001",
        privateSessionId,
        "30000000-0000-4000-8000-000000000002",
        "10000000-0000-4000-8000-000000000001",
        privateThreadId,
        createHash("sha256").update(privateThreadId).digest("hex"),
      ],
    );

    try {
      connectorSocket = await app.injectWS("/connector/v1/ws", {
        headers: { authorization: `Bearer ${config.connectorToken}` },
      }, {
        onInit(socket) {
          socket.on("message", (data) => connectorMessages.push(readMessage(data.toString())));
        },
      });
      await settleWebSocket();
      connectorSocket.send(JSON.stringify({ type: "hello" }));
      await waitFor(
        () => connectorMessages.some((message) => message.type === "welcome"),
        "dual-end Connector welcome",
      );

      desktopSocket = await app.injectWS("/api/live", {
        headers: { cookie: aliceCookie },
      }, {
        onInit(socket) {
          socket.on("message", (data) => desktopMessages.push(readMessage(data.toString())));
        },
      });
      mobileSocket = await app.injectWS("/api/live", {
        headers: { cookie: aliceCookie },
      }, {
        onInit(socket) {
          socket.on("message", (data) => mobileMessages.push(readMessage(data.toString())));
        },
      });
      outsideSocket = await app.injectWS("/api/live", {
        headers: { cookie: bobCookie },
      }, {
        onInit(socket) {
          socket.on("message", (data) => outsideMessages.push(readMessage(data.toString())));
        },
      });
      await waitFor(
        () => desktopMessages.some((message) => message.type === "connected") &&
          mobileMessages.some((message) => message.type === "connected") &&
          outsideMessages.some((message) => message.type === "connected"),
        "live sockets to authenticate",
      );

      desktopSocket.send(JSON.stringify({ type: "session.stream.subscribe", sessionId }));
      mobileSocket.send(JSON.stringify({ type: "session.stream.subscribe", sessionId }));
      outsideSocket.send(JSON.stringify({ type: "session.stream.subscribe", sessionId: privateSessionId }));

      await waitFor(
        () => connectorMessages.filter((message) =>
          message.type === "session.stream.subscribe" && message.threadId === "thread-alpha-live").length === 2,
        "desktop and mobile stream subscriptions",
      );
      await waitFor(
        () => outsideMessages.some((message) =>
          message.type === "session.stream.status" &&
          message.sessionId === privateSessionId &&
          message.state === "denied"),
        "cross-workspace subscription denial",
      );

      const subscriptions = connectorMessages.filter((message) =>
        message.type === "session.stream.subscribe" && message.threadId === "thread-alpha-live");
      expect(new Set(subscriptions.map((message) => message.subscriptionId)).size).toBe(2);

      const queued = await sendCommand(aliceCookie, `dual-end-command-${randomUUID()}`, commandText);
      expect(queued.statusCode, queued.body).toBe(202);
      const commandId = queued.json<{ command: { id: string } }>().command.id;
      await waitFor(
        () => connectorMessages.some((message) =>
          message.type === "session.command" && message.commandId === commandId),
        "queued mobile command at Connector",
      );
      expect(connectorMessages.findLast((message) =>
        message.type === "session.command" && message.commandId === commandId)).toMatchObject({
        threadId: "thread-alpha-live",
        text: commandText,
      });

      connectorSocket.send(JSON.stringify(makeEnvelope(deliveryEventId, 90_001, {
        type: "session.command.updated",
        commandId,
        threadId: "thread-alpha-live",
        status: "delivered",
        turnId,
      })));
      await waitFor(
        () => connectorMessages.some((message) =>
          message.type === "ack" && message.messageId === deliveryEventId),
        "Connector command delivery acknowledgement",
      );
      await waitFor(async () => {
        const result = await database.admin.query<{ status: string; turn_id: string | null }>(
          "SELECT status, turn_id FROM session_commands WHERE workspace_id = $1 AND id = $2",
          [identity.workspaceId, commandId],
        );
        return result.rows[0]?.status === "delivered" && result.rows[0]?.turn_id === turnId;
      }, "persisted delivered command");

      const frames: Array<Record<string, unknown>> = [
        { kind: "message.start", messageId: userMessageId, turnId, role: "user" },
        { kind: "message.delta", messageId: userMessageId, delta: commandText },
        { kind: "message.complete", messageId: userMessageId },
        { kind: "turn.status", turnId, status: "in_progress" },
        {
          kind: "activity.upsert",
          activityId,
          turnId,
          activity: "command",
          label: "Run focused relay verification",
          status: "in_progress",
        },
        { kind: "message.start", messageId: assistantMessageId, turnId, role: "assistant", phase: "commentary" },
        { kind: "message.delta", messageId: assistantMessageId, delta: assistantDelta },
        { kind: "message.complete", messageId: assistantMessageId },
        {
          kind: "activity.upsert",
          activityId,
          turnId,
          activity: "command",
          label: "Run focused relay verification",
          status: "completed",
        },
        { kind: "turn.status", turnId, status: "completed" },
      ];
      for (const frame of frames) {
        for (const subscription of subscriptions) {
          connectorSocket.send(JSON.stringify({
            type: "session.stream.frame",
            subscriptionId: subscription.subscriptionId,
            threadId: "thread-alpha-live",
            frame,
          }));
        }
      }

      const receivedFrames = (messages: Array<Record<string, any>>) => messages
        .filter((message) => message.type === "session.stream.frame" && message.sessionId === sessionId)
        .map((message) => message.frame);
      await waitFor(
        () => receivedFrames(desktopMessages).length === frames.length &&
          receivedFrames(mobileMessages).length === frames.length,
        "stream frames on desktop and mobile",
      );
      expect(receivedFrames(desktopMessages)).toEqual(frames);
      expect(receivedFrames(mobileMessages)).toEqual(frames);
      expect(outsideMessages.filter((message) => message.type === "session.stream.frame")).toEqual([]);
      expect(outsideMessages.map((message) => JSON.stringify(message)).join("\n"))
        .not.toContain(commandText);
      expect(outsideMessages.map((message) => JSON.stringify(message)).join("\n"))
        .not.toContain(assistantDelta);
    } finally {
      desktopSocket?.terminate();
      mobileSocket?.terminate();
      outsideSocket?.terminate();
      connectorSocket?.terminate();
      await database.admin.query(
        "DELETE FROM connector_inbox WHERE workspace_id = $1 AND message_id = $2",
        [identity.workspaceId, deliveryEventId],
      );
      await database.admin.query(
        "DELETE FROM agent_sessions WHERE workspace_id = $1 AND id = $2",
        ["20000000-0000-4000-8000-000000000001", privateSessionId],
      );
    }
  });
});

describe("Connector WebSocket handshake delivery", () => {
  it("replays once after hello and de-duplicates a command queued during the handshake", async () => {
    const socket = await app.injectWS("/connector/v1/ws", {
      headers: { authorization: `Bearer ${config.connectorToken}` },
    });
    const messages: Array<Record<string, any>> = [];
    socket.on("message", (data) => messages.push(readMessage(data.toString())));

    try {
      await waitFor(() => socket.readyState === socket.OPEN, "Connector socket to open");
      await settleWebSocket();
      const idempotencyKey = `handshake-command-${randomUUID()}`;
      const content = "Continue after the Connector handshake completes.";
      const queued = await sendCommand(
        aliceCookie,
        idempotencyKey,
        content,
      );
      expect(queued.statusCode, queued.body).toBe(202);
      const commandId = String(queued.json().command.id);
      await settleWebSocket();
      expect(messages).toHaveLength(0);

      socket.send(JSON.stringify({ type: "hello" }));
      await waitFor(
        () => messages.some((message) => message.type === "welcome") &&
          messages.some((message) => message.type === "session.command" && message.commandId === commandId),
        "welcome and queued command",
      );

      const stored = await database.admin.query<{ id: string; sequence: string }>(
        `SELECT id, sequence::text FROM connector_outbox
          WHERE workspace_id = $1 AND command_id = $2`,
        [identity.workspaceId, commandId],
      );
      const delivered = messages.filter((message) =>
        message.type === "session.command" && message.commandId === commandId);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        messageId: stored.rows[0]?.id,
        sequence: Number(stored.rows[0]?.sequence),
      });
      expect(messages.filter((message) => message.type === "welcome")).toHaveLength(1);

      socket.send(JSON.stringify({ type: "hello" }));
      await settleWebSocket();
      expect(messages.filter((message) => message.type === "welcome")).toHaveLength(1);
      expect(messages.filter((message) =>
        message.type === "session.command" && message.commandId === commandId)).toHaveLength(1);

      const replay = await sendCommand(aliceCookie, idempotencyKey, content);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json().replayed).toBe(true);
      await settleWebSocket();
      expect(messages.filter((message) =>
        message.type === "session.command" && message.commandId === commandId)).toHaveLength(1);
    } finally {
      socket.terminate();
    }
  });

  it("pushes a newly committed decision to an active Connector immediately", async () => {
    const socket = await app.injectWS("/connector/v1/ws", {
      headers: { authorization: `Bearer ${config.connectorToken}` },
    });
    const messages: Array<Record<string, any>> = [];
    socket.on("message", (data) => messages.push(readMessage(data.toString())));

    try {
      await settleWebSocket();
      socket.send(JSON.stringify({ type: "hello" }));
      await waitFor(() => messages.some((message) => message.type === "welcome"), "welcome message");

      const response = await decide(
        aliceCookie,
        `online-decision-${randomUUID()}`,
        { decision: "approve" },
      );
      expect(response.statusCode, response.body).toBe(200);
      await waitFor(
        () => messages.some((message) => message.type === "decision" && message.requestId === requestId),
        "online decision",
      );

      const stored = await database.admin.query<{ id: string; sequence: string }>(
        `SELECT id, sequence::text FROM connector_outbox
          WHERE workspace_id = $1 AND request_id = $2`,
        [identity.workspaceId, requestId],
      );
      const delivered = messages.filter((message) =>
        message.type === "decision" && message.requestId === requestId);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        messageId: stored.rows[0]?.id,
        decisionId: stored.rows[0]?.id,
        sequence: Number(stored.rows[0]?.sequence),
      });
    } finally {
      socket.terminate();
    }
  });
});

describe("ephemeral session image relay", () => {
  it("forwards verified Codex image frames in order without persisting image bytes", async () => {
    const relay = new SessionRelay(database.app, config.sessionSecret);
    const connector = fakeSocket();
    const user = fakeSocket();
    const image = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0x10, 0x00, 0x00, 0x00]),
      Buffer.from("WEBP", "ascii"),
      Buffer.from(`returned-image-sentinel-${randomUUID()}`, "utf8"),
    ]);
    const sha256 = createHash("sha256").update(image).digest("hex");
    const before = await database.admin.query(
      `SELECT
         (SELECT count(*)::int FROM connector_outbox) AS outbox,
         (SELECT count(*)::int FROM connector_inbox) AS inbox,
         (SELECT count(*)::int FROM audit_events) AS audit`,
    );
    relay.attachConnector(identity, connector.socket);
    await relay.attachUser(user.socket, "10000000-0000-4000-8000-000000000001");
    await relay.subscribeUser(user.socket, "10000000-0000-4000-8000-000000000001", sessionId);
    const subscribe = connector.messages.map(readMessage).find((message) =>
      message.type === "session.stream.subscribe");
    const subscriptionId = String(subscribe?.subscriptionId);
    const imageId = `returned-${randomUUID()}`;

    for (const frame of [
      { kind: "image.start", imageId, turnId: "turn-image", role: "assistant", mimeType: "image/webp", byteLength: image.length },
      { kind: "image.chunk", imageId, sequence: 0, data: image.toString("base64") },
      { kind: "image.complete", imageId, sha256 },
    ]) {
      expect(await relay.handleConnectorMessage(identity, {
        type: "session.stream.frame",
        subscriptionId,
        threadId: "thread-alpha-live",
        frame,
      })).toBe(true);
    }
    expect(user.messages.map(readMessage).filter((message) =>
      message.type === "session.stream.frame" && message.frame?.imageId === imageId)).toHaveLength(3);

    const after = await database.admin.query(
      `SELECT
         (SELECT count(*)::int FROM connector_outbox) AS outbox,
         (SELECT count(*)::int FROM connector_inbox) AS inbox,
         (SELECT count(*)::int FROM audit_events) AS audit`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    const databaseText = JSON.stringify(after.rows[0]);
    expect(databaseText).not.toContain(image.toString("base64"));
    expect(databaseText).not.toContain("returned-image-sentinel");

    const invalidImageId = `returned-invalid-${randomUUID()}`;
    await relay.handleConnectorMessage(identity, {
      type: "session.stream.frame",
      subscriptionId,
      threadId: "thread-alpha-live",
      frame: { kind: "image.start", imageId: invalidImageId, turnId: "turn-image", role: "assistant", mimeType: "image/webp", byteLength: image.length },
    });
    await expect(relay.handleConnectorMessage(identity, {
      type: "session.stream.frame",
      subscriptionId,
      threadId: "thread-alpha-live",
      frame: { kind: "image.chunk", imageId: invalidImageId, sequence: 1, data: image.toString("base64") },
    })).rejects.toThrow("out of order");
  });

  it("streams a verified image to the Connector, issues a restart-safe ticket, and queues metadata only", async () => {
    const relay = new SessionRelay(database.app, config.sessionSecret);
    const connector = fakeSocket();
    const user = fakeSocket();
    relay.attachConnector(identity, connector.socket);
    const uploadId = `upload-${randomUUID()}`;
    const attachmentId = `attachment-${randomUUID()}`;
    const image = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(`private-image-sentinel-${randomUUID()}`, "utf8"),
    ]);
    const sha256 = createHash("sha256").update(image).digest("hex");

    await relay.handleUserMessage(user.socket, "10000000-0000-4000-8000-000000000001", JSON.stringify({
      type: "session.attachment.begin",
      sessionId,
      uploadId,
      mimeType: "image/png",
      byteLength: image.length,
      sha256,
    }));
    const begin = connector.messages.map(readMessage).find((message) =>
      message.type === "session.attachment.begin" && message.uploadId === uploadId);
    expect(begin).toBeTruthy();
    const transferId = String(begin?.transferId);
    await relay.handleConnectorMessage(identity, {
      type: "session.attachment.status",
      transferId,
      uploadId,
      state: "accepted",
      nextOffset: 0,
    });

    await relay.handleUserMessage(user.socket, "10000000-0000-4000-8000-000000000001", JSON.stringify({
      type: "session.attachment.chunk",
      sessionId,
      uploadId,
      offset: 0,
      data: image.toString("base64"),
    }));
    await relay.handleConnectorMessage(identity, {
      type: "session.attachment.status",
      transferId,
      uploadId,
      state: "progress",
      nextOffset: image.length,
    });
    await relay.handleUserMessage(user.socket, "10000000-0000-4000-8000-000000000001", JSON.stringify({
      type: "session.attachment.complete",
      sessionId,
      uploadId,
    }));
    expect(connector.messages.map(readMessage).some((message) =>
      message.type === "session.attachment.complete" && message.transferId === transferId)).toBe(true);

    await relay.handleConnectorMessage(identity, {
      type: "session.attachment.status",
      transferId,
      uploadId,
      state: "ready",
      attachmentId,
    });
    const ready = user.messages.map(readMessage).findLast((message) =>
      message.type === "session.attachment.status" && message.state === "ready");
    expect(typeof ready?.ticket).toBe("string");

    const key = `image-message-${randomUUID()}`;
    const queued = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/commands`,
      headers: { cookie: aliceCookie, "idempotency-key": key },
      payload: { content: "", attachments: [{ ticket: ready?.ticket }] },
    });
    expect(queued.statusCode, queued.body).toBe(202);
    expect(queued.json().command).toMatchObject({ contentLength: 0, attachmentCount: 1 });

    const commandId = String(queued.json().command.id);
    const stored = await database.admin.query(
      `SELECT attachment.attachment_id, attachment.mime_type, attachment.byte_length,
              attachment.sha256, outbox.id AS message_id, outbox.sequence::text, outbox.payload
         FROM session_command_attachments attachment
         JOIN connector_outbox outbox
           ON outbox.workspace_id = attachment.workspace_id AND outbox.command_id = attachment.command_id
        WHERE attachment.workspace_id = $1 AND attachment.command_id = $2`,
      [identity.workspaceId, commandId],
    );
    expect(stored.rows[0]).toMatchObject({
      attachment_id: attachmentId,
      mime_type: "image/png",
      byte_length: image.length,
      sha256,
    });
    const persisted = JSON.stringify(stored.rows[0]);
    expect(persisted).not.toContain(image.toString("base64"));
    expect(persisted).not.toContain("private-image-sentinel");
    expect(persisted).not.toContain("/Users/");
    const privacyScan = await database.admin.query(
      `SELECT
         COALESCE((SELECT string_agg(payload::text, '') FROM connector_outbox
                    WHERE workspace_id = $1 AND command_id = $2::uuid), '') AS outbox,
         COALESCE((SELECT string_agg(metadata::text, '') FROM audit_events
                    WHERE workspace_id = $1 AND entity_id = $2::text), '') AS audit,
         COALESCE((SELECT string_agg(payload_type, '') FROM connector_inbox
                    WHERE workspace_id = $1), '') AS inbox`,
      [identity.workspaceId, commandId],
    );
    for (const value of Object.values(privacyScan.rows[0] as Record<string, string>)) {
      expect(value).not.toContain(image.toString("base64"));
      expect(value).not.toContain("private-image-sentinel");
    }

    const pending = await getPendingConnectorCommand(database.connector, identity, commandId);
    expect(pending).not.toBeNull();
    expect(relay.pushSessionCommand(identity, pending!)).toBe(true);
    const immediate = connector.messages.map(readMessage).findLast((message) =>
      message.type === "session.command" && message.commandId === commandId);
    expect(immediate).toMatchObject({
      messageId: stored.rows[0].message_id,
      sequence: Number(stored.rows[0].sequence),
      attachments: [{ attachmentId, mimeType: "image/png", byteLength: image.length, sha256 }],
    });

    const tampered = `${String(ready?.ticket).slice(0, -1)}x`;
    const rejected = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/commands`,
      headers: { cookie: aliceCookie, "idempotency-key": `tampered-${randomUUID()}` },
      payload: { content: "", attachments: [{ ticket: tampered }] },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe("invalid_attachment_ticket");
  });

  it("fails closed on forged types, chunk gaps, size limits, and cross-session ticket reuse", async () => {
    const relay = new SessionRelay(database.app, config.sessionSecret);
    const connector = fakeSocket();
    const user = fakeSocket();
    relay.attachConnector(identity, connector.socket);

    await expect(relay.handleUserMessage(user.socket, "10000000-0000-4000-8000-000000000001", JSON.stringify({
      type: "session.attachment.begin",
      sessionId,
      uploadId: `oversize-${randomUUID()}`,
      mimeType: "image/png",
      byteLength: 5 * 1024 * 1024 + 1,
      sha256: "a".repeat(64),
    }))).rejects.toThrow("Invalid attachment begin message");
    await expect(relay.handleUserMessage(user.socket, "10000000-0000-4000-8000-000000000001", JSON.stringify({
      type: "session.attachment.chunk",
      sessionId,
      uploadId: `large-chunk-${randomUUID()}`,
      offset: 0,
      data: Buffer.alloc(48 * 1024 + 1).toString("base64"),
    }))).rejects.toThrow("Invalid attachment chunk message");

    const uploadId = `gap-${randomUUID()}`;
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await relay.handleUserMessage(user.socket, "10000000-0000-4000-8000-000000000001", JSON.stringify({
      type: "session.attachment.begin",
      sessionId,
      uploadId,
      mimeType: "image/png",
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }));
    const begin = connector.messages.map(readMessage).find((message) => message.uploadId === uploadId);
    await relay.handleConnectorMessage(identity, {
      type: "session.attachment.status",
      transferId: begin?.transferId,
      uploadId,
      state: "accepted",
    });
    await relay.handleUserMessage(user.socket, "10000000-0000-4000-8000-000000000001", JSON.stringify({
      type: "session.attachment.chunk",
      sessionId,
      uploadId,
      offset: 1,
      data: bytes.toString("base64"),
    }));
    expect(user.messages.map(readMessage).findLast((message) => message.uploadId === uploadId)).toMatchObject({
      state: "failed",
      code: "chunk_out_of_order",
    });
    expect(connector.messages.map(readMessage).some((message) =>
      message.type === "session.attachment.cancel" && message.uploadId === uploadId)).toBe(true);

    const forgedUploadId = `forged-${randomUUID()}`;
    const forgedBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    await relay.handleUserMessage(user.socket, "10000000-0000-4000-8000-000000000001", JSON.stringify({
      type: "session.attachment.begin",
      sessionId,
      uploadId: forgedUploadId,
      mimeType: "image/png",
      byteLength: forgedBytes.length,
      sha256: createHash("sha256").update(forgedBytes).digest("hex"),
    }));
    const forgedBegin = connector.messages.map(readMessage).find((message) => message.uploadId === forgedUploadId);
    await relay.handleConnectorMessage(identity, {
      type: "session.attachment.status",
      transferId: forgedBegin?.transferId,
      uploadId: forgedUploadId,
      state: "accepted",
    });
    await relay.handleUserMessage(user.socket, "10000000-0000-4000-8000-000000000001", JSON.stringify({
      type: "session.attachment.chunk",
      sessionId,
      uploadId: forgedUploadId,
      offset: 0,
      data: forgedBytes.toString("base64"),
    }));
    await relay.handleUserMessage(user.socket, "10000000-0000-4000-8000-000000000001", JSON.stringify({
      type: "session.attachment.complete",
      sessionId,
      uploadId: forgedUploadId,
    }));
    expect(user.messages.map(readMessage).findLast((message) => message.uploadId === forgedUploadId)).toMatchObject({
      state: "failed",
      code: "invalid_image_type",
    });

    const foreignTicket = issueAttachmentTicket(config.sessionSecret, {
      userId: "10000000-0000-4000-8000-000000000001",
      sessionId,
      workspaceId: identity.workspaceId,
      workstationId: identity.workstationId,
      uploadId: `foreign-${randomUUID()}`,
      attachmentId: `foreign-attachment-${randomUUID()}`,
      mimeType: "image/webp",
      byteLength: 1,
      sha256: "b".repeat(64),
      expiresAt: Math.floor(Date.now() / 1_000) + 60,
    });
    const crossSession = await app.inject({
      method: "POST",
      url: "/api/sessions/40000000-0000-4000-8000-000000000002/commands",
      headers: { cookie: aliceCookie, "idempotency-key": `cross-session-${randomUUID()}` },
      payload: { content: "", attachments: [{ ticket: foreignTicket }] },
    });
    expect(crossSession.statusCode).toBe(403);
    expect(crossSession.json().error.code).toBe("attachment_ticket_scope_mismatch");

    const crossUser = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/commands`,
      headers: { cookie: bobCookie, "idempotency-key": `cross-user-${randomUUID()}` },
      payload: { content: "", attachments: [{ ticket: foreignTicket }] },
    });
    expect(crossUser.statusCode).toBe(403);
    expect(crossUser.json().error.code).toBe("attachment_ticket_scope_mismatch");

    const expiredTicket = issueAttachmentTicket(config.sessionSecret, {
      userId: "10000000-0000-4000-8000-000000000001",
      sessionId,
      workspaceId: identity.workspaceId,
      workstationId: identity.workstationId,
      uploadId: `expired-${randomUUID()}`,
      attachmentId: `expired-attachment-${randomUUID()}`,
      mimeType: "image/png",
      byteLength: 8,
      sha256: "c".repeat(64),
      expiresAt: Math.floor(Date.now() / 1_000) - 1,
    });
    const expired = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/commands`,
      headers: { cookie: aliceCookie, "idempotency-key": `expired-ticket-${randomUUID()}` },
      payload: { content: "", attachments: [{ ticket: expiredTicket }] },
    });
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error.code).toBe("attachment_ticket_expired");
  });

  it("enforces four-image and 12 MiB command boundaries using raw byte lengths", async () => {
    const tickets = (sizes: number[]) => sizes.map((byteLength, index) => ({
      ticket: issueAttachmentTicket(config.sessionSecret, {
        userId: "10000000-0000-4000-8000-000000000001",
        sessionId,
        workspaceId: identity.workspaceId,
        workstationId: identity.workstationId,
        uploadId: `boundary-upload-${index}-${randomUUID()}`,
        attachmentId: `boundary-attachment-${index}-${randomUUID()}`,
        mimeType: "image/jpeg",
        byteLength,
        sha256: createHash("sha256").update(`${index}:${byteLength}:${randomUUID()}`).digest("hex"),
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
      }),
    }));
    const exact = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/commands`,
      headers: { cookie: aliceCookie, "idempotency-key": `exact-boundary-${randomUUID()}` },
      payload: { content: "", attachments: tickets([3 * 1024 * 1024, 3 * 1024 * 1024, 3 * 1024 * 1024, 3 * 1024 * 1024]) },
    });
    expect(exact.statusCode, exact.body).toBe(202);

    const tooMany = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/commands`,
      headers: { cookie: aliceCookie, "idempotency-key": `too-many-${randomUUID()}` },
      payload: { content: "", attachments: tickets([1, 1, 1, 1, 1]) },
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error.code).toBe("invalid_attachments");

    const tooLarge = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/commands`,
      headers: { cookie: aliceCookie, "idempotency-key": `too-large-${randomUUID()}` },
      payload: { content: "", attachments: tickets([3 * 1024 * 1024 + 1, 3 * 1024 * 1024, 3 * 1024 * 1024, 3 * 1024 * 1024]) },
    });
    expect(tooLarge.statusCode).toBe(400);
    expect(tooLarge.json().error.code).toBe("attachments_too_large");
  });

  it("rechecks response authorization before forwarding every upload chunk", async () => {
    const relay = new SessionRelay(database.app, config.sessionSecret);
    const connector = fakeSocket();
    const user = fakeSocket();
    const uploadId = `revoked-${randomUUID()}`;
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    relay.attachConnector(identity, connector.socket);
    await relay.handleUserMessage(user.socket, "10000000-0000-4000-8000-000000000002", JSON.stringify({
      type: "session.attachment.begin",
      sessionId,
      uploadId,
      mimeType: "image/jpeg",
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }));
    const begin = connector.messages.map(readMessage).find((message) => message.uploadId === uploadId);
    await relay.handleConnectorMessage(identity, {
      type: "session.attachment.status",
      transferId: begin?.transferId,
      uploadId,
      state: "accepted",
    });
    await database.admin.query(
      `UPDATE workstation_access SET can_respond = false
        WHERE workspace_id = $1 AND workstation_id = $2
          AND user_id = '10000000-0000-4000-8000-000000000002'`,
      [identity.workspaceId, identity.workstationId],
    );
    try {
      await relay.handleUserMessage(user.socket, "10000000-0000-4000-8000-000000000002", JSON.stringify({
        type: "session.attachment.chunk",
        sessionId,
        uploadId,
        offset: 0,
        data: bytes.toString("base64"),
      }));
      expect(user.messages.map(readMessage).findLast((message) => message.uploadId === uploadId)).toMatchObject({
        state: "failed",
        code: "permission_denied",
      });
      expect(connector.messages.map(readMessage).some((message) =>
        message.type === "session.attachment.chunk" && message.uploadId === uploadId)).toBe(false);
    } finally {
      await database.admin.query(
        `UPDATE workstation_access SET can_respond = true
          WHERE workspace_id = $1 AND workstation_id = $2
            AND user_id = '10000000-0000-4000-8000-000000000002'`,
        [identity.workspaceId, identity.workstationId],
      );
    }
  });
});

describe("ephemeral Codex conversation relay", () => {
  it("authorizes, isolates and re-establishes an in-memory session stream without database writes", async () => {
    const relay = new SessionRelay(database.app);
    const connector = fakeSocket();
    const alice = fakeSocket();
    const unauthorized = fakeSocket();
    const before = await database.admin.query(
      `SELECT
         (SELECT count(*)::int FROM connector_outbox) AS outbox,
         (SELECT count(*)::int FROM connector_inbox) AS inbox,
         (SELECT count(*)::int FROM audit_events) AS audit`,
    );
    relay.attachConnector(identity, connector.socket);
    await relay.attachUser(alice.socket, "10000000-0000-4000-8000-000000000001");
    await relay.attachUser(unauthorized.socket, randomUUID());
    expect(await relay.handleConnectorMessage(identity, {
      type: "session.titles.snapshot",
      titles: [{ threadId: "thread-alpha-live", title: "创建私人仓库并提交项目" }],
    })).toBe(true);
    expect(alice.messages.at(-1)).toContain(`"sessionId":"${sessionId}"`);
    expect(alice.messages.at(-1)).toContain("创建私人仓库并提交项目");
    expect(unauthorized.messages.join("\n")).not.toContain("创建私人仓库并提交项目");
    expect(await relay.handleConnectorMessage({ ...identity, workstationId: randomUUID() }, {
      type: "session.titles.snapshot",
      titles: [{ threadId: "thread-alpha-live", title: "错误工作站标题" }],
    })).toBe(true);
    expect(alice.messages.at(-1)).not.toContain("错误工作站标题");
    await relay.subscribeUser(alice.socket, "10000000-0000-4000-8000-000000000001", sessionId);

    const subscribe = connector.messages
      .map((value) => JSON.parse(value) as Record<string, unknown>)
      .find((value) => value.type === "session.stream.subscribe");
    expect(subscribe).toBeTruthy();
    const subscriptionId = String(subscribe?.subscriptionId);
    expect(await relay.handleConnectorMessage(identity, {
      type: "session.stream.frame",
      subscriptionId,
      threadId: "thread-alpha-live",
      frame: { kind: "message.delta", messageId: "agent-message", delta: "只经过内存的回复" },
    })).toBe(true);
    expect(alice.messages.some((value) => value.includes("只经过内存的回复"))).toBe(true);
    expect(connector.messages.some((value) => value.includes('"type":"ack"'))).toBe(false);

    expect(await relay.handleConnectorMessage(identity, {
      type: "session.stream.frame",
      subscriptionId,
      threadId: "thread-alpha-live",
      frame: { kind: "activity.upsert", activityId: "command-one", turnId: "turn-one", activity: "command", label: "读取 main.mjs", status: "in_progress" },
    })).toBe(true);
    expect(alice.messages.some((value) => value.includes("读取 main.mjs"))).toBe(true);

    const aliceCount = alice.messages.length;
    await relay.handleConnectorMessage({ ...identity, workstationId: randomUUID() }, {
      type: "session.stream.frame",
      subscriptionId,
      threadId: "thread-alpha-live",
      frame: { kind: "message.delta", messageId: "agent-message", delta: "错误工作站" },
    });
    expect(alice.messages).toHaveLength(aliceCount);

    const connectorCount = connector.messages.length;
    await relay.subscribeUser(unauthorized.socket, randomUUID(), sessionId);
    expect(unauthorized.messages.at(-1)).toContain('"state":"denied"');
    expect(unauthorized.messages.join("\n")).not.toContain("thread-alpha-live");
    expect(connector.messages).toHaveLength(connectorCount);

    relay.detachConnector(identity, connector.socket);
    expect(alice.messages.at(-1)).toContain('"state":"connector_offline"');
    const reconnected = fakeSocket();
    relay.attachConnector(identity, reconnected.socket);
    expect(alice.messages.at(-1)).toContain('"state":"loading"');
    expect(reconnected.messages.some((value) => value.includes(subscriptionId))).toBe(true);

    const after = await database.admin.query(
      `SELECT
         (SELECT count(*)::int FROM connector_outbox) AS outbox,
         (SELECT count(*)::int FROM connector_inbox) AS inbox,
         (SELECT count(*)::int FROM audit_events) AS audit`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("rejects non-canonical or oversized ephemeral session titles", async () => {
    const relay = new SessionRelay(database.app);
    await expect(relay.handleConnectorMessage(identity, {
      type: "session.titles.snapshot",
      titles: [{ threadId: "thread-alpha-live", title: "unsafe\u202etitle" }],
    })).rejects.toThrow("Invalid Connector session title");
    await expect(relay.handleConnectorMessage(identity, {
      type: "session.titles.snapshot",
      titles: Array.from({ length: 201 }, (_, index) => ({ threadId: `thread-${index}`, title: "title" })),
    })).rejects.toThrow("Invalid Connector session title snapshot");
    await expect(relay.handleConnectorMessage(identity, {
      type: "session.stream.frame",
      subscriptionId: "subscription-one",
      threadId: "thread-alpha-live",
      frame: { kind: "activity.upsert", activityId: "activity-one", turnId: "turn-one", activity: "command", label: "unsafe\u202elabel", status: "completed" },
    })).rejects.toThrow("Invalid Connector session stream frame");
  });
});

describe("connector reliability", () => {
  it("persists opaque project identity and Codex timestamps from session discovery", async () => {
    const messageId = randomUUID();
    const threadId = `thread-project-${randomUUID()}`;
    const projectKey = "4e07408562bedb8b60ce05c1decfe3ad16b722309fbd10f22172fc5e4aa96713";
    const startedAt = "2026-08-07T03:04:05.000Z";
    const updatedAt = "2026-08-09T11:12:13.000Z";
    try {
      await processConnectorEnvelope(database.connector, identity, makeEnvelope(messageId, 499, {
        type: "session.upsert",
        threadId,
        turnId: "turn-project-latest",
        projectKey,
        projectName: "trace-agent",
        projectPath: "~/lws/upgrade/trace",
        model: "gpt-5.6-codex",
        status: "waiting",
        initiatedByEmail: "alice@yurupager.local",
        startedAt,
        updatedAt,
      }));

      const stored = await database.admin.query<{
        project_key: string;
        project_name: string;
        project_path_hint: string;
        started_at: Date;
        updated_at: Date;
      }>(
        `SELECT project_key, project_name, project_path_hint, started_at, updated_at
           FROM agent_sessions
          WHERE workspace_id = $1 AND workstation_id = $2 AND thread_id = $3`,
        [identity.workspaceId, identity.workstationId, threadId],
      );
      expect(stored.rows[0]?.project_key).toBe(projectKey);
      expect(stored.rows[0]?.project_name).toBe("trace-agent");
      expect(stored.rows[0]?.project_path_hint).toBe("~/lws/upgrade/trace");
      expect(stored.rows[0]?.started_at.toISOString()).toBe(startedAt);
      expect(stored.rows[0]?.updated_at.toISOString()).toBe(updatedAt);
    } finally {
      await database.admin.query(
        "DELETE FROM agent_sessions WHERE workspace_id = $1 AND workstation_id = $2 AND thread_id = $3",
        [identity.workspaceId, identity.workstationId, threadId],
      );
      await database.admin.query(
        "DELETE FROM connector_inbox WHERE workspace_id = $1 AND workstation_id = $2 AND message_id = $3",
        [identity.workspaceId, identity.workstationId, messageId],
      );
    }
  });

  it("reconciles a connector inventory without deleting old sessions", async () => {
    const messageId = randomUUID();
    const threadId = `thread-inventory-${randomUUID()}`;
    const upsert: ConnectorPayload = {
      type: "session.upsert",
      threadId,
      projectKey: "inventory-project",
      projectName: "inventory-project",
      projectPath: "~/inventory-project",
      model: "gpt-5.6-codex",
      status: "completed",
      syncState: "historical",
      startedAt: "2026-08-09T11:12:13.000Z",
      updatedAt: "2026-08-09T11:12:13.000Z",
    };
    const inventory: ConnectorPayload = {
      type: "session.inventory",
      inventoryId: randomUUID(),
      threadIds: [],
    };
    const inventoryMessageId = randomUUID();
    try {
      await processConnectorEnvelope(database.connector, identity, makeEnvelope(messageId, 498, upsert));
      await processConnectorEnvelope(database.connector, identity, makeEnvelope(inventoryMessageId, 499, inventory));
      const stored = await database.admin.query<{ sync_state: string }>(
        "SELECT sync_state FROM agent_sessions WHERE workspace_id = $1 AND workstation_id = $2 AND thread_id = $3",
        [identity.workspaceId, identity.workstationId, threadId],
      );
      expect(stored.rows[0]?.sync_state).toBe("stale");
      const visible = await database.admin.query<{ id: string }>(
        "SELECT id FROM agent_sessions WHERE workspace_id = $1 AND workstation_id = $2 AND thread_id = $3 AND sync_state <> 'stale'",
        [identity.workspaceId, identity.workstationId, threadId],
      );
      expect(visible.rows).toHaveLength(0);
    } finally {
      await database.admin.query(
        "DELETE FROM agent_sessions WHERE workspace_id = $1 AND workstation_id = $2 AND thread_id = $3",
        [identity.workspaceId, identity.workstationId, threadId],
      );
      await database.admin.query(
        "DELETE FROM connector_inbox WHERE workspace_id = $1 AND workstation_id = $2 AND message_id IN ($3, $4)",
        [identity.workspaceId, identity.workstationId, messageId, inventoryMessageId],
      );
    }
  });

  it("deduplicates token snapshots and replaces cumulative rollups", async () => {
    const messageId = randomUUID();
    const eventId = `integration-usage-${randomUUID()}`;
    const payload: ConnectorPayload = {
      type: "token.snapshot",
      eventId,
      sequence: 501,
      threadId: "thread-alpha-live",
      turnId: "turn-alpha-7",
      model: "gpt-5.6-codex",
      inputTokens: 220_000,
      cachedInputTokens: 140_000,
      outputTokens: 25_000,
      reasoningTokens: 10_000,
      totalTokens: 245_000,
      quality: "provisional",
      observedAt: new Date().toISOString(),
    };
    const envelope = makeEnvelope(messageId, 501, payload);
    expect((await processConnectorEnvelope(database.connector, identity, envelope)).duplicate).toBe(false);
    expect((await processConnectorEnvelope(database.connector, identity, envelope)).duplicate).toBe(true);
    const rows = await database.admin.query(
      "SELECT count(*)::int AS count FROM token_usage_snapshots WHERE workspace_id = $1 AND workstation_id = $2 AND event_id = $3",
      [identity.workspaceId, identity.workstationId, eventId],
    );
    expect(rows.rows[0].count).toBe(1);
    const rollup = await database.admin.query(
      "SELECT total_tokens::int, estimated_cost_micros::int, price_version FROM token_usage_rollups WHERE workspace_id = $1 AND session_id = '40000000-0000-4000-8000-000000000001' AND model = 'gpt-5.6-codex'",
      [identity.workspaceId],
    );
    expect(rollup.rows[0].total_tokens).toBe(245_000);
    expect(rollup.rows[0].estimated_cost_micros).toBe(322_500);
    expect(rollup.rows[0].price_version).toBe("alpha-2026-08-01");

    await processConnectorEnvelope(database.connector, identity, makeEnvelope(randomUUID(), 502, {
      type: "turn.completed",
      threadId: "thread-alpha-live",
      turnId: "turn-alpha-7",
      status: "completed",
    }));
    const calibrated = await database.admin.query(
      "SELECT quality FROM token_usage_rollups WHERE workspace_id = $1 AND session_id = '40000000-0000-4000-8000-000000000001' AND model = 'gpt-5.6-codex'",
      [identity.workspaceId],
    );
    expect(calibrated.rows[0].quality).toBe("final");
  });

  it("stores the owning agent and honours carried pricing provider", async () => {
    const threadId = `thread-agent-${randomUUID().slice(0, 8)}`;
    await processConnectorEnvelope(database.connector, identity, makeEnvelope(randomUUID(), 700, {
      type: "session.upsert",
      threadId,
      agent: "gemini",
      sessionId: threadId,
      projectKey: "agent-neutral-key",
      projectName: "Agent Neutral",
      projectPath: "~/agent-neutral",
      model: "gemini-test-model",
      status: "running",
      syncState: "live",
    }));
    const stored = await database.admin.query(
      "SELECT agent FROM agent_sessions WHERE workspace_id = $1 AND workstation_id = $2 AND thread_id = $3",
      [identity.workspaceId, identity.workstationId, threadId],
    );
    expect(stored.rows[0]?.agent).toBe("gemini");

    const eventId = `agent-usage-${randomUUID()}`;
    await processConnectorEnvelope(database.connector, identity, makeEnvelope(randomUUID(), 701, {
      type: "token.snapshot",
      eventId,
      sequence: 1,
      threadId,
      agent: "gemini",
      sessionId: threadId,
      turnId: "turn-agent-1",
      provider: "google",
      model: "gemini-test-model",
      inputTokens: 1_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 1_000,
      quality: "provisional",
      observedAt: new Date().toISOString(),
    }));
    const rollup = await database.admin.query(
      `SELECT provider FROM token_usage_rollups
        WHERE workspace_id = $1
          AND session_id = (SELECT id FROM agent_sessions
                             WHERE workspace_id = $1 AND workstation_id = $2 AND thread_id = $3)
          AND model = 'gemini-test-model'`,
      [identity.workspaceId, identity.workstationId, threadId],
    );
    expect(rollup.rows[0]?.provider).toBe("google");

    // The codex inventory must not mark another agent's live sessions stale.
    await processConnectorEnvelope(database.connector, identity, makeEnvelope(randomUUID(), 702, {
      type: "session.inventory",
      inventoryId: randomUUID(),
      threadIds: ["unrelated-thread"],
    }));
    const refreshed = await database.admin.query(
      "SELECT sync_state FROM agent_sessions WHERE workspace_id = $1 AND workstation_id = $2 AND thread_id = $3",
      [identity.workspaceId, identity.workstationId, threadId],
    );
    expect(refreshed.rows[0]?.sync_state).toBe("live");
  });

  it("turn interruption cancels the old pending approval", async () => {
    const envelope = makeEnvelope(randomUUID(), 601, {
      type: "turn.completed",
      threadId: "thread-alpha-tests",
      turnId: "turn-alpha-2",
      status: "interrupted",
    });
    await processConnectorEnvelope(database.connector, identity, envelope);
    const result = await database.admin.query(
      "SELECT status FROM agent_requests WHERE workspace_id = $1 AND id = $2",
      [identity.workspaceId, questionRequestId],
    );
    expect(result.rows[0].status).toBe("interrupted");
  });

  it("sent_unknown blocks server outbox replay", async () => {
    await decide(aliceCookie, `unknown-${randomUUID()}`, { decision: "approve" });
    const envelope = makeEnvelope(randomUUID(), 701, {
      type: "delivery.updated",
      requestId,
      deliveryStatus: "sent_unknown",
    });
    await processConnectorEnvelope(database.connector, identity, envelope);
    const pending = await getPendingConnectorDecisions(database.connector, identity);
    expect(pending.some((message) => message.requestId === requestId)).toBe(false);
    const result = await database.admin.query(
      "SELECT delivery_status FROM agent_requests WHERE workspace_id = $1 AND id = $2",
      [identity.workspaceId, requestId],
    );
    expect(result.rows[0].delivery_status).toBe("sent_unknown");
  });
});

async function login(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: "alpha-demo" },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.headers["set-cookie"];
  if (typeof cookie !== "string") throw new Error("Login did not return a session cookie");
  return cookie.split(";")[0] ?? "";
}

function registerPush(cookie: string, endpoint: string) {
  return app.inject({
    method: "POST",
    url: "/api/push/subscriptions",
    headers: { cookie },
    payload: {
      endpoint,
      expirationTime: null,
      keys: { p256dh: "D".repeat(87), auth: "E".repeat(22) },
    },
  });
}

function unregisterPush(cookie: string, endpoint: string) {
  return app.inject({
    method: "DELETE",
    url: "/api/push/subscriptions",
    headers: { cookie },
    payload: { endpoint },
  });
}

async function visiblePushEndpoints(userId: string): Promise<string[]> {
  return withUserTransaction(database.app, userId, null, async (client) => {
    const result = await client.query<{ endpoint: string }>(
      "SELECT endpoint FROM push_subscriptions ORDER BY endpoint",
    );
    return result.rows.map((row) => row.endpoint);
  });
}

async function createPushRequest(sequence: number): Promise<{ requestId: string; messageId: string }> {
  const requestId = randomUUID();
  const messageId = randomUUID();
  const socket = await app.injectWS("/connector/v1/ws", {
    headers: { authorization: `Bearer ${config.connectorToken}` },
  });
  const connectorMessages: Array<Record<string, unknown>> = [];
  socket.on("message", (data) => connectorMessages.push(JSON.parse(data.toString()) as Record<string, unknown>));
  const initialCalls = pushCalls.length;
  try {
    await waitFor(() => socket.readyState === socket.OPEN, "provider test Connector socket to open");
    await settleWebSocket();
    socket.send(JSON.stringify({ type: "hello" }));
    await waitFor(() => connectorMessages.some((message) => message.type === "welcome"), "provider test Connector welcome");
    socket.send(JSON.stringify(makeEnvelope(messageId, sequence, {
      type: "request.created",
      requestId,
      threadId: "thread-alpha-live",
      turnId: `turn-push-provider-${randomUUID()}`,
      itemId: `item-push-provider-${randomUUID()}`,
      kind: "approval",
      category: "command",
      tool: "shell",
      risk: "medium",
      context: { command: "npm test", cwd: "~/project", reason: "provider failure test" },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    })));
    await waitFor(() => connectorMessages.some((message) => message.type === "ack" && message.messageId === messageId), "provider test request ACK");
    await waitFor(() => pushCalls.length === initialCalls + 1, "provider push attempt");
    return { requestId, messageId };
  } finally {
    socket.terminate();
  }
}

async function deletePushRequest(value: { requestId: string; messageId: string }): Promise<void> {
  await database.admin.query(
    "DELETE FROM agent_requests WHERE workspace_id = $1 AND id = $2",
    [identity.workspaceId, value.requestId],
  );
  await database.admin.query(
    "DELETE FROM connector_inbox WHERE workspace_id = $1 AND message_id = $2",
    [identity.workspaceId, value.messageId],
  );
}

async function pushSubscriptionCount(endpoint: string): Promise<number> {
  const result = await database.admin.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM push_subscriptions WHERE endpoint = $1",
    [endpoint],
  );
  return result.rows[0]?.count ?? 0;
}

async function pushFailureCount(endpoint: string): Promise<number> {
  const result = await database.admin.query<{ failure_count: number }>(
    "SELECT failure_count FROM push_subscriptions WHERE endpoint = $1",
    [endpoint],
  );
  return result.rows[0]?.failure_count ?? 0;
}

function decide(
  cookie: string,
  key: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/api/requests/${requestId}/decision`,
    headers: { cookie, "idempotency-key": key },
    payload,
  });
}

function sendCommand(cookie: string, key: string, content: string) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/commands`,
    headers: { cookie, "idempotency-key": key },
    payload: { content },
  });
}

function createTestPairing(cookie: string) {
  return app.inject({
    method: "POST",
    url: "/api/workstation-pairings",
    headers: { cookie, "idempotency-key": `pair-${randomUUID()}` },
    payload: { workspaceId: identity.workspaceId },
  });
}

function claimTestPairing(pairCode: string, claimSecret: string, publicKey: string) {
  return app.inject({
    method: "POST",
    url: "/api/connector/pairings/claim",
    payload: {
      pairCode,
      claimSecret,
      deviceName: "Integration workstation",
      platform: "test 1 / arm64",
      connectorVersion: "0.2.0-alpha",
      publicKey,
    },
  });
}

function resultTestPairing(pairCode: string, claimSecret: string) {
  return app.inject({
    method: "POST",
    url: "/api/connector/pairings/result",
    payload: { pairCode, claimSecret },
  });
}

function approveTestPairing(cookie: string, pairingId: string, workstationName: string) {
  return app.inject({
    method: "POST",
    url: `/api/workstation-pairings/${pairingId}/approve`,
    headers: { cookie },
    payload: { workstationName },
  });
}

function makeEnvelope(
  messageId: string,
  sequence: number,
  payload: ConnectorPayload,
): TransportEnvelope<ConnectorPayload> {
  return {
    type: "event",
    protocolVersion: 1,
    messageId,
    streamId: "integration-stream",
    connectionEpoch: `integration-epoch-${messageId}`,
    sequence,
    timestamp: new Date().toISOString(),
    idempotencyKey: `integration:${messageId}`,
    payload,
  };
}

function fakeSocket(): { socket: WebSocket; messages: string[] } {
  const messages: string[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send(value: string) { messages.push(value); },
  } as unknown as WebSocket;
  return { socket, messages };
}

function readMessage(value: string): Record<string, any> {
  return JSON.parse(value) as Record<string, any>;
}

async function settleWebSocket(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not reserve a preview port");
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return address.port;
}

async function listenHttpServer(server: ReturnType<typeof createServer>, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not start the local preview fixture");
  return address.port;
}

async function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

async function waitForWebSocketOpen(socket: ClientWebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function waitForWebSocketMessage(socket: ClientWebSocket): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    socket.once("message", (data) => resolve(data.toString()));
    socket.once("error", reject);
  });
}

async function waitForWebSocketFailure(socket: ClientWebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket rejection")), 2_000);
    const failed = () => {
      clearTimeout(timeout);
      socket.terminate();
      resolve();
    };
    socket.once("open", () => {
      clearTimeout(timeout);
      socket.close();
      reject(new Error("WebSocket unexpectedly opened"));
    });
    socket.once("error", failed);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      failed();
    });
  });
}

interface GatewayRequestOptions {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

function gatewayRequest(
  port: number,
  options: GatewayRequestOptions,
): Promise<{ statusCode: number; headers: typeof import("node:http").IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method: options.method,
      path: options.path,
      headers: { host: `preview.localhost:${port}`, ...options.headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

async function waitFor(condition: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
