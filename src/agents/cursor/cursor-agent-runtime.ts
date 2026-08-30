import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { basename } from "node:path";

import type {
  ConnectorPayload,
  SessionStreamFrame,
  SessionSummary,
} from "@yurupager/shared";

import type {
  AgentCapabilities,
  AgentDiscoveredSessionSnapshot,
  AgentEventSink,
  AgentRuntime,
  AgentSessionOptions,
  AgentStartSessionOptions,
} from "../types.js";
import { assertSessionOptionsSupported } from "../session-options.js";
import { AgentSessionStore } from "../agent-session-store.js";
import type { RemoteDecision, RemoteSessionCommand, RemoteSessionStreamControl } from "../../transport/connector-cloud-client.js";

export interface CursorAgentRuntimeOptions {
  agentId?: string;
  /** Cursor CLI command; defaults to "cursor-agent". */
  command?: string;
  /** Extra CLI arguments placed before the fixed stream-json arguments. */
  args?: string[];
  cwd?: string;
  projectName: string;
  projectPath: string;
  sessionStorePath?: string;
  initTimeoutMs?: number;
}

interface TurnContext {
  turnId: string;
  messageId: string;
  started: boolean;
  settled: () => void;
  fail: (error: Error) => void;
}

interface PendingPermission {
  requestId: string;
  controlRequestId: string;
  threadId: string;
  turnId: string;
  resolve(behavior: "allow" | "deny"): void;
  settled: boolean;
}

const STREAM_JSON_ARGS = ["--output-format", "stream-json", "--input-format", "stream-json"];

/**
 * Native adapter for the Cursor CLI's stream-json protocol (ADR-029): a line
 * oriented event stream (system/assistant/result + control requests), not
 * JSON-RPC. Discovery is own-sessions only; approvals normalise into the
 * shared request flow with fail-closed semantics; result usage is
 * accumulated into cumulative token snapshots with provider "cursor".
 */
export class CursorAgentRuntime implements AgentRuntime {
  readonly agentId: string;
  readonly #options: CursorAgentRuntimeOptions;
  readonly #displayName: string;
  #sink: AgentEventSink | undefined;
  #child: ChildProcess | undefined;
  #store: AgentSessionStore | undefined;
  #native: { cursorSessionId: string; model: string } | undefined;
  #boundThreadId: string | undefined;
  readonly #subscriptions = new Map<string, string>();
  #turn: TurnContext | undefined;
  #pendingPermission: PendingPermission | undefined;
  readonly #usageTotals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  #usageSequence = 0;
  #initResolve: (() => void) | undefined;
  #initReject: ((error: Error) => void) | undefined;
  #running = false;

