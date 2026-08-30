import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptNotification, adaptServerRequest } from "../codex/adapter.js";
import type { QuestionRequest } from "../codex/domain.js";
import { isRecord } from "../codex/guards.js";
import { CodexAppServerClient } from "../codex/json-rpc-client.js";
import {
  AmbiguousDeliveryError,
  SqliteApprovalJournal,
} from "../reliability/sqlite-approval-journal.js";
import { SqliteDecisionLedger } from "../reliability/sqlite-decision-ledger.js";

interface ThreadStartResponse {
  thread: { id: string };
}

const workerPath = fileURLToPath(
  new URL("./fixtures/approval-crash-worker.js", import.meta.url),
);
const directory = await mkdtemp(join(tmpdir(), "yurupager-crash-window-"));
const executionLog = join(directory, "execution.log");
const databasePath = join(directory, "approval.sqlite");
const port = await findFreePort();
const webSocketUrl = `ws://127.0.0.1:${String(port)}`;
const server = spawn("codex", ["app-server", "--listen", webSocketUrl], {
  stdio: ["ignore", "ignore", "pipe"],
});
let serverStderr = "";
server.stderr?.on("data", (chunk: Buffer) => {
  serverStderr = `${serverStderr}${chunk.toString("utf8")}`.slice(-8_192);
});

const origin = new CodexAppServerClient({
  webSocketUrl,
  requestTimeoutMs: 30_000,
});
let recovery: CodexAppServerClient | undefined;
let threadId = "";
let requestId = "";
let approvalResolve: (() => void) | undefined;
const approvalObserved = new Promise<void>((resolve) => {
  approvalResolve = resolve;
});
let releaseOrigin: (() => void) | undefined;
const originRelease = new Promise<void>((resolve) => {
  releaseOrigin = resolve;
});
let completionResolve: (() => void) | undefined;
const completion = new Promise<void>((resolve) => {
  completionResolve = resolve;
});
let originResolvedEvents = 0;
let recoveryApprovalReplayed = false;

origin.setServerRequestHandler(async (request) => {
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
  requestId = adapted.domain.requestId;
  approvalResolve?.();
  await originRelease;
  return adapted.createCodexResponse({ kind: "approval", decision: "deny" });
});
origin.onNotification((notification) => {
  const event = adaptNotification(notification);
  if (event?.type === "server.request.resolved") {
    originResolvedEvents += 1;
  }
  if (event?.type === "turn.completed") {
    completionResolve?.();
  }
});

