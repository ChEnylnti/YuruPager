import { BellOff, BellRing, Check, LoaderCircle, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { errorLabel } from "./i18n.js";
import {
  disablePushNotifications,
  enablePushNotifications,
  inspectPushNotifications,
  type PushNotificationState,
} from "./push-notifications.js";

type MenuMotion = "closed" | "opening" | "open" | "closing";

export function PushNotificationMenu({ userId, onToast }: {
  userId: string;
  onToast(message: string, tone?: "success" | "error"): void;
}) {
  const [state, setState] = useState<PushNotificationState>({ kind: "loading" });
  const [operation, setOperation] = useState<"enable" | "disable" | null>(null);
  const [motion, setMotion] = useState<MenuMotion>("closed");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const openFrame = useRef<number | null>(null);
  const titleId = useId();
  const tooltipId = useId();
  const busy = operation !== null;
  const subscribed = state.kind === "subscribed" || (state.kind === "error" && state.subscribed);

  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    void inspectPushNotifications()
      .then((next) => { if (current) setState(next); })
      .catch((error: unknown) => {
        if (current) setState({ kind: "error", message: errorLabel(error, "无法读取通知设置"), subscribed: false });
      });
    return () => { current = false; };
  }, [userId]);

  useEffect(() => () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    if (openFrame.current !== null) cancelAnimationFrame(openFrame.current);
  }, []);

  useEffect(() => {
    if (motion !== "open") return;
    const handlePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) closeMenu();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
      }
    };
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [motion]);

  const openMenu = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    setMotion("opening");
    openFrame.current = requestAnimationFrame(() => {
      setMotion("open");
      requestAnimationFrame(() => {
        const target = menuRef.current?.querySelector<HTMLElement>(".notification-menu-actions button:not([disabled])")
          ?? menuRef.current?.querySelector<HTMLElement>("button:not([disabled])")
          ?? menuRef.current;
        target?.focus();
      });
    });
  };
  const closeMenu = () => {
    if (openFrame.current !== null) cancelAnimationFrame(openFrame.current);
    setMotion("closing");
    closeTimer.current = window.setTimeout(() => {
      setMotion("closed");
      triggerRef.current?.focus();
    }, reducedMotion() ? 0 : cssDuration("--dropdown-close-dur", 150));
  };
  const toggleMenu = () => motion === "closed" || motion === "closing" ? openMenu() : closeMenu();

  const enable = async () => {
    if (busy) return;
    setOperation("enable");
    try {
      const next = await enablePushNotifications();
      setState(next);
      if (next.kind === "subscribed") onToast("此设备已开启待办通知");
    } catch (error) {
      const message = errorLabel(error, "无法开启通知");
      setState({ kind: "error", message, subscribed: false });
      onToast(message, "error");
    } finally {
      setOperation(null);
    }
  };
  const disable = async () => {
    if (busy) return;
    setOperation("disable");
    try {
      const next = await disablePushNotifications();
      setState(next);
      onToast("此设备已关闭待办通知");
    } catch (error) {
      const message = errorLabel(error, "无法关闭通知");
      setState({ kind: "error", message, subscribed: true });
      onToast(message, "error");
    } finally {
      setOperation(null);
    }
  };

  return (
    <div className="notification-control">
      <span className="t-tt-wrap">
        <button
          ref={triggerRef}
          className="icon-button t-tt-trigger notification-trigger"
          type="button"
          aria-label={subscribed ? "通知已开启" : "通知设置"}
          aria-describedby={tooltipId}
          aria-haspopup="dialog"
          aria-expanded={motion === "open"}
          onClick={toggleMenu}
        >
          <span className="t-icon-swap" data-state={subscribed ? "a" : "b"}>
            <BellRing className="t-icon" data-icon="a" size={17} aria-hidden="true" />
            <BellOff className="t-icon" data-icon="b" size={17} aria-hidden="true" />
          </span>
          <span className="notification-enabled-dot" data-open={subscribed} aria-hidden="true" />
        </button>
        <span className="t-tt" id={tooltipId} role="tooltip">{subscribed ? "通知已开启" : "通知设置"}</span>
      </span>
      {motion !== "closed" && (
        <div
          ref={menuRef}
          className={`notification-menu t-dropdown ${motion === "open" ? "is-open" : motion === "closing" ? "is-closing" : ""}`}
          data-origin="top-right"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          tabIndex={-1}
        >
          <header><div><p className="eyebrow">此设备</p><h2 id={titleId}>待办通知</h2></div><button className="icon-button" type="button" onClick={closeMenu} aria-label="关闭通知设置"><X size={16} aria-hidden="true" /></button></header>
          <PushStateBody state={state} />
          <div className="notification-menu-actions">
            {subscribed ? (
              <button className="secondary-button" type="button" onClick={() => void disable()} disabled={busy}>{operation === "disable" && <LoaderCircle className="spinner" size={15} aria-hidden="true" />}{operation === "disable" ? "正在关闭" : "关闭通知"}</button>
            ) : state.kind === "available" || state.kind === "error" ? (
              <button className="primary-button" type="button" onClick={() => void enable()} disabled={busy}>{operation === "enable" && <LoaderCircle className="spinner" size={15} aria-hidden="true" />}{operation === "enable" ? "正在开启" : "开启通知"}</button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function PushStateBody({ state }: { state: PushNotificationState }) {
  if (state.kind === "loading") return <div className="notification-state" role="status"><LoaderCircle className="spinner" size={18} aria-hidden="true" /><div><strong>正在同步设置</strong><p>等待浏览器和服务器确认。</p></div></div>;
  if (state.kind === "subscribed") return <div className="notification-state is-on" role="status"><Check size={18} aria-hidden="true" /><div><strong>通知已开启</strong><p>新待办会以最小披露通知唤醒此设备。</p></div></div>;
  if (state.kind === "denied") return <div className="notification-state" role="status"><BellOff size={18} aria-hidden="true" /><div><strong>浏览器已阻止通知</strong><p>请在浏览器或系统设置中允许后重新打开此菜单。</p></div></div>;
  if (state.kind === "unsupported") return <div className="notification-state" role="status"><BellOff size={18} aria-hidden="true" /><div><strong>当前浏览器不支持</strong><p>请使用安装到主屏幕的 iOS PWA 或支持 Web Push 的浏览器。</p></div></div>;
  if (state.kind === "server_disabled") return <div className="notification-state" role="status"><BellOff size={18} aria-hidden="true" /><div><strong>服务器尚未启用</strong><p>待办仍会在打开应用后从快照恢复。</p></div></div>;
  if (state.kind === "error") return <div className="notification-state is-error" role="alert"><BellOff size={18} aria-hidden="true" /><div><strong>通知设置未完成</strong><p>{state.message}</p></div></div>;
  return <div className="notification-state"><BellRing size={18} aria-hidden="true" /><div><strong>通知未开启</strong><p>通知只提示有新待办，不显示命令、项目或对话内容。</p></div></div>;
}

function cssDuration(name: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
