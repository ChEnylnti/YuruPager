import WebSocket, { type RawData } from "ws";

import type {
  ConnectorPayload,
  ConnectorSessionStreamControl,
  ConnectorSessionStreamMessage,
  DecisionInput,
  TransportEnvelope,
} from "@yurupager/shared";

import { SqliteMessageStore } from "./sqlite-message-store.js";

export interface RemoteDecision {
  type: "decision";
  messageId: string;
  sequence: number;
  requestId: string;
  decisionId: string;
  decision: DecisionInput;
}

export interface RemoteSessionCommand {
  type: "session.command";
  messageId: string;
  sequence: number;
  commandId: string;
  threadId: string;
  text: string;
  attachments: RemoteImageAttachment[];
}

export interface RemoteImageAttachment {
  attachmentId: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  byteLength: number;
  sha256: string;
}

export type RemoteSessionStreamControl = Extract<
  ConnectorSessionStreamControl,
  { type: "session.stream.subscribe" | "session.stream.unsubscribe" }
>;

export type RemoteAttachmentControl = Extract<ConnectorSessionStreamControl, { type: `session.attachment.${string}` }>;

export type ConnectorAttachmentStatus = Extract<ConnectorSessionStreamMessage, { type: "session.attachment.status" }>;

export interface ConnectorCloudClientOptions {
  url: string;
  token: string;
  store: SqliteMessageStore;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  random?: () => number;
}

export class ConnectorCloudClient {
  readonly #url: string;
  readonly #token: string;
  readonly #store: SqliteMessageStore;
  readonly #reconnectMinMs: number;
  readonly #reconnectMaxMs: number;
  readonly #random: () => number;
  readonly #decisionHandlers = new Set<(decision: RemoteDecision) => Promise<void> | void>();
  readonly #commandHandlers = new Set<(command: RemoteSessionCommand) => Promise<void> | void>();
  readonly #streamHandlers = new Set<(control: RemoteSessionStreamControl) => Promise<void> | void>();
  readonly #attachmentHandlers = new Set<(control: RemoteAttachmentControl) => Promise<void> | void>();
  readonly #statusHandlers = new Set<(online: boolean) => void>();
  readonly #processingInbound = new Set<string>();

  #socket: WebSocket | undefined;
  #stopped = true;
  #attempt = 0;
  #reconnectTimer: NodeJS.Timeout | undefined;

  constructor(options: ConnectorCloudClientOptions) {
    this.#url = options.url;
    this.#token = options.token;
    this.#store = options.store;
    this.#reconnectMinMs = options.reconnectMinMs ?? 1_000;
    this.#reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
    this.#random = options.random ?? Math.random;
  }

