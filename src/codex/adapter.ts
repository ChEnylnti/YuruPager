import { createHash } from "node:crypto";

import {
  type AdaptedRequest,
  type ApprovalCategory,
  type ApprovalContext,
  type ApprovalRequest,
  type CodexServerNotification,
  type CodexServerRequest,
  type DomainEvent,
  type DomainResponseInput,
  type QuestionRequest,
  type ThreadTokenUsage,
  type TokenUsageBreakdown,
  type UserQuestion,
} from "./domain.js";
import {
  isRecord,
  ProtocolShapeError,
  readNumber,
  readString,
  requireString,
} from "./guards.js";

const APPROVAL_METHODS: Readonly<Record<string, ApprovalCategory>> = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "fileChange",
  "item/permissions/requestApproval": "permissions",
};

export function adaptServerRequest(
  request: CodexServerRequest,
): AdaptedRequest | null {
  const category = APPROVAL_METHODS[request.method];
  if (category !== undefined) {
    return adaptApprovalRequest(request, category);
  }
  if (request.method === "item/tool/requestUserInput") {
    return adaptQuestionRequest(request);
  }
  return null;
}

export function adaptNotification(
  notification: CodexServerNotification,
): DomainEvent | null {
  if (!isRecord(notification.params)) {
    throw new ProtocolShapeError(
      `Expected params for ${notification.method} to be an object`,
    );
  }
  const params = notification.params;

  if (notification.method === "serverRequest/resolved") {
    const rpcRequestId = params.requestId;
    if (typeof rpcRequestId !== "string" && typeof rpcRequestId !== "number") {
      throw new ProtocolShapeError(
        "Expected serverRequest/resolved requestId to be a string or number",
      );
    }
    return {
      type: "server.request.resolved",
      threadId: requireString(params, "threadId"),
      rpcRequestId,
      decision: null,
    };
  }

  if (notification.method === "thread/tokenUsage/updated") {
    return {
      type: "token.usage.updated",
      threadId: requireString(params, "threadId"),
      turnId: requireString(params, "turnId"),
      usage: readThreadTokenUsage(params.tokenUsage),
    };
  }

  if (notification.method === "turn/completed") {
    if (!isRecord(params.turn)) {
      throw new ProtocolShapeError("Expected turn to be an object");
    }
    const status = readString(params.turn, "status");
    return {
      type: "turn.completed",
      threadId: requireString(params, "threadId"),
      turnId: requireString(params.turn, "id"),
      status: isTurnStatus(status) ? status : "unknown",
    };
  }

  if (notification.method === "error") {
    const error = isRecord(params.error) ? params.error : {};
    return {
      type: "turn.failed",
      threadId: requireString(params, "threadId"),
      turnId: requireString(params, "turnId"),
      willRetry: params.willRetry === true,
      errorCode: readErrorCode(error.codexErrorInfo),
    };
  }

  return null;
}

function adaptApprovalRequest(
  request: CodexServerRequest,
  category: ApprovalCategory,
): AdaptedRequest<ApprovalRequest> {
  if (!isRecord(request.params)) {
    throw new ProtocolShapeError("Expected approval params to be an object");
  }
  const params = request.params;
  const threadId = requireString(params, "threadId");
  const turnId = requireString(params, "turnId");
  const itemId = requireString(params, "itemId");
  const startedAtMs = readNumber(params, "startedAtMs");
  if (startedAtMs === undefined) {
    throw new ProtocolShapeError("Expected startedAtMs to be a number");
  }

  const domain: ApprovalRequest = {
    type: "approval.requested",
    requestId: stableRequestId(request.method, params),
    category,
    threadId,
    turnId,
    itemId,
    startedAt: new Date(startedAtMs).toISOString(),
    context: readApprovalContext(category, params),
    source: { rpcId: request.id, method: request.method },
  };

  const requestedPermissions = isRecord(params.permissions)
    ? params.permissions
    : {};
  return {
    domain,
    createCodexResponse(input) {
      assertApprovalInput(input);
      if (category === "permissions") {
        if (input.decision === "cancel") {
          throw new Error("Codex permissions requests do not expose cancel");
        }
        return {
          permissions:
            input.decision === "approve" ? requestedPermissions : {},
          scope: "turn",
        };
      }
      return {
        decision:
          input.decision === "approve"
            ? "accept"
            : input.decision === "deny"
              ? "decline"
              : "cancel",
      };
    },
  };
}

function adaptQuestionRequest(
  request: CodexServerRequest,
): AdaptedRequest<QuestionRequest> {
  if (!isRecord(request.params)) {
    throw new ProtocolShapeError("Expected question params to be an object");
  }
  const params = request.params;
  const questions = Array.isArray(params.questions)
    ? params.questions.map(readQuestion)
    : [];
  const domain: QuestionRequest = {
    type: "question.requested",
    requestId: stableRequestId(request.method, params),
    threadId: requireString(params, "threadId"),
    turnId: requireString(params, "turnId"),
    itemId: requireString(params, "itemId"),
    questions,
    source: { rpcId: request.id, method: request.method },
  };
  return {
    domain,
    createCodexResponse(input) {
      if (input.kind !== "answers") {
        throw new Error("Question request requires answers");
      }
      const answerIds = new Set(Object.keys(input.answers));
      for (const question of questions) {
        if (!answerIds.has(question.id)) {
          throw new Error(`Missing answer for question: ${question.id}`);
        }
      }
      return {
        answers: Object.fromEntries(
          Object.entries(input.answers).map(([id, answers]) => [
            id,
            { answers },
          ]),
        ),
      };
    },
  };
}

