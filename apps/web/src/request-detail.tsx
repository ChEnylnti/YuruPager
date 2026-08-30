import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock3,
  HelpCircle,
  LoaderCircle,
  ShieldAlert,
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
import { deliveryStatusLabel, errorLabel, formatDate, permissionAccessLabel, requestStatusLabel, riskLabel, requestDetailText, viewsText } from "./i18n.js";

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
          ? requestDetailText.toastDenied
          : input.decision === "answer"
            ? requestDetailText.toastAnswerSent
            : requestDetailText.toastApproved,
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === "decision_conflict") {
        const details = error.details as { request?: RequestSummary } | undefined;
        if (details?.request !== undefined) onRequestChange(details.request);
        closeDialog(false);
        onToast(requestDetailText.toastConflict, "error");
      } else {
        onToast(errorLabel(error, requestDetailText.submitFailed), "error");
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
        <button className="icon-button mobile-back" type="button" onClick={onBack} aria-label={requestDetailText.backToRequests} title={requestDetailText.backToRequests}>
          <ArrowLeft aria-hidden="true" size={18} />
        </button>
        <div className="detail-title-block">
          <p className="eyebrow">{request.kind === "question" ? requestDetailText.eyebrowQuestion : requestDetailText.eyebrowApproval}</p>
          <h2 id="request-heading">{request.projectName}</h2>
        </div>
        <StatusBadge status={request.status} />
      </header>

      <div className="identity-strip" aria-label={requestDetailText.identityAria}>
        <Identity label={requestDetailText.idWorkspace} value={request.workspaceName} />
        <Identity label={requestDetailText.idWorkstation} value={request.workstationName} />
        <Identity label={requestDetailText.idProject} value={request.projectName} />
        <Identity label={requestDetailText.idSession} value={request.sessionId.slice(0, 8)} />
      </div>

      <div className="detail-scroll" role="region" aria-label={requestDetailText.detailAria} tabIndex={0}>
        {request.deliveryStatus === "sent_unknown" && (
          <div className="critical-notice" role="alert">
            <ShieldAlert aria-hidden="true" size={20} />
            <div>
              <strong>{requestDetailText.sentUnknownTitle}</strong>
              <p>{requestDetailText.sentUnknownBody}</p>
            </div>
          </div>
        )}
        {!online && request.status === "pending" && (
          <div className="offline-notice" role="status">
            <WifiOff aria-hidden="true" size={18} />
            <span>{requestDetailText.offlineNotice}</span>
          </div>
        )}

        <section className="detail-section" aria-labelledby="context-heading">
          <div className="section-heading-row">
            <h3 id="context-heading">{requestDetailText.contextHeading}</h3>
            <span className={`risk risk-${request.risk}`}>
              {request.risk === "high" && <AlertTriangle aria-hidden="true" size={14} />}
              {riskLabel(request.risk)}{viewsText.riskSuffix}
            </span>
          </div>
          <dl className="facts-grid">
            <Fact label={requestDetailText.factTool} value={request.tool} />
            <Fact label={requestDetailText.factCategory} value={request.category} />
            <Fact label={requestDetailText.factInitiator} value={request.sessionInitiatorName ?? requestDetailText.unknownSource} />
            <Fact label={requestDetailText.factAssignedTo} value={request.assignedToName ?? requestDetailText.unassigned} />
          </dl>
          {request.context.reason !== undefined && (
            <div className="context-copy">
              <span>{requestDetailText.reasonLabel}</span>
              <p>{request.context.reason}</p>
            </div>
          )}
          {request.context.command !== undefined && (
            <div className="command-block">
              <span>{requestDetailText.commandLabel}</span>
              <code>{request.context.command}</code>
            </div>
          )}
          {request.context.cwd !== undefined && (
            <div className="context-copy">
              <span>{requestDetailText.cwdLabel}</span>
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
                  {question.isSecret && <p id={`${question.id}-secret`} className="field-error">{requestDetailText.secretNotice}</p>}
                </fieldset>
              ))}
              <button className="primary-button" type="submit" disabled={!actionable || !answersComplete || submitting}>
                {submitting ? <LoaderCircle className="spinner" aria-hidden="true" size={17} /> : <HelpCircle aria-hidden="true" size={17} />}
                {submitting ? requestDetailText.submittingAnswer : requestDetailText.submitAnswer}
              </button>
            </form>
          )}
        </section>

        <section className="detail-section" aria-labelledby="handling-heading">
          <h3 id="handling-heading">{requestDetailText.handlingHeading}</h3>
          <dl className="facts-grid">
            <Fact label={requestDetailText.factRequestedAt} value={formatDate(request.requestedAt)} />
            <Fact label={requestDetailText.factExpiresAt} value={formatDate(request.expiresAt)} />
            <Fact label={requestDetailText.factDeliveryStatus} value={deliveryStatusLabel(request.deliveryStatus)} />
            <Fact label={requestDetailText.factFinalOperator} value={request.decidedByName ?? requestDetailText.undecided} />
          </dl>
          {request.decisionReason !== null && (
            <div className="context-copy"><span>{requestDetailText.denyReasonLabel}</span><p>{request.decisionReason}</p></div>
          )}
        </section>
      </div>

      {request.kind === "approval" && (
        <footer className="decision-bar" aria-label={requestDetailText.decisionBarAria}>
          {request.status === "pending" ? (
            <>
              <button
                ref={denyRef}
                className="secondary-button danger-text"
                type="button"
                disabled={!actionable || submitting}
                onClick={() => setDialog({ kind: "deny", idempotencyKey: createIdempotencyKey() })}
              >
                <X aria-hidden="true" size={17} /> {requestDetailText.denyAction}
              </button>
              <button
                ref={approveRef}
                className={request.risk === "high" ? "danger-button" : "primary-button"}
                type="button"
                disabled={!actionable || submitting}
                onClick={() => setDialog({ kind: "approve", idempotencyKey: createIdempotencyKey() })}
              >
                <Check aria-hidden="true" size={17} /> {requestDetailText.approveAction}
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
        {submitting ? requestDetailText.submittingDecision : `${requestStatusLabel(request.status)}，${request.decidedByName ?? requestDetailText.notYetHandled}`}
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
        <h2 id={titleId}>{kind === "deny" ? requestDetailText.dialogTitleDeny : highRisk ? requestDetailText.dialogTitleHighRisk : requestDetailText.dialogTitleApprove}</h2>
        <p>
          {kind === "deny"
            ? requestDetailText.dialogDenyBody
            : requestDetailText.dialogApproveBody(request.workstationName)}
        </p>
        <div className="dialog-context">
          <span>{request.workspaceName}</span>
          <strong className="wrap-anywhere">{request.context.command ?? request.tool}</strong>
        </div>
        {kind === "deny" && (
          <label className="field-label">
            {requestDetailText.reasonLabel}
            <textarea autoFocus rows={3} value={reason} onChange={(event) => onReason(event.target.value)} disabled={submitting} />
          </label>
        )}
        <div className="dialog-actions">
          <button ref={cancelRef} className="secondary-button" type="button" onClick={requestClose} disabled={submitting}>{viewsText.cancel}</button>
          <button
            className={kind === "deny" || highRisk ? "danger-button" : "primary-button"}
            type="button"
            disabled={submitting || (kind === "deny" && reason.trim().length < 3)}
            onClick={onConfirm}
          >
            {submitting && <LoaderCircle className="spinner" aria-hidden="true" size={17} />}
            {submitting ? requestDetailText.submitting : kind === "deny" ? requestDetailText.submitDeny : requestDetailText.confirmApprove}
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
      <span>{requestDetailText.permissionsLabel}</span>
      {permissions?.network === true && <p>{requestDetailText.networkAccess}</p>}
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
  if (request.status === "approved") return requestDetailText.finalApproved(request.decidedByName);
  if (request.status === "denied") return requestDetailText.finalDenied(request.decidedByName);
  if (request.status === "interrupted") return requestDetailText.finalInterrupted;
  if (request.status === "expired") return requestDetailText.finalExpired;
  return requestStatusLabel(request.status);
}
