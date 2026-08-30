import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  ConnectorPayload,
  ConnectorSessionStreamMessage,
  WorkflowDefinitionSnapshot,
  WorkflowModelOption,
} from "@yurupager/shared";

import type { AgentEventSink, AgentRuntime, AgentStartSessionOptions } from "../src/agents/types.js";
import type { ConnectorCloudClient, RemoteSessionCommand, RemoteSessionStreamControl } from "../src/transport/connector-cloud-client.js";
import { WorkflowEngine } from "../src/workflow/engine.js";

interface RecordedEvent { kind: "send"; payload: ConnectorPayload; idempotencyKey?: string }

class RecordingCloud {
  readonly events: RecordedEvent[] = [];
  readonly ephemeral: ConnectorSessionStreamMessage[] = [];
  readonly statusListeners = new Set<(online: boolean) => void>();
  readonly frameListeners = new Set<(message: ConnectorSessionStreamMessage) => void>();

  send(payload: ConnectorPayload, idempotencyKey?: string): void {
    this.events.push(idempotencyKey === undefined ? { kind: "send", payload } : { kind: "send", payload, idempotencyKey });
  }

  sendEphemeral(message: ConnectorSessionStreamMessage): void {
    this.ephemeral.push(message);
    for (const listener of this.frameListeners) listener(message);
  }

  onEphemeralMessage(listener: (message: ConnectorSessionStreamMessage) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onStatus(listener: (online: boolean) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  runStatuses(): Array<{ runId: string; status: string; reasonCode?: string }> {
    return this.events
      .filter((event) => event.payload.type === "workflow.run.status")
      .map((event) => {
        const payload = event.payload as { runId: string; status: string; reasonCode?: string };
        return payload.reasonCode === undefined
          ? { runId: payload.runId, status: payload.status }
          : { runId: payload.runId, status: payload.status, reasonCode: payload.reasonCode };
      });
  }

  nodeStatuses(): Array<{ nodeId: string; status: string; attempts: number; reasonCode?: string }> {
    return this.events
      .filter((event) => event.payload.type === "workflow.node.status")
      .map((event) => {
        const payload = event.payload as { nodeId: string; status: string; attempts: number; reasonCode?: string };
        return payload.reasonCode === undefined
          ? { nodeId: payload.nodeId, status: payload.status, attempts: payload.attempts }
          : { nodeId: payload.nodeId, status: payload.status, attempts: payload.attempts, reasonCode: payload.reasonCode };
      });
  }

  gateRequests(): Array<{ requestId: string; kind: string }> {
    return this.events
      .filter((event) => event.payload.type === "request.created")
      .map((event) => {
        const payload = event.payload as { requestId: string; kind: string };
        return { requestId: payload.requestId, kind: payload.kind };
      });
  }
}

class FakeWorkflowRuntime implements AgentRuntime {
  readonly agentId: string;
  models: WorkflowModelOption[];
  readonly prompts: string[] = [];
  readonly startedSessions: string[] = [];
  verifyReplies: string[] = [];
  hangTurns = false;
  #sink: AgentEventSink | undefined;
  #counter = 0;
  failStartSession = false;

  constructor(agentId: string, models: WorkflowModelOption[] = []) {
    this.agentId = agentId;
    this.models = models;
  }

  attach(sink: AgentEventSink): void {
    this.#sink = sink;
  }

  async capabilities() {
    return {
      agentId: this.agentId,
      displayName: this.agentId,
      discovery: "own-sessions" as const,
      questions: false,
      usageReporting: true,
      imageAttachments: false,
      models: this.models,
    };
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async listSessions(): Promise<null> { return null; }
  async handleDecision(): Promise<void> {}

  handleSessionStream(_control: RemoteSessionStreamControl): Promise<void> { return Promise.resolve(); }
  handleCloudOnline(): void {}

  async handleSessionCommand(remote: RemoteSessionCommand): Promise<void> {
    this.prompts.push(remote.text);
    const reply = remote.text.startsWith("Self-check request") || remote.text.startsWith("Verification request")
      ? (this.verifyReplies.shift() ?? "FAIL - no scripted reply")
      : null;
    this.#emitAssistant(remote.threadId, reply ?? "(work summary)");
    this.#emitTurn(remote.threadId, "completed");
  }

  async startSession(options: AgentStartSessionOptions): Promise<{ sessionId: string }> {
    if (this.failStartSession) throw new Error("session creation unsupported");
    if (options.model !== undefined && !this.models.some((model) => model.id === options.model)) {
      throw new Error(`Model ${options.model} is not available for agent ${this.agentId}`);
    }
    const sessionId = `sess-${++this.#counter}`;
    this.startedSessions.push(sessionId);
    this.prompts.push(options.initialPrompt);
    this.#emitAssistant(sessionId, "任务完成摘要 work summary");
    if (!this.hangTurns) setTimeout(() => this.#emitTurn(sessionId, "completed"), 5);
    return { sessionId };
  }

  #emitAssistant(sessionId: string, text: string): void {
    const messageId = `m-${this.#counter}-${this.prompts.length}`;
    this.#sink?.sendEphemeral({
      type: "session.stream.frame",
      subscriptionId: sessionId,
      threadId: sessionId,
      frame: { kind: "message.start", messageId, turnId: "t1", role: "assistant" },
    });
    this.#sink?.sendEphemeral({
      type: "session.stream.frame",
      subscriptionId: sessionId,
      threadId: sessionId,
      frame: { kind: "message.delta", messageId, delta: text },
    });
    this.#sink?.sendEphemeral({
      type: "session.stream.frame",
      subscriptionId: sessionId,
      threadId: sessionId,
      frame: { kind: "message.complete", messageId },
    });
  }

  #emitTurn(sessionId: string, status: "completed" | "failed" | "interrupted"): void {
    if (this.hangTurns) return;
    setTimeout(() => {
      this.#sink?.sendEphemeral({
        type: "session.stream.frame",
        subscriptionId: sessionId,
        threadId: sessionId,
        frame: { kind: "turn.status", turnId: "t1", status },
      });
    }, 5);
  }
}

