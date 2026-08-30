import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { basename } from "node:path";

import type {
  ConnectorPayload,
  ConnectorSessionTitle,
  SessionStreamFrame,
  SessionSummary,
} from "@yurupager/shared";

import type {
  AgentCapabilities,
  AgentDiscoveredSessionSnapshot,
  AgentEventSink,
  AgentSessionOptions,
  AgentStartSessionOptions,
} from "../types.js";
import { assertSessionOptionsSupported } from "../session-options.js";
import { AgentSessionStore } from "../agent-session-store.js";
import type {
  RemoteDecision,
  RemoteSessionCommand,
  RemoteSessionStreamControl,
} from "../../transport/connector-cloud-client.js";

export interface ZcodeAgentRuntimeOptions {
  agentId?: string;
  command?: string;
  /** Extra CLI arguments placed before the version probe and app-server. */
  args?: string[];
  cwd?: string;
  projectName: string;
  projectPath: string;
  sessionStorePath?: string;
  requestTimeoutMs?: number;
  /** Supervision permission mode; yolo and plan are never allowed (ADR-030). */
  mode?: "build" | "edit";
  pollMs?: number;
}

interface PendingPermission {
  requestId: string;
  rpcId: unknown;
  threadId: string;
  turnId: string;
  resolve(decision: "allow" | "deny"): void;
  settled: boolean;
}

const SUPPORTED_VERSION = /^zcode 0\.16\./;
const SUPERVISED_MODES = new Set(["build", "edit"]);
const DELTA_BYTES = 16 * 1024 - 1;

export function parseZcodeVersion(output: string): { supported: boolean; version: string | null } {
  const line = output.split("\n")[0]?.trim() ?? "";
  const match = /^zcode (\d+\.\d+\.\d+)/.exec(line);
  if (match === null) return { supported: false, version: null };
  return { supported: SUPPORTED_VERSION.test(line), version: match[1] ?? null };
}

/**
 * Native adapter for the ZCode Protocol app-server (ADR-030). The wire
 * dialect is ndjson `{id, method, params}` without a jsonrpc key. Discovery
 * is global via session/list; conversations are presented by polling
 * session/messages and diffing (turn-level event shapes are unverified and
 * unknown notifications are ignored, fail-closed). Approvals normalise
 * interaction/requestPermission into the shared flow with
 * `{decision: "allow"|"deny"}` results; supervision always launches in
 * build/edit mode — never yolo.
 */
export class ZcodeAgentRuntime {
  readonly agentId: string;
  readonly #options: ZcodeAgentRuntimeOptions;
  readonly #displayName: string;
  #sink: AgentEventSink | undefined;
  #connection: import("../acp/json-rpc-connection.js").NdjsonJsonRpcConnection | undefined;
  #store: AgentSessionStore | undefined;
  readonly #sessions = new Map<string, { sessionId: string; status: string }>();
  readonly #subscriptions = new Map<string, string>();
  readonly #activeTurns = new Map<string, { turnId: string; messageId: string | null; started: boolean }>();
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  readonly #messageSequences = new Map<string, number>();
  readonly #usageSequences = new Map<string, number>();
  readonly #seenTextLengths = new Map<string, number>();
  #pollTimer: NodeJS.Timeout | undefined;
  #versionChecked = false;
  #running = false;

  constructor(options: ZcodeAgentRuntimeOptions) {
    this.#options = options;
    this.agentId = options.agentId ?? "zcode";
    this.#displayName = `ZCode (${basename(options.command ?? "zcode")})`;
  }

  attach(sink: AgentEventSink): void {
    this.#sink = sink;
  }

  async capabilities(): Promise<AgentCapabilities> {
    if (!this.#versionChecked) {
      const output = await this.#runVersionProbe();
      const parsed = parseZcodeVersion(output);
      if (!parsed.supported) {
        throw new Error(
          parsed.version === null
            ? `ZCode version probe returned an unparseable version`
            : `ZCode version ${parsed.version} is outside the supervised 0.16.x window`,
        );
      }
      this.#versionChecked = true;
    }
    return {
      agentId: this.agentId,
      displayName: this.#displayName,
      discovery: "global",
      questions: false,
      usageReporting: true,
      imageAttachments: false,
      // session/setModel exists but the app-server exposes no selectable
      // catalogue over the wire; requested options fail closed (ADR-034).
      models: [],
    };
  }

