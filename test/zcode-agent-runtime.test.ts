import assert from "node:assert/strict";
import { test } from "node:test";

import { parseZcodeVersion, ZcodeAgentRuntime } from "../src/agents/zcode/zcode-agent-runtime.js";
import {
  createRecordingSink,
  registerAgentRuntimeContractTests,
} from "../src/agents/testing/agent-runtime-contract.js";

registerAgentRuntimeContractTests({
  test: (name, fn) => test(name, fn),
  createRuntime: (scenario) => {
    const sink = createRecordingSink();
    const runtime = new ZcodeAgentRuntime({
      command: process.execPath,
      args: [new URL("../src/agents/testing/fake-zcode-app-server.js", import.meta.url).pathname, "--scenario", scenario],
      projectName: "ZCode Contract Suite",
      projectPath: process.cwd(),
      requestTimeoutMs: 10_000,
      pollMs: 40,
    });
    runtime.attach(sink);
    return { runtime, sink };
  },
});

test("ZCode version gate accepts 0.16.x and fails closed outside it", () => {
  assert.equal(parseZcodeVersion("zcode 0.16.5").supported, true);
  assert.equal(parseZcodeVersion("zcode 0.16.0").supported, true);
  assert.equal(parseZcodeVersion("zcode 0.17.0").supported, false);
  assert.equal(parseZcodeVersion("zcode 0.15.9").supported, false);
  assert.equal(parseZcodeVersion("codex 0.16.5").supported, false);
  assert.equal(parseZcodeVersion("unknown output").version, null);
});

test("ZCode usage snapshots are cumulative with the zcode provider", async () => {
  const sink = createRecordingSink();
  const runtime = new ZcodeAgentRuntime({
    command: process.execPath,
    args: [new URL("../src/agents/testing/fake-zcode-app-server.js", import.meta.url).pathname, "--scenario", "standard"],
    projectName: "ZCode Usage Suite",
    projectPath: process.cwd(),
    requestTimeoutMs: 10_000,
    pollMs: 30,
  });
  runtime.attach(sink);
  try {
    await runtime.start();
    await runtime.handleSessionStream({
      type: "session.stream.subscribe",
      subscriptionId: "sub-usage",
      threadId: "sess_fake_1",
    });
    void runtime.handleSessionCommand({
      type: "session.command",
      messageId: "msg-usage-1",
      sequence: 1,
      commandId: "4d4d4d4d-usagetest",
      threadId: "sess_fake_1",
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
    await sink.waitUntil(() => sink.sent("token.snapshot").length >= 1);
    const snapshot = sink.sent("token.snapshot")[0] as {
      sequence: number; provider: string; agent?: string; sessionId?: string; totalTokens: number;
    };
    assert.equal(snapshot.provider, "zcode");
    assert.equal(snapshot.agent, "zcode");
    assert.equal(snapshot.sequence, 1);
    assert.equal(snapshot.sessionId, "sess_fake_1");
    assert.equal(snapshot.totalTokens, 1024 + 640);
  } finally {
    await runtime.stop();
  }
});

test("ZCode tool telemetry entries never reach frames or payloads", async () => {
  const sink = createRecordingSink();
  const runtime = new ZcodeAgentRuntime({
    command: process.execPath,
    args: [new URL("../src/agents/testing/fake-zcode-app-server.js", import.meta.url).pathname, "--scenario", "raw-tool-io"],
    projectName: "ZCode Sanitisation Suite",
    projectPath: process.cwd(),
    requestTimeoutMs: 10_000,
    pollMs: 30,
  });
  runtime.attach(sink);
  try {
    await runtime.start();
    await runtime.handleSessionStream({
      type: "session.stream.subscribe",
      subscriptionId: "sub-sanitize",
      threadId: "sess_fake_1",
    });
    void runtime.handleSessionCommand({
      type: "session.command",
      messageId: "msg-sanitize-1",
      sequence: 1,
      commandId: "5e5e5e5e-sanitise",
      threadId: "sess_fake_1",
      text: "clean up",
      attachments: [],
    }).catch(() => undefined);
    await sink.waitUntil(() => sink.frames().some((entry) =>
      entry.frame.kind === "turn.status" && entry.frame.status === "completed"));
    const rendered = JSON.stringify(sink.events);
    assert.equal(rendered.includes("SECRET-TOOL-OUTPUT-XYZ"), false, "raw tool output leaked");
    assert.equal(rendered.includes("rawOutput"), false);
  } finally {
    await runtime.stop();
  }
});