function definition(overrides?: {
  condition?: Partial<WorkflowDefinitionSnapshot["nodes"][number]["condition"]>;
  turnBudget?: number;
  model?: string;
  secondNode?: boolean;
}): WorkflowDefinitionSnapshot {
  const nodes: WorkflowDefinitionSnapshot["nodes"] = [{
    id: "node-1",
    agentKind: "fake",
    ...(overrides?.model === undefined ? {} : { model: overrides.model }),
    task: "Build the thing for {{workflow.goal}}",
    handoffPrompt: "Previous final message: {{prev.finalMessage}}",
    condition: { kind: "agent_confirm", maxRetries: 1, backoffMs: 5, ...(overrides?.condition ?? {}) },
    turnBudget: overrides?.turnBudget ?? 5,
    timeoutMs: 10_000,
  }];
  if (overrides?.secondNode === true) {
    nodes.push({
      id: "node-2",
      agentKind: "fake",
      task: "Review: {{prev.finalMessage}} / {{prev.checkSummary}}",
      condition: { kind: "agent_confirm", maxRetries: 0, backoffMs: 5 },
      turnBudget: 5,
      timeoutMs: 10_000,
    });
  }
  return {
    version: 1,
    workflowId: "wf-1",
    goal: "the goal",
    workstationId: "30000000-0000-4000-8000-000000000001",
    nodes,
  };
}

