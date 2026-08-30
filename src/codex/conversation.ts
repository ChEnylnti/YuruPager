import { createHash } from "node:crypto";
import { basename } from "node:path";

import type {
  ConversationActivityKind,
  ConversationActivityStatus,
  ConversationMessagePhase,
  ConversationTurnStatus,
  SessionStreamFrame,
} from "@yurupager/shared";

import {
  IMAGE_CHUNK_BYTES,
  MAX_IMAGE_BYTES,
  ImageMediaError,
  type ImageMimeType,
  type ValidatedImage,
  decodeDataImageUrl,
  decodeImageBase64,
  decodeStrictBase64,
  readImageMimeType,
  readLocalImage,
  validateImageBytes,
} from "./image-media.js";

const MAX_DELTA_BYTES = 16 * 1024;
type ImageFrameErrorCode = Extract<SessionStreamFrame, { kind: "image.error" }>["code"];

export interface ConversationNotificationFrames {
  threadId: string;
  frames: SessionStreamFrame[];
}

export type ConversationSnapshotEntry = ConversationMessageSnapshot | ConversationActivitySnapshot | ConversationImageSnapshot | ConversationTurnSnapshot;

export interface ConversationSnapshot {
  threadId: string;
  entries: ConversationSnapshotEntry[];
}

interface ConversationMessageSnapshot {
  kind: "message";
  id: string;
  turnId: string;
  role: "user" | "assistant";
  phase?: ConversationMessagePhase;
  text: string;
  complete: boolean;
}

interface ConversationActivitySnapshot {
  kind: "activity";
  id: string;
  turnId: string;
  activity: ConversationActivityKind;
  label: string;
  status: ConversationActivityStatus;
}

interface ConversationImageSnapshot {
  kind: "image";
  id: string;
  turnId: string;
  role: "user" | "assistant";
  mimeType?: ImageMimeType;
  byteLength: number;
  sha256: string;
  bytes: Buffer;
  complete: boolean;
  nextSequence: number;
  errorCode?: ImageFrameErrorCode;
}

interface ConversationTurnSnapshot {
  kind: "turn";
  id: string;
  status: ConversationTurnStatus;
}

export function conversationHistoryFrames(value: unknown): SessionStreamFrame[] {
  return conversationSnapshotFrames(conversationSnapshot(value));
}

export function conversationSnapshot(value: unknown): ConversationSnapshot {
  const root = readRecord(value);
  const thread = readRecord(root?.thread);
  const turns = Array.isArray(thread?.turns) ? thread.turns : null;
  if (thread === null || typeof thread.id !== "string" || turns === null) {
    throw new Error("Codex thread/read returned an invalid conversation");
  }

  const entries: ConversationSnapshotEntry[] = [];
  for (const candidate of turns) {
    const turn = readRecord(candidate);
    if (turn === null || typeof turn.id !== "string" || !Array.isArray(turn.items)) continue;
    for (const item of turn.items) {
      const message = readConversationItem(item);
      const images = readConversationImages(item, turn.id);
      if (message !== null && (message.text.length > 0 || images.length === 0)) {
        entries.push({ kind: "message", ...message, turnId: turn.id, complete: true });
      }
      entries.push(...images);
      const activity = readActivityItem(item, turn.id, "history");
      if (activity !== null) entries.push(activity);
    }
    const status = readTurnStatus(turn.status);
    if (status !== null) entries.push({ kind: "turn", id: turn.id, status });
  }
  return { threadId: thread.id, entries };
}

export function conversationSnapshotFrames(snapshot: ConversationSnapshot): SessionStreamFrame[] {
  return [
    { kind: "history.start" },
    ...snapshot.entries.flatMap(entryFrames),
    { kind: "history.complete" },
  ];
}