  async startSession(options: AgentStartSessionOptions): Promise<{ sessionId: string }> {
    assertSessionOptionsSupported(this.agentId, options, []);
    const connection = this.#requireConnection();
    const created = await connection.request("session/create", {
      workspace: { workspaceKey: this.#options.projectPath, workspacePath: this.#options.projectPath },
    }) as { sessionId?: unknown } | null;
    const sessionId = created?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error(`ZCode session/create returned no session id for ${this.agentId}`);
    }
    const mode = this.#options.mode ?? "build";
    if (!SUPERVISED_MODES.has(mode)) throw new Error(`Supervision mode ${mode} is not allowed`);
    await connection.request("session/setMode", { sessionId, mode });
    this.#activeSessions.add(sessionId);
    this.#store?.bind(sessionId, sessionId);
    this.#publishSession(sessionId, "running");
    // Fire-and-forget: turn completion arrives via state.updated.
    void connection.request("session/send", { sessionId, content: options.initialPrompt })
      .then(() => this.#refreshUsage(sessionId, "turn-start"))
      .catch(() => undefined);
    return { sessionId };
  }

  async #runVersionProbe(): Promise<string> {
    const command = this.#options.command ?? "zcode";
    const args = [...(this.#options.args ?? []), "--version"];
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
        stdio: ["ignore", "pipe", "ignore"],
      });
      let output = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`ZCode version probe timed out for ${this.agentId}`));
      }, 15_000);
      child.stdout?.on("data", (chunk) => { output += String(chunk); });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(output);
      });
    });
  }

  async start(): Promise<void> {
    if (this.#running) return;
    if (this.#options.sessionStorePath !== undefined) {
      this.#store = new AgentSessionStore(this.#options.sessionStorePath);
    }
    const { NdjsonJsonRpcConnection } = await import("../acp/json-rpc-connection.js");
    const connection = new NdjsonJsonRpcConnection({
      command: this.#options.command ?? "zcode",
      args: [...(this.#options.args ?? []), "app-server"],
      ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
      ...(this.#options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.#options.requestTimeoutMs }),
      envelope: "bare",
      onNotification: (method, params) => this.#handleNotification(method, params),
      onRequest: (method, params) => this.#handleServerRequest(method, params),
      onExit: () => this.#handleExit(),
    });
    connection.start();
    this.#connection = connection;
    const listing = await connection.request("session/list", {}) as { sessions?: unknown } | null;
    if (listing === null || !Array.isArray(listing.sessions)) {
      await connection.stop();
      this.#connection = undefined;
      throw new Error(`ZCode capability probe failed for ${this.agentId}: session/list unavailable`);
    }
    this.#running = true;
    await this.listSessions();
    this.#startPolling();
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#pollTimer !== undefined) clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
    for (const pending of this.#pendingPermissions.values()) {
      this.#settlePermission(pending, "deny");
    }
    await this.#connection?.stop();
    this.#connection = undefined;
    this.#store?.close();
    this.#store = undefined;
  }

  async listSessions(): Promise<AgentDiscoveredSessionSnapshot | null> {
    const listing = await this.#requireConnection().request("session/list", {}) as {
      sessions?: Array<Record<string, unknown>>;
    } | null;
    if (listing === null || !Array.isArray(listing.sessions)) return null;
    const sessions: SessionUpsertPayloadLike[] = [];
    const titles: ConnectorSessionTitle[] = [];
    for (const entry of listing.sessions) {
      const sessionId = entry.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) continue;
      const mapped = mapSessionStatus(entry.status);
      if (mapped === null) continue; // unknown statuses are skipped, never guessed
      this.#sessions.set(sessionId, { sessionId, status: String(entry.status ?? "unknown") });
      sessions.push({
        type: "session.upsert",
        threadId: sessionId,
        agent: this.agentId,
        sessionId,
        projectKey: createProjectKey(this.#options.projectPath),
        projectName: this.#options.projectName,
        projectPath: this.#options.projectPath,
        model: "zcode",
        status: mapped.status,
        syncState: mapped.syncState,
        updatedAt: new Date().toISOString(),
      });
      const title = sanitizeDisplayLabel(entry.title);
      if (title !== null) titles.push({ threadId: sessionId, title });
    }
    this.#store?.bind(this.agentId, `${sessions.length}`);
    return { sessions, titles };
  }

  async handleDecision(remote: RemoteDecision): Promise<void> {
    const pending = this.#pendingPermissions.get(remote.requestId);
    if (pending === undefined) return;
    const decision: "allow" | "deny" =
      remote.decision.decision === "approve" && remote.decision.highRiskConfirmed !== false
        ? "allow"
        : "deny";
    this.#settlePermission(pending, decision);
    this.#connection?.respond(pending.rpcId, { decision });
  }

  async handleSessionCommand(remote: RemoteSessionCommand, sessionOptions?: AgentSessionOptions): Promise<void> {
    assertSessionOptionsSupported(this.agentId, sessionOptions, []);
    const connection = this.#requireConnection();
    const sessionId = remote.threadId;
    await this.#ensureActive(sessionId);
    // Fail-closed supervision mode: re-assert build/edit after every resume.
    const mode = this.#options.mode ?? "build";
    if (!SUPERVISED_MODES.has(mode)) throw new Error(`Supervision mode ${mode} is not allowed`);
    await connection.request("session/setMode", { sessionId, mode });
    const turnId = `turn-${remote.commandId.slice(0, 8)}`;
    this.#activeTurns.set(sessionId, { turnId, messageId: null, started: false });
    this.#messageSequences.set(turnId, 0);
    await connection.request("session/send", { sessionId, content: remote.text });
    await this.#refreshUsage(sessionId, turnId);
  }

  async handleSessionStream(control: RemoteSessionStreamControl): Promise<void> {
    if (control.type === "session.stream.unsubscribe") {
      this.#subscriptions.delete(control.subscriptionId);
      return;
    }
    this.#subscriptions.set(control.subscriptionId, control.threadId);
    this.#sendFrame(control.threadId, { kind: "history.start" });
    await this.#ensureActive(control.threadId);
    this.#sendFrame(control.threadId, { kind: "history.complete" });
  }

  async cancelSession(threadId: string): Promise<void> {
    if (!this.#subscriptions.has(threadId) && this.#activeTurns.get(threadId) === undefined) return;
    await this.#requireConnection().request("session/stop", { sessionId: threadId });
  }

  handleCloudOnline(): void {
    void this.listSessions().then((snapshot) => {
      if (snapshot === null) return;
      for (const session of snapshot.sessions) {
        this.#sink?.send(session, `session:${session.threadId}:refresh`);
      }
    }).catch(() => undefined);
  }

  async #ensureActive(sessionId: string): Promise<void> {
    if (this.#activeSessions.has(sessionId)) return;
    const resumed = await this.#requireConnection().request("session/resume", { sessionId }) as {
      messages?: unknown;
    } | null;
    this.#activeSessions.add(sessionId);
    if (resumed?.messages !== undefined) {
      this.#ingestTranscript(sessionId, resumed.messages, { emit: false });
    }
    this.#store?.bind(sessionId, sessionId);
  }

  readonly #activeSessions = new Set<string>();

  #requireConnection(): import("../acp/json-rpc-connection.js").NdjsonJsonRpcConnection {
    const connection = this.#connection;
    if (connection === undefined || !this.#running) {
      throw new Error(`ZCode runtime ${this.agentId} is not running`);
    }
    return connection;
  }

  #startPolling(): void {
    if (this.#pollTimer !== undefined) return;
    const pollMs = this.#options.pollMs ?? 500;
    if (pollMs <= 0) return;
    this.#pollTimer = setInterval(() => {
      void this.#pollOnce().catch(() => undefined);
    }, pollMs);
    this.#pollTimer.unref();
  }

  async #pollOnce(): Promise<void> {
    for (const threadId of new Set(this.#subscriptions.values())) {
      if (!this.#activeSessions.has(threadId)) continue;
      const messages = await this.#requireConnection().request("session/messages", { sessionId: threadId }) as {
        messages?: unknown;
      } | null;
      if (messages?.messages !== undefined) {
        this.#ingestTranscript(threadId, messages.messages, { emit: true });
      }
    }
  }

  #ingestTranscript(threadId: string, value: unknown, options: { emit: boolean }): void {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const info = (record.info ?? {}) as Record<string, unknown>;
      const messageId = typeof info.messageId === "string" ? info.messageId
        : typeof record.messageId === "string" ? record.messageId : null;
      if (messageId === null) continue;
      // Fail-closed extraction: only plain text fields are forwarded. Tool
      // telemetry entries (rawInput/rawOutput, no text) drop entirely.
      const text = extractText(record) ?? extractText(info);
      if (text === null) continue;
      const role: "user" | "assistant" = info.agent === "zcode-agent" ? "assistant" : "user";
      const previous = this.#seenTextLengths.get(messageId) ?? -1;
      if (text.length <= previous) continue;
      const delta = text.slice(previous === -1 ? 0 : previous);
      this.#seenTextLengths.set(messageId, text.length);
      if (!options.emit) continue;
      if (previous === -1 && role === "assistant") {
        const turn = this.#activeTurns.get(threadId);
        if (turn !== undefined && !turn.started) {
          turn.messageId = `msg-${turn.turnId}`;
          turn.started = true;
          this.#sendFrame(threadId, {
            kind: "message.start", messageId: turn.messageId, turnId: turn.turnId, role: "assistant",
          });
        }
      }
      const turn = this.#activeTurns.get(threadId);
      const frameMessageId = role === "assistant" && turn?.messageId !== null && turn !== undefined
        ? turn.messageId
        : `msg-${messageId.slice(0, 8)}`;
      for (const piece of splitUtf8Safe(delta, DELTA_BYTES)) {
        this.#sendFrame(threadId, { kind: "message.delta", messageId: frameMessageId, delta: piece });
      }
    }
  }

  #handleNotification(method: string, params: unknown): void {
    if (method === "state.updated" && typeof params === "object" && params !== null) {
      const record = params as { sessionId?: unknown; status?: unknown };
      const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
      const status = typeof record.status === "string" ? record.status : "";
      const turn = this.#activeTurns.get(sessionId);
      if (turn === undefined) return;
      const mapped: SessionSummary["status"] | null =
        status === "idle" ? "completed" :
        status === "error" ? "failed" :
        status === "interrupted" ? "interrupted" : null;
      if (mapped === null) return; // unknown statuses never become turn states
      if (turn.started) {
        this.#sendFrame(sessionId, { kind: "message.complete", messageId: turn.messageId ?? "" });
      }
      this.#sendFrame(sessionId, { kind: "turn.status", turnId: turn.turnId, status: mapped });
      this.#activeTurns.delete(sessionId);
      void this.#refreshUsage(sessionId, turn.turnId).catch(() => undefined);
    }
    // Every other notification (mcpTelemetry, resourceSample, …) is ignored.
  }

  async #handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "session/requestRuntimePreferences") {
      return { nativeSearchEnhancementsEnabled: false };
    }
    if (method === "interaction/requestOfficialMcpAuthHeaders") {
      throw new Error("MCP auth header flows are not supervised; refused");
    }
    if (method === "interaction/requestPermission") {
      return this.#handlePermissionRequest(params);
    }
    // Fail-closed: unknown server requests (incl. requestUserInput) are refused.
    throw new Error(`Unsupported ZCode server request: ${method}`);
  }

  async #handlePermissionRequest(params: unknown): Promise<unknown> {
    const record = (typeof params === "object" && params !== null ? params : {}) as { sessionId?: unknown };
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : this.#firstActiveSession();
    if (sessionId === null) throw new Error("Permission request without a session");
    const requestId = randomUUID();
    const turn = this.#activeTurns.get(sessionId);
    const turnId = turn?.turnId ?? "turn-unknown";
    const pending: PendingPermission = {
      requestId,
      rpcId: null,
      threadId: sessionId,
      turnId,
      settled: false,
      resolve: () => undefined,
    };
    const parked = new Promise<"allow" | "deny">((resolve) => { pending.resolve = resolve; });
    this.#pendingPermissions.set(requestId, pending);
    const payload: ConnectorPayload = {
      type: "request.created",
      requestId,
      threadId: sessionId,
      agent: this.agentId,
      sessionId,
      turnId,
      itemId: randomUUID(),
      kind: "approval",
      category: "tool",
      tool: "zcode_permission",
      risk: "medium",
      context: { availableDecisions: ["allow", "deny"] },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    this.#sink?.send(payload, `request:${requestId}`);
    const decision = await parked;
    pending.rpcId = -1;
    return { decision };
  }

  #firstActiveSession(): string | null {
    for (const sessionId of this.#activeSessions) return sessionId;
    return null;
  }

  #settlePermission(pending: PendingPermission, decision: "allow" | "deny"): void {
    if (pending.settled) return;
    pending.settled = true;
    this.#pendingPermissions.delete(pending.requestId);
    pending.resolve(decision);
  }

  async #refreshUsage(sessionId: string, turnId: string): Promise<void> {
    const usage = await this.#requireConnection().request("session/usage", { sessionId }) as {
      totalTokens?: unknown;
      inputTokens?: unknown;
      outputTokens?: unknown;
      reasoningTokens?: unknown;
      cacheReadTokens?: unknown;
      cacheCreationTokens?: unknown;
    } | null;
    if (usage === null || typeof usage.totalTokens !== "number") return;
    const safe = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);
    const sequence = (this.#usageSequences.get(sessionId) ?? 0) + 1;
    this.#usageSequences.set(sessionId, sequence);
    const payload: ConnectorPayload = {
      type: "token.snapshot",
      eventId: createHash("sha256").update(sessionId).update("\0").update(String(sequence)).digest("hex"),
      sequence,
      threadId: sessionId,
      agent: this.agentId,
      sessionId,
      turnId,
      provider: "zcode",
      model: "zcode",
      inputTokens: safe(usage.inputTokens),
      cachedInputTokens: safe(usage.cacheReadTokens),
      outputTokens: safe(usage.outputTokens),
      reasoningTokens: safe(usage.reasoningTokens),
      totalTokens: safe(usage.totalTokens),
      quality: "provisional",
      observedAt: new Date().toISOString(),
    };
    this.#sink?.send(payload, `usage:${sessionId}:${sequence}`);
  }

  #publishSession(sessionId: string, status: SessionSummary["status"]): void {
    const payload: SessionUpsertPayloadLike = {
      type: "session.upsert",
      threadId: sessionId,
      agent: this.agentId,
      sessionId,
      projectKey: createProjectKey(this.#options.projectPath),
      projectName: this.#options.projectName,
      projectPath: this.#options.projectPath,
      model: "zcode",
      status,
      syncState: "live",
      updatedAt: new Date().toISOString(),
    };
    this.#sink?.send(payload, `session:${sessionId}:${status}`);
  }

  #sendFrame(threadId: string, frame: SessionStreamFrame): void {
    if (this.#sink === undefined) return;
    for (const [subscriptionId, subscribedThread] of this.#subscriptions) {
      if (subscribedThread !== threadId) continue;
      this.#sink.sendEphemeral({
        type: "session.stream.frame",
        subscriptionId,
        threadId,
        frame,
      });
    }
  }

  #handleExit(): void {
    this.#running = false;
    this.#activeSessions.clear();
    for (const pending of this.#pendingPermissions.values()) {
      this.#settlePermission(pending, "deny");
    }
  }
}

