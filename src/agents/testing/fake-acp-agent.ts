#!/usr/bin/env node
// Scriptable fake ACP agent (ADR-024 Phase 1 item 5). Speaks the
// newline-delimited JSON-RPC dialect over stdio so contract tests can drive
// any AgentRuntime implementation without a real agent CLI installed.
//
// Usage: node fake-acp-agent.js --scenario <standard|no-load-session|crash-on-prompt|unknown-permission-option>

import { createInterface } from "node:readline";

function scenarioName(): string {
  const index = process.argv.indexOf("--scenario");
  return index === -1 ? "standard" : (process.argv[index + 1] ?? "standard");
}

const scenario = scenarioName();
const loadSession = scenario !== "no-load-session";
const permissionOptions = scenario === "unknown-permission-option"
  ? [{ optionId: "always_allow_session", name: "Always allow", kind: "allow_once" }]
  : [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
    ];

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let nextId = 1;
function request(method: string, params: unknown): Promise<Record<string, unknown>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fake agent request timeout: ${method}`)), 20_000);
    pendingServerResponses.set(id, (result) => {
      clearTimeout(timer);
      resolve(result as Record<string, unknown>);
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const pendingServerResponses = new Map<number, (result: unknown) => void>();
let cancelled = false;

function emitUpdate(sessionId: string, update: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

async function runPrompt(sessionId: string): Promise<void> {
  emitUpdate(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "正在分析" } });
  if (scenario === "raw-tool-io") {
    emitUpdate(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-raw-1",
      title: "删除构建产物",
      kind: "execute",
      rawInput: { command: "SECRET-COMMAND-XYZ --token abc123" },
      rawOutput: { stdout: "SECRET-OUTPUT-XYZ", exitCode: 0 },
      rawContent: "SECRET-CONTENT-XYZ",
    });
    emitUpdate(sessionId, { sessionUpdate: "turn_end", stopReason: "end_turn" });
    return;
  }
  const permission = await request("session/request_permission", {
    sessionId,
    options: permissionOptions,
    kind: "select",
  });
  const outcome = (permission?.outcome as { outcome?: string; optionId?: string } | undefined) ?? {};
  const denied = outcome.outcome !== "selected" || !String(outcome.optionId ?? "").startsWith("allow");
  if (denied) {
    emitUpdate(sessionId, { sessionUpdate: "turn_end", stopReason: "rejected" });
    return;
  }
  emitUpdate(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "完成" } });
  // Keep the turn in flight briefly so supervisor cancels have a real window.
  setTimeout(() => {
    if (cancelled) return;
    emitUpdate(sessionId, { sessionUpdate: "turn_end", stopReason: "end_turn" });
  }, 400);
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
  const method = message.method as string | undefined;
  if (method === undefined) {
    const id = message.id as number | undefined;
    if (typeof id === "number" && pendingServerResponses.has(id)) {
      pendingServerResponses.get(id)?.(message.result);
      pendingServerResponses.delete(id);
    }
    return;
  }
  const params = (message.params ?? {}) as Record<string, unknown>;
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : "fake-session-1";
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: 1, agentCapabilities: { loadSession } },
      });
      return;
    case "session/new":
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fake-session-1" } });
      return;
    case "session/load":
      emitUpdate(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "历史消息" } });
      send({ jsonrpc: "2.0", id: message.id, result: null });
      return;
    case "session/prompt":
      if (scenario === "crash-on-prompt") {
        process.exit(1);
      }
      // Real ACP resolves session/prompt when the turn ends, so the fake
      // must not answer before runPrompt finishes (contract exercises the
      // asynchronous approval round-trip against the blocking semantics).
      void runPrompt(sessionId).then(() => {
        send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      });
      return;
    case "session/cancel":
      cancelled = true;
      send({ jsonrpc: "2.0", id: message.id, result: null });
      emitUpdate(sessionId, { sessionUpdate: "turn_end", stopReason: "cancelled" });
      return;
    case "session/cancel-never": // unreachable; documents the latch above
      return;
    default:
      if (typeof message.id !== "undefined") {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
  }
});

process.stdin.once("end", () => process.exit(0));
void cancelled;
