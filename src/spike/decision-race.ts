import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adaptNotification, adaptServerRequest } from "../codex/adapter.js";
import type {
  ApprovalDecision,
  QuestionRequest,
  TokenUsageBreakdown,
} from "../codex/domain.js";
import { CodexAppServerClient } from "../codex/json-rpc-client.js";
import { TokenUsageAccumulator } from "../reliability/token-accumulator.js";

interface ThreadStartResponse {
  thread: {
    id: string;
  };
}

interface ScenarioConfig {
  name: string;
  firstDecision: ApprovalDecision;
  lateDecision: ApprovalDecision;
  expectedExecutions: number;
}

interface ScenarioResult {
  name: string;
  passed: boolean;
  firstDecision: ApprovalDecision;
  lateDecision: ApprovalDecision;
  expectedExecutions: number;
  executionCount: number;
  threadId: string;
  requestIds: string[];
  callbackOrder: string[];
  responseOrder: string[];
  connectorResolvedNotifications: number;
  tokenUsage: TokenUsageBreakdown | null;
  tokenQuality: string;
  error?: string;
}

const configs: ScenarioConfig[] = [
  {
    name: "deny-then-late-approve",
    firstDecision: "deny",
    lateDecision: "approve",
    expectedExecutions: 0,
  },
  {
    name: "approve-then-late-deny",
    firstDecision: "approve",
    lateDecision: "deny",
    expectedExecutions: 1,
  },
];

const scenarios: ScenarioResult[] = [];
for (const config of configs) {
  try {
    scenarios.push(await runScenario(config));
  } catch (error) {
    scenarios.push({
      name: config.name,
      passed: false,
      firstDecision: config.firstDecision,
      lateDecision: config.lateDecision,
      expectedExecutions: config.expectedExecutions,
      executionCount: -1,
      threadId: "",
      requestIds: [],
      callbackOrder: [],
      responseOrder: [],
      connectorResolvedNotifications: 0,
      tokenUsage: null,
      tokenQuality: "missing",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const passed = scenarios.every((scenario) => scenario.passed);
const result = {
  passed,
  arbitration: passed ? "first-response-wins" : "unconfirmed",
  scenarios,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.passed) {
  process.exitCode = 1;
}

async function runScenario(config: ScenarioConfig): Promise<ScenarioResult> {
  const directory = await mkdtemp(join(tmpdir(), `yurupager-${config.name}-`));
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
  const tokenAccumulator = new TokenUsageAccumulator();
  const callbackOrder: string[] = [];
  const responseOrder: string[] = [];
  const requestIds: string[] = [];
  let tokenSequence = 0;
  let connectorResolvedNotifications = 0;
  let completedTurnId = "";
  let approvalObservedResolve: (() => void) | undefined;
  const approvalObserved = new Promise<void>((resolve) => {
    approvalObservedResolve = resolve;
  });
  let releaseLateResponse: (() => void) | undefined;
  const lateResponseRelease = new Promise<void>((resolve) => {
    releaseLateResponse = resolve;
  });
  let requestResolvedResolve: (() => void) | undefined;
  const requestResolved = new Promise<void>((resolve) => {
    requestResolvedResolve = resolve;
  });
  let completionResolve: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    completionResolve = resolve;
  });

  tuiClient.setServerRequestHandler(async (request) => {
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
    callbackOrder.push("tui");
    requestIds.push(adapted.domain.requestId);
    approvalObservedResolve?.();
    await lateResponseRelease;
    responseOrder.push(`tui:${config.lateDecision}`);
    return adapted.createCodexResponse({
      kind: "approval",
      decision: config.lateDecision,
    });
  });
  connectorClient.setServerRequestHandler((request) => {
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
    callbackOrder.push("connector");
    requestIds.push(adapted.domain.requestId);
    responseOrder.push(`connector:${config.firstDecision}`);
    return adapted.createCodexResponse({
      kind: "approval",
      decision: config.firstDecision,
    });
  });
  connectorClient.onNotification((notification) => {
    if (notification.method === "serverRequest/resolved") {
      connectorResolvedNotifications += 1;
      requestResolvedResolve?.();
    }
    const event = adaptNotification(notification);
    if (event?.type === "token.usage.updated") {
      tokenAccumulator.ingest({
        eventId: `${config.name}:${String(tokenSequence)}`,
        sequence: tokenSequence++,
        threadId: event.threadId,
        turnId: event.turnId,
        usage: event.usage,
        observedAt: new Date().toISOString(),
      });
    } else if (event?.type === "turn.completed") {
      completedTurnId = event.turnId;
      completionResolve?.();
    }
  });

  let threadId = "";
  try {
    await waitForPort(port, server, () => serverStderr);
    await Promise.all([tuiClient.start(), connectorClient.start()]);
    await Promise.all([
      tuiClient.initialize({
        name: `yurupager-race-tui-${config.name}`,
        version: "0.0.1",
      }),
      connectorClient.initialize({
        name: `yurupager-race-connector-${config.name}`,
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
    await connectorClient.request("thread/resume", {
      threadId,
      excludeTurns: true,
    });
    await withTimeout(requestResolved, 30_000);
    await delay(250);
    releaseLateResponse?.();
    await withTimeout(completion, 120_000);
    await delay(500);

    const executionCount = await countExecutions(executionLog);
    const uniqueRequestIds = [...new Set(requestIds)];
    const usage = tokenAccumulator.get(threadId);
    const finalizedUsage =
      usage === undefined || completedTurnId.length === 0
        ? undefined
        : tokenAccumulator.finalizeTurn(threadId, completedTurnId);
    return {
      name: config.name,
      passed:
        executionCount === config.expectedExecutions &&
        uniqueRequestIds.length === 1 &&
        callbackOrder.join(",") === "tui,connector" &&
        responseOrder.join(",") ===
          `connector:${config.firstDecision},tui:${config.lateDecision}` &&
        connectorResolvedNotifications === 1 &&
        finalizedUsage?.quality === "final",
      firstDecision: config.firstDecision,
      lateDecision: config.lateDecision,
      expectedExecutions: config.expectedExecutions,
      executionCount,
      threadId,
      requestIds: uniqueRequestIds,
      callbackOrder,
      responseOrder,
      connectorResolvedNotifications,
      tokenUsage: finalizedUsage?.total ?? null,
      tokenQuality: finalizedUsage?.quality ?? "missing",
    };
  } finally {
    releaseLateResponse?.();
    if (threadId.length > 0 && tuiClient.running) {
      try {
        await tuiClient.request("thread/delete", { threadId });
      } catch (error) {
        process.stderr.write(
          `Unable to delete race Spike thread ${threadId}: ${String(error)}\n`,
        );
      }
    }
    await Promise.allSettled([tuiClient.stop(), connectorClient.stop()]);
    await stopProcess(server);
    await rm(directory, { recursive: true, force: true });
  }
}

function sharedClient(url: string): CodexAppServerClient {
  return new CodexAppServerClient({
    webSocketUrl: url,
    requestTimeoutMs: 30_000,
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
  readStderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Shared app-server exited before listening: ${readStderr()}`,
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