export function conversationPatchFrames(
  previous: ConversationSnapshot,
  next: ConversationSnapshot,
): SessionStreamFrame[] {
  if (previous.threadId !== next.threadId) return conversationSnapshotFrames(next);
  const previousByKey = new Map(previous.entries.map((entry) => [entryKey(entry), entry]));
  const nextKeys = next.entries.map(entryKey);
  const nextKeySet = new Set(nextKeys);
  const previousKeys = previous.entries.map(entryKey);
  if (previousKeys.some((key) => !nextKeySet.has(key))) return conversationSnapshotFrames(next);
  const commonNextKeys = nextKeys.filter((key) => previousByKey.has(key));
  if (commonNextKeys.some((key, index) => key !== previousKeys[index])) return conversationSnapshotFrames(next);

  const frames: SessionStreamFrame[] = [];
  for (const entry of next.entries) {
    const previousEntry = previousByKey.get(entryKey(entry));
    if (previousEntry === undefined || previousEntry.kind !== entry.kind) {
      frames.push(...entryFrames(entry));
      continue;
    }
    if (entry.kind === "activity" && previousEntry.kind === "activity") {
      if (
        entry.turnId !== previousEntry.turnId ||
        entry.activity !== previousEntry.activity ||
        entry.label !== previousEntry.label ||
        entry.status !== previousEntry.status
      ) frames.push(activityFrame(entry));
      continue;
    }
    if (entry.kind === "image" && previousEntry.kind === "image") {
      if (
        entry.turnId !== previousEntry.turnId || entry.role !== previousEntry.role ||
        entry.mimeType !== previousEntry.mimeType || entry.byteLength !== previousEntry.byteLength ||
        entry.sha256 !== previousEntry.sha256 || entry.errorCode !== previousEntry.errorCode ||
        entry.complete !== previousEntry.complete
      ) frames.push(...entryFrames(entry));
      continue;
    }
    if (entry.kind === "turn" && previousEntry.kind === "turn") {
      if (entry.status !== previousEntry.status) frames.push({ kind: "turn.status", turnId: entry.id, status: entry.status });
      continue;
    }
    if (entry.kind === "message" && previousEntry.kind === "message") {
      const metadataChanged = entry.turnId !== previousEntry.turnId || entry.role !== previousEntry.role || entry.phase !== previousEntry.phase;
      const textChanged = entry.text !== previousEntry.text;
      const completionChanged = entry.complete !== previousEntry.complete;
      if (!metadataChanged && !textChanged && !completionChanged) continue;
      frames.push(messageStart(entry));
      if (textChanged) {
        if (!metadataChanged && entry.text.startsWith(previousEntry.text)) {
          frames.push(...textDeltaFrames(entry.id, entry.text.slice(previousEntry.text.length)));
        } else {
          frames.push({ kind: "message.reset", messageId: entry.id }, ...textDeltaFrames(entry.id, entry.text));
        }
      }
      if (entry.complete) frames.push({ kind: "message.complete", messageId: entry.id });
    }
  }
  return frames;
}

