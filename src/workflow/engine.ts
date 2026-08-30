import { randomUUID } from "node:crypto";

import type {
  ConnectorPayload,
  ConnectorSessionStreamMessage,
  WorkflowDefinitionSnapshot,
  WorkflowNodeRunState,
  WorkflowNodeRunStatus,
  WorkflowRunStatus,
} from "@yurupager/shared";

import type { AgentRuntime } from "../agents/types.js";
import type { ConnectorCloudClient } from "../transport/connector-cloud-client.js";
import { WorkflowRunJournal } from "./run-journal.js";
import {
  agentConfirmPrompt,
  criteriaCheckPrompt,
  parseConditionVerdict,
  renderTemplate,
  validateDefinition,
} from "./templates.js";

export interface WorkflowEngineOptions {
  cloud: ConnectorCloudClient;
  resolveRuntime(agentKind: string): AgentRuntime | undefined;
  journalPath: string;
  clock?: () => number;
  backoffCeilingMs?: number;
}

export interface WorkflowGateDecisionInput {
  requestId: string;
  decision: "approve" | "deny";
}

interface NodeRuntimeState {
  status: WorkflowNodeRunStatus;
  attempts: number;
  sessionId?: string;
  turnBudgetUsed: number;
  deadline: number;
  reasonCode?: string;
}

interface ActiveRun {
  runId: string;
  definition: WorkflowDefinitionSnapshot;
  status: WorkflowRunStatus;
  nodeIndex: number;
  node: NodeRuntimeState;
  checkSummary: string | null;
  finalMessage: string | null;
  cancelled: boolean;
  offline: boolean;
}

/**
 * The planning-workflow orchestration engine (ADR-032/033). The Connector is
 * the only executor: nodes run through AgentRuntime semantics, completion is
 * verified before any hand-off (fail-closed), and hand-off text / agent
 * output live exclusively in engine memory and the ephemeral channel —
 * reports carry status metadata only.
 */
export class WorkflowEngine {
  readonly #cloud: ConnectorCloudClient;
  readonly #resolveRuntime: (agentKind: string) => AgentRuntime | undefined;
  readonly #journal: WorkflowRunJournal;
  readonly #clock: () => number;
  readonly #backoffCeilingMs: number;
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #transcript = new Map<string, { text: string; last: string | null }>();
  readonly #nodeSessions = new Set<string>();
  readonly #startBuffer = new Map<string, ConnectorSessionStreamMessage[]>();
  #startInFlight = 0;
  readonly #turnWaiters = new Map<string, Array<(status: "completed" | "failed" | "interrupted") => void>>();
  readonly #gateWaiters = new Map<string, (decision: "approve" | "deny") => void>();
  readonly #detachFrameListener: () => void;
  readonly #detachStatusListener: () => void;

  constructor(options: WorkflowEngineOptions) {
    this.#cloud = options.cloud;
    this.#resolveRuntime = options.resolveRuntime;
    this.#journal = new WorkflowRunJournal(options.journalPath);
    this.#clock = options.clock ?? Date.now;
    this.#backoffCeilingMs = options.backoffCeilingMs ?? 30_000;
    this.#detachFrameListener = this.#cloud.onEphemeralMessage((message) => this.#handleEphemeral(message));
    this.#detachStatusListener = this.#cloud.onStatus((online) => this.#handleOnline(online));
  }