let worker: ChildProcess | undefined;
let workerStderr = "";
let ledger: SqliteDecisionLedger | undefined;
let journal: SqliteApprovalJournal | undefined;
try {
  await waitForPort(port, server);
  await origin.start();
  await origin.initialize({
    name: "yurupager-crash-window-origin",
    version: "0.0.1",
  });
  const started = await origin.request<ThreadStartResponse>("thread/start", {
    cwd: directory,
    ephemeral: false,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "read-only",
    developerInstructions:
      "Follow the user's single harmless shell command exactly and do not perform unrelated work.",
  });
  threadId = started.thread.id;
  await origin.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text:
          `Run exactly this shell command and no other command: ` +
          `/usr/bin/printf 'executed\\n' >> ${executionLog}. ` +
          "If approval is denied, acknowledge the denial and finish.",
      },
    ],
    approvalPolicy: "on-request",
  });
  await withTimeout(approvalObserved, 120_000);

  worker = spawn(
    process.execPath,
    [workerPath, webSocketUrl, threadId, databasePath],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  worker.stderr?.on("data", (chunk: Buffer) => {
    workerStderr = `${workerStderr}${chunk.toString("utf8")}`.slice(-8_192);
  });
  const workerExit = await waitForProcessExit(worker, 60_000);
  if (workerExit.code !== 86) {
    throw new Error(
      `Crash worker did not exit in the injected window: ${JSON.stringify(workerExit)} ${workerStderr}`,
    );
  }

  ledger = new SqliteDecisionLedger(databasePath);
  journal = new SqliteApprovalJournal(databasePath);
  const persistedDecision = ledger.get(requestId);
  const ambiguousRecord = journal.get(requestId);
  let retryBlocked = false;
  try {
    journal.beginDispatch(requestId);
  } catch (error) {
    retryBlocked = error instanceof AmbiguousDeliveryError;
  }

  recovery = new CodexAppServerClient({
    webSocketUrl,
    requestTimeoutMs: 30_000,
  });
  recovery.setServerRequestHandler((request) => {
    const adapted = adaptServerRequest(request);
    if (adapted === null || adapted.domain.type !== "approval.requested") {
      throw new Error(`Unexpected recovery request: ${request.method}`);
    }
    recoveryApprovalReplayed = true;
    return adapted.createCodexResponse({ kind: "approval", decision: "deny" });
  });
  await recovery.start();
  await recovery.initialize({
    name: "yurupager-crash-window-recovery",
    version: "0.0.1",
  });
  await recovery.request("thread/resume", {
    threadId,
    excludeTurns: true,
  });
  await withTimeout(completion, 120_000);
  await delay(500);
  const thread = await recovery.request<unknown>("thread/read", {
    threadId,
    includeTurns: true,
  });
  const turnSummaries = readTurnSummaries(thread);
  const executionCount = await countExecutions(executionLog);
  const hasCompletedTurn = turnSummaries.some(
    (turn) => turn.status === "completed",
  );
  const threadHistoryContainsCommandExecution = turnSummaries.some((turn) =>
    turn.items.some((item) => item.type === "commandExecution"),
  );
  const finalRecord = journal.get(requestId);
  const result = {
    passed:
      workerExit.code === 86 &&
      persistedDecision?.decision === "approve" &&
      ambiguousRecord?.state === "sent_unknown" &&
      ambiguousRecord.attemptCount === 1 &&
      retryBlocked &&
      !recoveryApprovalReplayed &&
      hasCompletedTurn &&
      executionCount === 1 &&
      !threadHistoryContainsCommandExecution &&
      finalRecord?.state === "sent_unknown",
    experimentCompleted: true,
    threadId,
    requestId,
    injectedExitCode: workerExit.code,
    responseSubmittedBeforeCrash: true,
    persistedDecision: persistedDecision?.decision ?? null,
    stateAfterCrash: ambiguousRecord?.state ?? null,
    dispatchAttempts: ambiguousRecord?.attemptCount ?? null,
    automaticRetryBlocked: retryBlocked,
    recoveryApprovalReplayed,
    originResolvedEvents,
    turnSummaries,
    threadHistoryContainsCommandExecution,
    executionCount,
    finalDeliveryState: finalRecord?.state ?? null,
    humanConfirmationRequired: true,
    testOracle:
      "execution marker proves one execution in the Spike but is unavailable to the product",
    exactlyOnceClaim:
      "observed_once_in_this_run; end-to-end exactly-once remains unproven",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) {
    process.exitCode = 1;
  }
} finally {
  releaseOrigin?.();
  if (worker !== undefined && worker.exitCode === null) {
    await stopProcess(worker);
  }
  if (threadId.length > 0 && recovery?.running === true) {
    try {
      await recovery.request("thread/delete", { threadId });
    } catch (error) {
      process.stderr.write(
        `Unable to delete Spike thread ${threadId}: ${String(error)}\n`,
      );
    }
  }
  ledger?.close();
  journal?.close();
  await Promise.allSettled([origin.stop(), recovery?.stop()]);
  await stopProcess(server);
  await rm(directory, { recursive: true, force: true });
}

function readTurnSummaries(value: unknown): Array<{
  id: string;
  status: string;
  items: Array<{ id: string; type: string; status: string }>;
}> {
  if (!isRecord(value) || !isRecord(value.thread) || !Array.isArray(value.thread.turns)) {
    return [];
  }
  return value.thread.turns.flatMap((turn) => {
    if (!isRecord(turn) || typeof turn.id !== "string") {
      return [];
    }
    const items = Array.isArray(turn.items)
      ? turn.items.flatMap((item) => {
          if (!isRecord(item) || typeof item.id !== "string") {
            return [];
          }
          return [{
            id: item.id,
            type: typeof item.type === "string" ? item.type : "unknown",
            status: typeof item.status === "string" ? item.status : "unknown",
          }];
        })
      : [];
    return [{
      id: turn.id,
      status: typeof turn.status === "string" ? turn.status : "unknown",
      items,
    }];
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

async function waitForPort(targetPort: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`app-server exited before listening: ${serverStderr}`);
    }
    if (await canConnect(targetPort)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${webSocketUrl}`);
}

function canConnect(targetPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: targetPort });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function waitForProcessExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Child process timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
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

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Timed out after ${String(timeoutMs)}ms`)),
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
