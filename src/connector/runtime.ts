import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, normalize, relative } from "node:path";

import type {
  ConnectorPayload,
  ConnectorSessionTitle,
  DecisionInput,
  SessionStreamFrame,
} from "@yurupager/shared";

import { adaptNotification, adaptServerRequest } from "../codex/adapter.js";
import {
  applyConversationFrames,
  conversationNotificationFrames,
  conversationPatchFrames,
  conversationSnapshot,
  conversationSnapshotFrames,
  type ConversationSnapshot,
} from "../codex/conversation.js";
import { ImageMediaError } from "../codex/image-media.js";
import {
  SqliteLocalImageStore,
  type ImageAttachmentReference,
} from "../codex/local-image-store.js";
import type {
  AdaptedRequest,
  ApprovalDecision,
  CodexServerRequest,
  DomainEvent,
  DomainRequest,
  TokenUsageUpdatedEvent,
} from "../codex/domain.js";
import { CodexAppServerClient } from "../codex/json-rpc-client.js";
import { SqliteApprovalJournal } from "../reliability/sqlite-approval-journal.js";
import { SqliteCommandJournal, type CommandDeliveryRecord } from "../reliability/sqlite-command-journal.js";
import { SqliteDecisionLedger } from "../reliability/sqlite-decision-ledger.js";
import {
  ConnectorCloudClient,
  type ConnectorAttachmentStatus,
  type RemoteAttachmentControl,
  type RemoteDecision,
  type RemoteSessionStreamControl,
  type RemoteSessionCommand,
} from "../transport/connector-cloud-client.js";
import { enforceCodexVersion } from "./version-gate.js";
import type {
  AgentCapabilities,
  AgentDiscoveredSessionSnapshot,
  AgentEventSink,
  AgentModelOption,
  AgentRuntime,
  AgentSessionOptions,
  AgentStartSessionOptions,
} from "../agents/types.js";
import { assertSessionOptionsSupported } from "../agents/session-options.js";

interface PendingCodexRequest {
  adapted: AdaptedRequest;
  source: CodexServerRequest;
  timeout: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface ActiveSessionStream {
  threadId: string;
  loading: boolean;
  revision: number;
  syncQueued: boolean;
  snapshot?: ConversationSnapshot;
  pollTimer?: NodeJS.Timeout;
  notificationTimer?: NodeJS.Timeout;
  syncInFlight?: Promise<void>;
}

interface RemoteTurnClient {
  client: CodexAppServerClient;
  threadId: string;
  turnId: string | null;
  turnStartAttempted: boolean;
  ambiguous: boolean;
  terminalTurnIds: Set<string>;
  removeNotificationHandler: () => void;
  releaseTimer?: NodeJS.Timeout;
  unknownTimer?: NodeJS.Timeout;
  stopping?: Promise<void>;
  queue?: RemoteThreadCommandQueue;
  job?: QueuedRemoteSessionCommand;
  queueReleased: boolean;
}

interface QueuedRemoteSessionCommand {
  remote: RemoteSessionCommand;
  sessionOptions: AgentSessionOptions | undefined;
  payloadHash: string;
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  settled: boolean;
}

interface RemoteThreadCommandQueue {
  threadId: string;
  pending: QueuedRemoteSessionCommand[];
  active?: RemoteTurnClient;
  blocked: boolean;
}

export interface ConnectorRuntimeOptions {
  cloud: ConnectorCloudClient;
  /** Protocol v2 agent identity stamped onto outbound session payloads. */
  agentId?: string;
  codex: CodexAppServerClient;
  journal: SqliteApprovalJournal;
  commands: SqliteCommandJournal;
  decisions: SqliteDecisionLedger;
  media?: SqliteLocalImageStore;
  codexCommand?: string;
  skipVersionGate?: boolean;
  /**
   * When false the runtime does not subscribe to the shared cloud client
   * itself; the multi-agent orchestrator routes callbacks instead (ADR-024).
   */
  registerCloudHandlers?: boolean;
  workstationName: string;
  platform: string;
  connectorVersion: string;
  projectName: string;
  projectPath: string;
  model: string;
  initiatedByEmail?: string;
  requestTimeoutMs?: number;
  modelCatalogueLimit?: number;
  sessionRefreshMs?: number;
  sessionStreamPollMs?: number;
  turnClientReleaseDelayMs?: number;
  turnClientUnknownTimeoutMs?: number;
  createTurnClient?: (onServerResponseWritten: (request: CodexServerRequest) => void) => CodexAppServerClient;
}

type SessionUpsertPayload = Extract<ConnectorPayload, { type: "session.upsert" }>;

export interface DiscoveredCodexSessionSnapshot {
  sessions: SessionUpsertPayload[];
  titles: ConnectorSessionTitle[];
}

export class ConnectorRuntime implements AgentRuntime {
  readonly #agentId: string;
  readonly #cloud: ConnectorCloudClient;
  readonly #codex: CodexAppServerClient;
  readonly #journal: SqliteApprovalJournal;
  readonly #commands: SqliteCommandJournal;
  readonly #decisions: SqliteDecisionLedger;
  readonly #media: SqliteLocalImageStore | undefined;
  readonly #options: ConnectorRuntimeOptions;
  readonly #pending = new Map<string, PendingCodexRequest>();
  readonly #pendingByRpc = new Map<string, string>();
  readonly #sessionStreams = new Map<string, ActiveSessionStream>();
  readonly #discoveredSessions = new Map<string, SessionUpsertPayload>();
  readonly #sessionSignatures = new Map<string, string>();
  readonly #sessionTitles = new Map<string, string>();
  readonly #attachmentTransfers = new Map<string, { transferId: string; threadId: string }>();
  readonly #turnClients = new Set<RemoteTurnClient>();
  readonly #remoteCommandQueues = new Map<string, RemoteThreadCommandQueue>();
  readonly #remoteCommandJobs = new Map<string, QueuedRemoteSessionCommand>();
  #sessionRefreshTimer: NodeJS.Timeout | undefined;
  #sessionRefreshInFlight: Promise<void> | undefined;
  readonly #tokenSequences = new Map<string, number>();
  #modelCatalogue: AgentModelOption[] = [];
  #stopping = false;

  /** Agent identity for protocol v2 payload stamping. */
  get agentId(): string {
    return this.#agentId;
  }

