import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type {
  ConnectorPayload,
  DecisionInput,
  SessionStreamFrame,
} from "@yurupager/shared";

import type {
  AgentCapabilities,
  AgentDiscoveredSessionSnapshot,
  AgentEventSink,
  AgentRuntime,
} from "../types.js";
import { NdjsonJsonRpcConnection } from "../acp/json-rpc-connection.js";
import type {
  RemoteDecision,
  RemoteSessionCommand,
  RemoteSessionStreamControl,
} from "../../transport/connector-cloud-client.js";

export interface FakeAgentRuntimeOptions {
  agentId?: string;
  /** Path to the fake agent script; defaults to the sibling dist file and
   *  runs under the current node executable. */
  command?: string;
  args?: string[];
  cwd?: string;
  requestTimeoutMs?: number;
}

interface PendingPermission {
  requestId: string;
  acpSessionId: string;
  threadId: string;
  turnId: string;
  optionIds: string[];
  resolve(outcome: unknown): void;
  settled: boolean;
}

/**
 * Minimal AgentRuntime speaking the ACP dialect against the fake agent. It
 * validates the contract suite itself (Phase 1) and seeds the full
 * AcpAgentRuntime (Phase 2). Fail-closed rules from ADR-027 apply: unmappable
 * permission options resolve to rejection, protocol mismatch aborts start().
 */
export class FakeAgentRuntime implements AgentRuntime {
  readonly agentId: string;
  readonly #options: FakeAgentRuntimeOptions;
  #sink: AgentEventSink | undefined;
  #connection: NdjsonJsonRpcConnection | undefined;
  readonly #sessions = new Map<string, { acpSessionId: string; loadSession: boolean }>();
  readonly #subscriptions = new Map<string, { threadId: string }>();
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  readonly #messageSequences = new Map<string, number>();
  readonly #activeTurnId = new Map<string, string>();
  #loadSession = false;
  #running = false;

  constructor(options: FakeAgentRuntimeOptions = {}) {
    this.agentId = options.agentId ?? "fake-acp";
    this.#options = options;
  }