  get online(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 1_000);
      socket.once("close", () => { clearTimeout(timeout); resolve(); });
      socket.close(1000, "Connector stopping");
    });
  }

  send(payload: ConnectorPayload, idempotencyKey?: string): TransportEnvelope<ConnectorPayload> {
    const envelope = this.#store.enqueue(payload, idempotencyKey);
    this.#flush();
    return envelope;
  }

  readonly #ephemeralFrameListeners = new Set<(message: ConnectorSessionStreamMessage) => void>();

  /** Observes outbound ephemeral traffic (e.g. the workflow engine captures
   *  node hand-off text in memory only). */
  onEphemeralMessage(listener: (message: ConnectorSessionStreamMessage) => void): () => void {
    this.#ephemeralFrameListeners.add(listener);
    return () => this.#ephemeralFrameListeners.delete(listener);
  }

  sendEphemeral(message: ConnectorSessionStreamMessage): boolean {
    for (const listener of this.#ephemeralFrameListeners) listener(message);
    return this.#sendRaw(message);
  }

  sendAttachmentStatus(status: ConnectorAttachmentStatus): boolean {
    return this.#sendRaw(status);
  }

  onDecision(handler: (decision: RemoteDecision) => Promise<void> | void): () => void {
    this.#decisionHandlers.add(handler);
    return () => this.#decisionHandlers.delete(handler);
  }

  onCommand(handler: (command: RemoteSessionCommand) => Promise<void> | void): () => void {
    this.#commandHandlers.add(handler);
    return () => this.#commandHandlers.delete(handler);
  }

  onSessionStream(handler: (control: RemoteSessionStreamControl) => Promise<void> | void): () => void {
    this.#streamHandlers.add(handler);
    return () => this.#streamHandlers.delete(handler);
  }

  onAttachment(handler: (control: RemoteAttachmentControl) => Promise<void> | void): () => void {
    this.#attachmentHandlers.add(handler);
    return () => this.#attachmentHandlers.delete(handler);
  }

  onStatus(handler: (online: boolean) => void): () => void {
    this.#statusHandlers.add(handler);
    return () => this.#statusHandlers.delete(handler);
  }

  #connect(): void {
    if (this.#stopped) return;
    const socket = new WebSocket(this.#url, { headers: { authorization: `Bearer ${this.#token}` } });
    this.#socket = socket;
    socket.on("open", () => {
      this.#attempt = 0;
      this.#notifyStatus(true);
      socket.send(JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        streamId: this.#store.streamId,
        connectionEpoch: this.#store.connectionEpoch,
        lastInboundSequence: this.#store.latestInboundSequence(),
      }));
      this.#flush();
    });
    socket.on("message", (data) => {
      void this.#handle(data).catch(() => socket.close(1011, "Inbound message processing failed"));
    });
    socket.on("pong", () => undefined);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.#socket === socket) this.#socket = undefined;
      this.#notifyStatus(false);
      this.#scheduleReconnect();
    });
  }

  async #handle(raw: RawData): Promise<void> {
    const value = JSON.parse(raw.toString()) as unknown;
    if (!isRecord(value) || typeof value.type !== "string") return;
    if (value.type === "welcome" && typeof value.lastAcceptedSequence === "number") {
      this.#store.acknowledgeThrough(value.lastAcceptedSequence);
      this.#flush();
      return;
    }
    if (value.type === "ack" && typeof value.messageId === "string") {
      this.#store.acknowledge(value.messageId);
      return;
    }
    if (value.type === "heartbeat") {
      this.#sendRaw({ type: "heartbeat", timestamp: new Date().toISOString() });
      return;
    }
    if (value.type === "session.stream.subscribe" || value.type === "session.stream.unsubscribe") {
      const control = readSessionStreamControl(value);
      for (const handler of this.#streamHandlers) await handler(control);
      return;
    }
    if (value.type.startsWith("session.attachment.")) {
      const control = readAttachmentControl(value);
      if (this.#attachmentHandlers.size === 0) throw new Error("Attachment handler is not registered");
      for (const handler of this.#attachmentHandlers) await handler(control);
      return;
    }
    const inbound = readRemoteInbound(value);
    const fresh = this.#store.acceptInbound(inbound.messageId, inbound.sequence, inbound);
    if (!fresh) {
      this.#sendRaw({ type: "ack", messageId: inbound.messageId, sequence: inbound.sequence });
      return;
    }
    // A duplicate that arrives while the first delivery is still executing must
    // not acknowledge work that has not crossed the local processed boundary.
    if (this.#processingInbound.has(inbound.messageId)) return;
    this.#processingInbound.add(inbound.messageId);
    try {
      if (inbound.type === "session.command") {
        if (this.#commandHandlers.size === 0) throw new Error("Session command handler is not registered");
        for (const handler of this.#commandHandlers) await handler(inbound);
        this.#store.markInboundProcessed(inbound.messageId, true);
      } else {
        if (this.#decisionHandlers.size === 0) throw new Error("Decision handler is not registered");
        for (const handler of this.#decisionHandlers) await handler(inbound);
        this.#store.markInboundProcessed(inbound.messageId);
      }
    } finally {
      this.#processingInbound.delete(inbound.messageId);
    }
    this.#sendRaw({ type: "ack", messageId: inbound.messageId, sequence: inbound.sequence });
  }

  #flush(): void {
    if (!this.online) return;
    for (const envelope of this.#store.pending()) this.#sendRaw(envelope);
  }

  #sendRaw(value: unknown): boolean {
    if (this.#socket?.readyState !== WebSocket.OPEN) return false;
    this.#socket.send(JSON.stringify(value));
    return true;
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer !== undefined) return;
    const base = Math.min(this.#reconnectMaxMs, this.#reconnectMinMs * 2 ** this.#attempt++);
    const delay = Math.round(base * (0.8 + this.#random() * 0.4));
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, delay);
  }

  #notifyStatus(online: boolean): void {
    for (const handler of this.#statusHandlers) handler(online);
  }
}

function readSessionStreamControl(value: Record<string, unknown>): RemoteSessionStreamControl {
  if (
    (value.type !== "session.stream.subscribe" && value.type !== "session.stream.unsubscribe") ||
    typeof value.subscriptionId !== "string" ||
    value.subscriptionId.length === 0 ||
    typeof value.threadId !== "string" ||
    value.threadId.length === 0
  ) {
    throw new Error("Invalid session stream control message");
  }
  return value as unknown as RemoteSessionStreamControl;
}

function readRemoteInbound(value: Record<string, unknown>): RemoteDecision | RemoteSessionCommand {
  if (value.type === "session.command") {
    const attachments = readRemoteAttachments(value.attachments);
    if (
      typeof value.messageId !== "string" ||
      typeof value.sequence !== "number" ||
      !Number.isSafeInteger(value.sequence) ||
      typeof value.commandId !== "string" ||
      typeof value.threadId !== "string" ||
      typeof value.text !== "string" ||
      (Array.from(value.text).length < 1 && attachments.length === 0) ||
      Array.from(value.text).length > 8_000
    ) {
      throw new Error("Invalid remote session command");
    }
    return {
      type: "session.command",
      messageId: value.messageId,
      sequence: value.sequence,
      commandId: value.commandId,
      threadId: value.threadId,
      text: value.text,
      attachments,
    };
  }
  if (
    value.type !== "decision" ||
    typeof value.messageId !== "string" ||
    typeof value.sequence !== "number" ||
    typeof value.requestId !== "string" ||
    typeof value.decisionId !== "string" ||
    !isRecord(value.decision) ||
    (value.decision.decision !== "approve" && value.decision.decision !== "deny" && value.decision.decision !== "answer")
  ) {
    throw new Error("Invalid remote decision");
  }
  return value as unknown as RemoteDecision;
}

function readAttachmentControl(value: Record<string, unknown>): RemoteAttachmentControl {
  requireOpaqueProtocolId(value.transferId, "transferId");
  requireOpaqueProtocolId(value.uploadId, "uploadId");
  const base = { transferId: value.transferId as string, uploadId: value.uploadId as string };
  if (value.type === "session.attachment.begin") {
    if (
      typeof value.threadId !== "string" || value.threadId.length < 1 || value.threadId.length > 512 ||
      !isImageMimeType(value.mimeType) ||
      !Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 1 || (value.byteLength as number) > 5 * 1024 * 1024 ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256)
    ) throw new Error("Invalid attachment begin message");
    return {
      type: value.type,
      ...base,
      threadId: value.threadId,
      mimeType: value.mimeType,
      byteLength: value.byteLength as number,
      sha256: value.sha256,
    };
  }
  if (value.type === "session.attachment.chunk") {
    if (
      !Number.isSafeInteger(value.offset) || (value.offset as number) < 0 ||
      typeof value.data !== "string" || value.data.length < 4 || value.data.length > 65_536
    ) throw new Error("Invalid attachment chunk message");
    return { type: value.type, ...base, offset: value.offset as number, data: value.data };
  }
  if (value.type === "session.attachment.complete" || value.type === "session.attachment.cancel") {
    return { type: value.type, ...base };
  }
  throw new Error("Invalid attachment control message");
}

function readRemoteAttachments(value: unknown): RemoteImageAttachment[] {
  if (!Array.isArray(value) || value.length > 4) throw new Error("Invalid remote session attachments");
  let total = 0;
  return value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Invalid remote session attachment");
    requireOpaqueProtocolId(candidate.attachmentId, "attachmentId");
    if (
      !isImageMimeType(candidate.mimeType) ||
      !Number.isSafeInteger(candidate.byteLength) || (candidate.byteLength as number) < 1 || (candidate.byteLength as number) > 5 * 1024 * 1024 ||
      typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.sha256)
    ) throw new Error("Invalid remote session attachment");
    total += candidate.byteLength as number;
    if (total > 12 * 1024 * 1024) throw new Error("Remote session attachments exceed the total byte limit");
    return {
      attachmentId: candidate.attachmentId as string,
      mimeType: candidate.mimeType,
      byteLength: candidate.byteLength as number,
      sha256: candidate.sha256,
    };
  });
}

function requireOpaqueProtocolId(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error(`Invalid ${label}`);
}

function isImageMimeType(value: unknown): value is RemoteImageAttachment["mimeType"] {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
