import assert from "node:assert/strict";
import { test } from "node:test";

import { adaptNotification, adaptServerRequest } from "../src/codex/adapter.js";

test("adapts command approval without copying unknown sensitive fields", () => {
  const adapted = adaptServerRequest({
    id: 41,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      startedAtMs: 1_700_000_000_000,
      command: "git push --force-with-lease",
      cwd: "/workspace/project",
      reason: "Requires network access",
      availableDecisions: ["accept", "decline"],
      diff: "SECRET DIFF",
      environment: { API_KEY: "SECRET" },
    },
  });

  assert.ok(adapted);
  assert.equal(adapted.domain.type, "approval.requested");
  if (adapted.domain.type !== "approval.requested") {
    throw new Error("Expected an approval request");
  }
  assert.equal(adapted.domain.category, "command");
  assert.equal(adapted.domain.context.command, "git push --force-with-lease");
  assert.equal(JSON.stringify(adapted.domain).includes("SECRET"), false);
  assert.deepEqual(
    adapted.createCodexResponse({ kind: "approval", decision: "approve" }),
    { decision: "accept" },
  );
});

test("maps denied permission request to an empty grant", () => {
  const adapted = adaptServerRequest({
    id: "permission-1",
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-2",
      startedAtMs: 1_700_000_000_000,
      cwd: "/workspace/project",
      permissions: {
        network: { enabled: true },
        fileSystem: {
          entries: [
            { access: "write", path: { type: "path", path: "/tmp/output" } },
          ],
        },
      },
    },
  });

  assert.ok(adapted);
  if (adapted.domain.type !== "approval.requested") {
    throw new Error("Expected an approval request");
  }
  assert.deepEqual(
    adapted.createCodexResponse({ kind: "approval", decision: "deny" }),
    { permissions: {}, scope: "turn" },
  );
  assert.deepEqual(adapted.domain.context.requestedPermissions, {
    network: true,
    fileSystem: [{ access: "write", path: "/tmp/output" }],
  });
});

test("adapts user questions and answer payloads", () => {
  const adapted = adaptServerRequest({
    id: 7,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-question",
      questions: [
        {
          id: "deploy",
          header: "Deploy",
          question: "Choose an environment",
          isSecret: false,
          options: [
            { label: "Staging", description: "Deploy to staging" },
          ],
        },
      ],
    },
  });

  assert.ok(adapted);
  assert.equal(adapted.domain.type, "question.requested");
  assert.deepEqual(
    adapted.createCodexResponse({
      kind: "answers",
      answers: { deploy: ["Staging"] },
    }),
    { answers: { deploy: { answers: ["Staging"] } } },
  );
});

test("adapts cumulative token usage", () => {
  const event = adaptNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        last: {
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 30,
          reasoningOutputTokens: 10,
          totalTokens: 130,
        },
        total: {
          inputTokens: 400,
          cachedInputTokens: 120,
          cacheWriteInputTokens: 5,
          outputTokens: 90,
          reasoningOutputTokens: 30,
          totalTokens: 490,
        },
        modelContextWindow: 200_000,
      },
    },
  });

  assert.ok(event);
  assert.equal(event.type, "token.usage.updated");
  assert.equal(event.usage.last.cacheWriteInputTokens, 0);
  assert.equal(event.usage.total.totalTokens, 490);
});

test("keeps request identity stable when JSON-RPC ids change", () => {
  const params = {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    startedAtMs: 1_700_000_000_000,
    command: "date",
  };
  const first = adaptServerRequest({
    id: 1,
    method: "item/commandExecution/requestApproval",
    params,
  });
  const replay = adaptServerRequest({
    id: 999,
    method: "item/commandExecution/requestApproval",
    params,
  });

  assert.ok(first);
  assert.ok(replay);
  assert.equal(first.domain.requestId, replay.domain.requestId);
});

test("maps errors without exposing raw error messages", () => {
  const event = adaptNotification({
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: {
        message: "SECRET terminal output",
        codexErrorInfo: "sandboxError",
      },
    },
  });

  assert.deepEqual(event, {
    type: "turn.failed",
    threadId: "thread-1",
    turnId: "turn-1",
    willRetry: false,
    errorCode: "sandboxError",
  });
  assert.equal(JSON.stringify(event).includes("SECRET"), false);
});

test("maps server request resolution without inventing the winning decision", () => {
  const event = adaptNotification({
    method: "serverRequest/resolved",
    params: {
      threadId: "thread-1",
      requestId: "rpc-approval-7",
      decision: "accept",
      response: "SECRET response payload",
    },
  });

  assert.deepEqual(event, {
    type: "server.request.resolved",
    threadId: "thread-1",
    rpcRequestId: "rpc-approval-7",
    decision: null,
  });
  assert.equal(JSON.stringify(event).includes("SECRET"), false);
});
