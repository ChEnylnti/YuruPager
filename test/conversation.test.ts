import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  applyConversationFrames,
  conversationPatchFrames,
  chunkConversationText,
  conversationHistoryFrames,
  conversationNotificationFrames,
  conversationSnapshot,
} from "../src/codex/conversation.js";

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("conversation-image")]);

test("conversation history exposes user and assistant text plus sanitized activity", () => {
  const sensitive = "SECRET_TOOL_OUTPUT";
  const frames = conversationHistoryFrames({
    thread: {
      id: "thread-1",
      turns: [{
        id: "turn-1",
        status: "completed",
        items: [
          { id: "user-1", type: "userMessage", content: [{ type: "text", text: "请检查问题" }, { type: "localImage", path: sensitive }] },
          { id: "reason-1", type: "reasoning", summary: [sensitive], content: [sensitive] },
          { id: "tool-1", type: "commandExecution", command: `printenv ${sensitive}`, commandActions: [{ type: "read", path: "/private/project/main.mjs", command: sensitive }], status: "completed", aggregatedOutput: sensitive },
          { id: "file-1", type: "fileChange", changes: [{ diff: sensitive }] },
          { id: "mcp-1", type: "mcpToolCall", server: "browser", tool: "read_file", status: "completed", arguments: { secret: sensitive }, appContext: { appName: "浏览器", actionName: "读取文件" }, result: sensitive },
          { id: "agent-1", type: "agentMessage", text: "问题已经定位。", phase: "final_answer" },
        ],
      }],
    },
  });

  const serialized = JSON.stringify(frames);
  assert.match(serialized, /请检查问题/);
  assert.match(serialized, /问题已经定位/);
  assert.equal(serialized.includes(sensitive), false);
  assert.deepEqual(frames.filter((frame) => frame.kind === "message.start").map((frame) => frame.messageId), ["user-1", "agent-1"]);
  assert.deepEqual(
    frames.filter((frame) => frame.kind === "activity.upsert").map((frame) => frame.label),
    ["读取 main.mjs", "更新 1 个文件", "使用 浏览器 读取文件"],
  );
});

test("conversation text chunks preserve Unicode and stay within the byte limit", () => {
  const text = `${"a".repeat(13)}你好🙂${"z".repeat(21)}`;
  const chunks = chunkConversationText(text, 16);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 16));
  assert.equal(chunks.some((chunk) => chunk.includes("\ud83d") && !chunk.includes("🙂")), false);
});

test("completed agent messages reset streamed text to the exact final value", () => {
  const delta = conversationNotificationFrames({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "partial" },
  });
  const completed = conversationNotificationFrames({
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "agent-1", type: "agentMessage", text: "完整回复", phase: "final_answer" } },
  });
  assert.equal(delta?.frames[0]?.kind, "message.delta");
  assert.deepEqual(completed?.frames.map((frame) => frame.kind), ["message.start", "message.reset", "message.delta", "message.complete"]);
  assert.equal((completed?.frames[2] as { delta: string }).delta, "完整回复");
});

test("tool activity updates one sanitized row without exposing its payload", () => {
  const sensitive = "API_KEY=must-not-leave-the-workstation";
  const started = conversationNotificationFrames({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "command-1",
        type: "commandExecution",
        command: sensitive,
        commandActions: [{ type: "search", command: sensitive, query: sensitive, path: "/private/project" }],
        status: "inProgress",
      },
    },
  });
  const completed = conversationNotificationFrames({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "command-1", type: "commandExecution", command: sensitive, aggregatedOutput: sensitive, status: "completed" },
    },
  });

  assert.deepEqual(started?.frames, [{
    kind: "activity.upsert",
    activityId: "command-1",
    turnId: "turn-1",
    activity: "command",
    label: "搜索项目",
    status: "in_progress",
  }]);
  assert.equal(JSON.stringify(started).includes(sensitive), false);
  assert.equal(JSON.stringify(completed).includes(sensitive), false);
  assert.equal((completed?.frames[0] as { status?: string }).status, "completed");
});