export function applyConversationFrames(
  snapshot: ConversationSnapshot,
  frames: SessionStreamFrame[],
): ConversationSnapshot {
  let entries = snapshot.entries.map((entry) => ({ ...entry }));
  for (const frame of frames) {
    if (frame.kind === "history.start") {
      entries = [];
      continue;
    }
    if (frame.kind === "history.complete") continue;
    if (frame.kind === "message.start") {
      const index = entries.findIndex((entry) => entry.kind === "message" && entry.id === frame.messageId);
      const phase = frame.phase === undefined ? {} : { phase: frame.phase };
      if (index === -1) {
        entries.push({ kind: "message", id: frame.messageId, turnId: frame.turnId, role: frame.role, text: "", complete: false, ...phase });
      } else {
        const current = entries[index];
        if (current?.kind === "message") entries[index] = { ...current, turnId: frame.turnId, role: frame.role, complete: false, ...phase };
      }
      continue;
    }
    if (frame.kind === "message.reset" || frame.kind === "message.delta" || frame.kind === "message.complete") {
      const index = entries.findIndex((entry) => entry.kind === "message" && entry.id === frame.messageId);
      const current = entries[index];
      if (index === -1 || current?.kind !== "message") continue;
      if (frame.kind === "message.reset") entries[index] = { ...current, text: "", complete: false };
      else if (frame.kind === "message.delta") entries[index] = { ...current, text: `${current.text}${frame.delta}`, complete: false };
      else entries[index] = { ...current, complete: true };
      continue;
    }
    if (frame.kind === "image.start") {
      const imageFrame = frame;
      const image: ConversationImageSnapshot = {
        kind: "image",
        id: imageFrame.imageId,
        turnId: imageFrame.turnId,
        role: imageFrame.role,
        mimeType: imageFrame.mimeType,
        byteLength: imageFrame.byteLength,
        sha256: "",
        bytes: Buffer.alloc(0),
        complete: false,
        nextSequence: 0,
      };
      const index = entries.findIndex((entry) => entry.kind === "image" && entry.id === image.id);
      if (index === -1) entries.push(image);
      else entries[index] = image;
      continue;
    }
    if (frame.kind === "image.chunk") {
      const imageFrame = frame;
      const index = entries.findIndex((entry) => entry.kind === "image" && entry.id === imageFrame.imageId);
      const current = entries[index];
      if (index === -1 || current?.kind !== "image" || current.mimeType === undefined || current.complete || current.errorCode !== undefined) continue;
      try {
        if (imageFrame.sequence !== current.nextSequence) throw new ImageMediaError("invalid_image_sequence", "Image chunks are unordered");
        const remaining = current.byteLength - current.bytes.length;
        const bytes = decodeStrictBase64(imageFrame.data, Math.min(IMAGE_CHUNK_BYTES, remaining));
        entries[index] = {
          ...current,
          bytes: Buffer.concat([current.bytes, bytes]),
          nextSequence: current.nextSequence + 1,
        };
      } catch (error) {
        entries[index] = { ...current, bytes: Buffer.alloc(0), errorCode: mediaErrorCode(error) };
      }
      continue;
    }
    if (frame.kind === "image.complete") {
      const imageFrame = frame;
      const index = entries.findIndex((entry) => entry.kind === "image" && entry.id === imageFrame.imageId);
      const current = entries[index];
      if (index === -1 || current?.kind !== "image" || current.mimeType === undefined || current.errorCode !== undefined) continue;
      try {
        if (current.bytes.length !== current.byteLength) throw new ImageMediaError("invalid_image", "Image length does not match");
        const validated = validateImageBytes(current.bytes, current.mimeType, imageFrame.sha256);
        entries[index] = { ...current, sha256: validated.sha256, complete: true };
      } catch (error) {
        entries[index] = { ...current, bytes: Buffer.alloc(0), errorCode: mediaErrorCode(error) };
      }
      continue;
    }
    if (frame.kind === "image.error") {
      const imageFrame = frame;
      const index = entries.findIndex((entry) => entry.kind === "image" && entry.id === imageFrame.imageId);
      const current = entries[index];
      if (index !== -1 && current?.kind === "image") {
        entries[index] = { ...current, bytes: Buffer.alloc(0), errorCode: safeImageErrorCode(imageFrame.code) };
      } else {
        entries.push({
          kind: "image",
          id: imageFrame.imageId,
          turnId: imageFrame.turnId,
          role: imageFrame.role,
          byteLength: 0,
          sha256: "",
          bytes: Buffer.alloc(0),
          complete: false,
          nextSequence: 0,
          errorCode: safeImageErrorCode(imageFrame.code),
        });
      }
      continue;
    }
    if (frame.kind === "activity.upsert") {
      const activity: ConversationActivitySnapshot = {
        kind: "activity",
        id: frame.activityId,
        turnId: frame.turnId,
        activity: frame.activity,
        label: frame.label,
        status: frame.status,
      };
      const index = entries.findIndex((entry) => entry.kind === "activity" && entry.id === frame.activityId);
      if (index === -1) entries.push(activity);
      else entries[index] = activity;
      continue;
    }
    const turn: ConversationTurnSnapshot = { kind: "turn", id: frame.turnId, status: frame.status };
    const index = entries.findIndex((entry) => entry.kind === "turn" && entry.id === frame.turnId);
    if (index === -1) entries.push(turn);
    else entries[index] = turn;
  }
  return { ...snapshot, entries };
}