  constructor(options: ConnectorRuntimeOptions) {
    this.#agentId = options.agentId ?? "codex";
    this.#options = options;
    this.#cloud = options.cloud;
    this.#codex = options.codex;
    this.#journal = options.journal;
    this.#commands = options.commands;
    this.#decisions = options.decisions;
    this.#media = options.media;
    if (this.#options.registerCloudHandlers !== false) {
      this.#cloud.onDecision((decision) => this.#handleDecision(decision));
      this.#cloud.onCommand((command) => this.#handleSessionCommand(command));
      this.#cloud.onSessionStream((control) => this.#handleSessionStream(control));
      if (this.#media !== undefined) {
        this.#cloud.onAttachment((control) => this.#handleAttachment(control));
      }
      this.#cloud.onStatus((online) => {
        if (online) this.handleCloudOnline();
      });
    }
    this.#codex.setServerRequestHandler((request) => this.#handleCodexRequest(request));
    this.#codex.onNotification(async (notification) => {
      await this.#handleCodexNotification(notification);
    });
  }

  async start(): Promise<void> {
    this.#stopping = false;
    this.#restoreAmbiguousCommandBlocks();
    if (this.#options.skipVersionGate !== true) {
      await enforceCodexVersion(this.#options.codexCommand ?? "codex");
    }
    for (const record of this.#journal.listByState("sent_unknown")) {
      this.#cloud.send(
        { type: "delivery.updated", requestId: record.requestId, deliveryStatus: "sent_unknown" },
        `sent-unknown:${record.requestId}`,
      );
    }
    this.#cloud.start();
    this.#cloud.send({
      type: "workstation.heartbeat",
      name: this.#options.workstationName,
      platform: this.#options.platform,
      connectorVersion: this.#options.connectorVersion,
    }, "workstation-start");
    await this.#codex.start();
    const initialized = await this.#codex.initialize({
      name: "yurupager-connector",
      title: "YuruPager Connector",
      version: this.#options.connectorVersion,
    });
    if (initialized.platformOs.length === 0) {
      throw new Error("Codex app-server capability probe returned no platform");
    }
    const modelListing = await this.#codex.request("model/list", {
      limit: this.#options.modelCatalogueLimit ?? 25,
      includeHidden: false,
    }) as { data?: unknown; models?: unknown } | null;
    this.#modelCatalogue = extractCodexModels(modelListing);
    await this.#refreshSessions();
    const refreshMs = this.#options.sessionRefreshMs ?? 30_000;
    if (refreshMs > 0) {
      this.#sessionRefreshTimer = setInterval(() => {
        void this.#refreshSessions().catch(() => undefined);
      }, refreshMs);
      this.#sessionRefreshTimer.unref();
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#sessionRefreshTimer !== undefined) {
      clearInterval(this.#sessionRefreshTimer);
      this.#sessionRefreshTimer = undefined;
    }
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Connector stopped while request was pending"));
    }
    this.#pending.clear();
    this.#pendingByRpc.clear();
    for (const [subscriptionId, stream] of this.#sessionStreams) this.#removeSessionStream(subscriptionId, stream);
    for (const queue of this.#remoteCommandQueues.values()) {
      for (const job of queue.pending) {
        this.#rejectQueuedCommand(job, new Error("Connector stopped before session command was dispatched"));
      }
      queue.pending.length = 0;
      if (queue.active?.job !== undefined) {
        this.#rejectQueuedCommand(queue.active.job, new Error("Connector stopped while session command was dispatching"));
      }
    }
    const turnClientStops = [...this.#turnClients].map((turnClient) => this.#stopTurnClient(turnClient));
    await Promise.all([...turnClientStops, this.#codex.stop(), this.#cloud.stop()]);
    this.#remoteCommandQueues.clear();
    this.#remoteCommandJobs.clear();
  }

  attach(_sink: AgentEventSink): void {
    // Legacy Codex path publishes through the cloud client directly; the
    // orchestrator-mode sink is adopted when this runtime is generalised.
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      agentId: this.#agentId,
      displayName: "Codex",
      discovery: "global",
      questions: true,
      usageReporting: true,
      imageAttachments: true,
      models: this.#modelCatalogue,
    };
  }

  async startSession(options: AgentStartSessionOptions): Promise<{ sessionId: string }> {
    assertSessionOptionsSupported(this.#agentId, options, this.#modelCatalogue);
    const captured = await this.#captureNewThread(options);
    const payload: SessionUpsertPayload = {
      type: "session.upsert",
      threadId: captured,
      agent: this.#agentId,
      sessionId: captured,
      projectKey: projectKey(normalize(this.#options.projectPath)),
      projectName: projectNameFromPath(normalize(this.#options.projectPath), this.#options.projectName),
      projectPath: projectPathHint(normalize(this.#options.projectPath)),
      model: options.model ?? this.#options.model,
      status: "running",
      syncState: "live",
      updatedAt: new Date().toISOString(),
    };
    if (this.#options.initiatedByEmail !== undefined) payload.initiatedByEmail = this.#options.initiatedByEmail;
    this.#cloud.send(payload, `session:${captured}`);
    return { sessionId: captured };
  }

  /** Dispatches turn/start without a thread id and captures the new thread. */
  async #captureNewThread(options: AgentStartSessionOptions): Promise<string> {
    const input: Array<{ type: "text"; text: string }> = [{ type: "text", text: options.initialPrompt }];
    let capture: ((threadId: string) => void) | undefined;
    const captured = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex did not announce a new thread for startSession")), 30_000);
      capture = (threadId) => {
        clearTimeout(timer);
        resolve(threadId);
      };
    });
    const removeHandler = this.#codex.onNotification((notification) => {
      if (notification.method !== "thread/started" || !isRecord(notification.params)) return;
      const thread = notification.params.thread;
      if (isRecord(thread) && typeof thread.id === "string") capture?.(thread.id);
    });
    try {
      await this.#codex.request("turn/start", {
        input,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.reasoningEffort === undefined ? {} : { model_reasoning_effort: options.reasoningEffort }),
      });
      return await captured;
    } finally {
      removeHandler();
      capture = undefined;
    }
  }

  async listSessions(): Promise<AgentDiscoveredSessionSnapshot | null> {
    return discoverCodexSessionSnapshot(this.#codex, this.#options);
  }

  handleDecision(remote: RemoteDecision): Promise<void> {
    return this.#handleDecision(remote);
  }

  handleSessionCommand(remote: RemoteSessionCommand, options?: AgentSessionOptions): Promise<void> {
    return this.#handleSessionCommand(remote, options);
  }

  handleSessionStream(control: RemoteSessionStreamControl): Promise<void> {
    return this.#handleSessionStream(control);
  }

  handleAttachment(control: RemoteAttachmentControl): Promise<void> {
    return this.#handleAttachment(control);
  }

  handleCloudOnline(): void {
    queueMicrotask(() => {
      this.#sessionSignatures.clear();
      void this.#refreshSessions().catch(() => undefined);
      this.#sendSessionTitles();
    });
  }

  markCodexResponseWritten(request: CodexServerRequest): void {
    const requestId = this.#pendingByRpc.get(rpcKey(request));
    if (requestId === undefined) return;
    const pending = this.#pending.get(requestId);
    this.#pendingByRpc.delete(rpcKey(request));
    this.#pending.delete(requestId);
    if (pending !== undefined) clearTimeout(pending.timeout);
    const record = this.#journal.get(requestId);
    if (record?.state === "sent_unknown") {
      this.#journal.markDelivered(requestId);
      this.#cloud.send(
        { type: "delivery.updated", requestId, deliveryStatus: "delivered" },
        `delivered:${requestId}`,
      );
    }
  }

  async #handleCodexRequest(request: CodexServerRequest): Promise<unknown> {
    const adapted = adaptServerRequest(request);
    if (adapted === null) {
      throw new Error(`Unsupported Codex server request: ${request.method}`);
    }
    const domain = adapted.domain;
    this.#sendSession(domain);
    this.#cloud.send(toRequestPayload(domain, this.#agentId), `request:${domain.requestId}`);
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(domain.requestId);
        this.#pendingByRpc.delete(rpcKey(request));
        this.#cloud.send(
          { type: "request.resolved", requestId: domain.requestId, status: "cancelled", reason: "connector_timeout" },
          `timeout:${domain.requestId}`,
        );
        reject(new Error("YuruPager approval timed out; request failed closed"));
      }, this.#options.requestTimeoutMs ?? 15 * 60_000);
      this.#pending.set(domain.requestId, { adapted, source: request, timeout, resolve, reject });
      this.#pendingByRpc.set(rpcKey(request), domain.requestId);
    });
  }

  async #handleDecision(remote: RemoteDecision): Promise<void> {
    const pending = this.#pending.get(remote.requestId);
    if (pending === undefined) {
      this.#cloud.send(
        { type: "request.resolved", requestId: remote.requestId, status: "interrupted", reason: "codex_request_not_pending" },
        `not-pending:${remote.requestId}`,
      );
      return;
    }
    try {
      if (pending.adapted.domain.type === "approval.requested") {
        const decision = readApprovalDecision(remote.decision);
        this.#decisions.decide(remote.requestId, remote.decisionId, decision);
        this.#journal.prepare(remote.requestId);
        this.#journal.beginDispatch(remote.requestId);
        pending.resolve(
          pending.adapted.createCodexResponse({ kind: "approval", decision }),
        );
        return;
      }
      if (remote.decision.decision !== "answer" || remote.decision.answers === undefined) {
        throw new Error("Question request requires structured answers");
      }
      pending.resolve(
        pending.adapted.createCodexResponse({ kind: "answers", answers: remote.decision.answers }),
      );
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error("Decision dispatch failed"));
    }
  }

  async #handleSessionCommand(remote: RemoteSessionCommand, options?: AgentSessionOptions): Promise<void> {
    assertSessionOptionsSupported(this.#agentId, options, this.#modelCatalogue);
    const payloadHash = sessionCommandPayloadHash(remote, options);
    const currentJob = this.#remoteCommandJobs.get(remote.commandId);
    if (currentJob !== undefined) {
      if (currentJob.remote.threadId !== remote.threadId || currentJob.payloadHash !== payloadHash) {
        throw new Error("Session command payload does not match its idempotency key");
      }
      return currentJob.promise;
    }

    const existing = this.#commands.get(remote.commandId);
    if (existing !== undefined) {
      if (existing.threadId !== remote.threadId || existing.payloadHash !== payloadHash) {
        throw new Error("Session command payload does not match its idempotency key");
      }
      if (existing.state !== "prepared") {
        this.#reportSessionCommand(existing);
        if (existing.state === "sent_unknown") this.#threadCommandQueue(remote.threadId).blocked = true;
        return;
      }
    }

    if (this.#stopping) throw new Error("Connector is stopping");
    const job = this.#createQueuedCommand(remote, options, payloadHash);
    this.#remoteCommandJobs.set(remote.commandId, job);
    const queue = this.#threadCommandQueue(remote.threadId);
    queue.pending.push(job);
    this.#pumpThreadCommandQueue(queue);
    return job.promise;
  }

  #createQueuedCommand(remote: RemoteSessionCommand, sessionOptions: AgentSessionOptions | undefined, payloadHash: string): QueuedRemoteSessionCommand {
    let resolvePromise: (() => void) | undefined;
    let rejectPromise: ((error: Error) => void) | undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    return {
      remote,
      sessionOptions,
      payloadHash,
      promise,
      resolve: () => resolvePromise?.(),
      reject: (error) => rejectPromise?.(error),
      settled: false,
    };
  }

  #threadCommandQueue(threadId: string): RemoteThreadCommandQueue {
    const existing = this.#remoteCommandQueues.get(threadId);
    if (existing !== undefined) return existing;
    const queue: RemoteThreadCommandQueue = {
      threadId,
      pending: [],
      blocked: false,
    };
    this.#remoteCommandQueues.set(threadId, queue);
    return queue;
  }

  #restoreAmbiguousCommandBlocks(): void {
    for (const record of this.#commands.listByState("sent_unknown")) {
      this.#threadCommandQueue(record.threadId).blocked = true;
    }
  }

  #pumpThreadCommandQueue(queue: RemoteThreadCommandQueue): void {
    if (this.#stopping || queue.blocked || queue.active !== undefined) return;
    const job = queue.pending.shift();
    if (job === undefined) {
      if (this.#remoteCommandQueues.get(queue.threadId) === queue) this.#remoteCommandQueues.delete(queue.threadId);
      return;
    }
    const turnClient = this.#createRemoteTurnClient(queue.threadId);
    turnClient.queue = queue;
    turnClient.job = job;
    queue.active = turnClient;
    this.#turnClients.add(turnClient);
    void this.#runQueuedSessionCommand(turnClient);
  }

  async #runQueuedSessionCommand(turnClient: RemoteTurnClient): Promise<void> {
    const queue = turnClient.queue;
    const job = turnClient.job;
    if (queue === undefined || job === undefined) throw new Error("Remote turn client was not assigned a command queue");
    try {
      await turnClient.client.start();
      if (this.#stopping) throw new Error("Connector stopped while starting session command");
      await turnClient.client.initialize({
        name: "yurupager-remote-turn",
        title: "YuruPager Remote Turn",
        version: this.#options.connectorVersion,
      });
      if (this.#stopping) throw new Error("Connector stopped while initializing session command");
      const result = await dispatchSessionCommand(
        turnClient.client,
        this.#commands,
        job.remote,
        this.#media,
        {
          onTurnStartAttempted: () => { turnClient.turnStartAttempted = true; },
          onTurnStarted: (turnId) => { turnClient.turnId = turnId; },
        },
        job.sessionOptions,
      );
      this.#reportSessionCommand(result);

      if (result.state === "sent_unknown") {
        // Once turn/start may have been written, preserve the write boundary by
        // holding every later command for this thread until an explicit recovery.
        queue.blocked = true;
        turnClient.ambiguous = turnClient.turnStartAttempted;
        this.#resolveQueuedCommand(job);
        if (turnClient.ambiguous) {
          if (turnClient.terminalTurnIds.size > 0) {
            this.#scheduleTurnClientStop(turnClient);
          } else {
            this.#armUnknownTurnTimeout(turnClient);
          }
          return;
        }
        await this.#stopTurnClient(turnClient);
        return;
      }

      this.#resolveQueuedCommand(job);
      if (turnClient.turnId !== null && turnClient.terminalTurnIds.has(turnClient.turnId)) {
        this.#scheduleTurnClientStop(turnClient);
        return;
      }
      if (result.state !== "delivered" || turnClient.turnId === null) {
        await this.#stopTurnClient(turnClient);
      }
    } catch (error) {
      queue.blocked = true;
      this.#rejectQueuedCommand(
        job,
        error instanceof Error ? error : new Error("Session command dispatch failed"),
      );
      await this.#stopTurnClient(turnClient);
    }
  }

  #resolveQueuedCommand(job: QueuedRemoteSessionCommand): void {
    if (job.settled) return;
    job.settled = true;
    if (this.#remoteCommandJobs.get(job.remote.commandId) === job) {
      this.#remoteCommandJobs.delete(job.remote.commandId);
    }
    job.resolve();
  }

  #rejectQueuedCommand(job: QueuedRemoteSessionCommand, error: Error): void {
    if (job.settled) return;
    job.settled = true;
    if (this.#remoteCommandJobs.get(job.remote.commandId) === job) {
      this.#remoteCommandJobs.delete(job.remote.commandId);
    }
    job.reject(error);
  }

  async #handleAttachment(control: RemoteAttachmentControl): Promise<void> {
    const media = this.#media;
    if (media === undefined) return;
    const status: ConnectorAttachmentStatus = {
      type: "session.attachment.status",
      transferId: control.transferId,
      uploadId: control.uploadId,
      state: "failed",
      code: "connector_write_failed",
    };
    try {
      if (control.type === "session.attachment.begin") {
        const result = media.beginUpload({
          uploadId: control.uploadId,
          threadId: control.threadId,
          mimeType: control.mimeType,
          byteLength: control.byteLength,
          sha256: control.sha256,
        });
        this.#attachmentTransfers.set(control.uploadId, {
          transferId: control.transferId,
          threadId: control.threadId,
        });
        this.#sendAttachmentResult(status, result);
        return;
      }
      const transfer = this.#attachmentTransfers.get(control.uploadId);
      if (transfer?.transferId !== control.transferId) {
        throw new ImageMediaError("invalid_transfer", "Image transfer is not active");
      }
      if (control.type === "session.attachment.chunk") {
        this.#sendAttachmentResult(status, media.appendChunk(control.uploadId, control.offset, control.data));
        return;
      }
      if (control.type === "session.attachment.complete") {
        const result = media.completeUpload(control.uploadId);
        this.#sendAttachmentResult(status, result);
        this.#attachmentTransfers.delete(control.uploadId);
        return;
      }
      this.#sendAttachmentResult(status, media.cancelUpload(control.uploadId));
      this.#attachmentTransfers.delete(control.uploadId);
    } catch (error) {
      if (control.type !== "session.attachment.begin") {
        try { media.cancelUpload(control.uploadId); } catch { /* keep the original canonical error */ }
        this.#attachmentTransfers.delete(control.uploadId);
      }
      status.code = attachmentStatusErrorCode(error, control.type);
      this.#cloud.sendAttachmentStatus(status);
    }
  }

  #sendAttachmentResult(
    base: ConnectorAttachmentStatus,
    result: ReturnType<SqliteLocalImageStore["beginUpload"]>,
  ): void {
    const status: ConnectorAttachmentStatus = {
      type: base.type,
      transferId: base.transferId,
      uploadId: base.uploadId,
      state: result.state,
      nextOffset: result.nextOffset,
    };
    if (result.state === "ready") status.attachmentId = result.attachment.attachmentId;
    this.#cloud.sendAttachmentStatus(status);
  }

  async #handleSessionStream(control: RemoteSessionStreamControl): Promise<void> {
    if (control.type === "session.stream.unsubscribe") {
      const current = this.#sessionStreams.get(control.subscriptionId);
      if (current?.threadId === control.threadId) this.#removeSessionStream(control.subscriptionId, current);
      return;
    }

    const previous = this.#sessionStreams.get(control.subscriptionId);
    if (previous !== undefined) this.#removeSessionStream(control.subscriptionId, previous);
    const stream: ActiveSessionStream = {
      threadId: control.threadId,
      loading: true,
      revision: 0,
      syncQueued: false,
    };
    this.#sessionStreams.set(control.subscriptionId, stream);
    await this.#syncSessionStream(control.subscriptionId, stream, true);
  }

  #reportSessionCommand(record: CommandDeliveryRecord): void {
    if (record.state === "prepared") return;
    const payload: Extract<ConnectorPayload, { type: "session.command.updated" }> = {
      type: "session.command.updated",
      commandId: record.commandId,
      threadId: record.threadId,
      status: record.state,
    };
    if (record.turnId !== null) payload.turnId = record.turnId;
    if (record.errorCode !== null) payload.errorCode = record.errorCode;
    this.#cloud.send(payload, `session-command:${record.commandId}:${record.state}`);
  }

  async #handleCodexNotification(notification: { method: string; params: unknown }): Promise<DomainEvent | null> {
    if (notification.method === "thread/started" && isRecord(notification.params)) {
      const sessions = await sessionPayloadsFromThreadList(
        { data: [notification.params.thread] },
        this.#options,
      );
      for (const session of sessions) this.#sendDiscoveredSession(session);
      for (const title of sessionTitlesFromThreadList({ data: [notification.params.thread] })) {
        this.#rememberSessionTitle(title);
      }
      this.#sendSessionTitles();
    }
    const conversation = conversationNotificationFrames(notification);
    if (conversation !== null) {
      for (const [subscriptionId, stream] of this.#sessionStreams) {
        if (stream.threadId !== conversation.threadId) continue;
        if (stream.loading || stream.snapshot === undefined) {
          stream.syncQueued = true;
          continue;
        }
        for (const frame of conversation.frames) {
          this.#sendSessionStreamFrame(subscriptionId, stream.threadId, frame);
        }
        stream.snapshot = applyConversationFrames(stream.snapshot, conversation.frames);
        stream.revision += 1;
        this.#queueSessionStreamSync(subscriptionId, stream);
      }
    }
    const event = adaptNotification(notification);
    if (event === null) return null;
    if (event.type === "token.usage.updated") {
      const sequence = (this.#tokenSequences.get(event.threadId) ?? 0) + 1;
      this.#tokenSequences.set(event.threadId, sequence);
      this.#cloud.send(
        toTokenPayload(event, this.#options.model, this.#agentId, sequence),
        tokenEventId(event),
      );
      return event;
    }
    if (event.type === "turn.completed") {
      if (event.status === "completed" || event.status === "failed" || event.status === "interrupted") {
        this.#cloud.send({ type: "turn.completed", threadId: event.threadId, turnId: event.turnId, status: event.status }, `turn:${event.threadId}:${event.turnId}:${event.status}`);
        if (event.status === "interrupted") this.#interruptTurn(event.threadId, event.turnId);
      }
      return event;
    }
    if (event.type === "turn.failed") {
      if (event.willRetry) return event;
      this.#cloud.send({ type: "turn.completed", threadId: event.threadId, turnId: event.turnId, status: "failed" }, `turn:${event.threadId}:${event.turnId}:failed`);
      return event;
    }
    if (event.type === "server.request.resolved") {
      for (const [requestId, pending] of this.#pending) {
        if (String(pending.source.id) === String(event.rpcRequestId)) {
          clearTimeout(pending.timeout);
          this.#pending.delete(requestId);
          this.#pendingByRpc.delete(rpcKey(pending.source));
          this.#cloud.send({ type: "request.resolved", requestId, status: "cancelled", reason: "resolved_externally" }, `external:${requestId}`);
          pending.reject(new Error("Codex request was resolved by another local client"));
        }
      }
    }
    return event;
  }

  #sendSessionStreamFrame(subscriptionId: string, threadId: string, frame: SessionStreamFrame): void {
    this.#cloud.sendEphemeral({
      type: "session.stream.frame",
      subscriptionId,
      threadId,
      frame,
    });
  }

  async #syncSessionStream(subscriptionId: string, stream: ActiveSessionStream, initial = false): Promise<void> {
    if (stream.syncInFlight !== undefined) {
      stream.syncQueued = true;
      await stream.syncInFlight;
      return;
    }
    const revisionAtStart = stream.revision;
    const sync = (async () => {
      try {
        const result = await this.#codex.request("thread/read", {
          threadId: stream.threadId,
          includeTurns: true,
        });
        if (this.#sessionStreams.get(subscriptionId) !== stream) return;
        const next = conversationSnapshot(result);
        if (next.threadId !== stream.threadId) throw new Error("Codex thread/read returned another thread");
        if (!initial && stream.revision !== revisionAtStart) {
          stream.syncQueued = true;
          return;
        }
        const frames = initial || stream.snapshot === undefined
          ? conversationSnapshotFrames(next)
          : conversationPatchFrames(stream.snapshot, next);
        for (const frame of frames) this.#sendSessionStreamFrame(subscriptionId, stream.threadId, frame);
        stream.snapshot = next;
        stream.loading = false;
        if (initial) this.#startSessionStreamPolling(subscriptionId, stream);
      } catch {
        if (this.#sessionStreams.get(subscriptionId) !== stream) return;
        if (initial || stream.snapshot === undefined) {
          stream.loading = false;
          this.#cloud.sendEphemeral({
            type: "session.stream.error",
            subscriptionId,
            threadId: stream.threadId,
            code: "thread_unavailable",
          });
        }
      } finally {
        if (this.#sessionStreams.get(subscriptionId) !== stream) return;
        delete stream.syncInFlight;
        if (stream.syncQueued) {
          stream.syncQueued = false;
          queueMicrotask(() => void this.#syncSessionStream(subscriptionId, stream));
        }
      }
    })();
    stream.syncInFlight = sync;
    await sync;
  }

  #startSessionStreamPolling(subscriptionId: string, stream: ActiveSessionStream): void {
    if (stream.pollTimer !== undefined) return;
    const pollMs = this.#options.sessionStreamPollMs ?? 500;
    if (pollMs <= 0) return;
    stream.pollTimer = setInterval(() => {
      void this.#syncSessionStream(subscriptionId, stream);
    }, pollMs);
    stream.pollTimer.unref();
  }

  #queueSessionStreamSync(subscriptionId: string, stream: ActiveSessionStream): void {
    if (stream.notificationTimer !== undefined) return;
    stream.notificationTimer = setTimeout(() => {
      delete stream.notificationTimer;
      void this.#syncSessionStream(subscriptionId, stream);
    }, 80);
    stream.notificationTimer.unref();
  }

  #removeSessionStream(subscriptionId: string, stream: ActiveSessionStream): void {
    if (this.#sessionStreams.get(subscriptionId) === stream) this.#sessionStreams.delete(subscriptionId);
    if (stream.pollTimer !== undefined) clearInterval(stream.pollTimer);
    if (stream.notificationTimer !== undefined) clearTimeout(stream.notificationTimer);
  }

  async #refreshSessions(): Promise<void> {
    if (this.#sessionRefreshInFlight !== undefined) return this.#sessionRefreshInFlight;
    const refresh = (async () => {
      const snapshot = await discoverCodexSessionSnapshot(this.#codex, this.#options);
      const currentThreadIds = new Set(snapshot.sessions.map((session) => session.threadId));
      for (const threadId of this.#discoveredSessions.keys()) {
        if (!currentThreadIds.has(threadId)) this.#discoveredSessions.delete(threadId);
      }
      for (const session of snapshot.sessions) this.#sendDiscoveredSession(session);
      this.#cloud.send({
        type: "session.inventory",
        inventoryId: randomUUID(),
        threadIds: [...currentThreadIds],
        agent: this.#agentId,
        sessionIds: [...currentThreadIds],
      }, `session-inventory:${randomUUID()}`);
      this.#sessionTitles.clear();
      for (const title of snapshot.titles) this.#sessionTitles.set(title.threadId, title.title);
      this.#sendSessionTitles();
    })();
    this.#sessionRefreshInFlight = refresh;
    try {
      await refresh;
    } finally {
      if (this.#sessionRefreshInFlight === refresh) this.#sessionRefreshInFlight = undefined;
    }
  }

  #sendDiscoveredSession(session: SessionUpsertPayload): void {
    const signature = createHash("sha256").update(JSON.stringify(session)).digest("hex");
    this.#discoveredSessions.set(session.threadId, session);
    if (this.#sessionSignatures.get(session.threadId) === signature) return;
    this.#cloud.send(session, `session-discovered:${session.threadId}:${signature}`);
    this.#sessionSignatures.set(session.threadId, signature);
  }

  #rememberSessionTitle(title: ConnectorSessionTitle): void {
    this.#sessionTitles.delete(title.threadId);
    this.#sessionTitles.set(title.threadId, title.title);
    while (this.#sessionTitles.size > 200) {
      const oldest = this.#sessionTitles.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#sessionTitles.delete(oldest);
    }
  }

  #sendSessionTitles(): void {
    this.#cloud.sendEphemeral({
      type: "session.titles.snapshot",
      titles: [...this.#sessionTitles].map(([threadId, title]) => ({ threadId, title })),
    });
  }

  #sendSession(domain: DomainRequest): void {
    const discovered = this.#discoveredSessions.get(domain.threadId);
    const contextPath = domain.type === "approval.requested" ? domain.context.cwd : undefined;
    const fallbackPath = contextPath !== undefined && isAbsolute(contextPath)
      ? normalize(contextPath)
      : normalize(this.#options.projectPath);
    const payload: SessionUpsertPayload = {
      type: "session.upsert",
      threadId: domain.threadId,
      agent: this.#agentId,
      sessionId: domain.threadId,
      turnId: domain.turnId,
      projectKey: discovered?.projectKey ?? projectKey(fallbackPath),
      projectName: discovered?.projectName ?? projectNameFromPath(fallbackPath, this.#options.projectName),
      projectPath: discovered?.projectPath ?? projectPathHint(fallbackPath),
      model: discovered?.model ?? this.#options.model,
      status: "waiting",
      syncState: "live",
      updatedAt: new Date().toISOString(),
    };
    if (this.#options.initiatedByEmail !== undefined) payload.initiatedByEmail = this.#options.initiatedByEmail;
    this.#cloud.send(payload, `session:${domain.threadId}`);
  }

  #interruptTurn(threadId: string, turnId: string): void {
    for (const [requestId, pending] of this.#pending) {
      if (pending.adapted.domain.threadId !== threadId || pending.adapted.domain.turnId !== turnId) continue;
      clearTimeout(pending.timeout);
      this.#pending.delete(requestId);
      this.#pendingByRpc.delete(rpcKey(pending.source));
      this.#cloud.send({ type: "request.resolved", requestId, status: "interrupted", reason: "listener_restart" }, `interrupted:${requestId}`);
      pending.reject(new Error("Codex turn was interrupted; old approval was cancelled"));
    }
  }

  #createRemoteTurnClient(threadId: string): RemoteTurnClient {
    const client = this.#options.createTurnClient?.((request) => this.markCodexResponseWritten(request))
      ?? new CodexAppServerClient({
        command: this.#options.codexCommand ?? "codex",
        cwd: this.#options.projectPath,
        onServerResponseWritten: (request) => this.markCodexResponseWritten(request),
      });
    const turnClient: RemoteTurnClient = {
      client,
      threadId,
      turnId: null,
      turnStartAttempted: false,
      ambiguous: false,
      terminalTurnIds: new Set(),
      removeNotificationHandler: () => undefined,
      queueReleased: false,
    };
    client.setServerRequestHandler((request) => this.#handleCodexRequest(request));
    turnClient.removeNotificationHandler = client.onNotification(async (notification) => {
      const event = await this.#handleCodexNotification(notification);
      if (!isTerminalTurnEvent(event) || event.threadId !== turnClient.threadId) return;
      turnClient.terminalTurnIds.add(event.turnId);
      if (turnClient.turnId === event.turnId || turnClient.ambiguous) {
        this.#scheduleTurnClientStop(turnClient);
      }
    });
    return turnClient;
  }

  #scheduleTurnClientStop(turnClient: RemoteTurnClient): void {
    if (turnClient.releaseTimer !== undefined || turnClient.stopping !== undefined) return;
    const delayMs = this.#options.turnClientReleaseDelayMs ?? 100;
    turnClient.releaseTimer = setTimeout(() => {
      delete turnClient.releaseTimer;
      void this.#stopTurnClient(turnClient);
    }, delayMs);
    turnClient.releaseTimer.unref();
  }

  #armUnknownTurnTimeout(turnClient: RemoteTurnClient): void {
    if (turnClient.unknownTimer !== undefined) return;
    const timeoutMs = this.#options.turnClientUnknownTimeoutMs ?? 24 * 60 * 60_000;
    turnClient.unknownTimer = setTimeout(() => {
      delete turnClient.unknownTimer;
      process.stderr.write(`Releasing ambiguous Codex turn writer after timeout for ${turnClient.threadId}\n`);
      void this.#stopTurnClient(turnClient);
    }, timeoutMs);
    turnClient.unknownTimer.unref();
  }

  async #stopTurnClient(turnClient: RemoteTurnClient): Promise<void> {
    if (turnClient.stopping !== undefined) return turnClient.stopping;
    if (turnClient.releaseTimer !== undefined) clearTimeout(turnClient.releaseTimer);
    if (turnClient.unknownTimer !== undefined) clearTimeout(turnClient.unknownTimer);
    delete turnClient.releaseTimer;
    delete turnClient.unknownTimer;
    turnClient.removeNotificationHandler();
    this.#turnClients.delete(turnClient);
    const stopping = (async () => {
      try {
        await turnClient.client.stop();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Unable to stop Codex remote turn client for ${turnClient.threadId}: ${detail}\n`);
      } finally {
        this.#releaseTurnClientQueue(turnClient);
      }
    })();
    turnClient.stopping = stopping;
    await stopping;
  }

  #releaseTurnClientQueue(turnClient: RemoteTurnClient): void {
    if (turnClient.queueReleased) return;
    turnClient.queueReleased = true;
    const queue = turnClient.queue;
    if (queue === undefined || queue.active !== turnClient) return;
    delete queue.active;
    if (!this.#stopping && !queue.blocked) this.#pumpThreadCommandQueue(queue);
  }
}

export async function discoverCodexSessions(
  codex: Pick<CodexAppServerClient, "request">,
  options: Pick<ConnectorRuntimeOptions, "model" | "initiatedByEmail" | "agentId">,
): Promise<SessionUpsertPayload[]> {
  return (await discoverCodexSessionSnapshot(codex, options)).sessions;
}

export async function discoverCodexSessionSnapshot(
  codex: Pick<CodexAppServerClient, "request">,
  options: Pick<ConnectorRuntimeOptions, "model" | "initiatedByEmail" | "agentId">,
): Promise<DiscoveredCodexSessionSnapshot> {
  const sessions = new Map<string, SessionUpsertPayload>();
  const titles = new Map<string, string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const params: Record<string, unknown> = {
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
    };
    if (cursor !== undefined) params.cursor = cursor;
    const page = await codex.request("thread/list", params);
    for (const session of await sessionPayloadsFromThreadList(page, options)) {
      sessions.set(session.threadId, session);
    }
    for (const title of sessionTitlesFromThreadList(page)) {
      if (titles.has(title.threadId) || titles.size < 200) titles.set(title.threadId, title.title);
    }
    const nextCursor = threadListNextCursor(page);
    if (nextCursor === null) return { sessions: [...sessions.values()], titles: [...titles].map(([threadId, title]) => ({ threadId, title })) };
    if (seenCursors.has(nextCursor)) {
      throw new Error("Codex thread/list returned a repeated pagination cursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export function sessionTitlesFromThreadList(value: unknown): ConnectorSessionTitle[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error("Codex thread/list returned an invalid response");
  }
  const titles: ConnectorSessionTitle[] = [];
  for (const candidate of value.data) {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.length < 1 || candidate.id.length > 500) continue;
    const title = sanitizeSessionTitle(candidate.name);
    if (title !== null) titles.push({ threadId: candidate.id, title });
  }
  return titles;
}

export function sanitizeSessionTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const withoutBidi = value.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/giu, "");
  const withoutControls = withoutBidi.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  const collapsed = withoutControls.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return null;
  return Array.from(collapsed).slice(0, 120).join("");
}

export async function sessionPayloadsFromThreadList(
  value: unknown,
  options: Pick<ConnectorRuntimeOptions, "model" | "initiatedByEmail" | "agentId">,
  canonicalize: (path: string) => Promise<string> = canonicalProjectPath,
): Promise<SessionUpsertPayload[]> {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error("Codex thread/list returned an invalid response");
  }
  const results = await Promise.all(value.data.map(async (candidate): Promise<SessionUpsertPayload | null> => {
    if (!isRecord(candidate) || typeof candidate.id !== "string") return null;
    const mapped = sessionStatus(candidate.status);
    // Keep every thread returned by Codex. Older/newer app-server builds may
    // omit cwd or introduce a status we do not understand; dropping those
    // records makes the Web list disagree with the Codex client.
    const rawPath = typeof candidate.cwd === "string" && isAbsolute(candidate.cwd) ? candidate.cwd : null;
    const canonicalPath = rawPath === null ? null : normalize(await canonicalize(rawPath));
    const projectIdentity = canonicalPath ?? `unclassified:${candidate.id}`;
    const payload: SessionUpsertPayload = {
      type: "session.upsert",
      threadId: candidate.id,
      agent: options.agentId ?? "codex",
      sessionId: candidate.id,
      projectKey: projectKey(projectIdentity),
      projectName: canonicalPath === null ? "未归类会话" : projectNameFromPath(canonicalPath),
      projectPath: canonicalPath === null ? "Codex 未提供项目路径" : projectPathHint(canonicalPath),
      model: options.model,
      status: mapped?.status ?? "completed",
      syncState: mapped?.syncState ?? "historical",
    };
    if (options.initiatedByEmail !== undefined) payload.initiatedByEmail = options.initiatedByEmail;
    const startedAt = unixTimestamp(candidate.createdAt);
    const updatedAt = unixTimestamp(candidate.updatedAt);
    if (startedAt !== undefined) payload.startedAt = startedAt;
    if (updatedAt !== undefined) payload.updatedAt = updatedAt;
    return payload;
  }));
  return results.filter((payload): payload is SessionUpsertPayload => payload !== null);
}

function sessionStatus(value: unknown): { status: "running" | "waiting" | "completed" | "failed"; syncState: "live" | "historical" } | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "systemError") return { status: "failed", syncState: "live" };
  if (value.type === "notLoaded") return { status: "completed", syncState: "historical" };
  if (value.type === "idle") return { status: "completed", syncState: "historical" };
  if (value.type !== "active") return null;
  return Array.isArray(value.activeFlags) && value.activeFlags.length > 0
    ? { status: "waiting", syncState: "live" }
    : { status: "running", syncState: "live" };
}

function projectPathHint(path: string): string {
  const relativeToHome = relative(homedir(), path);
  if (relativeToHome.length === 0) return "~";
  if (!relativeToHome.startsWith("..") && relativeToHome !== path) return `~/${relativeToHome}`;
  return basename(path);
}

function projectNameFromPath(path: string, fallback = "Codex workspace"): string {
  const name = basename(path);
  return name.length > 0 ? name : fallback;
}

function projectKey(path: string): string {
  return createHash("sha256").update(normalize(path)).digest("hex");
}

async function canonicalProjectPath(path: string): Promise<string> {
  const normalized = normalize(path);
  try {
    return await realpath(normalized);
  } catch {
    return normalized;
  }
}

function unixTimestamp(value: unknown): string | undefined {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return undefined;
  const date = new Date(Number(value) * 1_000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function threadListNextCursor(value: unknown): string | null {
  if (!isRecord(value)) throw new Error("Codex thread/list returned an invalid response");
  if (value.nextCursor === undefined || value.nextCursor === null) return null;
  if (typeof value.nextCursor !== "string" || value.nextCursor.length === 0) {
    throw new Error("Codex thread/list returned an invalid next cursor");
  }
  return value.nextCursor;
}

function extractCodexModels(listing: { data?: unknown; models?: unknown } | null | undefined): AgentModelOption[] {
  const items = Array.isArray(listing?.data)
    ? listing.data
    : Array.isArray(listing?.models)
      ? listing.models
      : [];
  const models: AgentModelOption[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id
      : typeof item.model === "string" ? item.model
        : typeof item.slug === "string" ? item.slug : null;
    if (id === null || id.length === 0) continue;
    const displayName = typeof item.displayName === "string" && item.displayName.length > 0 ? item.displayName : id;
    models.push({ id, displayName, reasoningEfforts: ["minimal", "low", "medium", "high"] });
  }
  return models;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRequestPayload(domain: DomainRequest, agentId: string): ConnectorPayload {
  if (domain.type === "approval.requested") {
    return {
      type: "request.created",
      requestId: domain.requestId,
      threadId: domain.threadId,
      agent: agentId,
      sessionId: domain.threadId,
      turnId: domain.turnId,
      itemId: domain.itemId,
      kind: "approval",
      category: domain.category,
      tool: domain.category === "command" ? "shell" : domain.category,
      risk: classifyRisk(domain.context.command, domain.category),
      context: domain.context,
      requestedAt: domain.startedAt,
      expiresAt: new Date(Date.parse(domain.startedAt) + 15 * 60_000).toISOString(),
    };
  }
  return {
    type: "request.created",
    requestId: domain.requestId,
    threadId: domain.threadId,
    agent: agentId,
    sessionId: domain.threadId,
    turnId: domain.turnId,
    itemId: domain.itemId,
    kind: "question",
    category: "userInput",
    tool: "request_user_input",
    risk: "low",
    context: { questions: domain.questions },
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

function toTokenPayload(
  event: TokenUsageUpdatedEvent,
  model: string,
  agentId: string,
  sequence: number,
): ConnectorPayload {
  return {
    type: "token.snapshot",
    eventId: tokenEventId(event),
    sequence,
    threadId: event.threadId,
    agent: agentId,
    sessionId: event.threadId,
    turnId: event.turnId,
    provider: "openai",
    model,
    inputTokens: event.usage.total.inputTokens,
    cachedInputTokens: event.usage.total.cachedInputTokens,
    outputTokens: event.usage.total.outputTokens,
    reasoningTokens: event.usage.total.reasoningOutputTokens,
    totalTokens: event.usage.total.totalTokens,
    quality: "provisional",
    observedAt: new Date().toISOString(),
  };
}

function tokenEventId(event: TokenUsageUpdatedEvent): string {
  return createHash("sha256")
    .update(event.threadId).update("\0").update(event.turnId).update("\0")
    .update(JSON.stringify(event.usage.total)).digest("hex");
}

function classifyRisk(command: string | undefined, category: string): "low" | "medium" | "high" {
  if (category === "permissions") return "high";
  if (command === undefined) return "medium";
  return /(?:\brm\b|--force|\bpush\b|\bsudo\b|\bcurl\b|\bssh\b|\bdeploy\b)/i.test(command)
    ? "high"
    : /(?:\bnpm\b|\bgit\b|\bmake\b|\bdocker\b)/i.test(command)
      ? "medium"
      : "low";
}

function readApprovalDecision(input: DecisionInput): ApprovalDecision {
  if (input.decision === "approve") return "approve";
  if (input.decision === "deny") return "deny";
  throw new Error("Approval request cannot be answered as a question");
}

function rpcKey(request: CodexServerRequest): string {
  return `${typeof request.id}:${String(request.id)}`;
}

function isTerminalTurnEvent(event: DomainEvent | null): event is Extract<DomainEvent, { type: "turn.completed" | "turn.failed" }> {
  if (event === null) return false;
  if (event.type === "turn.failed") return !event.willRetry;
  return event.type === "turn.completed" &&
    (event.status === "completed" || event.status === "failed" || event.status === "interrupted");
}

function readTurnId(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("turn" in value) ||
    typeof value.turn !== "object" ||
    value.turn === null ||
    !("id" in value.turn) ||
    typeof value.turn.id !== "string" ||
    value.turn.id.length === 0
  ) {
    throw new Error("Codex turn/start returned no turn id");
  }
  return value.turn.id;
}

export async function dispatchSessionCommand(
  codex: Pick<CodexAppServerClient, "request">,
  journal: SqliteCommandJournal,
  remote: RemoteSessionCommand,
  media?: SqliteLocalImageStore,
  hooks?: {
    onTurnStartAttempted?(): void;
    onTurnStarted?(turnId: string): void;
  },
  sessionOptions?: AgentSessionOptions,
): Promise<CommandDeliveryRecord> {
  const attachments = remote.attachments ?? [];
  const payloadHash = sessionCommandPayloadHash(remote);
  const prepared = journal.prepare(remote.commandId, remote.threadId, payloadHash);
  if (prepared.state !== "prepared") return prepared;

  const validateAttachments = (): Array<{ type: "localImage"; path: string }> => {
    if (attachments.length === 0) return [];
    if (media === undefined) throw new ImageMediaError("attachment_unavailable", "Image storage is unavailable");
    if (attachments.length > 4) throw new ImageMediaError("too_many_images", "Too many images were attached");
    const total = attachments.reduce((sum, attachment) => sum + attachment.byteLength, 0);
    if (!Number.isSafeInteger(total) || total > 12 * 1024 * 1024) {
      throw new ImageMediaError("images_too_large", "Attached images exceed the total byte limit");
    }
    const resolved = attachments.map((attachment) => {
      const local = media.resolveAttachment(attachment as ImageAttachmentReference, remote.threadId);
      return { type: "localImage" as const, path: local.path };
    });
    return resolved;
  };

  try {
    validateAttachments();
  } catch (error) {
    return journal.markFailed(remote.commandId, commandImageErrorCode(error));
  }

  try {
    await codex.request("thread/resume", {
      threadId: remote.threadId,
      excludeTurns: true,
    });
  } catch {
    return journal.markFailed(remote.commandId, "thread_resume_failed");
  }

  let imageInput: Array<{ type: "localImage"; path: string }>;
  try {
    imageInput = validateAttachments();
  } catch (error) {
    return journal.markFailed(remote.commandId, commandImageErrorCode(error));
  }

  const input: Array<{ type: "text"; text: string } | { type: "localImage"; path: string }> = [];
  if (remote.text.length > 0) input.push({ type: "text", text: remote.text });
  input.push(...imageInput);

  journal.beginDispatch(remote.commandId);
  hooks?.onTurnStartAttempted?.();
  try {
    const result = await codex.request("turn/start", {
      threadId: remote.threadId,
      input,
      ...(sessionOptions?.model === undefined ? {} : { model: sessionOptions.model }),
      ...(sessionOptions?.reasoningEffort === undefined ? {} : { model_reasoning_effort: sessionOptions.reasoningEffort }),
    });
    const turnId = readTurnId(result);
    hooks?.onTurnStarted?.(turnId);
    return journal.markDelivered(remote.commandId, turnId);
  } catch {
    const current = journal.get(remote.commandId);
    if (current === undefined) throw new Error("Session command journal disappeared during dispatch");
    return current;
  }
}

function sessionCommandPayloadHash(remote: RemoteSessionCommand, options?: AgentSessionOptions): string {
  return createHash("sha256").update(JSON.stringify({
    threadId: remote.threadId,
    text: remote.text,
    attachments: remote.attachments ?? [],
    model: options?.model ?? null,
    reasoningEffort: options?.reasoningEffort ?? null,
  })).digest("hex");
}

function commandImageErrorCode(error: unknown): string {
  return error instanceof ImageMediaError ? error.code : "attachment_unavailable";
}

function attachmentStatusErrorCode(
  error: unknown,
  controlType: RemoteAttachmentControl["type"],
): NonNullable<ConnectorAttachmentStatus["code"]> {
  if (!(error instanceof ImageMediaError)) return "connector_write_failed";
  if (error.code === "unsupported_image_type") return "invalid_image_type";
  if (error.code === "image_too_large") return "image_too_large";
  if (error.code === "invalid_upload_offset") return "chunk_out_of_order";
  if (error.code === "upload_incomplete") return "image_incomplete";
  if (error.code === "hash_mismatch") return "image_hash_mismatch";
  if (error.code === "upload_not_found") return "upload_expired";
  if (error.code === "storage_failed" || error.code === "upload_state_invalid") return "connector_write_failed";
  if (error.code === "invalid_image") {
    return controlType === "session.attachment.chunk" ? "invalid_chunk" : "invalid_image_type";
  }
  return "invalid_upload";
}
