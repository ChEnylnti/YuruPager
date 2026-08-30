import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionCommandSummary, SessionSummary, WebLiveClientMessage, WorkstationSummary } from "@yurupager/shared";

import type { DraftImageAttachment } from "../src/attachment-upload.js";
import type { uploadSessionAttachments } from "../src/attachment-upload.js";
import type { LiveChannel } from "../src/live-channel.js";
import { SessionComposer } from "../src/session-composer.js";
import type { sendSessionMessage } from "../src/api.js";

const session: SessionSummary = {
  id: "40000000-0000-4000-8000-000000000001",
  workspaceId: "20000000-0000-4000-8000-000000000002",
  workstationId: "30000000-0000-4000-8000-000000000001",
  workstationName: "Levinthal MacBook Pro",
  initiatorName: "Alice Chen",
  threadId: "thread-alpha-live",
  projectKey: "project-yurupager",
  projectName: "YuruPager",
  projectPath: "~/Documents/YuruPager",
  model: "gpt-5.6-codex",
  status: "waiting",
  syncState: "live",
  startedAt: "2026-08-06T08:00:00.000Z",
  updatedAt: "2026-08-06T08:05:00.000Z",
};
const workstation: WorkstationSummary = {
  id: session.workstationId,
  workspaceId: session.workspaceId,
  workspaceName: "Yuru Systems",
  name: session.workstationName,
  platform: "macOS",
  connectorVersion: "0.1.0-alpha",
  status: "online",
  lastSeenAt: "2026-08-06T08:05:00.000Z",
  activeSessionCount: 1,
  pendingCount: 0,
};
const queued: SessionCommandSummary = {
  id: "60000000-0000-4000-8000-000000000001",
  workspaceId: session.workspaceId,
  workstationId: session.workstationId,
  sessionId: session.id,
  actorName: "Alice Chen",
  status: "queued",
  contentLength: 24,
  attachmentCount: 0,
  turnId: null,
  errorCode: null,
  createdAt: "2026-08-06T08:06:00.000Z",
  updatedAt: "2026-08-06T08:06:00.000Z",
  deliveredAt: null,
};

