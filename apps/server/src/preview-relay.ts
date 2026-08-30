import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type { Pool } from "pg";
import type {
  ConnectorPreviewRoute,
  PreviewHeader,
  PreviewTunnelServerMessage,
  WorkstationPreviewSummary,
} from "@yurupager/shared";
import { previewLimits } from "@yurupager/shared";
import WebSocket from "ws";

import { isWebSessionActive } from "./auth.js";
import type { Config } from "./config.js";
import type { ConnectorIdentity } from "./connector-repository.js";
import { PreviewCapacity, type CapacityEntry } from "./preview-relay/capacity.js";
import {
  bindingMatchesPreview,
  isRecord,
  parseProtocols,
  readAccess,
  readContentLength,
  readPreviewClientStreamMessage,
  readPreviewHello,
  readRouteSnapshot,
  rejectProxyUpgrade,
  routeKey,
  sameIdentity,
  sendProxyError,
} from "./preview-relay/protocol.js";
import { PreviewStreamRegistry } from "./preview-relay/streams.js";
import type {
  BrowserWebSocketStream,
  HttpStream,
  PreviewAccess,
  PreviewConnection,
} from "./preview-relay/types.js";
import { PreviewAdmissionFailure, PreviewStreamFailure } from "./preview-relay/types.js";
import {
  authorizeWorkstationPreview,
  setConnectorPreviewRoutesStatus,
  stopWorkstationPreview,
  syncConnectorPreviewRoutes,
} from "./preview-repository.js";
import type { PreviewGatewayRelay, RedeemedPreviewLaunch } from "./preview-gateway.js";
import {
  OneTimePreviewTickets,
  sanitizePreviewRequestHeaders,
  signPreviewContext,
  validatePreviewMethod,
  validatePreviewPath,
  verifyPreviewContext,
} from "./preview-security.js";

export interface PreviewRelayOptions {
  appPool: Pool;
  connectorPool: Pool;
  config: Config;
  onChanged(workspaceId: string): void;
}

export class PreviewRelay implements PreviewGatewayRelay {
  readonly #appPool: Pool;
  readonly #connectorPool: Pool;
  readonly #config: Config;
  readonly #onChanged: (workspaceId: string) => void;
  readonly #connections = new Map<WebSocket, PreviewConnection>();
  readonly #routeSockets = new Map<string, PreviewConnection>();
  readonly #streams: PreviewStreamRegistry;
  readonly #capacity = new PreviewCapacity();
  readonly #tickets = new OneTimePreviewTickets();