  attach(sink: AgentEventSink): void {
    this.#sink = sink;
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      agentId: this.agentId,
      displayName: "Fake ACP agent",
      discovery: "own-sessions",
      questions: false,
      usageReporting: false,
      imageAttachments: false,
    };
  }

  async start(): Promise<void> {
    if (this.#running) return;
    const script = this.#options.command ?? defaultFakeAgentPath();
    const connection = new NdjsonJsonRpcConnection({
      command: process.execPath,
      args: [script, ...(this.#options.args ?? ["--scenario", "standard"])],
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
      clientCapabilities: {},
    }) as { protocolVersion?: number; agentCapabilities?: { loadSession?: boolean } } | null;
    if (result === null || result.protocolVersion !== 1) {
      await connection.stop();
      this.#connection = undefined;
      throw new Error("Fake agent capability probe failed: unsupported protocol version");
    }
    this.#loadSession = result.agentCapabilities?.loadSession === true;
    this.#running = true;
  }

  async stop(): Promise<void> {
    this.#running = false;
    for (const pending of this.#pendingPermissions.values()) {
      this.#settlePermission(pending, { outcome: { outcome: "rejected" } });
    }
    await this.#connection?.stop();
    this.#connection = undefined;
  }

  async listSessions(): Promise<AgentDiscoveredSessionSnapshot | null> {
    return null; // own-sessions agent: no global discovery (ADR-025)
  }

  handleCloudOnline(): void {
    // The fake agent keeps no cached discovery to refresh.
  }

  async handleDecision(remote: RemoteDecision): Promise<void> {
    const pending = this.#pendingPermissions.get(remote.requestId);
    if (pending === undefined) return;
    const optionId = this.#resolveOptionId(remote.decision.decision, pending.optionIds);
    this.#settlePermission(pending, optionId === null
      ? { outcome: { outcome: "rejected" } }
      : { outcome: { outcome: "selected", optionId } });
    if (optionId === null && remote.decision.decision === "approve") {
      // Fail-closed: an approve that maps to no safe option is a denial.
      this.#sendFrame(pending.threadId, { kind: "turn.status", turnId: pending.turnId, status: "failed" });
    }
  }

  async handleSessionCommand(remote: RemoteSessionCommand): Promise<void> {
    const connection = this.#requireConnection();
    let session = this.#sessions.get(remote.threadId);
    if (session === undefined) {
      const result = await connection.request("session/new", { cwd: process.cwd() }) as { sessionId?: string } | null;
      const acpSessionId = result?.sessionId;
      if (typeof acpSessionId !== "string" || acpSessionId.length === 0) {
        throw new Error("Fake agent returned no session id");
      }
      session = { acpSessionId, loadSession: this.#loadSession };
      this.#sessions.set(remote.threadId, session);
    }
    const turnId = `turn-${remote.commandId.slice(0, 8)}`;
    this.#activeTurnId.set(session.acpSessionId, turnId);
    this.#messageSequences.set(turnId, 0);
    await connection.request("session/prompt", {
      sessionId: session.acpSessionId,
      prompt: [{ type: "text", text: remote.text }],
    });
  }

  async handleSessionStream(control: RemoteSessionStreamControl): Promise<void> {
    if (control.type === "session.stream.unsubscribe") {
      this.#subscriptions.delete(control.subscriptionId);
      return;
    }
    this.#subscriptions.set(control.subscriptionId, { threadId: control.threadId });
    const session = this.#sessions.get(control.threadId);
    this.#sendFrame(control.threadId, { kind: "history.start" });
    if (session?.loadSession === true) {
      await this.#connection?.request("session/load", { sessionId: session.acpSessionId, history: true });
    }
    this.#sendFrame(control.threadId, { kind: "history.complete" });
  }

  async cancelSession(threadId: string): Promise<void> {
    const session = this.#sessions.get(threadId);
    if (session === undefined) return;
    this.#connection?.notify("session/cancel", { sessionId: session.acpSessionId });
  }

  #requireConnection(): NdjsonJsonRpcConnection {
    const connection = this.#connection;
    if (connection === undefined || !this.#running) {
      throw new Error("Fake agent runtime is not running");
    }
    return connection;
  }

  #resolveOptionId(decision: DecisionInput["decision"], optionIds: string[]): string | null {
    if (decision === "approve") {
      return optionIds.find((id) => /^(allow|approve)/i.test(id)) ?? null;
    }
    if (decision === "deny") {
      return optionIds.find((id) => /^(reject|deny)/i.test(id)) ?? null;
    }
    return null; // questions unsupported (ADR-027 fail-closed)
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
    const turnId = this.#activeTurnId.get(acpSessionId) ?? "turn-unknown";
    if (update.sessionUpdate === "agent_message_chunk") {
      const sequence = (this.#messageSequences.get(turnId) ?? 0) + 1;
      this.#messageSequences.set(turnId, sequence);
      if (sequence === 1) {
        this.#sendFrame(threadId, {
          kind: "message.start", messageId: `msg-${turnId}`, turnId, role: "assistant",
        });
      }
      const content = update.content as { type?: string; text?: string } | undefined;
      const text = typeof content?.text === "string" ? content.text : "";
      this.#sendFrame(threadId, { kind: "message.delta", messageId: `msg-${turnId}`, delta: text });
      return;
    }
    if (update.sessionUpdate === "turn_end") {
      const stopReason = update.stopReason;
      this.#sendFrame(threadId, {
        kind: "turn.status",
        turnId,
        status: stopReason === "cancelled" ? "interrupted" : "completed",
      });
    }
  }

  async #handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== "session/request_permission") {
      throw new Error(`Unsupported agent request: ${method}`);
    }
    const record = (typeof params === "object" && params !== null ? params : {}) as {
      sessionId?: unknown;
      options?: Array<{ optionId?: unknown }>;
    };
    const acpSessionId = typeof record.sessionId === "string" ? record.sessionId : "";
    const threadId = this.#threadIdFor(acpSessionId);
    if (threadId === null) throw new Error("Permission request for unknown session");
    const optionIds = (record.options ?? [])
      .map((option) => (typeof option?.optionId === "string" ? option.optionId : ""))
      .filter((id) => id.length > 0);
    const requestId = randomUUID();
    const turnId = this.#activeTurnId.get(acpSessionId) ?? "turn-unknown";
    const pending: PendingPermission = {
      requestId,
      acpSessionId,
      threadId,
      turnId,
      optionIds,
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
      category: "command",
      tool: "acp_permission",
      risk: "medium",
      context: { availableDecisions: optionIds },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    this.#sink?.send(payload);
    // Keep the agent-side request open; handleDecision resolves it through
    // the parked promise, which the connection turns into the JSON-RPC reply.
    return parked;
  }

  #threadIdFor(acpSessionId: string): string | null {
    for (const [threadId, session] of this.#sessions) {
      if (session.acpSessionId === acpSessionId) return threadId;
    }
    return null;
  }

  #sendFrame(threadId: string, frame: SessionStreamFrame): void {
    for (const [subscriptionId, subscription] of this.#subscriptions) {
      if (subscription.threadId !== threadId) continue;
      this.#sink?.sendEphemeral({
        type: "session.stream.frame",
        subscriptionId,
        threadId,
        frame,
      });
    }
  }

  #handleExit(): void {
    this.#running = false;
    for (const pending of this.#pendingPermissions.values()) {
      this.#settlePermission(pending, { outcome: { outcome: "rejected" } });
    }
    // Fail-closed: pending prompts are abandoned; a fresh start() can spawn a
    // replacement process (crash-reconnect contract).
  }
}

function defaultFakeAgentPath(): string {
  return fileURLToPath(new URL("./fake-acp-agent.js", import.meta.url));
}
