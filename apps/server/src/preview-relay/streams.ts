import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type {
  PreviewHttpMethod,
  PreviewTunnelClientMessage,
  PreviewTunnelErrorCode,
  PreviewTunnelServerMessage,
} from "@yurupager/shared";
import { previewLimits } from "@yurupager/shared";
import { WebSocketServer } from "ws";

import { sanitizePreviewResponseHeaders } from "../preview-security.js";
import {
  decodeCanonicalChunk,
  isIdempotent,
  previewErrorLabel,
  rewriteLocation,
  sendProxyError,
  truncateCloseReason,
  validCloseCode,
  validStatusCode,
} from "./protocol.js";
import type {
  BrowserWebSocketStream,
  HttpStream,
  PreviewAccess,
  PreviewConnection,
  PreviewStream,
  StreamBase,
} from "./types.js";
import { deferred, delay, PreviewStreamFailure } from "./types.js";

export interface StreamRegistryContext {
  send(connection: PreviewConnection, message: PreviewTunnelServerMessage): boolean;
  publicOrigin: string | null;
}

/**
 * Owns the per-stream state machine for proxied HTTP and WebSocket traffic:
 * stream registration, timers, credit/backpressure bookkeeping (流控),
 * browser-side WebSocket upgrade, and terminal failure handling. Stream
 * payloads stay in memory and are never persisted.
 */
export class PreviewStreamRegistry {
  readonly #streams = new Map<string, PreviewStream>();
  readonly #browserWebSockets = new WebSocketServer({
    noServer: true,
    maxPayload: previewLimits.maxChunkBytes,
    handleProtocols(protocols, request) {
      const accepted = (request as IncomingMessage & { yurupagerProtocol?: string }).yurupagerProtocol;
      return accepted !== undefined && protocols.has(accepted) ? accepted : false;
    },
  });
  readonly #context: StreamRegistryContext;

  constructor(context: StreamRegistryContext) {
    this.#context = context;
  }

  values(): IterableIterator<PreviewStream> {
    return this.#streams.values();
  }

  handleStreamMessage(
    connection: PreviewConnection,
    message: Exclude<PreviewTunnelClientMessage, { type: "preview.hello" | "preview.routes.snapshot" }>,
  ): void {
    const stream = this.#streams.get(message.streamId);
    if (stream === undefined || stream.connector !== connection) return;
    this.touch(stream);
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
            stream.response.appendHeader(name, rewriteLocation(value, stream.access.preview, this.#context.publicOrigin));
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
        this.#context.send(stream.connector, {
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

  createHttpStream(
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

  createWebSocketStream(
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

  async waitForCredit(stream: PreviewStream, bytes: number): Promise<void> {
    while (!stream.settled && stream.requestCredit < bytes) {
      await delay(5);
    }
    if (stream.settled) throw new PreviewStreamFailure("stream_cancelled", stream.dispatched);
  }

  touch(stream: PreviewStream): void {
    clearTimeout(stream.idleTimer);
    stream.idleTimer = setTimeout(() => this.#failStream(stream, "local_timeout", stream.dispatched), previewLimits.idleTimeoutMs);
    stream.idleTimer.unref();
  }

  failAllForConnector(connection: PreviewConnection): void {
    for (const stream of [...this.#streams.values()]) {
      if (stream.connector === connection) this.#failStream(stream, "route_unavailable", stream.dispatched);
    }
  }

  failAllForPreview(previewId: string): void {
    for (const stream of [...this.#streams.values()]) {
      if (stream.access.preview.id === previewId) this.#failStream(stream, "route_unavailable", stream.dispatched);
    }
  }

  failStream(stream: PreviewStream, code: PreviewTunnelErrorCode, dispatched: boolean): void {
    this.#failStream(stream, code, dispatched);
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
        this.#context.send(stream.connector, {
          type: "preview.ws.frame",
          streamId: stream.id,
          sequence: stream.outboundSequence++,
          binary: isBinary,
          data: buffer.toString("base64"),
        });
        stream.requestOffset += buffer.byteLength;
        stream.requestCredit -= buffer.byteLength;
        this.touch(stream);
      });
      browser.on("close", (code, reason) => {
        if (!stream.settled) {
          this.#context.send(stream.connector, {
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

  #grantHttpResponseCredit(stream: HttpStream): void {
    if (stream.settled || stream.pendingResponseCredit === 0) return;
    const creditBytes = stream.pendingResponseCredit;
    stream.pendingResponseCredit = 0;
    if (!this.#context.send(stream.connector, {
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
    else if (!stream.settled) this.touch(stream);
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
    this.#context.send(stream.connector, { type: "preview.stream.cancel", streamId: stream.id, reason: code });
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
}
