import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import type { WebSocket } from "ws";

import type {
  ConnectorServerMessage,
  SessionCommandAttachment,
  WebLiveServerMessage,
} from "@yurupager/shared";

import type {
  ConnectorIdentity,
  OutboxDecision,
  OutboxSessionCommand,
} from "./connector-repository.js";
import type { WorkflowDefinitionSnapshot } from "@yurupager/shared";
import { authorizeSessionStream } from "./repository.js";
import { UploadRegistry } from "./session-relay/attachments.js";
import {
  isImageFrame,
  readConnectorAttachmentStatus,
  readConnectorSessionStreamMessage,
  readConnectorSessionTitles,
  readRecord,
  readWebLiveClientMessage,
} from "./session-relay/codec.js";
import { ConnectorLinks, sameConnector } from "./session-relay/connector-links.js";
import { applyIncomingImageFrame, type IncomingImage } from "./session-relay/images.js";
import { TitleDirectory } from "./session-relay/titles.js";

interface SessionRoute {
  subscriptionId: string;
  sessionId: string;
  workspaceId: string;
  workstationId: string;
  threadId: string;
  userId: string;
  userSocket: WebSocket;
  images: Map<string, IncomingImage>;
}

export class SessionRelay {
  readonly #pool: Pool;
  readonly #links = new ConnectorLinks();
  readonly #titles: TitleDirectory;
  readonly #attachments: UploadRegistry;
  readonly #routes = new Map<string, SessionRoute>();
  readonly #routesByUser = new Map<WebSocket, Set<string>>();
  readonly #users = new Map<WebSocket, string>();
  readonly #intentVersions = new Map<WebSocket, number>();

