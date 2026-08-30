import { createHash, randomUUID, type Hash } from "node:crypto";

import type { Pool } from "pg";
import type { WebSocket } from "ws";

import type {
  ConnectorSessionTitle,
  ConnectorSessionStreamMessage,
  ConnectorServerMessage,
  SessionAttachmentErrorCode,
  SessionCommandAttachment,
  SessionImageMimeType,
  SessionTitle,
  SessionStreamFrame,
  WebLiveClientMessage,
  WebLiveServerMessage,
} from "@yurupager/shared";
import { sessionImageLimits, sessionImageMimeTypes } from "@yurupager/shared";

import { issueAttachmentTicket } from "./attachment-ticket.js";
import type {
  ConnectorIdentity,
  OutboxDecision,
  OutboxSessionCommand,
} from "./connector-repository.js";
import {
  authorizeSessionStream,
  authorizeSessionTitles,
  authorizeSessionUpload,
} from "./repository.js";

interface IncomingImage {
  mimeType: SessionImageMimeType;
  byteLength: number;
  receivedBytes: number;
  nextSequence: number;
  hash: Hash;
  prefix: Buffer;
}

interface SessionRoute {
  subscriptionId: string;
  sessionId: string;
  workspaceId: string;
  workstationId: string;
  threadId: string;
  userId: string;
  userSocket: WebSocket;
  images: Map<string, IncomingImage>;
}

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

type ReliableConnectorMessage = Extract<ConnectorServerMessage, { type: "decision" | "session.command" }>;

interface ConnectorConnection {
  socket: WebSocket;
  phase: "pending" | "active";
  queued: Map<string, ReliableConnectorMessage>;
  sent: Set<string>;
}

export class SessionRelay {
  readonly #pool: Pool;
  readonly #routes = new Map<string, SessionRoute>();
  readonly #routesByUser = new Map<WebSocket, Set<string>>();
  readonly #connectors = new Map<string, ConnectorConnection>();
  readonly #users = new Map<WebSocket, string>();
  readonly #titleSnapshots = new Map<string, { identity: ConnectorIdentity; titles: ConnectorSessionTitle[] }>();
  readonly #uploads = new Map<string, UploadRoute>();
  readonly #uploadsByUser = new Map<WebSocket, Map<string, string>>();
  readonly #intentVersions = new Map<WebSocket, number>();
  readonly #ticketSecret: string;
  #titleVersion = 0;

  constructor(pool: Pool, ticketSecret = "yurupager-test-attachment-secret") {
    this.#pool = pool;
    this.#ticketSecret = ticketSecret;
  }

  async handleUserMessage(socket: WebSocket, userId: string, raw: string): Promise<void> {
    this.#sweepExpiredUploads();
    const value = JSON.parse(raw) as unknown;
    const message = readWebLiveClientMessage(value);
    switch (message.type) {
      case "session.stream.subscribe":
        await this.subscribeUser(socket, userId, message.sessionId);
        return;
      case "session.stream.unsubscribe":
        this.unsubscribeUser(socket, message.sessionId);
        return;
      case "session.attachment.begin":
        await this.#beginUpload(socket, userId, message);
        return;
      case "session.attachment.chunk":
        await this.#receiveUploadChunk(socket, userId, message);
        return;
      case "session.attachment.complete":
        await this.#completeUpload(socket, userId, message);
        return;
      case "session.attachment.cancel":
        this.#cancelUpload(socket, message.sessionId, message.uploadId);
        return;
    }
  }

  async attachUser(socket: WebSocket, userId: string): Promise<void> {
    this.#users.set(socket, userId);
    await this.#sendAllTitlesToUser(socket, userId, this.#titleVersion);
  }