  /** Restores journal entries after a Connector restart (ADR-032). */
  start(): void {
    for (const entry of this.#journal.list()) {
      if (entry.nodeStatus === "pending") {
        // Never started: dispatch again from the beginning of the node.
        const run = this.#createRun(entry.definition, entry.runId);
        void this.#startNode(run, entry.currentNodeIndex, entry.attempts);
        continue;
      }
      // An in-flight node died with the Connector: mark interrupted, then
      // re-dispatch per the node retry policy.
      const run = this.#createRun(entry.definition, entry.runId);
      this.#reportNodeStatus(entry.runId, entry.definition.nodes[entry.currentNodeIndex]?.id ?? "", entry.currentNodeIndex, "interrupted", entry.attempts, entry.sessionId ?? undefined, "connector_restarted");
      const budgetLeft = entry.attempts < (entry.definition.nodes[entry.currentNodeIndex]?.condition.maxRetries ?? 0) + 1;
      if (!budgetLeft) {
        this.#failNode(run, "retries_exhausted");
        continue;
      }
      void this.#startNode(run, entry.currentNodeIndex, entry.attempts + 1);
    }
  }

  stop(): void {
    this.#detachFrameListener();
    this.#detachStatusListener();
    this.#journal.close();
    this.#activeRuns.clear();
  }

  dispatchRun(definition: WorkflowDefinitionSnapshot, runId: string): void {
    validateDefinition(definition);
    if (this.#activeRuns.has(runId)) {
      throw new Error(`workflow_run_already_active: ${runId}`);
    }
    const run = this.#createRun(definition, runId);
    this.#reportRunStatus(run, "running");
    void this.#startNode(run, 0, 0);
  }

  cancelRun(runId: string, reason: string): void {
    const run = this.#activeRuns.get(runId);
    if (run === undefined) return;
    run.cancelled = true;
    const sessionId = run.node.sessionId;
    const runtime = sessionId === undefined ? undefined : this.#resolveRuntime(run.definition.nodes[run.nodeIndex]?.agentKind ?? "");
    if (sessionId !== undefined && runtime?.cancelSession !== undefined) {
      void runtime.cancelSession(sessionId).catch(() => undefined);
    }
    void this.#finishRun(run, "cancelled", `cancelled:${reason}`);
  }

  /** Manual gate decisions arrive through the shared approval flow. */
  handleGateDecision(decision: WorkflowGateDecisionInput): boolean {
    const waiter = this.#gateWaiters.get(decision.requestId);
    if (waiter === undefined) return false;
    this.#gateWaiters.delete(decision.requestId);
    waiter(decision.decision);
    return true;
  }

