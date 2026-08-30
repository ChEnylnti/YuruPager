import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type { Pool } from "pg";
import WebSocket, { WebSocketServer } from "ws";

import type {
  ConnectorPreviewRoute,
  PreviewHeader,
  PreviewHttpMethod,
  PreviewTunnelClientMessage,
  PreviewTunnelErrorCode,
  PreviewTunnelServerMessage,
  WorkstationPreviewSummary,
} from "@yurupager/shared";
import { previewLimits } from "@yurupager/shared";

import { isWebSessionActive } from "./auth.js";
import type { Config } from "./config.js";
import type { ConnectorIdentity } from "./connector-repository.js";
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
  sanitizePreviewResponseHeaders,
  signPreviewContext,
  validatePreviewMethod,
  validatePreviewPath,
  verifyPreviewContext,
  type PreviewContextBinding,
} from "./preview-security.js";

interface PreviewConnection {
  identity: ConnectorIdentity;
  socket: WebSocket;
  phase: "pending" | "active";
  connectionEpoch: string | null;
  routes: Set<string>;
}

interface PreviewAccess {
  binding: PreviewContextBinding;
  preview: WorkstationPreviewSummary;
  connector: PreviewConnection;
}

interface StreamBase {
  id: string;
  access: PreviewAccess;
  connector: PreviewConnection;
  requestCredit: number;
  responseOffset: number;
  requestOffset: number;
  dispatched: boolean;
  settled: boolean;
  idleTimer: NodeJS.Timeout;
  lifetimeTimer: NodeJS.Timeout;
  done: Deferred<void>;
}

interface HttpStream extends StreamBase {
  kind: "http";
  method: PreviewHttpMethod;
  request: IncomingMessage;
  response: ServerResponse;
  accepted: Deferred<void>;
  responseStarted: boolean;
  responseBackpressured: boolean;
  responseEndReceived: boolean;
  pendingResponseCredit: number;
}

interface BrowserWebSocketStream extends StreamBase {
  kind: "websocket";
  request: IncomingMessage;
  rawSocket: Duplex;
  head: Buffer;
  accepted: Deferred<void>;
  acceptedProtocol?: string;
  browser?: WebSocket;
  inboundSequence: number;
  outboundSequence: number;
}

type PreviewStream = HttpStream | BrowserWebSocketStream;
interface CapacityEntry {
  access: PreviewAccess;
}

