import type { SessionStreamFrame } from "@yurupager/shared";

import { sniffImageMimeType } from "./image-format.js";
import { imageAssemblyText } from "./i18n.js";

type ImageStartFrame = Extract<SessionStreamFrame, { kind: "image.start" }>;
type ImageChunkFrame = Extract<SessionStreamFrame, { kind: "image.chunk" }>;
type ImageCompleteFrame = Extract<SessionStreamFrame, { kind: "image.complete" }>;

interface PendingImage {
  start: ImageStartFrame;
  chunks: Uint8Array<ArrayBuffer>[];
  encodedChunks: string[];
  byteLength: number;
}

export class ImageAssemblyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class ImageAssemblyStore {
  readonly #pending = new Map<string, PendingImage>();

  begin(frame: ImageStartFrame): void {
    if (!Number.isSafeInteger(frame.byteLength) || frame.byteLength <= 0 || frame.byteLength > 5 * 1024 * 1024) {
      throw new ImageAssemblyError("image_too_large", imageAssemblyText.sizeInvalid);
    }
    if (frame.mimeType !== "image/png" && frame.mimeType !== "image/jpeg" && frame.mimeType !== "image/webp") {
      throw new ImageAssemblyError("unsupported_image", imageAssemblyText.unsupported);
    }
    this.#pending.set(frame.imageId, { start: frame, chunks: [], encodedChunks: [], byteLength: 0 });
  }

  append(frame: ImageChunkFrame): void {
    const pending = this.#pending.get(frame.imageId);
    if (pending === undefined) throw new ImageAssemblyError("missing_image_start", imageAssemblyText.missingStart);
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0) {
      throw new ImageAssemblyError("invalid_image_sequence", imageAssemblyText.invalidSequence);
    }
    if (frame.sequence < pending.chunks.length) {
      if (pending.encodedChunks[frame.sequence] === frame.data) return;
      throw new ImageAssemblyError("conflicting_image_chunk", imageAssemblyText.conflictingChunk);
    }
    if (frame.sequence !== pending.chunks.length) {
      throw new ImageAssemblyError("missing_image_chunk", imageAssemblyText.discontiguous);
    }
    const bytes = strictBase64(frame.data);
    if (bytes.byteLength === 0 || bytes.byteLength > 48 * 1024) {
      throw new ImageAssemblyError("invalid_image_chunk", imageAssemblyText.invalidChunkSize);
    }
    if (pending.byteLength + bytes.byteLength > pending.start.byteLength) {
      throw new ImageAssemblyError("image_too_large", imageAssemblyText.exceedsDeclared);
    }
    pending.chunks.push(bytes);
    pending.encodedChunks.push(frame.data);
    pending.byteLength += bytes.byteLength;
  }

  async complete(frame: ImageCompleteFrame): Promise<{ blob: Blob; mimeType: string }> {
    const pending = this.#pending.get(frame.imageId);
    if (pending === undefined) throw new ImageAssemblyError("missing_image_start", imageAssemblyText.missingStart);
    this.#pending.delete(frame.imageId);
    if (pending.byteLength !== pending.start.byteLength) {
      throw new ImageAssemblyError("image_length_mismatch", imageAssemblyText.incomplete);
    }
    const bytes = joinChunks(pending.chunks, pending.byteLength);
    if (sniffImageMimeType(bytes) !== pending.start.mimeType) {
      throw new ImageAssemblyError("unsupported_image", imageAssemblyText.contentMismatch);
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
    const actual = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    if (!/^[a-f0-9]{64}$/u.test(frame.sha256) || actual !== frame.sha256) {
      throw new ImageAssemblyError("image_hash_mismatch", imageAssemblyText.integrityFailed);
    }
    return { blob: new Blob([bytes.buffer], { type: pending.start.mimeType }), mimeType: pending.start.mimeType };
  }

  fail(imageId: string): void {
    this.#pending.delete(imageId);
  }

  clear(): void {
    this.#pending.clear();
  }
}

function strictBase64(value: string): Uint8Array<ArrayBuffer> {
  if (value.length === 0 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new ImageAssemblyError("invalid_image_base64", imageAssemblyText.invalidEncoding);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new ImageAssemblyError("invalid_image_base64", imageAssemblyText.invalidEncoding);
  }
  if (btoa(binary) !== value) throw new ImageAssemblyError("invalid_image_base64", imageAssemblyText.nonCanonicalEncoding);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function joinChunks(chunks: Uint8Array<ArrayBuffer>[], byteLength: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
