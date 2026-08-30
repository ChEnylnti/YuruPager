import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adaptNotification, adaptServerRequest } from "../codex/adapter.js";
import type {
  QuestionRequest,
  ThreadTokenUsage,
} from "../codex/domain.js";
import { isRecord } from "../codex/guards.js";
import { CodexAppServerClient } from "../codex/json-rpc-client.js";

interface ThreadStartResponse {
  thread: { id: string };
}

interface RestartedTurnSummary {
  id: string;
  status: string;
}

const directory = await mkdtemp(join(tmpdir(), "yurupager-restart-"));
const executionLog = join(directory, "execution.log");
const port = await findFreePort();
const webSocketUrl = `ws://127.0.0.1:${String(port)}`;
const phaseOneTokens: ThreadTokenUsage[] = [];
const phaseTwoTokens: ThreadTokenUsage[] = [];
let phaseOneApprovalId: string | null = null;
let phaseTwoApprovalId: string | null = null;
let phaseOneApprovalResolve: (() => void) | undefined;
const phaseOneApproval = new Promise<void>((resolve) => {
  phaseOneApprovalResolve = resolve;
});
let phaseTwoApprovalResolve: (() => void) | undefined;
const phaseTwoApproval = new Promise<void>((resolve) => {
  phaseTwoApprovalResolve = resolve;
});
let releasePhaseOne: (() => void) | undefined;
const phaseOneRelease = new Promise<void>((resolve) => {
  releasePhaseOne = resolve;
});

let firstServer: ChildProcess | undefined;
let secondServer: ChildProcess | undefined;
let firstClient: CodexAppServerClient | undefined;
let secondClient: CodexAppServerClient | undefined;
let threadId = "";
let firstServerStderr = "";
let secondServerStderr = "";
let tui: ChildProcess | undefined;
let tuiOutputTail = "";

