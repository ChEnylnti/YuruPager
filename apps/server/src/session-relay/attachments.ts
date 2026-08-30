import { createHash, randomUUID, type Hash } from "node:crypto";

import type {
  SessionAttachmentErrorCode,
  SessionCommandAttachment,
  SessionImageMimeType,
  WebLiveClientMessage,
  WebLiveServerMessage,
} from "@yurupager/shared";

import type { Pool } from "pg";
import type { WebSocket } from "ws";

import { issueAttachmentTicket } from "../attachment-ticket.js";
import type { ConnectorIdentity } from "../connector-repository.js";
import { authorizeSessionUpload } from "../repository.js";
import type { ConnectorAttachmentStatus } from "./codec.js";
import { decodeBase64Chunk, matchesImageSignature } from "./images.js";
import { sameConnector } from "./connector-links.js";
import { validId } from "./codec.js";

interface UploadRoute {
  transferId: string;
  uploadId: string;
  userId: string;
  sessionId: string;
  workspaceId: string;
  workstationId: string;
  threadId: string;
  mimeType: SessionImageMimeType;
  byteLength: number;
  sha256: string;
  nextOffset: number;
  hash: Hash;
  prefix: Buffer;
  state: "transferring" | "verifying" | "ready";
  attachmentId?: string;
  expiresAt?: number;
  userSocket: WebSocket;
}

export interface UploadRegistryContext {
  pool: Pool;
  ticketSecret: string;
  sendUser(socket: WebSocket, message: WebLiveServerMessage): void;
  sendConnector(socket: WebSocket, message: object): boolean | void;
  activeConnector(identity: Pick<ConnectorIdentity, "workspaceId" | "workstationId">): WebSocket | undefined;
}

/**
 * Owns the browser→Connector attachment upload state machine (transfer
 * registry, chunk offsets, hash and image-signature verification, expiry
 * sweep). Bytes stay in memory only; persistence happens nowhere.
 */
export class UploadRegistry {
  readonly #uploads = new Map<string, UploadRoute>();
  readonly #uploadsByUser = new Map<WebSocket, Map<string, string>>();
  readonly #context: UploadRegistryContext;

  constructor(context: UploadRegistryContext) {
    this.#context = context;
  }

