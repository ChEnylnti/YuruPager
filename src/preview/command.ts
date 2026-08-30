import { randomUUID } from "node:crypto";

import type { ConnectorPreviewRoute } from "@yurupager/shared";

import {
  loadConnectorConfig,
  previewWebSocketUrl,
} from "../connector/setup.js";
import type { ConnectorConfigFile } from "../connector/setup.js";
import { PreviewTunnelClient } from "./client.js";
import { parsePreviewArguments } from "./options.js";
import { loopbackAuthority, resolvePreviewTarget } from "./target.js";

export interface RunningPreview {
  readonly route: ConnectorPreviewRoute;
  readonly finished: Promise<void>;
  stop(): Promise<void>;
}

export interface StartPreviewOptions {
  args: string[];
  configPath: string;
  output?: (message: string) => void;
  resolveTarget?: typeof resolvePreviewTarget;
  now?: () => number;
}

export async function startPreview(options: StartPreviewOptions): Promise<RunningPreview> {
  const command = parsePreviewArguments(options.args);
  const config = await loadConnectorConfig(options.configPath);
  const token = config?.token;
  const websocketUrl = resolvePreviewWebSocketUrl(config);
  if (token === undefined || token.length < 16 || websocketUrl === null) {
    throw new Error("预览只接受已配对工作站的动态凭据。请先运行 YuruPager 配对命令");
  }
  const output = options.output ?? ((message) => process.stdout.write(`${message}\n`));
  const target = await (options.resolveTarget ?? resolvePreviewTarget)(command.port);
  const now = options.now ?? Date.now;
  const expiresAtMs = now() + command.durationMinutes * 60_000;
  const route: ConnectorPreviewRoute = {
    routeId: randomUUID(),
    name: command.name,
    port: command.port,
    status: "active",
    expiresAt: new Date(expiresAtMs).toISOString(),
  };

  let stopped = false;
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const client = new PreviewTunnelClient({
    url: websocketUrl,
    token,
    route,
    target,
    onStatus(online) {
      output(online ? "预览通道已连接，可从 YuruPager 工作站详情打开。" : "预览通道已断开，正在等待恢复；旧请求不会重放。");
    },
    onRouteStop(reason) {
      output(routeStopText(reason));
      void stop();
    },
  });
  const expiryTimer = setTimeout(() => {
    output("预览授权已到期。");
    void stop();
  }, Math.max(0, expiresAtMs - now()));

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(expiryTimer);
    await client.stop();
    finish?.();
  };

  output(`正在开放 http://${loopbackAuthority(target)}（${route.name}）`);
  output(`路由：${route.routeId}`);
  output(`到期：${new Date(expiresAtMs).toLocaleString("zh-CN", { hour12: false })}`);
  output("按 Ctrl+C 立即停止；请求内容不会写入 YuruPager 本地数据库。");
  client.start();
  return { route, finished, stop };
}

export function resolvePreviewWebSocketUrl(
  config: ConnectorConfigFile | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = env.YURUPAGER_PREVIEW_WS?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;
  return config === null ? null : previewWebSocketUrl(config.serverUrl);
}

function routeStopText(reason: "user_stopped" | "expired" | "permission_revoked" | "server_shutdown"): string {
  switch (reason) {
    case "user_stopped": return "预览已由 YuruPager 用户停止。";
    case "expired": return "预览授权已到期。";
    case "permission_revoked": return "预览权限已撤销。";
    case "server_shutdown": return "预览服务正在关闭。";
  }
}
