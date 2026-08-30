import { Buffer } from "node:buffer";

import {
  previewLimits,
  type PreviewHeader,
  type PreviewHttpMethod,
  type PreviewTunnelServerMessage,
} from "@yurupager/shared";

const methods = new Set<PreviewHttpMethod>(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const blockedRequestHeaders = new Set([
  "authorization",
  "connection",
  "forwarded",
  "host",
  "origin",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "referer",
  "service-worker",
  "service-worker-navigation-preload",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);
const blockedResponseHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "service-worker-allowed",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function readPreviewServerMessage(value: unknown): PreviewTunnelServerMessage {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("Invalid preview message");
  switch (value.type) {
    case "preview.welcome":
      requireId(value.connectionEpoch, "connectionEpoch");
      requireInteger(value.maxChunkBytes, 1, previewLimits.maxChunkBytes, "maxChunkBytes");
      requireInteger(value.initialWindowBytes, 1, previewLimits.initialWindowBytes, "initialWindowBytes");
      break;
    case "preview.http.open":
      requireId(value.streamId, "streamId");
      requireId(value.routeId, "routeId");
      if (typeof value.method !== "string" || !methods.has(value.method as PreviewHttpMethod)) {
        throw new Error("Invalid preview HTTP method");
      }
      requirePreviewPath(value.path);
      readPreviewHeaders(value.headers, "request");
      if (value.bodyLength !== undefined) {
        requireInteger(value.bodyLength, 0, previewLimits.maxRequestBytes, "bodyLength");
      }
      break;
    case "preview.http.request.chunk":
      requireId(value.streamId, "streamId");
      requireInteger(value.offset, 0, previewLimits.maxRequestBytes, "offset");
      decodePreviewChunk(value.data, previewLimits.maxChunkBytes);
      break;
    case "preview.http.request.end":
      requireId(value.streamId, "streamId");
      break;
    case "preview.stream.cancel":
      requireId(value.streamId, "streamId");
      requireReason(value.reason);
      break;
    case "preview.route.stop":
      requireId(value.routeId, "routeId");
      if (
        value.reason !== "user_stopped" && value.reason !== "expired" &&
        value.reason !== "permission_revoked" && value.reason !== "server_shutdown"
      ) throw new Error("Invalid preview route stop reason");
      break;
    case "preview.ws.open":
      requireId(value.streamId, "streamId");
      requireId(value.routeId, "routeId");
      requirePreviewPath(value.path);
      readPreviewHeaders(value.headers, "request");
      if (!Array.isArray(value.protocols) || value.protocols.length > 16 || !value.protocols.every(isWebSocketProtocol)) {
        throw new Error("Invalid preview WebSocket protocols");
      }
      if (new Set(value.protocols).size !== value.protocols.length) throw new Error("Duplicate preview WebSocket protocol");
      break;
    case "preview.ws.frame":
      requireId(value.streamId, "streamId");
      requireInteger(value.sequence, 0, Number.MAX_SAFE_INTEGER, "sequence");
      if (typeof value.binary !== "boolean") throw new Error("Invalid preview WebSocket frame type");
      decodePreviewChunk(value.data, previewLimits.maxChunkBytes);
      break;
    case "preview.ws.close":
      requireId(value.streamId, "streamId");
      if (!isWebSocketCloseCode(value.code)) throw new Error("Invalid preview WebSocket close code");
      requireReason(value.reason);
      if (Buffer.byteLength(value.reason, "utf8") > 123) throw new Error("Preview WebSocket close reason is too long");
      break;
    case "preview.flow":
      requireId(value.streamId, "streamId");
      if (value.direction !== "request" && value.direction !== "response") throw new Error("Invalid preview flow direction");
      requireInteger(value.ackOffset, 0, Number.MAX_SAFE_INTEGER, "ackOffset");
      requireInteger(value.creditBytes, 0, previewLimits.initialWindowBytes, "creditBytes");
      break;
    default:
      throw new Error("Unknown preview message type");
  }
  return value as PreviewTunnelServerMessage;
}

export function readPreviewHeaders(value: unknown, direction: "request" | "response"): PreviewHeader[] {
  if (!Array.isArray(value) || value.length > previewLimits.maxHeaderCount) {
    throw new Error("Too many preview headers");
  }
  let bytes = 0;
  const blocked = direction === "request" ? blockedRequestHeaders : blockedResponseHeaders;
  const result: PreviewHeader[] = [];
  for (const header of value) {
    if (!Array.isArray(header) || header.length !== 2 || typeof header[0] !== "string" || typeof header[1] !== "string") {
      throw new Error("Invalid preview header");
    }
    const name = header[0].toLowerCase();
    const content = header[1];
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name) || /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(content)) {
      throw new Error("Invalid preview header characters");
    }
    bytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(content, "utf8") + 4;
    if (bytes > previewLimits.maxHeaderBytes) throw new Error("Preview headers are too large");
    if (!blocked.has(name) && name !== "content-length") result.push([name, content]);
  }
  return result;
}

export function requirePreviewPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > previewLimits.maxPathBytes
  ) {
    throw new Error("Preview path must use origin-form");
  }
}

export function decodePreviewChunk(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
    throw new Error("Invalid preview chunk encoding");
  }
  const data = Buffer.from(value, "base64");
  if (data.length === 0 || data.length > maxBytes || data.toString("base64") !== value) {
    throw new Error("Invalid preview chunk encoding");
  }
  return data;
}

export function isWebSocketCloseCode(value: unknown): value is number {
  return Number.isInteger(value) && (
    value === 1000 || value === 1001 || value === 1002 || value === 1003 ||
    (typeof value === "number" && value >= 1007 && value <= 1014) ||
    (typeof value === "number" && value >= 3000 && value <= 4999)
  );
}

function requireId(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[^A-Za-z0-9._:-]/u.test(value)) {
    throw new Error(`Invalid preview ${name}`);
  }
}

function requireInteger(value: unknown, minimum: number, maximum: number, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`Invalid preview ${name}`);
  }
}

function requireReason(value: unknown): asserts value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 512 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error("Invalid preview reason");
  }
}

function isWebSocketProtocol(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
