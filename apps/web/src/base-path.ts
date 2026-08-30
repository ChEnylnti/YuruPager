const basePath = resolveBasePath(import.meta.env.BASE_URL, location.href);

export function resolveBasePath(configuredBase: string, currentUrl: string): string {
  const pathname = new URL(configuredBase, currentUrl).pathname;
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

export function appUrl(path: string): string {
  return `${basePath}${path.replace(/^\/+/, "")}`;
}

export function appBaseUrl(): string {
  return new URL(basePath, location.origin).toString();
}

export function appBasePath(): string {
  return basePath;
}

export function appWebSocketUrl(path: string): string {
  const url = new URL(appUrl(path), location.origin);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
