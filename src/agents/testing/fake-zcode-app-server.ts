#!/usr/bin/env node
// Scriptable fake ZCode Protocol app-server (ADR-030). Speaks the observed
// dialect — ndjson {id, method, params} without a jsonrpc key, server->client
// requests answered with {id, result} — so contract tests can drive
// ZcodeAgentRuntime without the real CLI.
//
// Scenarios: standard | crash-on-prompt | raw-tool-io | unknown-server-request

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

function scenarioName(): string {
  const index = process.argv.indexOf("--scenario");
  return index === -1 ? "standard" : (process.argv[index + 1] ?? "standard");
}

const scenario = scenarioName();

if (process.argv.includes("--version")) {
  process.stdout.write("zcode 0.16.5\n");
  process.exit(0);
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

interface FakeMessage {
  info: { messageId: string; agent: string; kind?: string };
  text?: string;
  rawOutput?: string;
}

const messages: FakeMessage[] = [];
let activeSessionId = "sess_fake_1";
let turnEnded = false;
let permissionDecision: "allow" | "deny" | null = null;
let usageTotal = 1024;

// Pure notification (no id): a server->client request would be refused by
// the supervisor, and its error response would latch the turn ended.
send({ method: "session/hello", params: { protocolVersion: 1, agent: "fake-zcode" } });

function emitTurnEnd(status: string): void {
  if (turnEnded) return;
  turnEnded = true;
  send({ method: "state.updated", params: { sessionId: activeSessionId, status } });
}

function emitMessage(text: string): void {
  messages.push({ info: { messageId: `msg_${messages.length + 1}`, agent: "zcode-agent" }, text });
}

const reader = createInterface({ input: process.stdin });
const DEBUG = process.env.FAKE_ZCODE_DEBUG !== undefined;
const debug = (message: string): void => {
  if (DEBUG) appendFileSync("/tmp/fake-zcode-debug.log", message + "\n");
};
reader.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let message: Record<string, unknown>;
  try { message = JSON.parse(trimmed) as Record<string, unknown>; } catch { return; }
  const method = message.method as string | undefined;
  const id = message.id;
  debug(`<- ${JSON.stringify(message).slice(0, 160)}`);
  switch (method) {
    case "session/list":
      send({
        id,
        result: {
          sessions: [{
            sessionId: "sess_fake_1",
            mode: "build",
            status: "idle",
            sessionKind: "interactive",
            title: "契约测试会话",
            createdAt: 1_788_100_000_000,
          }],
        },
      });
      return;
    case "session/resume": {
      const resumedId = (message.params as { sessionId?: unknown } | undefined)?.sessionId;
      if (typeof resumedId === "string") activeSessionId = resumedId;
      send({ id, result: { messages: [] } });
      send({ id: "srv-pref-1", method: "session/requestRuntimePreferences", params: { sessionId: activeSessionId, scope: "runtime-materialization" } });
      send({ id: "srv-pref-2", method: "session/requestRuntimePreferences", params: { sessionId: activeSessionId, scope: "user-execution" } });
      return;
    }
    case "session/requestRuntimePreferences":
      // Server->client request answered by the runtime; validate the shape.
      if (message.result !== undefined) return; // our own response echo guard
      return;
    case "session/messages":
      send({ id, result: { messages } });
      return;
    case "session/usage":
      send({
        id,
        result: {
          sessionId: "sess_fake_1",
          totalTokens: usageTotal,
          inputTokens: Math.floor(usageTotal * 0.8),
          outputTokens: usageTotal - Math.floor(usageTotal * 0.8),
          reasoningTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          modelRequestCount: 3,
        },
      });
      return;
    case "session/setMode": {
      const mode = (message.params as { mode?: unknown } | undefined)?.mode;
      if (mode !== "build" && mode !== "edit") {
        send({ id, error: { code: -32602, message: `Supervision forbids mode: ${String(mode)}` } });
        return;
      }
      send({ id, result: { messages: [] } });
      return;
    }
    case "session/stop":
      emitTurnEnd("interrupted");
      send({ id, result: {} });
      return;
    case "session/send": {
      if (scenario === "crash-on-prompt") {
        process.exit(1);
      }
      const sentId = (message.params as { sessionId?: unknown } | undefined)?.sessionId;
      if (typeof sentId === "string") activeSessionId = sentId;
      emitMessage("正在分析");
      if (scenario === "raw-tool-io") {
        messages.push({
          info: { messageId: "msg_tool_1", agent: "zcode-agent", kind: "tool_call" },
          rawOutput: "SECRET-TOOL-OUTPUT-XYZ",
        });
        emitMessage("完成");
        usageTotal += 500;
        emitTurnEnd("idle");
        send({ id, result: {} });
        return;
      }
      if (scenario === "unknown-server-request" || scenario === "unknown-permission-option") {
        // Fail-closed scenario: an unsupported server->client request must be
        // refused by the runtime, and the turn must end failed.
        send({ id: "srv-unknown-1", method: "interaction/requestUnknownThing", params: {} });
        return;
      }
      send({ id: "srv-perm-1", method: "interaction/requestPermission", params: { sessionId: activeSessionId, tool: "bash" } });
      return;
    }
    case "interaction/requestUnknownThing":
      // The runtime must refuse unknown server requests; the fake then fails
      // the turn instead of proceeding (fail-closed contract scenario).
      emitTurnEnd("error");
      return;
    default:
      // An error response to one of our server->client requests means the
      // supervisor refused — fail the turn closed instead of proceeding.
      if (message.error !== undefined) {
        emitTurnEnd("error");
        return;
      }
      // Responses to our server->client requests (e.g. permission decisions).
      if (id !== undefined && message.result !== undefined) {
        if (id === "srv-perm-1") {
          const decision = (message.result as { decision?: unknown } | undefined)?.decision;
          permissionDecision = decision === "allow" ? "allow" : "deny";
          if (permissionDecision === "allow") {
            emitMessage("完成");
            usageTotal += 640;
            setTimeout(() => {
              emitTurnEnd("idle");
              send({ id, result: {} });
            }, 400);
          } else {
            emitTurnEnd("idle");
            send({ id, result: {} });
          }
          return;
        }
        if (String(id).startsWith("srv-pref-")) return;
        send({ id, result: {} });
        return;
      }
      send({ id, error: { code: -32601, message: `Method not found: ${String(method)}` } });
  }
});

process.stdin.once("end", () => process.exit(0));
