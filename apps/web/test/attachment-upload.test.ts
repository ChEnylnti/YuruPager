import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WebLiveClientMessage, WebLiveServerMessage } from "@yurupager/shared";

import {
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  uploadSessionAttachments,
  validateDraftImages,
  type DraftImageAttachment,
} from "../src/attachment-upload.js";
import type { LiveChannel, LiveMessageHandler } from "../src/live-channel.js";

class UploadChannel implements LiveChannel {
  readonly sent: WebLiveClientMessage[] = [];
  readonly handlers = new Set<LiveMessageHandler>();
  readonly ticket = "signed-attachment-ticket";

  send(message: WebLiveClientMessage): boolean {
    this.sent.push(message);
    if (message.type === "session.attachment.begin") {
      queueMicrotask(() => this.emit({ type: "session.attachment.status", sessionId: message.sessionId, uploadId: message.uploadId, state: "accepted", nextOffset: 0 }));
    } else if (message.type === "session.attachment.chunk") {
      const nextOffset = message.offset + Buffer.from(message.data, "base64").byteLength;
      queueMicrotask(() => this.emit({ type: "session.attachment.status", sessionId: message.sessionId, uploadId: message.uploadId, state: "progress", nextOffset }));
    } else if (message.type === "session.attachment.complete") {
      queueMicrotask(() => this.emit({ type: "session.attachment.status", sessionId: message.sessionId, uploadId: message.uploadId, state: "ready", ticket: this.ticket }));
    }
    return true;
  }

  subscribe(handler: LiveMessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(message: WebLiveServerMessage): void {
    act(() => { for (const handler of this.handlers) handler(message); });
  }
}

class FailSecondUploadChannel extends UploadChannel {
  override send(message: WebLiveClientMessage): boolean {
    if (message.type === "session.attachment.begin" && message.uploadId === "upload-two") {
      this.sent.push(message);
      queueMicrotask(() => this.emit({
        type: "session.attachment.status",
        sessionId: message.sessionId,
        uploadId: message.uploadId,
        state: "failed",
        code: "connector_offline",
      }));
      return true;
    }
    return super.send(message);
  }
}

describe("browser to Connector image upload", () => {
  it("uses stop-and-wait chunks without sending the local filename", async () => {
    const channel = new UploadChannel();
    const bytes = new Uint8Array(100_000).map((_, index) => index % 251);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const attachment: DraftImageAttachment = {
      id: "upload-one",
      file: new File([bytes], "secret-project-screenshot.png", { type: "image/png" }),
      previewUrl: "blob:local-only",
    };
    const progress = vi.fn();

    await expect(uploadSessionAttachments(channel, "session-one", [attachment], new AbortController().signal, progress)).resolves.toEqual([channel.ticket]);
    const chunks = channel.sent.filter((message): message is Extract<WebLiveClientMessage, { type: "session.attachment.chunk" }> => message.type === "session.attachment.chunk");
    expect(chunks.length).toBe(3);
    expect(chunks.every((chunk) => Buffer.from(chunk.data, "base64").byteLength <= 48 * 1024)).toBe(true);
    expect(chunks.map((chunk) => chunk.offset)).toEqual([0, 48 * 1024, 96 * 1024]);
    expect(JSON.stringify(channel.sent)).not.toContain("secret-project-screenshot.png");
    expect(progress).toHaveBeenCalled();
  });

  it("enforces MIME, count, per-image and total limits before upload", () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn((file: File) => `blob:${file.size}`) });
    const invalid = validateDraftImages([], [new File(["svg"], "x.svg", { type: "image/svg+xml" })]);
    expect(invalid.error).toContain("PNG");
    expect(invalid.accepted).toHaveLength(0);

    const tooLarge = validateDraftImages([], [new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "x.png", { type: "image/png" })]);
    expect(tooLarge.error).toContain("5 MiB");

    const current = Array.from({ length: 4 }, (_, index): DraftImageAttachment => ({
      id: `existing-${index}`,
      file: new File([new Uint8Array(1)], `${index}.png`, { type: "image/png" }),
      previewUrl: `blob:${index}`,
    }));
    expect(validateDraftImages(current, [new File(["x"], "fifth.png", { type: "image/png" })]).error).toContain("4 张");

    const first: DraftImageAttachment = {
      id: "large-existing",
      file: new File([new Uint8Array(MAX_TOTAL_IMAGE_BYTES - MAX_IMAGE_BYTES + 1)], "first.png", { type: "image/png" }),
      previewUrl: "blob:first",
    };
    expect(validateDraftImages([first], [new File([new Uint8Array(MAX_IMAGE_BYTES)], "second.png", { type: "image/png" })]).error).toContain("12 MiB");
  });

  it("rejects a forged browser MIME before opening an upload", async () => {
    const channel = new UploadChannel();
    const attachment: DraftImageAttachment = {
      id: "forged-image",
      file: new File(["not a png"], "forged.png", { type: "image/png" }),
      previewUrl: "blob:forged",
    };

    await expect(uploadSessionAttachments(
      channel,
      "session-one",
      [attachment],
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "invalid_image_type" });
    expect(channel.sent).toHaveLength(0);
  });

  it("cancels earlier temporary uploads when a later image fails", async () => {
    const channel = new FailSecondUploadChannel();
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const attachments: DraftImageAttachment[] = ["upload-one", "upload-two"].map((id) => ({
      id,
      file: new File([bytes], `${id}.png`, { type: "image/png" }),
      previewUrl: `blob:${id}`,
    }));

    await expect(uploadSessionAttachments(
      channel,
      "session-one",
      attachments,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "connector_offline" });

    const cancelled = channel.sent
      .filter((message): message is Extract<WebLiveClientMessage, { type: "session.attachment.cancel" }> => message.type === "session.attachment.cancel")
      .map((message) => message.uploadId);
    expect(cancelled).toEqual(["upload-one", "upload-two"]);
  });
});
