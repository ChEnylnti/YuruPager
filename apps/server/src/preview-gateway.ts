import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { previewCookieName, parseCookies } from "./preview-security.js";

export interface RedeemedPreviewLaunch {
  cookieValue: string;
  maxAgeSeconds: number;
}

export interface PreviewGatewayRelay {
  redeemLaunchTicket(ticket: string): Promise<RedeemedPreviewLaunch | null>;
  authorizePreviewContext(cookieValue: string | undefined): Promise<unknown | null>;
  relayHttp(access: unknown, request: IncomingMessage, response: ServerResponse): Promise<void>;
  relayWebSocket(access: unknown, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
}

export interface PreviewGatewayOptions {
  enabled: boolean;
  host: string;
  port: number;
  secureCookie: boolean;
  relay: PreviewGatewayRelay;
}

export class PreviewGateway {
  readonly #options: PreviewGatewayOptions;
  #server: Server | undefined;

  constructor(options: PreviewGatewayOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (!this.#options.enabled || this.#server !== undefined) return;
    const server = createServer((request, response) => {
      void this.#handleRequest(request, response).catch(() => {
        if (!response.headersSent) this.#sendError(response, 502, "预览暂时不可用");
        else response.destroy();
      });
    });
    server.on("upgrade", (request, socket, head) => {
      void this.#handleUpgrade(request, socket, head).catch(() => rejectUpgrade(socket, 502, "Preview unavailable"));
    });
    server.on("clientError", (_error, socket) => rejectUpgrade(socket, 400, "Bad request"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#options.port, this.#options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.#server = server;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setGatewayHeaders(response);
    if (request.url === "/__yurupager/open") {
      if (request.method !== "POST") {
        this.#sendError(response, 405, "只允许从 YuruPager 打开预览");
        return;
      }
      const ticket = await readLaunchTicket(request);
      const redeemed = ticket === null ? null : await this.#options.relay.redeemLaunchTicket(ticket);
      if (redeemed === null) {
        this.#sendError(response, 401, "预览启动凭据无效或已使用");
        return;
      }
      response.statusCode = 303;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Clear-Site-Data", '"cache", "storage"');
      response.setHeader("Location", "/");
      response.setHeader("Set-Cookie", serializeContextCookie(
        redeemed.cookieValue,
        redeemed.maxAgeSeconds,
        this.#options.secureCookie,
      ));
      response.end();
      return;
    }

    if (request.headers["service-worker"] !== undefined) {
      this.#sendError(response, 403, "开发预览不允许注册 Service Worker");
      return;
    }
    const cookie = parseCookies(request.headers.cookie).get(previewCookieName());
    const access = await this.#options.relay.authorizePreviewContext(cookie);
    if (access === null) {
      response.setHeader("Set-Cookie", clearContextCookie(this.#options.secureCookie));
      this.#sendError(response, 401, "请从 YuruPager 工作站详情重新打开预览");
      return;
    }
    await this.#options.relay.relayHttp(access, request, response);
  }

  async #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (request.headers["service-worker"] !== undefined) {
      rejectUpgrade(socket, 403, "Service Worker is not allowed");
      return;
    }
    const cookie = parseCookies(request.headers.cookie).get(previewCookieName());
    const access = await this.#options.relay.authorizePreviewContext(cookie);
    if (access === null) {
      rejectUpgrade(socket, 401, "Open the preview from YuruPager");
      return;
    }
    await this.#options.relay.relayWebSocket(access, request, socket, head);
  }

  #sendError(response: ServerResponse, statusCode: number, message: string): void {
    const body = errorPage(message);
    response.statusCode = statusCode;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Content-Length", Buffer.byteLength(body));
    response.end(body);
  }
}

async function readLaunchTicket(request: IncomingMessage): Promise<string | null> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return null;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > 2_048) return null;
    chunks.push(buffer);
  }
  const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const ticket = params.get("ticket");
  return ticket !== null && /^[A-Za-z0-9_-]{43}$/u.test(ticket) ? ticket : null;
}

function serializeContextCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${previewCookieName()}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor(maxAgeSeconds))}${secure ? "; Secure" : ""}`;
}

function clearContextCookie(secure: boolean): string {
  return `${previewCookieName()}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function setGatewayHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=()");
  response.setHeader("X-Frame-Options", "DENY");
}

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  if (socket.destroyed) return;
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText(statusCode)}\r\n` +
    "Connection: close\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "X-Content-Type-Options: nosniff\r\n" +
    "Referrer-Policy: no-referrer\r\n\r\n" +
    body,
  );
}

function statusText(statusCode: number): string {
  return statusCode === 400 ? "Bad Request" : statusCode === 401 ? "Unauthorized" : statusCode === 403 ? "Forbidden" : "Bad Gateway";
}

function errorPage(message: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>YuruPager 开发预览</title><style>body{margin:0;padding:40px 20px;color:#202521;background:#f7f9f7;font:14px/1.6 system-ui,sans-serif}main{max-width:520px;margin:auto}h1{font-size:20px;letter-spacing:0}p{color:#667069}</style><main><h1>开发预览不可用</h1><p>${escapeHtml(message)}</p></main></html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
