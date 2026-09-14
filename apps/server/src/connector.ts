import { randomUUID, timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

import type { ConnectorPayload, ConnectorServerMessage, TransportEnvelope } from "@yurupager/shared";

import type { Config } from "./config.js";
import type { Database } from "./database.js";
import type { SessionRelay } from "./session-relay.js";
import type { PushService } from "./push-service.js";
import {
  acknowledgeConnectorOutbox,
  getConnectorCursor,
  getPendingConnectorCommands,
  getPendingConnectorDecisions,
  getPendingConnectorWorkflows,
  findConnectorIdentity,
  heartbeatWorkstation,
  processConnectorEnvelope,
  type ConnectorIdentity,
} from "./connector-repository.js";

export function registerConnectorRoute(
  app: FastifyInstance,
  database: Database,
  config: Config,
  onChanged: (workspaceId: string) => void,
  sessionRelay: SessionRelay,
  pushService: PushService,
): void {
  app.get("/connector/v1/ws", { websocket: true }, (socket, request) => {
    const token = readBearer(request.headers.authorization);
    if (token === null) {
      socket.close(4401, "Invalid connector credential");
      return;
    }
    void resolveConnectorIdentity(database, config, token)
      .then((identity) => {
        if (identity === null) {
          socket.close(4401, "Invalid connector credential");
          return;
        }
        startConnectorConnection(socket, identity, database, onChanged, sessionRelay, pushService, app);
      })
      .catch((error: unknown) => {
        app.log.error(error, "Connector authentication failed");
        socket.close(1011, "Connector authentication failed");
      });
  });
}

function startConnectorConnection(
  socket: WebSocket,
  identity: ConnectorIdentity,
  database: Database,
  onChanged: (workspaceId: string) => void,
  sessionRelay: SessionRelay,
  pushService: PushService,
  app: FastifyInstance,
): void {
  const connectionEpoch = randomUUID();
  sessionRelay.registerPendingConnector(identity, socket);
  const handshake: { state: "pending" | "active" } = { state: "pending" };
  let alive = true;
  let processing = Promise.resolve();
  socket.on("pong", () => { alive = true; });
  const heartbeat = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
    send(socket, { type: "heartbeat", timestamp: new Date().toISOString() });
    // A socket is only considered online after the application handshake. A
    // TCP connection that is still pending authentication must not make the
    // workstation look healthy in snapshots while session streaming is unable
    // to use it.
    if (handshake.state === "active") {
      void heartbeatWorkstation(database.connector, identity).catch((error: unknown) => app.log.error(error));
    }
  }, 15_000);

  socket.on("close", () => {
    clearInterval(heartbeat);
    sessionRelay.detachConnector(identity, socket);
  });
  socket.on("error", (error) => app.log.warn(error, "Connector WebSocket error"));
  socket.on("message", (data) => {
    processing = processing
      .then(() => handleMessage(
        socket,
        data.toString(),
        identity,
        database,
        connectionEpoch,
        handshake,
        onChanged,
        sessionRelay,
        pushService,
      ))
      .catch((error: unknown) => {
        app.log.warn(error, "Connector message rejected");
        socket.close(4400, "Invalid connector message");
      });
  });
}

async function resolveConnectorIdentity(
  database: Database,
  config: Config,
  token: string,
): Promise<ConnectorIdentity | null> {
  const dynamic = await findConnectorIdentity(database.connector, token);
  if (dynamic !== null) return dynamic;
  if (!constantTimeEqual(token, config.connectorToken)) return null;
  return {
    workspaceId: config.connectorWorkspaceId,
    workstationId: config.connectorWorkstationId,
  };
}