  constructor(pool: Pool, ticketSecret = "yurupager-test-attachment-secret") {
    this.#pool = pool;
    this.#titles = new TitleDirectory({
      pool,
      users: this.#users,
      sendUser: (socket, message) => this.#sendUser(socket, message),
    });
    this.#attachments = new UploadRegistry({
      pool,
      ticketSecret,
      sendUser: (socket, message) => this.#sendUser(socket, message),
      sendConnector: (socket, message) => this.#sendConnector(socket, message as ConnectorServerMessage),
      activeConnector: (identity) => this.#links.activeSocket(identity),
    });
  }

  async handleUserMessage(socket: WebSocket, userId: string, raw: string): Promise<void> {
    this.#attachments.sweepExpired();
    const value = JSON.parse(raw) as unknown;
    const message = readWebLiveClientMessage(value);
    switch (message.type) {
      case "session.stream.subscribe":
        await this.subscribeUser(socket, userId, message.sessionId);
        return;
      case "session.stream.unsubscribe":
        this.unsubscribeUser(socket, message.sessionId);
        return;
      case "session.attachment.begin":
        await this.#attachments.begin(socket, userId, message);
        return;
      case "session.attachment.chunk":
        await this.#attachments.receiveChunk(socket, userId, message);
        return;
      case "session.attachment.complete":
        await this.#attachments.complete(socket, userId, message);
        return;
      case "session.attachment.cancel":
        this.#attachments.cancel(socket, message.sessionId, message.uploadId);
        return;
    }
  }

  async attachUser(socket: WebSocket, userId: string): Promise<void> {
    this.#users.set(socket, userId);
    await this.#titles.attach(socket, userId);
  }

  async subscribeUser(socket: WebSocket, userId: string, sessionId: string): Promise<void> {
    const version = (this.#intentVersions.get(socket) ?? 0) + 1;
    this.#intentVersions.set(socket, version);
    this.#removeUserRoutes(socket);
    this.#sendUser(socket, { type: "session.stream.status", sessionId, state: "loading" });

    let authorized: Awaited<ReturnType<typeof authorizeSessionStream>>;
    try {
      authorized = await authorizeSessionStream(this.#pool, userId, sessionId);
    } catch {
      if (this.#intentVersions.get(socket) === version) {
        this.#sendUser(socket, { type: "session.stream.status", sessionId, state: "denied" });
      }
      return;
    }
    if (this.#intentVersions.get(socket) !== version || !isOpen(socket)) return;

    const route: SessionRoute = {
      subscriptionId: randomUUID(),
      sessionId: authorized.sessionId,
      workspaceId: authorized.workspaceId,
      workstationId: authorized.workstationId,
      threadId: authorized.threadId,
      userId,
      userSocket: socket,
      images: new Map(),
    };
    this.#routes.set(route.subscriptionId, route);
    const userRoutes = this.#routesByUser.get(socket) ?? new Set<string>();
    userRoutes.add(route.subscriptionId);
    this.#routesByUser.set(socket, userRoutes);

    const connector = this.#activeConnector(route);
    if (connector === undefined) {
      this.#sendUser(socket, { type: "session.stream.status", sessionId, state: "connector_offline" });
      return;
    }
    this.#sendConnector(connector, {
      type: "session.stream.subscribe",
      subscriptionId: route.subscriptionId,
      threadId: route.threadId,
    });
  }

  unsubscribeUser(socket: WebSocket, sessionId?: string): void {
    this.#intentVersions.set(socket, (this.#intentVersions.get(socket) ?? 0) + 1);
    const ids = this.#routesByUser.get(socket);
    if (ids === undefined) return;
    for (const id of [...ids]) {
      const route = this.#routes.get(id);
      if (route !== undefined && (sessionId === undefined || route.sessionId === sessionId)) this.#removeRoute(route);
    }
  }

  removeUser(socket: WebSocket): void {
    this.unsubscribeUser(socket);
    this.#attachments.removeUser(socket);
    this.#routesByUser.delete(socket);
    this.#intentVersions.delete(socket);
    this.#users.delete(socket);
  }

  registerPendingConnector(identity: ConnectorIdentity, socket: WebSocket): void {
    this.#links.registerPending(identity, socket);
  }

  activateConnector(identity: ConnectorIdentity, socket: WebSocket, replayedMessageIds: ReadonlySet<string>): boolean {
    if (!this.#links.activate(identity, socket, replayedMessageIds)) return false;
    if (this.#titles.take(identity)) void this.#titles.broadcast().catch(() => undefined);
    for (const route of this.#routes.values()) {
      if (!sameConnector(route, identity)) continue;
      this.#sendUser(route.userSocket, {
        type: "session.stream.status",
        sessionId: route.sessionId,
        state: "loading",
      });
      this.#sendConnector(socket, {
        type: "session.stream.subscribe",
        subscriptionId: route.subscriptionId,
        threadId: route.threadId,
      });
    }
    return true;
  }

  attachConnector(identity: ConnectorIdentity, socket: WebSocket): void {
    this.registerPendingConnector(identity, socket);
    this.activateConnector(identity, socket, new Set());
  }

  detachConnector(identity: ConnectorIdentity, socket: WebSocket): void {
    if (!this.#links.detach(identity, socket)) return;
    if (this.#titles.take(identity)) void this.#titles.broadcast().catch(() => undefined);
    for (const route of this.#routes.values()) {
      if (sameConnector(route, identity)) {
        this.#sendUser(route.userSocket, {
          type: "session.stream.status",
          sessionId: route.sessionId,
          state: "connector_offline",
        });
      }
    }
    this.#attachments.handleConnectorOffline(identity);
  }

  disconnectConnector(identity: ConnectorIdentity, reason = "Connector disconnected"): void {
    this.#links.disconnect(identity, reason);
  }

  pushSessionCommand(identity: ConnectorIdentity, command: OutboxSessionCommand): boolean {
    return this.#links.pushReliable(identity, {
      type: "session.command",
      messageId: command.messageId,
      sequence: command.sequence,
      commandId: command.commandId,
      threadId: command.threadId,
      text: command.text,
      attachments: command.attachments,
    });
  }

  pushWorkflowDispatch(identity: ConnectorIdentity, dispatch: { runId: string; definition: WorkflowDefinitionSnapshot; messageId: string; sequence: number }): boolean {
    return this.#links.pushReliable(identity, {
      type: "workflow.run.dispatch",
      messageId: dispatch.messageId,
      sequence: dispatch.sequence,
      runId: dispatch.runId,
      definition: dispatch.definition,
    });
  }

  pushWorkflowCancel(identity: ConnectorIdentity, cancel: { runId: string; reason: string; messageId: string; sequence: number }): boolean {
    return this.#links.pushReliable(identity, {
      type: "workflow.run.cancel",
      messageId: cancel.messageId,
      sequence: cancel.sequence,
      runId: cancel.runId,
      reason: cancel.reason,
    });
  }

  pushDecision(identity: ConnectorIdentity, decision: OutboxDecision): boolean {
    return this.#links.pushReliable(identity, {
      type: "decision",
      messageId: decision.messageId,
      sequence: decision.sequence,
      requestId: decision.requestId,
      decisionId: decision.decisionId,
      decision: decision.decision,
    });
  }

  commitAttachments(userId: string, sessionId: string, attachments: SessionCommandAttachment[]): void {
    this.#attachments.commit(userId, sessionId, attachments);
  }

  async handleConnectorMessage(identity: ConnectorIdentity, value: unknown): Promise<boolean> {
    this.#attachments.sweepExpired();
    const record = readRecord(value);
    if (record === null) {
      return false;
    }
    if (record.type === "session.titles.snapshot") {
      const titles = readConnectorSessionTitles(record);
      await this.#titles.ingest(identity, titles);
      return true;
    }
    if (record.type === "session.attachment.status") {
      const message = readConnectorAttachmentStatus(record);
      return this.#attachments.handleConnectorStatus(identity, message);
    }
    if (record.type !== "session.stream.frame" && record.type !== "session.stream.error") return false;
    const message = readConnectorSessionStreamMessage(record);
    const route = this.#routes.get(message.subscriptionId);
    if (route === undefined || !sameConnector(route, identity) || route.threadId !== message.threadId) return true;

    if (message.type === "session.stream.error") {
      this.#sendUser(route.userSocket, {
        type: "session.stream.status",
        sessionId: route.sessionId,
        state: "error",
      });
      return true;
    }
    if (isImageFrame(message.frame)) {
      try {
        const authorized = await authorizeSessionStream(this.#pool, route.userId, route.sessionId);
        if (!sameSessionRoute(route, authorized)) throw new Error("Session authorization changed");
      } catch {
        this.#sendUser(route.userSocket, {
          type: "session.stream.status",
          sessionId: route.sessionId,
          state: "denied",
        });
        this.#removeRoute(route);
        return true;
      }
      applyIncomingImageFrame(route.images, message.frame);
    } else if (message.frame.kind === "history.start") {
      route.images.clear();
    }
    this.#sendUser(route.userSocket, {
      type: "session.stream.frame",
      sessionId: route.sessionId,
      frame: message.frame,
    });
    if (message.frame.kind === "history.complete") {
      this.#sendUser(route.userSocket, {
        type: "session.stream.status",
        sessionId: route.sessionId,
        state: "live",
      });
    }
    return true;
  }

  #removeUserRoutes(socket: WebSocket): void {
    const ids = this.#routesByUser.get(socket);
    if (ids === undefined) return;
    for (const id of [...ids]) {
      const route = this.#routes.get(id);
      if (route !== undefined) this.#removeRoute(route);
    }
  }

  #removeRoute(route: SessionRoute): void {
    this.#routes.delete(route.subscriptionId);
    const userRoutes = this.#routesByUser.get(route.userSocket);
    userRoutes?.delete(route.subscriptionId);
    if (userRoutes?.size === 0) this.#routesByUser.delete(route.userSocket);
    const connector = this.#activeConnector(route);
    if (connector !== undefined) {
      this.#sendConnector(connector, {
        type: "session.stream.unsubscribe",
        subscriptionId: route.subscriptionId,
        threadId: route.threadId,
      });
    }
  }

  #sendUser(socket: WebSocket, message: WebLiveServerMessage): void {
    if (isOpen(socket)) socket.send(JSON.stringify(message));
  }

  #sendConnector(socket: WebSocket, message: ConnectorServerMessage): void {
    if (isOpen(socket)) socket.send(JSON.stringify(message));
  }

  #activeConnector(identity: Pick<ConnectorIdentity, "workspaceId" | "workstationId">): WebSocket | undefined {
    return this.#links.activeSocket(identity);
  }
}

function sameSessionRoute(
  route: SessionRoute,
  authorized: Pick<SessionRoute, "sessionId" | "workspaceId" | "workstationId" | "threadId">,
): boolean {
  return route.sessionId === authorized.sessionId &&
    route.workspaceId === authorized.workspaceId &&
    route.workstationId === authorized.workstationId &&
    route.threadId === authorized.threadId;
}

function isOpen(socket: WebSocket): boolean {
  return socket.readyState === socket.OPEN;
}
