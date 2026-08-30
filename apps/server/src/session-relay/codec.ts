import type {
  ConnectorSessionTitle,
  ConnectorSessionStreamMessage,
  SessionAttachmentErrorCode,
  SessionImageMimeType,
  SessionStreamFrame,
  WebLiveClientMessage,
} from "@yurupager/shared";
import { sessionImageLimits, sessionImageMimeTypes } from "@yurupager/shared";

import { decodeBase64Chunk } from "./images.js";

export type ConnectorStreamRouteMessage = Extract<ConnectorSessionStreamMessage,
  { type: "session.stream.frame" | "session.stream.error" }>;

export type ConnectorAttachmentStatus = Extract<ConnectorSessionStreamMessage,
  { type: "session.attachment.status" }>;

export function readWebLiveClientMessage(value: unknown): WebLiveClientMessage {
  const record = readRecord(value);
  if (record === null || !validSessionId(record.sessionId)) {
    throw new Error("Invalid live session message");
  }
  if (record.type === "session.stream.subscribe" || record.type === "session.stream.unsubscribe") {
    return record as unknown as WebLiveClientMessage;
  }
  if (!validId(record.uploadId)) throw new Error("Invalid attachment upload id");
  if (record.type === "session.attachment.begin") {
    if (
      !sessionImageMimeTypes.includes(record.mimeType as SessionImageMimeType) ||
      !Number.isSafeInteger(record.byteLength) ||
      Number(record.byteLength) < 1 ||
      Number(record.byteLength) > sessionImageLimits.maxAttachmentBytes ||
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(record.sha256)
    ) throw new Error("Invalid attachment begin message");
    return record as unknown as WebLiveClientMessage;
  }
  if (record.type === "session.attachment.chunk") {
    if (
      !Number.isSafeInteger(record.offset) ||
      Number(record.offset) < 0 ||
      typeof record.data !== "string" ||
      record.data.length < 4 ||
      record.data.length > Math.ceil(sessionImageLimits.maxChunkBytes / 3) * 4
    ) throw new Error("Invalid attachment chunk message");
    return record as unknown as WebLiveClientMessage;
  }
  if (record.type !== "session.attachment.complete" && record.type !== "session.attachment.cancel") {
    throw new Error("Invalid live session message");
  }
  return record as unknown as WebLiveClientMessage;
}

export function readConnectorAttachmentStatus(record: Record<string, unknown>): ConnectorAttachmentStatus {
  if (!validId(record.transferId) || !validId(record.uploadId)) {
    throw new Error("Invalid Connector attachment route");
  }
  if (!["accepted", "progress", "ready", "failed", "cancelled"].includes(String(record.state))) {
    throw new Error("Invalid Connector attachment state");
  }
  if (
    (record.state === "progress" || (record.state === "accepted" && record.nextOffset !== undefined)) &&
    (!Number.isSafeInteger(record.nextOffset) || Number(record.nextOffset) < 0)
  ) throw new Error("Invalid Connector attachment offset");
  if (record.state === "ready" && !validId(record.attachmentId)) {
    throw new Error("Invalid Connector attachment id");
  }
  if (record.state === "failed" && record.code !== undefined && !isAttachmentErrorCode(record.code)) {
    throw new Error("Invalid Connector attachment error");
  }
  return record as unknown as ConnectorAttachmentStatus;
}

export function readConnectorSessionStreamMessage(record: Record<string, unknown>): ConnectorStreamRouteMessage {
  if (
    typeof record.subscriptionId !== "string" ||
    record.subscriptionId.length < 1 ||
    record.subscriptionId.length > 200 ||
    typeof record.threadId !== "string" ||
    record.threadId.length < 1 ||
    record.threadId.length > 500
  ) throw new Error("Invalid Connector session stream route");
  if (record.type === "session.stream.error") {
    if (record.code !== "thread_unavailable" && record.code !== "stream_failed") {
      throw new Error("Invalid Connector session stream error");
    }
    return record as unknown as ConnectorStreamRouteMessage;
  }
  if (record.type !== "session.stream.frame" || !isSessionStreamFrame(record.frame)) {
    throw new Error("Invalid Connector session stream frame");
  }
  return record as unknown as ConnectorStreamRouteMessage;
}

