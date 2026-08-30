import assert from "node:assert/strict";
import { test } from "node:test";

import { AcpAgentRuntime } from "../src/agents/acp/acp-agent-runtime.js";
import { createRecordingSink } from "../src/agents/testing/agent-runtime-contract.js";

function serializeSink(sink: ReturnType<typeof createRecordingSink>): string {
  return JSON.stringify(sink.events);
}

test("ACP tool telemetry is sanitised: raw tool IO never reaches frames or payloads", async () => {
  const sink = createRecordingSink();
  const runtime = new AcpAgentRuntime({
    command: process.execPath,
    args: [new URL("../src/agents/testing/fake-acp-agent.js", import.meta.url).pathname, "--scenario", "raw-tool-io"],
    projectName: "Sanitisation Suite",
    projectPath: process.cwd(),
    requestTimeoutMs: 10_000,
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
      messageId: "msg-sanitize-1",
      sequence: 1,
      commandId: "0f0f0f0f-sanitise",
      threadId: "sess-sanitize",
      text: "clean up",
      attachments: [],
    });
    await sink.waitUntil(() => sink.frames().some((entry) =>
      entry.frame.kind === "turn.status" && entry.frame.status === "completed"));

    const activity = sink.frames().find((entry) => entry.frame.kind === "activity.upsert");
    assert.ok(activity !== undefined, "sanitised activity frame expected");
    const label = (activity?.frame as { label: string }).label;
    assert.equal(label, "删除构建产物");
    assert.equal((activity?.frame as { activity: string }).activity, "command");

    const rendered = serializeSink(sink);
    for (const secret of ["SECRET-COMMAND-XYZ", "SECRET-OUTPUT-XYZ", "SECRET-CONTENT-XYZ", "abc123"]) {
      assert.equal(rendered.includes(secret), false, `raw IO leaked: ${secret}`);
    }
    assert.equal(JSON.stringify(sink.frames()).includes("rawInput"), false);
  } finally {
    await runtime.stop();
  }
});

test("ACP runtime never fabricates usage snapshots", async () => {
  const sink = createRecordingSink();
  const runtime = new AcpAgentRuntime({
    command: process.execPath,
    args: [new URL("../src/agents/testing/fake-acp-agent.js", import.meta.url).pathname, "--scenario", "standard"],
    projectName: "Usage Suite",
    projectPath: process.cwd(),
    requestTimeoutMs: 10_000,
  });
  runtime.attach(sink);
  try {
    await runtime.start();
    await runtime.handleSessionStream({
      type: "session.stream.subscribe",
      subscriptionId: "sub-usage",
      threadId: "sess-usage",
    });
    await runtime.handleSessionCommand({
      type: "session.command",
      messageId: "msg-usage-1",
      sequence: 1,
      commandId: "1a1a1a1a-usagetest",
      threadId: "sess-usage",
      text: "usage probe",
      attachments: [],
    });
    await sink.waitUntil(() => sink.requests().length === 1);
    const request = sink.requests()[0];
    await runtime.handleDecision({
      type: "decision",
      messageId: "msg-usage-decision",
      sequence: 2,
      requestId: request?.requestId as string,
      decisionId: "decision-usage-1",
      decision: { decision: "approve" },
    });
    await sink.waitUntil(() => sink.frames().some((entry) =>
      entry.frame.kind === "turn.status" && entry.frame.status === "completed"));
    assert.equal(sink.sent("token.snapshot").length, 0);
    assert.equal((await runtime.capabilities()).usageReporting, false);
  } finally {
    await runtime.stop();
  }
});