export function conversationNotificationFrames(
  notification: { method: string; params: unknown },
): ConversationNotificationFrames | null {
  const params = readRecord(notification.params);
  if (params === null || typeof params.threadId !== "string") return null;

  if (notification.method === "item/agentMessage/delta") {
    if (
      typeof params.turnId !== "string" ||
      typeof params.itemId !== "string" ||
      typeof params.delta !== "string" ||
      params.delta.length === 0
    ) return null;
    return { threadId: params.threadId, frames: textDeltaFrames(params.itemId, params.delta) };
  }

  if (notification.method === "item/started" || notification.method === "item/completed") {
    if (typeof params.turnId !== "string") return null;
    const item = readRecord(params.item);
    if (item === null) return null;
    const frames = itemFrames(item, params.turnId, notification.method === "item/completed" ? "completed" : "started");
    return frames.length === 0 ? null : { threadId: params.threadId, frames };
  }

  if (notification.method === "turn/started" || notification.method === "turn/completed") {
    const turn = readRecord(params.turn);
    if (turn === null || typeof turn.id !== "string") return null;
    const status = notification.method === "turn/started" ? "in_progress" : readTurnStatus(turn.status);
    return status === null ? null : {
      threadId: params.threadId,
      frames: [{ kind: "turn.status", turnId: turn.id, status }],
    };
  }

  return null;
}

