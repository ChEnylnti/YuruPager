import { access, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

import type { DecisionInput, PushSubscriptionInput, SessionCommandAttachmentInput, WorkspaceKind, WorkspaceRole } from "@yurupager/shared";

import {
  assertBrowserMutationOrigin,
  authenticateRequest,
  browserOriginAllowed,
  loginLocal,
  logout,
} from "./auth.js";
import type { Config } from "./config.js";
import { registerConnectorRoute } from "./connector.js";
import {
  cancelWorkflowRun,
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflowRuns,
  listWorkflows,
  runWorkflow,
  updateWorkflow,
  type WorkflowNodeInput,
} from "./workflow-repository.js";
import {
  getPendingConnectorCommand,
  getPendingConnectorDecision,
} from "./connector-repository.js";
import type { Database } from "./database.js";
import { HttpError } from "./errors.js";
import {
  approvePairing,
  cancelPairing,
  claimPairing,
  createPairing,
  getConnectorPairingResult,
  listPairings,
} from "./pairing-repository.js";
import { decideRequest, getSnapshot, sendSessionCommand } from "./repository.js";
import {
  createWorkspace,
  createWorkspaceInvite,
  joinWorkspaceInvite,
  removeMember,
  revokeWorkstation,
  updateMemberRole,
  updateWorkstationAccess,
} from "./management-repository.js";
import { SessionRelay } from "./session-relay.js";
import { registerPreviewConnectorRoute } from "./preview-connector.js";
import { PreviewGateway } from "./preview-gateway.js";
import { PreviewRelay } from "./preview-relay.js";
import { PushService, type PushTransport } from "./push-service.js";

export interface AppOptions {
  config: Config;
  database: Database;
  logger?: boolean;
  serveWeb?: boolean;
  pushTransport?: PushTransport;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { config, database } = options;
  const app = Fastify({ logger: options.logger ?? true, trustProxy: true });
  const liveSockets = new Set<WebSocket>();
  const sessionRelay = new SessionRelay(database.app, config.sessionSecret);
  const pushService = new PushService(database.connector, config, options.pushTransport);
  const invalidateWorkspace = (workspaceId: string) => {
    broadcast(liveSockets, { type: "snapshot.invalidated", workspaceId });
  };
  const previewRelay = new PreviewRelay({
    appPool: database.app,
    connectorPool: database.connector,
    config,
    onChanged: invalidateWorkspace,
  });
  const previewGateway = new PreviewGateway({
    enabled: config.previewEnabled,
    host: config.previewGatewayHost,
    port: config.previewGatewayPort,
    secureCookie: config.previewPublicOrigin?.startsWith("https://") === true,
    relay: previewRelay,
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: config.webOrigin,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  app.addHook("preHandler", async (request) => {
    if (request.url.startsWith("/api/") && !request.url.startsWith("/api/connector/")) {
      assertBrowserMutationOrigin(request, config);
    }
  });
  registerConnectorRoute(app, database, config, invalidateWorkspace, sessionRelay, pushService);

  type WorkflowBody = {
    workspaceId?: unknown;
    workstationId?: unknown;
    name?: unknown;
    goal?: unknown;
    nodes?: unknown;
  };

  app.post<{ Body: WorkflowBody }>("/api/workflows", async (request) => {
    const auth = await authenticateRequest(request, database.app, config);
    const body = readObject(request.body);
    const workspaceId = String(body.workspaceId ?? "");
    const workstationId = String(body.workstationId ?? "");
    const name = String(body.name ?? "");
    const goal = String(body.goal ?? "");
    const nodes = Array.isArray(body.nodes) ? body.nodes as never[] : [];
    const result = await createWorkflow(database.app, auth.user.id, workspaceId, {
      name, goal, workstationId,
      nodes: nodes as WorkflowNodeInput[],
    });
    invalidateWorkspace(workspaceId);
    return result;
  });

  app.get<{ Querystring: { workspaceId?: string } }>("/api/workflows", async (request) => {
    const auth = await authenticateRequest(request, database.app, config);
    const workspaceId = String((request.query as { workspaceId?: string }).workspaceId ?? "");
    return listWorkflows(database.app, auth.user.id, workspaceId);
  });

  app.get<{ Params: { workflowId: string }; Querystring: { workspaceId?: string } }>(
    "/api/workflows/:workflowId",
    async (request) => {
      const auth = await authenticateRequest(request, database.app, config);
      const workspaceId = String((request.query as { workspaceId?: string }).workspaceId ?? "");
      return getWorkflow(database.app, auth.user.id, workspaceId, request.params.workflowId);
    },
  );

  app.put<{ Params: { workflowId: string }; Body: WorkflowBody }>(
    "/api/workflows/:workflowId",
    async (request) => {
      const auth = await authenticateRequest(request, database.app, config);
      const body = readObject(request.body);
      const workspaceId = String(body.workspaceId ?? "");
      const workstationId = String(body.workstationId ?? "");
      const name = String(body.name ?? "");
      const goal = String(body.goal ?? "");
      const nodes = Array.isArray(body.nodes) ? body.nodes as never[] : [];
      const result = await updateWorkflow(database.app, auth.user.id, workspaceId, request.params.workflowId, {
        name, goal, workstationId,
        nodes: nodes as WorkflowNodeInput[],
      });
      invalidateWorkspace(workspaceId);
      return result;
    },
  );

  app.delete<{ Params: { workflowId: string }; Querystring: { workspaceId?: string } }>(
    "/api/workflows/:workflowId",
    async (request, reply) => {
      const auth = await authenticateRequest(request, database.app, config);
      const workspaceId = String((request.query as { workspaceId?: string }).workspaceId ?? "");
      await deleteWorkflow(database.app, auth.user.id, workspaceId, request.params.workflowId);
      invalidateWorkspace(workspaceId);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { workflowId: string }; Body: WorkflowBody }>(
    "/api/workflows/:workflowId/run",
    async (request) => {
      const auth = await authenticateRequest(request, database.app, config);
      const body = readObject(request.body);
      const workspaceId = String(body.workspaceId ?? "");
      const outcome = await runWorkflow(database.app, auth.user.id, workspaceId, request.params.workflowId);
      sessionRelay.pushWorkflowDispatch(
        { workspaceId, workstationId: outcome.run.workstationId },
        { runId: outcome.dispatch.runId, definition: outcome.dispatch.definition, messageId: randomUUID(), sequence: 0 },
      );
      invalidateWorkspace(workspaceId);
      return outcome.run;
    },
  );

  app.post<{ Params: { runId: string }; Body: WorkflowBody }>(
    "/api/workflow-runs/:runId/cancel",
    async (request) => {
      const auth = await authenticateRequest(request, database.app, config);
      const body = readObject(request.body);
      const workspaceId = String(body.workspaceId ?? "");
      const outcome = await cancelWorkflowRun(database.app, auth.user.id, workspaceId, request.params.runId);
      sessionRelay.pushWorkflowCancel(
        { workspaceId, workstationId: outcome.run.workstationId },
        { runId: outcome.dispatch.runId, reason: "user_cancelled", messageId: randomUUID(), sequence: 0 },
      );
      invalidateWorkspace(workspaceId);
      return outcome.run;
    },
  );

  app.get<{ Params: { workflowId: string }; Querystring: { workspaceId?: string } }>(
    "/api/workflows/:workflowId/runs",
    async (request) => {
      const auth = await authenticateRequest(request, database.app, config);
      const workspaceId = String((request.query as { workspaceId?: string }).workspaceId ?? "");
      return listWorkflowRuns(database.app, auth.user.id, workspaceId, request.params.workflowId);
    },
  );
  registerPreviewConnectorRoute(app, database, config, previewRelay);
  app.addHook("onReady", async () => previewGateway.start());
  app.addHook("onClose", async () => previewGateway.stop());
  app.addHook("onClose", async () => pushService.drain());

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      void reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    app.log.error(error);
    void reply.status(500).send({
      error: { code: "internal_error", message: "The server could not complete the request" },
    });
  });

  app.get("/api/health", async () => {
    await database.app.query("SELECT 1");
    return { status: "ok", time: new Date().toISOString() };
  });

  app.get("/api/connector/install.sh", async (_request, reply) => {
    const script = await readFile(resolve(process.cwd(), "scripts/install-connector.sh"), "utf8");
    return reply.type("text/x-shellscript; charset=utf-8").send(script);
  });

  app.get("/api/connector/package.tgz", async (_request, reply) => {
    const archive = await readFile(resolve(process.cwd(), config.connectorPackagePath));
    return reply
      .header("Content-Disposition", "attachment; filename=yurupager-connector.tgz")
      .type("application/gzip")
      .send(archive);
  });

  app.get("/api/connector/package.sha256", async (_request, reply) => {
    const archive = await readFile(resolve(process.cwd(), config.connectorPackagePath));
    return reply
      .type("text/plain; charset=utf-8")
      .send(`${createHash("sha256").update(archive).digest("hex")}\n`);
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = readObject(request.body);
    const email = readString(body, "email");
    const password = readString(body, "password");
    const user = await loginLocal(database.app, config, email, password, reply);
    return { user, authMode: config.authMode };
  });

  app.get("/api/auth/me", async (request) => {
    const auth = await authenticateRequest(request, database.app, config);
    return { user: auth.user, authMode: config.authMode };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await logout(request, reply, database.app, config);
    return reply.status(204).send();
  });

  app.get("/api/push/config", async (request, reply) => {
    await authenticateRequest(request, database.app, config);
    return reply.header("Cache-Control", "no-store").send(pushService.capability());
  });

  app.post("/api/push/subscriptions", async (request, reply) => {
    const auth = await authenticateRequest(request, database.app, config);
    const result = await pushService.register(auth.user.id, readPushSubscription(request.body));
    return reply.status(result.created ? 201 : 200).send({ subscribed: true });
  });

  app.delete("/api/push/subscriptions", async (request, reply) => {
    const auth = await authenticateRequest(request, database.app, config);
    const body = readObject(request.body);
    await pushService.unregister(auth.user.id, readString(body, "endpoint"));
    return reply.status(204).send();
  });

  app.get("/api/snapshot", async (request) => {
    const auth = await authenticateRequest(request, database.app, config);
    const query = readObject(request.query);
    const workspaceId = optionalString(query, "workspaceId") ?? null;
    return getSnapshot(database.app, auth.user.id, workspaceId, {
      enabled: config.previewEnabled,
      gatewayOrigin: config.previewPublicOrigin,
      command: "yurupager preview <port>",
    });
  });

  app.post("/api/workspaces", async (request, reply) => {
    const auth = await authenticateRequest(request, database.app, config);
    const body = readObject(request.body);
    const result = await createWorkspace(
      database.app,
      auth.user.id,
      readHeader(request.headers["idempotency-key"]),
      readString(body, "name"),
      readWorkspaceKind(body.kind),
    );
    broadcast(liveSockets, { type: "snapshot.invalidated", workspaceId: result.workspace.id });
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  app.post("/api/workspace-invites", async (request, reply) => {
    const auth = await authenticateRequest(request, database.app, config);
    const body = readObject(request.body);
    const result = await createWorkspaceInvite(
      database.app,
      auth.user.id,
      readString(body, "workspaceId"),
      readHeader(request.headers["idempotency-key"]),
      readMemberRole(body.role),
      config.sessionSecret,
    );
    broadcast(liveSockets, { type: "snapshot.invalidated", workspaceId: result.workspaceId });
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  app.post("/api/workspace-invites/join", async (request) => {
    const auth = await authenticateRequest(request, database.app, config);
    const body = readObject(request.body);
    const workspace = await joinWorkspaceInvite(database.app, auth.user.id, readString(body, "token"), config.sessionSecret);
    broadcast(liveSockets, { type: "snapshot.invalidated", workspaceId: workspace.id });
    return { workspace };
  });

  app.patch<{ Params: { workspaceId: string; userId: string } }>(
    "/api/workspaces/:workspaceId/members/:userId",
    async (request) => {
      const auth = await authenticateRequest(request, database.app, config);
      const body = readObject(request.body);
      const result = await updateMemberRole(database.app, auth.user.id, request.params.workspaceId, request.params.userId, readMemberRole(body.role));
      broadcast(liveSockets, { type: "snapshot.invalidated", workspaceId: request.params.workspaceId });
      return result;
    },
  );

  app.delete<{ Params: { workspaceId: string; userId: string } }>(
    "/api/workspaces/:workspaceId/members/:userId",
    async (request, reply) => {
      const auth = await authenticateRequest(request, database.app, config);
      await removeMember(database.app, auth.user.id, request.params.workspaceId, request.params.userId);
      broadcast(liveSockets, { type: "snapshot.invalidated", workspaceId: request.params.workspaceId });
      return reply.status(204).send();
    },
  );

  app.put<{ Params: { workspaceId: string; workstationId: string } }>(
    "/api/workspaces/:workspaceId/workstations/:workstationId/access",
    async (request) => {
      const auth = await authenticateRequest(request, database.app, config);
      const body = readObject(request.body);
      const result = await updateWorkstationAccess(database.app, auth.user.id, request.params.workspaceId, request.params.workstationId, readAccessInput(body));
      broadcast(liveSockets, { type: "snapshot.invalidated", workspaceId: request.params.workspaceId });
      return result;
    },
  );

  app.post<{ Params: { workspaceId: string; workstationId: string } }>(
    "/api/workspaces/:workspaceId/workstations/:workstationId/revoke",
    async (request) => {
      const auth = await authenticateRequest(request, database.app, config);
      await revokeWorkstation(database.app, auth.user.id, request.params.workspaceId, request.params.workstationId);
      sessionRelay.disconnectConnector({ workspaceId: request.params.workspaceId, workstationId: request.params.workstationId }, "Workstation access revoked");
      broadcast(liveSockets, { type: "snapshot.invalidated", workspaceId: request.params.workspaceId });
      return { revoked: true };
    },
  );

  app.post<{ Params: { previewId: string } }>(
    "/api/previews/:previewId/launch",
    async (request, reply) => {
      if (!config.previewEnabled || config.previewPublicOrigin === null) {
        throw new HttpError(404, "preview_disabled", "Development preview is disabled");
      }
      const auth = await authenticateRequest(request, database.app, config);
      const launch = await previewRelay.issueLaunchTicket(
        auth.user.id,
        auth.sessionId,
        request.params.previewId,
      );
      return reply.header("Cache-Control", "no-store").send({
        ...launch,
        gatewayOrigin: config.previewPublicOrigin,
      });
    },
  );

  app.post<{ Params: { previewId: string } }>(
    "/api/previews/:previewId/stop",
    async (request) => {
      const auth = await authenticateRequest(request, database.app, config);
      const preview = await previewRelay.stopPreview(auth.user.id, request.params.previewId);
      return { preview };
    },
  );

  app.get("/api/workstation-pairings", async (request) => {
    const auth = await authenticateRequest(request, database.app, config);
    const query = readObject(request.query);
    const workspaceId = optionalString(query, "workspaceId") ?? null;
    return { pairings: await listPairings(database.app, auth.user.id, workspaceId) };
  });

  app.post("/api/workstation-pairings", async (request, reply) => {
    const auth = await authenticateRequest(request, database.app, config);
    const idempotencyKey = readHeader(request.headers["idempotency-key"]);
    const body = readObject(request.body);
    const result = await createPairing(
      database.app,
      auth.user.id,
      readString(body, "workspaceId"),
      idempotencyKey,
      config.sessionSecret,
    );
    broadcast(liveSockets, { type: "snapshot.invalidated", workspaceId: result.pairing.workspaceId });
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  app.post<{ Params: { pairingId: string } }>(
    "/api/workstation-pairings/:pairingId/approve",
    async (request) => {
      const auth = await authenticateRequest(request, database.app, config);
      const body = readObject(request.body);
      const pairing = await approvePairing(
        database.app,
        auth.user.id,
        request.params.pairingId,
        optionalString(body, "workstationName"),
      );
      broadcast(liveSockets, { type: "snapshot.invalidated", workspaceId: pairing.workspaceId });
      return { pairing };
    },
  );

  app.post<{ Params: { pairingId: string } }>(
    "/api/workstation-pairings/:pairingId/cancel",
    async (request) => {
      const auth = await authenticateRequest(request, database.app, config);
      const pairing = await cancelPairing(database.app, auth.user.id, request.params.pairingId);
      broadcast(liveSockets, { type: "snapshot.invalidated", workspaceId: pairing.workspaceId });
      return { pairing };
    },
  );

  app.post("/api/connector/pairings/claim", async (request, reply) => {
    const body = readObject(request.body);
    const result = await claimPairing(database.connector, {
      pairCode: readString(body, "pairCode"),
      claimSecret: readString(body, "claimSecret"),
      deviceName: readString(body, "deviceName"),
      platform: readString(body, "platform"),
      connectorVersion: readString(body, "connectorVersion"),
      publicKey: readString(body, "publicKey"),
    }, config.sessionSecret);
    if (result.workspaceId !== undefined) {
      broadcast(liveSockets, { type: "snapshot.invalidated", workspaceId: result.workspaceId });
    }
    return reply.status(202).send(result);
  });

  app.post("/api/connector/pairings/result", async (request) => {
    const body = readObject(request.body);
    return getConnectorPairingResult(
      database.connector,
      readString(body, "pairCode"),
      readString(body, "claimSecret"),
      config.sessionSecret,
    );
  });

  app.post<{ Params: { requestId: string } }>(
    "/api/requests/:requestId/decision",
    async (request) => {
      const auth = await authenticateRequest(request, database.app, config);
      const idempotencyKey = readHeader(request.headers["idempotency-key"]);
      const body = readObject(request.body);
      const input = readDecisionInput(body);
      const result = await decideRequest(
        database.app,
        auth.user.id,
        request.params.requestId,
        idempotencyKey,
        input,
      );
      const connectorIdentity = {
        workspaceId: result.request.workspaceId,
        workstationId: result.request.workstationId,
      };
      const queued = await getPendingConnectorDecision(
        database.connector,
        connectorIdentity,
        result.request.id,
      );
      if (queued !== null) sessionRelay.pushDecision(connectorIdentity, queued);
      broadcast(liveSockets, {
        type: "snapshot.invalidated",
        workspaceId: result.request.workspaceId,
        requestId: result.request.id,
        status: result.request.status,
      });
      return result;
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/commands",
    async (request, reply) => {
      const auth = await authenticateRequest(request, database.app, config);
      const idempotencyKey = readHeader(request.headers["idempotency-key"]);
      const body = readObject(request.body);
      const result = await sendSessionCommand(
        database.app,
        auth.user.id,
        request.params.sessionId,
        idempotencyKey,
        optionalText(body, "content") ?? "",
        readAttachmentInputs(body.attachments),
        config.sessionSecret,
      );
      const connectorIdentity = {
        workspaceId: result.command.workspaceId,
        workstationId: result.command.workstationId,
      };
      const queued = await getPendingConnectorCommand(
        database.connector,
        connectorIdentity,
        result.command.id,
      );
      if (queued !== null) {
        sessionRelay.pushSessionCommand(connectorIdentity, queued);
        sessionRelay.commitAttachments(auth.user.id, request.params.sessionId, queued.attachments);
      }
      broadcast(liveSockets, {
        type: "snapshot.invalidated",
        workspaceId: result.command.workspaceId,
        sessionId: result.command.sessionId,
        commandId: result.command.id,
        status: result.command.status,
      });
      return reply.status(result.replayed ? 200 : 202).send(result);
    },
  );

  app.get(
    "/api/live",
    { websocket: true },
    (socket, request) => {
      const origin = Array.isArray(request.headers.origin) ? undefined : request.headers.origin;
      if (!browserOriginAllowed(origin, config)) {
        socket.close(4403, "Origin is not allowed");
        return;
      }
      void authenticateRequest(request, database.app, config)
        .then(async (auth) => {
          liveSockets.add(socket);
          socket.send(JSON.stringify({ type: "connected", userId: auth.user.id }));
          let processing = Promise.resolve();
          socket.on("message", (data) => {
            processing = processing
              .then(() => sessionRelay.handleUserMessage(socket, auth.user.id, data.toString()))
              .catch(() => socket.close(4400, "Invalid live message"));
          });
          socket.on("close", () => {
            liveSockets.delete(socket);
            sessionRelay.removeUser(socket);
          });
          socket.on("error", () => {
            liveSockets.delete(socket);
            sessionRelay.removeUser(socket);
          });
          await sessionRelay.attachUser(socket, auth.user.id);
        })
        .catch(() => socket.close(4401, "Authentication required"));
    },
  );

  if (options.serveWeb === true) {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    try {
      await access(webRoot);
      app.setNotFoundHandler(async (request, reply) => {
        if (request.method !== "GET" || request.url.startsWith("/api/")) {
          return reply.status(404).send({ error: { code: "not_found", message: "Route not found" } });
        }
        const pathname = new URL(request.url, "http://localhost").pathname;
        const requested = pathname === "/" || extname(pathname) === "" ? "index.html" : pathname.slice(1);
        const filePath = resolve(webRoot, requested);
        if (!filePath.startsWith(`${webRoot}${sep}`)) {
          return reply.status(404).send({ error: { code: "not_found", message: "Route not found" } });
        }
        try {
          const body = await readFile(filePath);
          return reply.type(contentType(filePath)).send(body);
        } catch {
          const body = await readFile(resolve(webRoot, "index.html"));
          return reply.type("text/html; charset=utf-8").send(body);
        }
      });
    } catch {
      app.log.warn({ webRoot }, "Web build is not available; API-only mode active");
    }
  }

  return app;
}

function contentType(path: string): string {
  const extension = extname(path);
  return extension === ".html"
    ? "text/html; charset=utf-8"
    : extension === ".js"
    ? "text/javascript; charset=utf-8"
    : extension === ".css"
      ? "text/css; charset=utf-8"
      : extension === ".json" || extension === ".webmanifest"
        ? "application/manifest+json; charset=utf-8"
        : extension === ".svg"
          ? "image/svg+xml"
          : extension === ".png"
            ? "image/png"
            : extension === ".ico"
              ? "image/x-icon"
              : "application/octet-stream";
}

function broadcast(sockets: Set<WebSocket>, message: unknown): void {
  const payload = JSON.stringify(message);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

function readDecisionInput(body: Record<string, unknown>): DecisionInput {
  const decision = readString(body, "decision");
  if (decision !== "approve" && decision !== "deny" && decision !== "answer") {
    throw new HttpError(400, "invalid_decision", "Decision is invalid");
  }
  const input: DecisionInput = { decision };
  const reason = optionalString(body, "reason");
  if (reason !== undefined) input.reason = reason;
  if (body.highRiskConfirmed === true) input.highRiskConfirmed = true;
  if (body.answers !== undefined) input.answers = readAnswers(body.answers);
  return input;
}

function readWorkspaceKind(value: unknown): WorkspaceKind {
  if (value !== "personal" && value !== "company" && value !== "team") {
    throw new HttpError(400, "invalid_workspace_kind", "Workspace kind is invalid");
  }
  return value;
}

function readMemberRole(value: unknown): Exclude<WorkspaceRole, "owner"> {
  if (value !== "admin" && value !== "member") {
    throw new HttpError(400, "invalid_member_role", "Member role is invalid");
  }
  return value;
}

function readAccessInput(body: Record<string, unknown>): {
  userId: string;
  canView: boolean;
  canRespond: boolean;
  canApproveHighRisk: boolean;
  canManage: boolean;
  canPreview: boolean;
} {
  const userId = readString(body, "userId");
  const booleanField = (key: string): boolean => {
    const value = body[key];
    if (typeof value !== "boolean") throw new HttpError(400, "invalid_access", `${key} must be boolean`);
    return value;
  };
  return {
    userId,
    canView: booleanField("canView"),
    canRespond: booleanField("canRespond"),
    canApproveHighRisk: booleanField("canApproveHighRisk"),
    canManage: booleanField("canManage"),
    canPreview: booleanField("canPreview"),
  };
}

function readAnswers(value: unknown): Record<string, string[]> {
  const object = readObject(value);
  if (Object.keys(object).length > 50) {
    throw new HttpError(400, "invalid_answers", "A decision can answer at most 50 questions");
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, answers]) => {
      if (
        !Array.isArray(answers) ||
        answers.length === 0 ||
        answers.length > 10 ||
        answers.some((answer) => typeof answer !== "string" || answer.length > 4_000)
      ) {
        throw new HttpError(400, "invalid_answers", `Answers for ${key} must be text values`);
      }
      return [key, answers as string[]];
    }),
  );
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "invalid_payload", "Expected an object payload");
  }
  return value as Record<string, unknown>;
}

function readString(value: Record<string, unknown>, key: string): string {
  const result = optionalString(value, key);
  if (result === undefined) throw new HttpError(400, "invalid_payload", `${key} is required`);
  return result;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const result = value[key];
  if (result === undefined) return undefined;
  if (typeof result !== "string" || result.length === 0) {
    throw new HttpError(400, "invalid_payload", `${key} must be non-empty text`);
  }
  return result;
}

function optionalText(value: Record<string, unknown>, key: string): string | undefined {
  const result = value[key];
  if (result === undefined) return undefined;
  if (typeof result !== "string") {
    throw new HttpError(400, "invalid_payload", `${key} must be text`);
  }
  return result;
}

function readAttachmentInputs(value: unknown): SessionCommandAttachmentInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) {
    throw new HttpError(400, "invalid_attachments", "attachments must contain at most four images");
  }
  return value.map((entry) => {
    const attachment = readObject(entry);
    const ticket = optionalString(attachment, "ticket");
    if (ticket === undefined || ticket.length > 2_000) {
      throw new HttpError(400, "invalid_attachment_ticket", "An image attachment ticket is invalid");
    }
    return { ticket };
  });
}

function readPushSubscription(value: unknown): PushSubscriptionInput {
  const body = readObject(value);
  const keys = readObject(body.keys);
  const expiration = body.expirationTime;
  if (expiration !== null && (typeof expiration !== "number" || !Number.isSafeInteger(expiration))) {
    throw new HttpError(400, "invalid_push_subscription", "expirationTime must be null or an integer timestamp");
  }
  return {
    endpoint: readString(body, "endpoint"),
    expirationTime: expiration,
    keys: {
      p256dh: readString(keys, "p256dh"),
      auth: readString(keys, "auth"),
    },
  };
}

function readHeader(value: string | string[] | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, "idempotency_key_required", "Idempotency-Key is required");
  }
  return value;
}
