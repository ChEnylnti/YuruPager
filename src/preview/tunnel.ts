import { Buffer } from "node:buffer";
import { request, type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";

import {
  previewLimits,
  type PreviewHeader,
  type PreviewTunnelClientMessage,
  type PreviewTunnelErrorCode,
  type PreviewTunnelServerMessage,
} from "@yurupager/shared";
import WebSocket, { type RawData } from "ws";

import { decodePreviewChunk, readPreviewHeaders } from "./protocol.js";
import { loopbackAuthority, type PreviewLoopbackTarget } from "./target.js";

interface StreamTimers {
  firstByte: NodeJS.Timeout | undefined;
  idle: NodeJS.Timeout;
  lifetime: NodeJS.Timeout;
}

interface HttpStream {
  kind: "http";
  id: string;
  request: ClientRequest;
  response: IncomingMessage | undefined;
  requestOffset: number;
  requestAckOffset: number;
  requestEnded: boolean;
  bodyLength: number | undefined;
  responseOffset: number;
  responseAckOffset: number;
  responseCredit: number;
  responseBytes: number;
  responseQueue: Buffer[];
  responseEnded: boolean;
  dispatched: boolean;
  timers: StreamTimers;
}

interface QueuedWebSocketFrame {
  data: Buffer;
  binary: boolean;
}

interface WebSocketStream {
  kind: "websocket";
  id: string;
  socket: WebSocket;
  requestSequence: number;
  requestOffset: number;
  requestAckOffset: number;
  responseSequence: number;
  responseOffset: number;
  responseAckOffset: number;
  responseCredit: number;
  responseBytes: number;
  responseQueue: QueuedWebSocketFrame[];
  opened: boolean;
  remoteClosing: boolean;
  dispatched: boolean;
  timers: StreamTimers;
}

type PreviewStream = HttpStream | WebSocketStream;

export interface PreviewTunnelOptions {
  routeId: string;
  target: PreviewLoopbackTarget;
  maxChunkBytes: number;
  initialWindowBytes: number;
  send: (message: PreviewTunnelClientMessage) => boolean;
  firstByteTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
}

export class PreviewTunnel {
  readonly #routeId: string;
  readonly #target: PreviewLoopbackTarget;
  readonly #maxChunkBytes: number;
  readonly #initialWindowBytes: number;
  readonly #send: (message: PreviewTunnelClientMessage) => boolean;
  readonly #firstByteTimeoutMs: number;
  readonly #idleTimeoutMs: number;
  readonly #maxLifetimeMs: number;
  readonly #streams = new Map<string, PreviewStream>();
  #closed = false;

  constructor(options: PreviewTunnelOptions) {
    this.#routeId = options.routeId;
    this.#target = options.target;
    this.#maxChunkBytes = Math.min(options.maxChunkBytes, previewLimits.maxChunkBytes);
    this.#initialWindowBytes = Math.min(options.initialWindowBytes, previewLimits.initialWindowBytes);
    this.#send = options.send;
    this.#firstByteTimeoutMs = options.firstByteTimeoutMs ?? previewLimits.firstByteTimeoutMs;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? previewLimits.idleTimeoutMs;
    this.#maxLifetimeMs = options.maxLifetimeMs ?? previewLimits.maxLifetimeMs;
  }

  get activeStreamCount(): number {
    return this.#streams.size;
  }

  handle(message: Exclude<PreviewTunnelServerMessage, { type: "preview.welcome" | "preview.route.stop" }>): void {
    if (this.#closed) return;
    switch (message.type) {
      case "preview.http.open":
        this.#openHttp(message);
        return;
      case "preview.http.request.chunk":
        this.#writeHttpChunk(message.streamId, message.offset, message.data);
        return;
      case "preview.http.request.end":
        this.#endHttpRequest(message.streamId);
        return;
      case "preview.stream.cancel":
        this.#cancel(message.streamId);
        return;
      case "preview.ws.open":
        this.#openWebSocket(message);
        return;
      case "preview.ws.frame":
        this.#writeWebSocketFrame(message.streamId, message.sequence, message.binary, message.data);
        return;
      case "preview.ws.close":
        this.#closeWebSocket(message.streamId, message.code, message.reason);
        return;
      case "preview.flow":
        this.#grantResponseCredit(message.streamId, message.direction, message.ackOffset, message.creditBytes);
        return;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const stream of this.#streams.values()) this.#destroyStream(stream);
    this.#streams.clear();
  }

  #openHttp(message: Extract<PreviewTunnelServerMessage, { type: "preview.http.open" }>): void {
    if (!this.#canOpen(message.streamId, message.routeId)) return;
    let headers: OutgoingHttpHeaders;
    try {
      headers = outgoingHeaders(readPreviewHeaders(message.headers, "request"), this.#target, message.bodyLength);
    } catch {
      this.#sendError(message.streamId, "protocol_error", false);
      return;
    }

    const localRequest = request({
      host: this.#target.host,
      port: this.#target.port,
      method: message.method,
      path: message.path,
      headers,
      agent: false,
    });
    const stream: HttpStream = {
      kind: "http",
      id: message.streamId,
      request: localRequest,
      response: undefined,
      requestOffset: 0,
      requestAckOffset: 0,
      requestEnded: false,
      bodyLength: message.bodyLength,
      responseOffset: 0,
      responseAckOffset: 0,
      responseCredit: this.#initialWindowBytes,
      responseBytes: 0,
      responseQueue: [],
      responseEnded: false,
      dispatched: false,
      timers: this.#createTimers(message.streamId),
    };
    this.#streams.set(stream.id, stream);
    localRequest.once("socket", () => { stream.dispatched = true; });
    localRequest.once("response", (response) => this.#startHttpResponse(stream, response));
    localRequest.once("error", (error) => {
      if (!this.#streams.has(stream.id)) return;
      this.#fail(stream, isTimeoutError(error) ? "local_timeout" : "local_connection_failed");
    });
    this.#send({ type: "preview.http.accepted", streamId: stream.id });
    localRequest.flushHeaders();
  }

  #writeHttpChunk(streamId: string, offset: number, encoded: string): void {
    const stream = this.#streams.get(streamId);
    if (stream?.kind !== "http" || stream.requestEnded) {
      this.#protocolFailure(streamId, stream);
      return;
    }
    let chunk: Buffer;
    try { chunk = decodePreviewChunk(encoded, this.#maxChunkBytes); }
    catch { this.#protocolFailure(streamId, stream); return; }
    const nextOffset = stream.requestOffset + chunk.length;
    if (
      offset !== stream.requestOffset ||
      nextOffset > previewLimits.maxRequestBytes ||
      (stream.bodyLength !== undefined && nextOffset > stream.bodyLength) ||
      nextOffset - stream.requestAckOffset > this.#initialWindowBytes
    ) {
      this.#protocolFailure(streamId, stream);
      return;
    }
    stream.requestOffset = nextOffset;
    this.#touch(stream);
    stream.request.write(chunk, (error?: Error | null) => {
      if (error || !this.#streams.has(stream.id)) return;
      stream.requestAckOffset = Math.max(stream.requestAckOffset, nextOffset);
      this.#send({
        type: "preview.flow",
        streamId,
        direction: "request",
        ackOffset: nextOffset,
        creditBytes: chunk.length,
      });
      this.#touch(stream);
    });
  }

  #endHttpRequest(streamId: string): void {
    const stream = this.#streams.get(streamId);
    if (
      stream?.kind !== "http" ||
      stream.requestEnded ||
      (stream.bodyLength !== undefined && stream.requestOffset !== stream.bodyLength)
    ) {
      this.#protocolFailure(streamId, stream);
      return;
    }
    stream.requestEnded = true;
    this.#touch(stream);
    stream.request.end();
  }

  #startHttpResponse(stream: HttpStream, response: IncomingMessage): void {
    if (!this.#streams.has(stream.id)) {
      response.destroy();
      return;
    }
    stream.response = response;
    if (stream.timers.firstByte !== undefined) clearTimeout(stream.timers.firstByte);
    stream.timers.firstByte = undefined;
    let headers: PreviewHeader[];
    try { headers = responseHeaders(response.rawHeaders); }
    catch { this.#fail(stream, "response_too_large"); return; }
    this.#send({
      type: "preview.http.response.start",
      streamId: stream.id,
      statusCode: response.statusCode ?? 502,
      headers,
    });
    this.#touch(stream);
    response.on("data", (raw: Buffer) => {
      if (!this.#streams.has(stream.id)) return;
      const data = Buffer.from(raw);
      stream.responseBytes += data.length;
      if (stream.responseBytes > previewLimits.maxResponseBytes) {
        this.#fail(stream, "response_too_large");
        return;
      }
      response.pause();
      for (let offset = 0; offset < data.length; offset += this.#maxChunkBytes) {
        stream.responseQueue.push(data.subarray(offset, Math.min(data.length, offset + this.#maxChunkBytes)));
      }
      this.#touch(stream);
      this.#flushHttpResponse(stream);
    });
    response.once("end", () => {
      if (!this.#streams.has(stream.id)) return;
      stream.responseEnded = true;
      this.#flushHttpResponse(stream);
    });
    response.once("error", (error) => {
      if (this.#streams.has(stream.id)) this.#fail(stream, isTimeoutError(error) ? "local_timeout" : "local_connection_failed");
    });
  }

  #flushHttpResponse(stream: HttpStream): void {
    while (stream.responseQueue.length > 0) {
      const chunk = stream.responseQueue[0];
      if (chunk === undefined || stream.responseCredit < chunk.length) break;
      stream.responseQueue.shift();
      stream.responseCredit -= chunk.length;
      const offset = stream.responseOffset;
      stream.responseOffset += chunk.length;
      if (!this.#send({
        type: "preview.http.response.chunk",
        streamId: stream.id,
        offset,
        data: chunk.toString("base64"),
      })) {
        this.#cancel(stream.id);
        return;
      }
    }
    if (stream.responseQueue.length === 0) {
      if (stream.responseEnded) {
        this.#send({ type: "preview.http.response.end", streamId: stream.id });
        this.#finish(stream);
      } else {
        stream.response?.resume();
      }
    }
  }

  #openWebSocket(message: Extract<PreviewTunnelServerMessage, { type: "preview.ws.open" }>): void {
    if (!this.#canOpen(message.streamId, message.routeId)) return;
    let headers: OutgoingHttpHeaders;
    try { headers = outgoingHeaders(readPreviewHeaders(message.headers, "request"), this.#target); }
    catch { this.#sendError(message.streamId, "protocol_error", false); return; }
    delete headers.origin;
    const authority = loopbackAuthority(this.#target);
    const socket = new WebSocket(`ws://${authority}${message.path}`, message.protocols, {
      headers,
      handshakeTimeout: this.#firstByteTimeoutMs,
      followRedirects: false,
      maxPayload: this.#maxChunkBytes,
    });
    const stream: WebSocketStream = {
      kind: "websocket",
      id: message.streamId,
      socket,
      requestSequence: 0,
      requestOffset: 0,
      requestAckOffset: 0,
      responseSequence: 0,
      responseOffset: 0,
      responseAckOffset: 0,
      responseCredit: this.#initialWindowBytes,
      responseBytes: 0,
      responseQueue: [],
      opened: false,
      remoteClosing: false,
      dispatched: true,
      timers: this.#createTimers(message.streamId),
    };
    this.#streams.set(stream.id, stream);
    socket.once("open", () => {
      if (!this.#streams.has(stream.id)) return;
      stream.opened = true;
      if (stream.timers.firstByte !== undefined) clearTimeout(stream.timers.firstByte);
      stream.timers.firstByte = undefined;
      const protocol = socket.protocol || undefined;
      this.#send(protocol === undefined
        ? { type: "preview.ws.accepted", streamId: stream.id }
        : { type: "preview.ws.accepted", streamId: stream.id, protocol });
      this.#touch(stream);
    });
    socket.on("message", (raw, binary) => this.#queueWebSocketResponse(stream, raw, binary));
    socket.once("error", (error) => {
      if (this.#streams.has(stream.id)) this.#fail(stream, isTimeoutError(error) ? "local_timeout" : "local_connection_failed");
    });
    socket.once("close", (code, reason) => {
      if (!this.#streams.has(stream.id)) return;
      if (!stream.remoteClosing) {
        this.#send({
          type: "preview.ws.close",
          streamId: stream.id,
          code: safeCloseCode(code),
          reason: truncateUtf8(reason.toString(), 123),
        });
      }
      this.#finish(stream);
    });
  }

  #writeWebSocketFrame(streamId: string, sequence: number, binary: boolean, encoded: string): void {
    const stream = this.#streams.get(streamId);
    if (stream?.kind !== "websocket" || !stream.opened || sequence !== stream.requestSequence) {
      this.#protocolFailure(streamId, stream);
      return;
    }
    let data: Buffer;
    try { data = decodePreviewChunk(encoded, this.#maxChunkBytes); }
    catch { this.#protocolFailure(streamId, stream); return; }
    const nextOffset = stream.requestOffset + data.length;
    if (nextOffset - stream.requestAckOffset > this.#initialWindowBytes) {
      this.#protocolFailure(streamId, stream);
      return;
    }
    stream.requestSequence += 1;
    stream.requestOffset = nextOffset;
    this.#touch(stream);
    stream.socket.send(data, { binary }, (error) => {
      if (error || !this.#streams.has(stream.id)) return;
      stream.requestAckOffset = Math.max(stream.requestAckOffset, nextOffset);
      this.#send({
        type: "preview.flow",
        streamId,
        direction: "request",
        ackOffset: nextOffset,
        creditBytes: data.length,
      });
      this.#touch(stream);
    });
  }

  #queueWebSocketResponse(stream: WebSocketStream, raw: RawData, binary: boolean): void {
    if (!this.#streams.has(stream.id)) return;
    const data = rawDataBuffer(raw);
    stream.responseBytes += data.length;
    if (data.length === 0 || data.length > this.#maxChunkBytes || stream.responseBytes > previewLimits.maxResponseBytes) {
      this.#fail(stream, "response_too_large");
      return;
    }
    stream.socket.pause();
    stream.responseQueue.push({ data, binary });
    this.#touch(stream);
    this.#flushWebSocketResponse(stream);
  }

  #flushWebSocketResponse(stream: WebSocketStream): void {
    while (stream.responseQueue.length > 0) {
      const frame = stream.responseQueue[0];
      if (frame === undefined || stream.responseCredit < frame.data.length) break;
      stream.responseQueue.shift();
      stream.responseCredit -= frame.data.length;
      const sequence = stream.responseSequence++;
      stream.responseOffset += frame.data.length;
      if (!this.#send({
        type: "preview.ws.frame",
        streamId: stream.id,
        sequence,
        binary: frame.binary,
        data: frame.data.toString("base64"),
      })) {
        this.#cancel(stream.id);
        return;
      }
    }
    if (stream.responseQueue.length === 0 && stream.socket.readyState === WebSocket.OPEN) stream.socket.resume();
  }

  #closeWebSocket(streamId: string, code: number, reason: string): void {
    const stream = this.#streams.get(streamId);
    if (stream?.kind !== "websocket") {
      this.#protocolFailure(streamId, stream);
      return;
    }
    stream.remoteClosing = true;
    stream.socket.close(code, reason);
    this.#touch(stream);
  }

  #grantResponseCredit(streamId: string, direction: "request" | "response", ackOffset: number, creditBytes: number): void {
    const stream = this.#streams.get(streamId);
    if (
      stream === undefined ||
      direction !== "response" ||
      ackOffset < stream.responseAckOffset ||
      ackOffset > stream.responseOffset
    ) {
      this.#protocolFailure(streamId, stream);
      return;
    }
    stream.responseAckOffset = ackOffset;
    stream.responseCredit = Math.min(this.#initialWindowBytes, stream.responseCredit + creditBytes);
    this.#touch(stream);
    if (stream.kind === "http") this.#flushHttpResponse(stream);
    else this.#flushWebSocketResponse(stream);
  }

  #canOpen(streamId: string, routeId: string): boolean {
    if (routeId !== this.#routeId) {
      this.#sendError(streamId, "route_unavailable", false);
      return false;
    }
    if (this.#streams.has(streamId) || this.#streams.size >= previewLimits.maxConcurrentStreamsPerConnector) {
      this.#sendError(streamId, "protocol_error", false);
      return false;
    }
    return true;
  }

  #createTimers(streamId: string): StreamTimers {
    return {
      firstByte: setTimeout(() => this.#timeout(streamId), this.#firstByteTimeoutMs),
      idle: setTimeout(() => this.#timeout(streamId), this.#idleTimeoutMs),
      lifetime: setTimeout(() => this.#timeout(streamId), this.#maxLifetimeMs),
    };
  }

  #touch(stream: PreviewStream): void {
    clearTimeout(stream.timers.idle);
    stream.timers.idle = setTimeout(() => this.#timeout(stream.id), this.#idleTimeoutMs);
  }

  #timeout(streamId: string): void {
    const stream = this.#streams.get(streamId);
    if (stream !== undefined) this.#fail(stream, "local_timeout");
  }

  #protocolFailure(streamId: string, stream: PreviewStream | undefined): void {
    if (stream === undefined) {
      this.#sendError(streamId, "protocol_error", false);
      return;
    }
    this.#fail(stream, "protocol_error");
  }

  #fail(stream: PreviewStream, code: PreviewTunnelErrorCode): void {
    if (!this.#streams.has(stream.id)) return;
    this.#sendError(stream.id, code, stream.dispatched);
    this.#destroyStream(stream);
    this.#streams.delete(stream.id);
  }

  #cancel(streamId: string): void {
    const stream = this.#streams.get(streamId);
    if (stream === undefined) return;
    this.#destroyStream(stream);
    this.#streams.delete(stream.id);
  }

  #finish(stream: PreviewStream): void {
    if (!this.#streams.has(stream.id)) return;
    this.#clearTimers(stream);
    this.#streams.delete(stream.id);
  }

  #destroyStream(stream: PreviewStream): void {
    this.#clearTimers(stream);
    if (stream.kind === "http") {
      stream.response?.destroy();
      stream.request.destroy();
    } else {
      stream.socket.removeAllListeners();
      // A cancelled CONNECTING ws can emit an asynchronous handshake error
      // after its normal listeners have been removed. Keep a terminal
      // listener so cancellation never becomes an uncaught process error.
      stream.socket.once("error", () => undefined);
      if (stream.socket.readyState !== WebSocket.CLOSED) stream.socket.terminate();
    }
  }

  #clearTimers(stream: PreviewStream): void {
    if (stream.timers.firstByte !== undefined) clearTimeout(stream.timers.firstByte);
    clearTimeout(stream.timers.idle);
    clearTimeout(stream.timers.lifetime);
  }

  #sendError(streamId: string, code: PreviewTunnelErrorCode, dispatched: boolean): void {
    this.#send({ type: "preview.stream.error", streamId, code, dispatched });
  }
}

function outgoingHeaders(headers: PreviewHeader[], target: PreviewLoopbackTarget, bodyLength?: number): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {
    host: loopbackAuthority(target),
    origin: `http://${loopbackAuthority(target)}`,
  };
  for (const [name, value] of headers) {
    const existing = result[name];
    if (existing === undefined) result[name] = value;
    else if (Array.isArray(existing)) result[name] = [...existing, value];
    else result[name] = [String(existing), value];
  }
  if (bodyLength !== undefined) result["content-length"] = bodyLength;
  return result;
}

function responseHeaders(rawHeaders: string[]): PreviewHeader[] {
  const headers: PreviewHeader[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.push([name, value]);
  }
  return readPreviewHeaders(headers, "response");
}

function rawDataBuffer(raw: RawData): Buffer {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  return Buffer.from(raw);
}

function safeCloseCode(code: number): number {
  if (code === 1000 || code === 1001 || code === 1002 || code === 1003 || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) {
    return code;
  }
  return 1001;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maximumBytes) break;
    result += character;
  }
  return result;
}

function isTimeoutError(error: Error): boolean {
  return "code" in error && (error.code === "ETIMEDOUT" || error.code === "ESOCKETTIMEDOUT");
}
