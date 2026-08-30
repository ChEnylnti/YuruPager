import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock3,
  HelpCircle,
  LoaderCircle,
  ShieldAlert,
  UserRound,
  WifiOff,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";

import type { DecisionInput, RequestSummary } from "@yurupager/shared";

import { ApiError, submitDecision } from "./api.js";
import { createIdempotencyKey } from "./idempotency.js";
import { deliveryStatusLabel, errorLabel, formatDate, permissionAccessLabel, requestStatusLabel, riskLabel } from "./i18n.js";

interface RequestDetailProps {
  request: RequestSummary;
  online: boolean;
  onBack(): void;
  onRequestChange(request: RequestSummary): void;
  onToast(message: string, tone?: "success" | "error"): void;
}

type DialogState =
  | { kind: "approve"; idempotencyKey: string }
  | { kind: "deny"; idempotencyKey: string }
  | null;

export function RequestDetail({
  request,
  online,
  onBack,
  onRequestChange,
  onToast,
}: RequestDetailProps) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reason, setReason] = useState("");
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const submittingRef = useRef(false);
  const approveRef = useRef<HTMLButtonElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const answerKey = useRef<string>(createIdempotencyKey());
  const actionable = request.status === "pending" && online;

  useEffect(() => {
    setDialog(null);
    setSubmitting(false);
    submittingRef.current = false;
    setReason("");
    setAnswers({});
    answerKey.current = createIdempotencyKey();
  }, [request.id]);

  useEffect(() => {
    if (request.status !== "pending") setDialog(null);
  }, [request.status]);

  const closeDialog = (returnFocus = true) => {
    const trigger = dialog?.kind === "deny" ? denyRef.current : approveRef.current;
    setDialog(null);
    if (returnFocus) requestAnimationFrame(() => trigger?.focus());
  };

  const send = async (key: string, input: DecisionInput) => {
    if (submittingRef.current || !online) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const result = await submitDecision(request.id, key, input);
      onRequestChange(result.request);
      closeDialog(false);
      onToast(
        input.decision === "deny"
          ? "请求已拒绝"
          : input.decision === "answer"
            ? "回答已发送"
            : "批准已记录",
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === "decision_conflict") {
        const details = error.details as { request?: RequestSummary } | undefined;
        if (details?.request !== undefined) onRequestChange(details.request);
        closeDialog(false);
        onToast("另一位协作者已处理此请求", "error");
      } else {
        onToast(errorLabel(error, "无法提交决定"), "error");
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const submitAnswers = (event: FormEvent) => {
    event.preventDefault();
    void send(answerKey.current, { decision: "answer", answers });
  };

  const questions = request.context.questions ?? [];
  const answersComplete =
    questions.length > 0 &&
    questions.every((question) => (answers[question.id]?.[0]?.trim().length ?? 0) > 0);

  return (
    <article className="request-detail" aria-labelledby="request-heading">
      <header className="detail-toolbar">
        <button className="icon-button mobile-back" type="button" onClick={onBack} aria-label="返回请求列表" title="返回请求列表">
          <ArrowLeft aria-hidden="true" size={18} />
        </button>
        <div className="detail-title-block">
          <p className="eyebrow">{request.kind === "question" ? "代理提问" : "审批请求"}</p>
          <h2 id="request-heading">{request.projectName}</h2>
        </div>
        <StatusBadge status={request.status} />
      </header>

      <div className="identity-strip" aria-label="请求标识">
        <Identity label="工作区" value={request.workspaceName} />
        <Identity label="工作站" value={request.workstationName} />
        <Identity label="项目" value={request.projectName} />
        <Identity label="会话" value={request.sessionId.slice(0, 8)} />
      </div>

      <div className="detail-scroll" role="region" aria-label="请求详情" tabIndex={0}>
        {request.deliveryStatus === "sent_unknown" && (
          <div className="critical-notice" role="alert">
            <ShieldAlert aria-hidden="true" size={20} />
            <div>
              <strong>执行结果未知</strong>
              <p>已阻止自动重发。请在工作站上核对该决定。</p>
            </div>
          </div>
        )}
        {!online && request.status === "pending" && (
          <div className="offline-notice" role="status">
            <WifiOff aria-hidden="true" size={18} />
            <span>当前离线。恢复服务器快照前无法提交决定。</span>
          </div>
        )}

        <section className="detail-section" aria-labelledby="context-heading">
          <div className="section-heading-row">
            <h3 id="context-heading">请求上下文</h3>
            <span className={`risk risk-${request.risk}`}>
              {request.risk === "high" && <AlertTriangle aria-hidden="true" size={14} />}
              {riskLabel(request.risk)}风险
            </span>
          </div>
          <dl className="facts-grid">
            <Fact label="工具" value={request.tool} />
            <Fact label="类别" value={request.category} />
            <Fact label="发起人" value={request.sessionInitiatorName ?? "未知来源"} />
            <Fact label="指派给" value={request.assignedToName ?? "未指派"} />
          </dl>
          {request.context.reason !== undefined && (
            <div className="context-copy">
              <span>原因</span>
              <p>{request.context.reason}</p>
            </div>
          )}
          {request.context.command !== undefined && (
            <div className="command-block">
              <span>命令</span>
              <code>{request.context.command}</code>
            </div>
          )}
          {request.context.cwd !== undefined && (
            <div className="context-copy">
              <span>工作目录</span>
              <p className="mono wrap-anywhere">{request.context.cwd}</p>
            </div>
          )}
          {request.context.requestedPermissions !== undefined && (
            <Permissions request={request} />
          )}
          {request.kind === "question" && (
            <form className="question-form" onSubmit={submitAnswers}>
              {questions.map((question) => (
                <fieldset key={question.id}>
                  <legend>{question.header}</legend>
                  <p>{question.question}</p>
                  {question.options.length > 0 ? (
                    <div className="option-list">
                      {question.options.map((option) => (
                        <label key={option.label} className="radio-option">
                          <input
                            type="radio"
                            name={question.id}
                            value={option.label}
                            checked={answers[question.id]?.[0] === option.label}
                            onChange={() => setAnswers((current) => ({ ...current, [question.id]: [option.label] }))}
                            disabled={!actionable || submitting}
                          />
                          <span><strong>{option.label}</strong><small>{option.description}</small></span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <textarea
                      rows={3}
                      value={answers[question.id]?.[0] ?? ""}
                      onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: [event.target.value] }))}
                      autoComplete={question.isSecret ? "off" : "on"}
                      disabled={!actionable || submitting || question.isSecret}
                      aria-describedby={question.isSecret ? `${question.id}-secret` : undefined}
                    />
                  )}
                  {question.isSecret && <p id={`${question.id}-secret`} className="field-error">敏感问题答案必须在工作站上输入。</p>}
                </fieldset>
              ))}
              <button className="primary-button" type="submit" disabled={!actionable || !answersComplete || submitting}>
                {submitting ? <LoaderCircle className="spinner" aria-hidden="true" size={17} /> : <HelpCircle aria-hidden="true" size={17} />}
                {submitting ? "正在提交回答" : "提交回答"}
              </button>
            </form>
          )}
        </section>

        <section className="detail-section" aria-labelledby="handling-heading">
          <h3 id="handling-heading">处理信息</h3>
          <dl className="facts-grid">
            <Fact label="请求时间" value={formatDate(request.requestedAt)} />
            <Fact label="过期时间" value={formatDate(request.expiresAt)} />
            <Fact label="传送状态" value={deliveryStatusLabel(request.deliveryStatus)} />
            <Fact label="最终操作人" value={request.decidedByName ?? "未处理"} />
          </dl>
          {request.decisionReason !== null && (
            <div className="context-copy"><span>拒绝原因</span><p>{request.decisionReason}</p></div>
          )}
        </section>
      </div>

      {request.kind === "approval" && (
        <footer className="decision-bar" aria-label="请求操作">
          {request.status === "pending" ? (
            <>
              <button
                ref={denyRef}
                className="secondary-button danger-text"
                type="button"
                disabled={!actionable || submitting}
                onClick={() => setDialog({ kind: "deny", idempotencyKey: createIdempotencyKey() })}
              >
                <X aria-hidden="true" size={17} /> 拒绝
              </button>
              <button
                ref={approveRef}
                className={request.risk === "high" ? "danger-button" : "primary-button"}
                type="button"
                disabled={!actionable || submitting}
                onClick={() => setDialog({ kind: "approve", idempotencyKey: createIdempotencyKey() })}
              >
                <Check aria-hidden="true" size={17} /> 批准
              </button>
            </>
          ) : (
            <div className="final-state" role="status">
              {request.status === "approved" ? <CheckCircle2 aria-hidden="true" size={18} /> : request.status === "interrupted" ? <AlertTriangle aria-hidden="true" size={18} /> : <Clock3 aria-hidden="true" size={18} />}
              <span>{finalStateCopy(request)}</span>
            </div>
          )}
        </footer>
      )}

      {dialog !== null && (
        <DecisionDialog
          request={request}
          kind={dialog.kind}
          reason={reason}
          submitting={submitting}
          onReason={setReason}
          onClose={() => closeDialog()}
          onConfirm={() => {
            const input: DecisionInput = dialog.kind === "deny"
              ? { decision: "deny", reason: reason.trim() }
              : request.risk === "high"
                ? { decision: "approve", highRiskConfirmed: true }
                : { decision: "approve" };
            void send(dialog.idempotencyKey, input);
          }}
        />
      )}
      <div className="sr-only" aria-live="polite">
        {submitting ? "正在提交决定" : `${requestStatusLabel(request.status)}，${request.decidedByName ?? "尚未处理"}`}
      </div>
    </article>
  );
}

