import type { SessionImageMimeType, WebLiveClientMessage, WebLiveServerMessage } from "@yurupager/shared";

import type { LiveChannel } from "./live-channel.js";
import { sniffImageMimeType } from "./image-format.js";

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_IMAGE_COUNT = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_CHUNK_BYTES = 48 * 1024;
const STATUS_TIMEOUT_MS = 20_000;

export interface DraftImageAttachment {
  id: string;
  file: File;
  previewUrl: string;
}

export interface AttachmentUploadProgress {
  completedBytes: number;
  totalBytes: number;
  completedImages: number;
  totalImages: number;
}

export class AttachmentUploadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function validateDraftImages(
  current: DraftImageAttachment[],
  files: File[],
): { accepted: DraftImageAttachment[]; error: string | null } {
  const next = [...current];
  for (const file of files) {
    if (!IMAGE_MIME_TYPES.includes(file.type as (typeof IMAGE_MIME_TYPES)[number])) {
      return { accepted: next, error: "仅支持 PNG、JPEG 和 WebP 图片" };
    }
    if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
      return { accepted: next, error: "每张图片必须小于 5 MiB" };
    }
    if (next.length >= MAX_IMAGE_COUNT) {
      return { accepted: next, error: "每条消息最多添加 4 张图片" };
    }
    if (next.reduce((total, item) => total + item.file.size, 0) + file.size > MAX_TOTAL_IMAGE_BYTES) {
      return { accepted: next, error: "每条消息的图片总大小不能超过 12 MiB" };
    }
    next.push({ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) });
  }
  return { accepted: next, error: null };
}

export async function uploadSessionAttachments(
  channel: LiveChannel,
  sessionId: string,
  attachments: DraftImageAttachment[],
  signal: AbortSignal,
  onProgress?: (progress: AttachmentUploadProgress) => void,
): Promise<string[]> {
  const totalBytes = attachments.reduce((total, attachment) => total + attachment.file.size, 0);
  let completedBytes = 0;
  const tickets: string[] = [];
  const startedUploadIds: string[] = [];

  try {
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      if (attachment === undefined) continue;
      const mimeType = requireImageMimeType(attachment.file.type);
      const bytes = new Uint8Array(await readFileBuffer(attachment.file));
      if (sniffImageMimeType(bytes) !== mimeType) {
        throw new AttachmentUploadError("invalid_image_type", "图片内容与格式不匹配");
      }
      const sha256 = await sha256Hex(bytes);
      let currentOffset = 0;
      const report = (offset: number) => onProgress?.({
        completedBytes: completedBytes + offset,
        totalBytes,
        completedImages: index,
        totalImages: attachments.length,
      });

      startedUploadIds.push(attachment.id);
      let status = await sendAndWait(channel, sessionId, attachment.id, {
        type: "session.attachment.begin",
        sessionId,
        uploadId: attachment.id,
        mimeType,
        byteLength: bytes.byteLength,
        sha256,
      }, signal);
      if (status.state === "ready") {
        tickets.push(requireTicket(status.ticket));
        completedBytes += bytes.byteLength;
        onProgress?.({ completedBytes, totalBytes, completedImages: index + 1, totalImages: attachments.length });
        continue;
      }
      currentOffset = readNextOffset(status.nextOffset, bytes.byteLength);
      report(currentOffset);

      while (currentOffset < bytes.byteLength) {
        const chunk = bytes.subarray(currentOffset, Math.min(currentOffset + IMAGE_CHUNK_BYTES, bytes.byteLength));
        status = await sendAndWait(channel, sessionId, attachment.id, {
          type: "session.attachment.chunk",
          sessionId,
          uploadId: attachment.id,
          offset: currentOffset,
          data: bytesToBase64(chunk),
        }, signal);
        if (status.state === "ready") break;
        const nextOffset = readNextOffset(status.nextOffset, bytes.byteLength);
        if (nextOffset <= currentOffset) throw new AttachmentUploadError("upload_stalled", "图片上传没有继续进行");
        currentOffset = nextOffset;
        report(currentOffset);
      }

      if (status.state !== "ready") {
        status = await sendAndWait(channel, sessionId, attachment.id, {
          type: "session.attachment.complete",
          sessionId,
          uploadId: attachment.id,
        }, signal);
      }
      if (status.state !== "ready") throw new AttachmentUploadError("upload_incomplete", "工作站未完成图片校验");
      tickets.push(requireTicket(status.ticket));
      completedBytes += bytes.byteLength;
      onProgress?.({ completedBytes, totalBytes, completedImages: index + 1, totalImages: attachments.length });
    }
  } catch (error) {
    for (const uploadId of startedUploadIds) {
      channel.send({ type: "session.attachment.cancel", sessionId, uploadId });
    }
    throw error;
  }
  return tickets;
}

