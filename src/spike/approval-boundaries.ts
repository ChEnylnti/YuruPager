import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adaptNotification, adaptServerRequest } from "../codex/adapter.js";
import type {
  ApprovalCategory,
  ApprovalRequest,
  QuestionRequest,
} from "../codex/domain.js";
import { CodexAppServerClient } from "../codex/json-rpc-client.js";

interface ThreadStartResponse {
  thread: { id: string };
}

interface ScenarioResult {
  name: string;
  passed: boolean;
  threadId: string;
  category: ApprovalCategory | null;
  requestId: string | null;
  turnStatus: string | null;
  executionCount: number;
  detail: Record<string, unknown>;
}

const root = await mkdtemp(join(tmpdir(), "yurupager-boundaries-"));
try {
  const fileChange = await runFileChangeScenario();
  const permissions = await runPermissionsScenario();
  const cancellation = await runCancellationScenario();
  const timeout = await runTimeoutScenario();
  const scenarios = [fileChange, permissions, cancellation, timeout];
  const result = {
    passed: scenarios.every((scenario) => scenario.passed),
    experimentCompleted: true,
    scenarios,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) {
    process.exitCode = 1;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

async function runFileChangeScenario(): Promise<ScenarioResult> {
  const cwd = await mkdtemp(join(root, "file-change-"));
  const marker = join(cwd, "file-change-marker.txt");
  return runScenario({
    name: "file_change_denied",
    cwd,
    marker,
    threadParams: {
      sandbox: "read-only",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      developerInstructions:
        "Use apply_patch for the requested file change. Do not use shell commands or other tools.",
    },
    prompt:
      `Use apply_patch exactly once to create ${marker} containing one line: executed. ` +
      "If the change is denied, acknowledge the denial and finish.",
    onApproval: async (approval) => ({
      response: approval.createCodexResponse({
        kind: "approval",
        decision: "deny",
      }),
      detail: {},
    }),
    evaluate: ({ approval, executionCount, turnStatus }) =>
      approval?.domain.category === "fileChange" &&
      executionCount === 0 &&
      turnStatus === "completed",
  });
}

async function runPermissionsScenario(): Promise<ScenarioResult> {
  const cwd = await mkdtemp(join(root, "permissions-"));
  const marker = join(cwd, "permissions-marker.txt");
  return runScenario({
    name: "permissions_denied",
    cwd,
    marker,
    clientArgs: [
      "app-server",
      "--stdio",
      "--enable",
      "request_permissions_tool",
    ],
    threadParams: {
      permissions: ":read-only",
      approvalPolicy: {
        granular: {
          mcp_elicitations: false,
          request_permissions: true,
          rules: false,
          sandbox_approval: false,
          skill_approval: false,
        },
      },
      approvalsReviewer: "user",
      developerInstructions:
        "Use the request_permissions tool to request only the write access needed for the user's command.",
    },
    prompt:
      `Request write permission for ${marker}, then run exactly ` +
      `/usr/bin/printf 'executed\\n' >> ${marker}. ` +
      "If permission is denied, do not try another tool or path; acknowledge and finish.",
    onApproval: async (approval) => ({
      response: approval.createCodexResponse({
        kind: "approval",
        decision: "deny",
      }),
      detail: {
        requestedPermissions: approval.domain.context.requestedPermissions ?? null,
      },
    }),
    evaluate: ({ approval, executionCount, turnStatus }) =>
      approval?.domain.category === "permissions" &&
      executionCount === 0 &&
      turnStatus === "completed",
  });
}

async function runCancellationScenario(): Promise<ScenarioResult> {
  const cwd = await mkdtemp(join(root, "cancellation-"));
  const marker = join(cwd, "cancellation-marker.txt");
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return runScenario({
    name: "turn_interrupted_while_pending",
    cwd,
    marker,
    threadParams: commandThreadParams(),
    prompt: commandPrompt(marker),
    onApproval: async (approval, client) => {
      await client.request("turn/interrupt", {
        threadId: approval.domain.threadId,
        turnId: approval.domain.turnId,
      });
      release?.();
      await released;
      return {
        response: approval.createCodexResponse({
          kind: "approval",
          decision: "deny",
        }),
        detail: { interruptSent: true },
      };
    },
    evaluate: ({ approval, executionCount, turnStatus }) =>
      approval?.domain.category === "command" &&
      executionCount === 0 &&
      turnStatus === "interrupted",
  });
}

async function runTimeoutScenario(): Promise<ScenarioResult> {
  const cwd = await mkdtemp(join(root, "timeout-"));
  const marker = join(cwd, "timeout-marker.txt");
  const timeoutMs = 1_000;
  return runScenario({
    name: "connector_timeout_denies",
    cwd,
    marker,
    threadParams: commandThreadParams(),
    prompt: commandPrompt(marker),
    onApproval: async (approval) => {
      const startedAt = Date.now();
      await delay(timeoutMs);
      return {
        response: approval.createCodexResponse({
          kind: "approval",
          decision: "deny",
        }),
        detail: {
          timeoutOwner: "yurupager_connector",
          configuredTimeoutMs: timeoutMs,
          elapsedMs: Date.now() - startedAt,
        },
      };
    },
    evaluate: ({ approval, executionCount, turnStatus, detail }) =>
      approval?.domain.category === "command" &&
      executionCount === 0 &&
      turnStatus === "completed" &&
      typeof detail.elapsedMs === "number" &&
      detail.elapsedMs >= timeoutMs,
  });
}

function commandThreadParams(): Record<string, unknown> {
  return {
    sandbox: "read-only",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    developerInstructions:
      "Follow the user's single harmless shell command exactly and do not perform unrelated work.",
  };
}

function commandPrompt(marker: string): string {
  return (
    `Run exactly this shell command and no other command: ` +
    `/usr/bin/printf 'executed\\n' >> ${marker}. ` +
    "If approval is denied, acknowledge the denial and finish."
  );
}

interface RunScenarioOptions {
  name: string;
  cwd: string;
  marker: string;
  clientArgs?: string[];
  threadParams: Record<string, unknown>;
  prompt: string;
  onApproval(
    approval: ReturnType<typeof requireApproval>,
    client: CodexAppServerClient,
  ): Promise<{ response: unknown; detail: Record<string, unknown> }>;
  evaluate(input: {
    approval: ReturnType<typeof requireApproval> | null;
    executionCount: number;
    turnStatus: string | null;
    detail: Record<string, unknown>;
  }): boolean;
}

async function runScenario(options: RunScenarioOptions): Promise<ScenarioResult> {
  const clientOptions = {
    requestTimeoutMs: 30_000,
    ...(options.clientArgs === undefined ? {} : { args: options.clientArgs }),
  };
  const client = new CodexAppServerClient(clientOptions);
  let threadId = "";
  const observed: { approval: ReturnType<typeof requireApproval> | null } = {
    approval: null,
  };
  let turnStatus: string | null = null;
  let scenarioDetail: Record<string, unknown> = {};
  let completionResolve: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    completionResolve = resolve;
  });

  client.setServerRequestHandler(async (request) => {
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
    const approval = requireApproval(adapted);
    observed.approval = approval;
    const handled = await options.onApproval(approval, client);
    scenarioDetail = handled.detail;
    return handled.response;
  });
  client.onNotification((notification) => {
    const event = adaptNotification(notification);
    if (event?.type === "turn.completed") {
      turnStatus = event.status;
      completionResolve?.();
    }
  });

  try {
    await client.start();
    await client.initialize({
      name: `yurupager-${options.name}`,
      version: "0.0.1",
    });
    const started = await client.request<ThreadStartResponse>("thread/start", {
      cwd: options.cwd,
      ephemeral: false,
      ...options.threadParams,
    });
    threadId = started.thread.id;
    await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: options.prompt }],
    });
    await withTimeout(completion, 120_000);
    await delay(250);
    const executionCount = await countExecutions(options.marker);
    const passed = options.evaluate({
      approval: observed.approval,
      executionCount,
      turnStatus,
      detail: scenarioDetail,
    });
    return {
      name: options.name,
      passed,
      threadId,
      category: observed.approval?.domain.category ?? null,
      requestId: observed.approval?.domain.requestId ?? null,
      turnStatus,
      executionCount,
      detail: scenarioDetail,
    };
  } finally {
    if (threadId.length > 0 && client.running) {
      try {
        await client.request("thread/delete", { threadId });
      } catch (error) {
        process.stderr.write(
          `Unable to delete Spike thread ${threadId}: ${String(error)}\n`,
        );
      }
    }
    await client.stop();
  }
}

function requireApproval(
  adapted: NonNullable<ReturnType<typeof adaptServerRequest>>,
): { domain: ApprovalRequest; createCodexResponse: typeof adapted.createCodexResponse } {
  if (adapted.domain.type !== "approval.requested") {
    throw new Error("Expected an approval request");
  }
  return {
    domain: adapted.domain,
    createCodexResponse: adapted.createCodexResponse,
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