  async subscribeUser(socket: WebSocket, userId: string, sessionId: string): Promise<void> {
    const version = (this.#intentVersions.get(socket) ?? 0) + 1;
    this.#intentVersions.set(socket, version);
    this.#removeUserRoutes(socket);
    this.#sendUser(socket, { type: "session.stream.status", sessionId, state: "loading" });

    let authorized: Awaited<ReturnType<typeof authorizeSessionStream>>;
    try {
      authorized = await authorizeSessionStream(this.#pool, userId, sessionId);
    } catch {
      if (this.#intentVersions.get(socket) === version) {
        this.#sendUser(socket, { type: "session.stream.status", sessionId, state: "denied" });
      }
      return;
    }
    if (this.#intentVersions.get(socket) !== version || !isOpen(socket)) return;

    const route: SessionRoute = {
      subscriptionId: randomUUID(),
      sessionId: authorized.sessionId,
      workspaceId: authorized.workspaceId,
      workstationId: authorized.workstationId,
      threadId: authorized.threadId,
      userId,
      userSocket: socket,
      images: new Map(),
    };
    this.#routes.set(route.subscriptionId, route);
    const userRoutes = this.#routesByUser.get(socket) ?? new Set<string>();
    userRoutes.add(route.subscriptionId);
    this.#routesByUser.set(socket, userRoutes);

    const connector = this.#activeConnector(route);
    if (connector === undefined) {
      this.#sendUser(socket, { type: "session.stream.status", sessionId, state: "connector_offline" });
      return;
    }
    this.#sendConnector(connector, {
      type: "session.stream.subscribe",
      subscriptionId: route.subscriptionId,
      threadId: route.threadId,
    });
  }

  unsubscribeUser(socket: WebSocket, sessionId?: string): void {
    this.#intentVersions.set(socket, (this.#intentVersions.get(socket) ?? 0) + 1);
    const ids = this.#routesByUser.get(socket);
    if (ids === undefined) return;
    for (const id of [...ids]) {
      const route = this.#routes.get(id);
      if (route !== undefined && (sessionId === undefined || route.sessionId === sessionId)) this.#removeRoute(route);
    }
  }

  removeUser(socket: WebSocket): void {
    this.unsubscribeUser(socket);
    const uploads = this.#uploadsByUser.get(socket);
    if (uploads !== undefined) {
      for (const transferId of uploads.values()) {
        const upload = this.#uploads.get(transferId);
        if (upload !== undefined) this.#removeUpload(upload, upload.state !== "ready");
      }
    }
    this.#uploadsByUser.delete(socket);
    this.#routesByUser.delete(socket);
    this.#intentVersions.delete(socket);
    this.#users.delete(socket);
  }

  registerPendingConnector(identity: ConnectorIdentity, socket: WebSocket): void {
    const key = connectorKey(identity);
    this.#connectors.set(key, { socket, phase: "pending", queued: new Map(), sent: new Set() });
  }

  activateConnector(identity: ConnectorIdentity, socket: WebSocket, replayedMessageIds: ReadonlySet<string>): boolean {
    const key = connectorKey(identity);
    const connection = this.#connectors.get(key);
    if (
      connection === undefined ||
      connection.socket !== socket ||
      connection.phase === "active" ||
      !isOpen(socket)
    ) return false;
    connection.phase = "active";
    for (const messageId of replayedMessageIds) connection.sent.add(messageId);

    const queued = [...connection.queued.values()]
      .filter((message) => !replayedMessageIds.has(message.messageId))
      .sort((left, right) => left.sequence - right.sequence);
    connection.queued.clear();
    for (const message of queued) {
      connection.sent.add(message.messageId);
      this.#sendConnector(socket, message);
    }

    if (this.#titleSnapshots.delete(key)) void this.#broadcastTitleSnapshot().catch(() => undefined);
    for (const route of this.#routes.values()) {
      if (!sameConnector(route, identity)) continue;
      this.#sendUser(route.userSocket, {
        type: "session.stream.status",
        sessionId: route.sessionId,
        state: "loading",
      });
      this.#sendConnector(socket, {
        type: "session.stream.subscribe",
        subscriptionId: route.subscriptionId,
        threadId: route.threadId,
      });
    }
    return true;
  }

  attachConnector(identity: ConnectorIdentity, socket: WebSocket): void {
    this.registerPendingConnector(identity, socket);
    this.activateConnector(identity, socket, new Set());
  }

  detachConnector(identity: ConnectorIdentity, socket: WebSocket): void {
    const key = connectorKey(identity);
    if (this.#connectors.get(key)?.socket !== socket) return;
    this.#connectors.delete(key);
    if (this.#titleSnapshots.delete(key)) void this.#broadcastTitleSnapshot().catch(() => undefined);
    for (const route of this.#routes.values()) {
      if (sameConnector(route, identity)) {
        this.#sendUser(route.userSocket, {
          type: "session.stream.status",
          sessionId: route.sessionId,
          state: "connector_offline",
        });
      }
    }
    for (const upload of [...this.#uploads.values()]) {
      if (!sameConnector(upload, identity)) continue;
      this.#sendUser(upload.userSocket, {
        type: "session.attachment.status",
        sessionId: upload.sessionId,
        uploadId: upload.uploadId,
        state: "failed",
        code: "connector_offline",
      });
      this.#removeUpload(upload, false);
    }
  }

  disconnectConnector(identity: ConnectorIdentity, reason = "Connector disconnected"): void {
    const connection = this.#connectors.get(connectorKey(identity));
    if (connection === undefined) return;
    try {
      connection.socket.close(4003, reason.slice(0, 120));
    } catch {
      connection.socket.terminate();
    }
  }

  pushSessionCommand(identity: ConnectorIdentity, command: OutboxSessionCommand): boolean {
    return this.#pushReliable(identity, {
      type: "session.command",
      messageId: command.messageId,
      sequence: command.sequence,
      commandId: command.commandId,
      threadId: command.threadId,
      text: command.text,
      attachments: command.attachments,
    });
  }

  pushDecision(identity: ConnectorIdentity, decision: OutboxDecision): boolean {
    return this.#pushReliable(identity, {
      type: "decision",
      messageId: decision.messageId,
      sequence: decision.sequence,
      requestId: decision.requestId,
      decisionId: decision.decisionId,
      decision: decision.decision,
    });
  }

  commitAttachments(userId: string, sessionId: string, attachments: SessionCommandAttachment[]): void {
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

  async #beginUpload(
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
        this.#sendUser(socket, {
          type: "session.attachment.status",
          sessionId: existing.sessionId,
          uploadId: existing.uploadId,
          state: existing.state === "ready" ? "ready" : "progress",
          ...(existing.state === "ready" && existing.attachmentId !== undefined && existing.expiresAt !== undefined
            ? { ticket: issueAttachmentTicket(this.#ticketSecret, ticketBinding(existing)) }
            : { nextOffset: existing.nextOffset }),
        });
        return;
      }
      this.#sendUploadFailure(socket, message.sessionId, message.uploadId, "invalid_upload");
      return;
    }

    let authorized: Awaited<ReturnType<typeof authorizeSessionUpload>>;
    try {
      authorized = await authorizeSessionUpload(this.#pool, userId, message.sessionId);
    } catch {
      this.#sendUploadFailure(socket, message.sessionId, message.uploadId, "permission_denied");
      return;
    }
    const connector = this.#activeConnector(authorized);
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
    this.#sendConnector(connector, {
      type: "session.attachment.begin",
      transferId: upload.transferId,
      uploadId: upload.uploadId,
      threadId: upload.threadId,
      mimeType: upload.mimeType,
      byteLength: upload.byteLength,
      sha256: upload.sha256,
    });
  }

  async #receiveUploadChunk(
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
    const connector = this.#activeConnector(upload);
    if (connector === undefined) {
      this.#failUpload(upload, "connector_offline", false);
      return;
    }
    this.#sendConnector(connector, {
      type: "session.attachment.chunk",
      transferId: upload.transferId,
      uploadId: upload.uploadId,
      offset: message.offset,
      data: message.data,
    });
  }

  async #completeUpload(
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
    const connector = this.#activeConnector(upload);
    if (connector === undefined) {
      this.#failUpload(upload, "connector_offline", false);
      return;
    }
    this.#sendConnector(connector, {
      type: "session.attachment.complete",
      transferId: upload.transferId,
      uploadId: upload.uploadId,
    });
  }

  #cancelUpload(socket: WebSocket, sessionId: string, uploadId: string): void {
    const upload = this.#findUpload(socket, sessionId, uploadId);
    if (upload === undefined) {
      this.#sendUser(socket, {
        type: "session.attachment.status",
        sessionId,
        uploadId,
        state: "cancelled",
      });
      return;
    }
    this.#sendUser(socket, {
      type: "session.attachment.status",
      sessionId,
      uploadId,
      state: "cancelled",
    });
    this.#removeUpload(upload, true);
  }

  async #stillAuthorized(upload: UploadRoute): Promise<boolean> {
    try {
      const authorized = await authorizeSessionUpload(this.#pool, upload.userId, upload.sessionId);
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
    this.#sendUser(socket, {
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
    const connector = this.#activeConnector(upload);
    if (connector !== undefined) {
      this.#sendConnector(connector, {
        type: "session.attachment.cancel",
        transferId: upload.transferId,
        uploadId: upload.uploadId,
      });
    }
  }

  #sweepExpiredUploads(): void {
    const now = Math.floor(Date.now() / 1_000);
    for (const upload of [...this.#uploads.values()]) {
      if (upload.expiresAt === undefined || upload.expiresAt > now) continue;
      this.#failUpload(upload, "upload_expired");
    }
  }

  async handleConnectorMessage(identity: ConnectorIdentity, value: unknown): Promise<boolean> {
    this.#sweepExpiredUploads();
    const record = readRecord(value);
    if (record === null) {
      return false;
    }
    if (record.type === "session.titles.snapshot") {
      const titles = readConnectorSessionTitles(record);
      this.#titleSnapshots.set(connectorKey(identity), { identity, titles });
      await this.#broadcastTitleSnapshot();
      return true;
    }
    if (record.type === "session.attachment.status") {
      const message = readConnectorAttachmentStatus(record);
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
        this.#sendUser(upload.userSocket, {
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
        this.#sendUser(upload.userSocket, {
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
        this.#sendUser(upload.userSocket, {
          type: "session.attachment.status",
          sessionId: upload.sessionId,
          uploadId: upload.uploadId,
          state: "ready",
          ticket: issueAttachmentTicket(this.#ticketSecret, ticketBinding(upload)),
        });
        return true;
      }
      this.#sendUser(upload.userSocket, {
        type: "session.attachment.status",
        sessionId: upload.sessionId,
        uploadId: upload.uploadId,
        state: message.state,
        ...(message.state === "failed" ? { code: message.code ?? "connector_write_failed" } : {}),
      });
      this.#removeUpload(upload, false);
      return true;
    }
    if (record.type !== "session.stream.frame" && record.type !== "session.stream.error") return false;
    const message = readConnectorSessionStreamMessage(record);
    const route = this.#routes.get(message.subscriptionId);
    if (route === undefined || !sameConnector(route, identity) || route.threadId !== message.threadId) return true;

    if (message.type === "session.stream.error") {
      this.#sendUser(route.userSocket, {
        type: "session.stream.status",
        sessionId: route.sessionId,
        state: "error",
      });
      return true;
    }
    if (isImageFrame(message.frame)) {
      try {
        const authorized = await authorizeSessionStream(this.#pool, route.userId, route.sessionId);
        if (!sameSessionRoute(route, authorized)) throw new Error("Session authorization changed");
      } catch {
        this.#sendUser(route.userSocket, {
          type: "session.stream.status",
          sessionId: route.sessionId,
          state: "denied",
        });
        this.#removeRoute(route);
        return true;
      }
      applyIncomingImageFrame(route, message.frame);
    } else if (message.frame.kind === "history.start") {
      route.images.clear();
    }
    this.#sendUser(route.userSocket, {
      type: "session.stream.frame",
      sessionId: route.sessionId,
      frame: message.frame,
    });
    if (message.frame.kind === "history.complete") {
      this.#sendUser(route.userSocket, {
        type: "session.stream.status",
        sessionId: route.sessionId,
        state: "live",
      });
    }
    return true;
  }

  async #sendAllTitlesToUser(socket: WebSocket, userId: string, version: number): Promise<void> {
    const snapshots = [...this.#titleSnapshots.values()];
    const authorized = await Promise.all(snapshots.map(async ({ identity, titles }) => {
      const byThread = new Map(titles.map((title) => [title.threadId, title.title]));
      const sessions = await authorizeSessionTitles(
        this.#pool,
        userId,
        identity.workspaceId,
        identity.workstationId,
        [...byThread.keys()],
      );
      return sessions.flatMap((session): SessionTitle[] => {
        const title = byThread.get(session.threadId);
        return title === undefined ? [] : [{ sessionId: session.sessionId, title }];
      });
    }));
    if (this.#titleVersion !== version || this.#users.get(socket) !== userId) return;
    const titles = new Map<string, string>();
    for (const batch of authorized) {
      for (const title of batch) titles.set(title.sessionId, title.title);
    }
    this.#sendUser(socket, {
      type: "session.titles.snapshot",
      titles: [...titles].map(([sessionId, title]) => ({ sessionId, title })),
    });
  }

  async #broadcastTitleSnapshot(): Promise<void> {
    const version = ++this.#titleVersion;
    await Promise.all([...this.#users].map(([socket, userId]) =>
      this.#sendAllTitlesToUser(socket, userId, version)));
  }

  #removeUserRoutes(socket: WebSocket): void {
    const ids = this.#routesByUser.get(socket);
    if (ids === undefined) return;
    for (const id of [...ids]) {
      const route = this.#routes.get(id);
      if (route !== undefined) this.#removeRoute(route);
    }
  }

  #removeRoute(route: SessionRoute): void {
    this.#routes.delete(route.subscriptionId);
    const userRoutes = this.#routesByUser.get(route.userSocket);
    userRoutes?.delete(route.subscriptionId);
    if (userRoutes?.size === 0) this.#routesByUser.delete(route.userSocket);
    const connector = this.#activeConnector(route);
    if (connector !== undefined) {
      this.#sendConnector(connector, {
        type: "session.stream.unsubscribe",
        subscriptionId: route.subscriptionId,
        threadId: route.threadId,
      });
    }
  }

  #sendUser(socket: WebSocket, message: WebLiveServerMessage): void {
    if (isOpen(socket)) socket.send(JSON.stringify(message));
  }

  #sendConnector(socket: WebSocket, message: ConnectorServerMessage): void {
    if (isOpen(socket)) socket.send(JSON.stringify(message));
  }

  #activeConnector(identity: ConnectorIdentity): WebSocket | undefined {
    const connection = this.#connectors.get(connectorKey(identity));
    return connection?.phase === "active" && isOpen(connection.socket) ? connection.socket : undefined;
  }

  #pushReliable(identity: ConnectorIdentity, message: ReliableConnectorMessage): boolean {
    const connection = this.#connectors.get(connectorKey(identity));
    if (connection === undefined || !isOpen(connection.socket)) return false;
    if (connection.phase === "pending") {
      connection.queued.set(message.messageId, message);
    } else {
      if (connection.sent.has(message.messageId)) return true;
      connection.sent.add(message.messageId);
      this.#sendConnector(connection.socket, message);
    }
    return true;
  }
}

