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
import { composerText, errorLabel } from "./i18n.js";
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
    ? composerText.offlineNotice
    : sessionBusy && attachments.length > 0
      ? composerText.busyWithImages
      : sessionBusy
        ? composerText.busyTextQueued
      : attachments.length > 0 && workstation?.status !== "online"
        ? composerText.workstationMustBeOnline
        : workstation?.status === "offline"
          ? composerText.workstationOfflineNotice
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
          if (channel === undefined) throw new Error(composerText.liveUnavailable);
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
        onToast(result.replayed ? composerText.queuedToast : queueForNextTurn ? composerText.queuedNextTurnToast : composerText.queuedToastDefault);
        requestAnimationFrame(() => textareaRef.current?.focus());
      } catch (reason: unknown) {
        if (tickets.length > 0 && channel !== undefined) {
          for (const attachment of attachments) {
            channel.send({ type: "session.attachment.cancel", sessionId: session.id, uploadId: attachment.id });
          }
        }
        if (reason instanceof DOMException && reason.name === "AbortError") {
          const message = composerText.uploadCancelled;
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
          ? composerText.permissionDenied
          : uploadFailure ?? errorLabel(reason, composerText.queueFailedFallback);
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
      aria-label={composerText.composerAria}
    >
      <div className="composer-heading">
        <label htmlFor={`session-message-${session.id}`}>{composerText.sendToCodexLabel}</label>
        <span className={contentLength > 8_000 ? "is-over-limit" : ""}>{attachments.length > 0 && composerText.imagesCounter(attachments.length)}{contentLength.toLocaleString("zh-CN")} / 8,000</span>
      </div>
      {attachments.length > 0 && (
        <div className="composer-attachments" aria-label={composerText.pendingImagesAria}>
          {attachments.map((attachment, index) => (
            <div className="composer-attachment" key={attachment.id}>
              <img src={attachment.previewUrl} alt={composerText.pendingImageAlt(index + 1)} />
              <button type="button" onClick={() => removeAttachment(attachment.id)} disabled={submitting} aria-label={composerText.removePendingAria(index + 1)} title={composerText.removeImageTitle}>
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
          aria-label={composerText.pickImagesAria}
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
          aria-label={composerText.addImageAria}
          title={composerText.addImageAria}
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
          placeholder={composerText.messagePlaceholder}
          rows={1}
          maxLength={12_000}
          disabled={submitting}
          aria-describedby={`session-message-status-${session.id}`}
          aria-invalid={error !== null || contentLength > 8_000}
        />
        <button className="primary-button composer-send" type="submit" disabled={!canSubmit} aria-label={queueForNextTurn ? composerText.queueNextTurn : composerText.sendMessage} aria-busy={submitting} title={queueForNextTurn ? composerText.queueNextTurn : composerText.sendMessage}>
          {submitting ? <LoaderCircle className="spinner" aria-hidden="true" size={17} /> : <Send aria-hidden="true" size={17} />}
          <span>{phase === "uploading" ? composerText.uploading : phase === "queueing" ? composerText.queueing : queueForNextTurn ? composerText.queueNextTurn : composerText.send}</span>
        </button>
      </div>
      <div id={`session-message-status-${session.id}`} className="composer-status" aria-live="polite">
        {phase === "uploading" && <span>{composerText.uploadingProgress(progressPercent)}<button type="button" onClick={() => uploadAbortRef.current?.abort()}>{composerText.cancelUpload}</button></span>}
        {statusText.length > 0 && <span>{!online && <WifiOff aria-hidden="true" size={14} />}{statusText}</span>}
        {error !== null && <span className="field-error" role="alert">{error}</span>}
      </div>
    </form>
  );
}
