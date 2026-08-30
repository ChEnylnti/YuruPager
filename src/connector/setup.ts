import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface ConnectorConfigFile {
  version: 1;
  serverUrl: string;
  cloudWebSocketUrl: string;
  token: string;
  workspaceId: string;
  workstationId: string;
  pairedAt: string;
}

interface PairingResult {
  pairingId: string;
  status: "waiting_for_device" | "pending_approval" | "approved" | "cancelled" | "expired";
  expiresAt: string;
  workspaceId?: string;
  workstationId?: string;
  connectorToken?: string;
}

export interface SetupOptions {
  serverUrl: string;
  pairCode: string;
  dataDirectory: string;
  installService: boolean;
  entryPath: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  output?: (message: string) => void;
}

export async function runSetup(options: SetupOptions): Promise<ConnectorConfigFile> {
  const serverUrl = normalizeServerUrl(options.serverUrl);
  const pairCode = normalizePairCode(options.pairCode);
  const output = options.output ?? ((message) => process.stdout.write(`${message}\n`));
  const fetchImpl = options.fetchImpl ?? fetch;
  await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(options.dataDirectory, 0o700);

  const keyPath = join(options.dataDirectory, "device-key.pem");
  const publicKeyPath = join(options.dataDirectory, "device-public-key.pem");
  const publicKey = await ensureDeviceKeyPair(keyPath, publicKeyPath);
  const claimSecret = randomBytes(32).toString("base64url");
  const deviceName = hostname();
  const platformName = `${platform()} ${release()} / ${process.arch}`;
  const claimDeadline = Date.now() + 10 * 60_000;
  const claim = await retryTransient(async () => postJson<PairingResult>(fetchImpl, apiUrl(serverUrl, "api/connector/pairings/claim"), {
      pairCode,
      claimSecret,
      deviceName,
      platform: platformName,
      connectorVersion: "0.2.0-alpha",
      publicKey,
    }), claimDeadline, options.pollIntervalMs ?? 1_500);
  output(`候选设备已登记：${deviceName}`);
  output(`设备指纹：${fingerprint(publicKey)}`);
  output("请回到 YuruPager Web 确认连接。等待确认中...");

  let result = claim;
  const deadline = new Date(claim.expiresAt).getTime();
  while (result.status === "pending_approval" || result.status === "waiting_for_device") {
    if (Date.now() >= deadline) throw new Error("配对已过期，请在 Web 中创建新的配对码");
    await delay(options.pollIntervalMs ?? 1_500);
    try {
      result = await postJson<PairingResult>(fetchImpl, apiUrl(serverUrl, "api/connector/pairings/result"), {
        pairCode,
        claimSecret,
      });
    } catch (error) {
      if (!isTransient(error)) throw error;
      output("连接暂时中断，继续等待确认...");
    }
  }
  if (result.status === "cancelled") throw new Error("配对已在 Web 中取消");
  if (result.status === "expired") throw new Error("配对已过期，请在 Web 中创建新的配对码");
  if (
    result.status !== "approved" || result.connectorToken === undefined ||
    result.workspaceId === undefined || result.workstationId === undefined
  ) {
    throw new Error("服务端未返回完整的工作站凭据");
  }

  const config: ConnectorConfigFile = {
    version: 1,
    serverUrl,
    cloudWebSocketUrl: connectorWebSocketUrl(serverUrl),
    token: result.connectorToken,
    workspaceId: result.workspaceId,
    workstationId: result.workstationId,
    pairedAt: new Date().toISOString(),
  };
  const configPath = join(options.dataDirectory, "config.json");
  await writePrivateJson(configPath, config);
  if (options.installService) {
    try {
      await installBackgroundService(options.entryPath, configPath, options.dataDirectory);
      output("后台 Connector 已安装并启动。");
    } catch (error) {
      output(`后台服务安装失败：${error instanceof Error ? error.message : "未知错误"}`);
      output(`配对配置已保留。手动运行：YURUPAGER_CONFIG_FILE=${shellQuote(configPath)} node ${shellQuote(options.entryPath)}`);
    }
  } else {
    output(`配对完成。运行：YURUPAGER_CONFIG_FILE=${shellQuote(configPath)} node ${shellQuote(options.entryPath)}`);
  }
  output("工作站已连接，长期凭据已安全写入本机配置。\n");
  return config;
}

