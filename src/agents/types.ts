import type {
  ConnectorPayload,
  ConnectorSessionTitle,
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

/**
 * The consumption surface the connector orchestrator needs from every agent
 * implementation (ADR-024). The orchestrator owns the single shared
 * ConnectorCloudClient and routes its callbacks here; runtimes never touch
 * the cloud client themselves.
 */
export interface AgentRuntime {
  readonly agentId: string;
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
  /** Called when the shared cloud connection transitions to online. */
  handleCloudOnline(): void;
}