function makeEngine(): {
  engine: WorkflowEngine;
  cloud: RecordingCloud;
  runtime: FakeWorkflowRuntime;
  journalDir: string;
} {
  const cloud = new RecordingCloud();
  const runtime: FakeWorkflowRuntime = new FakeWorkflowRuntime("fake");
  const journalDir = mkdtempSync(join(tmpdir(), "wf-engine-"));
  const engine = new WorkflowEngine({
    cloud: cloud as unknown as ConnectorCloudClient,
    resolveRuntime: (agentKind) => (agentKind === "fake" ? (runtime as FakeWorkflowRuntime) : undefined),
    journalPath: join(journalDir, "wf.sqlite"),
  });
  runtime.attach(cloud as unknown as AgentEventSink);
  engine.start();
  return { engine, cloud, runtime, journalDir };
}

test("single agent_confirm node completes and reports the full status chain", async () => {
  const { engine, cloud, runtime, journalDir } = makeEngine();
  try {
    runtime.verifyReplies.push("PASS - everything checks out");
    engine.dispatchRun(definition(), "run-1");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const statuses = cloud.runStatuses().filter((entry) => entry.runId === "run-1");
    assert.deepEqual(statuses.map((entry) => entry.status), ["running", "completed"]);
    const nodeStatuses = cloud.nodeStatuses().filter((entry) => entry.nodeId === "node-1");
    assert.ok(nodeStatuses.some((entry) => entry.status === "starting"));
    assert.ok(nodeStatuses.some((entry) => entry.status === "running"));
    assert.ok(nodeStatuses.some((entry) => entry.status === "verifying"));
    assert.ok(nodeStatuses.some((entry) => entry.status === "completed"));
    assert.ok(runtime.prompts.some((prompt) => prompt.includes("Build the thing for the goal")));
    assert.ok(runtime.prompts.some((prompt) => prompt.startsWith("Self-check request")));
  } finally {
    engine.stop();
    rmSync(journalDir, { recursive: true, force: true });
  }
});

test("hand-off renders prev.finalMessage and prev.checkSummary into the next node", async () => {
  const { engine, runtime, journalDir } = makeEngine();
  try {
    runtime.verifyReplies.push("PASS - checks pass", "PASS - review done");
    engine.dispatchRun(definition({ secondNode: true }), "run-2");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const reviewPrompt = runtime.prompts.find((prompt) => prompt.startsWith("Review:"));
    assert.ok(reviewPrompt !== undefined, "second node prompt expected");
    assert.ok(reviewPrompt.includes("任务完成摘要 work summary"), "prev.finalMessage rendered");
    assert.ok(reviewPrompt.includes("PASS - checks pass"), "prev.checkSummary rendered");
    assert.ok(reviewPrompt.includes("Previous final message:"), "handoff template rendered");
  } finally {
    engine.stop();
    rmSync(journalDir, { recursive: true, force: true });
  }
});

test("criteria_check failure retries before passing", async () => {
  const { engine, cloud, runtime, journalDir } = makeEngine();
  try {
    runtime.verifyReplies.push("FAIL - tests red", "PASS - green now");
    engine.dispatchRun(definition({
      condition: { kind: "criteria_check", criteriaText: "tests green", maxRetries: 1, backoffMs: 5 },
    }), "run-3");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const attempts = cloud.nodeStatuses().filter((entry) => entry.nodeId === "node-1" && (entry.status === "starting" || entry.status === "running"));
    assert.ok(attempts.some((entry) => entry.attempts === 1), "first attempt recorded");
    assert.ok(attempts.some((entry) => entry.attempts === 1), "retry attempt recorded");
    assert.equal(runtime.prompts.filter((prompt) => prompt.startsWith("Verification request")).length, 2);
    assert.ok(cloud.runStatuses().some((entry) => entry.runId === "run-3" && entry.status === "completed"));
  } finally {
    engine.stop();
    rmSync(journalDir, { recursive: true, force: true });
  }
});

