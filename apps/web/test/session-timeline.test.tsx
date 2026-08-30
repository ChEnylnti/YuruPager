import { createHash } from "node:crypto";

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WebLiveClientMessage, WebLiveServerMessage } from "@yurupager/shared";

import type { LiveChannel, LiveMessageHandler } from "../src/live-channel.js";
import { initialTimelineState, SessionTimeline, timelineReducer } from "../src/session-timeline.js";

class FakeLiveChannel implements LiveChannel {
  readonly sent: WebLiveClientMessage[] = [];
  readonly handlers = new Set<LiveMessageHandler>();
  open = true;

  send(message: WebLiveClientMessage): boolean {
    if (!this.open) return false;
    this.sent.push(message);
    return true;
  }

  subscribe(handler: LiveMessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(message: WebLiveServerMessage): void {
    act(() => {
      for (const handler of this.handlers) handler(message);
    });
  }
}

describe("temporary Codex session timeline", () => {
  it("retains turn states and replaces only the matching turn", () => {
    const running = timelineReducer(initialTimelineState, {
      type: "frame",
      frame: { kind: "turn.status", turnId: "turn-one", status: "in_progress" },
    });
    const completed = timelineReducer(running, {
      type: "frame",
      frame: { kind: "turn.status", turnId: "turn-one", status: "completed" },
    });
    const next = timelineReducer(completed, {
      type: "frame",
      frame: { kind: "turn.status", turnId: "turn-two", status: "in_progress" },
    });

    expect(next.turns).toEqual([
      { id: "turn-one", status: "completed" },
      { id: "turn-two", status: "in_progress" },
    ]);
  });

  it("shows the current or last turn state in the persistent toolbar", () => {
    const channel = new FakeLiveChannel();
    render(<SessionTimeline sessionId="session-one" channel={channel} serverOnline />);
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "history.start" } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "history.complete" } });

