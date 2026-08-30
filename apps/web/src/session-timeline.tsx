import {
  ArrowDown,
  Ban,
  CheckCircle2,
  Clock3,
  FilePenLine,
  Globe2,
  ImageIcon,
  ImageOff,
  LoaderCircle,
  LockKeyhole,
  MessageSquareText,
  RefreshCw,
  ScanText,
  Terminal,
  Users,
  Wrench,
  WifiOff,
  X,
  XCircle,
  ZoomIn,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type {
  ConversationTurnStatus,
  SessionStreamFrame,
  SessionStreamState,
  WebLiveServerMessage,
} from "@yurupager/shared";

import type { LiveChannel } from "./live-channel.js";
import { ImageAssemblyStore } from "./image-assembly.js";
import { MarkdownMessage } from "./markdown-message.js";
import { TransitionText } from "./transition-text.js";

export interface TimelineMessage {
  kind: "message";
  id: string;
  turnId: string;
  role: "user" | "assistant";
  phase?: "commentary" | "final_answer";
  text: string;
  complete: boolean;
}

export interface TimelineActivity {
  kind: "activity";
  id: string;
  turnId: string;
  activity: Extract<SessionStreamFrame, { kind: "activity.upsert" }>["activity"];
  label: string;
  status: Extract<SessionStreamFrame, { kind: "activity.upsert" }>["status"];
}

export interface TimelineImage {
  kind: "image";
  id: string;
  turnId: string;
  role: "user" | "assistant";
  mimeType?: "image/png" | "image/jpeg" | "image/webp";
  byteLength?: number;
  state: "loading" | "ready" | "failed";
  url?: string;
  errorCode?: string;
}

export interface TimelineTurn {
  id: string;
  status: ConversationTurnStatus;
}

export type TimelineEntry = TimelineMessage | TimelineActivity | TimelineImage;

export interface TimelineState {
  status: SessionStreamState;
  entries: TimelineEntry[];
  turns: TimelineTurn[];
  announcement: string;
}

export const initialTimelineState: TimelineState = {
  status: "loading",
  entries: [],
  turns: [],
  announcement: "",
};

type TimelineAction =
  | { type: "clear" }
  | { type: "status"; state: SessionStreamState }
  | { type: "frame"; frame: SessionStreamFrame }
  | { type: "image.ready"; imageId: string; url: string }
  | { type: "image.failed"; imageId: string; code: string };

export function timelineReducer(state: TimelineState, action: TimelineAction): TimelineState {
  if (action.type === "clear") return initialTimelineState;
  if (action.type === "image.ready" || action.type === "image.failed") {
    return {
      ...state,
      entries: state.entries.map((entry) => entry.kind !== "image" || entry.id !== action.imageId
        ? entry
        : action.type === "image.ready"
          ? readyTimelineImage(entry, action.url)
          : failedTimelineImage(entry, action.code)),
      announcement: action.type === "image.ready" ? "图片已加载" : "图片加载失败",
    };
  }
  if (action.type === "status") {
    const clearsConversation = action.state === "loading" || action.state === "connector_offline" || action.state === "denied" || action.state === "error";
    return {
      status: action.state,
      entries: clearsConversation ? [] : state.entries,
      turns: clearsConversation ? [] : state.turns,
      announcement: statusAnnouncement(action.state),
    };
  }
  const frame = action.frame;
  if (frame.kind === "history.start") return { status: "loading", entries: [], turns: [], announcement: "" };
  if (frame.kind === "history.complete") {
    return { ...state, status: "live", announcement: state.entries.length === 0 ? "会话已同步，暂无消息" : "会话已同步" };
  }
  if (frame.kind === "turn.status") {
    return { ...state, turns: updateTurn(state.turns, frame.turnId, frame.status) };
  }
  if (frame.kind === "image.start") {
    const image: TimelineImage = {
      kind: "image",
      id: frame.imageId,
      turnId: frame.turnId,
      role: frame.role,
      mimeType: frame.mimeType,
      byteLength: frame.byteLength,
      state: "loading",
    };
    const index = state.entries.findIndex((entry) => entry.kind === "image" && entry.id === frame.imageId);
    return {
      ...state,
      entries: index === -1
        ? [...state.entries, image]
        : state.entries.map((entry, entryIndex) => entryIndex === index ? image : entry),
    };
  }
  if (frame.kind === "image.error") {
    const existing = state.entries.find((entry): entry is TimelineImage =>
      entry.kind === "image" && entry.id === frame.imageId);
    const failed = existing === undefined
      ? {
          kind: "image" as const,
          id: frame.imageId,
          turnId: frame.turnId,
          role: frame.role,
          state: "failed" as const,
          errorCode: frame.code,
        }
      : failedTimelineImage(existing, frame.code);
    const index = state.entries.findIndex((entry) => entry.kind === "image" && entry.id === frame.imageId);
    return {
      ...state,
      entries: index === -1
        ? [...state.entries, failed]
        : state.entries.map((entry, entryIndex) => entryIndex === index ? failed : entry),
      announcement: "图片加载失败",
    };
  }
  if (frame.kind === "image.chunk" || frame.kind === "image.complete") return state;
  if (frame.kind === "message.start") {
    const existing = state.entries.find((entry): entry is TimelineMessage => entry.kind === "message" && entry.id === frame.messageId);
    if (existing !== undefined) {
      return {
        ...state,
        entries: updateMessage(state.entries, frame.messageId, (message) => ({
          ...message,
          turnId: frame.turnId,
          role: frame.role,
          complete: false,
          ...(frame.phase === undefined ? {} : { phase: frame.phase }),
        })),
      };
    }
    const message: TimelineMessage = {
      kind: "message",
      id: frame.messageId,
      turnId: frame.turnId,
      role: frame.role,
      text: "",
      complete: false,
      ...(frame.phase === undefined ? {} : { phase: frame.phase }),
    };
    return { ...state, entries: [...state.entries, message] };
  }
  if (frame.kind === "message.reset") {
    return { ...state, entries: updateMessage(state.entries, frame.messageId, (message) => ({ ...message, text: "", complete: false })) };
  }
  if (frame.kind === "message.delta") {
    return { ...state, entries: updateMessage(state.entries, frame.messageId, (message) => ({ ...message, text: `${message.text}${frame.delta}`, complete: false })) };
  }
  if (frame.kind === "activity.upsert") {
    const activity: TimelineActivity = {
      kind: "activity",
      id: frame.activityId,
      turnId: frame.turnId,
      activity: frame.activity,
      label: frame.label,
      status: frame.status,
    };
    const index = state.entries.findIndex((entry) => entry.kind === "activity" && entry.id === frame.activityId);
    if (index === -1) return { ...state, entries: [...state.entries, activity] };
    return { ...state, entries: state.entries.map((entry, entryIndex) => entryIndex === index ? activity : entry) };
  }
  if (frame.kind !== "message.complete") return state;
  const completed = state.entries.find((entry): entry is TimelineMessage => entry.kind === "message" && entry.id === frame.messageId);
  return {
    ...state,
    entries: updateMessage(state.entries, frame.messageId, (message) => ({ ...message, complete: true })),
    announcement: completed?.role === "assistant" ? "Codex 回复已完成" : state.announcement,
  };
}

export function SessionTimeline({
  sessionId,
  channel,
  serverOnline,
  active = true,
}: {
  sessionId: string;
  channel: LiveChannel;
  serverOnline: boolean;
  active?: boolean;
}) {
  const [state, dispatch] = useReducer(timelineReducer, initialTimelineState);
  const [following, setFollowing] = useState(true);
  const [viewer, setViewer] = useState<{ image: TimelineImage; trigger: HTMLButtonElement } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewerTriggerRef = useRef<HTMLButtonElement | null>(null);

  const restoreViewerFocus = useCallback((trigger: HTMLButtonElement) => {
    requestAnimationFrame(() => {
      if (trigger.isConnected) trigger.focus();
      else scrollRef.current?.focus();
    });
  }, []);

  const subscribe = () => {
    dispatch({ type: "status", state: "loading" });
    if (!channel.send({ type: "session.stream.subscribe", sessionId })) {
      dispatch({ type: "status", state: "error" });
    }
  };

  useEffect(() => {
    const assembly = new ImageAssemblyStore();
    const objectUrls = new Map<string, string>();
    let disposed = false;
    const releaseImage = (imageId: string) => {
      const url = objectUrls.get(imageId);
      if (url !== undefined) URL.revokeObjectURL(url);
      objectUrls.delete(imageId);
    };
    const clearImages = (restoreFocus = false) => {
      assembly.clear();
      for (const url of objectUrls.values()) URL.revokeObjectURL(url);
      objectUrls.clear();
      const trigger = viewerTriggerRef.current;
      viewerTriggerRef.current = null;
      setViewer(null);
      if (restoreFocus && trigger !== null) restoreViewerFocus(trigger);
    };
    dispatch({ type: "clear" });
    setFollowing(true);
    if (!active) return;
    const removeHandler = channel.subscribe((message: WebLiveServerMessage) => {
      if (message.type === "connected") {
        subscribe();
        return;
      }
      if (message.type === "session.stream.status" && message.sessionId === sessionId) {
        if (message.state !== "live" && message.state !== "loading") clearImages(true);
        dispatch({ type: "status", state: message.state });
      } else if (message.type === "session.stream.frame" && message.sessionId === sessionId) {
        const frame = message.frame;
        if (frame.kind === "history.start") clearImages(true);
        if (frame.kind === "image.start") {
          dispatch({ type: "frame", frame });
          releaseImage(frame.imageId);
          try { assembly.begin(frame); }
          catch (error) {
            dispatch({ type: "image.failed", imageId: frame.imageId, code: imageErrorCode(error) });
          }
          return;
        } else if (frame.kind === "image.chunk") {
          try { assembly.append(frame); }
          catch (error) {
            assembly.fail(frame.imageId);
            dispatch({ type: "image.failed", imageId: frame.imageId, code: imageErrorCode(error) });
          }
        } else if (frame.kind === "image.complete") {
          void assembly.complete(frame)
            .then(({ blob }) => {
              if (disposed) return;
              const previousUrl = objectUrls.get(frame.imageId);
              if (previousUrl !== undefined) URL.revokeObjectURL(previousUrl);
              const url = URL.createObjectURL(blob);
              objectUrls.set(frame.imageId, url);
              dispatch({ type: "image.ready", imageId: frame.imageId, url });
            })
            .catch((error: unknown) => {
              if (!disposed) dispatch({ type: "image.failed", imageId: frame.imageId, code: imageErrorCode(error) });
            });
        } else if (frame.kind === "image.error") {
          assembly.fail(frame.imageId);
          releaseImage(frame.imageId);
        }
        dispatch({ type: "frame", frame });
      }
    });
    if (serverOnline) subscribe();
    return () => {
      disposed = true;
      clearImages();
      channel.send({ type: "session.stream.unsubscribe", sessionId });
      removeHandler();
    };
  }, [active, channel, restoreViewerFocus, serverOnline, sessionId]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node !== null && following) node.scrollTop = node.scrollHeight;
  }, [following, state.entries]);

  const updateFollowing = () => {
    const node = scrollRef.current;
    if (node === null) return;
    setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight <= 72);
  };
  const jumpToLatest = () => {
    const node = scrollRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
    setFollowing(true);
  };

  const unavailable = state.status !== "live" && state.entries.length === 0;
  const latestTurn = state.turns.at(-1);
  return (
    <section className="session-timeline" aria-labelledby={`timeline-${sessionId}`}>
      <header className="timeline-toolbar">
        <div className="timeline-title"><MessageSquareText size={16} aria-hidden="true" /><h3 id={`timeline-${sessionId}`}>对话</h3></div>
        <div className="timeline-statuses" aria-label="会话状态">
          <StreamStatus status={state.status} />
          <TurnStatus turn={latestTurn} />
        </div>
      </header>
      <div
        ref={scrollRef}
        className="timeline-scroll"
        role="log"
        aria-label="Codex 会话消息"
        aria-live="off"
        tabIndex={0}
        onScroll={updateFollowing}
      >
        {unavailable ? <TimelineState status={state.status} onRetry={subscribe} /> : state.entries.length === 0 ? (
          <div className="timeline-empty"><MessageSquareText size={22} aria-hidden="true" /><p>当前会话暂无文本消息</p></div>
        ) : state.entries.map((entry) => entry.kind === "message"
          ? <MessageRow key={`message-${entry.id}`} message={entry} />
          : entry.kind === "activity"
            ? <ActivityRow key={`activity-${entry.id}`} activity={entry} />
            : <ImageRow key={`image-${entry.id}`} image={entry} onOpen={(trigger) => {
                viewerTriggerRef.current = trigger;
                setViewer({ image: entry, trigger });
              }} onRetry={subscribe} />)}
      </div>
      {!following && state.entries.length > 0 && (
        <button className="timeline-latest secondary-button" type="button" onClick={jumpToLatest}>
          <ArrowDown size={15} aria-hidden="true" />回到最新
        </button>
      )}
      <p className="sr-only" aria-live="polite" aria-atomic="true">{state.announcement}</p>
      {viewer !== null && createPortal(
        <ImageViewer image={viewer.image} onClose={() => {
          const trigger = viewerTriggerRef.current ?? viewer.trigger;
          viewerTriggerRef.current = null;
          setViewer(null);
          restoreViewerFocus(trigger);
        }} />,
        document.body,
      )}
    </section>
  );
}

