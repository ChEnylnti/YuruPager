import { ExternalLink, LoaderCircle, Square, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  PreviewCapability,
  WorkstationPreviewSummary,
} from "@yurupager/shared";

import { launchPreview, stopPreview } from "./api.js";
import { errorLabel, formatDate, previewStatusLabel, previewText } from "./i18n.js";
import { openPreviewTab, renderPreviewTabStatus, submitPreviewLaunch } from "./preview-launch.js";

type PreviewAction = "launching" | "stopping";

export function WorkstationPreviewSection({
  workstationId,
  previews,
  capability,
  onChanged,
  onToast,
}: {
  workstationId: string;
  previews: WorkstationPreviewSummary[];
  capability: PreviewCapability;
  onChanged(): void;
  onToast(message: string, tone?: "success" | "error"): void;
}) {
  const visible = useMemo(
    () => previews.filter((preview) => preview.workstationId === workstationId),
    [previews, workstationId],
  );
  const actionsRef = useRef(new Map<string, PreviewAction>());
  const [actions, setActions] = useState<Record<string, PreviewAction | undefined>>({});
  const [confirmed, setConfirmed] = useState<Record<string, WorkstationPreviewSummary | undefined>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setConfirmed((current) => {
      let changed = false;
      const next = { ...current };
      for (const [id, local] of Object.entries(current)) {
        if (local === undefined) continue;
        const remote = previews.find((preview) => preview.id === id);
        if (remote === undefined || Date.parse(remote.updatedAt) >= Date.parse(local.updatedAt)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [previews]);

  function begin(previewId: string, action: PreviewAction): boolean {
    if (actionsRef.current.has(previewId)) return false;
    actionsRef.current.set(previewId, action);
    setActions((current) => ({ ...current, [previewId]: action }));
    setError(null);
    return true;
  }

  function finish(previewId: string): void {
    actionsRef.current.delete(previewId);
    setActions((current) => ({ ...current, [previewId]: undefined }));
  }

  async function open(preview: WorkstationPreviewSummary): Promise<void> {
    if (!begin(preview.id, "launching")) return;
    const tab = openPreviewTab(preview.name);
    if (tab === null) {
      finish(preview.id);
      const message = previewText.popupBlocked;
      setError(message);
      onToast(message, "error");
      return;
    }
    try {
      const result = await launchPreview(preview.id);
      submitPreviewLaunch(result, tab.target);
      onToast(previewText.openedToast, "success");
    } catch (reason) {
      const message = previewActionError(reason, previewText.openFailed);
      setError(message);
      onToast(message, "error");
      try { renderPreviewTabStatus(tab.window, previewText.openFailed, message); } catch { /* inaccessible popup */ }
    } finally {
      finish(preview.id);
    }
  }

  async function stop(preview: WorkstationPreviewSummary): Promise<void> {
    if (!begin(preview.id, "stopping")) return;
    try {
      const result = await stopPreview(preview.id);
      setConfirmed((current) => ({ ...current, [preview.id]: result }));
      onToast(previewText.stoppedToast, "success");
      onChanged();
    } catch (reason) {
      const message = previewActionError(reason, previewText.stopFailed);
      setError(message);
      onToast(message, "error");
    } finally {
      finish(preview.id);
    }
  }

  return (
    <section className="entity-section preview-section" aria-labelledby={`preview-heading-${workstationId}`}>
      <div className="preview-section-heading">
        <h3 id={`preview-heading-${workstationId}`}>{previewText.heading}</h3>
        {capability.enabled && capability.gatewayOrigin !== null && visible.length > 0 && <span>{previewText.countSuffix(visible.length)}</span>}
      </div>
      {!capability.enabled ? (
        <div className="preview-notice" role="status">
          <TerminalSquare size={17} aria-hidden="true" />
          <span>{previewText.serverDisabled}</span>
        </div>
      ) : capability.gatewayOrigin === null ? (
        <div className="preview-notice" role="status">
          <TerminalSquare size={17} aria-hidden="true" />
          <span>{previewText.gatewayMissing}</span>
        </div>
      ) : visible.length === 0 ? (
        <div className="preview-empty">
          <TerminalSquare size={18} aria-hidden="true" />
          <div>
            <span>{previewText.noneForWorkstation}</span>
            <code>{examplePreviewCommand(capability.command)}</code>
          </div>
        </div>
      ) : (
        <div className="preview-list">
          {visible.map((source) => {
            const preview = confirmed[source.id] ?? source;
            const action = actions[preview.id];
            const status = action === "stopping" ? "stopping" : preview.status;
            const terminal = preview.status === "stopped" || preview.status === "expired";
            const launchDisabled = action !== undefined || preview.status !== "active";
            const statusLabel = previewStatusLabel(status);
            const launchLabel = action === "launching" ? previewText.launching : previewText.openAction;
            const stopLabel = action === "stopping" ? previewText.stopping : previewText.stopAction;
            return (
              <div className="preview-row" key={preview.id} data-preview-status={status}>
                <div className="preview-identity">
                  <strong title={preview.name}>{preview.name}</strong>
                  <code aria-label={previewText.localPortAria(preview.port)}>localhost:<b>{preview.port}</b></code>
                </div>
                <div className="preview-state" role="status" aria-label={statusLabel}>
                  <span className={`preview-status preview-status-${status}`}>{statusLabel}</span>
                  <time dateTime={preview.expiresAt} title={formatDate(preview.expiresAt)}>{previewText.expiresPrefix}{formatDate(preview.expiresAt)}</time>
                </div>
                <div className="preview-actions">
                  <button className="secondary-button" type="button" aria-label={launchLabel} disabled={launchDisabled} onClick={() => void open(preview)}>
                    <span className="t-icon-swap" data-state={action === "launching" ? "b" : "a"} aria-hidden="true">
                      <span className="t-icon" data-icon="a"><ExternalLink size={15} /></span>
                      <span className="t-icon" data-icon="b"><LoaderCircle className="spinner" size={15} /></span>
                    </span>
                    <span>{launchLabel}</span>
                  </button>
                  <button className="secondary-button danger-text" type="button" aria-label={stopLabel} disabled={action !== undefined || terminal} onClick={() => void stop(preview)}>
                    <span className="t-icon-swap" data-state={action === "stopping" ? "b" : "a"} aria-hidden="true">
                      <span className="t-icon" data-icon="a"><Square size={14} /></span>
                      <span className="t-icon" data-icon="b"><LoaderCircle className="spinner" size={15} /></span>
                    </span>
                    <span>{stopLabel}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="preview-feedback">{error}</div>
    </section>
  );
}

function examplePreviewCommand(command: string): string {
  const normalized = command.trim();
  if (normalized === "") return "yurupager preview 5173";
  if (normalized.includes("<port>")) return normalized.replaceAll("<port>", "5173");
  if (normalized.includes("{port}")) return normalized.replaceAll("{port}", "5173");
  if (/\b5173\b/.test(normalized)) return normalized;
  return `${normalized} 5173`;
}

function previewActionError(reason: unknown, fallback: string): string {
  const code = typeof reason === "object" && reason !== null && "code" in reason
    ? String((reason as { code?: unknown }).code ?? "")
    : "";
  if (code === "permission_denied") return previewText.permissionDenied;
  return errorLabel(reason, fallback);
}