function readApprovalContext(
  category: ApprovalCategory,
  params: Record<string, unknown>,
): ApprovalContext {
  const context: ApprovalContext = {};
  const reason = readString(params, "reason");
  const cwd = readString(params, "cwd");
  if (reason !== undefined) {
    context.reason = reason;
  }
  if (cwd !== undefined) {
    context.cwd = cwd;
  }

  if (category === "command") {
    const command = readString(params, "command");
    if (command !== undefined) {
      context.command = command;
    }
    if (Array.isArray(params.availableDecisions)) {
      context.availableDecisions = params.availableDecisions.filter(
        (decision): decision is string => typeof decision === "string",
      );
    }
  } else if (category === "fileChange") {
    const grantRoot = readString(params, "grantRoot");
    if (grantRoot !== undefined) {
      context.grantRoot = grantRoot;
    }
  } else if (isRecord(params.permissions)) {
    context.requestedPermissions = summarizePermissions(params.permissions);
  }
  return context;
}

function summarizePermissions(
  permissions: Record<string, unknown>,
): NonNullable<ApprovalContext["requestedPermissions"]> {
  const summary: NonNullable<ApprovalContext["requestedPermissions"]> = {};
  if (isRecord(permissions.network) && typeof permissions.network.enabled === "boolean") {
    summary.network = permissions.network.enabled;
  }
  if (isRecord(permissions.fileSystem) && Array.isArray(permissions.fileSystem.entries)) {
    summary.fileSystem = permissions.fileSystem.entries
      .slice(0, 50)
      .flatMap((entry) => {
        if (!isRecord(entry) || !isRecord(entry.path)) {
          return [];
        }
        const access = readString(entry, "access") ?? "unknown";
        const path = summarizePath(entry.path);
        return path === undefined ? [] : [{ access, path }];
      });
  }
  return summary;
}

function summarizePath(path: Record<string, unknown>): string | undefined {
  const type = readString(path, "type");
  if (type === "path") {
    return readString(path, "path");
  }
  if (type === "glob_pattern") {
    return readString(path, "pattern");
  }
  if (type === "special" && isRecord(path.value)) {
    const kind = readString(path.value, "kind");
    return kind === undefined ? undefined : `<${kind}>`;
  }
  return undefined;
}

function readQuestion(value: unknown): UserQuestion {
  if (!isRecord(value)) {
    throw new ProtocolShapeError("Expected question to be an object");
  }
  return {
    id: requireString(value, "id"),
    header: requireString(value, "header"),
    question: requireString(value, "question"),
    isSecret: value.isSecret === true,
    options: Array.isArray(value.options)
      ? value.options.flatMap((option) => {
          if (!isRecord(option)) {
            return [];
          }
          const label = readString(option, "label");
          const description = readString(option, "description");
          return label === undefined || description === undefined
            ? []
            : [{ label, description }];
        })
      : [],
  };
}

function readThreadTokenUsage(value: unknown): ThreadTokenUsage {
  if (!isRecord(value)) {
    throw new ProtocolShapeError("Expected tokenUsage to be an object");
  }
  return {
    last: readBreakdown(value.last),
    total: readBreakdown(value.total),
    modelContextWindow:
      value.modelContextWindow === null
        ? null
        : readNumber(value, "modelContextWindow") ?? null,
  };
}

function readBreakdown(value: unknown): TokenUsageBreakdown {
  if (!isRecord(value)) {
    throw new ProtocolShapeError("Expected token usage breakdown to be an object");
  }
  const result: TokenUsageBreakdown = {
    inputTokens: requireCounter(value, "inputTokens"),
    cachedInputTokens: requireCounter(value, "cachedInputTokens"),
    cacheWriteInputTokens: readNumber(value, "cacheWriteInputTokens") ?? 0,
    outputTokens: requireCounter(value, "outputTokens"),
    reasoningOutputTokens: requireCounter(value, "reasoningOutputTokens"),
    totalTokens: requireCounter(value, "totalTokens"),
  };
  for (const counter of Object.values(result)) {
    if (!Number.isSafeInteger(counter) || counter < 0) {
      throw new ProtocolShapeError("Token counters must be non-negative integers");
    }
  }
  return result;
}

function requireCounter(value: Record<string, unknown>, key: string): number {
  const counter = readNumber(value, key);
  if (counter === undefined) {
    throw new ProtocolShapeError(`Expected ${key} to be a number`);
  }
  return counter;
}

function stableRequestId(
  method: string,
  params: Record<string, unknown>,
): string {
  const parts = [
    method,
    readString(params, "threadId") ?? "",
    readString(params, "turnId") ?? "",
    readString(params, "itemId") ?? "",
    readString(params, "approvalId") ?? "",
  ];
  return `codex_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32)}`;
}

function assertApprovalInput(
  input: DomainResponseInput,
): asserts input is Extract<DomainResponseInput, { kind: "approval" }> {
  if (input.kind !== "approval") {
    throw new Error("Approval request requires an approval decision");
  }
}

function isTurnStatus(
  value: string | undefined,
): value is "completed" | "interrupted" | "failed" | "inProgress" {
  return (
    value === "completed" ||
    value === "interrupted" ||
    value === "failed" ||
    value === "inProgress"
  );
}

function readErrorCode(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value)) {
    return Object.keys(value).sort()[0] ?? "unknown";
  }
  return "unknown";
}
