import {
  Activity,
  Bell,
  ChevronDown,
  CircleDollarSign,
  ClipboardCheck,
  Plus,
  KeyRound,
  History,
  Laptop,
  LoaderCircle,
  LogOut,
  MessageSquareMore,
  RefreshCw,
  ShieldCheck,
  UsersRound,
  Wifi,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import type { RequestSummary, SessionCommandSummary, Snapshot, UserSummary, WebLiveServerMessage, WorkspaceKind } from "@yurupager/shared";

import {
  ApiError,
  getCurrentUser,
  getSnapshot,
  createWorkspace,
  joinWorkspaceInvite,
  login,
  logout,
} from "./api.js";
import { appWebSocketUrl } from "./base-path.js";
import { RequestDetail } from "./request-detail.js";
import {
  AuditView,
  InboxList,
  MembersView,
  SessionsView,
  UsageView,
  WorkstationsView,
} from "./views.js";
import { appText, errorLabel } from "./i18n.js";
import type { LiveChannel, LiveMessageHandler } from "./live-channel.js";
import { PushNotificationMenu } from "./push-notification-menu.js";

type ViewId = "inbox" | "workstations" | "sessions" | "usage" | "members" | "audit";

const navigation: Array<{ id: ViewId; label: string; icon: LucideIcon }> = [
  { id: "inbox", label: appText.navInbox, icon: ClipboardCheck },
  { id: "workstations", label: appText.navWorkstations, icon: Laptop },
  { id: "sessions", label: appText.navSessions, icon: Activity },
  { id: "usage", label: appText.navUsage, icon: CircleDollarSign },
  { id: "members", label: appText.navMembers, icon: UsersRound },
  { id: "audit", label: appText.navAudit, icon: History },
];
const cachePrefix = "yurupager:v2:";
const userCacheKey = `${cachePrefix}user`;

interface ToastState {
  id: number;
  message: string;
  tone: "success" | "error";
}

export function App() {
  const [authState, setAuthState] = useState<"checking" | "signed-out" | "signed-in">("checking");
  const [user, setUser] = useState<UserSummary | null>(null);
  const userIdRef = useRef<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [sessionTitles, setSessionTitles] = useState<Record<string, string>>({});
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverConnected, setServerConnected] = useState(navigator.onLine);
  const [view, setView] = useState<ViewId>(() => readViewFromUrl());
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(() => new URLSearchParams(location.search).get("request"));
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => new URLSearchParams(location.search).get("session"));
  const [mobileDetail, setMobileDetail] = useState(() => {
    const params = new URLSearchParams(location.search);
    return params.has("request") || params.has("session");
  });
  const [toast, setToast] = useState<ToastState | null>(null);
  const liveSocketRef = useRef<WebSocket | null>(null);
  const liveHandlersRef = useRef(new Set<LiveMessageHandler>());
  const liveChannel = useMemo<LiveChannel>(() => ({
    send(message) {
      const socket = liveSocketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
    subscribe(handler) {
      liveHandlersRef.current.add(handler);
      return () => liveHandlersRef.current.delete(handler);
    },
  }), []);

  const load = useCallback(async (scope: string | null, allowCache = true) => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await getSnapshot(scope);
      setSnapshot(next);
      if (userIdRef.current !== null) {
        localStorage.setItem(cacheKey(userIdRef.current, scope), JSON.stringify(next));
      }
      setServerConnected(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setAuthState("signed-out");
        setUser(null);
        userIdRef.current = null;
        setSessionTitles({});
        clearCachedSession();
        setSnapshot(null);
        return;
      }
      const cached = allowCache && userIdRef.current !== null
        ? readCachedSnapshot(userIdRef.current, scope)
        : null;
      if (cached !== null) setSnapshot(cached);
      setServerConnected(false);
      setLoadError(errorLabel(error, appText.snapshotLoadFailed));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void getCurrentUser()
      .then((current) => {
        userIdRef.current = current.id;
        localStorage.setItem(userCacheKey, JSON.stringify(current));
        setUser(current);
        setAuthState("signed-in");
        return load(workspaceId);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          clearCachedSession();
          setAuthState("signed-out");
          return;
        }
        const cached = readCachedUser();
        if (cached === null) {
          setAuthState("signed-out");
          return;
        }
        userIdRef.current = cached.id;
        setUser(cached);
        setAuthState("signed-in");
        void load(workspaceId);
      });
  }, [load, workspaceId]);

  useEffect(() => {
    if (authState !== "signed-in") return;
    let socket: WebSocket | null = null;
    let retry: number | null = null;
    let stopped = false;
    const connect = () => {
      if (stopped || !navigator.onLine) return;
      socket = new WebSocket(appWebSocketUrl("api/live"));
      liveSocketRef.current = socket;
      socket.addEventListener("open", () => setServerConnected(true));
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as WebLiveServerMessage;
        if (message.type === "snapshot.invalidated") void load(workspaceId, false);
        if (message.type === "session.titles.snapshot") {
          setSessionTitles(Object.fromEntries(message.titles.map((title) => [title.sessionId, title.title])));
        }
        for (const handler of liveHandlersRef.current) handler(message);
      });
      socket.addEventListener("close", () => {
        if (liveSocketRef.current === socket) liveSocketRef.current = null;
        setSessionTitles({});
        setServerConnected(false);
        if (!stopped) retry = window.setTimeout(connect, 1_500);
      });
      socket.addEventListener("error", () => socket?.close());
    };
    connect();
    const online = () => { setServerConnected(true); void load(workspaceId); connect(); };
    const offline = () => setServerConnected(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      stopped = true;
      if (liveSocketRef.current === socket) liveSocketRef.current = null;
      socket?.close();
      if (retry !== null) clearTimeout(retry);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [authState, load, workspaceId]);

  useEffect(() => {
    if (snapshot === null) return;
    const selected = snapshot.requests.find((request) => request.id === selectedRequestId);
    if (selected === undefined) {
      const preferred = snapshot.requests.find((request) => request.status === "pending") ?? snapshot.requests[0];
      setSelectedRequestId(preferred?.id ?? null);
    }
  }, [selectedRequestId, snapshot]);

  useEffect(() => {
    if (snapshot === null) return;
    const selected = snapshot.sessions.find((session) => session.id === selectedSessionId);
    if (selected === undefined) {
      setSelectedSessionId(snapshot.sessions[0]?.id ?? null);
    }
  }, [selectedSessionId, snapshot]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === null) return;
    const updateViewportHeight = () => {
      document.documentElement.style.setProperty("--visual-viewport-height", `${viewport.height}px`);
    };
    updateViewportHeight();
    viewport.addEventListener("resize", updateViewportHeight);
    return () => {
      viewport.removeEventListener("resize", updateViewportHeight);
      document.documentElement.style.removeProperty("--visual-viewport-height");
    };
  }, []);

  const notify = (message: string, tone: "success" | "error" = "success") => {
    const next = { id: Date.now(), message, tone };
    setToast(next);
  };
  const signedIn = (current: UserSummary) => {
    userIdRef.current = current.id;
    localStorage.setItem(userCacheKey, JSON.stringify(current));
    setUser(current);
    setAuthState("signed-in");
    void load(workspaceId, false);
  };
  const signedOut = () => {
    clearCachedSession();
    userIdRef.current = null;
    setAuthState("signed-out");
    setUser(null);
    setSnapshot(null);
    setSessionTitles({});
  };

  if (authState === "checking") return <BootScreen />;
  if (authState === "signed-out" || user === null) {
    return <LoginScreen onSignedIn={signedIn} />;
  }

  const changeView = (next: ViewId) => {
    setView(next);
    setMobileDetail(false);
    const url = new URL(location.href);
    url.searchParams.set("view", next);
    url.searchParams.delete("request");
    url.searchParams.delete("session");
    history.replaceState(null, "", url);
  };
  const selectRequest = (id: string) => {
    setSelectedRequestId(id);
    setMobileDetail(true);
    const url = new URL(location.href);
    url.searchParams.set("view", "inbox");
    url.searchParams.set("request", id);
    url.searchParams.delete("session");
    history.replaceState(null, "", url);
  };
  const selectSession = (id: string) => {
    setSelectedSessionId(id);
    setMobileDetail(true);
    const url = new URL(location.href);
    url.searchParams.set("view", "sessions");
    url.searchParams.set("session", id);
    url.searchParams.delete("request");
    history.replaceState(null, "", url);
  };
  const updateRequest = (next: RequestSummary) => {
    setSnapshot((current) => current === null ? current : {
      ...current,
      requests: current.requests.map((request) => request.id === next.id ? next : request),
    });
  };
  const updateSessionCommand = (next: SessionCommandSummary) => {
    setSnapshot((current) => {
      if (current === null) return current;
      const commands = current.sessionCommands ?? [];
      return {
        ...current,
        sessionCommands: commands.some((command) => command.id === next.id)
          ? commands.map((command) => command.id === next.id ? next : command)
          : [next, ...commands],
      };
    });
  };
  const closeMobileDetail = () => {
    setMobileDetail(false);
    const selectedId = view === "sessions" ? selectedSessionId : selectedRequestId;
    const selector = view === "sessions" ? "data-session-id" : "data-request-id";
    const url = new URL(location.href);
    url.searchParams.delete(view === "sessions" ? "session" : "request");
    history.replaceState(null, "", url);
    requestAnimationFrame(() => {
      if (selectedId !== null) {
        document.querySelector<HTMLButtonElement>(`[${selector}="${selectedId}"]`)?.focus();
      }
    });
  };

  return (
    <div className={`app-root ${view === "sessions" && mobileDetail ? "mobile-conversation-open" : ""}`}>
      <TopBar
        user={user}
        snapshot={snapshot}
        workspaceId={workspaceId}
        connected={serverConnected}
        loading={loading}
        onWorkspace={(next) => {
          setWorkspaceId(next);
          setSelectedRequestId(null);
          setSelectedSessionId(null);
          setMobileDetail(false);
        }}
        onRefresh={() => void load(workspaceId, false)}
        onChanged={() => void load(workspaceId, false)}
        onLogout={() => void logout().finally(signedOut)}
        onToast={notify}
      />
      <aside className="side-nav" aria-label={appText.sideNavAria}>
        <nav>{navigation.map((item) => <NavButton key={item.id} item={item} active={view === item.id} pending={item.id === "inbox" ? snapshot?.requests.filter((request) => request.status === "pending").length ?? 0 : 0} onClick={() => changeView(item.id)} />)}</nav>
        <div className="privacy-note"><ShieldCheck aria-hidden="true" size={16} /><span>{appText.privacyNote}</span></div>
      </aside>

      <main className={`main-surface view-${view} ${mobileDetail ? "mobile-detail-open" : ""}`}>
        <div className={`snapshot-shell t-skel ${snapshot !== null || loadError !== null ? "is-revealed" : ""}`}>
          <div
            className="t-skel-skeleton skeleton-layout is-pulsing"
            role="status"
            aria-label={appText.loadingWorkspacesAria}
            aria-hidden={snapshot !== null || loadError !== null}
          ><div /><div /><div /></div>
          <div className="t-skel-content">
            {snapshot === null ? (
              <SnapshotState error={loadError} onRetry={() => void load(workspaceId, false)} />
            ) : view === "inbox" ? (
              <InboxWorkspace
                snapshot={snapshot}
                selectedRequestId={selectedRequestId}
                connected={serverConnected}
                mobileDetail={mobileDetail}
                onSelect={selectRequest}
                onBack={closeMobileDetail}
                onRequestChange={updateRequest}
                onToast={notify}
              />
            ) : view === "workstations" ? <WorkstationsView snapshot={snapshot} onChanged={() => void load(workspaceId, false)} onToast={notify} />
              : view === "sessions" ? <SessionsView snapshot={snapshot} sessionTitles={sessionTitles} selectedId={selectedSessionId} mobileDetail={mobileDetail} online={serverConnected} liveChannel={liveChannel} onSelect={selectSession} onBack={closeMobileDetail} onCommandChange={updateSessionCommand} onToast={notify} />
                : view === "usage" ? <UsageView snapshot={snapshot} />
                  : view === "members" ? <MembersView snapshot={snapshot} onChanged={() => void load(workspaceId, false)} onToast={notify} />
                    : <AuditView snapshot={snapshot} />}
          </div>
        </div>
        {loading && snapshot !== null && <div className="refresh-line" role="status"><span /><span className="sr-only">{appText.refreshingSnapshot}</span></div>}
      </main>

      <nav className="bottom-nav" aria-label={appText.mobileNavAria}>
        {navigation.slice(0, 3).map((item) => <NavButton key={item.id} item={item} active={view === item.id} pending={item.id === "inbox" ? snapshot?.requests.filter((request) => request.status === "pending").length ?? 0 : 0} onClick={() => changeView(item.id)} />)}
        <NavButton item={{ id: "usage", label: appText.navMore, icon: MessageSquareMore }} active={["usage", "members", "audit"].includes(view)} pending={0} onClick={() => changeView("usage")} />
      </nav>

      {loadError !== null && snapshot !== null && <div className={`snapshot-warning ${mobileDetail && view === "inbox" ? "with-decision-bar" : ""}`} role="status"><WifiOff size={16} aria-hidden="true" /><span>{loadError}{appText.staleSnapshotSuffix}</span><button type="button" onClick={() => void load(workspaceId, false)}>{appText.retry}</button></div>}
      {toast !== null && <Toast toast={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

function InboxWorkspace({
  snapshot,
  selectedRequestId,
  connected,
  mobileDetail,
  onSelect,
  onBack,
  onRequestChange,
  onToast,
}: {
  snapshot: Snapshot;
  selectedRequestId: string | null;
  connected: boolean;
  mobileDetail: boolean;
  onSelect(id: string): void;
  onBack(): void;
  onRequestChange(request: RequestSummary): void;
  onToast(message: string, tone?: "success" | "error"): void;
}) {
  const selected = snapshot.requests.find((request) => request.id === selectedRequestId) ?? null;
  return (
    <div className="inbox-workspace t-page-slide" data-page={mobileDetail ? "2" : "1"}>
      <InboxList requests={snapshot.requests} selectedId={selected?.id ?? null} onSelect={onSelect} motionPageId="1" />
      <section className="detail-pane t-page" data-page-id="2">
        {selected === null ? <div className="detail-empty"><Bell aria-hidden="true" size={26} /><h2>{appText.noRequestTitle}</h2><p>{appText.noRequestBody}</p></div> : (
          <RequestDetail request={selected} online={connected} onBack={onBack} onRequestChange={onRequestChange} onToast={onToast} />
        )}
      </section>
    </div>
  );
}

function TopBar({
  user,
  snapshot,
  workspaceId,
  connected,
  loading,
  onWorkspace,
  onRefresh,
  onChanged,
  onLogout,
  onToast,
}: {
  user: UserSummary;
  snapshot: Snapshot | null;
  workspaceId: string | null;
  connected: boolean;
  loading: boolean;
  onWorkspace(value: string | null): void;
  onRefresh(): void;
  onChanged(): void;
  onLogout(): void;
  onToast(message: string, tone?: "success" | "error"): void;
}) {
  const pending = snapshot?.requests.filter((request) => request.status === "pending").length ?? 0;
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuMounted, setMenuMounted] = useState(false);
  const workspaceTriggerRef = useRef<HTMLButtonElement>(null);
  const openWorkspaceMenu = useCallback(() => {
    setMenuMounted(true);
    setMenuOpen(true);
  }, []);
  const closeWorkspaceMenu = useCallback(() => setMenuOpen(false), []);
  const finishWorkspaceMenuClose = useCallback(() => {
    setMenuMounted(false);
    workspaceTriggerRef.current?.focus();
  }, []);
  return (
    <header className="top-bar">
      <div className="brand"><span className="brand-mark"><MessageSquareMore aria-hidden="true" size={20} /></span><strong>YuruPager</strong></div>
      <div className="workspace-control">
        <label htmlFor="workspace-select">{appText.workspaceSelectLabel}</label>
        <div className="select-wrap"><select id="workspace-select" value={workspaceId ?? "all"} onChange={(event) => onWorkspace(event.target.value === "all" ? null : event.target.value)} disabled={loading && snapshot === null}>
          <option value="all">{appText.workspaceAllOption}</option>
          {snapshot?.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select><ChevronDown aria-hidden="true" size={15} /></div>
      </div>
      <div className="top-actions">
        <div className="pending-indicator" aria-label={appText.pendingAria(pending)}><Bell aria-hidden="true" size={17} /><span>{appText.pendingLabel}</span><strong>{pending}</strong></div>
        <span className={`connection-pill ${connected ? "is-online" : "is-offline"}`} role="status">{connected ? <Wifi aria-hidden="true" size={15} /> : <WifiOff aria-hidden="true" size={15} />}<span>{connected ? appText.online : appText.offline}</span></span>
        <PushNotificationMenu userId={user.id} onToast={onToast} />
        <TooltipIconButton label={appText.refreshSnapshot} onClick={onRefresh} disabled={loading}><RefreshCw className={loading ? "spinner" : ""} aria-hidden="true" size={17} /></TooltipIconButton>
        <span className="workspace-action"><button ref={workspaceTriggerRef} className="icon-button workspace-menu-trigger" type="button" aria-label={appText.workspaceActions} aria-expanded={menuOpen} aria-haspopup="dialog" title={appText.workspaceActions} onClick={() => menuOpen ? closeWorkspaceMenu() : openWorkspaceMenu()}><Plus aria-hidden="true" size={17} /></button>{menuMounted && <WorkspaceMenu open={menuOpen} snapshot={snapshot} onWorkspace={onWorkspace} onChanged={onChanged} onToast={onToast} onRequestClose={closeWorkspaceMenu} onClosed={finishWorkspaceMenuClose} />}</span>
        <span className="user-avatar" title={`${user.name} / ${user.email}`}>{initials(user.name)}</span>
        <TooltipIconButton label={appText.logout} onClick={onLogout}><LogOut aria-hidden="true" size={17} /></TooltipIconButton>
      </div>
    </header>
  );
}

function WorkspaceMenu({ open, snapshot, onWorkspace, onChanged, onToast, onRequestClose, onClosed }: {
  open: boolean;
  snapshot: Snapshot | null;
  onWorkspace(value: string | null): void;
  onChanged(): void;
  onToast(message: string, tone?: "success" | "error"): void;
  onRequestClose(): void;
  onClosed(): void;
}) {
  const [mode, setMode] = useState<"create" | "join">("create");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<WorkspaceKind>("team");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const requestClose = useCallback(() => {
    onRequestClose();
  }, [onRequestClose]);
  useEffect(() => {
    if (open) {
      const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>("input, select, button")?.focus());
      return () => cancelAnimationFrame(frame);
    }
    closeTimer.current = window.setTimeout(onClosed, reducedMotion() ? 0 : cssDuration("--dropdown-close-dur", 150));
    return () => { if (closeTimer.current !== null) clearTimeout(closeTimer.current); };
  }, [open, onClosed]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [requestClose]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      if (mode === "create") {
        const result = await createWorkspace(name, kind, crypto.randomUUID());
        onWorkspace(result.workspace.id);
        onToast(appText.workspaceCreatedToast);
        onChanged();
        requestClose();
      } else {
        const workspace = await joinWorkspaceInvite(token);
        onWorkspace(workspace.id);
        onToast(appText.joinedWorkspaceToast(workspace.name));
        onChanged();
        requestClose();
      }
    } catch (reason) {
      setError(errorLabel(reason, mode === "create" ? appText.workspaceCreateFailed : appText.workspaceJoinFailed));
    } finally { setBusy(false); }
  };
  return <div ref={menuRef} className={`workspace-menu t-dropdown ${open ? "is-open" : "is-closing"}`} data-origin="top-right" role="dialog" aria-label={appText.workspaceActionsAria} aria-modal="false" tabIndex={-1}>
    <div className="workspace-menu-tabs" role="tablist" aria-label={appText.menuTabsAria}><button type="button" role="tab" aria-selected={mode === "create"} onClick={() => { setMode("create"); setError(null); }}>{appText.createWorkspaceTab}</button><button type="button" role="tab" aria-selected={mode === "join"} onClick={() => { setMode("join"); setError(null); }}>{appText.joinWorkspaceTab}</button></div>
    <form onSubmit={submit}>
      {mode === "create" ? <><label>{appText.nameLabel}<input value={name} maxLength={240} onChange={(event) => setName(event.target.value)} placeholder={appText.namePlaceholder} required /></label><label>{appText.kindLabel}<select value={kind} onChange={(event) => setKind(event.target.value as WorkspaceKind)}><option value="personal">{appText.kindPersonal}</option><option value="company">{appText.kindCompany}</option><option value="team">{appText.kindTeam}</option></select></label></> : <label>{appText.inviteTokenLabel}<input className="mono" value={token} onChange={(event) => setToken(event.target.value)} placeholder="ypi_..." autoCapitalize="none" required /></label>}
      {error !== null && <p className="management-error" role="alert">{error}</p>}
      <div className="workspace-menu-actions"><button className="secondary-button compact-action" type="button" onClick={requestClose}>{appText.cancel}</button><button className="primary-button compact-action" type="submit" disabled={busy || (mode === "create" ? name.trim() === "" : token.trim() === "")}>{busy && <LoaderCircle className="spinner" aria-hidden="true" size={14} />}{busy ? appText.submitting : mode === "create" ? appText.createAction : appText.joinAction}</button></div>
    </form>
    {snapshot?.workspaces.length === 0 && <p className="workspace-menu-note"><KeyRound aria-hidden="true" size={14} />{appText.workspaceMenuNote}</p>}
  </div>;
}

function NavButton({ item, active, pending, onClick }: { item: { id: ViewId; label: string; icon: LucideIcon }; active: boolean; pending: number; onClick(): void }) {
  const Icon = item.icon;
  return <button type="button" data-active={active} onClick={onClick} aria-current={active ? "page" : undefined} aria-label={pending > 0 ? appText.navPendingAria(item.label, pending) : item.label}><span className="nav-icon"><Icon aria-hidden="true" size={18} /><span className="nav-badge t-badge" data-open={pending > 0 ? "true" : "false"} aria-hidden="true"><span className="t-badge-dot">{pending > 99 ? "99+" : pending}</span></span></span><span>{item.label}</span></button>;
}

function LoginScreen({ onSignedIn }: { onSignedIn(user: UserSummary): void }) {
  const [email, setEmail] = useState("alice@yurupager.local");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    void login(email, password)
      .then(onSignedIn)
      .catch((reason: unknown) => setError(errorLabel(reason, appText.loginFailed)))
      .finally(() => setSubmitting(false));
  };
  return (
    <main className="login-screen">
      <section className="login-panel" aria-labelledby="login-heading">
        <div className="login-brand"><span className="brand-mark"><MessageSquareMore aria-hidden="true" size={21} /></span><strong>YuruPager</strong></div>
        <div><p className="eyebrow">{appText.loginEyebrow}</p><h1 id="login-heading">{appText.loginHeading}</h1></div>
        <form onSubmit={submit}>
          <label>{appText.emailLabel}<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required /></label>
          <label>{appText.passwordLabel}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
          {error !== null && <p className="login-error" role="alert">{error}</p>}
          <button className="primary-button login-submit" type="submit" disabled={submitting}>{submitting && <LoaderCircle className="spinner" aria-hidden="true" size={17} />}{submitting ? appText.loggingIn : appText.loginAction}</button>
        </form>
      </section>
    </main>
  );
}