test("exhausted retries fail the node and the run", async () => {
  const { engine, cloud, runtime, journalDir } = makeEngine();
  try {
    runtime.verifyReplies.push("FAIL - still red", "FAIL - ignored");
    engine.dispatchRun(definition({
      condition: { kind: "criteria_check", criteriaText: "green", maxRetries: 0, backoffMs: 5 },
    }), "run-4");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(cloud.runStatuses().some((entry) => entry.runId === "run-4" && entry.status === "failed"));
    const failed = cloud.nodeStatuses().find((entry) => entry.nodeId === "node-1" && entry.status === "failed");
    assert.ok(failed?.reasonCode?.startsWith("check_failed"));
  } finally {
    engine.stop();
    rmSync(journalDir, { recursive: true, force: true });
  }
});

test("manual_gate approve completes the node; deny fails it", async () => {
  const { engine, cloud, journalDir } = makeEngine();
  try {
    engine.dispatchRun(definition({
      condition: { kind: "manual_gate", maxRetries: 0, backoffMs: 5 },
    }), "run-5");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const gates = cloud.gateRequests();
    assert.equal(gates.length, 1);
    assert.equal(gates[0]?.kind, "workflow_gate");
    assert.ok(cloud.nodeStatuses().some((entry) => entry.nodeId === "node-1" && entry.status === "waiting_approval"));
    assert.ok(engine.handleGateDecision({ requestId: gates[0]?.requestId as string, decision: "approve" }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(cloud.runStatuses().some((entry) => entry.runId === "run-5" && entry.status === "completed"));
  } finally {
    engine.stop();
    rmSync(journalDir, { recursive: true, force: true });
  }

  const denied = makeEngine();
  try {
    denied.engine.dispatchRun(definition({
      condition: { kind: "manual_gate", maxRetries: 0, backoffMs: 5 },
    }), "run-5b");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const gates = denied.cloud.gateRequests();
    assert.ok(denied.engine.handleGateDecision({ requestId: gates[0]?.requestId as string, decision: "deny" }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const failedNode = denied.cloud.nodeStatuses().find((entry) => entry.nodeId === "node-1" && entry.status === "failed");
    assert.equal(failedNode?.reasonCode, "gate_denied");
    assert.ok(denied.cloud.runStatuses().some((entry) => entry.runId === "run-5b" && entry.status === "failed"));
  } finally {
    denied.engine.stop();
    rmSync(denied.journalDir, { recursive: true, force: true });
  }
});

test("turn budget exhaustion fails the node", async () => {
  const { engine, cloud, journalDir } = makeEngine();
  try {
    engine.dispatchRun(definition({ turnBudget: 1 }), "run-6");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const failed = cloud.nodeStatuses().find((entry) => entry.nodeId === "node-1" && entry.status === "failed");
    assert.equal(failed?.reasonCode, "turn_budget_exhausted");
  } finally {
    engine.stop();
    rmSync(journalDir, { recursive: true, force: true });
  }
});

test("crash recovery marks the node interrupted and re-dispatches", async () => {
  const journalDir = mkdtempSync(join(tmpdir(), "wf-crash-"));
  const journalPath = join(journalDir, "wf.sqlite");
  const cloud1 = new RecordingCloud();
  const runtime1 = new FakeWorkflowRuntime("fake");
  const first = {
    engine: new WorkflowEngine({
      cloud: cloud1 as unknown as ConnectorCloudClient,
      resolveRuntime: (agentKind) => (agentKind === "fake" ? runtime1 : undefined),
      journalPath,
    }),
    runtime: runtime1,
  };
  runtime1.attach(cloud1 as unknown as AgentEventSink);
  try {
    first.runtime.hangTurns = true;
    first.engine.dispatchRun(definition({ condition: { kind: "criteria_check", criteriaText: "green", maxRetries: 1, backoffMs: 5 } }), "run-7");
    await new Promise((resolve) => setTimeout(resolve, 80));
    first.engine.stop(); // simulated crash: the run was in flight
    // Second engine over the same journal: the run must be recovered.
    const cloud2 = new RecordingCloud();
    const runtime2 = new FakeWorkflowRuntime("fake");
    runtime2.verifyReplies.push("PASS - recovered");
    const engine2 = new WorkflowEngine({
      cloud: cloud2 as unknown as ConnectorCloudClient,
      resolveRuntime: (agentKind) => (agentKind === "fake" ? (runtime2 as FakeWorkflowRuntime) : undefined),
      journalPath,
    });
    runtime2.attach(cloud2 as unknown as AgentEventSink);
    engine2.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const interrupted = cloud2.nodeStatuses().find((entry) => entry.status === "interrupted");
    assert.ok(interrupted !== undefined, "interrupted status reported after recovery");
    assert.equal(interrupted?.reasonCode, "connector_restarted");
    assert.ok(cloud2.runStatuses().some((entry) => entry.runId === "run-7" && entry.status === "completed"));
    assert.ok(runtime2.prompts.some((prompt) => prompt.startsWith("Build the thing")));
    engine2.stop();
  } finally {
    rmSync(journalDir, { recursive: true, force: true });
  }
});

test("workstation offline blocks the node; reconnect interrupts and re-dispatches", async () => {
  const journalDir = mkdtempSync(join(tmpdir(), "wf-offline-"));
  const journalPath = join(journalDir, "wf.sqlite");
  const cloud = new RecordingCloud();
  const runtime = new FakeWorkflowRuntime("fake");
  const engine = new WorkflowEngine({
    cloud: cloud as unknown as ConnectorCloudClient,
    resolveRuntime: (agentKind) => (agentKind === "fake" ? (runtime as FakeWorkflowRuntime) : undefined),
    journalPath,
  });
  runtime.attach(cloud as unknown as AgentEventSink);
  runtime.verifyReplies.push("PASS - green after recovery");
  runtime.hangTurns = true;
  engine.start();
  try {
    engine.dispatchRun(definition({ condition: { kind: "criteria_check", criteriaText: "green", maxRetries: 1, backoffMs: 5 } }), "run-8");
    await new Promise((resolve) => setTimeout(resolve, 80));
    for (const listener of cloud.statusListeners) listener(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(cloud.nodeStatuses().some((entry) => entry.status === "blocked_offline" && entry.reasonCode === "workstation_offline"));
    runtime.hangTurns = false;
    for (const listener of cloud.statusListeners) listener(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(cloud.nodeStatuses().some((entry) => entry.status === "interrupted" || (entry.status === "starting" && entry.attempts >= 1)));
    assert.ok(cloud.runStatuses().some((entry) => entry.runId === "run-8" && entry.status === "completed"));
  } finally {
    engine.stop();
    rmSync(journalDir, { recursive: true, force: true });
  }
});

test("models outside the capability catalogue fail the node closed", async () => {
  const { engine, cloud, runtime, journalDir } = makeEngine();
  try {
    engine.dispatchRun(definition({ model: "ghost-model" }), "run-9");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const failed = cloud.nodeStatuses().find((entry) => entry.nodeId === "node-1" && entry.status === "failed");
    assert.ok(failed?.reasonCode?.startsWith("model_unavailable"));
    assert.equal(runtime.startedSessions.length, 0);
  } finally {
    engine.stop();
    rmSync(journalDir, { recursive: true, force: true });
  }
});

test("cancel stops an in-flight run", async () => {
  const { engine, cloud, runtime, journalDir } = makeEngine();
  try {
    runtime.hangTurns = true;
    engine.dispatchRun(definition(), "run-10");
    await new Promise((resolve) => setTimeout(resolve, 60));
    engine.cancelRun("run-10", "user_requested");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(cloud.runStatuses().some((entry) => entry.runId === "run-10" && entry.status === "cancelled"));
  } finally {
    engine.stop();
    rmSync(journalDir, { recursive: true, force: true });
  }
});