    const labels = {
      in_progress: "当前回合运行中",
      completed: "上一回合已完成",
      failed: "上一回合失败",
      interrupted: "上一回合已中断",
    } as const;
    for (const status of ["in_progress", "completed", "failed", "interrupted"] as const) {
      channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "turn.status", turnId: "turn-one", status } });
      expect(screen.getByRole("status", { name: `回合状态：${labels[status]}` })).toBeVisible();
    }
  });

  it("reconstructs history and calibrates streamed text without browser persistence", () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem });
    const channel = new FakeLiveChannel();
    render(<SessionTimeline sessionId="session-one" channel={channel} serverOnline />);
    expect(channel.sent).toContainEqual({ type: "session.stream.subscribe", sessionId: "session-one" });

    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "history.start" } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.start", messageId: "user-1", turnId: "turn-1", role: "user" } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.delta", messageId: "user-1", delta: "请继续验证" } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.complete", messageId: "user-1" } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.start", messageId: "agent-1", turnId: "turn-1", role: "assistant", phase: "final_answer" } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.delta", messageId: "agent-1", delta: "不完整" } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.reset", messageId: "agent-1" } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.delta", messageId: "agent-1", delta: "完整回复，包含很长的 command --flag=value" } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.complete", messageId: "agent-1" } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "history.complete" } });

    expect(screen.getByText("请继续验证")).toBeInTheDocument();
    expect(screen.getByText("完整回复，包含很长的 command --flag=value")).toBeInTheDocument();
    expect(screen.queryByText("不完整")).not.toBeInTheDocument();
    expect(screen.getByText("实时", { selector: ".stream-status .sr-only" })).toBeInTheDocument();
    expect(setItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("updates sanitized process activity in place and renders text before completion", () => {
    const channel = new FakeLiveChannel();
    const { container } = render(<SessionTimeline sessionId="session-one" channel={channel} serverOnline />);
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "history.start" } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "history.complete" } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "activity.upsert", activityId: "activity-one", turnId: "turn-one", activity: "command", label: "读取 main.mjs", status: "in_progress" } });
    expect(screen.getByText("正在读取 main.mjs")).toBeVisible();

    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "activity.upsert", activityId: "activity-one", turnId: "turn-one", activity: "command", label: "读取 main.mjs", status: "completed" } });
    expect(screen.getByText("已读取 main.mjs")).toBeVisible();
    expect(container.querySelectorAll('[data-activity-id="activity-one"]')).toHaveLength(1);

    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.start", messageId: "agent-live", turnId: "turn-one", role: "assistant", phase: "commentary" } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.delta", messageId: "agent-live", delta: "正在检查" } });
    expect(screen.getByText("正在检查")).toBeVisible();
    expect(screen.getByLabelText("正在回复")).toBeVisible();
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.delta", messageId: "agent-live", delta: "页面" } });
    expect(screen.getByText("正在检查页面")).toBeVisible();
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.complete", messageId: "agent-live" } });
    expect(screen.queryByLabelText("正在回复")).not.toBeInTheDocument();
  });

  it("unsubscribes and clears the old conversation on rapid session changes", () => {
    const channel = new FakeLiveChannel();
    const view = render(<SessionTimeline sessionId="session-one" channel={channel} serverOnline />);
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.start", messageId: "agent-old", turnId: "turn-old", role: "assistant" } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.delta", messageId: "agent-old", delta: "旧会话正文" } });
    expect(screen.getByText("旧会话正文")).toBeInTheDocument();

    view.rerender(<SessionTimeline sessionId="session-two" channel={channel} serverOnline />);
    expect(channel.sent).toContainEqual({ type: "session.stream.unsubscribe", sessionId: "session-one" });
    expect(channel.sent).toContainEqual({ type: "session.stream.subscribe", sessionId: "session-two" });
    expect(screen.queryByText("旧会话正文")).not.toBeInTheDocument();

    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.delta", messageId: "agent-old", delta: "不应写入" } });
    expect(screen.queryByText(/不应写入/)).not.toBeInTheDocument();
    channel.emit({ type: "connected", userId: "user-one" });
    expect(channel.sent.filter((message) => message.type === "session.stream.subscribe" && message.sessionId === "session-two").length).toBe(2);
  });

  it("unsubscribes and clears text when a mobile conversation returns to its list", () => {
    const channel = new FakeLiveChannel();
    const view = render(<SessionTimeline sessionId="session-one" channel={channel} serverOnline active />);
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.start", messageId: "agent-1", turnId: "turn-1", role: "assistant" } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.delta", messageId: "agent-1", delta: "仅在详情内存中可见" } });
    expect(screen.getByText("仅在详情内存中可见")).toBeInTheDocument();

    view.rerender(<SessionTimeline sessionId="session-one" channel={channel} serverOnline active={false} />);
    expect(channel.sent).toContainEqual({ type: "session.stream.unsubscribe", sessionId: "session-one" });
    expect(channel.handlers.size).toBe(0);
    expect(screen.queryByText("仅在详情内存中可见")).not.toBeInTheDocument();
  });

  it("drops stale text while offline and does not announce each delta", () => {
    const channel = new FakeLiveChannel();
    const { container } = render(<SessionTimeline sessionId="session-one" channel={channel} serverOnline />);
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.start", messageId: "agent-1", turnId: "turn-1", role: "assistant" } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.delta", messageId: "agent-1", delta: "流式片段" } });
    expect(container.querySelector("[aria-live='polite']")).toHaveTextContent("");

    channel.emit({ type: "session.stream.status", sessionId: "session-one", state: "connector_offline" });
    expect(screen.getByText("工作站离线，暂时无法读取对话")).toBeInTheDocument();
    expect(screen.queryByText("流式片段")).not.toBeInTheDocument();
    expect(container.querySelector("[aria-live='polite']")).toHaveTextContent("工作站离线，无法读取对话");
  });

  it("pauses auto-follow while the user reads earlier messages", () => {
    const channel = new FakeLiveChannel();
    render(<SessionTimeline sessionId="session-one" channel={channel} serverOnline />);
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.start", messageId: "agent-1", turnId: "turn-1", role: "assistant" } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "message.delta", messageId: "agent-1", delta: "回复" } });
    const log = screen.getByRole("log");
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    fireEvent.scroll(log);
    const latest = screen.getByRole("button", { name: "回到最新" });
    fireEvent.click(latest);
    expect(log.scrollTop).toBe(1_000);
    expect(screen.queryByRole("button", { name: "回到最新" })).not.toBeInTheDocument();
  });

  it("verifies returned image chunks, opens a modal and restores focus", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const base64 = Buffer.from(bytes).toString("base64");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const createObjectURL = vi.fn(() => "blob:yurupager-image");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const channel = new FakeLiveChannel();
    const view = render(<SessionTimeline sessionId="session-one" channel={channel} serverOnline />);

    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "history.start" } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "image.start", imageId: "image-one", turnId: "turn-one", role: "assistant", mimeType: "image/png", byteLength: bytes.byteLength } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "image.chunk", imageId: "image-one", sequence: 0, data: base64 } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "image.complete", imageId: "image-one", sha256 } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "history.complete" } });

    const open = await screen.findByRole("button", { name: "查看Codex的图片" });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    fireEvent.click(open);
    expect(screen.getByRole("dialog", { name: "查看 Codex 返回的图片" })).toBeVisible();
    expect(screen.getByRole("button", { name: "关闭图片" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(open).toHaveFocus());

    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:yurupager-image");
  });

  it("releases a ready image immediately when an error supersedes it", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const base64 = Buffer.from(bytes).toString("base64");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:failed-image") });
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const channel = new FakeLiveChannel();
    render(<SessionTimeline sessionId="session-one" channel={channel} serverOnline />);

    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "image.start", imageId: "image-one", turnId: "turn-one", role: "assistant", mimeType: "image/png", byteLength: bytes.byteLength } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "image.chunk", imageId: "image-one", sequence: 0, data: base64 } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "image.complete", imageId: "image-one", sha256 } });
    await screen.findByRole("button", { name: "查看Codex的图片" });

    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "image.error", imageId: "image-one", turnId: "turn-one", role: "assistant", code: "image_unavailable" } });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:failed-image");
    expect(screen.getByText("图片在工作站上不可用")).toBeVisible();
  });

  it("returns focus to the timeline when resync removes an open image", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const base64 = Buffer.from(bytes).toString("base64");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:resynced-image") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const channel = new FakeLiveChannel();
    render(<SessionTimeline sessionId="session-one" channel={channel} serverOnline />);

    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "image.start", imageId: "image-one", turnId: "turn-one", role: "assistant", mimeType: "image/png", byteLength: bytes.byteLength } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "image.chunk", imageId: "image-one", sequence: 0, data: base64 } });
    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "image.complete", imageId: "image-one", sha256 } });
    fireEvent.click(await screen.findByRole("button", { name: "查看Codex的图片" }));
    expect(screen.getByRole("button", { name: "关闭图片" })).toHaveFocus();

    channel.emit({ type: "session.stream.frame", sessionId: "session-one", frame: { kind: "history.start" } });
    await waitFor(() => expect(screen.getByRole("log", { name: "Codex 会话消息" })).toHaveFocus());
  });

  it("shows a failed image even when the Connector cannot emit a start frame", () => {
    const channel = new FakeLiveChannel();
    render(<SessionTimeline sessionId="session-one" channel={channel} serverOnline />);
    channel.emit({
      type: "session.stream.frame",
      sessionId: "session-one",
      frame: {
        kind: "image.error",
        imageId: "missing-local-image",
        turnId: "turn-one",
        role: "assistant",
        code: "image_unavailable",
      },
    });
    expect(screen.getByText("图片在工作站上不可用")).toBeVisible();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeVisible();
  });
});
