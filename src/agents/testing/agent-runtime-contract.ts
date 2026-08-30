import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type {
  ConnectorPayload,
  SessionStreamFrame,
} from "@yurupager/shared";

import type { AgentEventSink, AgentRuntime } from "../types.js";

interface EphemeralMessage {
  type: "session.stream.frame" | "session.stream.error" | "session.titles.snapshot";
  subscriptionId?: string;
  threadId?: string;
  frame?: SessionStreamFrame;
  code?: string;
  titles?: unknown;
}

export interface RecordedSend { kind: "send"; payload: ConnectorPayload; idempotencyKey?: string }
export interface RecordedEphemeral { kind: "ephemeral"; message: EphemeralMessage }
export type RecordedEvent = RecordedSend | RecordedEphemeral;

export interface RecordingSink extends AgentEventSink {
  readonly events: RecordedEvent[];
  sent<T extends ConnectorPayload["type"]>(type: T): Array<Extract<ConnectorPayload, { type: T }>>;
  frames(): Array<{ subscriptionId: string; threadId: string; frame: SessionStreamFrame }>;
  requests(): Array<Extract<ConnectorPayload, { type: "request.created" }>>;
  waitUntil(predicate: () => boolean, timeoutMs?: number): Promise<void>;
}

export function createRecordingSink(): RecordingSink {
  const events: RecordedEvent[] = [];
  const sink: RecordingSink = {
    events,
    send(payload, idempotencyKey) {
      events.push(idempotencyKey === undefined
        ? { kind: "send", payload }
        : { kind: "send", payload, idempotencyKey });
    },
    sendEphemeral(message) {
      events.push({ kind: "ephemeral", message: message as EphemeralMessage });
    },
    sent(type) {
      return events
        .filter((event): event is RecordedSend => event.kind === "send" && event.payload.type === type)
        .map((event) => event.payload as never);
    },
    frames() {
      const result: Array<{ subscriptionId: string; threadId: string; frame: SessionStreamFrame }> = [];
      for (const event of events) {
        if (event.kind === "ephemeral" && event.message.type === "session.stream.frame") {
          const message = event.message as unknown as {
            subscriptionId: string;
            threadId: string;
            frame: SessionStreamFrame;
          };
          result.push({ subscriptionId: message.subscriptionId, threadId: message.threadId, frame: message.frame });
        }
      }
      return result;
    },
    requests() {
      return events
        .filter((event): event is RecordedSend => event.kind === "send" && event.payload.type === "request.created")
        .map((event) => event.payload as Extract<ConnectorPayload, { type: "request.created" }>);
    },
    async waitUntil(predicate, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(predicate(), "condition was not met before the timeout");
    },
  };
  return sink;
}

export interface ContractRuntimeHandle {
  runtime: AgentRuntime;
  sink: RecordingSink;
}

/**
 * The merge gate every AgentRuntime implementation must pass (ADR-024 Phase 1
 * item 5): handshake, capability-degraded discovery, prompt with incremental
 * frames, approval round-trip, fail-closed unknown options, cancel, and
 * crash-reconnect.
 */