export function readConnectorSessionTitles(record: Record<string, unknown>): ConnectorSessionTitle[] {
  if (!Array.isArray(record.titles) || record.titles.length > 200) {
    throw new Error("Invalid Connector session title snapshot");
  }
  const seen = new Set<string>();
  return record.titles.map((value) => {
    const title = readRecord(value);
    if (title === null || !validId(title.threadId) || typeof title.title !== "string") {
      throw new Error("Invalid Connector session title");
    }
    const normalized = normalizeSessionTitle(title.title);
    if (normalized === null || normalized !== title.title || seen.has(title.threadId)) {
      throw new Error("Invalid Connector session title");
    }
    seen.add(title.threadId);
    return { threadId: title.threadId, title: normalized };
  });
}

function normalizeSessionTitle(value: string): string | null {
  const withoutBidi = value.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/giu, "");
  const withoutControls = withoutBidi.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  const normalized = withoutControls.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || Array.from(normalized).length > 120) return null;
  return normalized;
}

export function isSessionStreamFrame(value: unknown): value is SessionStreamFrame {
  const frame = readRecord(value);
  if (frame === null || typeof frame.kind !== "string") return false;
  if (frame.kind === "history.start" || frame.kind === "history.complete") return true;
  if (frame.kind === "message.reset" || frame.kind === "message.complete") {
    return validId(frame.messageId);
  }
  if (frame.kind === "message.delta") {
    return validId(frame.messageId) && typeof frame.delta === "string" && frame.delta.length > 0 && Buffer.byteLength(frame.delta, "utf8") <= 16 * 1024;
  }
  if (frame.kind === "message.start") {
    return validId(frame.messageId) && validId(frame.turnId) &&
      (frame.role === "user" || frame.role === "assistant") &&
      (frame.phase === undefined || frame.phase === "commentary" || frame.phase === "final_answer");
  }
  if (frame.kind === "image.start") {
    return validId(frame.imageId) && validId(frame.turnId) &&
      (frame.role === "user" || frame.role === "assistant") &&
      sessionImageMimeTypes.includes(frame.mimeType as SessionImageMimeType) &&
      Number.isSafeInteger(frame.byteLength) && Number(frame.byteLength) >= 1 &&
      Number(frame.byteLength) <= sessionImageLimits.maxAttachmentBytes;
  }
  if (frame.kind === "image.chunk") {
    if (
      !validId(frame.imageId) ||
      !Number.isSafeInteger(frame.sequence) ||
      Number(frame.sequence) < 0 ||
      typeof frame.data !== "string"
    ) return false;
    try {
      decodeBase64Chunk(frame.data);
      return true;
    } catch {
      return false;
    }
  }
  if (frame.kind === "image.complete") {
    return validId(frame.imageId) && typeof frame.sha256 === "string" && /^[a-f0-9]{64}$/u.test(frame.sha256);
  }
  if (frame.kind === "image.error") {
    return validId(frame.imageId) && validId(frame.turnId) &&
      (frame.role === "user" || frame.role === "assistant") && [
      "image_unavailable",
      "image_invalid",
      "image_too_large",
      "image_incomplete",
      "image_hash_mismatch",
    ].includes(String(frame.code));
  }
  if (frame.kind === "activity.upsert") {
    return validId(frame.activityId) && validId(frame.turnId) &&
      ["command", "file_change", "tool", "web_search", "image", "collaboration", "wait", "review", "context_compaction"].includes(String(frame.activity)) &&
      ["in_progress", "completed", "failed", "cancelled"].includes(String(frame.status)) &&
      typeof frame.label === "string" && normalizeActivityLabel(frame.label) === frame.label;
  }
  if (frame.kind === "turn.status") {
    return validId(frame.turnId) && ["in_progress", "completed", "failed", "interrupted"].includes(String(frame.status));
  }
  return false;
}

function normalizeActivityLabel(value: string): string | null {
  const withoutBidi = value.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/giu, "");
  const withoutControls = withoutBidi.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  const normalized = withoutControls.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || Array.from(normalized).length > 120) return null;
  return normalized;
}

export function isImageFrame(frame: SessionStreamFrame): boolean {
  return frame.kind === "image.start" || frame.kind === "image.chunk" ||
    frame.kind === "image.complete" || frame.kind === "image.error";
}

export function isAttachmentErrorCode(value: unknown): value is SessionAttachmentErrorCode {
  return [
    "connector_offline",
    "permission_denied",
    "invalid_upload",
    "invalid_image_type",
    "image_too_large",
    "invalid_chunk",
    "chunk_out_of_order",
    "image_incomplete",
    "image_hash_mismatch",
    "connector_write_failed",
    "upload_expired",
  ].includes(String(value));
}

export function validSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

export function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500;
}

export function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
