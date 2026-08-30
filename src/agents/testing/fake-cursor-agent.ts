#!/usr/bin/env node
// Scriptable fake Cursor CLI (ADR-029). Speaks the stream-json line protocol
// (system/assistant/result events + control requests) so contract tests can
// drive CursorAgentRuntime without the real CLI installed.
//
// Usage: node fake-cursor-agent.js --scenario <standard|unknown-permission-option|crash-on-prompt|raw-tool-io>

import { createInterface } from "node:readline";

function scenarioName(): string {
  const index = process.argv.indexOf("--scenario");
  return index === -1 ? "standard" : (process.argv[index + 1] ?? "standard");
}

const scenario = scenarioName();

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

send({
  type: "system",
  subtype: "init",
  session_id: "cursor-fake-1",
  model: "cursor-fake-model",
  tools: ["bash", "read_file"],
});

let turnEnded = false;

function emitResult(subtype: string, isError: boolean, usage: Record<string, number> | undefined): void {
  if (turnEnded) return;
  turnEnded = true;
  send({
    type: "result",
    subtype,
    is_error: isError,
    session_id: "cursor-fake-1",
    ...(usage === undefined ? {} : { usage }),
  });
}

function canUseTool(): void {
  send({
    type: "control_request",
    request_id: "ctrl-1",
    subtype: "can_use_tool",
    tool_name: "bash",
  });
}

const reader = createInterface({ input: process.stdin });
reader.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }
  if (message.type === "user") {
    if (scenario === "crash-on-prompt") {
      process.exit(1);
    }
    send({ type: "assistant", message: { content: [{ type: "text", text: "正在分析" }] } });
    if (scenario === "raw-tool-io") {
      send({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tool-raw-1", name: "bash", input: { command: "SECRET-COMMAND-XYZ --token abc123" } }] },
      });
      emitResult("success", false, { input_tokens: 500, cached_input_tokens: 0, output_tokens: 40, total_tokens: 540 });
      return;
    }
    if (scenario === "unknown-permission-option") {
      send({ type: "control_request", request_id: "ctrl-unknown", subtype: "some_unknown_control", tool_name: "bash" });
      return;
    }
    canUseTool();
    return;
  }
  if (message.type === "control_request") {
    // The only control request this fake honours is the supervisor interrupt.
    const subtype = typeof message.subtype === "string" ? message.subtype : "";
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { behavior: "allow" } } });
    if (subtype === "interrupt") {
      emitResult("interrupted", false, undefined);
    }
    return;
  }
  if (message.type === "control_response") {
    const response = message.response as Record<string, unknown> | undefined;
    if (response?.subtype === "error") {
      emitResult("error_during_execution", true, undefined);
      return;
    }
    if (scenario === "unknown-permission-option") {
      emitResult("error_during_execution", true, undefined);
      return;
    }
    const behavior = (response?.response as { behavior?: string } | undefined)?.behavior;
    if (behavior === "allow") {
      send({ type: "assistant", message: { content: [{ type: "text", text: "完成" }] } });
      // Keep the turn in flight briefly so supervisor interrupts have a real
      // window; emitResult's turnEnded guard makes the interrupt win the race
      // against the natural completion.
      setTimeout(() => emitResult("success", false, { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 80, total_tokens: 1280 }), 400);
    } else {
      emitResult("error_during_execution", true, undefined);
    }
    return;
  }
});

process.stdin.once("end", () => process.exit(0));
