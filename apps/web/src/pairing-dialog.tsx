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
import { errorLabel } from "./i18n.js";

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
    void load().catch((reason: unknown) => setError(errorLabel(reason, "无法读取配对状态"))).finally(() => setBusy(null));
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
      setError(errorLabel(reason, "无法创建配对"));
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
      onToast("工作站已授权，正在等待 Connector 上线");
      onChanged();
    } catch (reason) {
      setError(errorLabel(reason, "无法确认工作站"));
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
      onToast("配对已取消");
    } catch (reason) {
      setError(errorLabel(reason, "无法取消配对"));
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
          <div><p className="eyebrow">独立设备凭据</p><h2 id="pairing-title">添加工作站</h2></div>
          <button className="icon-button" type="button" aria-label="关闭配对" title="关闭" onClick={requestClose}><X aria-hidden="true" size={18} /></button>
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
            <button className="secondary-button" type="button" onClick={requestClose}>关闭</button>
          ) : selected.status === "waiting_for_device" ? (
            <><button className="secondary-button danger-text" type="button" disabled={busy !== null} onClick={() => void cancel()}>取消配对</button><button className="secondary-button" type="button" onClick={requestClose}>稍后继续</button></>
          ) : selected.status === "pending_approval" ? (
            <><button className="secondary-button danger-text" type="button" disabled={busy !== null} onClick={() => void cancel()}>拒绝连接</button><button className="primary-button" type="button" disabled={busy !== null || workstationName.trim() === ""} onClick={() => void approve()}>{busy === "approving" && <LoaderCircle className="spinner" aria-hidden="true" size={16} />}确认连接</button></>
          ) : (
            <><button className="secondary-button" type="button" onClick={startAnother}>继续添加</button><button className="primary-button" type="button" onClick={requestClose}>完成</button></>
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
  if (workspaces.length === 0) return <div className="pairing-empty"><ShieldCheck aria-hidden="true" size={22} /><p>你没有可管理工作站的工作区。</p></div>;
  return <div className="pairing-create"><p>选择工作站的数据归属。配对码十分钟有效，设备登记后仍需你明确确认。</p><label className="field-label">工作区<select value={workspaceId} onChange={(event) => onWorkspace(event.target.value)}>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label><button className="primary-button pairing-create-button" type="button" disabled={busy || workspaceId === ""} onClick={onCreate}>{busy && <LoaderCircle className="spinner" aria-hidden="true" size={16} />}{busy ? "正在创建" : "生成配对命令"}</button></div>;
}

function WaitingForDevice({ pairing, pairCode, now, onCopy }: { pairing: WorkstationPairingSummary; pairCode: string | null; now: number; onCopy(message: string, tone?: "success" | "error"): void }) {
  const seconds = Math.max(0, Math.ceil((new Date(pairing.expiresAt).getTime() - now) / 1_000));
  const command = pairCode === null ? null : `curl -fsSL ${appBaseUrl()}api/connector/install.sh | sh -s -- --server ${appBaseUrl()} --pair ${pairCode}`;
  const copy = async () => {
    if (command === null) return;
    try { await navigator.clipboard.writeText(command); onCopy("配对命令已复制"); }
    catch { onCopy("无法访问剪贴板，请手动复制", "error"); }
  };
  return <div className="pairing-waiting"><div className="pairing-status-line"><Clock3 aria-hidden="true" size={18} /><div><strong>等待设备运行命令</strong><span>{formatCountdown(seconds)} 后过期 / {pairing.workspaceName}</span></div></div>{command === null ? <p className="pairing-unavailable">此浏览器没有保存该短期码。请取消后重新创建配对。</p> : <><code className="pairing-command">{command}</code><button className="secondary-button pairing-copy" type="button" onClick={() => void copy()}><Clipboard aria-hidden="true" size={16} />复制命令</button></>}</div>;
}

function ConfirmDevice({ pairing, name, onName }: { pairing: WorkstationPairingSummary; name: string; onName(value: string): void }) {
  return <div className="pairing-confirm"><div className="pairing-status-line"><ShieldCheck aria-hidden="true" size={18} /><div><strong>核对候选设备</strong><span>确认后该设备将获得独立连接凭据</span></div></div><dl className="pairing-facts"><div><dt>工作区</dt><dd>{pairing.workspaceName}</dd></div><div><dt>平台</dt><dd>{pairing.platform}</dd></div><div><dt>Connector</dt><dd>{pairing.connectorVersion}</dd></div><div><dt>设备指纹</dt><dd className="mono">{pairing.fingerprint}</dd></div></dl><label className="field-label">工作站名称<input value={name} maxLength={240} onChange={(event) => onName(event.target.value)} /></label></div>;
}

function PairingFinal({ pairing }: { pairing: WorkstationPairingSummary }) {
  const approved = pairing.status === "approved";
  return <div className={`pairing-final ${approved ? "is-approved" : ""}`}>{approved ? <CheckCircle2 aria-hidden="true" size={28} /> : <X aria-hidden="true" size={28} />}<h3>{approved ? "工作站已授权" : pairing.status === "expired" ? "配对已过期" : "配对已取消"}</h3><p>{approved ? `${pairing.deviceName ?? "工作站"} 正在领取独立凭据并连接。` : "该配对码不能再用于连接。"}</p></div>;
}

function PairingLoading() { return <div className="pairing-loading"><LoaderCircle className="spinner" aria-hidden="true" size={22} /><span>正在恢复配对状态</span></div>; }
function formatCountdown(seconds: number): string { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
function cssDuration(name: string, fallback: number): number { const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)); return Number.isFinite(value) ? value : fallback; }
function prefersReducedMotion(): boolean { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; }