  #createRun(definition: WorkflowDefinitionSnapshot, runId: string): ActiveRun {
    const run: ActiveRun = {
      runId,
      definition,
      status: "running",
      nodeIndex: 0,
      node: { status: "pending", attempts: 0, turnBudgetUsed: 0, deadline: 0 },
      checkSummary: null,
      finalMessage: null,
      cancelled: false,
      offline: false,
    };
    this.#activeRuns.set(runId, run);
    return run;
  }

  async #startNode(run: ActiveRun, nodeIndex: number, attempts: number): Promise<void> {
    run.nodeIndex = nodeIndex;
    const node = run.definition.nodes[nodeIndex];
    if (node === undefined) {
      await this.#finishRun(run, "completed");
      return;
    }
    if (run.cancelled) return;
    const runtime = this.#resolveRuntime(node.agentKind);
    if (runtime === undefined) {
      this.#failNode(run, "agent_unavailable");
      return;
    }
    const capabilities = await runtime.capabilities().catch(() => undefined);
    if (capabilities === undefined) {
      this.#failNode(run, "agent_probe_failed");
      return;
    }
    if (node.model !== undefined || node.reasoningEffort !== undefined) {
      try {
        assertOptionsInCatalogue(node.agentKind, node.model, node.reasoningEffort, capabilities.models);
      } catch (error) {
        this.#failNode(run, `model_unavailable:${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }

    const runId = this.#runIdOf(run);
    run.node = {
      status: "starting",
      attempts,
      turnBudgetUsed: run.node.turnBudgetUsed,
      deadline: this.#clock() + node.timeoutMs,
    };
    const nodeState: WorkflowNodeRunState = {
      nodeId: node.id,
      index: nodeIndex,
      status: "starting",
      attempts,
    };
    this.#sink().send({
      type: "workflow.node.status",
      runId,
      nodeId: node.id,
      index: nodeIndex,
      status: "starting",
      attempts,
    }, `wf-node:${runId}:${node.id}:starting:${attempts}`);
    void nodeState;
    this.#journal.upsert({
      runId,
      definition: run.definition,
      currentNodeIndex: nodeIndex,
      nodeStatus: "starting",
      attempts,
      sessionId: null,
    });

    const prevNode = nodeIndex > 0 ? run.definition.nodes[nodeIndex - 1] : undefined;
    const variables = {
      goal: run.definition.goal,
      nodeTask: node.task,
      prevFinalMessage: run.finalMessage ?? "",
      prevCheckSummary: run.checkSummary ?? "",
    };
    let prompt = renderTemplate(node.task, variables);
    if (prevNode?.handoffPrompt !== undefined && prevNode.handoffPrompt.trim().length > 0) {
      prompt = `${prompt}\n\n${renderTemplate(prevNode.handoffPrompt, variables)}`;
    }

    if (runtime.startSession === undefined) {
      this.#failNode(run, "session_creation_unsupported");
      return;
    }
    this.#startInFlight += 1;
    try {
      const cwd = this.#options_cwd();
      const { sessionId } = await runtime.startSession({
        initialPrompt: prompt,
        ...(cwd === undefined ? {} : { cwd }),
        ...(node.model === undefined ? {} : { model: node.model }),
        ...(node.reasoningEffort === undefined ? {} : { reasoningEffort: node.reasoningEffort }),
      });
      run.node.sessionId = sessionId;
      this.#nodeSessions.add(sessionId);
      this.#transcript.set(sessionId, { text: "", last: null });
      this.#promoteStartBuffer(sessionId);
      this.#journal.upsert({
        runId,
        definition: run.definition,
        currentNodeIndex: nodeIndex,
        nodeStatus: "running",
        attempts,
        sessionId,
      });
      this.#reportNodeStatus(runId, node.id, nodeIndex, "running", attempts, sessionId);
      run.node.status = "running";
      void this.#awaitTurnCompletion(sessionId, run).then((turnStatus) => {
        if (this.#activeRuns.get(run.runId) !== run) return;
        if (turnStatus !== "completed") {
          // Interrupted/failed turns have an unknown outcome: fail-closed by
          // re-running the node under its retry policy, never assuming success.
          this.#retryOrFail(run, node.id, nodeIndex, attempts, sessionId, `turn_${turnStatus}`);
          return;
        }
        const taskTranscript = this.#transcript.get(sessionId);
        if (taskTranscript !== undefined && taskTranscript.text.length > 0) {
          run.finalMessage = taskTranscript.text;
        }
        void this.#enterConditionPhase(run, node.id, nodeIndex, attempts, sessionId);
      }).catch(() => undefined);
    } catch (error) {
      this.#failNode(run, `start_failed:${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.#startInFlight -= 1;
      if (this.#startInFlight === 0) this.#startBuffer.clear();
    }
  }

  #promoteStartBuffer(sessionId: string): void {
    const buffered = this.#startBuffer.get(sessionId);
    this.#startBuffer.delete(sessionId);
    for (const message of buffered ?? []) this.#handleEphemeral(message);
  }

  #options_cwd(): string | undefined {
    return undefined; // the runtime's own workspace cwd applies
  }

  #runIdOf(run: ActiveRun): string {
    return run.runId;
  }

  async #awaitTurnCompletion(sessionId: string, run: ActiveRun): Promise<"completed" | "failed" | "interrupted"> {
    return this.#waitTurn(sessionId, run);
  }

  #waitTurn(sessionId: string, run: ActiveRun): Promise<"completed" | "failed" | "interrupted"> {
    return new Promise((resolve, reject) => {
      const waiters = this.#turnWaiters.get(sessionId) ?? [];
      const timer = setInterval(() => {
        if (run.cancelled) {
          clearInterval(timer);
          resolve("interrupted");
          return;
        }
        if (this.#clock() > run.node.deadline) {
          clearInterval(timer);
          reject(new Error("node_timeout"));
        }
      }, 250);
      timer.unref();
      waiters.push((status) => {
        clearInterval(timer);
        resolve(status);
      });
      this.#turnWaiters.set(sessionId, waiters);
    });
  }

  async #enterConditionPhase(
    run: ActiveRun,
    nodeId: string,
    nodeIndex: number,
    attempts: number,
    sessionId: string,
  ): Promise<void> {
    const node = run.definition.nodes[nodeIndex];
    if (node === undefined) return;
    const runId = this.#runIdOf(run);
    const condition = node.condition;

    if (condition.kind === "manual_gate") {
      run.node.status = "waiting_approval";
      this.#reportNodeStatus(runId, nodeId, nodeIndex, "waiting_approval", attempts, sessionId);
      const requestId = randomUUID();
      const gatePayload: ConnectorPayload = {
        type: "request.created",
        requestId,
        threadId: sessionId,
        agent: node.agentKind,
        sessionId,
        turnId: "turn-gate",
        itemId: randomUUID(),
        kind: "workflow_gate",
        category: "workflow",
        tool: "manual_gate",
        risk: "high",
        context: { reason: `workflow_gate:${node.id}`, availableDecisions: ["approve", "deny"] },
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      };
      this.#sink().send(gatePayload, `wf-gate:${runId}:${node.id}:${requestId}`);
      const decision = await new Promise<"approve" | "deny">((resolve) => {
        this.#gateWaiters.set(requestId, resolve);
      });
      if (decision !== "approve") {
        this.#failNode(run, "gate_denied");
        return;
      }
      this.#confirmNode(run, nodeId, nodeIndex, attempts, sessionId, "gate_approved");
      return;
    }

    // agent_confirm / criteria_check: a verification turn on the same session.
    run.node.status = "verifying";
    this.#reportNodeStatus(runId, nodeId, nodeIndex, "verifying", attempts, sessionId);
    run.node.turnBudgetUsed += 1;
    if (run.node.turnBudgetUsed > node.turnBudget) {
      this.#failNode(run, "turn_budget_exhausted");
      return;
    }
    const verifyPrompt = condition.kind === "agent_confirm"
      ? agentConfirmPrompt(node.task)
      : criteriaCheckPrompt(node.task, condition.criteriaText ?? "");
    this.#nodeSessions.add(sessionId); // verifier replies flow through the live channel
    this.#transcript.set(sessionId, { text: "", last: null }); // capture only the verifier reply
    const runtime = this.#resolveRuntime(node.agentKind);
    if (runtime === undefined) {
      this.#failNode(run, "agent_unavailable");
      return;
    }
    void runtime.handleSessionCommand({
      type: "session.command",
      messageId: randomUUID(),
      sequence: 0,
      commandId: randomUUID(),
      threadId: sessionId,
      text: verifyPrompt,
      attachments: [],
    }).catch(() => undefined);
    const turnStatus = await this.#waitTurn(sessionId, run).catch(() => "failed" as const);
    if (turnStatus !== "completed") {
      this.#failNode(run, turnStatus === "interrupted" ? "turn_interrupted" : "verification_turn_failed");
      return;
    }
    const reply = this.#transcript.get(sessionId)?.text ?? "";
    const verdict = parseConditionVerdict(reply);
    run.checkSummary = `${verdict.verdict} - ${verdict.reason}`;
    if (verdict.verdict !== "PASS") {
      this.#retryOrFail(run, nodeId, nodeIndex, attempts, sessionId, `check_failed:${verdict.reason}`);
      return;
    }
    this.#confirmNode(run, nodeId, nodeIndex, attempts, sessionId, verdict.reason);
  }

  #retryOrFail(
    run: ActiveRun,
    nodeId: string,
    nodeIndex: number,
    attempts: number,
    sessionId: string,
    reason: string,
  ): void {
    const node = run.definition.nodes[nodeIndex];
    if (node === undefined) return;
    if (attempts < node.condition.maxRetries) {
      const backoff = Math.min(node.condition.backoffMs * 2 ** attempts, this.#backoffCeilingMs);
      this.#reportNodeStatus(this.#runIdOf(run), nodeId, nodeIndex, "starting", attempts + 1, sessionId, `retry:${reason}`);
      setTimeout(() => {
        void this.#startNode(run, nodeIndex, attempts + 1);
      }, backoff).unref();
      return;
    }
    this.#failNode(run, reason);
  }

  #confirmNode(
    run: ActiveRun,
    nodeId: string,
    nodeIndex: number,
    attempts: number,
    sessionId: string | undefined,
    _checkSummary: string,
  ): void {
    if (run.cancelled) return;
    run.node.status = "completed";
    this.#reportNodeStatus(this.#runIdOf(run), nodeId, nodeIndex, "completed", attempts, sessionId);
    const nextIndex = nodeIndex + 1;
    this.#journal.upsert({
      runId: this.#runIdOf(run),
      definition: run.definition,
      currentNodeIndex: nodeIndex,
      nodeStatus: "completed",
      attempts,
      sessionId: sessionId ?? null,
    });
    if (nextIndex >= run.definition.nodes.length) {
      void this.#finishRun(run, "completed");
      return;
    }
    // Hand-off text lives only in memory: finalMessage feeds the next
    // node's template rendering and is never reported or persisted.
    void this.#startNode(run, nextIndex, 0);
  }

  #failNode(run: ActiveRun, reason: string): void {
    if (!this.#activeRuns.has(run.runId)) return; // already finished (e.g. cancelled)
    const node = run.definition.nodes[run.nodeIndex];
    const nodeStatus: WorkflowNodeRunStatus = "failed";
    if (node !== undefined) {
      this.#reportNodeStatus(
        this.#runIdOf(run),
        node.id,
        run.nodeIndex,
        nodeStatus,
        run.node.attempts,
        run.node.sessionId,
        reason,
      );
    }
    void this.#finishRun(run, "failed", reason);
  }

  async #finishRun(run: ActiveRun, status: WorkflowRunStatus, reasonCode?: string): Promise<void> {
    if (status !== "running" && !this.#activeRuns.has(run.runId)) return;
    run.status = status;
    this.#reportRunStatus(run, status, reasonCode);
    const runId = this.#runIdOf(run);
    this.#journal.remove(runId);
    this.#activeRuns.delete(runId);
    for (const sessionId of [...this.#transcript.keys()]) {
      if (this.#nodeSessions.has(sessionId)) {
        this.#transcript.delete(sessionId);
        this.#nodeSessions.delete(sessionId);
      }
    }
  }

  #reportRunStatus(run: ActiveRun, status: WorkflowRunStatus, reasonCode?: string): void {
    const payload: ConnectorPayload = {
      type: "workflow.run.status",
      runId: this.#runIdOf(run),
      status,
      ...(reasonCode === undefined ? {} : { reasonCode }),
    };
    this.#sink().send(payload, `wf-run:${this.#runIdOf(run)}:${status}`);
  }

  #reportNodeStatus(
    runId: string,
    nodeId: string,
    index: number,
    status: WorkflowNodeRunStatus,
    attempts: number,
    sessionId?: string,
    reasonCode?: string,
  ): void {
    const payload: ConnectorPayload = {
      type: "workflow.node.status",
      runId,
      nodeId,
      index,
      status,
      attempts,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(reasonCode === undefined ? {} : { reasonCode }),
    };
    this.#sink().send(payload, `wf-node:${runId}:${nodeId}:${status}:${attempts}:${reasonCode ?? ""}`);
  }

  #sink(): AgentEventSinkLike {
    return this.#cloud;
  }

  #handleEphemeral(message: ConnectorSessionStreamMessage): void {
    if (message.type !== "session.stream.frame" || typeof message.threadId !== "string") return;
    const sessionId = message.threadId;
    const frame = message.frame;
    if (frame === undefined) return;
    // Privacy boundary: only node sessions created by this engine are
    // observed. During startSession the owning session is unknown until the
    // call returns, so frames are buffered and promoted (or discarded) after.
    if (!this.#nodeSessions.has(sessionId)) {
      if (this.#startInFlight > 0) {
        const buffered = this.#startBuffer.get(sessionId) ?? [];
        buffered.push(message);
        this.#startBuffer.set(sessionId, buffered);
      }
      return;
    }
    if (frame.kind === "turn.status" && (frame.status === "completed" || frame.status === "failed" || frame.status === "interrupted")) {
      const waiters = this.#turnWaiters.get(sessionId);
      if (waiters !== undefined) {
        this.#turnWaiters.delete(sessionId);
        const status = frame.status as "completed" | "failed" | "interrupted";
        for (const waiter of waiters) waiter(status);
      }
      return;
    }
    if (frame.kind === "message.delta" && typeof frame.delta === "string" && typeof frame.messageId === "string") {
      const transcript = this.#transcript.get(sessionId);
      if (transcript !== undefined) transcript.text += frame.delta;
      return;
    }
    if (frame.kind === "message.complete") {
      const transcript = this.#transcript.get(sessionId);
      if (transcript !== undefined && transcript.text.length > 0) {
        transcript.last = transcript.text;
      }
    }
  }

  #handleOnline(online: boolean): void {
    for (const [, run] of this.#activeRuns) {
      if (run.cancelled) continue;
      if (!online && run.node.status === "running") {
        run.node.status = "blocked_offline";
        this.#reportNodeStatus(
          this.#runIdOf(run),
          run.definition.nodes[run.nodeIndex]?.id ?? "",
          run.nodeIndex,
          "blocked_offline",
          run.node.attempts,
          run.node.sessionId,
          "workstation_offline",
        );
      }
      // Reconnect: the in-flight turn died with the connection; the node is
      // interrupted and re-dispatched per its retry policy (fail-closed —
      // the turn's outcome is unknown, never assumed complete).
      if (online && run.node.status === "blocked_offline") {
        run.node.status = "interrupted";
        const sessionId = run.node.sessionId;
        if (sessionId !== undefined) {
          const waiters = this.#turnWaiters.get(sessionId);
          if (waiters !== undefined) {
            this.#turnWaiters.delete(sessionId);
            for (const waiter of waiters) waiter("interrupted");
          }
        }
      }
    }
  }
}

interface AgentEventSinkLike {
  send(payload: ConnectorPayload, idempotencyKey?: string): void;
}

function assertOptionsInCatalogue(
  agentKind: string,
  model: string | undefined,
  effort: import("@yurupager/shared").WorkflowReasoningEffort | undefined,
  models: Array<{ id: string; reasoningEfforts: import("@yurupager/shared").WorkflowReasoningEffort[] }>,
): void {
  if (model === undefined && effort === undefined) return;
  if (models.length === 0) {
    throw new Error(`agent ${agentKind} exposes no model catalogue (ADR-034)`);
  }
  if (model !== undefined && !models.some((candidate) => candidate.id === model)) {
    throw new Error(`model ${model} is not available for agent ${agentKind}`);
  }
  if (effort !== undefined && model !== undefined) {
    const entry = models.find((candidate) => candidate.id === model);
    if (entry !== undefined && !entry.reasoningEfforts.includes(effort)) {
      throw new Error(`effort ${effort} is not available for model ${model}`);
    }
  }
}
