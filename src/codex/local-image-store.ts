import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import {
  IMAGE_CHUNK_BYTES,
  ImageMediaError,
  type ImageMimeType,
  type ValidatedImage,
  decodeStrictBase64,
  readImageMimeType,
  validateImageBytes,
} from "./image-media.js";

export interface ImageUploadDescriptor {
  uploadId: string;
  threadId: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
}

export interface ImageAttachmentReference {
  attachmentId: string;
  mimeType: ImageMimeType;
  byteLength: number;
  sha256: string;
}

export interface LocalImageAttachment extends ImageAttachmentReference {
  threadId: string;
  path: string;
}

export type ImageUploadResult =
  | { state: "accepted" | "progress"; nextOffset: number }
  | { state: "ready"; nextOffset: number; attachment: ImageAttachmentReference }
  | { state: "cancelled"; nextOffset: number };

interface UploadRow {
  upload_id: string;
  thread_id: string;
  mime_type: string;
  byte_length: number;
  sha256: string;
  next_offset: number;
  temp_name: string;
}

interface AttachmentRow {
  attachment_id: string;
  upload_id: string;
  thread_id: string;
  mime_type: string;
  byte_length: number;
  sha256: string;
  stored_name: string;
}

export class SqliteLocalImageStore {
  readonly #database: DatabaseSync;
  readonly #directory: string;
  readonly #now: () => Date;
  readonly #getUpload: StatementSync;
  readonly #getAttachment: StatementSync;
  readonly #getAttachmentByUpload: StatementSync;
  readonly #insertUpload: StatementSync;
  readonly #advanceUpload: StatementSync;
  readonly #insertAttachment: StatementSync;
  readonly #deleteUpload: StatementSync;