export function chunkConversationText(text: string, maxBytes = MAX_DELTA_BYTES): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new Error("Conversation chunk size is invalid");
  if (text.length === 0) return [];
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const point of text) {
    const pointBytes = Buffer.byteLength(point, "utf8");
    if (bytes + pointBytes > maxBytes && chunk.length > 0) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += point;
    bytes += pointBytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function itemFrames(value: unknown, turnId: string, lifecycle: "started" | "completed"): SessionStreamFrame[] {
  const frames: SessionStreamFrame[] = [];
  const message = readConversationItem(value);
  const images = lifecycle === "completed" ? readConversationImages(value, turnId) : [];
  if (message !== null && (message.text.length > 0 || images.length === 0)) {
    const entry: ConversationMessageSnapshot = { kind: "message", ...message, turnId, complete: lifecycle === "completed" };
    if (lifecycle === "started") {
      const start = messageStart(entry);
      frames.push(start);
      if (message.text.length > 0) {
        frames.push({ kind: "message.reset", messageId: message.id });
        frames.push(...textDeltaFrames(message.id, message.text));
      }
    } else {
      frames.push(...entryFrames(entry));
    }
  }
  for (const image of images) frames.push(...entryFrames(image));
  const activity = readActivityItem(value, turnId, lifecycle);
  if (activity !== null) frames.push(activityFrame(activity));
  return frames;
}

function entryFrames(entry: ConversationSnapshotEntry): SessionStreamFrame[] {
  if (entry.kind === "activity") return [activityFrame(entry)];
  if (entry.kind === "image") return imageFrames(entry);
  if (entry.kind === "turn") return [{ kind: "turn.status", turnId: entry.id, status: entry.status }];
  const frames: SessionStreamFrame[] = [
    messageStart(entry),
    { kind: "message.reset", messageId: entry.id },
    ...textDeltaFrames(entry.id, entry.text),
  ];
  if (entry.complete) frames.push({ kind: "message.complete", messageId: entry.id });
  return frames;
}

function imageFrames(image: ConversationImageSnapshot): SessionStreamFrame[] {
  if (image.errorCode !== undefined) {
    return [{
      kind: "image.error",
      imageId: image.id,
      turnId: image.turnId,
      role: image.role,
      code: image.errorCode,
    }];
  }
  if (image.mimeType === undefined || image.byteLength < 1) {
    return [{ kind: "image.error", imageId: image.id, turnId: image.turnId, role: image.role, code: "image_invalid" }];
  }
  const frames: SessionStreamFrame[] = [{
    kind: "image.start",
    imageId: image.id,
    turnId: image.turnId,
    role: image.role,
    mimeType: image.mimeType,
    byteLength: image.byteLength,
  }];
  for (let offset = 0, sequence = 0; offset < image.bytes.length; offset += IMAGE_CHUNK_BYTES, sequence += 1) {
    frames.push({
      kind: "image.chunk",
      imageId: image.id,
      sequence,
      data: image.bytes.subarray(offset, offset + IMAGE_CHUNK_BYTES).toString("base64"),
    });
  }
  frames.push({ kind: "image.complete", imageId: image.id, sha256: image.sha256 });
  return frames;
}

function messageStart(message: Pick<ConversationMessageSnapshot, "id" | "turnId" | "role" | "phase">): SessionStreamFrame {
  const frame: Extract<SessionStreamFrame, { kind: "message.start" }> = {
    kind: "message.start",
    messageId: message.id,
    turnId: message.turnId,
    role: message.role,
  };
  if (message.phase !== undefined) frame.phase = message.phase;
  return frame;
}

function activityFrame(activity: ConversationActivitySnapshot): SessionStreamFrame {
  return {
    kind: "activity.upsert",
    activityId: activity.id,
    turnId: activity.turnId,
    activity: activity.activity,
    label: activity.label,
    status: activity.status,
  };
}

function textDeltaFrames(messageId: string, text: string): SessionStreamFrame[] {
  return chunkConversationText(text).map((delta) => ({ kind: "message.delta", messageId, delta }));
}

function readConversationItem(value: unknown): Omit<ConversationMessageSnapshot, "kind" | "turnId" | "complete"> | null {
  const item = readRecord(value);
  if (item === null || typeof item.id !== "string" || typeof item.type !== "string") return null;
  if (item.type === "agentMessage") {
    if (typeof item.text !== "string") return null;
    const phase = item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
    return phase === undefined
      ? { id: item.id, role: "assistant", text: item.text }
      : { id: item.id, role: "assistant", phase, text: item.text };
  }
  if (item.type !== "userMessage" || !Array.isArray(item.content)) return null;
  const text = item.content.flatMap((input) => {
    const part = readRecord(input);
    return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
  }).join("");
  return { id: item.id, role: "user", text };
}

function readConversationImages(value: unknown, turnId: string): ConversationImageSnapshot[] {
  const item = readRecord(value);
  if (item === null || typeof item.id !== "string" || typeof item.type !== "string") return [];
  if (item.type === "userMessage" && Array.isArray(item.content)) {
    const images: ConversationImageSnapshot[] = [];
    for (let index = 0; index < item.content.length; index += 1) {
      const input = readRecord(item.content[index]);
      if (input?.type === "localImage" && typeof input.path === "string") {
        const path = input.path;
        images.push(readImageSnapshot(item.id, turnId, "user", `input:${index}`, () => readLocalImage(path)));
      } else if (input?.type === "image" && typeof input.url === "string") {
        const url = input.url;
        images.push(readImageSnapshot(item.id, turnId, "user", `input:${index}`, () => decodeDataImageUrl(url)));
      }
    }
    return images;
  }
  if (item.type === "imageGeneration") {
    const itemId = item.id;
    return readGeneratedImages(item).map((source, index) =>
      readImageSnapshot(itemId, turnId, "assistant", `generation:${index}`, source));
  }
  return [];
}

function readGeneratedImages(item: Record<string, unknown>): Array<() => ValidatedImage> {
  const result = readStrictGeneratedImageResult(item.result);
  if (typeof item.savedPath === "string") {
    try {
      const image = readLocalImage(item.savedPath);
      return [() => image];
    } catch (error) {
      return result.length > 0 ? result : [() => { throw error; }];
    }
  }
  return result;
}

function readStrictGeneratedImageResult(value: unknown): Array<() => ValidatedImage> {
  if (typeof value !== "string" || value.length === 0) return [];
  if (value.startsWith("data:")) {
    return [() => decodeDataImageUrl(value)];
  }
  try {
    const bare = validateImageBytes(decodeStrictBase64(value, MAX_IMAGE_BYTES));
    return [() => bare];
  } catch {
    // Continue only with a structured MCP result; arbitrary text is not media.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  const direct = readStrictMcpImageContent(parsed);
  if (direct !== null) return [direct];
  const result = readRecord(parsed);
  if (result === null || !Array.isArray(result.content)) return [];
  const images: Array<() => ValidatedImage> = [];
  for (const candidate of result.content) {
    const image = readStrictMcpImageContent(candidate);
    if (image !== null) images.push(image);
  }
  return images;
}

function readStrictMcpImageContent(value: unknown): (() => ValidatedImage) | null {
  const content = readRecord(value);
  if (content === null || content.type !== "image") return null;
  const keys = Object.keys(content).sort();
  if (
    keys.length !== 3 || keys[0] !== "data" || keys[1] !== "mimeType" || keys[2] !== "type" ||
    typeof content.data !== "string" || typeof content.mimeType !== "string"
  ) return null;
  const data = content.data;
  const mimeType = content.mimeType;
  return () => decodeImageBase64(data, readImageMimeType(mimeType));
}

function readImageSnapshot(
  itemId: string,
  turnId: string,
  role: "user" | "assistant",
  discriminator: string,
  read: () => ValidatedImage,
): ConversationImageSnapshot {
  const id = createHash("sha256").update(`${itemId}\0${discriminator}`).digest("hex");
  try {
    const image = read();
    return {
      kind: "image",
      id,
      turnId,
      role,
      mimeType: image.mimeType,
      byteLength: image.byteLength,
      sha256: image.sha256,
      bytes: image.bytes,
      complete: true,
      nextSequence: Math.ceil(image.byteLength / IMAGE_CHUNK_BYTES),
    };
  } catch (error) {
    return {
      kind: "image",
      id,
      turnId,
      role,
      byteLength: 0,
      sha256: "",
      bytes: Buffer.alloc(0),
      complete: false,
      nextSequence: 0,
      errorCode: mediaErrorCode(error),
    };
  }
}

function mediaErrorCode(error: unknown): ImageFrameErrorCode {
  return error instanceof ImageMediaError ? safeImageErrorCode(error.code) : "image_unavailable";
}

function safeImageErrorCode(value: string): ImageFrameErrorCode {
  const translations: Record<string, ImageFrameErrorCode> = {
    hash_mismatch: "image_hash_mismatch",
    image_hash_mismatch: "image_hash_mismatch",
    image_too_large: "image_too_large",
    image_unavailable: "image_unavailable",
    invalid_image: "image_invalid",
    image_invalid: "image_invalid",
    invalid_image_sequence: "image_incomplete",
    image_incomplete: "image_incomplete",
    unsupported_image_type: "image_invalid",
  };
  return translations[value] ?? "image_unavailable";
}

function readActivityItem(
  value: unknown,
  turnId: string,
  lifecycle: "history" | "started" | "completed",
): ConversationActivitySnapshot | null {
  const item = readRecord(value);
  if (item === null || typeof item.id !== "string" || typeof item.type !== "string") return null;
  const fallbackStatus: ConversationActivityStatus = lifecycle === "started" ? "in_progress" : "completed";
  const status = readActivityStatus(item.status) ?? fallbackStatus;
  const base = { kind: "activity" as const, id: item.id, turnId, status };

  if (item.type === "commandExecution") {
    return { ...base, activity: "command", label: commandActivityLabel(item) };
  }
  if (item.type === "fileChange") {
    const count = Array.isArray(item.changes) ? item.changes.length : 0;
    return { ...base, activity: "file_change", label: count > 0 ? `更新 ${count} 个文件` : "更新文件" };
  }
  if (item.type === "mcpToolCall") {
    return { ...base, activity: "tool", label: toolActivityLabel(item, "调用工具") };
  }
  if (item.type === "dynamicToolCall") {
    return { ...base, activity: "tool", label: namedToolActivityLabel(item.namespace, item.tool, "调用工具") };
  }
  if (item.type === "collabAgentToolCall") {
    const labels: Record<string, string> = {
      spawnAgent: "创建协作任务",
      sendInput: "更新协作任务",
      resumeAgent: "恢复协作任务",
      wait: "等待协作任务",
      closeAgent: "关闭协作任务",
    };
    return { ...base, activity: "collaboration", label: typeof item.tool === "string" ? labels[item.tool] ?? "处理协作任务" : "处理协作任务" };
  }
  if (item.type === "subAgentActivity") {
    const labels: Record<string, string> = { started: "启动协作任务", interacted: "处理协作任务", interrupted: "中断协作任务" };
    const itemStatus: ConversationActivityStatus = item.kind === "interrupted" ? "cancelled" : status;
    return { ...base, status: itemStatus, activity: "collaboration", label: typeof item.kind === "string" ? labels[item.kind] ?? "处理协作任务" : "处理协作任务" };
  }
  if (item.type === "webSearch") return { ...base, activity: "web_search", label: "搜索网页" };
  if (item.type === "imageView") return { ...base, activity: "image", label: "查看图片" };
  if (item.type === "imageGeneration") return { ...base, activity: "image", label: "生成图片" };
  if (item.type === "sleep") return { ...base, activity: "wait", label: "等待外部状态" };
  if (item.type === "enteredReviewMode") return { ...base, activity: "review", label: "进入代码审查" };
  if (item.type === "exitedReviewMode") return { ...base, activity: "review", label: "完成代码审查" };
  if (item.type === "contextCompaction") return { ...base, activity: "context_compaction", label: "压缩上下文" };
  return null;
}

function commandActivityLabel(item: Record<string, unknown>): string {
  const action = Array.isArray(item.commandActions) ? readRecord(item.commandActions[0]) : null;
  if (action?.type === "read") {
    const name = typeof action.path === "string" ? safeActivityPart(basename(action.path)) : null;
    return name === null ? "读取文件" : `读取 ${name}`;
  }
  if (action?.type === "listFiles") return "查看文件列表";
  if (action?.type === "search") return "搜索项目";
  return "运行命令";
}

function toolActivityLabel(item: Record<string, unknown>, fallback: string): string {
  const context = readRecord(item.appContext);
  const appName = safeActivityPart(context?.appName);
  const actionName = safeActivityPart(context?.actionName);
  if (appName !== null && actionName !== null) return sanitizeActivityLabel(`使用 ${appName} ${actionName}`, fallback);
  if (appName !== null) return sanitizeActivityLabel(`使用 ${appName}`, fallback);
  return namedToolActivityLabel(item.server, item.tool, fallback);
}

function namedToolActivityLabel(namespace: unknown, tool: unknown, fallback: string): string {
  const safeNamespace = safeActivityPart(namespace);
  const safeTool = safeActivityPart(tool);
  if (safeNamespace !== null && safeTool !== null) return sanitizeActivityLabel(`使用 ${safeNamespace} ${safeTool}`, fallback);
  if (safeTool !== null) return sanitizeActivityLabel(`使用 ${safeTool}`, fallback);
  return fallback;
}

function safeActivityPart(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = sanitizeActivityLabel(value, "");
  return normalized.length === 0 ? null : Array.from(normalized).slice(0, 48).join("");
}

function sanitizeActivityLabel(value: string, fallback: string): string {
  const withoutBidi = value.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/giu, "");
  const withoutControls = withoutBidi.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  const collapsed = withoutControls.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return fallback;
  return Array.from(collapsed).slice(0, 120).join("");
}

function readActivityStatus(value: unknown): ConversationActivityStatus | null {
  if (value === "inProgress" || value === "in_progress" || value === "running") return "in_progress";
  if (value === "completed" || value === "success" || value === "succeeded") return "completed";
  if (value === "failed" || value === "error") return "failed";
  if (value === "declined" || value === "cancelled" || value === "interrupted") return "cancelled";
  return null;
}

function readTurnStatus(value: unknown): ConversationTurnStatus | null {
  if (value === "completed" || value === "failed" || value === "interrupted") return value;
  if (value === "inProgress" || value === "in_progress" || value === "running") return "in_progress";
  const record = readRecord(value);
  if (record !== null && typeof record.type === "string") return readTurnStatus(record.type);
  return null;
}

function entryKey(entry: ConversationSnapshotEntry): string {
  return `${entry.kind}:${entry.id}`;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