  constructor(options: CursorAgentRuntimeOptions) {
    this.#options = options;
    this.agentId = options.agentId ?? "cursor";
    this.#displayName = `Cursor (${basename(options.command ?? "cursor-agent")})`;
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
      usageReporting: true,
      imageAttachments: false,
      // The stream-json init event reports a model but no selectable
      // catalogue; requested options fail closed (ADR-034).
      models: [],
    };
  }

  async startSession(options: AgentStartSessionOptions): Promise<{ sessionId: string }> {
    assertSessionOptionsSupported(this.agentId, options, []);
    if (!this.#running || this.#native === undefined) {
      throw new Error(`Cursor runtime ${this.agentId} is not running`);
    }
    if (this.#boundThreadId !== undefined) {
      throw new Error(`Cursor runtime ${this.agentId} already supervises a session`);
    }
    const threadId = `cursor-${randomUUID().slice(0, 8)}`;
    this.#bindOrRequire(threadId);
    // Fire-and-forget: the result event closes the turn asynchronously.
    this.#write({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: options.initialPrompt }] },
      session_id: this.#native.cursorSessionId,
    });
    return { sessionId: threadId };
  }

  async start(): Promise<void> {
    if (this.#running) return;
    if (this.#options.sessionStorePath !== undefined) {
      this.#store = new AgentSessionStore(this.#options.sessionStorePath);
    }
    const persisted = this.#store?.list() ?? [];
    const resumeId = persisted.at(-1)?.nativeSessionId;
    this.#spawn(resumeId === undefined ? [] : ["--resume", resumeId]);
    const initTimeoutMs = this.#options.initTimeoutMs ?? 30_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#initResolve = undefined;
        this.#initReject = undefined;
        reject(new Error(`Cursor capability probe timed out for ${this.agentId}`));
      }, initTimeoutMs);
      this.#initResolve = () => {
        clearTimeout(timer);
        this.#initResolve = undefined;
        this.#initReject = undefined;
        resolve();
      };
      this.#initReject = (error) => {
        clearTimeout(timer);
        this.#initResolve = undefined;
        this.#initReject = undefined;
        reject(error);
      };
    });
    if (this.#native === undefined) {
      // ADR-027: no init event means no negotiated surface — fail closed.
      throw new Error(`Cursor capability probe failed for ${this.agentId}: no init event`);
    }
    this.#running = true;
    if (resumeId !== undefined && this.#native.cursorSessionId === resumeId && persisted[0] !== undefined) {
      this.#boundThreadId = persisted[0].threadId;
      this.#publishSession("running");
    }
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#failPending(new Error("Cursor runtime stopped"));
    this.#child?.kill("SIGTERM");
    this.#child = undefined;
    this.#store?.close();
    this.#store = undefined;
  }

  async listSessions(): Promise<AgentDiscoveredSessionSnapshot | null> {
    return null; // own-sessions agent (ADR-025)
  }

  async handleDecision(remote: RemoteDecision): Promise<void> {
    const pending = this.#pendingPermission;
    if (pending === undefined || pending.requestId !== remote.requestId) return;
    const behavior = remote.decision.decision === "approve" ? "allow" : "deny";
    this.#settlePermission(pending, behavior);
    this.#write({
      type: "control_response",
      response: { subtype: "success", request_id: pending.controlRequestId, response: { behavior } },
    });
    if (behavior === "deny" && remote.decision.decision === "approve") {
      // Unmappable approve — fail closed with an explicit failed turn.
      this.#sendFrame(pending.threadId, { kind: "turn.status", turnId: pending.turnId, status: "failed" });
    }
  }

  async handleSessionCommand(remote: RemoteSessionCommand, sessionOptions?: AgentSessionOptions): Promise<void> {
    assertSessionOptionsSupported(this.agentId, sessionOptions, []);
    if (!this.#running || this.#child === undefined) {
      throw new Error(`Cursor runtime ${this.agentId} is not running`);
    }
    const bound = this.#bindOrRequire(remote.threadId);
    if (this.#turn !== undefined) {
      throw new Error("Cursor agent is already processing a turn");
    }
    const turnId = `turn-${remote.commandId.slice(0, 8)}`;
    this.#turn = {
      turnId,
      messageId: `msg-${turnId}`,
      started: false,
      settled: () => undefined,
      fail: () => undefined,
    };
    const settled = new Promise<void>((resolve, reject) => {
      if (this.#turn === undefined) return;
      this.#turn.settled = resolve;
      this.#turn.fail = reject;
    });
    this.#write({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: remote.text }] },
      session_id: bound.cursorSessionId,
    });
    await settled;
  }

  async handleSessionStream(control: RemoteSessionStreamControl): Promise<void> {
    if (control.type === "session.stream.unsubscribe") {
      this.#subscriptions.delete(control.subscriptionId);
      return;
    }
    this.#subscriptions.set(control.subscriptionId, control.threadId);
    this.#bindOrRequire(control.threadId);
    this.#sendFrame(control.threadId, { kind: "history.start" });
    this.#sendFrame(control.threadId, { kind: "history.complete" });
    // Cursor stream-json has no history replay; the live stream works and the
    // history section stays unavailable (ADR-025 degradation ladder).
  }

  async cancelSession(threadId: string): Promise<void> {
    if (this.#boundThreadId !== threadId || this.#turn === undefined) return;
    this.#write({ type: "control_request", request_id: randomUUID(), subtype: "interrupt" });
  }

  handleCloudOnline(): void {
    if (this.#boundThreadId !== undefined) this.#publishSession("running");
  }

  #spawn(extraArgs: string[]): void {
    const command = this.#options.command ?? "cursor-agent";
    const child = spawn(command, [
      ...(this.#options.args ?? []),
      ...STREAM_JSON_ARGS,
      ...extraArgs,
    ], {
      ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    child.once("exit", () => this.#handleExit());
    child.once("error", (error) => {
      this.#initReject?.(error instanceof Error ? error : new Error(String(error)));
      this.#handleExit();
    });
    if (child.stderr !== null) child.stderr.on("data", () => undefined);
    if (child.stdout !== null) {
      const reader = createInterface({ input: child.stdout });
      reader.on("line", (line) => this.#handleLine(line));
    }
  }

  #handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // tolerate non-protocol noise
    }
    const type = event.type;
    if (type === "system" && event.subtype === "init") {
      const cursorSessionId = typeof event.session_id === "string" ? event.session_id : "";
      const model = typeof event.model === "string" ? event.model : "unknown";
      if (cursorSessionId.length === 0) {
        this.#initReject?.(new Error("Cursor init event carried no session id"));
        return;
      }
      this.#native = { cursorSessionId, model };
      this.#initResolve?.();
      return;
    }
    if (type === "assistant") {
      this.#handleAssistant(event);
      return;
    }
    if (type === "control_request") {
      void this.#handleControlRequest(event);
      return;
    }
    if (type === "result") {
      this.#handleResult(event);
      return;
    }
    // Unknown event types are telemetry-shaped; they never carry permissions,
    // so ignoring them cannot fail open (ADR-029).
  }

  #handleAssistant(event: Record<string, unknown>): void {
    const turn = this.#turn;
    const threadId = this.#boundThreadId;
    if (turn === undefined || threadId === undefined) return;
    const message = event.message as { content?: unknown } | undefined;
    if (!Array.isArray(message?.content)) return;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        if (!turn.started) {
          this.#sendFrame(threadId, {
            kind: "message.start", messageId: turn.messageId, turnId: turn.turnId, role: "assistant",
          });
          turn.started = true;
        }
        this.#sendFrame(threadId, {
          kind: "message.delta", messageId: turn.messageId, delta: block.text,
        });
        continue;
      }
      if (block.type === "tool_use") {
        this.#forwardToolUse(threadId, turn, block);
      }
    }
  }

  #forwardToolUse(threadId: string, turn: TurnContext, block: Record<string, unknown>): void {
    const toolCallId = typeof block.id === "string" ? block.id : null;
    const name = typeof block.name === "string" ? block.name : null;
    if (toolCallId === null || name === null) return;
    // Sanitisation boundary (ADR-024 hard constraints): block.input is the
    // raw tool payload and never leaves the workstation; only the tool name
    // is used as the bounded activity label.
    this.#sendFrame(threadId, {
      kind: "activity.upsert",
      activityId: toolCallId,
      turnId: turn.turnId,
      activity: "tool",
      status: "in_progress",
      label: sanitizeLabel(name),
    });
  }

  async #handleControlRequest(event: Record<string, unknown>): Promise<void> {
    const controlRequestId = typeof event.request_id === "string" ? event.request_id : null;
    const subtype = typeof event.subtype === "string" ? event.subtype : "";
    if (controlRequestId === null) return;
    if (subtype !== "can_use_tool" || this.#turn === undefined || this.#pendingPermission !== undefined) {
      // Unknown control subtypes and out-of-state permissions fail closed.
      this.#write({
        type: "control_response",
        response: { subtype: "error", request_id: controlRequestId, error: "unsupported control request" },
      });
      return;
    }
    const toolName = typeof event.tool_name === "string" ? event.tool_name : "tool";
    const requestId = randomUUID();
    const threadId = this.#boundThreadId ?? "";
    const pending: PendingPermission = {
      requestId,
      controlRequestId,
      threadId,
      turnId: this.#turn.turnId,
      settled: false,
      resolve: () => undefined,
    };
    const parked = new Promise<"allow" | "deny">((resolve) => { pending.resolve = resolve; });
    this.#pendingPermission = pending;
    const payload: ConnectorPayload = {
      type: "request.created",
      requestId,
      threadId,
      agent: this.agentId,
      sessionId: threadId,
      turnId: this.#turn.turnId,
      itemId: randomUUID(),
      kind: "approval",
      category: "tool",
      tool: sanitizeLabel(toolName),
      risk: "medium",
      context: { availableDecisions: ["allow", "deny"] },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    this.#sink?.send(payload, `request:${requestId}`);
    const behavior = await parked;
    void behavior;
  }

  #handleResult(event: Record<string, unknown>): void {
    const turn = this.#turn;
    const threadId = this.#boundThreadId;
    if (turn === undefined || threadId === undefined) return;
    if (turn.started) {
      this.#sendFrame(threadId, { kind: "message.complete", messageId: turn.messageId });
    }
    const isError = event.is_error === true || String(event.subtype ?? "").startsWith("error");
    const subtype = String(event.subtype ?? "");
    this.#sendFrame(threadId, {
      kind: "turn.status",
      turnId: turn.turnId,
      status: subtype === "interrupted" ? "interrupted" : isError ? "failed" : "completed",
    });
    this.#ingestUsage(event);
    this.#publishSession(isError ? "failed" : "completed");
    turn.settled();
    this.#turn = undefined;
  }

  #ingestUsage(event: Record<string, unknown>): void {
    const usage = event.usage as Record<string, unknown> | undefined;
    if (usage === undefined) return;
    const read = (key: string): number =>
      typeof usage[key] === "number" && Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0
        ? usage[key] as number
        : 0;
    // Result usage is per-turn; the protocol expects cumulative snapshots.
    this.#usageTotals.inputTokens += read("input_tokens");
    this.#usageTotals.cachedInputTokens += read("cache_read_input_tokens") + read("cached_input_tokens");
    this.#usageTotals.outputTokens += read("output_tokens");
    this.#usageTotals.reasoningTokens += read("reasoning_output_tokens");
    const total = read("total_tokens");
    this.#usageTotals.totalTokens += total > 0
      ? total
      : this.#usageTotals.inputTokens + this.#usageTotals.outputTokens;
    this.#usageSequence += 1;
    const threadId = this.#boundThreadId;
    const turn = this.#turn;
    if (threadId === undefined || turn === undefined) return;
    const payload: ConnectorPayload = {
      type: "token.snapshot",
      eventId: createHash("sha256")
        .update(threadId).update("\0").update(String(this.#usageSequence))
        .digest("hex"),
      sequence: this.#usageSequence,
      threadId,
      agent: this.agentId,
      sessionId: threadId,
      turnId: turn.turnId,
      provider: "cursor",
      model: this.#native?.model ?? "unknown",
      inputTokens: this.#usageTotals.inputTokens,
      cachedInputTokens: this.#usageTotals.cachedInputTokens,
      outputTokens: this.#usageTotals.outputTokens,
      reasoningTokens: this.#usageTotals.reasoningTokens,
      totalTokens: this.#usageTotals.totalTokens,
      quality: "provisional",
      observedAt: new Date().toISOString(),
    };
    this.#sink?.send(payload, `usage:${threadId}:${this.#usageSequence}`);
  }

  #publishSession(status: SessionSummary["status"]): void {
    const threadId = this.#boundThreadId;
    if (threadId === undefined) return;
    const payload: ConnectorPayload = {
      type: "session.upsert",
      threadId,
      agent: this.agentId,
      sessionId: threadId,
      projectKey: createHash("sha256").update(this.#options.projectPath.trim()).digest("hex"),
      projectName: this.#options.projectName,
      projectPath: this.#options.projectPath,
      model: this.#native?.model ?? "unknown",
      status,
      syncState: "live",
      updatedAt: new Date().toISOString(),
    };
    this.#sink?.send(payload, `session:${threadId}:${status}`);
  }

  /** Binds the single supervised session lazily; mismatches fail closed. */
  #bindOrRequire(threadId: string): { cursorSessionId: string; model: string } {
    if (this.#boundThreadId === undefined) {
      this.#boundThreadId = threadId;
      if (this.#native !== undefined) {
        this.#store?.bind(threadId, this.#native.cursorSessionId);
        this.#publishSession("running");
      }
    }
    if (this.#boundThreadId !== threadId || this.#native === undefined) {
      throw new Error(`Cursor runtime ${this.agentId} supervises exactly one session`);
    }
    return this.#native;
  }

  #settlePermission(pending: PendingPermission, behavior: "allow" | "deny"): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.resolve(behavior);
    if (this.#pendingPermission === pending) this.#pendingPermission = undefined;
  }

  #failPending(error: Error): void {
    this.#turn?.fail(error);
    this.#turn = undefined;
    if (this.#pendingPermission !== undefined) {
      this.#settlePermission(this.#pendingPermission, "deny");
    }
  }

  #handleExit(): void {
    this.#running = false;
    this.#failPending(new Error("Cursor agent process exited"));
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

  #write(message: unknown): void {
    const child = this.#child;
    if (child === undefined) return;
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  }
}

function sanitizeLabel(value: string): string {
  const withoutBidi = value.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/giu, "");
  const withoutControls = withoutBidi.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  const collapsed = withoutControls.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return "tool";
  return Array.from(collapsed).slice(0, 120).join("");
}