function DecisionDialog({
  request,
  kind,
  reason,
  submitting,
  onReason,
  onClose,
  onConfirm,
}: {
  request: RequestSummary;
  kind: "approve" | "deny";
  reason: string;
  submitting: boolean;
  onReason(value: string): void;
  onClose(): void;
  onConfirm(): void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | null>(null);
  const [motionState, setMotionState] = useState<"opening" | "open" | "closing">("opening");
  const requestClose = () => {
    if (submitting || motionState === "closing") return;
    setMotionState("closing");
    closeTimer.current = window.setTimeout(
      onClose,
      prefersReducedMotion() ? 0 : cssDuration("--modal-close-dur", 150),
    );
  };
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMotionState((current) => current === "opening" ? "open" : current));
    return () => {
      cancelAnimationFrame(frame);
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    };
  }, []);
  useDialogFocus(dialogRef, cancelRef, requestClose);
  const highRisk = request.risk === "high" && kind === "approve";

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <div ref={dialogRef} className={`decision-dialog t-modal ${motionState === "open" ? "is-open" : motionState === "closing" ? "is-closing" : ""} ${highRisk ? "high-risk-dialog" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-icon" aria-hidden="true">
          {kind === "deny" ? <X size={21} /> : highRisk ? <ShieldAlert size={21} /> : <Check size={21} />}
        </div>
        <h2 id={titleId}>{kind === "deny" ? "拒绝此请求？" : highRisk ? "确认高风险批准" : "批准此请求？"}</h2>
        <p>
          {kind === "deny"
            ? "代理将不会执行此操作。拒绝原因会与协作者共享。"
            : `此决定将发送到 ${request.workstationName}，Codex 接收后无法撤回。`}
        </p>
        <div className="dialog-context">
          <span>{request.workspaceName}</span>
          <strong className="wrap-anywhere">{request.context.command ?? request.tool}</strong>
        </div>
        {kind === "deny" && (
          <label className="field-label">
            原因
            <textarea autoFocus rows={3} value={reason} onChange={(event) => onReason(event.target.value)} disabled={submitting} />
          </label>
        )}
        <div className="dialog-actions">
          <button ref={cancelRef} className="secondary-button" type="button" onClick={requestClose} disabled={submitting}>取消</button>
          <button
            className={kind === "deny" || highRisk ? "danger-button" : "primary-button"}
            type="button"
            disabled={submitting || (kind === "deny" && reason.trim().length < 3)}
            onClick={onConfirm}
          >
            {submitting && <LoaderCircle className="spinner" aria-hidden="true" size={17} />}
            {submitting ? "提交中" : kind === "deny" ? "提交拒绝" : "确认批准"}
          </button>
        </div>
      </div>
    </div>
  );
}

function useDialogFocus(
  dialogRef: RefObject<HTMLDivElement | null>,
  initialRef: RefObject<HTMLButtonElement | null>,
  onClose: () => void,
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    initialRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== "Tab" || dialogRef.current === null) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), textarea:not([disabled]), input:not([disabled])"));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [dialogRef, initialRef]);
}

function cssDuration(name: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function Permissions({ request }: { request: RequestSummary }) {
  const permissions = request.context.requestedPermissions;
  return (
    <div className="permissions-block">
      <span>请求权限</span>
      {permissions?.network === true && <p>网络访问</p>}
      {permissions?.fileSystem?.map((entry) => (
        <p key={`${entry.access}:${entry.path}`} className="mono wrap-anywhere">{permissionAccessLabel(entry.access)}：{entry.path}</p>
      ))}
    </div>
  );
}

function Identity({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd title={value}>{value}</dd></div>;
}

export function StatusBadge({ status }: { status: RequestSummary["status"] }) {
  return <span className={`status-badge status-${status}`}>{requestStatusLabel(status)}</span>;
}

function finalStateCopy(request: RequestSummary): string {
  if (request.status === "approved") return `已批准${request.decidedByName === null ? "" : `，操作人：${request.decidedByName}`}`;
  if (request.status === "denied") return `已拒绝${request.decidedByName === null ? "" : `，操作人：${request.decidedByName}`}`;
  if (request.status === "interrupted") return "回合已中断，旧审批已取消。";
  if (request.status === "expired") return "请求已过期，未执行任何操作。";
  return requestStatusLabel(request.status);
}