  constructor(options: PreviewRelayOptions) {
    this.#appPool = options.appPool;
    this.#connectorPool = options.connectorPool;
    this.#config = options.config;
    this.#onChanged = options.onChanged;
    this.#streams = new PreviewStreamRegistry({
      send: (connection, message) => this.#send(connection, message),
      publicOrigin: options.config.previewPublicOrigin,
    });
  }

  attachConnector(identity: ConnectorIdentity, socket: WebSocket): void {
    this.#connections.set(socket, {
      identity,
      socket,
      phase: "pending",
      connectionEpoch: null,
      routes: new Set(),
    });
  }

  async detachConnector(socket: WebSocket): Promise<void> {
    const connection = this.#connections.get(socket);
    if (connection === undefined) return;
    this.#connections.delete(socket);
    const routes = [...connection.routes];
    for (const routeId of routes) {
      const key = routeKey(connection.identity, routeId);
      if (this.#routeSockets.get(key) === connection) this.#routeSockets.delete(key);
    }
    this.#streams.failAllForConnector(connection);
    if (routes.length > 0) {
      await setConnectorPreviewRoutesStatus(
        this.#connectorPool,
        connection.identity,
        routes,
        "connector_offline",
      );
      this.#onChanged(connection.identity.workspaceId);
    }
  }

  async handleConnectorMessage(identity: ConnectorIdentity, socket: WebSocket, raw: string): Promise<void> {
    const connection = this.#connections.get(socket);
    if (connection === undefined || !sameIdentity(connection.identity, identity)) {
      throw new Error("Preview connector is not attached");
    }
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || typeof value.type !== "string") throw new Error("Invalid preview message");
    if (value.type === "preview.hello") {
      if (connection.phase === "active") throw new Error("Duplicate preview hello");
      const hello = readPreviewHello(value, this.#config.previewMaxDurationMinutes);
      connection.phase = "active";
      connection.connectionEpoch = hello.connectionEpoch;
      await this.#replaceRoutes(connection, hello.routes);
      this.#send(connection, {
        type: "preview.welcome",
        connectionEpoch: randomUUID(),
        maxChunkBytes: previewLimits.maxChunkBytes,
        initialWindowBytes: previewLimits.initialWindowBytes,
      });
      return;
    }
    if (connection.phase !== "active") throw new Error("Preview connector must send hello first");
    if (value.type === "preview.routes.snapshot") {
      const snapshot = readRouteSnapshot(value, this.#config.previewMaxDurationMinutes);
      await this.#replaceRoutes(connection, snapshot.routes);
      return;
    }
    const message = readPreviewClientStreamMessage(value);
    this.#streams.handleStreamMessage(connection, message);
  }

  async issueLaunchTicket(
    userId: string,
    sessionId: string,
    previewId: string,
  ): Promise<{ ticket: string; preview: WorkstationPreviewSummary; expiresAt: string }> {
    const preview = await authorizeWorkstationPreview(this.#appPool, userId, previewId);
    const previewExpiresAt = new Date(preview.expiresAt).getTime();
    const now = Date.now();
    const ticketExpiresAt = Math.min(previewExpiresAt, now + 60_000);
    const ticket = this.#tickets.issue({
      previewId: preview.id,
      userId,
      sessionId,
      workspaceId: preview.workspaceId,
      workstationId: preview.workstationId,
      ticketExpiresAt,
      previewExpiresAt,
    });
    return { ticket, preview, expiresAt: new Date(ticketExpiresAt).toISOString() };
  }

  async redeemLaunchTicket(ticket: string): Promise<RedeemedPreviewLaunch | null> {
    const binding = this.#tickets.consume(ticket);
    if (binding === null) return null;
    if (!await isWebSessionActive(this.#appPool, binding.sessionId, binding.userId)) return null;
    let preview: WorkstationPreviewSummary;
    try {
      preview = await authorizeWorkstationPreview(this.#appPool, binding.userId, binding.previewId);
    } catch {
      return null;
    }
    if (!bindingMatchesPreview(binding, preview)) return null;
    const now = Date.now();
    const contextExpiresAt = Math.min(binding.previewExpiresAt, now + 12 * 60 * 60_000);
    if (contextExpiresAt <= now) return null;
    const cookieValue = signPreviewContext(this.#config.sessionSecret, {
      previewId: binding.previewId,
      userId: binding.userId,
      sessionId: binding.sessionId,
      workspaceId: binding.workspaceId,
      workstationId: binding.workstationId,
      previewExpiresAt: binding.previewExpiresAt,
      contextExpiresAt,
    });
    return { cookieValue, maxAgeSeconds: Math.ceil((contextExpiresAt - now) / 1_000) };
  }

  async authorizePreviewContext(cookieValue: string | undefined) {
    if (cookieValue === undefined) return null;
    const binding = verifyPreviewContext(this.#config.sessionSecret, cookieValue);
    if (binding === null || !await isWebSessionActive(this.#appPool, binding.sessionId, binding.userId)) return null;
    let preview: WorkstationPreviewSummary;
    try {
      preview = await authorizeWorkstationPreview(this.#appPool, binding.userId, binding.previewId);
    } catch {
      return null;
    }
    if (!bindingMatchesPreview(binding, preview)) return null;
    const connector = this.#routeSockets.get(routeKey({
      workspaceId: preview.workspaceId,
      workstationId: preview.workstationId,
    }, preview.routeId));
    return connector?.phase === "active" && connector.socket.readyState === WebSocket.OPEN
      ? { binding, preview, connector }
      : null;
  }

  async stopPreview(userId: string, previewId: string): Promise<WorkstationPreviewSummary> {
    const preview = await stopWorkstationPreview(this.#appPool, userId, previewId);
    const key = routeKey({ workspaceId: preview.workspaceId, workstationId: preview.workstationId }, preview.routeId);
    const connector = this.#routeSockets.get(key);
    if (connector !== undefined) {
      this.#send(connector, { type: "preview.route.stop", routeId: preview.routeId, reason: "user_stopped" });
      connector.routes.delete(preview.routeId);
      this.#routeSockets.delete(key);
      this.#streams.failAllForPreview(preview.id);
    }
    this.#onChanged(preview.workspaceId);
    return preview;
  }

  async relayHttp(accessValue: unknown, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const access = readAccess(accessValue);
    const method = validatePreviewMethod(request.method);
    const path = validatePreviewPath(request.url ?? "");
    if (method === null || path === null) {
      sendProxyError(response, 400, "请求不符合开发预览协议");
      return;
    }
    const bodyLength = readContentLength(request.headers["content-length"]);
    if (bodyLength !== undefined && bodyLength > previewLimits.maxRequestBytes) {
      sendProxyError(response, 413, "请求正文超过开发预览限制");
      return;
    }
    let headers: PreviewHeader[];
    try {
      headers = sanitizePreviewRequestHeaders(request.headers, access.preview.routeId);
    } catch {
      sendProxyError(response, 431, "请求 header 超过开发预览限制");
      return;
    }
    request.pause();
    const abortController = new AbortController();
    const abortAdmission = () => abortController.abort();
    request.once("aborted", abortAdmission);
    response.once("close", abortAdmission);
    let reservation: CapacityEntry;
    try {
      reservation = await this.#reserveCapacity(access, abortController.signal);
    } catch (error) {
      request.off("aborted", abortAdmission);
      response.off("close", abortAdmission);
      request.resume();
      this.#handleHttpAdmissionFailure(response, error);
      return;
    }
    request.off("aborted", abortAdmission);
    response.off("close", abortAdmission);

    let stream: HttpStream;
    try {
      stream = this.#streams.createHttpStream(access, method, request, response);
    } finally {
      this.#capacity.release(reservation);
    }
    try {
      if (!this.#send(access.connector, {
        type: "preview.http.open",
        streamId: stream.id,
        routeId: access.preview.routeId,
        method,
        path,
        headers,
        ...(bodyLength === undefined ? {} : { bodyLength }),
      })) {
        throw new PreviewStreamFailure("route_unavailable", false);
      }
      await stream.accepted.promise;
      request.resume();
      for await (const value of request) {
        const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
        for (let offset = 0; offset < buffer.byteLength; offset += previewLimits.maxChunkBytes) {
          const chunk = buffer.subarray(offset, offset + previewLimits.maxChunkBytes);
          if (stream.requestOffset + chunk.byteLength > previewLimits.maxRequestBytes) {
            throw new PreviewStreamFailure("request_too_large", false);
          }
          await this.#streams.waitForCredit(stream, chunk.byteLength);
          this.#send(stream.connector, {
            type: "preview.http.request.chunk",
            streamId: stream.id,
            offset: stream.requestOffset,
            data: chunk.toString("base64"),
          });
          stream.requestOffset += chunk.byteLength;
          stream.requestCredit -= chunk.byteLength;
          this.#streams.touch(stream);
        }
      }
      this.#send(stream.connector, { type: "preview.http.request.end", streamId: stream.id });
      await stream.done.promise;
    } catch (error) {
      if (!stream.settled) {
        const failure = error instanceof PreviewStreamFailure ? error : new PreviewStreamFailure("stream_cancelled", stream.dispatched);
        this.#streams.failStream(stream, failure.code, failure.dispatched);
      }
    }
  }

  async relayWebSocket(accessValue: unknown, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const access = readAccess(accessValue);
    const path = validatePreviewPath(request.url ?? "");
    if (path === null) {
      socket.destroy();
      return;
    }
    let headers: PreviewHeader[];
    try {
      headers = sanitizePreviewRequestHeaders(request.headers, access.preview.routeId);
    } catch {
      socket.destroy();
      return;
    }
    const protocols = parseProtocols(request.headers["sec-websocket-protocol"]);
    const abortController = new AbortController();
    const abortAdmission = () => abortController.abort();
    socket.once("close", abortAdmission);
    let reservation: CapacityEntry;
    try {
      reservation = await this.#reserveCapacity(access, abortController.signal);
    } catch (error) {
      socket.off("close", abortAdmission);
      this.#handleWebSocketAdmissionFailure(socket, error);
      return;
    }
    socket.off("close", abortAdmission);

    let stream: BrowserWebSocketStream;
    try {
      stream = this.#streams.createWebSocketStream(access, request, socket, head);
    } finally {
      this.#capacity.release(reservation);
    }
    try {
      if (!this.#send(access.connector, {
        type: "preview.ws.open",
        streamId: stream.id,
        routeId: access.preview.routeId,
        path,
        headers,
        protocols,
      })) {
        throw new PreviewStreamFailure("route_unavailable", false);
      }
      await stream.accepted.promise;
      await stream.done.promise;
    } catch {
      if (!stream.settled) this.#streams.failStream(stream, "stream_cancelled", stream.dispatched);
    }
  }

  async #replaceRoutes(connection: PreviewConnection, routes: ConnectorPreviewRoute[]): Promise<void> {
    const nextIds = new Set(routes.map((route) => route.routeId));
    const removed = [...connection.routes].filter((routeId) => !nextIds.has(routeId));
    if (removed.length > 0) {
      await setConnectorPreviewRoutesStatus(this.#connectorPool, connection.identity, removed, "stopped");
      for (const routeId of removed) {
        const key = routeKey(connection.identity, routeId);
        if (this.#routeSockets.get(key) === connection) this.#routeSockets.delete(key);
      }
    }
    const previews = await syncConnectorPreviewRoutes(this.#connectorPool, connection.identity, routes, {
      maxDurationMs: this.#config.previewMaxDurationMinutes * 60_000,
    });
    connection.routes = nextIds;
    for (const preview of previews) {
      const key = routeKey(connection.identity, preview.routeId);
      const previous = this.#routeSockets.get(key);
      if (previous !== undefined && previous !== connection) {
        previous.routes.delete(preview.routeId);
        if (previous.routes.size === 0) previous.socket.close(4409, "Preview route superseded");
      }
      this.#routeSockets.set(key, connection);
    }
    this.#onChanged(connection.identity.workspaceId);
  }

  #reserveCapacity(access: PreviewAccess, signal: AbortSignal): Promise<CapacityEntry> {
    return this.#capacity.reserve(access, signal, {
      isActive: () => this.#accessIsActive(access),
      streams: () => this.#streams.values(),
    });
  }

  #accessIsActive(access: PreviewAccess): boolean {
    const key = routeKey({
      workspaceId: access.preview.workspaceId,
      workstationId: access.preview.workstationId,
    }, access.preview.routeId);
    return access.connector.phase === "active" &&
      access.connector.socket.readyState === WebSocket.OPEN &&
      access.connector.routes.has(access.preview.routeId) &&
      this.#routeSockets.get(key) === access.connector;
  }

  #handleHttpAdmissionFailure(response: ServerResponse, error: unknown): void {
    if (response.destroyed || error instanceof PreviewAdmissionFailure && error.reason === "cancelled") return;
    if (error instanceof PreviewAdmissionFailure && error.reason === "busy") {
      sendProxyError(response, 503, "开发预览请求较多，请稍后重试");
      return;
    }
    sendProxyError(response, 504, "本机预览路由不可用");
  }

  #handleWebSocketAdmissionFailure(socket: Duplex, error: unknown): void {
    if (socket.destroyed || error instanceof PreviewAdmissionFailure && error.reason === "cancelled") return;
    const busy = error instanceof PreviewAdmissionFailure && error.reason === "busy";
    rejectProxyUpgrade(socket, busy ? 503 : 504, busy ? "Preview capacity is busy" : "Preview route is unavailable");
  }

  #send(connection: PreviewConnection, message: PreviewTunnelServerMessage): boolean {
    if (connection.socket.readyState !== WebSocket.OPEN) return false;
    connection.socket.send(JSON.stringify(message));
    return true;
  }
}