async function handleMessage(
  socket: WebSocket,
  raw: string,
  identity: ConnectorIdentity,
  database: Database,
  connectionEpoch: string,
  handshake: { state: "pending" | "active" },
  onChanged: (workspaceId: string) => void,
  sessionRelay: SessionRelay,
  pushService: PushService,
): Promise<void> {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("Message must have a type");
  if (value.type === "hello") {
    if (handshake.state === "active") return;
    const replayedMessageIds = await sendWelcomeAndReplay(socket, database, identity, connectionEpoch);
    if (!sessionRelay.activateConnector(identity, socket, replayedMessageIds)) {
      socket.close(4409, "Connector connection was superseded");
      return;
    }
    handshake.state = "active";
    return;
  }
  if (handshake.state !== "active") throw new Error("Connector must send hello first");
  if (value.type === "ack") {
    if (typeof value.messageId !== "string") throw new Error("ACK requires messageId");
    await acknowledgeConnectorOutbox(database.connector, identity, value.messageId);
    return;
  }
  if (value.type === "heartbeat") {
    await heartbeatWorkstation(database.connector, identity);
    return;
  }
  if (await sessionRelay.handleConnectorMessage(identity, value)) return;
  const envelope = readEnvelope(value);
  const result = await processConnectorEnvelope(database.connector, identity, envelope);
  send(socket, { type: "ack", messageId: envelope.messageId, sequence: envelope.sequence });
  onChanged(result.workspaceId);
  if (result.pushRequest !== undefined) pushService.enqueueRequest(result.pushRequest);
}

async function sendWelcomeAndReplay(
  socket: WebSocket,
  database: Database,
  identity: ConnectorIdentity,
  connectionEpoch: string,
): Promise<Set<string>> {
  const cursor = await getConnectorCursor(database.connector, identity);
  send(socket, { type: "welcome", connectionEpoch, lastAcceptedSequence: cursor });
  const [decisions, commands, workflows] = await Promise.all([
    getPendingConnectorDecisions(database.connector, identity),
    getPendingConnectorCommands(database.connector, identity),
    getPendingConnectorWorkflows(database.connector, identity),
  ]);
  const messages: Array<Extract<ConnectorServerMessage, { sequence: number; messageId: string }>> = [
    ...decisions.map((decision): Extract<ConnectorServerMessage, { type: "decision" }> => ({
      type: "decision",
      messageId: decision.messageId,
      sequence: decision.sequence,
      requestId: decision.requestId,
      decisionId: decision.decisionId,
      decision: decision.decision,
    })),
    ...commands.map((command): Extract<ConnectorServerMessage, { type: "session.command" }> => ({
      type: "session.command",
      messageId: command.messageId,
      sequence: command.sequence,
      commandId: command.commandId,
      threadId: command.threadId,
      text: command.text,
      attachments: command.attachments,
    })),
    ...workflows.dispatches.map((dispatch): Extract<ConnectorServerMessage, { type: "workflow.run.dispatch"; sequence: number; messageId: string }> => ({
      type: "workflow.run.dispatch",
      messageId: dispatch.messageId,
      sequence: dispatch.sequence,
      runId: dispatch.runId,
      definition: dispatch.definition,
    })),
    ...workflows.cancels.map((cancel): Extract<ConnectorServerMessage, { type: "workflow.run.cancel"; sequence: number; messageId: string }> => ({
      type: "workflow.run.cancel",
      messageId: cancel.messageId,
      sequence: cancel.sequence,
      runId: cancel.runId,
      reason: cancel.reason,
    })),
  ].sort((left, right) => left.sequence - right.sequence);
  for (const message of messages) {
    send(socket, message);
  }
  return new Set(messages.map((message) => message.messageId));
}

function readEnvelope(value: Record<string, unknown>): TransportEnvelope<ConnectorPayload> {
  if (
    value.type !== "event" ||
    value.protocolVersion !== 1 ||
    typeof value.messageId !== "string" ||
    typeof value.streamId !== "string" ||
    typeof value.connectionEpoch !== "string" ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    typeof value.timestamp !== "string" ||
    typeof value.idempotencyKey !== "string" ||
    !isRecord(value.payload) ||
    typeof value.payload.type !== "string"
  ) {
    throw new Error("Invalid transport envelope");
  }
  return value as unknown as TransportEnvelope<ConnectorPayload>;
}

function send(socket: WebSocket, message: ConnectorServerMessage | { type: "ack"; messageId: string; sequence: number }): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function readBearer(value: string | undefined): string | null {
  return value?.startsWith("Bearer ") === true ? value.slice(7) : null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
