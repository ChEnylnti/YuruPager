import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adaptNotification, adaptServerRequest } from "../codex/adapter.js";
import type { QuestionRequest } from "../codex/domain.js";
import { isRecord } from "../codex/guards.js";
import { CodexAppServerClient } from "../codex/json-rpc-client.js";

const directory = await mkdtemp(join(tmpdir(), "yurupager-remote-tui-"));
const executionLog = join(directory, "execution.log");
const port = await findFreePort();
const webSocketUrl = `ws://127.0.0.1:${String(port)}`;
const server = spawn(
  "codex",
  ["app-server", "--listen", webSocketUrl],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let serverStderr = "";
server.stderr.on("data", (chunk: Buffer) => {
  serverStderr = `${serverStderr}${chunk.toString("utf8")}`.slice(-8_192);
});
let tuiOutputTail = "";

const connector = new CodexAppServerClient({
  webSocketUrl,
  requestTimeoutMs: 30_000,
});
const notificationCounts = new Map<string, number>();
const approvalRequestIds: string[] = [];
let approvalResolve: (() => void) | undefined;
const approvalObserved = new Promise<void>((resolve) => {
  approvalResolve = resolve;
});
let completionResolve: (() => void) | undefined;
const completion = new Promise<void>((resolve) => {
  completionResolve = resolve;
});

connector.setServerRequestHandler(async (request) => {
  const adapted = adaptServerRequest(request);
  if (adapted === null) {
    throw new Error(`Unsupported Codex server request: ${request.method}`);
  }
  if (adapted.domain.type === "question.requested") {
    return adapted.createCodexResponse({
      kind: "answers",
      answers: defaultAnswers(adapted.domain),
    });
  }
  approvalRequestIds.push(adapted.domain.requestId);
  approvalResolve?.();
  return adapted.createCodexResponse({ kind: "approval", decision: "deny" });
});
connector.onNotification((notification) => {
  notificationCounts.set(
    notification.method,
    (notificationCounts.get(notification.method) ?? 0) + 1,
  );
  const event = adaptNotification(notification);
  if (event?.type === "turn.completed") {
    completionResolve?.();
  }
});

let tui: ChildProcess | undefined;
let threadId = "";
try {
  await waitForPort(port, server);
  await connector.start();
  await connector.initialize({
    name: "yurupager-real-tui-connector",
    version: "0.0.1",
  });

  const startedTui = startRemoteTui(webSocketUrl, directory, executionLog);
  tui = startedTui;
  threadId = await waitForThread(connector, directory, startedTui);
  await connector.request("thread/resume", {
    threadId,
    excludeTurns: true,
  });
  await withTimeout(approvalObserved, 120_000);
  await withTimeout(completion, 120_000);
  await delay(250);

  const executionCount = await countExecutions(executionLog);
  const result = {
    passed:
      approvalRequestIds.length === 1 &&
      (notificationCounts.get("thread/tokenUsage/updated") ?? 0) > 0 &&
      (notificationCounts.get("turn/completed") ?? 0) === 1 &&
      executionCount === 0,
    realTuiConnected: true,
    threadId,
    approvalRequestIds: [...new Set(approvalRequestIds)],
    connectorNotifications: Object.fromEntries(notificationCounts),
    executionCount,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) {
    process.exitCode = 1;
  }
} finally {
  if (tui !== undefined) {
    await stopTui(tui);
  }
  if (threadId.length === 0 && connector.running) {
    try {
      threadId = (await findThread(connector, directory)) ?? "";
    } catch {
      // The app-server may already be unavailable during failure cleanup.
    }
  }
  if (threadId.length > 0 && connector.running) {
    try {
      await connector.request("thread/delete", { threadId });
    } catch (error) {
      process.stderr.write(
        `Unable to delete Spike thread ${threadId}: ${String(error)}\n`,
      );
    }
  }
  await connector.stop();
  await stopProcess(server);
  await rm(directory, { recursive: true, force: true });
}

function startRemoteTui(
  url: string,
  cwd: string,
  markerPath: string,
): ChildProcess {
  const prompt =
    `Run exactly this shell command and no other command: ` +
    `/usr/bin/printf 'executed\\n' >> ${markerPath}. ` +
    "If approval is denied, acknowledge the denial and finish.";
  const child = spawn(
    "/usr/bin/script",
    [
      "-q",
      "/dev/null",
      "codex",
      "--remote",
      url,
      "-C",
      cwd,
      "-a",
      "on-request",
      "-s",
      "read-only",
      prompt,
    ],
    {
      env: { ...process.env, TERM: "xterm-256color" },
      stdio: ["inherit", "pipe", "pipe"],
    },
  );
  const capture = (chunk: Buffer) => {
    tuiOutputTail = `${tuiOutputTail}${chunk.toString("utf8")}`.slice(-8_192);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return child;
}

interface ThreadListResponse {
  data: unknown[];
}

async function waitForThread(
  client: CodexAppServerClient,
  cwd: string,
  tuiProcess: ChildProcess,
): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const threadId = await findThread(client, cwd);
    if (threadId !== undefined) {
      return threadId;
    }
    if (tuiProcess.exitCode !== null) {
      throw new Error(
        `Remote TUI exited before creating a thread (code=${String(tuiProcess.exitCode)}, state=${tuiState()})`,
      );
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for the remote TUI thread (state=${tuiState()})`,
  );
}

async function findThread(
  client: CodexAppServerClient,
  cwd: string,
): Promise<string | undefined> {
  const response = await client.request<ThreadListResponse>("thread/list", {
    cwd,
    limit: 10,
    sortKey: "created_at",
    sortDirection: "desc",
  });
  for (const thread of response.data) {
    if (
      isRecord(thread) &&
      typeof thread.id === "string" &&
      thread.cwd === cwd
    ) {
      return thread.id;
    }
  }
  return undefined;
}

function tuiState(): string {
  if (tuiOutputTail.includes("Action Required")) {
    return "action-required";
  }
  return tuiOutputTail.length > 0 ? "rendering" : "no-output";
}

async function stopTui(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGINT");
  if (await waitForExit(child, 1_000)) {
    return;
  }
  await stopProcess(child);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  if (await waitForExit(child, 2_000)) {
    return;
  }
  child.kill("SIGKILL");
  await waitForExit(child, 2_000);
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function defaultAnswers(request: QuestionRequest): Record<string, string[]> {
  return Object.fromEntries(
    request.questions.map((question) => [
      question.id,
      [question.options[0]?.label ?? "Continue"],
    ]),
  );
}

async function findFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (address === null || typeof address === "string") {
    probe.close();
    throw new Error("Unable to allocate a loopback port");
  }
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

async function waitForPort(
  port: number,
  child: ReturnType<typeof spawn>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Shared app-server exited before listening: ${serverStderr}`,
      );
    }
    if (await canConnect(port)) {
      return;
    }
    await delay(25);
  }
  throw new Error("Timed out waiting for shared app-server listener");
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function countExecutions(path: string): Promise<number> {
  try {
    const content = await readFile(path, "utf8");
    return content.split("\n").filter((line) => line === "executed").length;
  } catch {
    return 0;
  }
}

async function withTimeout(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([promise, timedOut]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
