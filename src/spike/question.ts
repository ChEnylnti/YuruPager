import { adaptNotification, adaptServerRequest } from "../codex/adapter.js";
import type {
  DomainEvent,
  DomainRequest,
  QuestionRequest,
} from "../codex/domain.js";
import { isRecord, requireString } from "../codex/guards.js";
import { CodexAppServerClient } from "../codex/json-rpc-client.js";
import { TokenUsageAccumulator } from "../reliability/token-accumulator.js";

interface ThreadStartResponse {
  thread: {
    id: string;
  };
}

const client = new CodexAppServerClient({
  args: [
    "app-server",
    "--stdio",
    "--enable",
    "default_mode_request_user_input",
  ],
  requestTimeoutMs: 30_000,
});
const tokenAccumulator = new TokenUsageAccumulator();
const requests: DomainRequest[] = [];
let sequence = 0;
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
      answers: answersFor(adapted.domain),
    });
  }
  return adapted.createCodexResponse({ kind: "approval", decision: "deny" });
});

client.onNotification((notification) => {
  const event = adaptNotification(notification);
  if (event === null) {
    return;
  }
  if (event.type === "token.usage.updated") {
    tokenAccumulator.ingest({
      eventId: `question:${event.threadId}:${sequence}`,
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
    title: "YuruPager Question Spike",
    version: "0.0.1",
  });

  const thread = await client.request<ThreadStartResponse>("thread/start", {
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    developerInstructions:
      "When the user asks you to ask a question, call request_user_input exactly once before replying. Do not use any other tool.",
  });
  threadId = thread.thread.id;
  const turn = await client.request<unknown>("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text: "Use request_user_input to ask which deployment environment I prefer. Offer Staging and Production. After receiving the answer, acknowledge it and finish.",
      },
    ],
    approvalPolicy: "never",
  });
  if (isRecord(turn) && isRecord(turn.turn)) {
    turnId = requireString(turn.turn, "id");
  }

  const completedEvent = await withTimeout(completion, 120_000);
  if (completedEvent.type !== "turn.completed") {
    throw new Error("Expected a turn completion event");
  }
  const questionRequests = requests.filter(
    (request) => request.type === "question.requested",
  );
  const usage = tokenAccumulator.get(threadId);
  const finalizedUsage =
    usage === undefined
      ? undefined
      : tokenAccumulator.finalizeTurn(threadId, completedEvent.turnId);
  const result = {
    passed: questionRequests.length === 1 && finalizedUsage !== undefined,
    threadId,
    turnId,
    turnStatus: completedEvent.status,
    questionCount: questionRequests.length,
    questions: questionRequests.flatMap((request) => request.questions),
    suppliedAnswer: "Staging",
    tokenUsage: finalizedUsage?.total ?? null,
    tokenQuality: finalizedUsage?.quality ?? "missing",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) {
    process.exitCode = 1;
  }
} finally {
  await client.stop();
}

function answersFor(request: QuestionRequest): Record<string, string[]> {
  return Object.fromEntries(
    request.questions.map((question) => [question.id, ["Staging"]]),
  );
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

