import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

import { adaptNotification, adaptServerRequest } from "../codex/adapter.js";
import type {
  ApprovalDecision,
  DomainEvent,
  DomainRequest,
  QuestionRequest,
} from "../codex/domain.js";
import { isRecord, requireString } from "../codex/guards.js";
import { CodexAppServerClient } from "../codex/json-rpc-client.js";
import { SqliteDecisionLedger } from "../reliability/sqlite-decision-ledger.js";
import { TokenUsageAccumulator } from "../reliability/token-accumulator.js";

interface ThreadStartResponse {
  thread: {
    id: string;
  };
}

const requestedDecision = readDecision(process.env.YURUPAGER_SPIKE_DECISION);
const workDirectory = await mkdtemp(join(tmpdir(), "yurupager-approval-"));
const markerPath = join(workDirectory, "approved-marker");
const client = new CodexAppServerClient({ requestTimeoutMs: 30_000 });
const decisionGate = new SqliteDecisionLedger(
  join(workDirectory, "decisions.sqlite"),
);
const tokenAccumulator = new TokenUsageAccumulator();
const events: DomainEvent[] = [];
const requests: DomainRequest[] = [];
let sequence = 0;
let idempotentReplayObserved = false;
let completionResolve: ((event: DomainEvent) => void) | undefined;
let completionReject: ((error: Error) => void) | undefined;
const completion = new Promise<DomainEvent>((resolve, reject) => {
  completionResolve = resolve;
  completionReject = reject;
});

client.setServerRequestHandler((request) => {
  const adapted = adaptServerRequest(request);
  if (adapted === null) {
    throw new Error(`Unsupported Codex server request: ${request.method}`);
  }
  requests.push(adapted.domain);

  if (adapted.domain.type === "question.requested") {
    return adapted.createCodexResponse({
      kind: "answers",
      answers: defaultAnswers(adapted.domain),
    });
  }

  decisionGate.decide(
    adapted.domain.requestId,
    `spike:${adapted.domain.requestId}`,
    requestedDecision,
  );
  idempotentReplayObserved = decisionGate.decide(
    adapted.domain.requestId,
    `spike:${adapted.domain.requestId}`,
    requestedDecision,
  ).replayed;
  return adapted.createCodexResponse({
    kind: "approval",
    decision: requestedDecision,
  });
});

client.onNotification((notification) => {
  const event = adaptNotification(notification);
  if (event === null) {
    return;
  }
  events.push(event);

  if (event.type === "token.usage.updated") {
    tokenAccumulator.ingest({
      eventId: `live:${event.threadId}:${sequence}`,
      sequence: sequence++,
      threadId: event.threadId,
      turnId: event.turnId,
      usage: event.usage,
      observedAt: new Date().toISOString(),
    });
  } else if (event.type === "turn.completed") {
    completionResolve?.(event);
  } else if (event.type === "turn.failed" && !event.willRetry) {
    completionReject?.(
      new Error(`Codex turn failed without retry: ${event.errorCode}`),
    );
  }
});

let threadId = "";
let turnId = "";
try {
  await client.start();
  await client.initialize({
    name: "yurupager-spike",
    title: "YuruPager Approval Spike",
    version: "0.0.1",
  });

  const thread = await client.request<ThreadStartResponse>("thread/start", {
    cwd: workDirectory,
    ephemeral: true,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "read-only",
    developerInstructions:
      "Follow the user's single harmless command request exactly. Use the shell tool and do not use a file editing tool or perform unrelated work.",
  });
  threadId = thread.thread.id;

  const turn = await client.request<unknown>("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text: `Run exactly this shell command and no other command: /usr/bin/printf 'executed\\n' >> ${markerPath}. If approval is denied, acknowledge the denial and finish.`,
      },
    ],
    approvalPolicy: "on-request",
  });
  if (isRecord(turn) && isRecord(turn.turn)) {
    turnId = requireString(turn.turn, "id");
  }

  const completedEvent = await withTimeout(completion, 120_000);
  if (completedEvent.type !== "turn.completed") {
    throw new Error("Expected a turn completion event");
  }

  const executionCount = await countExecutions(markerPath);
  const approvalRequests = requests.filter(
    (request) => request.type === "approval.requested",
  );
  const usage = tokenAccumulator.get(threadId);
  const finalizedUsage =
    usage === undefined
      ? undefined
      : tokenAccumulator.finalizeTurn(threadId, completedEvent.turnId);
  const expectedExecutions = requestedDecision === "approve" ? 1 : 0;

  const result = {
    passed:
      approvalRequests.length > 0 &&
      executionCount === expectedExecutions &&
      finalizedUsage !== undefined &&
      idempotentReplayObserved,
    decision: requestedDecision,
    threadId,
    turnId,
    turnStatus: completedEvent.status,
    approvalCount: approvalRequests.length,
    approvalCategories: approvalRequests.map((request) => request.category),
    executionCount,
    expectedExecutions,
    idempotentReplayObserved,
    tokenUsage: finalizedUsage?.total ?? null,
    tokenQuality: finalizedUsage?.quality ?? "missing",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (!result.passed) {
    process.exitCode = 1;
  }
} finally {
  await client.stop();
  decisionGate.close();
  await rm(workDirectory, { recursive: true, force: true });
}

function readDecision(value: string | undefined): ApprovalDecision {
  if (value === undefined || value === "deny") {
    return "deny";
  }
  if (value === "approve" || value === "cancel") {
    return value;
  }
  throw new Error(
    "YURUPAGER_SPIKE_DECISION must be approve, deny, or cancel",
  );
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
