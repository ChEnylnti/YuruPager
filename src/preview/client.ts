import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  previewLimits,
  type ConnectorPreviewRoute,
  type PreviewTunnelClientMessage,
} from "@yurupager/shared";
import WebSocket, { type RawData } from "ws";

import { readPreviewServerMessage } from "./protocol.js";
import type { PreviewLoopbackTarget } from "./target.js";
import { PreviewTunnel } from "./tunnel.js";

export interface PreviewTunnelClientOptions {
  url: string;
  token: string;
  route: ConnectorPreviewRoute;
  target: PreviewLoopbackTarget;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  random?: () => number;
  onStatus?: (online: boolean) => void;
  onRouteStop?: (reason: "user_stopped" | "expired" | "permission_revoked" | "server_shutdown") => void;
}

export class PreviewTunnelClient {
  readonly connectionEpoch = randomUUID();
  readonly #url: string;
  readonly #token: string;
  readonly #route: ConnectorPreviewRoute;
  readonly #target: PreviewLoopbackTarget;
  readonly #reconnectMinMs: number;
  readonly #reconnectMaxMs: number;
  readonly #random: () => number;
  readonly #onStatus: (online: boolean) => void;
  readonly #onRouteStop: NonNullable<PreviewTunnelClientOptions["onRouteStop"]>;
  #socket: WebSocket | undefined;
  #tunnel: PreviewTunnel | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #stopped = true;
  #attempt = 0;
  #revision = 0;
  #online = false;

  constructor(options: PreviewTunnelClientOptions) {
    this.#url = options.url;
    this.#token = options.token;
    this.#route = options.route;
    this.#target = options.target;
    this.#reconnectMinMs = options.reconnectMinMs ?? 1_000;
    this.#reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
    this.#random = options.random ?? Math.random;
    this.#onStatus = options.onStatus ?? (() => undefined);
    this.#onRouteStop = options.onRouteStop ?? (() => undefined);
  }

  get online(): boolean {
    return this.#online;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#tunnel?.close();
    this.#tunnel = undefined;
    this.#setOnline(false);
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 1_000);
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: "preview.routes.snapshot",
          revision: ++this.#revision,
          routes: [],
        } satisfies PreviewTunnelClientMessage), () => socket.close(1000, "Preview stopped"));
      } else if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      } else {
        socket.close(1000, "Preview stopped");
      }
    });
  }

  #connect(): void {
    if (this.#stopped) return;
    const socket = new WebSocket(this.#url, {
      headers: { authorization: `Bearer ${this.#token}` },
      maxPayload: 128 * 1024,
      handshakeTimeout: previewLimits.firstByteTimeoutMs,
    });
    this.#socket = socket;
    socket.once("open", () => {
      if (this.#socket !== socket || this.#stopped) return;
      socket.send(JSON.stringify({
        type: "preview.hello",
        protocolVersion: 1,
        connectionEpoch: this.connectionEpoch,
        routes: [this.#route],
      } satisfies PreviewTunnelClientMessage));
    });
    socket.on("message", (raw, binary) => {
      if (binary) {
        socket.close(1002, "Text protocol required");
        return;
      }
      try { this.#handle(socket, raw); }
      catch { socket.close(1002, "Invalid preview protocol"); }
    });
    socket.on("error", () => undefined);
    socket.once("close", () => {
      if (this.#socket === socket) this.#socket = undefined;
      this.#tunnel?.close();
      this.#tunnel = undefined;
      this.#setOnline(false);
      this.#scheduleReconnect();
    });
  }

  #handle(socket: WebSocket, raw: RawData): void {
    const data = rawDataBuffer(raw);
    if (data.length === 0 || data.length > 128 * 1024) throw new Error("Preview message is too large");
    const message = readPreviewServerMessage(JSON.parse(data.toString("utf8")) as unknown);
    if (message.type === "preview.welcome") {
      if (this.#tunnel !== undefined) throw new Error("Duplicate preview welcome");
      this.#attempt = 0;
      this.#tunnel = new PreviewTunnel({
        routeId: this.#route.routeId,
        target: this.#target,
        maxChunkBytes: message.maxChunkBytes,
        initialWindowBytes: message.initialWindowBytes,
        send: (outbound) => this.#send(socket, outbound),
      });
      this.#setOnline(true);
      return;
    }
    if (message.type === "preview.route.stop") {
      if (message.routeId !== this.#route.routeId) throw new Error("Preview route mismatch");
      this.#onRouteStop(message.reason);
      return;
    }
    if (this.#tunnel === undefined) throw new Error("Preview welcome is required");
    this.#tunnel.handle(message);
  }

  #send(socket: WebSocket, message: PreviewTunnelClientMessage): boolean {
    if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer !== undefined || Date.now() >= new Date(this.#route.expiresAt).getTime()) return;
    const base = Math.min(this.#reconnectMaxMs, this.#reconnectMinMs * 2 ** this.#attempt++);
    const delay = Math.round(base * (0.8 + this.#random() * 0.4));
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, delay);
  }

  #setOnline(value: boolean): void {
    if (this.#online === value) return;
    this.#online = value;
    this.#onStatus(value);
  }
}

function rawDataBuffer(raw: RawData): Buffer {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  return Buffer.from(raw);
}
