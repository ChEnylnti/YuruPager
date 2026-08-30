import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adaptNotification, adaptServerRequest } from "../codex/adapter.js";
import type { QuestionRequest } from "../codex/domain.js";
import { CodexAppServerClient } from "../codex/json-rpc-client.js";

interface ThreadStartResponse {
  thread: {
    id: string;
  };
}

const directory = await mkdtemp(join(tmpdir(), "yurupager-shared-"));
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

const tuiClient = sharedClient(webSocketUrl);
const connectorClient = sharedClient(webSocketUrl);
const requestObservations: Array<{
  recipient: string;
  requestId: string;
  category: string;
}> = [];
const notificationCounts = {
  tui: new Map<string, number>(),
  connector: new Map<string, number>(),
};
let completionResolve: (() => void) | undefined;
const completion = new Promise<void>((resolve) => {
  completionResolve = resolve;
});
let approvalObservedResolve: (() => void) | undefined;
const approvalObserved = new Promise<void>((resolve) => {
  approvalObservedResolve = resolve;
});
let releaseTuiApproval: (() => void) | undefined;
const tuiApprovalRelease = new Promise<void>((resolve) => {
  releaseTuiApproval = resolve;
});

tuiClient.setServerRequestHandler(requestHandler("tui"));
connectorClient.setServerRequestHandler(requestHandler("connector"));
tuiClient.onNotification(notificationHandler("tui"));
connectorClient.onNotification(notificationHandler("connector"));

let threadId = "";
try {
  await waitForPort(port, server);
  await Promise.all([tuiClient.start(), connectorClient.start()]);
  await Promise.all([
    tuiClient.initialize({
      name: "yurupager-tui-simulator",
      version: "0.0.1",
    }),
    connectorClient.initialize({
      name: "yurupager-connector-simulator",
      version: "0.0.1",
    }),
  ]);

  const thread = await tuiClient.request<ThreadStartResponse>("thread/start", {
    cwd: directory,
    ephemeral: false,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "read-only",
    developerInstructions:
      "Follow the user's single harmless shell command exactly and do not perform unrelated work.",
  });
  threadId = thread.thread.id;

  await tuiClient.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text: `Run exactly this shell command and no other command: /usr/bin/printf 'executed\\n' >> ${executionLog}. If approval is denied, acknowledge the denial and finish.`,
      },
    ],
    approvalPolicy: "on-request",
  });

  await withTimeout(approvalObserved, 120_000);
  let resumeSucceeded = false;
  let resumeError: string | null = null;
  try {
    await connectorClient.request("thread/resume", {
      threadId,
      excludeTurns: true,
    });
    resumeSucceeded = true;
  } catch (error) {
    resumeError = error instanceof Error ? error.message : String(error);
  }
  await delay(500);
  releaseTuiApproval?.();
  await withTimeout(completion, 120_000);
  await delay(250);
  const requestRecipients = requestObservations.map(
    (observation) => observation.recipient,
  );
  const approvalRequestIds = [
    ...new Set(requestObservations.map((observation) => observation.requestId)),
  ];
  const executionCount = await countExecutions(executionLog);
  const result = {
    passed:
      resumeSucceeded &&
      requestRecipients.includes("connector") &&
      requestRecipients.includes("tui") &&
      approvalRequestIds.length === 1 &&
      executionCount === 0,
    experimentCompleted: true,
    threadId,
    resumeSucceeded,
    resumeError,
    requestRecipients,
    approvalRequestIds,
    requestObservations,
    connectorSawApproval: requestRecipients.includes("connector"),
    tuiSawApproval: requestRecipients.includes("tui"),
    connectorNotifications: Object.fromEntries(notificationCounts.connector),
    tuiNotifications: Object.fromEntries(notificationCounts.tui),
    executionCount,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) {
    process.exitCode = 1;
  }
} finally {
  releaseTuiApproval?.();
  if (threadId.length > 0 && tuiClient.running) {
    try {
      await tuiClient.request("thread/delete", { threadId });
    } catch (error) {
      process.stderr.write(
        `Unable to delete Spike thread ${threadId}: ${String(error)}\n`,
      );
    }
  }
  await Promise.allSettled([tuiClient.stop(), connectorClient.stop()]);
  await stopProcess(server);
  await rm(directory, { recursive: true, force: true });
}

function sharedClient(url: string): CodexAppServerClient {
  return new CodexAppServerClient({
    webSocketUrl: url,
    requestTimeoutMs: 30_000,
  });
}

function requestHandler(clientName: string) {
  return async (request: Parameters<typeof adaptServerRequest>[0]) => {
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
    requestObservations.push({
      recipient: clientName,
      requestId: adapted.domain.requestId,
      category: adapted.domain.category,
    });
    if (clientName === "tui") {
      approvalObservedResolve?.();
      await tuiApprovalRelease;
    }
    return adapted.createCodexResponse({ kind: "approval", decision: "deny" });
  };
}

function notificationHandler(clientName: "tui" | "connector") {
  return (notification: Parameters<typeof adaptNotification>[0]) => {
    const counts = notificationCounts[clientName];
    counts.set(notification.method, (counts.get(notification.method) ?? 0) + 1);
    const event = adaptNotification(notification);
    if (event?.type === "turn.completed") {
      completionResolve?.();
    }
  };
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

async function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
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
  child: ReturnType<typeof spawn>,
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