function SnapshotState({ error, onRetry }: { error: string | null; onRetry(): void }) {
  return <div className="fatal-state"><WifiOff size={26} aria-hidden="true" /><h1>{appText.workspaceUnavailableTitle}</h1><p>{error ?? appText.snapshotLoadFailedSentence}</p><button className="secondary-button" type="button" onClick={onRetry}>{appText.retry}</button></div>;
}

function BootScreen() { return <main className="boot-screen" aria-label={appText.bootAria}><span className="brand-mark"><MessageSquareMore aria-hidden="true" size={22} /></span><LoaderCircle className="spinner" aria-hidden="true" size={20} /></main>; }

function TooltipIconButton({ label, onClick, disabled = false, children }: { label: string; onClick(): void; disabled?: boolean; children: ReactNode }) {
  const tooltipId = useId();
  return <span className="t-tt-wrap"><button className="icon-button t-tt-trigger" type="button" onClick={onClick} disabled={disabled} aria-label={label} aria-describedby={tooltipId}>{children}</button><span className="t-tt" id={tooltipId} role="tooltip">{label}</span></span>;
}

function Toast({ toast, onClose }: { toast: ToastState; onClose(): void }) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const closingRef = useRef(false);
  const dismiss = () => {
    closingRef.current = true;
    setOpen(false);
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(onClose, reducedMotion() ? 0 : cssDuration("--toast-close", 350));
  };
  useEffect(() => {
    closingRef.current = false;
    const frame = requestAnimationFrame(() => {
      if (!closingRef.current) setOpen(true);
    });
    const autoClose = window.setTimeout(dismiss, 4_000);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(autoClose);
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    };
  }, [toast.id]);
  return <div className={`toast toast-${toast.tone} t-toast ${open ? "is-open" : ""}`} role={toast.tone === "error" ? "alert" : "status"}><span>{toast.message}</span><button type="button" onClick={dismiss} aria-label={appText.dismissToast}><X aria-hidden="true" size={16} /></button></div>;
}

function cssDuration(name: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}
function reducedMotion() { return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches; }

function readViewFromUrl(): ViewId { const value = new URLSearchParams(location.search).get("view"); return navigation.some((item) => item.id === value) ? value as ViewId : "inbox"; }
function cacheKey(userId: string, workspaceId: string | null) { return `${cachePrefix}snapshot:${userId}:${workspaceId ?? "all"}`; }
function readCachedSnapshot(userId: string, workspaceId: string | null): Snapshot | null { try { const value = localStorage.getItem(cacheKey(userId, workspaceId)); return value === null ? null : JSON.parse(value) as Snapshot; } catch { return null; } }
function readCachedUser(): UserSummary | null { try { const value = localStorage.getItem(userCacheKey); return value === null ? null : JSON.parse(value) as UserSummary; } catch { return null; } }
function clearCachedSession() {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(cachePrefix) === true) localStorage.removeItem(key);
  }
}
function initials(name: string) { return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
