// End-to-end spike against a real Gemini CLI in ACP mode (ADR-024/025).
// Structured skip: when the `gemini` CLI is not installed the spike reports
// { skipped: true } and exits 0 — real-CLI verification is a manual checklist,
// the fake-agent contract suite is the merge gate.
//
// Usage: npm run spike:gemini-e2e
//
// The transcript is printed to stdout only; nothing about the conversation,
// tool IO, or prompts is persisted anywhere.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { AcpAgentRuntime } from "../agents/acp/acp-agent-runtime.js";
import { createRecordingSink } from "../agents/testing/agent-runtime-contract.js";

const GEMINI_COMMAND = process.env.GEMINI_COMMAND ?? "gemini";
const GEMINI_ACP_ARGS = (process.env.GEMINI_ACP_ARGS ?? "--acp").split(" ").filter((part) => part.length > 0);
const TURN_TIMEOUT_MS = 120_000;

function probeGemini(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(GEMINI_COMMAND, ["--version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

function summary(frames: Array<{ frame: Record<string, unknown> }>): Record<string, unknown> {
  const deltas = frames
    .filter((entry) => entry.frame.kind === "message.delta")
    .map((entry) => String((entry.frame as { delta?: unknown }).delta ?? ""))
    .join("");
  const activities = frames
    .filter((entry) => entry.frame.kind === "activity.upsert")
    .map((entry) => String((entry.frame as { label?: unknown }).label ?? ""));
  const turn = frames.find((entry) => entry.frame.kind === "turn.status");
  return {
    frameKinds: [...new Set(frames.map((entry) => entry.frame.kind))],
    assistantTextChars: deltas.length,
    assistantTextPreview: deltas.slice(0, 400),
    sanitizedActivities: activities,
    turnStatus: turn === undefined ? null : (turn.frame as { status?: unknown }).status ?? null,
  };
}

if (!(await probeGemini())) {
  process.stdout.write(`${JSON.stringify({
    spike: "gemini-e2e",
    skipped: true,
    reason: `The '${GEMINI_COMMAND}' CLI is not available on this machine. Install Google Gemini CLI (it must support ${GEMINI_ACP_ARGS.join(" ")}) and re-run; the fake-agent contract suite remains the merge gate.`,
  }, null, 2)}\n`);
  process.exit(0);
}

const sink = createRecordingSink();
const runtime = new AcpAgentRuntime({
  command: GEMINI_COMMAND,
  args: GEMINI_ACP_ARGS,
  projectName: "Gemini ACP Spike",
  projectPath: process.cwd(),
  requestTimeoutMs: 60_000,
});
runtime.attach(sink);

try {
  await runtime.start();
  const capabilities = await runtime.capabilities();
  await runtime.handleSessionStream({
    type: "session.stream.subscribe",
    subscriptionId: "spike-gemini",
    threadId: "spike-gemini-session",
  });
  void runtime.handleSessionCommand({
    type: "session.command",
    messageId: randomUUID(),
    sequence: 1,
    commandId: randomUUID(),
    threadId: "spike-gemini-session",
    text: "用一句话说明你是什么编码 agent，不要执行任何命令。",
    attachments: [],
  }).catch(() => undefined);

  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (sink.frames().some((entry) => entry.frame.kind === "turn.status")) break;
    const request = sink.requests()[0];
    if (request !== undefined) {
      await runtime.handleDecision({
        type: "decision",
        messageId: randomUUID(),
        sequence: 2,
        requestId: request.requestId,
        decisionId: randomUUID(),
        decision: { decision: "deny" }, // spike never grants tool permissions
      });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  process.stdout.write(`${JSON.stringify({
    spike: "gemini-e2e",
    skipped: false,
    agentId: capabilities.agentId,
    usageReporting: capabilities.usageReporting,
    usageNote: capabilities.usageReporting ? undefined : "unavailable (ACP 无标准用量上报；不构造数据)",
    ...summary(sink.frames()),
  }, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    spike: "gemini-e2e",
    skipped: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await runtime.stop();
}