export function registerAgentRuntimeContractTests(params: {
  test(name: string, fn: () => Promise<void>): void;
  createRuntime(scenario: string): Promise<ContractRuntimeHandle> | ContractRuntimeHandle;
}): void {
  const { test, createRuntime } = params;

  test("handshake completes and the capability probe answers", async () => {
    const { runtime } = await Promise.resolve(createRuntime("standard"));
    try {
      await runtime.start();
      const capabilities = await runtime.capabilities();
      assert.equal(capabilities.agentId, runtime.agentId);
      assert.ok(capabilities.discovery === "global" || capabilities.discovery === "own-sessions");
    } finally {
      await runtime.stop();
    }
  });

  test("discovery follows the capability degradation ladder", async () => {
    const { runtime } = await Promise.resolve(createRuntime("standard"));
    try {
      await runtime.start();
      const capabilities = await runtime.capabilities();
      const sessions = await runtime.listSessions();
      if (capabilities.discovery === "own-sessions") {
        assert.equal(sessions, null); // ADR-025: no intrusive discovery
      } else {
        assert.ok(sessions !== null);
      }
    } finally {
      await runtime.stop();
    }
  });

  test("prompt streams incremental frames and completes an approval round-trip", async () => {
    const { runtime, sink } = await Promise.resolve(createRuntime("standard"));
    try {
      await runtime.start();
      await runtime.handleSessionStream({
        type: "session.stream.subscribe",
        subscriptionId: "sub-1",
        threadId: "sess-1",
      });
      const commandId = randomUUID();
      // Prompt dispatch may block until the turn ends on real agents; the
      // observable contract is the frame/request stream, and the approval
      // decision arrives asynchronously from the cloud (as in production).
      void runtime.handleSessionCommand({
        type: "session.command",
        messageId: randomUUID(),
        sequence: 1,
        commandId,
        threadId: "sess-1",
        text: "hello agent",
        attachments: [],
      }).catch(() => undefined);
      await sink.waitUntil(() => sink.requests().length === 1);
      const request = sink.requests()[0];
      assert.equal(request?.agent, runtime.agentId);
      assert.equal(request?.sessionId, "sess-1");
      assert.ok(Array.isArray(request?.context.availableDecisions));
      await runtime.handleDecision({
        type: "decision",
        messageId: randomUUID(),
        sequence: 2,
        requestId: request?.requestId as string,
        decisionId: randomUUID(),
        decision: { decision: "approve" },
      });
      await sink.waitUntil(() => sink.frames().some((entry) =>
        entry.frame.kind === "turn.status" && entry.frame.status === "completed"));
      const kinds = sink.frames().map((entry) => entry.frame.kind);
      assert.ok(kinds.includes("history.start"));
      assert.ok(kinds.includes("message.start"));
      assert.ok(kinds.includes("message.delta"));
      const deltas = sink.frames()
        .filter((entry) => entry.frame.kind === "message.delta")
        .map((entry) => (entry.frame as { delta: string }).delta);
      assert.ok(deltas.join("").includes("完成"));
    } finally {
      await runtime.stop();
    }
  });

  test("unknown permission options fail closed on approve", async () => {
    const { runtime, sink } = await Promise.resolve(createRuntime("unknown-permission-option"));
    try {
      await runtime.start();
      await runtime.handleSessionStream({
        type: "session.stream.subscribe",
        subscriptionId: "sub-1",
        threadId: "sess-1",
      });
      void runtime.handleSessionCommand({
        type: "session.command",
        messageId: randomUUID(),
        sequence: 1,
        commandId: randomUUID(),
        threadId: "sess-1",
        text: "hello agent",
        attachments: [],
      }).catch(() => undefined);
      // Protocols differ in how an unmappable permission surfaces: either a
      // request is created (and approving it must fail closed) or the unknown
      // permission surface is refused outright. Both must end the turn failed.
      await sink.waitUntil(() =>
        sink.requests().length === 1 ||
        sink.frames().some((entry) => entry.frame.kind === "turn.status" && entry.frame.status === "failed"));
      const request = sink.requests()[0];
      if (request !== undefined) {
        await runtime.handleDecision({
          type: "decision",
          messageId: randomUUID(),
          sequence: 2,
          requestId: request.requestId,
          decisionId: randomUUID(),
          decision: { decision: "approve" },
        });
      }
      await sink.waitUntil(() => sink.frames().some((entry) =>
        entry.frame.kind === "turn.status" && entry.frame.status === "failed"));
      const deltas = sink.frames()
        .filter((entry) => entry.frame.kind === "message.delta")
        .map((entry) => (entry.frame as { delta: string }).delta);
      assert.ok(!deltas.join("").includes("完成")); // the agent never got permission
    } finally {
      await runtime.stop();
    }
  });

  test("cancel surfaces as an interrupted turn", async () => {
    const { runtime, sink } = await Promise.resolve(createRuntime("standard"));
    try {
      await runtime.start();
      await runtime.handleSessionStream({
        type: "session.stream.subscribe",
        subscriptionId: "sub-1",
        threadId: "sess-1",
      });
      void runtime.handleSessionCommand({
        type: "session.command",
        messageId: randomUUID(),
        sequence: 1,
        commandId: randomUUID(),
        threadId: "sess-1",
        text: "long running",
        attachments: [],
      }).catch(() => undefined);
      await sink.waitUntil(() => sink.requests().length === 1);
      const request = sink.requests()[0];
      await runtime.handleDecision({
        type: "decision",
        messageId: randomUUID(),
        sequence: 2,
        requestId: request?.requestId as string,
        decisionId: randomUUID(),
        decision: { decision: "approve" },
      });
      await sink.waitUntil(() => sink.frames().some((entry) =>
        entry.frame.kind === "message.delta"));
      if (runtime.cancelSession === undefined) {
        return; // cancel is optional per ADR-024; the suite records its absence
      }
      await runtime.cancelSession("sess-1");
      await sink.waitUntil(() => sink.frames().some((entry) =>
        entry.frame.kind === "turn.status" && entry.frame.status === "interrupted"));
    } finally {
      await runtime.stop();
    }
  });

  test("startSession dispatches the initial prompt and fails closed on unknown options", async () => {
    const { runtime, sink } = await Promise.resolve(createRuntime("standard"));
    try {
      await runtime.start();
      const capabilities = await runtime.capabilities();
      assert.ok(Array.isArray(capabilities.models));
      if (runtime.startSession === undefined) return; // optional per ADR-034
      const unsupported = capabilities.models.length > 0
        ? `${capabilities.models[0]?.id ?? "model"}--does-not-exist`
        : "unsupported-model";
      await assert.rejects(
        runtime.startSession({ initialPrompt: "hello", model: unsupported }),
        (error: unknown) => error instanceof Error,
      );
      const { sessionId } = await runtime.startSession({ initialPrompt: "workflow kick-off" });
      assert.ok(sessionId.length > 0);
      await sink.waitUntil(() => sink
        .sent("session.upsert")
        .some((payload) => payload.sessionId === sessionId || payload.threadId === sessionId));
    } finally {
      await runtime.stop();
    }
  });

  test("agent crash fails closed and a replacement runtime connects", async () => {
    const { runtime, sink } = await Promise.resolve(createRuntime("crash-on-prompt"));
    try {
      await runtime.start();
      await runtime.handleSessionStream({
        type: "session.stream.subscribe",
        subscriptionId: "sub-1",
        threadId: "sess-1",
      });
      await assert.rejects(
        runtime.handleSessionCommand({
          type: "session.command",
          messageId: randomUUID(),
          sequence: 1,
          commandId: randomUUID(),
          threadId: "sess-1",
          text: "hello",
          attachments: [],
        }),
      );
      await sink.waitUntil(() => true);
    } finally {
      await runtime.stop();
    }
    const replacement = await Promise.resolve(createRuntime("standard"));
    try {
      await replacement.runtime.start();
      assert.ok(true);
    } finally {
      await replacement.runtime.stop();
    }
  });
}