try {
  firstServer = startServer((tail) => {
    firstServerStderr = tail;
  });
  await waitForPort(port, firstServer, () => firstServerStderr);

  firstClient = client();
  firstClient.setServerRequestHandler(async (request) => {
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
    phaseOneApprovalId = adapted.domain.requestId;
    phaseOneApprovalResolve?.();
    await phaseOneRelease;
    return adapted.createCodexResponse({ kind: "approval", decision: "deny" });
  });
  firstClient.onNotification((notification) => {
    const event = adaptNotification(notification);
    if (event?.type === "token.usage.updated") {
      phaseOneTokens.push(event.usage);
    }
  });
  await firstClient.start();
  await firstClient.initialize({
    name: "yurupager-listener-restart-before",
    version: "0.0.1",
  });

  const started = await firstClient.request<ThreadStartResponse>(
    "thread/start",
    {
      cwd: directory,
      ephemeral: false,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "read-only",
      developerInstructions:
        "Follow the user's single harmless shell command exactly and do not perform unrelated work.",
    },
  );
  threadId = started.thread.id;
  await firstClient.request("turn/start", {
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

  await withTimeout(phaseOneApproval, 120_000);
  await stopProcess(firstServer);
  await firstClient.stop();
  firstServer = undefined;
  firstClient = undefined;

  secondServer = startServer((tail) => {
    secondServerStderr = tail;
  });
  await waitForPort(port, secondServer, () => secondServerStderr);
  secondClient = client();
  secondClient.setServerRequestHandler(async (request) => {
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
    phaseTwoApprovalId = adapted.domain.requestId;
    phaseTwoApprovalResolve?.();
    return adapted.createCodexResponse({ kind: "approval", decision: "deny" });
  });
  secondClient.onNotification((notification) => {
    const event = adaptNotification(notification);
    if (event?.type === "token.usage.updated") {
      phaseTwoTokens.push(event.usage);
    }
  });
  await secondClient.start();
  await secondClient.initialize({
    name: "yurupager-listener-restart-after",
    version: "0.0.1",
  });

  const resumeResponse = await secondClient.request<unknown>("thread/resume", {
    threadId,
    excludeTurns: false,
  });
  const approvalReplayed = await resolvesWithin(phaseTwoApproval, 5_000);
  tui = startResumeTui();
  await delay(2_000);
  const tuiResumeConnected = tui.exitCode === null && tuiOutputTail.length > 0;
  const tuiResumeState = readTuiState();
  await stopProcess(tui);
  tui = undefined;
  await delay(500);
  const executionCount = await countExecutions(executionLog);
  const resumedTurns = readTurnSummaries(resumeResponse);
  const tokenBehavior = classifyTokenBehavior(
    phaseOneTokens,
    phaseTwoTokens,
  );
  const result = {
    passed:
      executionCount === 0 &&
      phaseOneApprovalId !== null &&
      tuiResumeConnected &&
      (!approvalReplayed || phaseTwoApprovalId === phaseOneApprovalId),
    experimentCompleted: true,
    threadId,
    listenerRestarted: true,
    approvalReplayed,
    tuiResumeConnected,
    tuiResumeState,
    stableRequestId:
      approvalReplayed && phaseOneApprovalId === phaseTwoApprovalId,
    phaseOneApprovalId,
    phaseTwoApprovalId,
    resumedTurns,
    phaseOneTokenEvents: phaseOneTokens.length,
    phaseTwoTokenEvents: phaseTwoTokens.length,
    phaseOneLastTotal: phaseOneTokens.at(-1)?.total ?? null,
    phaseTwoLastTotal: phaseTwoTokens.at(-1)?.total ?? null,
    tokenBehavior,
    executionCount,
    recoveryClassification: approvalReplayed
      ? "pending_approval_replayed_and_denied"
      : "turn_interrupted_pending_approval_not_replayed",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) {
    process.exitCode = 1;
  }
} finally {
  releasePhaseOne?.();
  if (tui !== undefined) {
    await stopProcess(tui);
  }
  if (threadId.length > 0 && secondClient?.running === true) {
    try {
      await secondClient.request("thread/delete", { threadId });
    } catch (error) {
      process.stderr.write(
        `Unable to delete Spike thread ${threadId}: ${String(error)}\n`,
      );
    }
  }
  await Promise.allSettled([
    firstClient?.stop(),
    secondClient?.stop(),
  ]);
  if (firstServer !== undefined) {
    await stopProcess(firstServer);
  }
  if (secondServer !== undefined) {
    await stopProcess(secondServer);
  }
  await rm(directory, { recursive: true, force: true });
}

function startServer(onStderr: (tail: string) => void): ChildProcess {
  const child = spawn("codex", ["app-server", "--listen", webSocketUrl], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let tail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    tail = `${tail}${chunk.toString("utf8")}`.slice(-8_192);
    onStderr(tail);
  });
  return child;
}

function startResumeTui(): ChildProcess {
  const child = spawn(
    "/usr/bin/script",
    [
      "-q",
      "/dev/null",
      "codex",
      "resume",
      "--remote",
      webSocketUrl,
      "--no-alt-screen",
      threadId,
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

function readTuiState(): string {
  if (tuiOutputTail.includes("Action Required")) {
    return "action_required";
  }
  if (tuiOutputTail.includes("interrupted")) {
    return "interrupted_thread_rendered";
  }
  return tuiOutputTail.length > 0 ? "rendering" : "no_output";
}

function client(): CodexAppServerClient {
  return new CodexAppServerClient({
    webSocketUrl,
    requestTimeoutMs: 30_000,
  });
}

function readTurnSummaries(value: unknown): RestartedTurnSummary[] {
  if (!isRecord(value) || !isRecord(value.thread) || !Array.isArray(value.thread.turns)) {
    return [];
  }
  return value.thread.turns.flatMap((turn) => {
    if (!isRecord(turn) || typeof turn.id !== "string") {
      return [];
    }
    return [{
      id: turn.id,
      status: typeof turn.status === "string" ? turn.status : "unknown",
    }];
  });
}

function classifyTokenBehavior(
  before: ThreadTokenUsage[],
  after: ThreadTokenUsage[],
): string {
  const beforeTotal = before.at(-1)?.total.totalTokens;
  const afterTotal = after.at(-1)?.total.totalTokens;
  if (afterTotal === undefined) {
    return "no_token_snapshot_replayed_after_resume";
  }
  if (beforeTotal === undefined) {
    return "first_snapshot_observed_after_resume";
  }
  if (afterTotal < beforeTotal) {
    return "counter_reset";
  }
  if (afterTotal === beforeTotal) {
    return "same_cumulative_total_replayed";
  }
  return "cumulative_total_continued";
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
  targetPort: number,
  child: ChildProcess,
  stderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`app-server exited before listening: ${stderr()}`);
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

async function resolvesWithin(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
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
