// ZCode Protocol app-server spike (ADR-030). Probes the RPC surface of
// `zcode app-server` and prints the observed protocol shape as structured
// JSON. Re-runnable; skips structurally when the CLI is absent.
//
// Protocol findings encoded here were observed against zcode 0.16.5:
// - ndjson framing; envelope is {id, method, params} (NOT JSON-RPC 2.0 — the
//   server rejects a `jsonrpc` key); server->client requests are answered
//   with {id, result}; notifications carry {method, params}.
// - session/list provides global discovery; session/resume answers a
//   session/requestRuntimePreferences server request per scope;
//   session/usage returns cumulative usage; session/setMode validates
//   mode: plan|build|edit|yolo|auto; interaction/requestPermission is the
//   approval request (shape unverified without a live model turn).
//
// Usage: npm run spike:zcode-app-server [-- --command <zcode>]

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const DEFAULT_APP_CLI = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";

function readArgument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function resolveZcodeCommand(args: string[]): string {
  const explicit = readArgument(args, "--command");
  if (explicit !== undefined) return explicit;
  if (process.env.ZCODE_COMMAND !== undefined) return process.env.ZCODE_COMMAND;
  return DEFAULT_APP_CLI;
}

interface ProbeResult {
  result?: unknown;
  error?: { code?: number; message?: string };
}

const child = spawn(process.execPath, [resolveZcodeCommand(process.argv.slice(2)), "app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
});
const pending = new Map<string, (message: ProbeResult) => void>();
let nextId = 1;
const notifications = new Set<string>();
const serverRequests = new Set<string>();

const reader = createInterface({ input: child.stdout });
reader.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let message: { id?: unknown; requestId?: unknown; result?: unknown; error?: unknown; method?: unknown };
  try { message = JSON.parse(trimmed); } catch { return; }
  const id = message.id ?? message.requestId;
  if (id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const pendingEntry = pending.get(String(id));
    if (pendingEntry !== undefined) {
      pending.delete(String(id));
      pendingEntry(message as ProbeResult);
      return;
    }
  }
  if (typeof message.method === "string") {
    if (id === undefined) notifications.add(message.method);
    else serverRequests.add(message.method);
  }
  // Runtime preferences are answered so resume can proceed; every other
  // server request is left to time out (the spike is read-only).
  if (message.method === "session/requestRuntimePreferences") {
    child.stdin?.write(`${JSON.stringify({ id: message.id, result: { nativeSearchEnhancementsEnabled: false } })}\n`);
  }
});
child.stderr.on("data", () => undefined);

function request(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<ProbeResult> {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(String(id));
      resolve({ error: { code: -1, message: "__timeout" } });
    }, timeoutMs);
    pending.set(String(id), (message) => { clearTimeout(timer); resolve(message); });
    child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

function summarise(message: ProbeResult): string {
  const body = JSON.stringify(message);
  return body.length > 400 ? `${body.slice(0, 400)}…` : body;
}

try {
  const listing = await request("session/list", {});
  const sessions = (listing.result as { sessions?: Array<{ sessionId?: string; status?: string; mode?: string }> } | undefined)?.sessions ?? [];
  const realId = sessions[0]?.sessionId;
  process.stdout.write(`${JSON.stringify({
    spike: "zcode-app-server",
    envelope: "{id, method, params} ndjson (no jsonrpc key)",
    discovery: {
      method: "session/list",
      sessionCount: sessions.length,
      observedStatuses: [...new Set(sessions.map((session) => session.status ?? "unknown"))],
      observedModes: [...new Set(sessions.map((session) => session.mode ?? "unknown"))],
    },
    resume: realId === undefined ? "no session available" : summarise(await request("session/resume", { sessionId: realId })),
    usage: realId === undefined ? null : summarise(await request("session/usage", { sessionId: realId })),
    subscribeValidation: summarise(await request("session/subscribe", { sessionId: realId ?? "sess_none" })),
    setModeValidation: summarise(await request("session/setMode", { sessionId: realId ?? "sess_none", mode: "build" })),
    serverRequestsSeen: [...serverRequests].sort(),
    notificationsSeen: [...notifications].sort(),
    permissionMethod: "interaction/requestPermission (server->client; result shape unverified without a live model turn)",
    userInputMethod: "interaction/requestUserInput (server->client; unsupported by YuruPager, refused)",
    turnMethods: "session/send {sessionId, content}; session/stop {sessionId}; turn-scoped event delivery via session/subscribe {deliveryKind}",
  }, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    spike: "zcode-app-server",
    error: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 1_000).unref();
}
