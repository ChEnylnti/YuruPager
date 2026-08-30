import {
  Activity,
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Cpu,
  Folder,
  HardDrive,
  History,
  Info,
  Laptop,
  MessageSquareText,
  Plus,
  Send,
  ShieldCheck,
  UserRound,
  UsersRound,
  X,
  UserPlus,
  UserMinus,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type {
  AuditSummary,
  RequestSummary,
  SessionSummary,
  SessionCommandSummary,
  Snapshot,
  WorkstationSummary,
  WorkspaceRole,
} from "@yurupager/shared";

import { StatusBadge } from "./request-detail.js";
import type { DraftImageAttachment } from "./attachment-upload.js";
import { SessionComposer } from "./session-composer.js";
import { SessionTimeline } from "./session-timeline.js";
import { TransitionText } from "./transition-text.js";
import { PairingDialog } from "./pairing-dialog.js";
import { WorkstationPreviewSection } from "./workstation-preview.js";
import type { LiveChannel } from "./live-channel.js";
import {
  createWorkspaceInvite,
  removeMember,
  revokeWorkstation,
  updateMemberRole,
  updateWorkstationAccess,
} from "./api.js";
import {
  auditActionLabel,
  deliveryStatusLabel,
  formatNumber,
  permissionAccessLabel,
  qualityLabel,
  relativeTime,
  requestStatusLabel,
  riskLabel,
  roleLabel,
  sessionStatusLabel,
  sessionSyncStateLabel,
  sessionCommandStatusLabel,
  workstationStatusLabel,
} from "./i18n.js";
import { errorLabel } from "./i18n.js";

export function InboxList({
  requests,
  selectedId,
  onSelect,
  motionPageId,
}: {
  requests: RequestSummary[];
  selectedId: string | null;
  onSelect(id: string): void;
  motionPageId?: "1";
}) {
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const visible = requests.filter((request) =>
    tab === "pending" ? request.status === "pending" : request.status !== "pending",
  );
  return (
    <section className={`object-list-pane ${motionPageId === undefined ? "" : "t-page"}`} data-page-id={motionPageId} aria-labelledby="inbox-list-heading">
      <header className="pane-heading">
        <div><p className="eyebrow">所有已授权工作区</p><h1 id="inbox-list-heading">请求</h1></div>
        <span className="count-slot" aria-label={`${requests.filter((request) => request.status === "pending").length} 个待处理请求`}>
          {requests.filter((request) => request.status === "pending").length}
        </span>
      </header>
      <SlidingTabs label="请求状态" value={tab} options={[{ value: "pending", label: "待处理" }, { value: "history", label: "历史" }]} onChange={(value) => setTab(value as "pending" | "history")} />
      <div className="object-list" role="tabpanel">
        {visible.length === 0 ? (
          <EmptyState icon={tab === "pending" ? CheckCircle2 : History} title={tab === "pending" ? "没有待处理请求" : "没有请求历史"} />
        ) : visible.map((request) => (
          <button
            key={request.id}
            data-request-id={request.id}
            className="request-row"
            data-selected={request.id === selectedId}
            type="button"
            onClick={() => onSelect(request.id)}
            aria-current={request.id === selectedId ? "true" : undefined}
          >
            <span className={`request-type-icon risk-bg-${request.risk}`} aria-hidden="true">
              {request.kind === "question" ? <AlertCircle size={17} /> : <ShieldCheck size={17} />}
            </span>
            <span className="row-main">
              <strong title={request.context.command ?? request.tool}>{request.context.command ?? request.context.questions?.[0]?.question ?? request.tool}</strong>
              <small><span>{request.workspaceName}</span><span aria-hidden="true">/</span><span>{request.workstationName}</span></small>
            </span>
            <span className="row-side"><span className={`risk-dot risk-dot-${request.risk}`} aria-label={`${riskLabel(request.risk)}风险`} /><time>{relativeTime(request.requestedAt)}</time></span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function WorkstationsView({ snapshot, onChanged, onToast }: {
  snapshot: Snapshot;
  onChanged(): void;
  onToast(message: string, tone?: "success" | "error"): void;
}) {
  const [selectedId, setSelectedId] = useState(snapshot.workstations[0]?.id ?? null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const selected = snapshot.workstations.find((item) => item.id === selectedId) ?? snapshot.workstations[0];
  useEffect(() => {
    if (selected === undefined && snapshot.workstations[0] !== undefined) setSelectedId(snapshot.workstations[0].id);
  }, [selected, snapshot.workstations]);
  return (
    <>
    <EntitySplit title="工作站" eyebrow="已授权设备" count={snapshot.workstations.length} action={<button ref={addButtonRef} className="pane-add-button" type="button" onClick={() => setPairingOpen(true)}><Plus aria-hidden="true" size={16} /><span>添加</span></button>}>
      <div className="entity-list">
        {snapshot.workstations.map((workstation) => (
          <button key={workstation.id} type="button" data-selected={selected?.id === workstation.id} onClick={() => setSelectedId(workstation.id)}>
            <span className="entity-leading"><Laptop size={18} aria-hidden="true" /></span>
            <span className="row-main"><strong>{workstation.name}</strong><small>{workstation.workspaceName}</small></span>
            <span className={`online-dot online-${workstation.status}`} aria-label={workstationStatusLabel(workstation.status)} />
          </button>
        ))}
      </div>
      {selected === undefined ? <EmptyState icon={Laptop} title="没有已授权工作站" /> : <WorkstationDetail workstation={selected} snapshot={snapshot} onChanged={onChanged} onToast={onToast} />}
    </EntitySplit>
    {pairingOpen && <PairingDialog snapshot={snapshot} onClose={() => { setPairingOpen(false); requestAnimationFrame(() => addButtonRef.current?.focus()); }} onChanged={onChanged} onToast={onToast} />}
    </>
  );
}

function WorkstationDetail({ workstation, snapshot, onChanged, onToast }: {
  workstation: WorkstationSummary;
  snapshot: Snapshot;
  onChanged(): void;
  onToast(message: string, tone?: "success" | "error"): void;
}) {
  const sessions = snapshot.sessions.filter((session) => session.workstationId === workstation.id);
  const requests = snapshot.requests.filter((request) => request.workstationId === workstation.id && request.status === "pending");
  const members = snapshot.members.filter((member) => member.workspaceId === workstation.workspaceId);
  const workspace = snapshot.workspaces.find((item) => item.id === workstation.workspaceId);
  const canManage = workspace?.role === "owner" || workspace?.role === "admin";
  const [accessOpen, setAccessOpen] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [revokeConfirm, setRevokeConfirm] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const manageAccess = async (member: Snapshot["members"][number], key: "canView" | "canRespond" | "canApproveHighRisk" | "canManage" | "canPreview") => {
    const current = member.workstationAccess.find((grant) => grant.workstationId === workstation.id);
    const next = {
      userId: member.userId,
      canView: current?.canView ?? false,
      canRespond: current?.canRespond ?? false,
      canApproveHighRisk: current?.canApproveHighRisk ?? false,
      canManage: current?.canManage ?? false,
      canPreview: current?.canPreview ?? false,
    };
    next[key] = !next[key];
    setBusyUserId(member.userId);
    setAccessError(null);
    try {
      await updateWorkstationAccess(workstation.workspaceId, workstation.id, next);
      onToast("工作站授权已更新");
      onChanged();
    } catch (reason) {
      setAccessError(errorLabel(reason, "无法更新工作站授权"));
    } finally {
      setBusyUserId(null);
    }
  };
  const revoke = async () => {
    setRevoking(true);
    setAccessError(null);
    try {
      await revokeWorkstation(workstation.workspaceId, workstation.id);
      onToast("工作站已撤销");
      onChanged();
    } catch (reason) {
      setAccessError(errorLabel(reason, "无法撤销工作站"));
    } finally {
      setRevoking(false);
      setRevokeConfirm(false);
    }
  };
  return (
    <article className="entity-detail">
      <header className="entity-detail-header">
        <div className="large-entity-icon"><Laptop aria-hidden="true" size={22} /></div>
        <div><p className="eyebrow">{workstation.workspaceName}</p><h2>{workstation.name}</h2><p>{workstation.platform}</p></div>
        <span className={`connection-label connection-${workstation.status}`}>{workstationStatusLabel(workstation.status)}</span>
      </header>
      <dl className="metric-strip">
        <Metric label="活跃会话" value={String(workstation.activeSessionCount)} />
        <Metric label="待处理" value={String(workstation.pendingCount)} />
        <Metric label="连接器" value={workstation.connectorVersion} />
        <Metric label="最近在线" value={workstation.lastSeenAt === null ? "从未在线" : relativeTime(workstation.lastSeenAt)} />
      </dl>
      <section className="entity-section workstation-controls" aria-labelledby={`workstation-controls-${workstation.id}`}>
        <div className="section-heading-row"><h3 id={`workstation-controls-${workstation.id}`}>工作站授权</h3>{canManage && <button className="secondary-button compact-action" type="button" onClick={() => setAccessOpen((open) => !open)} aria-expanded={accessOpen}>{accessOpen ? "收起" : "编辑授权"}</button>}</div>
        {!canManage ? <p className="permission-notice"><ShieldCheck aria-hidden="true" size={15} />你没有此工作区的管理权限，当前仅可查看状态。</p> : accessOpen && <div className="access-editor">
          {members.length === 0 ? <InlineEmpty text="此工作区暂无其他成员" /> : members.map((member) => {
            const grant = member.workstationAccess.find((item) => item.workstationId === workstation.id);
            const inherited = member.role === "owner" || member.role === "admin";
            return <div className="access-editor-row" key={member.userId}><div className="access-editor-person"><strong>{member.name}</strong><small>{member.email} / {roleLabel(member.role)}</small></div><div className="access-editor-toggles">
              {(["canView", "canRespond", "canApproveHighRisk", "canManage", "canPreview"] as const).map((permission) => <label key={permission} className="permission-toggle"><input type="checkbox" checked={inherited || grant?.[permission] === true} disabled={inherited || busyUserId === member.userId} onChange={() => void manageAccess(member, permission)} /><span>{permissionLabel(permission)}</span></label>)}
            </div></div>;
          })}
          {accessError !== null && <p className="inline-error" role="alert">{accessError}</p>}
        </div>}
        {canManage && <div className="danger-action-row"><span>撤销后将立即断开 Connector，并清除连接凭据。</span>{revokeConfirm ? <span className="confirm-actions"><button className="secondary-button compact-action" type="button" disabled={revoking} onClick={() => setRevokeConfirm(false)}>取消</button><button className="danger-button compact-action" type="button" disabled={revoking} onClick={() => void revoke()}>{revoking ? "正在撤销" : "确认撤销"}</button></span> : <button className="danger-button compact-action" type="button" onClick={() => setRevokeConfirm(true)}><UserMinus aria-hidden="true" size={14} />撤销工作站</button>}</div>}
      </section>
      <WorkstationPreviewSection
        workstationId={workstation.id}
        previews={snapshot.previews ?? []}
        capability={snapshot.previewCapability ?? { enabled: false, gatewayOrigin: null, command: "yurupager preview <port>" }}
        onChanged={onChanged}
        onToast={onToast}
      />
      <section className="entity-section"><h3>活跃会话</h3>
        {sessions.length === 0 ? <InlineEmpty text="此工作站暂无会话" /> : sessions.map((session) => <SessionLine key={session.id} session={session} />)}
      </section>
      <section className="entity-section"><h3>待处理请求</h3>
        {requests.length === 0 ? <InlineEmpty text="没有待处理请求" /> : requests.map((request) => (
          <div className="activity-line" key={request.id}><ShieldCheck size={17} aria-hidden="true" /><div><strong>{request.context.command ?? request.tool}</strong><span>{riskLabel(request.risk)}风险 / {request.assignedToName ?? "未指派"}</span></div><StatusBadge status={request.status} /></div>
        ))}
      </section>
    </article>
  );
}

export function SessionsView({ snapshot, sessionTitles, selectedId, mobileDetail, online, liveChannel, onSelect, onBack, onCommandChange, onToast }: {
  snapshot: Snapshot;
  sessionTitles: Record<string, string>;
  selectedId: string | null;
  mobileDetail: boolean;
  online: boolean;
  liveChannel: LiveChannel;
  onSelect(id: string): void;
  onBack(): void;
  onCommandChange(command: SessionCommandSummary): void;
  onToast(message: string, tone?: "success" | "error"): void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attachmentDrafts, setAttachmentDrafts] = useState<Record<string, DraftImageAttachment[]>>({});
  const attachmentDraftsRef = useRef(attachmentDrafts);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [motionReady, setMotionReady] = useState(false);
  const scopeRef = useRef(snapshot.scopeWorkspaceId);
  const selectedSessionRef = useRef<string | undefined>(undefined);
  const selected = snapshot.sessions.find((item) => item.id === selectedId) ?? snapshot.sessions[0];
  const projects = useMemo(() => groupSessionsByProject(snapshot.sessions), [snapshot.sessions]);
  const mobileViewport = useMobileViewport();
  const conversationActive = !mobileViewport || mobileDetail;
  useEffect(() => { attachmentDraftsRef.current = attachmentDrafts; }, [attachmentDrafts]);
  useEffect(() => {
    if (scopeRef.current === snapshot.scopeWorkspaceId) return;
    for (const attachments of Object.values(attachmentDraftsRef.current)) {
      for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
    }
    attachmentDraftsRef.current = {};
    setAttachmentDrafts({});
    setDrafts({});
    scopeRef.current = snapshot.scopeWorkspaceId;
  }, [snapshot.scopeWorkspaceId]);
  useEffect(() => {
    const previousId = selectedSessionRef.current;
    const nextId = selected?.id;
    selectedSessionRef.current = nextId;
    if (previousId === undefined || previousId === nextId) return;
    const previous = attachmentDraftsRef.current[previousId] ?? [];
    for (const attachment of previous) URL.revokeObjectURL(attachment.previewUrl);
    if (previous.length > 0) {
      const nextDrafts = { ...attachmentDraftsRef.current, [previousId]: [] };
      attachmentDraftsRef.current = nextDrafts;
      setAttachmentDrafts(nextDrafts);
    }
  }, [selected?.id]);
  useEffect(() => () => {
    for (const attachments of Object.values(attachmentDraftsRef.current)) {
      for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
    }
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMotionReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (selected === undefined) return;
    const projectId = projectGroupId(selected);
    setCollapsedProjects((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  }, [selected?.id]);
  return (
    <section className={`entity-split session-workspace t-page-slide ${motionReady ? "is-motion-ready" : ""}`} data-page={mobileDetail ? "2" : "1"}>
      <div className="entity-index session-index t-page" data-page-id="1" aria-hidden={mobileViewport && mobileDetail ? "true" : undefined} inert={mobileViewport && mobileDetail ? true : undefined}>
        <header className="pane-heading"><div><p className="eyebrow">{projects.length} 个本机项目</p><h1>会话</h1></div><span className="count-slot" aria-label={`${snapshot.sessions.length} 个会话`}>{snapshot.sessions.length}</span></header>
        <div className="entity-list session-project-list">
          {snapshot.sessions.length === 0 ? <EmptyState icon={Activity} title="当前范围暂无会话" /> : projects.map((project) => {
            const collapsed = collapsedProjects.has(project.id);
            const regionId = `project-sessions-${project.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
            return (
              <section className="session-project-group t-acc" data-open={String(!collapsed)} key={project.id} aria-labelledby={`${regionId}-heading`}>
                <button
                  id={`${regionId}-heading`}
                  className="session-project-toggle t-acc-head"
                  type="button"
                  aria-expanded={!collapsed}
                  aria-controls={regionId}
                  onClick={() => setCollapsedProjects((current) => {
                    const next = new Set(current);
                    if (next.has(project.id)) next.delete(project.id); else next.add(project.id);
                    return next;
                  })}
                >
                  <span className="session-project-icon"><Folder size={17} aria-hidden="true" /></span>
                  <span className="session-project-copy"><strong title={project.name}>{project.name}</strong><small className="mono" title={project.path}>{project.path}</small><small title={`${workspaceLabel(snapshot, project.workspaceId)} / ${project.workstationName}`}>{workspaceLabel(snapshot, project.workspaceId)} / {project.workstationName}</small></span>
                  <span className="session-project-count" aria-label={`${project.sessions.length} 个会话`}>{project.sessions.length}</span>
                  <span className="session-project-chevron t-acc-chevron"><ChevronDown size={17} aria-hidden="true" /></span>
                </button>
                <div id={regionId} className="t-acc-panel" role="group" aria-label={`${project.name} 的会话`} aria-hidden={collapsed ? "true" : undefined} inert={collapsed ? true : undefined}>
                  <div className="session-project-sessions t-acc-panel-inner">
                    {project.sessions.map((session) => {
                      const displayTitle = sessionDisplayTitle(session, sessionTitles);
                      return <button className="session-row" key={session.id} type="button" data-session-id={session.id} data-selected={selected?.id === session.id} aria-current={selected?.id === session.id ? "true" : undefined} onClick={() => onSelect(session.id)}>
                        <span className="entity-leading"><MessageSquareText size={17} aria-hidden="true" /></span>
                        <span className="row-main"><strong title={displayTitle}>{displayTitle}</strong><small><span>{session.initiatorName ?? "未知发起人"}</span><span aria-hidden="true">/</span><time>{relativeTime(session.updatedAt)}</time></small></span>
                        <span className={`session-state session-${session.status}`}>
                          {sessionSyncStateLabel(session.syncState) ?? sessionStatusLabel(session.status)}
                        </span>
                      </button>;
                    })}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      </div>
      <div className="entity-detail-pane session-detail-pane t-page" data-page-id="2" aria-hidden={mobileViewport && !mobileDetail ? "true" : undefined} inert={mobileViewport && !mobileDetail ? true : undefined}>
        {selected === undefined ? <EmptyState icon={Activity} title="当前范围暂无会话" /> : (
          <SessionDetail
            session={selected}
            title={sessionDisplayTitle(selected, sessionTitles)}
            snapshot={snapshot}
            active={conversationActive}
            online={online}
            liveChannel={liveChannel}
            draft={drafts[selected.id] ?? ""}
            attachments={attachmentDrafts[selected.id] ?? []}
            onBack={onBack}
            onDraftChange={(value) => setDrafts((current) => ({ ...current, [selected.id]: value }))}
            onAttachmentsChange={(attachments) => setAttachmentDrafts((current) => ({ ...current, [selected.id]: attachments }))}
            onCommandChange={onCommandChange}
            onToast={onToast}
          />
        )}
      </div>
    </section>
  );
}

interface SessionProjectGroup {
  id: string;
  name: string;
  path: string;
  workspaceId: string;
  workstationName: string;
  sessions: SessionSummary[];
}

export function groupSessionsByProject(sessions: SessionSummary[]): SessionProjectGroup[] {
  const groups = new Map<string, SessionProjectGroup>();
  const ordered = [...sessions].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  for (const session of ordered) {
    const id = projectGroupId(session);
    const current = groups.get(id);
    if (current !== undefined) {
      current.sessions.push(session);
      continue;
    }
    groups.set(id, {
      id,
      name: session.projectName,
      path: session.projectPath,
      workspaceId: session.workspaceId,
      workstationName: session.workstationName,
      sessions: [session],
    });
  }
  return [...groups.values()];
}

function projectGroupId(session: SessionSummary): string {
  return `${session.workspaceId}:${session.workstationId}:${session.projectKey}`;
}

function sessionDisplayTitle(session: SessionSummary, titles: Record<string, string>): string {
  return titles[session.id] ?? `Codex 会话 ${session.threadId.slice(0, 8)}`;
}

function SessionDetail({ session, title, snapshot, active, online, liveChannel, draft, attachments, onBack, onDraftChange, onAttachmentsChange, onCommandChange, onToast }: {
  session: SessionSummary;
  title: string;
  snapshot: Snapshot;
  active: boolean;
  online: boolean;
  liveChannel: LiveChannel;
  draft: string;
  attachments: DraftImageAttachment[];
  onBack(): void;
  onDraftChange(value: string): void;
  onAttachmentsChange(attachments: DraftImageAttachment[]): void;
  onCommandChange(command: SessionCommandSummary): void;
  onToast(message: string, tone?: "success" | "error"): void;
}) {
  const requests = snapshot.requests.filter((request) => request.sessionId === session.id);
  const commands = (snapshot.sessionCommands ?? []).filter((command) => command.sessionId === session.id);
  const usage = snapshot.usage.find((item) => item.sessionId === session.id);
  const workstation = snapshot.workstations.find((item) => item.id === session.workstationId);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoButtonRef = useRef<HTMLButtonElement>(null);
  const closeInfo = useCallback(() => {
    setInfoOpen(false);
    requestAnimationFrame(() => infoButtonRef.current?.focus());
  }, []);
  useEffect(() => setInfoOpen(false), [session.id]);
  return (
    <article className="entity-detail session-detail">
      <header className="mobile-session-header">
        <button className="icon-button" type="button" onClick={onBack} aria-label="返回会话列表" title="返回会话列表"><ArrowLeft aria-hidden="true" size={21} /></button>
        <div className="mobile-session-title"><h2 title={title}>{title}</h2><p title={`${session.projectName} / ${workspaceLabel(snapshot, session.workspaceId)} / ${session.workstationName}`}>{session.projectName} / {workspaceLabel(snapshot, session.workspaceId)} / {session.workstationName}</p></div>
        <span className={`session-state session-${session.status}`}>
          {sessionSyncStateLabel(session.syncState) ?? sessionStatusLabel(session.status)}
        </span>
        <button ref={infoButtonRef} className="icon-button" type="button" onClick={() => setInfoOpen(true)} aria-label="查看会话信息" title="查看会话信息"><Info aria-hidden="true" size={20} /></button>
      </header>
      <header className="entity-detail-header"><div className="large-entity-icon"><Activity size={22} aria-hidden="true" /></div><div><p className="eyebrow">{session.projectName} / {workspaceLabel(snapshot, session.workspaceId)} / {session.workstationName}</p><h2 title={title}>{title}</h2><p className="mono wrap-anywhere">{session.projectPath}</p></div><span className={`session-state session-${session.status}`}>{sessionSyncStateLabel(session.syncState) ?? sessionStatusLabel(session.status)}</span></header>
      <dl className="metric-strip">
        <Metric label="发起人" value={session.initiatorName ?? "未知"} />
        <Metric label="模型" value={session.model} />
        <Metric label="请求" value={String(requests.length)} />
        <Metric label="Token" value={usage === undefined ? "不完整" : formatNumber(usage.totalTokens)} />
      </dl>
      <div className="session-detail-center">
        <SessionTimeline sessionId={session.id} channel={liveChannel} serverOnline={online} active={active} />
        <details className="session-records">
          <summary>传输与请求记录 <span>{commands.length + requests.length}</span></summary>
          <SessionRecordList commands={commands} requests={requests} />
        </details>
      </div>
      <SessionComposer session={session} workstation={workstation} online={online} value={draft} attachments={attachments} channel={liveChannel} onChange={onDraftChange} onAttachmentsChange={onAttachmentsChange} onCommandChange={onCommandChange} onToast={onToast} />
      {infoOpen && <SessionInfoSheet session={session} title={title} snapshot={snapshot} requests={requests} commands={commands} tokenTotal={usage?.totalTokens} onClose={closeInfo} />}
    </article>
  );
}

function SessionInfoSheet({ session, title, snapshot, requests, commands, tokenTotal, onClose }: {
  session: SessionSummary;
  title: string;
  snapshot: Snapshot;
  requests: RequestSummary[];
  commands: SessionCommandSummary[];
  tokenTotal: number | undefined;
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const [motionState, setMotionState] = useState<"entering" | "open" | "closing">("entering");
  const requestClose = useCallback(() => {
    if (motionState === "closing") return;
    setMotionState("closing");
    closeTimer.current = window.setTimeout(
      onClose,
      prefersReducedMotion() ? 0 : cssDuration("--modal-close-dur", 150),
    );
  }, [motionState, onClose]);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab" || dialog === null) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMotionState((current) => current === "entering" ? "open" : current));
    return () => {
      cancelAnimationFrame(frame);
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    };
  }, []);
  return (
    <div className="dialog-backdrop session-info-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <div ref={dialogRef} className={`session-info-sheet t-modal ${motionState === "open" ? "is-open" : motionState === "closing" ? "is-closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="session-info-title" tabIndex={-1}>
        <header className="session-info-header"><div><p className="eyebrow">会话详情</p><h2 id="session-info-title">{title}</h2></div><button className="icon-button" type="button" onClick={requestClose} aria-label="关闭会话信息" title="关闭会话信息"><X aria-hidden="true" size={20} /></button></header>
        <div className="session-info-scroll">
          <dl className="session-info-facts">
            <Metric label="工作区" value={workspaceLabel(snapshot, session.workspaceId)} />
            <Metric label="工作站" value={session.workstationName} />
            <Metric label="项目" value={session.projectName} />
            <Metric label="项目路径" value={session.projectPath} />
        <Metric label="会话状态" value={sessionSyncStateLabel(session.syncState) ?? sessionStatusLabel(session.status)} />
            <Metric label="发起人" value={session.initiatorName ?? "未知"} />
            <Metric label="模型" value={session.model} />
            <Metric label="请求" value={String(requests.length)} />
            <Metric label="Token" value={tokenTotal === undefined ? "不完整" : formatNumber(tokenTotal)} />
          </dl>
          <section className="session-info-records" aria-labelledby="session-records-heading"><div className="session-info-section-heading"><h3 id="session-records-heading">传输与请求记录</h3><span>{commands.length + requests.length}</span></div><SessionRecordList commands={commands} requests={requests} /></section>
        </div>
      </div>
    </div>
  );
}

function SessionRecordList({ commands, requests }: { commands: SessionCommandSummary[]; requests: RequestSummary[] }) {
  return (
    <div className="session-records-scroll">
      {commands.map((command) => (
        <div className="activity-line command-line" key={command.id}>
          <Send size={16} aria-hidden="true" />
          <div><strong>{sessionCommandStatusLabel(command.status)}</strong><span>{command.actorName} / {relativeTime(command.createdAt)} / {command.contentLength.toLocaleString("zh-CN")} 字符</span></div>
          <span className={`command-status command-${command.status}`} aria-label={sessionCommandStatusLabel(command.status)}><TransitionText value={sessionCommandStatusLabel(command.status)} /></span>
        </div>
      ))}
      {requests.map((request) => <div className="activity-line" key={request.id}><ShieldCheck size={17} aria-hidden="true" /><div><strong>{request.context.command ?? request.tool}</strong><span>{relativeTime(request.requestedAt)} / {request.decidedByName ?? "未处理"}</span></div><StatusBadge status={request.status} /></div>)}
      {commands.length + requests.length === 0 && <InlineEmpty text="暂无传输与请求记录" />}
    </div>
  );
}

export function UsageView({ snapshot }: { snapshot: Snapshot }) {
  const [range, setRange] = useState("30d");
  const filteredUsage = useMemo(() => {
    const days = Number.parseInt(range, 10);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1_000;
    return snapshot.usage.filter((item) => new Date(item.updatedAt).getTime() >= cutoff);
  }, [range, snapshot.usage]);
  const totals = useMemo(() => filteredUsage.reduce((sum, item) => ({
    tokens: sum.tokens + item.totalTokens,
    cost: sum.cost + (item.estimatedCostMicros ?? 0),
    priced: sum.priced + (item.estimatedCostMicros === null ? 0 : 1),
    incomplete: sum.incomplete || item.quality === "incomplete",
  }), { tokens: 0, cost: 0, priced: 0, incomplete: false }), [filteredUsage]);
  const estimatedCost = totals.priced === 0
    ? "暂无"
    : `$${(totals.cost / 1_000_000).toFixed(2)}${totals.priced < filteredUsage.length ? "（部分估算）" : ""}`;
  return (
    <section className="full-view" aria-labelledby="usage-heading">
      <header className="full-view-heading"><div><p className="eyebrow">累计 app-server 快照</p><h1 id="usage-heading">Token 用量</h1></div><SlidingTabs compact label="时间范围" value={range} options={["7d", "30d", "90d"].map((value) => ({ value, label: value.replace("d", "天") }))} onChange={setRange} /></header>
      <dl className="usage-summary"><Metric label="Token 总量" value={formatNumber(totals.tokens)} /><Metric label="预计成本" value={estimatedCost} /><Metric label="会话数" value={String(filteredUsage.length)} /><Metric label="数据质量" value={totals.incomplete ? "不完整" : "已校准"} /></dl>
      <div className="table-wrap"><table><thead><tr><th>工作区</th><th>会话</th><th>工作站</th><th>模型</th><th>输入</th><th>缓存</th><th>输出</th><th>总量</th><th>成本</th><th>质量</th></tr></thead><tbody>
        {filteredUsage.map((item) => <tr key={item.id}><td>{workspaceLabel(snapshot, item.workspaceId)}</td><td><strong>{item.projectName}</strong><small className="mono">{item.sessionId.slice(0, 8)}</small></td><td>{item.workstationName}</td><td className="mono">{item.model}</td><td>{formatNumber(item.inputTokens)}</td><td>{formatNumber(item.cachedInputTokens)}</td><td>{formatNumber(item.outputTokens)}</td><td><strong>{formatNumber(item.totalTokens)}</strong></td><td>{item.estimatedCostMicros === null ? "暂无" : `$${(item.estimatedCostMicros / 1_000_000).toFixed(2)}`}<small>{item.priceVersion === null ? "" : `估算 / ${item.priceVersion}`}</small></td><td><span className={`quality quality-${item.quality}`}>{qualityLabel(item.quality)}</span></td></tr>)}
      </tbody></table></div>
    </section>
  );
}

export function MembersView({ snapshot, onChanged, onToast }: { snapshot: Snapshot; onChanged(): void; onToast(message: string, tone?: "success" | "error"): void }) {
  const workspaceName = snapshot.scopeWorkspaceId === null ? "全部工作区" : snapshot.workspaces.find((workspace) => workspace.id === snapshot.scopeWorkspaceId)?.name ?? "工作区";
  const manageable = snapshot.workspaces.filter((workspace) => workspace.role === "owner" || workspace.role === "admin");
  const [workspaceId, setWorkspaceId] = useState(snapshot.scopeWorkspaceId ?? manageable[0]?.id ?? "");
  const [inviteRole, setInviteRole] = useState<Exclude<WorkspaceRole, "owner">>("member");
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [memberBusy, setMemberBusy] = useState<string | null>(null);
  const [removeConfirmUserId, setRemoveConfirmUserId] = useState<string | null>(null);
  const selectedMembers = snapshot.scopeWorkspaceId === null
    ? snapshot.members
    : snapshot.members.filter((member) => member.workspaceId === snapshot.scopeWorkspaceId);
  const createInvite = async () => {
    if (workspaceId === "") return;
    setInviteBusy(true); setInviteError(null);
    try {
      const result = await createWorkspaceInvite(workspaceId, inviteRole, crypto.randomUUID());
      setInviteToken(result.token);
      onToast("邀请已创建，请安全发送给协作者");
    } catch (reason) { setInviteError(errorLabel(reason, "无法创建邀请")); }
    finally { setInviteBusy(false); }
  };
  const copyInvite = async () => {
    if (inviteToken === null) return;
    try { await navigator.clipboard.writeText(inviteToken); onToast("邀请令牌已复制"); }
    catch { onToast("无法访问剪贴板，请手动复制令牌", "error"); }
  };
  const changeRole = async (memberWorkspaceId: string, userId: string, role: Exclude<WorkspaceRole, "owner">) => {
    const targetWorkspace = memberWorkspaceId;
    if (targetWorkspace === "") return;
    setMemberBusy(userId); setInviteError(null);
    try { await updateMemberRole(targetWorkspace, userId, role); onToast("成员角色已更新"); onChanged(); }
    catch (reason) { setInviteError(errorLabel(reason, "无法更新成员角色")); }
    finally { setMemberBusy(null); }
  };
  const remove = async (memberWorkspaceId: string, userId: string) => {
    const targetWorkspace = memberWorkspaceId;
    if (targetWorkspace === "") return;
    setMemberBusy(userId); setInviteError(null);
    try { await removeMember(targetWorkspace, userId); onToast("成员已移除"); onChanged(); }
    catch (reason) { setInviteError(errorLabel(reason, "无法移除成员")); }
    finally { setMemberBusy(null); }
  };
  return (
    <section className="full-view" aria-labelledby="members-heading"><header className="full-view-heading"><div><p className="eyebrow">{workspaceName}</p><h1 id="members-heading">成员与授权</h1></div></header>
      {manageable.length > 0 && <section className="management-toolbar" aria-label="工作区管理操作"><label>管理工作区<select value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setInviteToken(null); }}>{manageable.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label><label>邀请角色<select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Exclude<WorkspaceRole, "owner">)}><option value="member">成员</option><option value="admin">管理员</option></select></label><button className="primary-button compact-action" type="button" disabled={inviteBusy || workspaceId === ""} onClick={() => void createInvite()}><UserPlus aria-hidden="true" size={15} />{inviteBusy ? "创建中" : "创建邀请"}</button>{inviteToken !== null && <div className="invite-result"><code>{inviteToken}</code><button className="secondary-button compact-action" type="button" onClick={() => void copyInvite()}>复制令牌</button></div>}</section>}
      {inviteError !== null && <p className="management-error" role="alert">{inviteError}</p>}
      <div className="table-wrap"><table><thead><tr><th>工作区</th><th>成员</th><th>角色</th><th>已授权工作站</th><th>会话查看</th><th>普通请求</th><th>高风险请求</th><th>操作</th></tr></thead><tbody>
        {selectedMembers.map((member) => {
          const visible = member.workstationAccess.filter((grant) => grant.canView);
          const immutable = member.role === "owner";
          const canManageMember = snapshot.workspaces.find((workspace) => workspace.id === member.workspaceId)?.role === "owner" || snapshot.workspaces.find((workspace) => workspace.id === member.workspaceId)?.role === "admin";
          return <tr key={member.id}><td>{workspaceLabel(snapshot, member.workspaceId)}</td><td><div className="person-cell"><span>{initials(member.name)}</span><div><strong>{member.name}</strong><small>{member.email}</small></div></div></td><td>{immutable || !canManageMember ? <span className="role-label">{roleLabel(member.role)}</span> : <select aria-label={`成员角色：${member.name}`} className="inline-select" value={member.role} disabled={memberBusy === member.userId} onChange={(event) => void changeRole(member.workspaceId, member.userId, event.target.value as Exclude<WorkspaceRole, "owner">)}><option value="member">成员</option><option value="admin">管理员</option></select>}</td><td title={visible.map((grant) => grant.workstationName).join(", ")}>{member.workstationCount}</td><td><Permission allowed={visible.length > 0} /></td><td><Permission allowed={member.workstationAccess.some((grant) => grant.canRespond)} /></td><td><Permission allowed={member.workstationAccess.some((grant) => grant.canApproveHighRisk)} /></td><td>{immutable || !canManageMember ? <span className="muted-action">只读</span> : removeConfirmUserId === member.userId ? <span className="confirm-actions"><button className="secondary-button compact-action" type="button" disabled={memberBusy === member.userId} onClick={() => setRemoveConfirmUserId(null)}>取消</button><button className="danger-button compact-action" type="button" disabled={memberBusy === member.userId} onClick={() => void remove(member.workspaceId, member.userId)}>确认移除</button></span> : <button className="text-danger-button" type="button" disabled={memberBusy === member.userId} onClick={() => setRemoveConfirmUserId(member.userId)}><UserMinus aria-hidden="true" size={13} />移除</button>}</td></tr>;
        })}
      </tbody></table></div>
    </section>
  );
}

export function AuditView({ snapshot }: { snapshot: Snapshot }) {
  return (
    <section className="full-view" aria-labelledby="audit-heading"><header className="full-view-heading"><div><p className="eyebrow">追加式活动</p><h1 id="audit-heading">审计历史</h1></div></header>
      <div className="audit-list">{snapshot.audit.length === 0 ? <EmptyState icon={History} title="没有审计事件" /> : snapshot.audit.map((event) => <AuditLine key={event.id} event={event} workspaceName={workspaceLabel(snapshot, event.workspaceId)} />)}</div>
    </section>
  );
}

function AuditLine({ event, workspaceName }: { event: AuditSummary; workspaceName: string }) {
  return <div className="audit-line"><span className="audit-icon"><History size={16} aria-hidden="true" /></span><div><strong>{auditActionLabel(event.action)}</strong><p>{workspaceName} / {event.actorName ?? "连接器"} / {event.entityType} {event.entityId.slice(0, 8)}</p></div><div className="audit-state"><span>{requestStatusLabel(event.previousState ?? "")}{" → "}{requestStatusLabel(event.nextState ?? "")}</span><time>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(event.occurredAt))}</time></div></div>;
}

function SlidingTabs({ label, value, options, compact = false, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; compact?: boolean; onChange(value: string): void }) {
  const barRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const firstPaint = useRef(true);
  const moveToActive = (animate: boolean) => {
    const bar = barRef.current;
    const pill = pillRef.current;
    const active = bar?.querySelector<HTMLButtonElement>(`[data-tab-value="${value}"]`);
    if (pill === null || active === undefined || active === null) return;
    if (!animate) pill.style.transition = "none";
    pill.style.transform = `translateX(${active.offsetLeft}px)`;
    pill.style.width = `${active.offsetWidth}px`;
    if (!animate) {
      void pill.offsetWidth;
      pill.style.transition = "";
    }
  };
  useLayoutEffect(() => {
    moveToActive(!firstPaint.current);
    firstPaint.current = false;
  }, [value]);
  useEffect(() => {
    const resize = () => moveToActive(false);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [value]);
  return <div ref={barRef} className={`segmented-tabs t-tabs ${compact ? "compact" : ""}`} role="tablist" aria-label={label}><span ref={pillRef} className="t-tabs-pill" aria-hidden="true" />{options.map((option) => <button key={option.value} className="t-tab" data-tab-value={option.value} role="tab" aria-selected={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}

function EntitySplit({ title, eyebrow, count, action, children }: { title: string; eyebrow: string; count: number; action?: React.ReactNode; children: React.ReactNode }) {
  const childArray = Array.isArray(children) ? children : [children];
  return <section className="entity-split"><div className="entity-index"><header className="pane-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div><div className="pane-heading-actions">{action}<span className="count-slot">{count}</span></div></header>{childArray[0]}</div><div className="entity-detail-pane">{childArray[1]}</div></section>;
}

function SessionLine({ session }: { session: SessionSummary }) {
  return <div className="activity-line"><Activity size={17} aria-hidden="true" /><div><strong>{session.projectName}</strong><span>{session.initiatorName ?? "未知发起人"} / {session.model}</span></div><span className={`session-state session-${session.status}`}>{sessionSyncStateLabel(session.syncState) ?? sessionStatusLabel(session.status)}</span></div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd title={value}>{value}</dd></div>; }
function InlineEmpty({ text }: { text: string }) { return <p className="inline-empty">{text}</p>; }
function Permission({ allowed = true }: { allowed?: boolean }) { return <span className={allowed ? "permission-yes" : "permission-no"}>{allowed ? <CheckCircle2 size={16} aria-label="已允许" /> : <Clock3 size={16} aria-label="未授权" />}</span>; }
function EmptyState({ icon: Icon, title }: { icon: typeof Laptop; title: string }) { return <div className="empty-state"><Icon aria-hidden="true" size={24} /><p>{title}</p></div>; }
function initials(name: string) { return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
function workspaceLabel(snapshot: Snapshot, workspaceId: string) { return snapshot.workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "未知工作区"; }
function permissionLabel(value: "canView" | "canRespond" | "canApproveHighRisk" | "canManage" | "canPreview"): string {
  return ({ canView: "查看", canRespond: "回复", canApproveHighRisk: "高风险", canManage: "管理", canPreview: "预览" } as Record<string, string>)[value] ?? value;
}

function useMobileViewport() {
  const query = "(max-width: 720px)";
  const [matches, setMatches] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return matches;
}

function cssDuration(name: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