describe("session message commit boundary", () => {
  let sender: ReturnType<typeof vi.fn<typeof sendSessionMessage>>;

  beforeEach(() => { sender = vi.fn<typeof sendSessionMessage>(); });

  it("queues once on a slow double submission and clears only after server acceptance", async () => {
    let resolveSend: ((value: Awaited<ReturnType<typeof sendSessionMessage>>) => void) | undefined;
    sender.mockReturnValue(new Promise((resolve) => { resolveSend = resolve; }));
    renderComposer(sender);
    const input = screen.getByLabelText("发送给 Codex");
    fireEvent.change(input, { target: { value: "Continue with focused tests." } });
    const send = screen.getByRole("button", { name: "发送消息" });
    fireEvent.click(send);
    fireEvent.click(send);

    await waitFor(() => expect(sender).toHaveBeenCalledTimes(1));
    expect(input).toHaveValue("Continue with focused tests.");
    expect(send).toBeDisabled();

    resolveSend?.({ command: queued, replayed: false });
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("keeps the original text when the server rejects the submission", async () => {
    sender.mockImplementation(() => {
      throw { code: "permission_denied" };
    });
    renderComposer(sender);
    const input = screen.getByLabelText("发送给 Codex");
    fireEvent.change(input, { target: { value: "Keep this draft on failure." } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(screen.getByText("你无权向此会话发送消息")).toBeVisible());
    expect(input).toHaveValue("Keep this draft on failure.");
  });

  it("supports an explicit keyboard submission and queues a text message for the next turn while running", async () => {
    sender.mockResolvedValue({ command: queued, replayed: false });
    const { rerender } = renderComposer(sender);
    const input = screen.getByLabelText("发送给 Codex");
    fireEvent.change(input, { target: { value: "Submit from the keyboard." } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(sender).toHaveBeenCalledTimes(1));

    sender.mockClear();
    rerender(<ComposerHost session={{ ...session, status: "running" }} sendMessage={sender} />);
    const runningInput = screen.getByLabelText("发送给 Codex");
    fireEvent.change(runningInput, { target: { value: "Queue this after the current turn." } });
    expect(screen.getByRole("button", { name: "排入下一轮" })).toBeEnabled();
    expect(screen.getByText("Codex 正在运行；文字消息会排入下一轮。")).toBeVisible();
    fireEvent.keyDown(runningInput, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(sender).toHaveBeenCalledWith(session.id, expect.any(String), "Queue this after the current turn.", []));
  });

  it("keeps attached images behind the current turn boundary", () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:queued-image") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const { container } = render(<ImageComposerHost sendMessage={sender} session={{ ...session, status: "running" }} />);
    fireEvent.change(container.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(["png"], "queued.png", { type: "image/png" })] },
    });

    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    expect(screen.getByText("Codex 正在运行；请在本轮结束后再发送图片。")).toBeVisible();
  });

  it("uploads an image-only message and clears previews only after queue acceptance", async () => {
    const createObjectURL = vi.fn(() => "blob:preview-one");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    sender.mockResolvedValue({ command: { ...queued, contentLength: 0 }, replayed: false });
    const uploader = vi.fn<typeof uploadSessionAttachments>().mockResolvedValue(["signed-ticket"]);
    const { container } = render(<ImageComposerHost sendMessage={sender} uploadAttachments={uploader} />);
    expect(screen.getByLabelText("选择要发送的图片")).toBe(container.querySelector('input[type="file"]'));
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File([new Uint8Array([137, 80, 78, 71])], "private-name.png", { type: "image/png" });
    fireEvent.change(picker!, { target: { files: [file] } });

    expect(await screen.findByAltText("待发送图片 1")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(uploader).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sender).toHaveBeenCalledWith(session.id, expect.any(String), "", ["signed-ticket"]));
    await waitFor(() => expect(screen.queryByAltText("待发送图片 1")).not.toBeInTheDocument());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-one");
  });

  it("keeps image and text drafts when upload fails", async () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview-failed") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const uploader = vi.fn<typeof uploadSessionAttachments>().mockRejectedValue(new Error("工作站拒绝图片"));
    const { container } = render(<ImageComposerHost sendMessage={sender} uploadAttachments={uploader} />);
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(picker!, { target: { files: [new File(["png"], "secret.png", { type: "image/png" })] } });
    fireEvent.change(screen.getByLabelText("发送给 Codex"), { target: { value: "请检查这张图" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(screen.getByText("工作站拒绝图片")).toBeVisible());
    expect(screen.getByLabelText("发送给 Codex")).toHaveValue("请检查这张图");
    expect(screen.getByAltText("待发送图片 1")).toBeVisible();
    expect(sender).not.toHaveBeenCalled();
  });

  it("cancels temporary image tickets when command queueing fails", async () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview-command-failed") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    sender.mockRejectedValue({ code: "permission_denied" });
    const uploader = vi.fn<typeof uploadSessionAttachments>().mockResolvedValue(["signed-ticket"]);
    const send = vi.fn((_message: WebLiveClientMessage) => true);
    const liveChannel: LiveChannel = { send, subscribe: () => () => undefined };
    const { container } = render(<ImageComposerHost sendMessage={sender} uploadAttachments={uploader} liveChannel={liveChannel} />);
    fireEvent.change(container.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File([new Uint8Array([137, 80, 78, 71])], "private.png", { type: "image/png" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(screen.getByText("你无权向此会话发送消息")).toBeVisible());
    expect(send).toHaveBeenCalledWith({
      type: "session.attachment.cancel",
      sessionId: session.id,
      uploadId: expect.any(String),
    });
    expect(screen.getByAltText("待发送图片 1")).toBeVisible();
  });

  it("cancels an in-progress upload without crossing the command boundary", async () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview-cancel") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const uploader = vi.fn<typeof uploadSessionAttachments>((_channel, _sessionId, _attachments, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }));
    const { container } = render(<ImageComposerHost sendMessage={sender} uploadAttachments={uploader} />);
    fireEvent.change(container.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(["png"], "cancel.png", { type: "image/png" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    const cancel = await screen.findByRole("button", { name: "取消上传" });
    fireEvent.click(cancel);

    await waitFor(() => expect(screen.getByText("图片上传已取消，文字和图片仍保留")).toBeVisible());
    expect(screen.getByAltText("待发送图片 1")).toBeVisible();
    expect(sender).not.toHaveBeenCalled();
  });
});

function renderComposer(sendMessage: typeof sendSessionMessage) {
  return render(<ComposerHost session={session} sendMessage={sendMessage} />);
}

function ComposerHost({ session: currentSession, sendMessage }: { session: SessionSummary; sendMessage: typeof sendSessionMessage }) {
  const [value, setValue] = useState("");
  return (
    <SessionComposer
      session={currentSession}
      workstation={workstation}
      online
      value={value}
      onChange={setValue}
      onCommandChange={vi.fn()}
      onToast={vi.fn()}
      sendMessage={sendMessage}
    />
  );
}

const channel: LiveChannel = {
  send(_message: WebLiveClientMessage) { return true; },
  subscribe() { return () => undefined; },
};

function ImageComposerHost({
  sendMessage,
  uploadAttachments,
  liveChannel = channel,
  session: currentSession = session,
}: {
  sendMessage: typeof sendSessionMessage;
  uploadAttachments?: typeof uploadSessionAttachments;
  liveChannel?: LiveChannel;
  session?: SessionSummary;
}) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<DraftImageAttachment[]>([]);
  return (
    <SessionComposer
      session={currentSession}
      workstation={workstation}
      online
      value={value}
      attachments={attachments}
      channel={liveChannel}
      onChange={setValue}
      onAttachmentsChange={setAttachments}
      onCommandChange={vi.fn()}
      onToast={vi.fn()}
      sendMessage={sendMessage}
      {...(uploadAttachments === undefined ? {} : { uploadAttachments })}
    />
  );
}
