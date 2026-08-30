import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { Writable } from "node:stream";

import {
  type CodexServerNotification,
  type CodexServerRequest,
  type JsonRpcId,
} from "./domain.js";
import { isRecord } from "./guards.js";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export interface CodexAppServerClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  webSocketUrl?: string;
  requestTimeoutMs?: number;
  /** Called after a successful server response is submitted to the transport. */
  onServerResponseWritten?: ServerResponseWrittenHandler;
}

export interface InitializeResult {
  codexHome: string;
  platformFamily: string;
  platformOs: string;
  userAgent: string;
}

export type ServerRequestHandler = (
  request: CodexServerRequest,
) => Promise<unknown> | unknown;

export type NotificationHandler = (
  notification: CodexServerNotification,
) => Promise<void> | void;

export type ServerResponseWrittenHandler = (
  request: CodexServerRequest,
) => void;

export class JsonRpcRemoteError extends Error {
  override readonly name = "JsonRpcRemoteError";

  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export class CodexAppServerClient {
  readonly #command: string;
  readonly #args: string[];
  readonly #cwd: string | undefined;
  readonly #env: NodeJS.ProcessEnv;
  readonly #webSocketUrl: string | undefined;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #notificationHandlers = new Set<NotificationHandler>();

  #child: ChildProcessWithoutNullStreams | undefined;
  #webSocket: WebSocket | undefined;
  #output: Writable | undefined;
  #lines: Interface | undefined;
  #nextId = 1;
  #serverRequestHandler: ServerRequestHandler | undefined;
  #serverResponseWrittenHandler: ServerResponseWrittenHandler | undefined;
  #stderrTail = "";

  constructor(options: CodexAppServerClientOptions = {}) {
    this.#command = options.command ?? "codex";
    this.#args = options.args ?? ["app-server", "--stdio"];
    this.#cwd = options.cwd;
    this.#env = { ...process.env, ...options.env };
    this.#webSocketUrl = options.webSocketUrl;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#serverResponseWrittenHandler = options.onServerResponseWritten;
  }

  get running(): boolean {
    return (
      (this.#child !== undefined && this.#child.exitCode === null) ||
      this.#webSocket?.readyState === WebSocket.OPEN
    );
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.#serverRequestHandler = handler;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.#notificationHandlers.add(handler);
    return () => this.#notificationHandlers.delete(handler);
  }

  async start(): Promise<void> {
    if (this.#child !== undefined || this.#webSocket !== undefined) {
      throw new Error("Codex app-server client already started");
    }

    if (this.#webSocketUrl !== undefined) {
      await this.#startWebSocket(this.#webSocketUrl);
      return;
    }

    const spawnOptions: SpawnOptionsWithoutStdio = {
      env: this.#env,
    };
    if (this.#cwd !== undefined) {
      spawnOptions.cwd = this.#cwd;
    }

    const child = spawn(this.#command, this.#args, spawnOptions);
    this.#child = child;
    this.#output = child.stdin;
    this.#lines = createInterface({ input: child.stdout });
    this.#lines.on("line", (line) => this.#handleLine(line));

    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrTail = `${this.#stderrTail}${chunk.toString("utf8")}`.slice(
        -8_192,
      );
    });
    child.once("error", (error) => this.#failPending(error));
    child.once("exit", (code, signal) => {
      const detail = this.#stderrTail.trim();
      const suffix = detail.length > 0 ? `: ${detail}` : "";
      this.#failPending(
        new Error(
          `Codex app-server exited (code=${String(code)}, signal=${String(signal)})${suffix}`,
        ),
      );
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  async initialize(
    clientInfo: { name: string; version: string; title?: string },
    experimentalApi = true,
  ): Promise<InitializeResult> {
    const result = await this.request<InitializeResult>("initialize", {
      clientInfo,
      capabilities: { experimentalApi },
    });
    this.notify("initialized");
    return result;
  }

  request<T>(method: string, params: unknown): Promise<T> {
    this.#assertRunning();
    const id = this.#nextId++;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(this.#idKey(id));
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.#requestTimeoutMs);

      this.#pending.set(this.#idKey(id), {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.#write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.#assertRunning();
    this.#write(params === undefined ? { method } : { method, params });
  }

  async stop(): Promise<void> {
    const webSocket = this.#webSocket;
    if (webSocket !== undefined) {
      this.#webSocket = undefined;
      if (webSocket.readyState === WebSocket.CLOSED) {
        return;
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          resolve();
        }, 1_000);
        webSocket.addEventListener("close", () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
        webSocket.close(1000, "client stopping");
      });
      return;
    }

    const child = this.#child;
    if (child === undefined) {
      return;
    }

    this.#child = undefined;
    this.#output = undefined;
    this.#lines?.close();
    this.#lines = undefined;

    if (child.exitCode !== null) {
      return;
    }

    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        resolve();
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  #assertRunning(): void {
    if (!this.running) {
      throw new Error("Codex app-server client is not running");
    }
  }

  #write(message: Record<string, unknown>): void {
    const serialized = JSON.stringify(message);
    if (this.#webSocket?.readyState === WebSocket.OPEN) {
      this.#webSocket.send(serialized);
      return;
    }
    this.#output?.write(`${serialized}\n`);
  }

  async #startWebSocket(url: string): Promise<void> {
    const webSocket = new WebSocket(url);
    this.#webSocket = webSocket;
    webSocket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        this.#failPending(
          new Error("Codex app-server sent a non-text WebSocket message"),
        );
        return;
      }
      this.#handleLine(event.data);
    });
    webSocket.addEventListener("close", (event) => {
      if (this.#webSocket === webSocket) {
        this.#webSocket = undefined;
      }
      this.#failPending(
        new Error(
          `Codex app-server WebSocket closed (code=${String(event.code)}, reason=${event.reason || "none"})`,
        ),
      );
    });
    webSocket.addEventListener("error", () => {
      this.#failPending(new Error("Codex app-server WebSocket failed"));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        webSocket.addEventListener("open", () => resolve(), { once: true });
        webSocket.addEventListener(
          "error",
          () => reject(new Error(`Unable to connect to ${url}`)),
          { once: true },
        );
      });
    } catch (error) {
      if (this.#webSocket === webSocket) {
        this.#webSocket = undefined;
      }
      throw error;
    }
  }

  #handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.#failPending(
        new Error(`Invalid JSON from Codex app-server: ${String(error)}`),
      );
      return;
    }

    if (!isRecord(message)) {
      return;
    }

    const method = message.method;
    const id = message.id;
    if (
      typeof method === "string" &&
      (typeof id === "string" || typeof id === "number")
    ) {
      void this.#handleServerRequest({ id, method, params: message.params });
      return;
    }

    if (typeof id === "string" || typeof id === "number") {
      this.#handleResponse(id, message);
      return;
    }

    if (typeof method === "string") {
      const notification = { method, params: message.params };
      for (const handler of this.#notificationHandlers) {
        void Promise.resolve(handler(notification)).catch(() => undefined);
      }
    }
  }

  async #handleServerRequest(request: CodexServerRequest): Promise<void> {
    if (this.#serverRequestHandler === undefined) {
      this.#write({
        id: request.id,
        error: { code: -32601, message: `Unhandled method: ${request.method}` },
      });
      return;
    }

    let result: unknown;
    try {
      result = await this.#serverRequestHandler(request);
    } catch (error) {
      this.#write({
        id: request.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Request handler failed",
        },
      });
      return;
    }
    this.#write({ id: request.id, result });
    try {
      this.#serverResponseWrittenHandler?.(request);
    } catch {
      // Observability hooks cannot change an already submitted RPC response.
    }
  }

  #handleResponse(id: JsonRpcId, message: Record<string, unknown>): void {
    const pending = this.#pending.get(this.#idKey(id));
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(this.#idKey(id));
    clearTimeout(pending.timeout);

    const error = message.error;
    if (isRecord(error)) {
      const code = typeof error.code === "number" ? error.code : -32000;
      const remoteMessage =
        typeof error.message === "string" ? error.message : "JSON-RPC error";
      pending.reject(new JsonRpcRemoteError(remoteMessage, code, error.data));
      return;
    }
    pending.resolve(message.result);
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #idKey(id: JsonRpcId): string {
    return `${typeof id}:${String(id)}`;
  }
}
