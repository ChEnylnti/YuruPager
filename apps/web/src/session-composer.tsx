import { ImagePlus, LoaderCircle, Send, WifiOff, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";

import type { SessionCommandSummary, SessionSummary, WorkstationSummary } from "@yurupager/shared";

import { sendSessionMessage } from "./api.js";
import {
  IMAGE_MIME_TYPES,
  uploadSessionAttachments,
  validateDraftImages,
  type AttachmentUploadProgress,
  type DraftImageAttachment,
} from "./attachment-upload.js";
import { createIdempotencyKey } from "./idempotency.js";
import { errorLabel } from "./i18n.js";
import type { LiveChannel } from "./live-channel.js";

export interface SessionComposerProps {
  session: SessionSummary;
  workstation: WorkstationSummary | undefined;
  online: boolean;
  value: string;
  attachments?: DraftImageAttachment[];
  channel?: LiveChannel;
  onChange(value: string): void;
  onAttachmentsChange?(attachments: DraftImageAttachment[]): void;
  onCommandChange(command: SessionCommandSummary): void;
  onToast(message: string, tone?: "success" | "error"): void;
  sendMessage?: typeof sendSessionMessage;
  uploadAttachments?: typeof uploadSessionAttachments;
}

export function SessionComposer({
  session,
  workstation,
  online,
  value,
  attachments = [],
  channel,
  onChange,
  onAttachmentsChange = () => undefined,
  onCommandChange,
  onToast,
  sendMessage = sendSessionMessage,
  uploadAttachments = uploadSessionAttachments,
}: SessionComposerProps) {
  const [phase, setPhase] = useState<"idle" | "uploading" | "queueing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<AttachmentUploadProgress | null>(null);
  const [dragging, setDragging] = useState(false);
  const submittingRef = useRef(false);
  const keyRef = useRef(createIdempotencyKey());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageButtonRef = useRef<HTMLButtonElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const contentLength = Array.from(value.trim()).length;
  const sessionBusy = session.status === "running";
  const submitting = phase !== "idle";
  const valid = contentLength <= 8_000 && (contentLength > 0 || attachments.length > 0);
  const connectorReadyForImages = attachments.length === 0 || workstation?.status === "online";
  const queueForNextTurn = sessionBusy && attachments.length === 0;
  const canSubmit = online && valid && !submitting && connectorReadyForImages && (!sessionBusy || queueForNextTurn);
  const statusText = !online
    ? "当前离线，消息未发送。"
    : sessionBusy && attachments.length > 0
      ? "Codex 正在运行；请在本轮结束后再发送图片。"
      : sessionBusy
        ? "Codex 正在运行；文字消息会排入下一轮。"
      : attachments.length > 0 && workstation?.status !== "online"
        ? "工作站在线后才能上传图片。文字草稿和图片仍保留在此设备。"
        : workstation?.status === "offline"
          ? "工作站离线，消息将在 Connector 重连后投递。"
          : "";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setError(null);
    const content = value.trim();
    void (async () => {
      let tickets: string[] = [];
      try {
        if (attachments.length > 0) {
          if (channel === undefined) throw new Error("实时连接不可用，图片未上传");
          const controller = new AbortController();
          uploadAbortRef.current = controller;
          setPhase("uploading");
          setProgress({
            completedBytes: 0,
            totalBytes: attachments.reduce((total, attachment) => total + attachment.file.size, 0),
            completedImages: 0,
            totalImages: attachments.length,
          });
          tickets = await uploadAttachments(channel, session.id, attachments, controller.signal, setProgress);
          uploadAbortRef.current = null;
        }
        setPhase("queueing");
        const result = await sendMessage(session.id, keyRef.current, content, tickets);
        onCommandChange(result.command);
        onChange("");
        for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
        onAttachmentsChange([]);
        keyRef.current = createIdempotencyKey();
        onToast(result.replayed ? "消息已在队列中" : queueForNextTurn ? "消息已排入下一轮" : "消息已排队，等待工作站接收");
        requestAnimationFrame(() => textareaRef.current?.focus());
      } catch (reason: unknown) {
        if (tickets.length > 0 && channel !== undefined) {
          for (const attachment of attachments) {
            channel.send({ type: "session.attachment.cancel", sessionId: session.id, uploadId: attachment.id });
          }
        }
        if (reason instanceof DOMException && reason.name === "AbortError") {
          const message = "图片上传已取消，文字和图片仍保留";
          setError(message);
          return;
        }
        const code = typeof reason === "object" && reason !== null && "code" in reason
          ? String(reason.code)
          : "";
        const uploadFailure = attachments.length > 0 && reason instanceof Error && reason.message.trim().length > 0
          ? reason.message
          : null;
        const message = code === "permission_denied"
          ? "你无权向此会话发送消息"
          : uploadFailure ?? errorLabel(reason, "消息未排队，内容已保留");
        setError(message);
        onToast(message, "error");
      } finally {
        uploadAbortRef.current = null;
        submittingRef.current = false;
        setPhase("idle");
        setProgress(null);
      }
    })();
  };

  const change = (next: string) => {
    if (!submittingRef.current) keyRef.current = createIdempotencyKey();
    setError(null);
    onChange(next);
  };
  const addFiles = (files: File[]) => {
    if (submitting || files.length === 0) return;
    const result = validateDraftImages(attachments, files);
    if (result.accepted.length !== attachments.length) {
      keyRef.current = createIdempotencyKey();
      onAttachmentsChange(result.accepted);
    }
    setError(result.error);
    if (result.error !== null) onToast(result.error, "error");
  };
  const removeAttachment = (id: string) => {
    if (submitting) return;
    const index = attachments.findIndex((attachment) => attachment.id === id);
    const target = attachments.find((attachment) => attachment.id === id);
    if (target !== undefined) URL.revokeObjectURL(target.previewUrl);
    keyRef.current = createIdempotencyKey();
    setError(null);
    onAttachmentsChange(attachments.filter((attachment) => attachment.id !== id));
    requestAnimationFrame(() => {
      const remaining = formRef.current?.querySelectorAll<HTMLButtonElement>(".composer-attachment button");
      remaining?.[Math.min(index, Math.max(remaining.length - 1, 0))]?.focus();
      if (remaining === undefined || remaining.length === 0) imageButtonRef.current?.focus();
    });
  };
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };
  const drop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/")));
  };

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.style.height = "0px";
    const style = getComputedStyle(textarea);
    const minimum = Number.parseFloat(style.minHeight) || 44;
    const maximum = Number.parseFloat(style.maxHeight) || 120;
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minimum), maximum);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maximum ? "auto" : "hidden";
  }, [value]);

  useEffect(() => () => uploadAbortRef.current?.abort(), []);

  const progressPercent = progress === null || progress.totalBytes === 0
    ? 0
    : Math.min(100, Math.round(progress.completedBytes / progress.totalBytes * 100));

  return (
    <form
      ref={formRef}
      className={`session-composer ${dragging ? "is-dragging" : ""}`}
      onSubmit={submit}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={drop}
      aria-label="向 Codex 发送消息"
    >
      <div className="composer-heading">
        <label htmlFor={`session-message-${session.id}`}>发送给 Codex</label>
        <span className={contentLength > 8_000 ? "is-over-limit" : ""}>{attachments.length > 0 && `${attachments.length} 张图片 / `}{contentLength.toLocaleString("zh-CN")} / 8,000</span>
      </div>
      {attachments.length > 0 && (
        <div className="composer-attachments" aria-label="待发送图片">
          {attachments.map((attachment, index) => (
            <div className="composer-attachment" key={attachment.id}>
              <img src={attachment.previewUrl} alt={`待发送图片 ${index + 1}`} />
              <button type="button" onClick={() => removeAttachment(attachment.id)} disabled={submitting} aria-label={`移除待发送图片 ${index + 1}`} title="移除图片">
                <X size={15} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-input-row">
        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          accept={IMAGE_MIME_TYPES.join(",")}
          multiple
          tabIndex={-1}
          aria-label="选择要发送的图片"
          onChange={(event) => {
            addFiles(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = "";
            requestAnimationFrame(() => imageButtonRef.current?.focus());
          }}
        />
        <button
          ref={imageButtonRef}
          className="secondary-button composer-image-button"
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={submitting || attachments.length >= 4}
          aria-label="添加图片"
          title="添加图片"
        >
          <ImagePlus size={18} aria-hidden="true" />
        </button>
        <textarea
          ref={textareaRef}
          id={`session-message-${session.id}`}
          value={value}
          onChange={(event) => change(event.target.value)}
          onKeyDown={keyDown}
          onPaste={paste}
          placeholder="输入下一步消息"
          rows={1}
          maxLength={12_000}
          disabled={submitting}
          aria-describedby={`session-message-status-${session.id}`}
          aria-invalid={error !== null || contentLength > 8_000}
        />
        <button className="primary-button composer-send" type="submit" disabled={!canSubmit} aria-label={queueForNextTurn ? "排入下一轮" : "发送消息"} aria-busy={submitting} title={queueForNextTurn ? "排入下一轮" : "发送消息"}>
          {submitting ? <LoaderCircle className="spinner" aria-hidden="true" size={17} /> : <Send aria-hidden="true" size={17} />}
          <span>{phase === "uploading" ? "上传中" : phase === "queueing" ? "排队中" : queueForNextTurn ? "排入下一轮" : "发送"}</span>
        </button>
      </div>
      <div id={`session-message-status-${session.id}`} className="composer-status" aria-live="polite">
        {phase === "uploading" && <span>正在上传图片 {progressPercent}% <button type="button" onClick={() => uploadAbortRef.current?.abort()}>取消上传</button></span>}
        {statusText.length > 0 && <span>{!online && <WifiOff aria-hidden="true" size={14} />}{statusText}</span>}
        {error !== null && <span className="field-error" role="alert">{error}</span>}
      </div>
    </form>
  );
}
