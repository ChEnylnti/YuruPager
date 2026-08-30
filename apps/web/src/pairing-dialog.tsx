import {
  CheckCircle2,
  Clipboard,
  Clock3,
  Laptop,
  LoaderCircle,
  ShieldCheck,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Snapshot, WorkstationPairingSummary } from "@yurupager/shared";

import {
  approveWorkstationPairing,
  cancelWorkstationPairing,
  createWorkstationPairing,
  getWorkstationPairings,
} from "./api.js";
import { appBaseUrl } from "./base-path.js";
import { errorLabel, pairingText } from "./i18n.js";

const codeStoragePrefix = "yurupager:pair-code:";

export function PairingDialog({
  snapshot,
  onClose,
  onChanged,
  onToast,
}: {
  snapshot: Snapshot;
  onClose(): void;
  onChanged(): void;
  onToast(message: string, tone?: "success" | "error"): void;
}) {
  const manageable = snapshot.workspaces.filter((workspace) => workspace.role === "owner" || workspace.role === "admin");
  const initialWorkspace = snapshot.scopeWorkspaceId !== null && manageable.some((item) => item.id === snapshot.scopeWorkspaceId)
    ? snapshot.scopeWorkspaceId
    : manageable[0]?.id ?? "";
  const [workspaceId, setWorkspaceId] = useState(initialWorkspace);
  const [pairings, setPairings] = useState<WorkstationPairingSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [workstationName, setWorkstationName] = useState("");
  const [busy, setBusy] = useState<"loading" | "creating" | "approving" | "cancelling" | null>("loading");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [motionState, setMotionState] = useState<"entering" | "open" | "closing">("entering");
  const createKey = useRef(crypto.randomUUID());
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);

  const selected = pairings.find((pairing) => pairing.id === selectedId) ?? null;
  const requestClose = useCallback(() => {
    if (motionState === "closing") return;
    setMotionState("closing");
    closeTimer.current = window.setTimeout(
      onClose,
      prefersReducedMotion() ? 0 : cssDuration("--modal-close-dur", 150),
    );
  }, [motionState, onClose]);
  const load = useCallback(async () => {
    const next = await getWorkstationPairings(snapshot.scopeWorkspaceId);
    setPairings(next);
    setSelectedId((current) => {
      if (current !== null && next.some((item) => item.id === current)) return current;
      return next.find((item) => item.status === "pending_approval" || item.status === "waiting_for_device")?.id ?? null;
    });
  }, [snapshot.scopeWorkspaceId]);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    void load().catch((reason: unknown) => setError(errorLabel(reason, pairingText.loadFailed))).finally(() => setBusy(null));
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [load, requestClose]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setMotionState((current) => current === "entering" ? "open" : current));
    return () => {
      cancelAnimationFrame(frame);
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (selected === null) return;
    const stored = sessionStorage.getItem(`${codeStoragePrefix}${selected.id}`);
    setPairCode(stored);
    if (selected.deviceName !== null) setWorkstationName(selected.deviceName);
  }, [selected?.id, selected?.deviceName]);

  useEffect(() => {
    if (selected === null || (selected.status !== "waiting_for_device" && selected.status !== "pending_approval")) return;
    const interval = window.setInterval(() => {
      setNow(Date.now());
      void load().catch(() => undefined);
    }, 1_500);
    return () => clearInterval(interval);
  }, [load, selected?.id, selected?.status]);

  const create = async () => {
    if (workspaceId === "") return;
    setBusy("creating");
    setError(null);
    try {
      const result = await createWorkstationPairing(workspaceId, createKey.current);
      sessionStorage.setItem(`${codeStoragePrefix}${result.pairing.id}`, result.pairCode);
      setPairCode(result.pairCode);
      setPairings((current) => [result.pairing, ...current.filter((item) => item.id !== result.pairing.id)]);
      setSelectedId(result.pairing.id);
    } catch (reason) {
      setError(errorLabel(reason, pairingText.createFailed));
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (selected === null || workstationName.trim() === "") return;
    setBusy("approving");
    setError(null);
    try {
      const next = await approveWorkstationPairing(selected.id, workstationName.trim());
      setPairings((current) => current.map((item) => item.id === next.id ? next : item));
      sessionStorage.removeItem(`${codeStoragePrefix}${next.id}`);
      setPairCode(null);
      onToast(pairingText.approvedToast);
      onChanged();
    } catch (reason) {
      setError(errorLabel(reason, pairingText.approveFailed));
      await load().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (selected === null) return;
    setBusy("cancelling");
    setError(null);
    try {
      const next = await cancelWorkstationPairing(selected.id);
      setPairings((current) => current.map((item) => item.id === next.id ? next : item));
      sessionStorage.removeItem(`${codeStoragePrefix}${next.id}`);
      setPairCode(null);
      onToast(pairingText.cancelledToast);
    } catch (reason) {
      setError(errorLabel(reason, pairingText.cancelFailed));
      await load().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const startAnother = () => {
    createKey.current = crypto.randomUUID();
    setSelectedId(null);
    setPairCode(null);
    setWorkstationName("");
    setError(null);
  };

  return (
    <div className="dialog-backdrop pairing-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <div ref={dialogRef} className={`decision-dialog pairing-dialog t-modal ${motionState === "open" ? "is-open" : motionState === "closing" ? "is-closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="pairing-title" tabIndex={-1}>
        <header className="pairing-dialog-header">
          <span className="dialog-icon"><Laptop aria-hidden="true" size={20} /></span>
          <div><p className="eyebrow">{pairingText.eyebrow}</p><h2 id="pairing-title">{pairingText.heading}</h2></div>
          <button className="icon-button" type="button" aria-label={pairingText.closeAria} title={pairingText.close} onClick={requestClose}><X aria-hidden="true" size={18} /></button>
        </header>
        <div className="pairing-state-slot" aria-live="polite">
          {busy === "loading" ? <PairingLoading /> : selected === null ? (
            <CreatePairing
              workspaceId={workspaceId}
              workspaces={manageable}
              busy={busy === "creating"}
              onWorkspace={setWorkspaceId}
              onCreate={() => void create()}
            />
          ) : selected.status === "waiting_for_device" ? (
            <WaitingForDevice pairing={selected} pairCode={pairCode} now={now} onCopy={onToast} />
          ) : selected.status === "pending_approval" ? (
            <ConfirmDevice pairing={selected} name={workstationName} onName={setWorkstationName} />
          ) : (
            <PairingFinal pairing={selected} />
          )}
        </div>
        {error !== null && <p className="pairing-error" role="alert">{error}</p>}
        <footer className="dialog-actions pairing-actions">
          {selected === null ? (
            <button className="secondary-button" type="button" onClick={requestClose}>{pairingText.close}</button>
          ) : selected.status === "waiting_for_device" ? (
            <><button className="secondary-button danger-text" type="button" disabled={busy !== null} onClick={() => void cancel()}>{pairingText.cancelPairing}</button><button className="secondary-button" type="button" onClick={requestClose}>{pairingText.continueLater}</button></>
          ) : selected.status === "pending_approval" ? (
            <><button className="secondary-button danger-text" type="button" disabled={busy !== null} onClick={() => void cancel()}>{pairingText.rejectConnection}</button><button className="primary-button" type="button" disabled={busy !== null || workstationName.trim() === ""} onClick={() => void approve()}>{busy === "approving" && <LoaderCircle className="spinner" aria-hidden="true" size={16} />}{pairingText.confirmConnection}</button></>
          ) : (
            <><button className="secondary-button" type="button" onClick={startAnother}>{pairingText.addAnother}</button><button className="primary-button" type="button" onClick={requestClose}>{pairingText.done}</button></>
          )}
        </footer>
      </div>
    </div>
  );
}

function CreatePairing({ workspaceId, workspaces, busy, onWorkspace, onCreate }: {
  workspaceId: string;
  workspaces: Snapshot["workspaces"];
  busy: boolean;
  onWorkspace(value: string): void;
  onCreate(): void;
}) {
  if (workspaces.length === 0) return <div className="pairing-empty"><ShieldCheck aria-hidden="true" size={22} /><p>{pairingText.noWorkspaces}</p></div>;
  return <div className="pairing-create"><p>{pairingText.ownershipNotice}</p><label className="field-label">{pairingText.workspaceLabel}<select value={workspaceId} onChange={(event) => onWorkspace(event.target.value)}>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label><button className="primary-button pairing-create-button" type="button" disabled={busy || workspaceId === ""} onClick={onCreate}>{busy && <LoaderCircle className="spinner" aria-hidden="true" size={16} />}{busy ? pairingText.creating : pairingText.generateCommand}</button></div>;
}

function WaitingForDevice({ pairing, pairCode, now, onCopy }: { pairing: WorkstationPairingSummary; pairCode: string | null; now: number; onCopy(message: string, tone?: "success" | "error"): void }) {
  const seconds = Math.max(0, Math.ceil((new Date(pairing.expiresAt).getTime() - now) / 1_000));
  const command = pairCode === null ? null : `curl -fsSL ${appBaseUrl()}api/connector/install.sh | sh -s -- --server ${appBaseUrl()} --pair ${pairCode}`;
  const copy = async () => {
    if (command === null) return;
    try { await navigator.clipboard.writeText(command); onCopy(pairingText.commandCopiedToast); }
    catch { onCopy(pairingText.clipboardFailedToast, "error"); }
  };
  return <div className="pairing-waiting"><div className="pairing-status-line"><Clock3 aria-hidden="true" size={18} /><div><strong>{pairingText.waitingTitle}</strong><span>{formatCountdown(seconds)}{pairingText.expiresSuffix}{pairing.workspaceName}</span></div></div>{command === null ? <p className="pairing-unavailable">{pairingText.commandUnavailable}</p> : <><code className="pairing-command">{command}</code><button className="secondary-button pairing-copy" type="button" onClick={() => void copy()}><Clipboard aria-hidden="true" size={16} />{pairingText.copyCommand}</button></>}</div>;
}

function ConfirmDevice({ pairing, name, onName }: { pairing: WorkstationPairingSummary; name: string; onName(value: string): void }) {
  return <div className="pairing-confirm"><div className="pairing-status-line"><ShieldCheck aria-hidden="true" size={18} /><div><strong>{pairingText.confirmTitle}</strong><span>{pairingText.confirmSubtitle}</span></div></div><dl className="pairing-facts"><div><dt>{pairingText.workspaceLabel}</dt><dd>{pairing.workspaceName}</dd></div><div><dt>{pairingText.platformLabel}</dt><dd>{pairing.platform}</dd></div><div><dt>{pairingText.connectorLabel}</dt><dd>{pairing.connectorVersion}</dd></div><div><dt>{pairingText.fingerprintLabel}</dt><dd className="mono">{pairing.fingerprint}</dd></div></dl><label className="field-label">{pairingText.workstationNameLabel}<input value={name} maxLength={240} onChange={(event) => onName(event.target.value)} /></label></div>;
}

function PairingFinal({ pairing }: { pairing: WorkstationPairingSummary }) {
  const approved = pairing.status === "approved";
  return <div className={`pairing-final ${approved ? "is-approved" : ""}`}>{approved ? <CheckCircle2 aria-hidden="true" size={28} /> : <X aria-hidden="true" size={28} />}<h3>{approved ? pairingText.finalApproved : pairing.status === "expired" ? pairingText.finalExpired : pairingText.finalCancelled}</h3><p>{approved ? pairingText.finalApprovedBody(pairing.deviceName ?? pairingText.workstationFallback) : pairingText.finalRejectedBody}</p></div>;
}

function PairingLoading() { return <div className="pairing-loading"><LoaderCircle className="spinner" aria-hidden="true" size={22} /><span>{pairingText.restoring}</span></div>; }
function formatCountdown(seconds: number): string { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
function cssDuration(name: string, fallback: number): number { const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)); return Number.isFinite(value) ? value : fallback; }
function prefersReducedMotion(): boolean { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; }
