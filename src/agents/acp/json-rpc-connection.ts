import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export interface NdjsonJsonRpcConnectionOptions {
  command: string;
  args?: string[];
  cwd?: string;
  requestTimeoutMs?: number;
  onNotification(method: string, params: unknown): void;
  /** Server→client request; the returned value becomes the JSON-RPC result. */
  onRequest(method: string, params: unknown): Promise<unknown>;
  /** The child exited; pending requests reject with this cause. */
  onExit?(error: Error): void;
  spawnImpl?: typeof spawn;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * Newline-delimited JSON-RPC 2.0 over a child process stdio pair — the
 * transport dialect shared by ACP agents (ADR-024). Deliberately protocol
 * agnostic: method semantics live in the runtime, not here.
 */
export class NdjsonJsonRpcConnection {
  readonly #options: NdjsonJsonRpcConnectionOptions;
  readonly #pending = new Map<string, PendingRequest>();
  #child: ChildProcess | undefined;
  #nextId = 1;
  #exited = false;
  #stdinEnded = false;

  constructor(options: NdjsonJsonRpcConnectionOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#child !== undefined) throw new Error("JSON-RPC connection already started");
    const spawnImpl = this.#options.spawnImpl ?? spawn;
    const child = spawnImpl(this.#options.command, this.#options.args ?? [], {
      cwd: this.#options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    child.once("exit", () => this.#handleExit());
    child.once("error", (error) => this.#handleExit(error));
    if (child.stdout !== null) {
      const reader = createInterface({ input: child.stdout });
      reader.on("line", (line) => this.#handleLine(line));
    }
    if (child.stderr !== null) {
      child.stderr.on("data", () => undefined); // drain; agents may log on stderr
    }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const child = this.#child;
    if (child === undefined || this.#exited) {
      return Promise.reject(new Error(`JSON-RPC connection is not running: ${method}`));
    }
    const id = this.#nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timeoutMs = this.#options.requestTimeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        this.#pending.delete(String(id));
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(String(id), { resolve, reject, timer });
      child.stdin?.write(`${message}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.#pending.delete(String(id));
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  notify(method: string, params?: unknown): void {
    const child = this.#child;
    if (child === undefined || this.#exited) return;
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  respond(id: unknown, result: unknown): void {
    this.#write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: unknown, code: number, message: string): void {
    this.#write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (child === undefined || this.#exited) return;
    this.#stdinEnded = true;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      try {
        child.stdin?.end();
        child.kill("SIGTERM");
      } catch {
        resolve();
      }
      setTimeout(() => resolve(), 2_000).unref();
    });
  }

  #write(message: unknown): void {
    const child = this.#child;
    if (child === undefined || this.#exited || this.#stdinEnded) return;
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // tolerate non-protocol noise on stdout
    }
    if (typeof message.id !== "undefined" && ("result" in message || "error" in message)) {
      const pending = this.#pending.get(String(message.id));
      if (pending === undefined) return;
      this.#pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if ("error" in message) {
        const err = message.error as { message?: string } | undefined;
        pending.reject(new Error(err?.message ?? "JSON-RPC request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      const params = message.params ?? null;
      if (typeof message.id !== "undefined") {
        Promise.resolve()
          .then(() => this.#options.onRequest(message.method as string, params))
          .then((result) => this.respond(message.id, result))
          .catch((error: unknown) => this.respondError(
            message.id,
            -32603,
            error instanceof Error ? error.message : String(error),
          ));
      } else {
        this.#options.onNotification(message.method as string, params);
      }
    }
  }

  #handleExit(error?: Error): void {
    if (this.#exited) return;
    this.#exited = true;
    const cause = error ?? new Error("Agent process exited unexpectedly");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(cause);
    }
    this.#pending.clear();
    this.#options.onExit?.(cause);
  }
}
