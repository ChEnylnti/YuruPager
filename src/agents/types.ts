import type {
  ConnectorPayload,
  ConnectorSessionStreamMessage,
  ConnectorSessionTitle,
  SessionStreamFrame,
} from "@yurupager/shared";

import type {
  RemoteAttachmentControl,
  RemoteDecision,
  RemoteSessionCommand,
  RemoteSessionStreamControl,
} from "../transport/connector-cloud-client.js";

export type SessionUpsertPayload = Extract<ConnectorPayload, { type: "session.upsert" }>;

/** How a runtime discovers sessions on this workstation (ADR-025). */
export type AgentDiscoveryMode =
  /** The agent exposes a global session listing (Codex thread/list). */
  | "global"
  /** Only sessions the Connector itself started can be supervised. */
  | "own-sessions";

export interface AgentCapabilities {
  agentId: string;
  displayName: string;
  discovery: AgentDiscoveryMode;
  /** Structured question (answer) requests are supported. */
  questions: boolean;
  /** The agent reports token usage snapshots (ADR-024 usageStream). */
  usageReporting: boolean;
  /** The agent accepts local image attachments. */
  imageAttachments: boolean;
}

export interface AgentDiscoveredSessionSnapshot {
  sessions: SessionUpsertPayload[];
  titles: ConnectorSessionTitle[];
}

type ConnectorEphemeralMessage = Extract<
  ConnectorSessionStreamMessage,
  { type: "session.stream.frame" | "session.stream.error" }
> | { type: "session.titles.snapshot"; titles: ConnectorSessionTitle[] };

/**
 * Narrow event surface an AgentRuntime uses to publish sessions, requests,
 * usage, and ephemeral stream frames. The orchestrator implements it over the
 * shared cloud client; contract tests record into an in-memory sink.
 */
export interface AgentEventSink {
  /** Reliable, at-least-once payload (sessions, requests, usage). */
  send(payload: ConnectorPayload, idempotencyKey?: string): void;
  /** Ephemeral, connection-scoped stream traffic. */
  sendEphemeral(message: ConnectorEphemeralMessage): void;
}

export interface StreamFrameSink {
  frame(subscriptionId: string, sessionId: string, frame: SessionStreamFrame): void;
  error(subscriptionId: string, sessionId: string, code: "thread_unavailable" | "stream_failed"): void;
}

/**
 * The consumption surface the connector orchestrator needs from every agent
 * implementation (ADR-024). The orchestrator owns the single shared
 * ConnectorCloudClient and routes its callbacks here; runtimes never touch
 * the cloud client themselves.
 */
export interface AgentRuntime {
  readonly agentId: string;
  /** Publishes sessions/requests/usage/frames; wired before start(). */
  attach(sink: AgentEventSink): void;
  /** Capability probe (ADR-027); a throwing probe disables the agent. */
  capabilities(): Promise<AgentCapabilities>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Global discovery snapshot for the current refresh cycle; null when the
   * agent only exposes its own Connector-started sessions (ADR-025).
   */
  listSessions(): Promise<AgentDiscoveredSessionSnapshot | null>;
  handleDecision(remote: RemoteDecision): Promise<void>;
  handleSessionCommand(remote: RemoteSessionCommand): Promise<void>;
  handleSessionStream(control: RemoteSessionStreamControl): Promise<void>;
  handleAttachment?(control: RemoteAttachmentControl): Promise<void>;
  /** Optional cooperative cancel of the agent's active turn (ADR-024). */
  cancelSession?(threadId: string): Promise<void>;
  /** Called when the shared cloud connection transitions to online. */
  handleCloudOnline(): void;
}
