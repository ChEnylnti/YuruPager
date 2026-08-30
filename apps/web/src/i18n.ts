export function requestStatusLabel(value: string): string {
  return ({
    pending: "待处理",
    approved: "已批准",
    denied: "已拒绝",
    expired: "已过期",
    cancelled: "已取消",
    interrupted: "已中断",
  } as Record<string, string>)[value] ?? humanize(value);
}

export function sessionStatusLabel(value: string): string {
  return ({ running: "运行中", waiting: "等待处理", completed: "已完成", failed: "失败", interrupted: "已中断" } as Record<string, string>)[value] ?? humanize(value);
}

export function sessionSyncStateLabel(value: string | undefined): string | null {
  return ({ historical: "历史会话", stale: "暂不可同步", live: null } as Record<string, string | null | undefined>)[value ?? "live"] ?? null;
}

export function sessionCommandStatusLabel(value: string): string {
  return ({
    queued: "等待工作站",
    delivered: "已交付 Codex",
    failed: "投递前失败",
    sent_unknown: "发送结果未知",
  } as Record<string, string>)[value] ?? humanize(value);
}

export function workstationStatusLabel(value: string): string {
  return ({ online: "在线", offline: "离线", degraded: "降级" } as Record<string, string>)[value] ?? humanize(value);
}

export function previewStatusLabel(value: string): string {
  return ({
    active: "可访问",
    unreachable: "本地服务不可达",
    connector_offline: "连接器离线",
    stopped: "已停止",
    expired: "已过期",
    stopping: "正在停止",
  } as Record<string, string>)[value] ?? humanize(value);
}

export function riskLabel(value: string): string {
  return ({ low: "低", medium: "中", high: "高" } as Record<string, string>)[value] ?? value;
}

export function deliveryStatusLabel(value: string): string {
  return ({
    not_queued: "未排队",
    queued: "已排队",
    sent: "已发送",
    delivered: "已送达",
    failed: "失败",
    sent_unknown: "发送结果未知",
  } as Record<string, string>)[value] ?? humanize(value);
}

export function roleLabel(value: string): string {
  return ({ owner: "所有者", admin: "管理员", member: "成员" } as Record<string, string>)[value] ?? humanize(value);
}

export function qualityLabel(value: string): string {
  return ({ provisional: "暂定", final: "最终", incomplete: "不完整" } as Record<string, string>)[value] ?? humanize(value);
}

export function permissionAccessLabel(value: string): string {
  return ({ read: "读取", write: "写入", execute: "执行" } as Record<string, string>)[value] ?? value;
}

export function auditActionLabel(value: string): string {
  return ({
    "request.approve": "批准请求",
    "request.deny": "拒绝请求",
    "request.answer": "回答问题",
    "request.resolved": "请求已解决",
    "session.message_queued": "主动消息已排队",
    "session.message_delivery_updated": "主动消息投递更新",
    "workstation.register": "注册工作站",
    "workstation.heartbeat": "工作站心跳",
    "connector.connected": "连接器已连接",
  } as Record<string, string>)[value] ?? humanize(value);
}

export function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase());
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: value >= 1_000_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

export function relativeTime(value: string): string {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(-seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  return formatter.format(-hours, "hour");
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function errorLabel(error: unknown, fallback = "请求失败，请稍后重试"): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return ({
    unauthenticated: "登录已失效，请重新登录",
    invalid_credentials: "邮箱或密码不正确",
    permission_denied: "你无权处理此请求",
    request_not_found: "请求不存在或无权访问",
    decision_conflict: "另一位协作者已处理此请求",
    idempotency_key_reused: "此提交凭据已用于其他决定",
    high_risk_confirmation_required: "高风险批准需要明确确认",
    session_not_found: "会话不存在或无权访问",
    invalid_message: "消息必须为 1 至 8,000 个字符",
    preview_not_found: "预览不存在或你没有访问权限",
    preview_unavailable: "此开发预览当前不可访问",
    preview_disabled: "此服务器未启用开发预览",
    preview_gateway_unavailable: "开发预览网关暂时不可用",
    invalid_invite_token: "邀请令牌格式不正确",
    invite_expired: "邀请已过期或已经使用",
    invalid_workspace_kind: "工作区类型不正确",
    invalid_member_role: "成员角色不正确",
    member_not_found: "成员不存在或已被移除",
    workstation_not_found: "工作站不存在或已撤销",
    owner_immutable: "所有者不能通过此操作修改",
    invalid_access: "工作站授权字段不正确",
  } as Record<string, string>)[code] ?? fallback;
}