export async function loadConnectorConfig(path: string): Promise<ConnectorConfigFile | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<ConnectorConfigFile>;
    if (
      value.version !== 1 || typeof value.serverUrl !== "string" ||
      typeof value.cloudWebSocketUrl !== "string" || typeof value.token !== "string" ||
      typeof value.workspaceId !== "string" || typeof value.workstationId !== "string" ||
      typeof value.pairedAt !== "string"
    ) {
      throw new Error("Connector config is invalid");
    }
    return value as ConnectorConfigFile;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("服务地址必须使用 HTTPS（本机开发地址除外）");
  }
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

export function connectorWebSocketUrl(serverUrl: string): string {
  const url = new URL("connector/v1/ws", normalizeServerUrl(serverUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function previewWebSocketUrl(serverUrl: string): string {
  const url = new URL("connector/v1/preview/ws", normalizeServerUrl(serverUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function ensureDeviceKeyPair(privatePath: string, publicPath: string): Promise<string> {
  try {
    const publicKey = await readFile(publicPath, "utf8");
    await chmod(privatePath, 0o600);
    await chmod(publicPath, 0o600);
    return publicKey;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  await writePrivate(privatePath, privateKey);
  await writePrivate(publicPath, publicKey);
  return publicKey;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writePrivate(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function installBackgroundService(entryPath: string, configPath: string, dataDirectory: string): Promise<void> {
  if (process.platform === "darwin") {
    const agents = join(homedir(), "Library", "LaunchAgents");
    const plistPath = join(agents, "dev.yurupager.connector.plist");
    const logs = join(dataDirectory, "logs");
    await mkdir(agents, { recursive: true });
    await mkdir(logs, { recursive: true, mode: 0o700 });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.yurupager.connector</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(resolve(entryPath))}</string></array>
  <key>EnvironmentVariables</key><dict><key>YURUPAGER_CONFIG_FILE</key><string>${xml(configPath)}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(logs, "connector.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logs, "connector-error.log"))}</string>
</dict></plist>\n`;
    await writeFile(plistPath, plist, { mode: 0o644 });
    await runCommand("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, plistPath], true);
    await runCommand("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, plistPath]);
    return;
  }
  if (process.platform === "linux") {
    const userUnits = join(homedir(), ".config", "systemd", "user");
    const unitPath = join(userUnits, "yurupager-connector.service");
    await mkdir(userUnits, { recursive: true });
    const unit = `[Unit]
Description=YuruPager Connector
After=network-online.target

[Service]
ExecStart=${systemdQuote(process.execPath)} ${systemdQuote(resolve(entryPath))}
Environment=YURUPAGER_CONFIG_FILE=${systemdQuote(configPath)}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
    await writeFile(unitPath, unit, { mode: 0o644 });
    await runCommand("systemctl", ["--user", "daemon-reload"]);
    await runCommand("systemctl", ["--user", "enable", "--now", "yurupager-connector.service"]);
    return;
  }
  throw new Error(`暂不支持在 ${process.platform} 安装后台服务`);
}

async function postJson<T>(fetchImpl: typeof fetch, url: string, body: unknown): Promise<T> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    let message = `服务端请求失败（${response.status}）`;
    try {
      const value = await response.json() as { error?: { message?: string } };
      if (typeof value.error?.message === "string") message = value.error.message;
    } catch { /* proxy returned non-JSON */ }
    throw new SetupHttpError(response.status, message);
  }
  return response.json() as Promise<T>;
}

async function retryTransient<T>(work: () => Promise<T>, deadline: number, interval: number): Promise<T> {
  for (;;) {
    try { return await work(); }
    catch (error) {
      if (!isTransient(error) || Date.now() >= deadline) throw error;
      await delay(interval);
    }
  }
}

function isTransient(error: unknown): boolean {
  return !(error instanceof SetupHttpError) || error.status === 429 || error.status >= 500;
}

class SetupHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function runCommand(command: string, args: string[], ignoreFailure = false): Promise<void> {
  const code = await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (status) => resolvePromise(status ?? 1));
  });
  if (code !== 0 && !ignoreFailure) throw new Error(`${command} failed with exit code ${code}`);
}

function apiUrl(serverUrl: string, path: string): string {
  return new URL(path, serverUrl).toString();
}

function normalizePairCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.length !== 12) throw new Error("配对码格式不正确");
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8)}`;
}

function fingerprint(publicKey: string): string {
  const hex = createHash("sha256").update(publicKey).digest("hex").slice(0, 24).toUpperCase();
  return hex.match(/.{1,4}/g)?.join("-") ?? hex;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
