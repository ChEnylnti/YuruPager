import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type {
  PreviewHttpMethod,
  PreviewTunnelErrorCode,
  WorkstationPreviewSummary,
} from "@yurupager/shared";
import type { WebSocket } from "ws";

import type { ConnectorIdentity } from "../connector-repository.js";
import type { PreviewContextBinding } from "../preview-security.js";

export interface PreviewConnection {
  identity: ConnectorIdentity;
  socket: WebSocket;
  phase: "pending" | "active";
  connectionEpoch: string | null;
  routes: Set<string>;
}

export interface PreviewAccess {
  binding: PreviewContextBinding;
  preview: WorkstationPreviewSummary;
  connector: PreviewConnection;
}

export interface StreamBase {
  id: string;
  access: PreviewAccess;
  connector: PreviewConnection;
  requestCredit: number;
  responseOffset: number;
  requestOffset: number;
  dispatched: boolean;
  settled: boolean;
  idleTimer: NodeJS.Timeout;
  lifetimeTimer: NodeJS.Timeout;
  done: Deferred<void>;
}

export interface HttpStream extends StreamBase {
  kind: "http";
  method: PreviewHttpMethod;
  request: IncomingMessage;
  response: ServerResponse;
  accepted: Deferred<void>;
  responseStarted: boolean;
  responseBackpressured: boolean;
  responseEndReceived: boolean;
  pendingResponseCredit: number;
}

export interface BrowserWebSocketStream extends StreamBase {
  kind: "websocket";
  request: IncomingMessage;
  rawSocket: Duplex;
  head: Buffer;
  accepted: Deferred<void>;
  acceptedProtocol?: string;
  browser?: WebSocket;
  inboundSequence: number;
  outboundSequence: number;
}

export type PreviewStream = HttpStream | BrowserWebSocketStream;

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // A stream may fail before its sequential consumer reaches this promise.
  void promise.catch(() => undefined);
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export class PreviewStreamFailure extends Error {
  constructor(readonly code: PreviewTunnelErrorCode, readonly dispatched: boolean) {
    super(code);
  }
}

export class PreviewAdmissionFailure extends Error {
  constructor(readonly reason: "busy" | "cancelled" | "unavailable") {
    super(reason);
  }
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