test("snapshot polling emits only the appended assistant text", () => {
  const previous = conversationSnapshot({
    thread: { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress", items: [{ id: "agent-1", type: "agentMessage", text: "正在检查", phase: "commentary" }] }] },
  });
  const next = conversationSnapshot({
    thread: { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress", items: [{ id: "agent-1", type: "agentMessage", text: "正在检查页面", phase: "commentary" }] }] },
  });
  const frames = conversationPatchFrames(previous, next);
  assert.equal(frames.some((frame) => frame.kind === "message.reset"), false);
  assert.deepEqual(frames.filter((frame) => frame.kind === "message.delta"), [{ kind: "message.delta", messageId: "agent-1", delta: "页面" }]);
});

test("streams only official structured images without exposing local paths or generation output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-conversation-image-"));
  const path = join(directory, "PRIVATE-screen-name.png");
  await writeFile(path, PNG, { mode: 0o600 });
  try {
    const frames = conversationHistoryFrames({
      thread: {
        id: "thread-images",
        turns: [{
          id: "turn-images",
          status: "completed",
          items: [
            {
              id: "user-images",
              type: "userMessage",
              content: [
                { type: "text", text: "检查这张图片" },
                { type: "localImage", path },
                { type: "image", url: `data:image/png;base64,${PNG.toString("base64")}` },
                { type: "image", url: "https://private.example/never-fetch.png" },
              ],
            },
            {
              id: "generated-image",
              type: "imageGeneration",
              status: "completed",
              savedPath: path,
              result: "SECRET_GENERATION_TOOL_OUTPUT",
              revisedPrompt: "SECRET_REVISED_PROMPT",
            },
            { id: "viewed-image", type: "imageView", path },
          ],
        }],
      },
    });

    const serialized = JSON.stringify(frames);
    assert.equal(serialized.includes(path), false);
    assert.equal(serialized.includes("PRIVATE-screen-name"), false);
    assert.equal(serialized.includes("private.example"), false);
    assert.equal(serialized.includes("SECRET_GENERATION_TOOL_OUTPUT"), false);
    assert.equal(serialized.includes("SECRET_REVISED_PROMPT"), false);
    assert.equal(frames.filter((frame) => frame.kind === "image.start").length, 3);
    assert.equal(frames.filter((frame) => frame.kind === "image.complete").length, 3);
    assert.equal(frames.some((frame) => frame.kind === "image.error"), true);
    assert.equal(frames.filter((frame) => frame.kind === "activity.upsert" && frame.activity === "image").length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts strict MCP ImageContent for image generation and rejects enriched tool output", () => {
  const strict = conversationHistoryFrames({
    thread: {
      id: "thread-mcp-image",
      turns: [{
        id: "turn-mcp-image",
        status: "completed",
        items: [{
          id: "generated-strict",
          type: "imageGeneration",
          status: "completed",
          savedPath: null,
          result: JSON.stringify({ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }),
        }],
      }],
    },
  });
  assert.equal(strict.some((frame) => frame.kind === "image.complete"), true);

  const enriched = conversationHistoryFrames({
    thread: {
      id: "thread-mcp-image",
      turns: [{
        id: "turn-mcp-image",
        status: "completed",
        items: [{
          id: "generated-enriched",
          type: "imageGeneration",
          status: "completed",
          savedPath: null,
          result: JSON.stringify({
            type: "image",
            data: PNG.toString("base64"),
            mimeType: "image/png",
            toolOutput: "SECRET_TOOL_OUTPUT",
          }),
        }],
      }],
    },
  });
  assert.equal(enriched.some((frame) => frame.kind.startsWith("image.")), false);
  assert.equal(JSON.stringify(enriched).includes("SECRET_TOOL_OUTPUT"), false);
});

test("accepts bare Base64 and strict MCP result.content images without relaying other blocks", () => {
  const frames = conversationHistoryFrames({
    thread: {
      id: "thread-generated-results",
      turns: [{
        id: "turn-generated-results",
        status: "completed",
        items: [
          {
            id: "generated-base64",
            type: "imageGeneration",
            status: "completed",
            savedPath: null,
            result: PNG.toString("base64"),
          },
          {
            id: "generated-mcp-result",
            type: "imageGeneration",
            status: "completed",
            savedPath: null,
            revisedPrompt: "SECRET_RESULT_PROMPT",
            result: JSON.stringify({
              content: [
                { type: "text", text: "SECRET_MCP_TEXT" },
                { type: "resource_link", uri: "file:///PRIVATE/result.png", name: "PRIVATE_FILE_NAME" },
                { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
                { type: "image", data: PNG.toString("base64"), mimeType: "image/png", path: "/PRIVATE/path.png" },
              ],
              structuredContent: { prompt: "SECRET_STRUCTURED_OUTPUT" },
            }),
          },
        ],
      }],
    },
  });
  assert.equal(frames.filter((frame) => frame.kind === "image.start").length, 2);
  assert.equal(frames.filter((frame) => frame.kind === "image.complete").length, 2);
  const serialized = JSON.stringify(frames);
  assert.equal(serialized.includes("SECRET_MCP_TEXT"), false);
  assert.equal(serialized.includes("PRIVATE_FILE_NAME"), false);
  assert.equal(serialized.includes("SECRET_RESULT_PROMPT"), false);
  assert.equal(serialized.includes("SECRET_STRUCTURED_OUTPUT"), false);
  assert.equal(serialized.includes("/PRIVATE/path.png"), false);
});

test("image errors carry real item identity and create a failed snapshot without fake metadata", () => {
  const frames = conversationHistoryFrames({
    thread: {
      id: "thread-image-error",
      turns: [{
        id: "turn-image-error",
        status: "completed",
        items: [{
          id: "user-image-error",
          type: "userMessage",
          content: [{ type: "image", url: "https://private.example/not-fetched.png" }],
        }],
      }],
    },
  });
  const error = frames.find((frame) => frame.kind === "image.error");
  assert.deepEqual(error, {
    kind: "image.error",
    imageId: createImageId("user-image-error", "input:0"),
    turnId: "turn-image-error",
    role: "user",
    code: "image_invalid",
  });
  assert.equal(frames.some((frame) => frame.kind === "image.start"), false);
  assert.ok(error?.kind === "image.error");
  const snapshot = applyConversationFrames({ threadId: "thread-image-error", entries: [] }, [error]);
  const image = snapshot.entries.find((entry) => entry.kind === "image");
  assert.equal(image?.kind === "image" && image.errorCode, "image_invalid");
});

test("emits 48 KiB image chunks with stable sequence and detects duplicate frames", () => {
  const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(100 * 1024, 0x41)]);
  const frames = conversationHistoryFrames({
    thread: {
      id: "thread-large-image",
      turns: [{
        id: "turn-large-image",
        status: "completed",
        items: [{
          id: "user-large-image",
          type: "userMessage",
          content: [{ type: "image", url: `data:image/png;base64,${bytes.toString("base64")}` }],
        }],
      }],
    },
  });
  const chunks = frames.filter((frame) => frame.kind === "image.chunk");
  assert.deepEqual(chunks.map((frame) => frame.sequence), [0, 1, 2]);
  assert.equal(Buffer.from(chunks[0]?.data ?? "", "base64").length, 48 * 1024);
  const start = frames.find((frame) => frame.kind === "image.start");
  assert.ok(start?.kind === "image.start");
  const duplicated = applyConversationFrames(
    { threadId: "thread-large-image", entries: [] },
    [start, chunks[0]!, chunks[0]!],
  );
  const image = duplicated.entries.find((entry) => entry.kind === "image");
  assert.equal(image?.kind === "image" && image.errorCode, "image_incomplete");
});

function createImageId(itemId: string, discriminator: string): string {
  return createHash("sha256").update(`${itemId}\0${discriminator}`).digest("hex");
}
