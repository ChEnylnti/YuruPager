import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";

import type {
  ConnectorPayload,
  DecisionInput,
  SessionStreamFrame,
  SessionSummary,
} from "@yurupager/shared";

import type {
  AgentCapabilities,
  AgentDiscoveredSessionSnapshot,
  AgentEventSink,
  AgentRuntime,
} from "../types.js";
import { NdjsonJsonRpcConnection } from "./json-rpc-connection.js";
import { AcpSessionStore } from "./acp-session-store.js";
import type {
  RemoteDecision,
  RemoteSessionCommand,
  RemoteSessionStreamControl,
} from "../../transport/connector-cloud-client.js";

export interface AcpAgentRuntimeOptions {
  agentId?: string;
  command: string;
  args?: string[];
  cwd?: string;
  projectName: string;
  projectPath: string;
  /** SQLite file for durable own-session bindings; omit to keep memory-only (tests). */
  sessionStorePath?: string;
  requestTimeoutMs?: number;
  /** Whether to resume persisted sessions after start (default true). */
  resumePersistedSessions?: boolean;
}

interface ActiveSession {
  threadId: string;
  acpSessionId: string;
}

interface TurnContext {
  turnId: string;
  messageId: string;
  started: boolean;
}

interface PendingPermission {
  requestId: string;
  acpSessionId: string;
  threadId: string;
  turnId: string;
  options: Array<{ optionId: string; kind: string }>;
  resolve(outcome: unknown): void;
  settled: boolean;
}

const MAX_DELTA_BYTES = 16 * 1024 - 1;

/**
 * Runtime for ACP (Agent Client Protocol) agents over stdio JSON-RPC
 * (ADR-024). Discovers only its own sessions (ADR-025), rebuilds history via
 * session/load when the agent declares loadSession, and normalizes
 * session/request_permission into the shared approval flow with fail-closed
 * option mapping (ADR-027). ACP defines no usage reporting: this runtime
 * never fabricates token snapshots.
 */
export class AcpAgentRuntime implements AgentRuntime {
  readonly agentId: string;
  readonly #options: AcpAgentRuntimeOptions;
  readonly #displayName: string;
  #sink: AgentEventSink | undefined;
  #connection: NdjsonJsonRpcConnection | undefined;
  #store: AcpSessionStore | undefined;
  readonly #sessions = new Map<string, ActiveSession>();
  readonly #subscriptions = new Map<string, string>();
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  readonly #turns = new Map<string, TurnContext>();
  #loadSession = false;
  #running = false;

  constructor(options: AcpAgentRuntimeOptions) {
    this.#options = options;
    this.agentId = options.agentId ?? "acp";
    this.#displayName = `ACP (${basename(options.command)})`;
  }

