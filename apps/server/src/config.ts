export interface Config {
  host: string;
  port: number;
  authMode: "local" | "oidc";
  sessionSecret: string;
  adminDatabaseUrl: string;
  databaseUrl: string;
  connectorDatabaseUrl: string;
  webOrigin: string;
  connectorToken: string;
  connectorWorkspaceId: string;
  connectorWorkstationId: string;
  cookiePath: string;
  localAlphaPassword: string;
  connectorPackagePath: string;
  previewEnabled: boolean;
  previewGatewayHost: string;
  previewGatewayPort: number;
  previewPublicOrigin: string | null;
  previewMaxDurationMinutes: number;
  webPushEnabled: boolean;
  webPushVapidSubject: string | null;
  webPushVapidPublicKey: string | null;
  webPushVapidPrivateKey: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authMode = env.AUTH_MODE ?? "local";
  if (authMode !== "local" && authMode !== "oidc") {
    throw new Error("AUTH_MODE must be local or oidc");
  }
  const webOrigin = env.WEB_ORIGIN ?? "http://127.0.0.1:4173";
  const previewEnabled = readBoolean(env.PREVIEW_ENABLED, false, "PREVIEW_ENABLED");
  const previewPublicOrigin = optionalOrigin(env.PREVIEW_PUBLIC_ORIGIN);
  if (previewEnabled && previewPublicOrigin === null) {
    throw new Error("PREVIEW_PUBLIC_ORIGIN is required when PREVIEW_ENABLED=true");
  }
  if (previewEnabled && previewPublicOrigin === new URL(webOrigin).origin) {
    throw new Error("PREVIEW_PUBLIC_ORIGIN must be isolated from WEB_ORIGIN");
  }
  const webPushEnabled = readBoolean(env.WEB_PUSH_ENABLED, false, "WEB_PUSH_ENABLED");
  const webPushVapidSubject = optionalValue(env.WEB_PUSH_VAPID_SUBJECT);
  const webPushVapidPublicKey = optionalValue(env.WEB_PUSH_VAPID_PUBLIC_KEY);
  const webPushVapidPrivateKey = optionalValue(env.WEB_PUSH_VAPID_PRIVATE_KEY);
  if (webPushEnabled) {
    if (webPushVapidSubject === null || webPushVapidPublicKey === null || webPushVapidPrivateKey === null) {
      throw new Error("WEB_PUSH_VAPID_SUBJECT, WEB_PUSH_VAPID_PUBLIC_KEY and WEB_PUSH_VAPID_PRIVATE_KEY are required when WEB_PUSH_ENABLED=true");
    }
    if (!isVapidSubject(webPushVapidSubject)) {
      throw new Error("WEB_PUSH_VAPID_SUBJECT must be an https URL or mailto address");
    }
    if (!isBase64Url(webPushVapidPublicKey, 80, 120) || !isBase64Url(webPushVapidPrivateKey, 40, 80)) {
      throw new Error("WEB_PUSH VAPID keys must be unpadded base64url values");
    }
  }
  return {
    host: env.HOST ?? "127.0.0.1",
    port: readPort(env.PORT),
    authMode,
    sessionSecret: env.SESSION_SECRET ?? "local-alpha-session-secret-change-before-production",
    adminDatabaseUrl:
      env.ADMIN_DATABASE_URL ??
      "postgres://postgres:postgres@127.0.0.1:55432/yurupager",
    databaseUrl:
      env.DATABASE_URL ??
      "postgres://yurupager_app:yurupager_app@127.0.0.1:55432/yurupager",
    connectorDatabaseUrl:
      env.CONNECTOR_DATABASE_URL ??
      "postgres://yurupager_connector:yurupager_connector@127.0.0.1:55432/yurupager",
    webOrigin,
    connectorToken: env.CONNECTOR_TOKEN ?? "alpha-connector-token",
    connectorWorkspaceId:
      env.CONNECTOR_WORKSPACE_ID ?? "20000000-0000-4000-8000-000000000002",
    connectorWorkstationId:
      env.CONNECTOR_WORKSTATION_ID ?? "30000000-0000-4000-8000-000000000001",
    cookiePath: readCookiePath(env.PUBLIC_PATH),
    localAlphaPassword: env.ALPHA_PASSWORD ?? "alpha-demo",
    connectorPackagePath: env.CONNECTOR_PACKAGE_PATH ?? "artifacts/yurupager-connector.tgz",
    previewEnabled,
    previewGatewayHost: env.PREVIEW_GATEWAY_HOST ?? "127.0.0.1",
    previewGatewayPort: readNamedPort(env.PREVIEW_GATEWAY_PORT, 4301, "PREVIEW_GATEWAY_PORT"),
    previewPublicOrigin,
    previewMaxDurationMinutes: readInteger(
      env.PREVIEW_MAX_DURATION_MINUTES,
      240,
      15,
      24 * 60,
      "PREVIEW_MAX_DURATION_MINUTES",
    ),
    webPushEnabled,
    webPushVapidSubject,
    webPushVapidPublicKey,
    webPushVapidPrivateKey,
  };
}

function readCookiePath(value: string | undefined): string {
  const path = value ?? "/";
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new Error("PUBLIC_PATH must be an absolute URL path");
  }
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function readPort(value: string | undefined): number {
  return readNamedPort(value, 4300, "PORT");
}

function readNamedPort(value: string | undefined, fallback: number, name: string): number {
  const port = Number(value ?? String(fallback));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

function readInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = Number(value ?? String(fallback));
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function readBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true or false`);
}

function optionalOrigin(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("PREVIEW_PUBLIC_ORIGIN must use HTTPS except for loopback development");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("PREVIEW_PUBLIC_ORIGIN must not contain a path, query or fragment");
  }
  return url.origin;
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "preview.localhost" || hostname === "::1";
}

function optionalValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

function isVapidSubject(value: string): boolean {
  if (value.startsWith("mailto:") && value.length > "mailto:".length) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isBase64Url(value: string, minimum: number, maximum: number): boolean {
  return value.length >= minimum && value.length <= maximum && /^[A-Za-z0-9_-]+$/u.test(value);
}