interface SessionUpsertPayloadLike {
  type: "session.upsert";
  threadId: string;
  agent: string;
  sessionId: string;
  projectKey: string;
  projectName: string;
  projectPath: string;
  model: string;
  status: SessionSummary["status"];
  syncState: SessionSummary["syncState"];
  updatedAt: string;
}

function mapSessionStatus(value: unknown): { status: SessionSummary["status"]; syncState: SessionSummary["syncState"] } | null {
  if (typeof value !== "string") return null;
  if (value === "idle") return { status: "completed", syncState: "historical" };
  if (value === "running" || value === "active") return { status: "running", syncState: "live" };
  if (value === "waiting") return { status: "waiting", syncState: "live" };
  if (value === "failed" || value === "error") return { status: "failed", syncState: "historical" };
  return null; // unknown statuses are skipped, never guessed
}

function extractText(record: Record<string, unknown>): string | null {
  const candidates = [record.text, record.content];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

function sanitizeDisplayLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const withoutBidi = value.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/giu, "");
  const withoutControls = withoutBidi.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  const collapsed = withoutControls.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return null;
  return Array.from(collapsed).slice(0, 120).join("");
}

function splitUtf8Safe(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];
  const pieces: string[] = [];
  let current = "";
  for (const char of text) {
    if (Buffer.byteLength(current + char, "utf8") > maxBytes) {
      pieces.push(current);
      current = "";
    }
    current += char;
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}

function createProjectKey(path: string): string {
  return createHash("sha256").update(path.trim()).digest("hex");
}