  attach(sink: AgentEventSink): void {
    this.#sink = sink;
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      agentId: this.agentId,
      displayName: this.#displayName,
      discovery: "own-sessions",
      questions: false,
      usageReporting: false,
      imageAttachments: false,
    };
  }

  async start(): Promise<void> {
    if (this.#running) return;
    if (this.#options.sessionStorePath !== undefined) {
      this.#store = new AcpSessionStore(this.#options.sessionStorePath);
    }
    const connection = new NdjsonJsonRpcConnection({
      command: this.#options.command,
      args: this.#options.args ?? [],
      ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
      ...(this.#options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.#options.requestTimeoutMs }),
      onNotification: (method, params) => this.#handleNotification(method, params),
      onRequest: (method, params) => this.#handleServerRequest(method, params),
      onExit: () => this.#handleExit(),
    });
    connection.start();
    this.#connection = connection;
    const result = await connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }) as { protocolVersion?: unknown; agentCapabilities?: { loadSession?: unknown } } | null;
    if (result === null || result.protocolVersion !== 1) {
      // ADR-027: protocol mismatch fails closed instead of improvising.
      await connection.stop();
      this.#connection = undefined;
      throw new Error(`ACP agent capability probe failed for ${this.agentId}: unsupported protocol version`);
    }
    this.#loadSession = result.agentCapabilities?.loadSession === true;
    this.#running = true;

    await this.#resumePersistedSessions();
    this.#republishSessions();
  }

  async stop(): Promise<void> {
    this.#running = false;
    for (const pending of this.#pendingPermissions.values()) {
      this.#settlePermission(pending, { outcome: { outcome: "rejected" } });
    }
    await this.#connection?.stop();
    this.#connection = undefined;
    this.#store?.close();
    this.#store = undefined;
  }

  async listSessions(): Promise<AgentDiscoveredSessionSnapshot | null> {
    return null; // own-sessions agent: no intrusive global discovery (ADR-025)
  }

  async handleDecision(remote: RemoteDecision): Promise<void> {
    const pending = this.#pendingPermissions.get(remote.requestId);
    if (pending === undefined) return;
    const optionId = this.#resolveOptionId(remote.decision.decision, pending.options);
    this.#settlePermission(pending, optionId === null
      ? { outcome: { outcome: "rejected" } }
      : { outcome: { outcome: "selected", optionId } });
    if (optionId === null && remote.decision.decision === "approve") {
      // Fail-closed: an approve that maps to no safe option is a denial.
      this.#sendFrame(pending.threadId, { kind: "turn.status", turnId: pending.turnId, status: "failed" });
    }
  }

  async handleSessionCommand(remote: RemoteSessionCommand): Promise<void> {
    const session = await this.#ensureSession(remote.threadId);
    const turnId = `turn-${remote.commandId.slice(0, 8)}`;
    this.#turns.set(session.acpSessionId, {
      turnId,
      messageId: `msg-${turnId}`,
      started: false,
    });
    await this.#requireConnection().request("session/prompt", {
      sessionId: session.acpSessionId,
      prompt: [{ type: "text", text: remote.text }],
    });
  }

  async handleSessionStream(control: RemoteSessionStreamControl): Promise<void> {
    if (control.type === "session.stream.unsubscribe") {
      this.#subscriptions.delete(control.subscriptionId);
      return;
    }
    const threadId = control.threadId;
    this.#subscriptions.set(control.subscriptionId, threadId);
    this.#sendFrame(threadId, { kind: "history.start" });
    const session = this.#sessions.get(threadId);
    if (session !== undefined && this.#loadSession) {
      try {
        await this.#requireConnection().request("session/load", {
          sessionId: session.acpSessionId,
          history: true,
        });
      } catch {
        // ADR-025 degradation: history stays unavailable; the live stream works.
        this.#sendStreamError(control.subscriptionId, threadId, "thread_unavailable");
      }
    }
    this.#sendFrame(threadId, { kind: "history.complete" });
  }

  async cancelSession(threadId: string): Promise<void> {
    const session = this.#sessions.get(threadId);
    if (session === undefined) return;
    this.#connection?.notify("session/cancel", { sessionId: session.acpSessionId });
  }

  handleCloudOnline(): void {
    this.#republishSessions();
  }

  async #ensureSession(threadId: string): Promise<ActiveSession> {
    const existing = this.#sessions.get(threadId);
    if (existing !== undefined) return existing;
    const result = await this.#requireConnection().request("session/new", {
      ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
      mcpServers: [],
    }) as { sessionId?: unknown } | null;
    const acpSessionId = result?.sessionId;
    if (typeof acpSessionId !== "string" || acpSessionId.length === 0) {
      throw new Error(`ACP agent returned no session id for ${this.agentId}`);
    }
    return this.#bindSession(threadId, acpSessionId);
  }

  #bindSession(threadId: string, acpSessionId: string): ActiveSession {
    const session: ActiveSession = { threadId, acpSessionId };
    this.#sessions.set(threadId, session);
    this.#store?.bind(threadId, acpSessionId);
    this.#publishSession(threadId, "running");
    return session;
  }

  #resumePersistedSessions(): Promise<void> {
    const persisted = this.#store?.list() ?? [];
    if (persisted.length === 0 || this.#options.resumePersistedSessions === false) {
      return Promise.resolve();
    }
    const resume = async (): Promise<void> => {
      for (const entry of persisted) {
        if (this.#loadSession) {
          try {
            await this.#requireConnection().request("session/load", {
              sessionId: entry.acpSessionId,
              history: false, // resume without replay; history is reloaded on subscribe
            });
          } catch {
            continue; // failed resume fails closed: the session is not re-offered
          }
        }
        this.#sessions.set(entry.threadId, { threadId: entry.threadId, acpSessionId: entry.acpSessionId });
      }
    };
    return resume();
  }

  #republishSessions(): void {
    for (const threadId of this.#sessions.keys()) this.#publishSession(threadId, "running");
  }

  #publishSession(threadId: string, status: SessionSummary["status"]): void {
    const payload: ConnectorPayload = {
      type: "session.upsert",
      threadId,
      agent: this.agentId,
      sessionId: threadId,
      projectKey: this.#projectKey(),
      projectName: this.#options.projectName,
      projectPath: this.#projectPathHint(),
      model: this.#displayName,
      status,
      syncState: "live",
      updatedAt: new Date().toISOString(),
    };
    this.#sink?.send(payload, `session:${threadId}:${status}`);
  }

  #projectKey(): string {
    return createProjectKey(this.#options.projectPath);
  }

  #projectPathHint(): string {
    const path = this.#options.projectPath;
    return path.startsWith("/") ? `~${path}` : path;
  }

  #requireConnection(): NdjsonJsonRpcConnection {
    const connection = this.#connection;
    if (connection === undefined || !this.#running) {
      throw new Error(`ACP runtime ${this.agentId} is not running`);
    }
    return connection;
  }

  async #handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission") {
      return this.#handlePermissionRequest(params);
    }
    // Fail-closed: unknown server→client requests are refused (ADR-027).
    throw new Error(`Unsupported ACP server request: ${method}`);
  }

  async #handlePermissionRequest(params: unknown): Promise<unknown> {
    const record = (typeof params === "object" && params !== null ? params : {}) as {
      sessionId?: unknown;
      options?: Array<{ optionId?: unknown; kind?: unknown }>;
      reason?: unknown;
    };
    const acpSessionId = typeof record.sessionId === "string" ? record.sessionId : "";
    const threadId = this.#threadIdFor(acpSessionId);
    if (threadId === null) throw new Error("Permission request for an unknown ACP session");
    const options = (record.options ?? [])
      .map((option) => ({
        optionId: typeof option?.optionId === "string" ? option.optionId : "",
        kind: typeof option?.kind === "string" ? option.kind : "unknown",
      }))
      .filter((option) => option.optionId.length > 0);
    const requestId = randomUUID();
    const turn = this.#turns.get(acpSessionId);
    const turnId = turn?.turnId ?? "turn-unknown";
    const pending: PendingPermission = {
      requestId,
      acpSessionId,
      threadId,
      turnId,
      options,
      settled: false,
      resolve: () => undefined,
    };
    const parked = new Promise<unknown>((resolve) => { pending.resolve = resolve; });
    this.#pendingPermissions.set(requestId, pending);
    const payload: ConnectorPayload = {
      type: "request.created",
      requestId,
      threadId,
      agent: this.agentId,
      sessionId: threadId,
      turnId,
      itemId: randomUUID(),
      kind: "approval",
      category: "tool",
      tool: "acp_permission",
      risk: "medium",
      context: {
        ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
        availableDecisions: options.map((option) => option.optionId),
      },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    this.#sink?.send(payload, `request:${requestId}`);
    return parked;
  }

  #resolveOptionId(decision: DecisionInput["decision"], options: Array<{ optionId: string; kind: string }>): string | null {
    if (decision === "approve") {
      // ADR-027: only an explicit one-shot allow maps to approve; sticky
      // "always allow" grants more than this decision and stays unmapped.
      return options.find((option) => option.kind === "allow_once")?.optionId
        ?? options.find((option) => /^allow/i.test(option.optionId) && option.kind === "allow_once")?.optionId
        ?? null;
    }
    if (decision === "deny") {
      return options.find((option) => option.kind === "reject_once")?.optionId
        ?? options.find((option) => /^reject/i.test(option.optionId))?.optionId
        ?? null;
    }
    return null; // questions unsupported over ACP
  }

  #settlePermission(pending: PendingPermission, outcome: unknown): void {
    if (pending.settled) return;
    pending.settled = true;
    this.#pendingPermissions.delete(pending.requestId);
    pending.resolve(outcome);
  }

  #handleNotification(method: string, params: unknown): void {
    if (method !== "session/update" || typeof params !== "object" || params === null) return;
    const record = params as { sessionId?: unknown; update?: Record<string, unknown> };
    const acpSessionId = record.sessionId;
    const update = record.update;
    if (typeof acpSessionId !== "string" || update === undefined) return;
    const threadId = this.#threadIdFor(acpSessionId);
    if (threadId === null) return;
    const sessionUpdate = update.sessionUpdate;
    if (sessionUpdate === "agent_message_chunk") {
      this.#forwardTextChunk(acpSessionId, threadId, update.content);
      return;
    }
    if (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") {
      this.#forwardToolCall(acpSessionId, threadId, update);
      return;
    }
    if (sessionUpdate === "turn_end") {
      this.#forwardTurnEnd(acpSessionId, threadId, update.stopReason);
      return;
    }
    // agent_thought_chunk (hidden reasoning), plan, available_commands_update
    // and mode updates never leave the workstation — same boundary as Codex.
  }

  #forwardTextChunk(acpSessionId: string, threadId: string, content: unknown): void {
    const turn = this.#turns.get(acpSessionId);
    if (turn === undefined) return;
    const text = (content as { type?: unknown; text?: unknown } | undefined)?.text;
    if (typeof text !== "string" || text.length === 0) return;
    if (!turn.started) {
      this.#sendFrame(threadId, {
        kind: "message.start", messageId: turn.messageId, turnId: turn.turnId, role: "assistant",
      });
      turn.started = true;
    }
    for (const piece of splitUtf8Safe(text, MAX_DELTA_BYTES)) {
      this.#sendFrame(threadId, { kind: "message.delta", messageId: turn.messageId, delta: piece });
    }
  }

  #forwardToolCall(acpSessionId: string, threadId: string, update: Record<string, unknown>): void {
    const turn = this.#turns.get(acpSessionId);
    if (turn === undefined) return;
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : null;
    if (toolCallId === null) return;
    // Sanitisation boundary (ADR-024 hard constraints): rawInput, rawOutput
    // and rawContent never leave the workstation; only a bounded display label.
    const label = sanitizeDisplayLabel(update.title);
    if (label === null) return;
    const kind = typeof update.kind === "string" ? update.kind : "other";
    const status = mapToolStatus(update.status);
    if (status === null) return;
    this.#sendFrame(threadId, {
      kind: "activity.upsert",
      activityId: toolCallId,
      turnId: turn.turnId,
      activity: mapToolKind(kind),
      status,
      label,
    });
  }

  #forwardTurnEnd(acpSessionId: string, threadId: string, stopReason: unknown): void {
    const turn = this.#turns.get(acpSessionId);
    if (turn === undefined) return;
    if (turn.started) {
      this.#sendFrame(threadId, { kind: "message.complete", messageId: turn.messageId });
    }
    const status = stopReason === "end_turn" ? "completed"
      : stopReason === "cancelled" ? "interrupted"
        : "failed"; // refused / max_tokens / unknown — fail closed
    this.#sendFrame(threadId, { kind: "turn.status", turnId: turn.turnId, status });
    this.#turns.delete(acpSessionId);
    this.#publishSession(threadId, status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed");
  }

  #threadIdFor(acpSessionId: string): string | null {
    for (const [threadId, session] of this.#sessions) {
      if (session.acpSessionId === acpSessionId) return threadId;
    }
    return null;
  }

  #sendFrame(threadId: string, frame: SessionStreamFrame): void {
    for (const [subscriptionId, subscribedThread] of this.#subscriptions) {
      if (subscribedThread !== threadId) continue;
      this.#sink?.sendEphemeral({
        type: "session.stream.frame",
        subscriptionId,
        threadId,
        frame,
      });
    }
  }

  #sendStreamError(subscriptionId: string, threadId: string, code: "thread_unavailable" | "stream_failed"): void {
    this.#sink?.sendEphemeral({ type: "session.stream.error", subscriptionId, threadId, code });
  }

  #handleExit(): void {
    this.#running = false;
    for (const pending of this.#pendingPermissions.values()) {
      this.#settlePermission(pending, { outcome: { outcome: "rejected" } });
    }
    this.#turns.clear();
  }
}

function mapToolStatus(value: unknown): "in_progress" | "completed" | "failed" | null {
  if (value === "completed") return "completed";
  if (value === "failed") return "failed";
  if (value === "pending" || value === "in_progress" || value === undefined) return "in_progress";
  return null; // unknown statuses are dropped rather than guessed
}

function mapToolKind(kind: string): "command" | "file_change" | "tool" | "web_search" {
  if (kind === "execute") return "command";
  if (kind === "edit" || kind === "delete" || kind === "move") return "file_change";
  if (kind === "fetch") return "web_search";
  return "tool"; // read / search / think / other
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
  // Stable, non-reversible workspace key matching the Codex runtime's scheme.
  return createHash("sha256").update(path.trim()).digest("hex");
}