function readWebLiveClientMessage(value: unknown): WebLiveClientMessage {
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

type ConnectorStreamRouteMessage = Extract<ConnectorSessionStreamMessage,
  { type: "session.stream.frame" | "session.stream.error" }>;

type ConnectorAttachmentStatus = Extract<ConnectorSessionStreamMessage,
  { type: "session.attachment.status" }>;

function readConnectorAttachmentStatus(record: Record<string, unknown>): ConnectorAttachmentStatus {
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

function readConnectorSessionStreamMessage(record: Record<string, unknown>): ConnectorStreamRouteMessage {
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

function readConnectorSessionTitles(record: Record<string, unknown>): ConnectorSessionTitle[] {
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

function isSessionStreamFrame(value: unknown): value is SessionStreamFrame {
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

function applyIncomingImageFrame(route: SessionRoute, frame: SessionStreamFrame): void {
  if (frame.kind === "image.start") {
    if (route.images.has(frame.imageId)) throw new Error("Duplicate Connector image start");
    route.images.set(frame.imageId, {
      mimeType: frame.mimeType,
      byteLength: frame.byteLength,
      receivedBytes: 0,
      nextSequence: 0,
      hash: createHash("sha256"),
      prefix: Buffer.alloc(0),
    });
    return;
  }
  if (frame.kind === "image.chunk") {
    const image = route.images.get(frame.imageId);
    if (image === undefined || frame.sequence !== image.nextSequence) {
      throw new Error("Connector image chunk is out of order");
    }
    const bytes = decodeBase64Chunk(frame.data);
    if (image.receivedBytes + bytes.length > image.byteLength) {
      throw new Error("Connector image exceeded its declared size");
    }
    image.hash.update(bytes);
    image.prefix = appendPrefix(image.prefix, bytes);
    image.receivedBytes += bytes.length;
    image.nextSequence += 1;
    return;
  }
  if (frame.kind === "image.complete") {
    const image = route.images.get(frame.imageId);
    if (
      image === undefined ||
      image.receivedBytes !== image.byteLength ||
      !matchesImageSignature(image.mimeType, image.prefix) ||
      image.hash.digest("hex") !== frame.sha256
    ) throw new Error("Connector image verification failed");
    route.images.delete(frame.imageId);
    return;
  }
  if (frame.kind === "image.error") route.images.delete(frame.imageId);
}

function decodeBase64Chunk(value: string): Buffer {
  if (
    value.length < 4 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) throw new Error("Invalid Base64 image chunk");
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length < 1 ||
    bytes.length > sessionImageLimits.maxChunkBytes ||
    bytes.toString("base64") !== value
  ) throw new Error("Invalid Base64 image chunk");
  return bytes;
}

function appendPrefix(prefix: Buffer, bytes: Buffer): Buffer {
  if (prefix.length >= 12) return prefix;
  return Buffer.concat([prefix, bytes.subarray(0, 12 - prefix.length)]);
}

function matchesImageSignature(mimeType: SessionImageMimeType, prefix: Buffer): boolean {
  if (mimeType === "image/png") {
    return prefix.length >= 8 && prefix.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }
  if (mimeType === "image/jpeg") {
    return prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  }
  return prefix.length >= 12 &&
    prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
    prefix.subarray(8, 12).toString("ascii") === "WEBP";
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

function isImageFrame(frame: SessionStreamFrame): boolean {
  return frame.kind === "image.start" || frame.kind === "image.chunk" ||
    frame.kind === "image.complete" || frame.kind === "image.error";
}

function isAttachmentErrorCode(value: unknown): value is SessionAttachmentErrorCode {
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

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500;
}

function connectorKey(value: Pick<ConnectorIdentity, "workspaceId" | "workstationId">): string {
  return `${value.workspaceId}:${value.workstationId}`;
}

function sameConnector(
  route: Pick<SessionRoute, "workspaceId" | "workstationId">,
  identity: ConnectorIdentity,
): boolean {
  return route.workspaceId === identity.workspaceId && route.workstationId === identity.workstationId;
}

function sameSessionRoute(
  route: SessionRoute,
  authorized: Pick<SessionRoute, "sessionId" | "workspaceId" | "workstationId" | "threadId">,
): boolean {
  return route.sessionId === authorized.sessionId &&
    route.workspaceId === authorized.workspaceId &&
    route.workstationId === authorized.workstationId &&
    route.threadId === authorized.threadId;
}

function isOpen(socket: WebSocket): boolean {
  return socket.readyState === socket.OPEN;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