type AttachmentStatus = Extract<WebLiveServerMessage, { type: "session.attachment.status" }>;

function sendAndWait(
  channel: LiveChannel,
  sessionId: string,
  uploadId: string,
  message: WebLiveClientMessage,
  signal: AbortSignal,
): Promise<AttachmentStatus> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    let settled = false;
    const finish = (work: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      removeHandler();
      signal.removeEventListener("abort", aborted);
      work();
    };
    const removeHandler = channel.subscribe((candidate) => {
      if (candidate.type !== "session.attachment.status" || candidate.sessionId !== sessionId || candidate.uploadId !== uploadId) return;
      if (candidate.state === "failed") {
        finish(() => reject(new AttachmentUploadError(candidate.code ?? "upload_failed", uploadErrorLabel(candidate.code))));
        return;
      }
      if (candidate.state === "cancelled") {
        finish(() => reject(new DOMException("Upload cancelled", "AbortError")));
        return;
      }
      finish(() => resolve(candidate));
    });
    const aborted = () => finish(() => reject(new DOMException("Upload cancelled", "AbortError")));
    const timeout = window.setTimeout(
      () => finish(() => reject(new AttachmentUploadError("upload_timeout", "等待工作站响应超时"))),
      STATUS_TIMEOUT_MS,
    );
    signal.addEventListener("abort", aborted, { once: true });
    if (!channel.send(message)) {
      finish(() => reject(new AttachmentUploadError("live_offline", "实时连接不可用，图片未上传")));
    }
  });
}

function readNextOffset(value: number | undefined, byteLength: number): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 0 || value > byteLength) {
    throw new AttachmentUploadError("invalid_upload_offset", "工作站返回了无效的上传位置");
  }
  return value;
}

function requireTicket(value: string | undefined): string {
  if (value === undefined || value.length < 16) throw new AttachmentUploadError("missing_upload_ticket", "工作站未返回图片票据");
  return value;
}

function requireImageMimeType(value: string): SessionImageMimeType {
  if (!IMAGE_MIME_TYPES.includes(value as SessionImageMimeType)) {
    throw new AttachmentUploadError("invalid_image_type", "仅支持 PNG、JPEG 和 WebP 图片");
  }
  return value as SessionImageMimeType;
}

function readFileBuffer(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new AttachmentUploadError("invalid_upload", "无法读取图片内容"));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new AttachmentUploadError("invalid_upload", "无法读取图片内容"));
    };
    reader.readAsArrayBuffer(file);
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index] ?? 0);
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function uploadErrorLabel(code: string | undefined): string {
  if (code === "connector_offline") return "工作站离线，图片未上传";
  if (code === "permission_denied") return "你无权向此会话上传图片";
  if (code === "invalid_image_type" || code === "invalid_image") return "图片内容与格式不匹配";
  if (code === "image_too_large") return "图片超过允许大小";
  if (code === "image_hash_mismatch" || code === "hash_mismatch") return "图片完整性校验失败";
  return "图片上传失败，内容已保留";
}