  constructor(databasePath: string, directory: string, now: () => Date = () => new Date()) {
    this.#directory = directory;
    this.#now = now;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.#database = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS image_uploads (
        upload_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        next_offset INTEGER NOT NULL,
        temp_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS image_attachments (
        attachment_id TEXT PRIMARY KEY,
        upload_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        stored_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
    this.#getUpload = this.#database.prepare("SELECT * FROM image_uploads WHERE upload_id = ?");
    this.#getAttachment = this.#database.prepare("SELECT * FROM image_attachments WHERE attachment_id = ?");
    this.#getAttachmentByUpload = this.#database.prepare("SELECT * FROM image_attachments WHERE upload_id = ?");
    this.#insertUpload = this.#database.prepare(`
      INSERT INTO image_uploads
        (upload_id, thread_id, mime_type, byte_length, sha256, next_offset, temp_name, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `);
    this.#advanceUpload = this.#database.prepare(`
      UPDATE image_uploads SET next_offset = ? WHERE upload_id = ? AND next_offset = ?
    `);
    this.#insertAttachment = this.#database.prepare(`
      INSERT INTO image_attachments
        (attachment_id, upload_id, thread_id, mime_type, byte_length, sha256, stored_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#deleteUpload = this.#database.prepare("DELETE FROM image_uploads WHERE upload_id = ?");
    this.#discardIncompleteUploads();
  }

  beginUpload(input: ImageUploadDescriptor): ImageUploadResult {
    const descriptor = readUploadDescriptor(input);
    const completed = readAttachmentRow(this.#getAttachmentByUpload.get(descriptor.uploadId));
    if (completed !== undefined) {
      requireMatchingDescriptor(completed, descriptor);
      const attachment = this.#validatedAttachment(completed);
      return { state: "ready", nextOffset: attachment.byteLength, attachment: publicReference(attachment) };
    }

    const existing = readUploadRow(this.#getUpload.get(descriptor.uploadId));
    if (existing !== undefined) {
      requireMatchingDescriptor(existing, descriptor);
      const path = this.#privatePath(existing.temp_name, ".part");
      const size = safeFileSize(path);
      if (size !== existing.next_offset || size > existing.byte_length) {
        this.#cancelUploadRow(existing);
        throw new ImageMediaError("upload_state_invalid", "Incomplete image state is invalid");
      }
      return { state: "accepted", nextOffset: existing.next_offset };
    }

    const tempName = `${randomUUID().replaceAll("-", "")}.part`;
    const path = this.#privatePath(tempName, ".part");
    const descriptorTime = this.#now().toISOString();
    const handle = openSync(path, "wx", 0o600);
    closeSync(handle);
    chmodSync(path, 0o600);
    try {
      this.#insertUpload.run(
        descriptor.uploadId,
        descriptor.threadId,
        descriptor.mimeType,
        descriptor.byteLength,
        descriptor.sha256,
        tempName,
        descriptorTime,
      );
    } catch (error) {
      safeUnlink(path);
      throw error;
    }
    return { state: "accepted", nextOffset: 0 };
  }

  appendChunk(uploadId: string, offset: number, encoded: string): ImageUploadResult {
    requireOpaqueId(uploadId, "uploadId");
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ImageMediaError("invalid_upload_offset", "Image upload offset is invalid");
    }
    const upload = this.#requireUpload(uploadId);
    if (offset !== upload.next_offset) {
      this.#cancelUploadRow(upload);
      throw new ImageMediaError("invalid_upload_offset", "Image chunks must be ordered");
    }
    const remaining = upload.byte_length - offset;
    if (remaining <= 0) throw new ImageMediaError("invalid_upload_offset", "Image upload is already complete");
    let bytes: Buffer;
    try {
      bytes = decodeStrictBase64(encoded, Math.min(IMAGE_CHUNK_BYTES, remaining));
    } catch (error) {
      this.#cancelUploadRow(upload);
      throw error;
    }
    const nextOffset = offset + bytes.length;
    if (nextOffset > upload.byte_length) throw new ImageMediaError("image_too_large", "Image chunk exceeds its declaration");

    const path = this.#privatePath(upload.temp_name, ".part");
    const before = safeFileSize(path);
    if (before !== offset) {
      this.#cancelUploadRow(upload);
      throw new ImageMediaError("upload_state_invalid", "Incomplete image state is invalid");
    }
    const handle = openSync(path, "r+");
    try {
      let written = 0;
      while (written < bytes.length) {
        written += writeSync(handle, bytes, written, bytes.length - written, offset + written);
      }
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    const updated = this.#advanceUpload.run(nextOffset, uploadId, offset);
    if (updated.changes !== 1) {
      this.#cancelUploadRow(upload);
      throw new ImageMediaError("upload_state_invalid", "Image upload state changed unexpectedly");
    }
    return { state: "progress", nextOffset };
  }

  completeUpload(uploadId: string): ImageUploadResult {
    requireOpaqueId(uploadId, "uploadId");
    const completed = readAttachmentRow(this.#getAttachmentByUpload.get(uploadId));
    if (completed !== undefined) {
      const attachment = this.#validatedAttachment(completed);
      return { state: "ready", nextOffset: attachment.byteLength, attachment: publicReference(attachment) };
    }
    const upload = this.#requireUpload(uploadId);
    if (upload.next_offset !== upload.byte_length) {
      this.#cancelUploadRow(upload);
      throw new ImageMediaError("upload_incomplete", "Image upload is incomplete");
    }
    const tempPath = this.#privatePath(upload.temp_name, ".part");
    let validated: ValidatedImage;
    try {
      validated = validateImageBytes(
        readFileSync(tempPath),
        readImageMimeType(upload.mime_type),
        upload.sha256,
      );
    } catch (error) {
      this.#cancelUploadRow(upload);
      throw error;
    }
    if (validated.byteLength !== upload.byte_length) {
      this.#cancelUploadRow(upload);
      throw new ImageMediaError("invalid_image", "Image length does not match its declaration");
    }

    const attachmentId = randomUUID();
    const storedName = `${attachmentId.replaceAll("-", "")}.${extensionFor(validated.mimeType)}`;
    const storedPath = this.#privatePath(storedName);
    renameSync(tempPath, storedPath);
    chmodSync(storedPath, 0o600);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#insertAttachment.run(
        attachmentId,
        upload.upload_id,
        upload.thread_id,
        validated.mimeType,
        validated.byteLength,
        validated.sha256,
        storedName,
        this.#now().toISOString(),
      );
      this.#deleteUpload.run(uploadId);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      renameSync(storedPath, tempPath);
      throw error;
    }
    return {
      state: "ready",
      nextOffset: validated.byteLength,
      attachment: { attachmentId, mimeType: validated.mimeType, byteLength: validated.byteLength, sha256: validated.sha256 },
    };
  }

  cancelUpload(uploadId: string): ImageUploadResult {
    requireOpaqueId(uploadId, "uploadId");
    const completed = readAttachmentRow(this.#getAttachmentByUpload.get(uploadId));
    if (completed !== undefined) {
      const attachment = this.#validatedAttachment(completed);
      return { state: "ready", nextOffset: attachment.byteLength, attachment: publicReference(attachment) };
    }
    const upload = readUploadRow(this.#getUpload.get(uploadId));
    if (upload !== undefined) this.#cancelUploadRow(upload);
    return { state: "cancelled", nextOffset: 0 };
  }

  resolveAttachment(expected: ImageAttachmentReference, threadId: string): LocalImageAttachment {
    requireOpaqueId(expected.attachmentId, "attachmentId");
    requireThreadId(threadId);
    const row = readAttachmentRow(this.#getAttachment.get(expected.attachmentId));
    if (row === undefined || row.thread_id !== threadId) {
      throw new ImageMediaError("attachment_unavailable", "Image attachment is unavailable");
    }
    if (
      row.mime_type !== expected.mimeType ||
      row.byte_length !== expected.byteLength ||
      row.sha256 !== expected.sha256
    ) {
      throw new ImageMediaError("attachment_mismatch", "Image attachment metadata does not match");
    }
    return this.#validatedAttachment(row);
  }

  close(): void {
    this.#database.close();
  }

  #validatedAttachment(row: AttachmentRow): LocalImageAttachment {
    const path = this.#privatePath(row.stored_name);
    let info;
    try {
      info = lstatSync(path);
    } catch {
      throw new ImageMediaError("attachment_unavailable", "Image attachment is unavailable");
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ImageMediaError("attachment_unavailable", "Image attachment is unavailable");
    }
    if ((info.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
    const validated = validateImageBytes(
      readFileSync(path),
      readImageMimeType(row.mime_type),
      row.sha256,
    );
    if (validated.byteLength !== row.byte_length) {
      throw new ImageMediaError("attachment_mismatch", "Image attachment metadata does not match");
    }
    return {
      attachmentId: row.attachment_id,
      threadId: row.thread_id,
      path,
      mimeType: validated.mimeType,
      byteLength: validated.byteLength,
      sha256: validated.sha256,
    };
  }

  #requireUpload(uploadId: string): UploadRow {
    const upload = readUploadRow(this.#getUpload.get(uploadId));
    if (upload === undefined) throw new ImageMediaError("upload_not_found", "Image upload was not found");
    return upload;
  }

  #cancelUploadRow(upload: UploadRow): void {
    this.#deleteUpload.run(upload.upload_id);
    safeUnlink(this.#privatePath(upload.temp_name, ".part"));
  }

  #privatePath(name: string, requiredSuffix?: string): string {
    if (basename(name) !== name || !/^[a-f0-9]+(?:\.(?:part|png|jpg|webp))?$/u.test(name)) {
      throw new ImageMediaError("attachment_unavailable", "Image attachment name is invalid");
    }
    if (requiredSuffix !== undefined && !name.endsWith(requiredSuffix)) {
      throw new ImageMediaError("upload_state_invalid", "Image upload name is invalid");
    }
    return join(this.#directory, name);
  }

  #discardIncompleteUploads(): void {
    const rows = this.#database.prepare("SELECT * FROM image_uploads").all();
    for (const value of rows) {
      const upload = readUploadRow(value);
      if (upload !== undefined) safeUnlink(this.#privatePath(upload.temp_name, ".part"));
    }
    this.#database.exec("DELETE FROM image_uploads");
    const retained = new Set(
      this.#database.prepare("SELECT stored_name FROM image_attachments").all()
        .flatMap((value) => isRecord(value) && typeof value.stored_name === "string" ? [value.stored_name] : []),
    );
    for (const name of readdirSync(this.#directory)) {
      if (/^[a-f0-9]+\.part$/u.test(name)) {
        safeUnlink(join(this.#directory, name));
      } else if (/^[a-f0-9]+\.(?:png|jpg|webp)$/u.test(name) && !retained.has(name)) {
        safeUnlink(join(this.#directory, name));
      }
    }
  }
}

function readUploadDescriptor(value: ImageUploadDescriptor): Required<ImageUploadDescriptor> & { mimeType: ImageMimeType } {
  requireOpaqueId(value.uploadId, "uploadId");
  requireThreadId(value.threadId);
  const mimeType = readImageMimeType(value.mimeType);
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > 5 * 1024 * 1024) {
    throw new ImageMediaError("image_too_large", "Image byte length is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new ImageMediaError("invalid_image", "Image digest is invalid");
  }
  return { ...value, mimeType };
}

function requireMatchingDescriptor(
  row: Pick<UploadRow, "upload_id" | "thread_id" | "mime_type" | "byte_length" | "sha256">,
  input: ReturnType<typeof readUploadDescriptor>,
): void {
  if (
    row.upload_id !== input.uploadId ||
    row.thread_id !== input.threadId ||
    row.mime_type !== input.mimeType ||
    row.byte_length !== input.byteLength ||
    row.sha256 !== input.sha256
  ) throw new ImageMediaError("upload_conflict", "Image upload is bound to different metadata");
}

function publicReference(attachment: LocalImageAttachment): ImageAttachmentReference {
  return {
    attachmentId: attachment.attachmentId,
    mimeType: attachment.mimeType,
    byteLength: attachment.byteLength,
    sha256: attachment.sha256,
  };
}

function extensionFor(mimeType: ImageMimeType): "png" | "jpg" | "webp" {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  return "webp";
}

function requireOpaqueId(value: string, label: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ImageMediaError("invalid_upload", `${label} is invalid`);
  }
}

function requireThreadId(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ImageMediaError("invalid_upload", "threadId is invalid");
  }
}

function safeFileSize(path: string): number {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink() ? info.size : -1;
  } catch {
    return -1;
  }
}

function safeUnlink(path: string): void {
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    throw new ImageMediaError("storage_failed", "Image storage cleanup failed");
  }
}

function readUploadRow(value: unknown): UploadRow | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ImageMediaError("upload_state_invalid", "Image upload row is invalid");
  if (
    typeof value.upload_id !== "string" || typeof value.thread_id !== "string" ||
    typeof value.mime_type !== "string" || typeof value.byte_length !== "number" ||
    typeof value.sha256 !== "string" || typeof value.next_offset !== "number" ||
    typeof value.temp_name !== "string"
  ) throw new ImageMediaError("upload_state_invalid", "Image upload row is invalid");
  return value as unknown as UploadRow;
}

function readAttachmentRow(value: unknown): AttachmentRow | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ImageMediaError("attachment_unavailable", "Image attachment row is invalid");
  if (
    typeof value.attachment_id !== "string" || typeof value.upload_id !== "string" ||
    typeof value.thread_id !== "string" || typeof value.mime_type !== "string" ||
    typeof value.byte_length !== "number" || typeof value.sha256 !== "string" ||
    typeof value.stored_name !== "string"
  ) throw new ImageMediaError("attachment_unavailable", "Image attachment row is invalid");
  return value as unknown as AttachmentRow;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