function ImageRow({ image, onOpen, onRetry }: { image: TimelineImage; onOpen(trigger: HTMLButtonElement): void; onRetry(): void }) {
  const actor = image.role === "user" ? "你" : "Codex";
  return (
    <article className={`timeline-image timeline-${image.role}`} data-image-id={image.id}>
      <header><strong>{actor}</strong><span>图片</span></header>
      <div className={`timeline-image-slot image-${image.state} t-skel ${image.state === "loading" ? "" : "is-revealed"}`}>
        <div className={`timeline-image-loading t-skel-skeleton ${image.state === "loading" ? "is-pulsing" : ""}`} role={image.state === "loading" ? "status" : undefined} aria-hidden={image.state !== "loading"}>
          <ImageIcon size={22} aria-hidden="true" /><span>正在校验图片</span>
        </div>
        <div className="t-skel-content">
          {image.state === "failed" && <div className="timeline-image-error" role="status"><ImageOff size={22} aria-hidden="true" /><span>{imageErrorLabel(image.errorCode)}</span><button className="secondary-button" type="button" onClick={onRetry}><RefreshCw size={14} aria-hidden="true" />重新加载</button></div>}
          {image.state === "ready" && image.url !== undefined && (
            <button type="button" className="timeline-image-open" onClick={(event) => onOpen(event.currentTarget)} aria-label={`查看${actor}的图片`} title="查看图片">
              <img src={image.url} alt={`${actor}的图片`} />
              <span aria-hidden="true"><ZoomIn size={17} /></span>
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function ImageViewer({ image, onClose }: { image: TimelineImage; onClose(): void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  const [motionState, setMotionState] = useState<"opening" | "open" | "closing">("opening");
  onCloseRef.current = onClose;
  const requestClose = useCallback(() => {
    if (motionState === "closing") return;
    setMotionState("closing");
    closeTimer.current = window.setTimeout(
      () => onCloseRef.current(),
      prefersReducedMotion() ? 0 : cssDuration("--modal-close-dur", 150),
    );
  }, [motionState]);
  useEffect(() => {
    closeRef.current?.focus();
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      } else if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, [requestClose]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMotionState((current) => current === "opening" ? "open" : current));
    return () => {
      cancelAnimationFrame(frame);
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    };
  }, []);
  return (
    <div className="image-viewer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) requestClose();
    }}>
      <div className={`image-viewer-dialog t-modal ${motionState === "open" ? "is-open" : motionState === "closing" ? "is-closing" : ""}`} role="dialog" aria-modal="true" aria-label={image.role === "user" ? "查看你发送的图片" : "查看 Codex 返回的图片"}>
        <button ref={closeRef} className="icon-button image-viewer-close" type="button" onClick={requestClose} aria-label="关闭图片" title="关闭图片"><X size={21} aria-hidden="true" /></button>
        {image.url !== undefined && <img src={image.url} alt={image.role === "user" ? "你发送的图片" : "Codex 返回的图片"} />}
      </div>
    </div>
  );
}

const activityIcons = {
  command: Terminal,
  file_change: FilePenLine,
  tool: Wrench,
  web_search: Globe2,
  image: ImageIcon,
  collaboration: Users,
  wait: Clock3,
  review: ScanText,
  context_compaction: ScanText,
};

function ActivityRow({ activity }: { activity: TimelineActivity }) {
  const Icon = activityIcons[activity.activity];
  const label = activityStatusLabel(activity);
  const StatusIcon = activity.status === "completed"
    ? CheckCircle2
    : activity.status === "cancelled"
      ? Ban
      : XCircle;
  return (
    <div className={`timeline-activity activity-${activity.status}`} data-activity-id={activity.id} aria-label={label}>
      <span className="activity-kind-icon"><Icon size={15} aria-hidden="true" /></span>
      <span className="activity-label" title={label}>{label}</span>
      <span className="t-icon-swap" data-state={activity.status === "in_progress" ? "a" : "b"} aria-hidden="true">
        <span className="t-icon" data-icon="a"><LoaderCircle className="spinner" size={14} /></span>
        <span className="t-icon" data-icon="b"><StatusIcon size={14} /></span>
      </span>
    </div>
  );
}

function activityStatusLabel(activity: TimelineActivity): string {
  if (activity.status === "in_progress") return `正在${activity.label}`;
  if (activity.status === "completed") return `已${activity.label}`;
  if (activity.status === "cancelled") return `${activity.label}已取消`;
  return `${activity.label}失败`;
}

function MessageRow({ message }: { message: TimelineMessage }) {
  return (
    <article className={`timeline-message timeline-${message.role}`} data-message-id={message.id}>
      <header>
        <strong>{message.role === "user" ? "你" : "Codex"}</strong>
        {message.role === "assistant" && message.phase === "commentary" && <span>过程</span>}
        {!message.complete && message.role === "assistant" && <LoaderCircle className="spinner" size={13} aria-label="正在回复" />}
      </header>
      {message.role === "assistant"
        ? <MarkdownMessage source={message.text} />
        : <p className="message-plain">{message.text}</p>}
    </article>
  );
}

function StreamStatus({ status }: { status: SessionStreamState }) {
  const label = status === "live" ? "实时" : status === "loading" ? "同步中" : status === "connector_offline" ? "工作站离线" : status === "denied" ? "无权限" : "连接异常";
  return <span className={`stream-status stream-${status}`}>{status === "loading" && <LoaderCircle className="spinner" size={12} aria-hidden="true" />}<TransitionText value={label} /><span className="sr-only">{label}</span></span>;
}

function TurnStatus({ turn }: { turn: TimelineTurn | undefined }) {
  const status = turn?.status ?? "idle";
  const label = status === "in_progress"
    ? "当前回合运行中"
    : status === "completed"
      ? "上一回合已完成"
      : status === "failed"
        ? "上一回合失败"
        : status === "interrupted"
          ? "上一回合已中断"
          : "尚未开始回合";
  const Icon = status === "in_progress"
    ? LoaderCircle
    : status === "completed"
      ? CheckCircle2
      : status === "failed"
        ? XCircle
        : status === "interrupted"
          ? Ban
          : Clock3;
  return (
    <span className={`turn-status turn-${status}`} role="status" aria-label={`回合状态：${label}`}>
      <Icon className={status === "in_progress" ? "spinner" : undefined} size={12} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function TimelineState({ status, onRetry }: { status: SessionStreamState; onRetry(): void }) {
  if (status === "loading") return <div className="timeline-empty" role="status"><LoaderCircle className="spinner" size={22} aria-hidden="true" /><p>正在从工作站同步会话</p></div>;
  if (status === "connector_offline") return <div className="timeline-empty" role="status"><WifiOff size={22} aria-hidden="true" /><p>工作站离线，暂时无法读取对话</p></div>;
  if (status === "denied") return <div className="timeline-empty" role="status"><LockKeyhole size={22} aria-hidden="true" /><p>没有查看此会话的权限</p></div>;
  return <div className="timeline-empty" role="status"><RefreshCw size={22} aria-hidden="true" /><p>会话同步失败</p><button className="secondary-button" type="button" onClick={onRetry}><RefreshCw size={14} aria-hidden="true" />重试</button></div>;
}

function updateMessage(
  entries: TimelineEntry[],
  messageId: string,
  update: (message: TimelineMessage) => TimelineMessage,
): TimelineEntry[] {
  return entries.map((entry) => entry.kind === "message" && entry.id === messageId ? update(entry) : entry);
}

function updateTurn(turns: TimelineTurn[], turnId: string, status: ConversationTurnStatus): TimelineTurn[] {
  const index = turns.findIndex((turn) => turn.id === turnId);
  const next = { id: turnId, status };
  return index === -1
    ? [...turns, next]
    : turns.map((turn, turnIndex) => turnIndex === index ? next : turn);
}

function statusAnnouncement(status: SessionStreamState): string {
  if (status === "live") return "会话已连接";
  if (status === "connector_offline") return "工作站离线，无法读取对话";
  if (status === "denied") return "没有查看此会话的权限";
  if (status === "error") return "会话同步失败";
  return "";
}

function imageErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "image_unavailable";
}

function imageErrorLabel(code: string | undefined): string {
  if (code === "image_unavailable") return "图片在工作站上不可用";
  if (code === "image_too_large") return "图片超过 5 MiB，无法显示";
  if (code === "unsupported_image") return "图片格式不受支持";
  if (code === "image_hash_mismatch") return "图片完整性校验失败";
  if (code === "missing_image_chunk" || code === "image_length_mismatch") return "图片传输不完整";
  return "图片暂时无法显示";
}

function readyTimelineImage(image: TimelineImage, url: string): TimelineImage {
  const next: TimelineImage = { ...image, state: "ready", url };
  delete next.errorCode;
  return next;
}

function failedTimelineImage(image: TimelineImage, errorCode: string): TimelineImage {
  const next: TimelineImage = { ...image, state: "failed", errorCode };
  delete next.url;
  return next;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function cssDuration(name: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}
