import type { ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type {
  ConnectorPreviewRoute,
  PreviewHeader,
  PreviewHttpMethod,
  PreviewTunnelClientMessage,
  PreviewTunnelErrorCode,
  WorkstationPreviewSummary,
} from "@yurupager/shared";
import { previewLimits } from "@yurupager/shared";

import type { ConnectorIdentity } from "../connector-repository.js";
import type { PreviewAccess } from "./types.js";

export const routeClockToleranceMs = 30_000;

export function readPreviewHello(
  value: Record<string, unknown>,
  maxDurationMinutes: number,
): Extract<PreviewTunnelClientMessage, { type: "preview.hello" }> {
  if (value.protocolVersion !== 1 || !validUuid(value.connectionEpoch)) throw new Error("Invalid preview hello");
  return {
    type: "preview.hello",
    protocolVersion: 1,
    connectionEpoch: value.connectionEpoch,
    routes: readRoutes(value.routes, maxDurationMinutes),
  };
}

export function readRouteSnapshot(
  value: Record<string, unknown>,
  maxDurationMinutes: number,
): Extract<PreviewTunnelClientMessage, { type: "preview.routes.snapshot" }> {
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

export function readPreviewClientStreamMessage(
  value: Record<string, unknown>,
): Exclude<PreviewTunnelClientMessage, { type: "preview.hello" | "preview.routes.snapshot" }> {
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

export function decodeCanonicalChunk(value: string): Buffer {
  if (value.length < 1 || value.length > Math.ceil(previewLimits.maxChunkBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("Invalid preview Base64 chunk");
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.byteLength > previewLimits.maxChunkBytes || buffer.toString("base64") !== value) throw new Error("Non-canonical preview Base64 chunk");
  return buffer;
}

export function readAccess(value: unknown): PreviewAccess {
  if (!isRecord(value) || !isRecord(value.binding) || !isRecord(value.preview) || !isRecord(value.connector)) {
    throw new Error("Invalid preview access");
  }
  return value as unknown as PreviewAccess;
}

export function readContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error("Invalid Content-Length");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Invalid Content-Length");
  return parsed;
}

export function parseProtocols(value: string | undefined): string[] {
  if (value === undefined) return [];
  const protocols = value.split(",").map((child) => child.trim());
  if (protocols.length > 16 || protocols.some((protocol) => protocol === "" || protocol.length > 128 || hasUnsafeControl(protocol))) {
    throw new Error("Invalid WebSocket protocol list");
  }
  return protocols;
}

export function bindingMatchesPreview(
  binding: { previewId: string; workspaceId: string; workstationId: string; previewExpiresAt: number },
  preview: WorkstationPreviewSummary,
): boolean {
  return binding.previewId === preview.id && binding.workspaceId === preview.workspaceId &&
    binding.workstationId === preview.workstationId && binding.previewExpiresAt === new Date(preview.expiresAt).getTime();
}

export function rewriteLocation(value: string, preview: WorkstationPreviewSummary, publicOrigin: string | null): string {
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

export function routeKey(identity: Pick<ConnectorIdentity, "workspaceId" | "workstationId">, routeId: string): string {
  return `${identity.workspaceId}:${identity.workstationId}:${routeId}`;
}

export function sameIdentity(left: ConnectorIdentity, right: ConnectorIdentity): boolean {
  return left.workspaceId === right.workspaceId && left.workstationId === right.workstationId;
}

export function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export function validStatusCode(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599;
}

export function validCloseCode(value: number): boolean {
  return value === 1000 || (value >= 1001 && value <= 1014 && ![1004, 1005, 1006].includes(value)) || (value >= 3000 && value <= 4999);
}

export function truncateCloseReason(value: string): string {
  return Buffer.from(value, "utf8").subarray(0, 123).toString("utf8").replace(/\uFFFD$/u, "");
}

export function hasUnsafeControl(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

export function isPreviewError(value: unknown): value is PreviewTunnelErrorCode {
  return value === "route_unavailable" || value === "local_connection_failed" || value === "local_timeout" ||
    value === "request_too_large" || value === "response_too_large" || value === "protocol_error" || value === "stream_cancelled";
}

export function previewErrorLabel(code: PreviewTunnelErrorCode): string {
  return code === "route_unavailable" ? "本机预览路由不可用" :
    code === "local_connection_failed" ? "无法连接工作站本机端口" :
      code === "local_timeout" ? "工作站本机服务响应超时" :
        code === "request_too_large" ? "请求正文超过开发预览限制" :
          code === "response_too_large" ? "响应正文超过开发预览限制" :
            code === "protocol_error" ? "开发预览协议错误" : "开发预览已取消";
}

export function isIdempotent(method: PreviewHttpMethod): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

export function sendProxyError(response: ServerResponse, statusCode: number, message: string): void {
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

export function rejectProxyUpgrade(socket: Duplex, statusCode: number, message: string): void {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
