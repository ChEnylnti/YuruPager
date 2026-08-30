import { createHmac, timingSafeEqual } from "node:crypto";

import {
  sessionImageLimits,
  sessionImageMimeTypes,
  type SessionCommandAttachment,
} from "@yurupager/shared";

const ticketContext = "yurupager.session-attachment.v1\0";

export interface AttachmentTicketBinding extends SessionCommandAttachment {
  userId: string;
  sessionId: string;
  workspaceId: string;
  workstationId: string;
  uploadId: string;
  expiresAt: number;
}

interface TicketPayload {
  v: 1;
  u: string;
  s: string;
  w: string;
  x: string;
  o: string;
  a: string;
  m: SessionCommandAttachment["mimeType"];
  b: number;
  h: string;
  e: number;
}

export function issueAttachmentTicket(
  secret: string,
  binding: AttachmentTicketBinding,
): string {
  const payload: TicketPayload = {
    v: 1,
    u: binding.userId,
    s: binding.sessionId,
    w: binding.workspaceId,
    x: binding.workstationId,
    o: binding.uploadId,
    a: binding.attachmentId,
    m: binding.mimeType,
    b: binding.byteLength,
    h: binding.sha256,
    e: binding.expiresAt,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signature(secret, encoded)}`;
}

export function readAttachmentTicket(
  secret: string,
  ticket: string,
  now = Date.now(),
  requireUnexpired = true,
): AttachmentTicketBinding | null {
  if (ticket.length < 40 || ticket.length > 2_000) return null;
  const separator = ticket.indexOf(".");
  if (separator < 1 || separator !== ticket.lastIndexOf(".")) return null;
  const encoded = ticket.slice(0, separator);
  const suppliedSignature = ticket.slice(separator + 1);
  const expectedSignature = signature(secret, encoded);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) return null;

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const payload = value as Partial<TicketPayload>;
  if (
    payload.v !== 1 ||
    !validOpaqueId(payload.u) ||
    !validOpaqueId(payload.s) ||
    !validOpaqueId(payload.w) ||
    !validOpaqueId(payload.x) ||
    !validOpaqueId(payload.o) ||
    !validOpaqueId(payload.a) ||
    !sessionImageMimeTypes.includes(payload.m as SessionCommandAttachment["mimeType"]) ||
    !Number.isSafeInteger(payload.b) ||
    (payload.b ?? 0) < 1 ||
    (payload.b ?? 0) > sessionImageLimits.maxAttachmentBytes ||
    typeof payload.h !== "string" ||
    !/^[a-f0-9]{64}$/u.test(payload.h) ||
    !Number.isSafeInteger(payload.e) ||
    (requireUnexpired && (payload.e ?? 0) <= Math.floor(now / 1_000))
  ) return null;

  return {
    userId: payload.u,
    sessionId: payload.s,
    workspaceId: payload.w,
    workstationId: payload.x,
    uploadId: payload.o,
    attachmentId: payload.a,
    mimeType: payload.m,
    byteLength: payload.b,
    sha256: payload.h,
    expiresAt: payload.e,
  } as AttachmentTicketBinding;
}

function signature(secret: string, encoded: string): string {
  return createHmac("sha256", secret)
    .update(ticketContext)
    .update(encoded)
    .digest("base64url");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