const routeClockToleranceMs = 30_000;

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
  readonly #streams = new Map<string, PreviewStream>();
  readonly #capacityWaiters = new Set<CapacityEntry>();
  readonly #capacityReservations = new Set<CapacityEntry>();
  readonly #tickets = new OneTimePreviewTickets();
  readonly #browserWebSockets = new WebSocketServer({
    noServer: true,
    maxPayload: previewLimits.maxChunkBytes,
    handleProtocols(protocols, request) {
      const accepted = (request as IncomingMessage & { yurupagerProtocol?: string }).yurupagerProtocol;
      return accepted !== undefined && protocols.has(accepted) ? accepted : false;
    },
  });

  constructor(options: PreviewRelayOptions) {
    this.#appPool = options.appPool;
    this.#connectorPool = options.connectorPool;
    this.#config = options.config;
    this.#onChanged = options.onChanged;
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
    for (const stream of [...this.#streams.values()]) {
      if (stream.connector === connection) this.#failStream(stream, "route_unavailable", stream.dispatched);
    }
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
    await this.#handleStreamMessage(connection, message);
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

  async authorizePreviewContext(cookieValue: string | undefined): Promise<PreviewAccess | null> {
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
      for (const stream of [...this.#streams.values()]) {
        if (stream.access.preview.id === preview.id) this.#failStream(stream, "route_unavailable", stream.dispatched);
      }
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
      stream = this.#createHttpStream(access, method, request, response);
    } finally {
      this.#capacityReservations.delete(reservation);
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
          await this.#waitForCredit(stream, chunk.byteLength);
          this.#send(stream.connector, {
            type: "preview.http.request.chunk",
            streamId: stream.id,
            offset: stream.requestOffset,
            data: chunk.toString("base64"),
          });
          stream.requestOffset += chunk.byteLength;
          stream.requestCredit -= chunk.byteLength;
          this.#touch(stream);
        }
      }
      this.#send(stream.connector, { type: "preview.http.request.end", streamId: stream.id });
      await stream.done.promise;
    } catch (error) {
      if (!stream.settled) {
        const failure = error instanceof PreviewStreamFailure ? error : new PreviewStreamFailure("stream_cancelled", stream.dispatched);
        this.#failStream(stream, failure.code, failure.dispatched);
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
      stream = this.#createWebSocketStream(access, request, socket, head);
    } finally {
      this.#capacityReservations.delete(reservation);
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
      if (!stream.settled) this.#failStream(stream, "stream_cancelled", stream.dispatched);
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

  async #handleStreamMessage(connection: PreviewConnection, message: Exclude<PreviewTunnelClientMessage, { type: "preview.hello" | "preview.routes.snapshot" }>): Promise<void> {
    const stream = this.#streams.get(message.streamId);
    if (stream === undefined || stream.connector !== connection) return;
    this.#touch(stream);
    switch (message.type) {
      case "preview.http.accepted":
        if (stream.kind !== "http") throw new Error("HTTP accepted for non-HTTP stream");
        stream.dispatched = true;
        stream.accepted.resolve();
        return;
      case "preview.http.response.start":
        if (stream.kind !== "http" || stream.responseStarted || !validStatusCode(message.statusCode)) {
          throw new Error("Invalid preview response start");
        }
        stream.responseStarted = true;
        stream.dispatched = true;
        stream.response.statusCode = message.statusCode;
        for (const [name, value] of sanitizePreviewResponseHeaders(message.headers, stream.access.preview.routeId)) {
          if (name === "location") {
            stream.response.appendHeader(name, rewriteLocation(value, stream.access.preview, this.#config.previewPublicOrigin));
          } else {
            stream.response.appendHeader(name, value);
          }
        }
        return;
      case "preview.http.response.chunk": {
        if (stream.kind !== "http" || !stream.responseStarted || message.offset !== stream.responseOffset) {
          throw new Error("Out-of-order preview response chunk");
        }
        const chunk = decodeCanonicalChunk(message.data);
        if (stream.responseOffset + chunk.byteLength > previewLimits.maxResponseBytes) {
          this.#failStream(stream, "response_too_large", true);
          return;
        }
        stream.responseOffset += chunk.byteLength;
        stream.pendingResponseCredit += chunk.byteLength;
        const writable = stream.response.write(chunk);
        if (!writable && !stream.responseBackpressured) {
          stream.responseBackpressured = true;
          void once(stream.response, "drain")
            .then(() => this.#resumeHttpResponse(stream))
            .catch(() => this.#failStream(stream, "stream_cancelled", stream.dispatched));
        } else if (writable && !stream.responseBackpressured) {
          this.#grantHttpResponseCredit(stream);
        }
        return;
      }
      case "preview.http.response.end":
        if (stream.kind !== "http" || !stream.responseStarted) throw new Error("Invalid preview response end");
        stream.responseEndReceived = true;
        if (!stream.responseBackpressured) this.#completeHttpResponse(stream);
        return;
      case "preview.stream.error":
        this.#failStream(stream, message.code, message.dispatched);
        return;
      case "preview.flow":
        if (message.direction === "request" && message.ackOffset <= stream.requestOffset) {
          stream.requestCredit = Math.min(
            previewLimits.initialWindowBytes,
            stream.requestCredit + message.creditBytes,
          );
        }
        return;
      case "preview.ws.accepted":
        if (stream.kind !== "websocket") throw new Error("WebSocket accepted for HTTP stream");
        stream.dispatched = true;
        if (message.protocol !== undefined) stream.acceptedProtocol = message.protocol;
        this.#acceptBrowserWebSocket(stream);
        return;
      case "preview.ws.frame": {
        if (stream.kind !== "websocket" || stream.browser === undefined || message.sequence !== stream.inboundSequence) {
          throw new Error("Invalid preview WebSocket frame");
        }
        const frame = decodeCanonicalChunk(message.data);
        stream.inboundSequence += 1;
        stream.responseOffset += frame.byteLength;
        stream.browser.send(message.binary ? frame : frame.toString("utf8"), { binary: message.binary });
        this.#send(stream.connector, {
          type: "preview.flow",
          streamId: stream.id,
          direction: "response",
          ackOffset: stream.responseOffset,
          creditBytes: frame.byteLength,
        });
        return;
      }
      case "preview.ws.close":
        if (stream.kind !== "websocket") throw new Error("WebSocket close for HTTP stream");
        stream.browser?.close(validCloseCode(message.code) ? message.code : 1000, truncateCloseReason(message.reason));
        this.#finishStream(stream);
        return;
      default:
        throw new Error("Unsupported preview stream message");
    }
  }

  #createHttpStream(
    access: PreviewAccess,
    method: PreviewHttpMethod,
    request: IncomingMessage,
    response: ServerResponse,
  ): HttpStream {
    const stream = this.#baseStream<HttpStream>({
      kind: "http",
      method,
      request,
      response,
      accepted: deferred<void>(),
      responseStarted: false,
      responseBackpressured: false,
      responseEndReceived: false,
      pendingResponseCredit: 0,
    }, access);
    request.once("aborted", () => this.#failStream(stream, "stream_cancelled", stream.dispatched));
    response.once("close", () => {
      if (!response.writableEnded) this.#failStream(stream, "stream_cancelled", stream.dispatched);
    });
    return stream;
  }

  #createWebSocketStream(
    access: PreviewAccess,
    request: IncomingMessage,
    rawSocket: Duplex,
    head: Buffer,
  ): BrowserWebSocketStream {
    const stream = this.#baseStream<BrowserWebSocketStream>({
      kind: "websocket",
      request,
      rawSocket,
      head,
      accepted: deferred<void>(),
      inboundSequence: 0,
      outboundSequence: 0,
    }, access);
    rawSocket.once("close", () => this.#failStream(stream, "stream_cancelled", stream.dispatched));
    return stream;
  }

  #baseStream<T extends PreviewStream>(
    value: Omit<T, keyof StreamBase>,
    access: PreviewAccess,
  ): T {
    const id = randomUUID();
    const stream = {
      ...value,
      id,
      access,
      connector: access.connector,
      requestCredit: previewLimits.initialWindowBytes,
      responseOffset: 0,
      requestOffset: 0,
      dispatched: false,
      settled: false,
      idleTimer: setTimeout(() => undefined, 0),
      lifetimeTimer: setTimeout(() => undefined, 0),
      done: deferred<void>(),
    } as T;
    clearTimeout(stream.idleTimer);
    clearTimeout(stream.lifetimeTimer);
    stream.idleTimer = setTimeout(() => this.#failStream(stream, "local_timeout", stream.dispatched), previewLimits.firstByteTimeoutMs);
    stream.lifetimeTimer = setTimeout(() => this.#failStream(stream, "local_timeout", stream.dispatched), previewLimits.maxLifetimeMs);
    stream.idleTimer.unref();
    stream.lifetimeTimer.unref();
    this.#streams.set(id, stream);
    return stream;
  }

  #acceptBrowserWebSocket(stream: BrowserWebSocketStream): void {
    const request = stream.request as IncomingMessage & { yurupagerProtocol?: string };
    if (stream.acceptedProtocol !== undefined) request.yurupagerProtocol = stream.acceptedProtocol;
    this.#browserWebSockets.handleUpgrade(request, stream.rawSocket, stream.head, (browser) => {
      stream.browser = browser;
      browser.on("message", (data, isBinary) => {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (buffer.byteLength > previewLimits.maxChunkBytes || buffer.byteLength > stream.requestCredit) {
          browser.close(1009, "Preview frame is too large");
          return;
        }
        this.#send(stream.connector, {
          type: "preview.ws.frame",
          streamId: stream.id,
          sequence: stream.outboundSequence++,
          binary: isBinary,
          data: buffer.toString("base64"),
        });
        stream.requestOffset += buffer.byteLength;
        stream.requestCredit -= buffer.byteLength;
        this.#touch(stream);
      });
      browser.on("close", (code, reason) => {
        if (!stream.settled) {
          this.#send(stream.connector, {
            type: "preview.ws.close",
            streamId: stream.id,
            code: validCloseCode(code) ? code : 1000,
            reason: truncateCloseReason(reason.toString()),
          });
          this.#finishStream(stream);
        }
      });
      browser.on("error", () => this.#failStream(stream, "stream_cancelled", stream.dispatched));
      stream.accepted.resolve();
    });
  }

  async #waitForCredit(stream: PreviewStream, bytes: number): Promise<void> {
    while (!stream.settled && stream.requestCredit < bytes) {
      await delay(5);
    }
    if (stream.settled) throw new PreviewStreamFailure("stream_cancelled", stream.dispatched);
  }

  #touch(stream: PreviewStream): void {
    clearTimeout(stream.idleTimer);
    stream.idleTimer = setTimeout(() => this.#failStream(stream, "local_timeout", stream.dispatched), previewLimits.idleTimeoutMs);
    stream.idleTimer.unref();
  }

  #grantHttpResponseCredit(stream: HttpStream): void {
    if (stream.settled || stream.pendingResponseCredit === 0) return;
    const creditBytes = stream.pendingResponseCredit;
    stream.pendingResponseCredit = 0;
    if (!this.#send(stream.connector, {
      type: "preview.flow",
      streamId: stream.id,
      direction: "response",
      ackOffset: stream.responseOffset,
      creditBytes,
    })) {
      this.#failStream(stream, "route_unavailable", stream.dispatched);
    }
  }

  #resumeHttpResponse(stream: HttpStream): void {
    if (stream.settled) return;
    stream.responseBackpressured = false;
    this.#grantHttpResponseCredit(stream);
    if (!stream.settled && stream.responseEndReceived) this.#completeHttpResponse(stream);
    else if (!stream.settled) this.#touch(stream);
  }

  #completeHttpResponse(stream: HttpStream): void {
    if (stream.settled) return;
    this.#grantHttpResponseCredit(stream);
    if (stream.settled) return;
    stream.response.end();
    this.#finishStream(stream);
  }

  #finishStream(stream: PreviewStream): void {
    if (stream.settled) return;
    stream.settled = true;
    clearTimeout(stream.idleTimer);
    clearTimeout(stream.lifetimeTimer);
    this.#streams.delete(stream.id);
    stream.done.resolve();
  }

  #failStream(stream: PreviewStream, code: PreviewTunnelErrorCode, dispatched: boolean): void {
    if (stream.settled) return;
    stream.settled = true;
    clearTimeout(stream.idleTimer);
    clearTimeout(stream.lifetimeTimer);
    this.#streams.delete(stream.id);
    this.#send(stream.connector, { type: "preview.stream.cancel", streamId: stream.id, reason: code });
    if (stream.kind === "http") {
      stream.accepted.reject(new PreviewStreamFailure(code, dispatched));
      if (!stream.response.headersSent) {
        if (dispatched && !isIdempotent(stream.method)) stream.response.setHeader("X-YuruPager-Outcome", "unknown");
        sendProxyError(
          stream.response,
          code === "request_too_large" ? 413 : code === "response_too_large" ? 502 : 504,
          dispatched && !isIdempotent(stream.method)
            ? "连接中断，本机请求可能已经执行；YuruPager 不会自动重试"
            : previewErrorLabel(code),
        );
      } else {
        stream.response.destroy();
      }
    } else {
      stream.accepted.reject(new PreviewStreamFailure(code, dispatched));
      if (stream.browser !== undefined) stream.browser.close(1011, "Preview connection closed");
      else stream.rawSocket.destroy();
    }
    stream.done.reject(new PreviewStreamFailure(code, dispatched));
  }

  async #reserveCapacity(access: PreviewAccess, signal: AbortSignal): Promise<CapacityEntry> {
    if (!this.#accessIsActive(access)) throw new PreviewAdmissionFailure("unavailable");
    if (this.#hasCapacity(access)) {
      const reservation = { access };
      this.#capacityReservations.add(reservation);
      return reservation;
    }

    let userWaiters = 0;
    let connectorWaiters = 0;
    for (const waiter of this.#capacityWaiters) {
      if (waiter.access.binding.userId === access.binding.userId) userWaiters += 1;
      if (waiter.access.connector === access.connector) connectorWaiters += 1;
    }
    if (
      userWaiters >= previewLimits.maxQueuedStreamsPerUser ||
      connectorWaiters >= previewLimits.maxQueuedStreamsPerConnector
    ) throw new PreviewAdmissionFailure("busy");

    const waiter = { access };
    const deadline = Date.now() + previewLimits.firstByteTimeoutMs;
    this.#capacityWaiters.add(waiter);
    try {
      while (true) {
        if (signal.aborted) throw new PreviewAdmissionFailure("cancelled");
        if (!this.#accessIsActive(access)) throw new PreviewAdmissionFailure("unavailable");
        if (this.#hasCapacity(access)) {
          const reservation = { access };
          this.#capacityReservations.add(reservation);
          return reservation;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new PreviewAdmissionFailure("busy");
        await abortableDelay(Math.min(10, remaining), signal);
      }
    } finally {
      this.#capacityWaiters.delete(waiter);
    }
  }

  #hasCapacity(access: PreviewAccess): boolean {
    let userStreams = 0;
    let connectorStreams = 0;
    for (const stream of this.#streams.values()) {
      if (stream.access.binding.userId === access.binding.userId) userStreams += 1;
      if (stream.connector === access.connector) connectorStreams += 1;
    }
    for (const reservation of this.#capacityReservations) {
      if (reservation.access.binding.userId === access.binding.userId) userStreams += 1;
      if (reservation.access.connector === access.connector) connectorStreams += 1;
    }
    return userStreams < previewLimits.maxConcurrentStreamsPerUser &&
      connectorStreams < previewLimits.maxConcurrentStreamsPerConnector;
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

function readPreviewHello(value: Record<string, unknown>, maxDurationMinutes: number): Extract<PreviewTunnelClientMessage, { type: "preview.hello" }> {
  if (value.protocolVersion !== 1 || !validUuid(value.connectionEpoch)) throw new Error("Invalid preview hello");
  return {
    type: "preview.hello",
    protocolVersion: 1,
    connectionEpoch: value.connectionEpoch,
    routes: readRoutes(value.routes, maxDurationMinutes),
  };
}

function readRouteSnapshot(value: Record<string, unknown>, maxDurationMinutes: number): Extract<PreviewTunnelClientMessage, { type: "preview.routes.snapshot" }> {
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw new Error("Invalid preview route revision");
  return { type: "preview.routes.snapshot", revision: value.revision as number, routes: readRoutes(value.routes, maxDurationMinutes) };
}

function readRoutes(value: unknown, maxDurationMinutes: number): ConnectorPreviewRoute[] {
  if (!Array.isArray(value) || value.length > previewLimits.maxRoutesPerWorkstation) throw new Error("Invalid preview routes");
  const now = Date.now();
  const maximum = now + maxDurationMinutes * 60_000 + routeClockToleranceMs;
  const seen = new Set<string>();
  return value.map((child): ConnectorPreviewRoute => {
    if (!isRecord(child) || !validUuid(child.routeId) || seen.has(child.routeId)) throw new Error("Invalid preview route ID");
    seen.add(child.routeId);
    const expiresAt = typeof child.expiresAt === "string" ? Date.parse(child.expiresAt) : Number.NaN;
    if (
      typeof child.name !== "string" || Array.from(child.name).length < 1 ||
      Array.from(child.name).length > previewLimits.maxNameCharacters || hasUnsafeControl(child.name) ||
      !Number.isSafeInteger(child.port) || (child.port as number) < previewLimits.minLocalPort ||
      (child.port as number) > previewLimits.maxLocalPort ||
      (child.status !== "active" && child.status !== "unreachable") ||
      !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > maximum
    ) throw new Error("Invalid preview route");
    return {
      routeId: child.routeId,
      name: child.name,
      port: child.port as number,
      status: child.status,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  });
}

function readPreviewClientStreamMessage(value: Record<string, unknown>): Exclude<PreviewTunnelClientMessage, { type: "preview.hello" | "preview.routes.snapshot" }> {
  if (!validUuid(value.streamId)) throw new Error("Invalid preview stream ID");
  const streamId = value.streamId;
  if (value.type === "preview.http.accepted" || value.type === "preview.http.response.end") return { type: value.type, streamId };
  if (value.type === "preview.http.response.start") {
    if (!validStatusCode(value.statusCode)) throw new Error("Invalid preview response status");
    return { type: value.type, streamId, statusCode: value.statusCode, headers: readHeaders(value.headers) };
  }
  if (value.type === "preview.http.response.chunk") {
    if (!Number.isSafeInteger(value.offset) || (value.offset as number) < 0 || typeof value.data !== "string") throw new Error("Invalid preview response chunk");
    decodeCanonicalChunk(value.data);
    return { type: value.type, streamId, offset: value.offset as number, data: value.data };
  }
  if (value.type === "preview.stream.error") {
    if (!isPreviewError(value.code) || typeof value.dispatched !== "boolean") throw new Error("Invalid preview stream error");
    return { type: value.type, streamId, code: value.code, dispatched: value.dispatched };
  }
  if (value.type === "preview.ws.accepted") {
    if (value.protocol !== undefined && (typeof value.protocol !== "string" || value.protocol.length > 128 || hasUnsafeControl(value.protocol))) throw new Error("Invalid preview protocol");
    return value.protocol === undefined ? { type: value.type, streamId } : { type: value.type, streamId, protocol: value.protocol };
  }
  if (value.type === "preview.ws.frame") {
    if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 || typeof value.binary !== "boolean" || typeof value.data !== "string") throw new Error("Invalid preview WebSocket frame");
    decodeCanonicalChunk(value.data);
    return { type: value.type, streamId, sequence: value.sequence as number, binary: value.binary, data: value.data };
  }
  if (value.type === "preview.ws.close") {
    if (!Number.isInteger(value.code) || typeof value.reason !== "string" || value.reason.length > 123 || hasUnsafeControl(value.reason)) throw new Error("Invalid preview WebSocket close");
    return { type: value.type, streamId, code: value.code as number, reason: value.reason };
  }
  if (value.type === "preview.flow") {
    if (
      (value.direction !== "request" && value.direction !== "response") ||
      !Number.isSafeInteger(value.ackOffset) || (value.ackOffset as number) < 0 ||
      !Number.isSafeInteger(value.creditBytes) || (value.creditBytes as number) < 0 ||
      (value.creditBytes as number) > previewLimits.initialWindowBytes
    ) throw new Error("Invalid preview flow update");
    return { type: value.type, streamId, direction: value.direction, ackOffset: value.ackOffset as number, creditBytes: value.creditBytes as number };
  }
  throw new Error("Unsupported preview message");
}

function readHeaders(value: unknown): PreviewHeader[] {
  if (!Array.isArray(value) || value.length > previewLimits.maxHeaderCount) throw new Error("Invalid preview headers");
  let bytes = 0;
  return value.map((child): PreviewHeader => {
    if (!Array.isArray(child) || child.length !== 2 || typeof child[0] !== "string" || typeof child[1] !== "string") throw new Error("Invalid preview header");
    const name = child[0].toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || hasUnsafeControl(child[1])) throw new Error("Invalid preview header");
    bytes += Buffer.byteLength(name) + Buffer.byteLength(child[1]);
    if (bytes > previewLimits.maxHeaderBytes) throw new Error("Preview headers are too large");
    return [name, child[1]];
  });
}

function decodeCanonicalChunk(value: string): Buffer {
  if (value.length < 1 || value.length > Math.ceil(previewLimits.maxChunkBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("Invalid preview Base64 chunk");
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.byteLength > previewLimits.maxChunkBytes || buffer.toString("base64") !== value) throw new Error("Non-canonical preview Base64 chunk");
  return buffer;
}

function readAccess(value: unknown): PreviewAccess {
  if (!isRecord(value) || !isRecord(value.binding) || !isRecord(value.preview) || !isRecord(value.connector)) {
    throw new Error("Invalid preview access");
  }
  return value as unknown as PreviewAccess;
}

function readContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error("Invalid Content-Length");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Invalid Content-Length");
  return parsed;
}

function parseProtocols(value: string | undefined): string[] {
  if (value === undefined) return [];
  const protocols = value.split(",").map((child) => child.trim());
  if (protocols.length > 16 || protocols.some((protocol) => protocol === "" || protocol.length > 128 || hasUnsafeControl(protocol))) {
    throw new Error("Invalid WebSocket protocol list");
  }
  return protocols;
}

function bindingMatchesPreview(
  binding: { previewId: string; workspaceId: string; workstationId: string; previewExpiresAt: number },
  preview: WorkstationPreviewSummary,
): boolean {
  return binding.previewId === preview.id && binding.workspaceId === preview.workspaceId &&
    binding.workstationId === preview.workstationId && binding.previewExpiresAt === new Date(preview.expiresAt).getTime();
}

function rewriteLocation(value: string, preview: WorkstationPreviewSummary, publicOrigin: string | null): string {
  if (publicOrigin === null) return value;
  try {
    const url = new URL(value);
    const local = (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") && Number(url.port || (url.protocol === "https:" ? 443 : 80)) === preview.port;
    if (!local) return value;
    return new URL(`${url.pathname}${url.search}${url.hash}`, publicOrigin).toString();
  } catch {
    return value;
  }
}

function routeKey(identity: ConnectorIdentity, routeId: string): string {
  return `${identity.workspaceId}:${identity.workstationId}:${routeId}`;
}

function sameIdentity(left: ConnectorIdentity, right: ConnectorIdentity): boolean {
  return left.workspaceId === right.workspaceId && left.workstationId === right.workstationId;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function validStatusCode(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599;
}

function validCloseCode(value: number): boolean {
  return value === 1000 || (value >= 1001 && value <= 1014 && ![1004, 1005, 1006].includes(value)) || (value >= 3000 && value <= 4999);
}

function truncateCloseReason(value: string): string {
  return Buffer.from(value, "utf8").subarray(0, 123).toString("utf8").replace(/\uFFFD$/u, "");
}

function hasUnsafeControl(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function isPreviewError(value: unknown): value is PreviewTunnelErrorCode {
  return value === "route_unavailable" || value === "local_connection_failed" || value === "local_timeout" ||
    value === "request_too_large" || value === "response_too_large" || value === "protocol_error" || value === "stream_cancelled";
}

function previewErrorLabel(code: PreviewTunnelErrorCode): string {
  return code === "route_unavailable" ? "本机预览路由不可用" :
    code === "local_connection_failed" ? "无法连接工作站本机端口" :
      code === "local_timeout" ? "工作站本机服务响应超时" :
        code === "request_too_large" ? "请求正文超过开发预览限制" :
          code === "response_too_large" ? "响应正文超过开发预览限制" :
            code === "protocol_error" ? "开发预览协议错误" : "开发预览已取消";
}

function isIdempotent(method: PreviewHttpMethod): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function sendProxyError(response: ServerResponse, statusCode: number, message: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = `${message}\n`;
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // A stream may fail before its sequential consumer reaches this promise.
  void promise.catch(() => undefined);
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

class PreviewStreamFailure extends Error {
  constructor(readonly code: PreviewTunnelErrorCode, readonly dispatched: boolean) {
    super(code);
  }
}

class PreviewAdmissionFailure extends Error {
  constructor(readonly reason: "busy" | "cancelled" | "unavailable") {
    super(reason);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new PreviewAdmissionFailure("cancelled"));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(new PreviewAdmissionFailure("cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function rejectProxyUpgrade(socket: Duplex, statusCode: number, message: string): void {
  if (socket.destroyed) return;
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusCode === 503 ? "Service Unavailable" : "Gateway Timeout"}\r\n` +
    "Connection: close\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
    body,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