  async begin(
    socket: WebSocket,
    userId: string,
    message: Extract<WebLiveClientMessage, { type: "session.attachment.begin" }>,
  ): Promise<void> {
    const existingTransferId = this.#uploadsByUser.get(socket)?.get(message.uploadId);
    if (existingTransferId !== undefined) {
      const existing = this.#uploads.get(existingTransferId);
      if (
        existing !== undefined &&
        existing.userId === userId &&
        existing.sessionId === message.sessionId &&
        existing.mimeType === message.mimeType &&
        existing.byteLength === message.byteLength &&
        existing.sha256 === message.sha256
      ) {
        this.#context.sendUser(socket, {
          type: "session.attachment.status",
          sessionId: existing.sessionId,
          uploadId: existing.uploadId,
          state: existing.state === "ready" ? "ready" : "progress",
          ...(existing.state === "ready" && existing.attachmentId !== undefined && existing.expiresAt !== undefined
            ? { ticket: issueAttachmentTicket(this.#context.ticketSecret, ticketBinding(existing)) }
            : { nextOffset: existing.nextOffset }),
        });
        return;
      }
      this.#sendUploadFailure(socket, message.sessionId, message.uploadId, "invalid_upload");
      return;
    }

    let authorized: Awaited<ReturnType<typeof authorizeSessionUpload>>;
    try {
      authorized = await authorizeSessionUpload(this.#context.pool, userId, message.sessionId);
    } catch {
      this.#sendUploadFailure(socket, message.sessionId, message.uploadId, "permission_denied");
      return;
    }
    const connector = this.#context.activeConnector(authorized);
    if (connector === undefined) {
      this.#sendUploadFailure(socket, message.sessionId, message.uploadId, "connector_offline");
      return;
    }

    const upload: UploadRoute = {
      transferId: randomUUID(),
      uploadId: message.uploadId,
      userId,
      sessionId: authorized.sessionId,
      workspaceId: authorized.workspaceId,
      workstationId: authorized.workstationId,
      threadId: authorized.threadId,
      mimeType: message.mimeType,
      byteLength: message.byteLength,
      sha256: message.sha256,
      nextOffset: 0,
      hash: createHash("sha256"),
      prefix: Buffer.alloc(0),
      state: "transferring",
      userSocket: socket,
    };
    this.#uploads.set(upload.transferId, upload);
    const userUploads = this.#uploadsByUser.get(socket) ?? new Map<string, string>();
    userUploads.set(upload.uploadId, upload.transferId);
    this.#uploadsByUser.set(socket, userUploads);
    this.#context.sendConnector(connector, {
      type: "session.attachment.begin",
      transferId: upload.transferId,
      uploadId: upload.uploadId,
      threadId: upload.threadId,
      mimeType: upload.mimeType,
      byteLength: upload.byteLength,
      sha256: upload.sha256,
    });
  }

  async receiveChunk(
    socket: WebSocket,
    userId: string,
    message: Extract<WebLiveClientMessage, { type: "session.attachment.chunk" }>,
  ): Promise<void> {
    const upload = this.#findUpload(socket, message.sessionId, message.uploadId);
    if (upload === undefined || upload.userId !== userId || upload.state !== "transferring") {
      this.#sendUploadFailure(socket, message.sessionId, message.uploadId, "invalid_upload");
      return;
    }
    if (!await this.#stillAuthorized(upload)) return;
    let bytes: Buffer;
    try {
      bytes = decodeBase64Chunk(message.data);
    } catch {
      this.#failUpload(upload, "invalid_chunk");
      return;
    }
    if (message.offset !== upload.nextOffset) {
      this.#failUpload(upload, "chunk_out_of_order");
      return;
    }
    if (upload.nextOffset + bytes.length > upload.byteLength) {
      this.#failUpload(upload, "image_too_large");
      return;
    }
    upload.hash.update(bytes);
    upload.prefix = appendPrefix(upload.prefix, bytes);
    upload.nextOffset += bytes.length;
    const connector = this.#context.activeConnector(upload);
    if (connector === undefined) {
      this.#failUpload(upload, "connector_offline", false);
      return;
    }
    this.#context.sendConnector(connector, {
      type: "session.attachment.chunk",
      transferId: upload.transferId,
      uploadId: upload.uploadId,
      offset: message.offset,
      data: message.data,
    });
  }

  async complete(
    socket: WebSocket,
    userId: string,
    message: Extract<WebLiveClientMessage, { type: "session.attachment.complete" }>,
  ): Promise<void> {
    const upload = this.#findUpload(socket, message.sessionId, message.uploadId);
    if (upload === undefined || upload.userId !== userId || upload.state !== "transferring") {
      this.#sendUploadFailure(socket, message.sessionId, message.uploadId, "invalid_upload");
      return;
    }
    if (!await this.#stillAuthorized(upload)) return;
    if (upload.nextOffset !== upload.byteLength) {
      this.#failUpload(upload, "image_incomplete");
      return;
    }
    if (!matchesImageSignature(upload.mimeType, upload.prefix)) {
      this.#failUpload(upload, "invalid_image_type");
      return;
    }
    if (upload.hash.digest("hex") !== upload.sha256) {
      this.#failUpload(upload, "image_hash_mismatch");
      return;
    }
    upload.state = "verifying";
    const connector = this.#context.activeConnector(upload);
    if (connector === undefined) {
      this.#failUpload(upload, "connector_offline", false);
      return;
    }
    this.#context.sendConnector(connector, {
      type: "session.attachment.complete",
      transferId: upload.transferId,
      uploadId: upload.uploadId,
    });
  }

  cancel(socket: WebSocket, sessionId: string, uploadId: string): void {
    const upload = this.#findUpload(socket, sessionId, uploadId);
    if (upload === undefined) {
      this.#context.sendUser(socket, {
        type: "session.attachment.status",
        sessionId,
        uploadId,
        state: "cancelled",
      });
      return;
    }
    this.#context.sendUser(socket, {
      type: "session.attachment.status",
      sessionId,
      uploadId,
      state: "cancelled",
    });
    this.#removeUpload(upload, true);
  }

  async #stillAuthorized(upload: UploadRoute): Promise<boolean> {
    try {
      const authorized = await authorizeSessionUpload(this.#context.pool, upload.userId, upload.sessionId);
      if (
        authorized.workspaceId === upload.workspaceId &&
        authorized.workstationId === upload.workstationId &&
        authorized.threadId === upload.threadId
      ) return true;
    } catch {
      // The client receives only a stable permission code; no local identifiers are exposed.
    }
    this.#failUpload(upload, "permission_denied");
    return false;
  }

  sweepExpired(): void {
    const now = Math.floor(Date.now() / 1_000);
    for (const upload of [...this.#uploads.values()]) {
      if (upload.expiresAt === undefined || upload.expiresAt > now) continue;
      this.#failUpload(upload, "upload_expired");
    }
  }

  handleConnectorStatus(identity: ConnectorIdentity, message: ConnectorAttachmentStatus): boolean {
    const upload = this.#uploads.get(message.transferId);
    if (
      upload === undefined ||
      upload.uploadId !== message.uploadId ||
      !sameConnector(upload, identity)
    ) return true;
    if (message.state === "accepted") {
      if (upload.state !== "transferring" || (message.nextOffset ?? 0) !== upload.nextOffset) {
        this.#failUpload(upload, "invalid_upload");
        return true;
      }
      this.#context.sendUser(upload.userSocket, {
        type: "session.attachment.status",
        sessionId: upload.sessionId,
        uploadId: upload.uploadId,
        state: "accepted",
        nextOffset: upload.nextOffset,
      });
      return true;
    }
    if (message.state === "progress") {
      if (upload.state !== "transferring" || message.nextOffset !== upload.nextOffset) {
        this.#failUpload(upload, "invalid_upload");
        return true;
      }
      this.#context.sendUser(upload.userSocket, {
        type: "session.attachment.status",
        sessionId: upload.sessionId,
        uploadId: upload.uploadId,
        state: "progress",
        nextOffset: upload.nextOffset,
      });
      return true;
    }
    if (message.state === "ready") {
      if (upload.state !== "verifying" || !validId(message.attachmentId)) {
        this.#failUpload(upload, "invalid_upload");
        return true;
      }
      upload.state = "ready";
      upload.attachmentId = message.attachmentId;
      upload.expiresAt = Math.floor(Date.now() / 1_000) + 30 * 60;
      this.#context.sendUser(upload.userSocket, {
        type: "session.attachment.status",
        sessionId: upload.sessionId,
        uploadId: upload.uploadId,
        state: "ready",
        ticket: issueAttachmentTicket(this.#context.ticketSecret, ticketBinding(upload)),
      });
      return true;
    }
    this.#context.sendUser(upload.userSocket, {
      type: "session.attachment.status",
      sessionId: upload.sessionId,
      uploadId: upload.uploadId,
      state: message.state,
      ...(message.state === "failed" ? { code: message.code ?? "connector_write_failed" } : {}),
    });
    this.#removeUpload(upload, false);
    return true;
  }

  handleConnectorOffline(identity: ConnectorIdentity): void {
    for (const upload of [...this.#uploads.values()]) {
      if (!sameConnector(upload, identity)) continue;
      this.#context.sendUser(upload.userSocket, {
        type: "session.attachment.status",
        sessionId: upload.sessionId,
        uploadId: upload.uploadId,
        state: "failed",
        code: "connector_offline",
      });
      this.#removeUpload(upload, false);
    }
  }

  commit(userId: string, sessionId: string, attachments: SessionCommandAttachment[]): void {
    const attachmentIds = new Set(attachments.map((attachment) => attachment.attachmentId));
    for (const upload of [...this.#uploads.values()]) {
      if (
        upload.userId === userId &&
        upload.sessionId === sessionId &&
        upload.attachmentId !== undefined &&
        attachmentIds.has(upload.attachmentId)
      ) this.#removeUpload(upload, false);
    }
  }

  removeUser(socket: WebSocket): void {
    const uploads = this.#uploadsByUser.get(socket);
    if (uploads !== undefined) {
      for (const transferId of uploads.values()) {
        const upload = this.#uploads.get(transferId);
        if (upload !== undefined) this.#removeUpload(upload, upload.state !== "ready");
      }
    }
    this.#uploadsByUser.delete(socket);
  }

  #findUpload(socket: WebSocket, sessionId: string, uploadId: string): UploadRoute | undefined {
    const transferId = this.#uploadsByUser.get(socket)?.get(uploadId);
    const upload = transferId === undefined ? undefined : this.#uploads.get(transferId);
    return upload?.sessionId === sessionId ? upload : undefined;
  }

  #failUpload(upload: UploadRoute, code: SessionAttachmentErrorCode, cancelConnector = true): void {
    this.#sendUploadFailure(upload.userSocket, upload.sessionId, upload.uploadId, code);
    this.#removeUpload(upload, cancelConnector);
  }

  #sendUploadFailure(
    socket: WebSocket,
    sessionId: string,
    uploadId: string,
    code: SessionAttachmentErrorCode,
  ): void {
    this.#context.sendUser(socket, {
      type: "session.attachment.status",
      sessionId,
      uploadId,
      state: "failed",
      code,
    });
  }

  #removeUpload(upload: UploadRoute, cancelConnector: boolean): void {
    this.#uploads.delete(upload.transferId);
    const userUploads = this.#uploadsByUser.get(upload.userSocket);
    userUploads?.delete(upload.uploadId);
    if (userUploads?.size === 0) this.#uploadsByUser.delete(upload.userSocket);
    if (!cancelConnector) return;
    const connector = this.#context.activeConnector(upload);
    if (connector !== undefined) {
      this.#context.sendConnector(connector, {
        type: "session.attachment.cancel",
        transferId: upload.transferId,
        uploadId: upload.uploadId,
      });
    }
  }
}

function appendPrefix(prefix: Buffer, bytes: Buffer): Buffer {
  if (prefix.length >= 12) return prefix;
  return Buffer.concat([prefix, bytes.subarray(0, 12 - prefix.length)]);
}

function ticketBinding(upload: UploadRoute) {
  if (upload.attachmentId === undefined || upload.expiresAt === undefined) {
    throw new Error("Attachment is not ready for a ticket");
  }
  return {
    userId: upload.userId,
    sessionId: upload.sessionId,
    workspaceId: upload.workspaceId,
    workstationId: upload.workstationId,
    uploadId: upload.uploadId,
    attachmentId: upload.attachmentId,
    mimeType: upload.mimeType,
    byteLength: upload.byteLength,
    sha256: upload.sha256,
    expiresAt: upload.expiresAt,
  };
}
