import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { IncomingHttpHeaders } from "node:http";

import type { PreviewHeader, PreviewHttpMethod } from "@yurupager/shared";
import { previewLimits } from "@yurupager/shared";

const requestBlocked = new Set([
  "authorization",
  "connection",
  "cookie",
  "forwarded",
  "host",
  "origin",
  "proxy-authorization",
  "proxy-connection",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
]);

const responseBlocked = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "permissions-policy",
  "referrer-policy",
  "x-content-type-options",
  "x-frame-options",
]);

export interface PreviewTicketBinding {
  previewId: string;
  userId: string;
  sessionId: string;
  workspaceId: string;
  workstationId: string;
  ticketExpiresAt: number;
  previewExpiresAt: number;
}

export interface PreviewContextBinding extends Omit<PreviewTicketBinding, "ticketExpiresAt"> {
  contextExpiresAt: number;
}

export class OneTimePreviewTickets {
  readonly #tickets = new Map<string, PreviewTicketBinding>();

  issue(binding: PreviewTicketBinding): string {
    this.sweep();
    const token = randomBytes(32).toString("base64url");
    this.#tickets.set(ticketHash(token), binding);
    return token;
  }

  consume(token: string, now = Date.now()): PreviewTicketBinding | null {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
    const key = ticketHash(token);
    const binding = this.#tickets.get(key);
    this.#tickets.delete(key);
    if (binding === undefined || binding.ticketExpiresAt <= now) return null;
    return binding;
  }

  sweep(now = Date.now()): void {
    for (const [key, value] of this.#tickets) {
      if (value.ticketExpiresAt <= now) this.#tickets.delete(key);
    }
  }
}

export function signPreviewContext(secret: string, binding: PreviewContextBinding): string {
  const payload = Buffer.from(JSON.stringify({
    p: binding.previewId,
    u: binding.userId,
    s: binding.sessionId,
    w: binding.workspaceId,
    x: binding.workstationId,
    e: binding.previewExpiresAt,
    c: binding.contextExpiresAt,
  }), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update("yurupager-preview-context\0").update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyPreviewContext(
  secret: string,
  token: string,
  now = Date.now(),
): PreviewContextBinding | null {
  const separator = token.indexOf(".");
  if (separator < 1 || token.indexOf(".", separator + 1) !== -1) return null;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = createHmac("sha256", secret).update("yurupager-preview-context\0").update(payload).digest("base64url");
  if (!constantTimeEqual(signature, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      !validUuid(value.p) || !validUuid(value.u) || !validUuid(value.s) ||
      !validUuid(value.w) || !validUuid(value.x) ||
      !Number.isSafeInteger(value.e) || !Number.isSafeInteger(value.c) ||
      (value.e as number) <= now || (value.c as number) <= now
    ) return null;
    return {
      previewId: value.p,
      userId: value.u,
      sessionId: value.s,
      workspaceId: value.w,
      workstationId: value.x,
      previewExpiresAt: value.e as number,
      contextExpiresAt: value.c as number,
    };
  } catch {
    return null;
  }
}

export function sanitizePreviewRequestHeaders(
  headers: IncomingHttpHeaders,
  routeId: string,
): PreviewHeader[] {
  const result: PreviewHeader[] = [];
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (requestBlocked.has(name) || rawValue === undefined || name === "service-worker") continue;
    for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) {
      pushHeader(result, name, String(value));
    }
  }
  const applicationCookie = applicationCookies(headers.cookie, routeId);
  if (applicationCookie !== "") pushHeader(result, "cookie", applicationCookie);
  return result;
}

export function sanitizePreviewResponseHeaders(
  headers: PreviewHeader[],
  routeId: string,
): PreviewHeader[] {
  const result: PreviewHeader[] = [];
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (responseBlocked.has(name)) continue;
    if (name === "set-cookie") {
      const rewritten = namespaceSetCookie(value, routeId);
      if (rewritten !== null) pushHeader(result, name, rewritten);
      continue;
    }
    pushHeader(result, name, value);
  }
  return result;
}

export function validatePreviewMethod(value: string | undefined): PreviewHttpMethod | null {
  return value === "GET" || value === "HEAD" || value === "OPTIONS" || value === "POST" ||
    value === "PUT" || value === "PATCH" || value === "DELETE" ? value : null;
}

export function validatePreviewPath(value: string): string | null {
  if (!value.startsWith("/") || value.startsWith("//") || /[\r\n\0]/u.test(value)) return null;
  return Buffer.byteLength(value, "utf8") <= previewLimits.maxPathBytes ? value : null;
}

export function isServiceWorkerRequest(headers: IncomingHttpHeaders): boolean {
  return headers["service-worker"] !== undefined;
}

export function parseCookies(value: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (value === undefined) return result;
  for (const part of value.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const cookieValue = part.slice(separator + 1).trim();
    if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) result.set(name, cookieValue);
  }
  return result;
}

export function previewCookieName(): string {
  return "yp_preview_context";
}

export function routeCookiePrefix(routeId: string): string {
  return `ypv_${routeId.replaceAll("-", "").slice(0, 12)}_`;
}

function applicationCookies(value: string | undefined, routeId: string): string {
  const prefix = routeCookiePrefix(routeId);
  return [...parseCookies(value)]
    .filter(([name]) => name.startsWith(prefix))
    .map(([name, cookieValue]) => `${name.slice(prefix.length)}=${cookieValue}`)
    .join("; ");
}

function namespaceSetCookie(value: string, routeId: string): string | null {
  if (/\r|\n/u.test(value)) return null;
  const parts = value.split(";");
  const pair = parts.shift()?.trim();
  if (pair === undefined) return null;
  const separator = pair.indexOf("=");
  if (separator < 1) return null;
  const name = pair.slice(0, separator).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) return null;
  const attributes = parts
    .map((part) => part.trim())
    .filter((part) => part !== "" && !part.toLowerCase().startsWith("domain="));
  return `${routeCookiePrefix(routeId)}${name}=${pair.slice(separator + 1)}${attributes.length === 0 ? "" : `; ${attributes.join("; ")}`}`;
}

function pushHeader(headers: PreviewHeader[], name: string, value: string): void {
  if (
    headers.length >= previewLimits.maxHeaderCount ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ||
    /[\r\n\0]/u.test(value)
  ) throw new Error("Invalid preview header");
  const nextBytes = headers.reduce((total, [key, child]) => total + Buffer.byteLength(key) + Buffer.byteLength(child), 0) +
    Buffer.byteLength(name) + Buffer.byteLength(value);
  if (nextBytes > previewLimits.maxHeaderBytes) throw new Error("Preview headers are too large");
  headers.push([name, value]);
}

function ticketHash(token: string): string {
  return createHash("sha256").update("yurupager-preview-ticket\0").update(token).digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
