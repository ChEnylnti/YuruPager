import assert from "node:assert/strict";
import { test } from "node:test";

import { CursorAgentRuntime } from "../src/agents/cursor/cursor-agent-runtime.js";
import {
  createRecordingSink,
  registerAgentRuntimeContractTests,
} from "../src/agents/testing/agent-runtime-contract.js";

registerAgentRuntimeContractTests({
  test: (name, fn) => test(name, fn),
  createRuntime: (scenario) => {
    const sink = createRecordingSink();
    const runtime = new CursorAgentRuntime({
      command: process.execPath,
      args: [new URL("../src/agents/testing/fake-cursor-agent.js", import.meta.url).pathname, "--scenario", scenario],
      projectName: "Cursor Contract Suite",
      projectPath: process.cwd(),
      initTimeoutMs: 10_000,
    });
    runtime.attach(sink);
    return { runtime, sink };
  },
});

test("Cursor usage accumulates into cumulative snapshots with the cursor provider", async () => {
  const sink = createRecordingSink();
  const runtime = new CursorAgentRuntime({
    command: process.execPath,
    args: [new URL("../src/agents/testing/fake-cursor-agent.js", import.meta.url).pathname, "--scenario", "standard"],
    projectName: "Cursor Usage Suite",
    projectPath: process.cwd(),
    initTimeoutMs: 10_000,
  });
  runtime.attach(sink);
  try {
    await runtime.start();
    await runtime.handleSessionStream({
      type: "session.stream.subscribe",
      subscriptionId: "sub-usage",
      threadId: "sess-usage",
    });
    void runtime.handleSessionCommand({
      type: "session.command",
      messageId: "msg-usage-1",
      sequence: 1,
      commandId: "2b2b2b2b-usagetest",
      threadId: "sess-usage",
      text: "usage probe",
      attachments: [],
    }).catch(() => undefined);
    await sink.waitUntil(() => sink.requests().length === 1);
    await runtime.handleDecision({
      type: "decision",
      messageId: "decision-usage-1",
      sequence: 2,
      requestId: sink.requests()[0]?.requestId as string,
      decisionId: "decision-usage-1",
      decision: { decision: "approve" },
    });
    await sink.waitUntil(() => sink.frames().some((entry) =>
      entry.frame.kind === "turn.status" && entry.frame.status === "completed"));
    const snapshots = sink.sent("token.snapshot");
    assert.equal(snapshots.length, 1);
    const snapshot = snapshots[0] as { sequence: number; provider: string; totalTokens: number; agent?: string; sessionId?: string };
    assert.equal(snapshot.provider, "cursor");
    assert.equal(snapshot.agent, "cursor");
    assert.equal(snapshot.sequence, 1);
    assert.equal(snapshot.totalTokens, 1280);
    assert.equal(snapshot.sessionId, "sess-usage");
  } finally {
    await runtime.stop();
  }
});

test("Cursor raw tool input never reaches frames or payloads", async () => {
  const sink = createRecordingSink();
  const runtime = new CursorAgentRuntime({
    command: process.execPath,
    args: [new URL("../src/agents/testing/fake-cursor-agent.js", import.meta.url).pathname, "--scenario", "raw-tool-io"],
    projectName: "Cursor Sanitisation Suite",
    projectPath: process.cwd(),
    initTimeoutMs: 10_000,
  });
  runtime.attach(sink);
  try {
    await runtime.start();
    await runtime.handleSessionStream({
      type: "session.stream.subscribe",
      subscriptionId: "sub-sanitize",
      threadId: "sess-sanitize",
    });
    await runtime.handleSessionCommand({
      type: "session.command",
      messageId: "msg-sanitize-2",
      sequence: 1,
      commandId: "3c3c3c3c-sanitise",
      threadId: "sess-sanitize",
      text: "clean up",
      attachments: [],
    });
    await sink.waitUntil(() => sink.frames().some((entry) =>
      entry.frame.kind === "turn.status" && entry.frame.status === "completed"));
    const activity = sink.frames().find((entry) => entry.frame.kind === "activity.upsert");
    assert.ok(activity !== undefined, "sanitised activity frame expected");
    assert.equal((activity?.frame as { label: string }).label, "bash");
    const rendered = JSON.stringify(sink.events);
    for (const secret of ["SECRET-COMMAND-XYZ", "abc123"]) {
      assert.equal(rendered.includes(secret), false, `raw tool input leaked: ${secret}`);
    }
  } finally {
    await runtime.stop();
  }
});
