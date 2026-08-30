export const requestStatuses = [
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
  "interrupted",
] as const;

export const deliveryStatuses = [
  "not_queued",
  "queued",
  "sent",
  "delivered",
  "failed",
  "sent_unknown",
] as const;

export type RequestStatus = (typeof requestStatuses)[number];
export type DeliveryStatus = (typeof deliveryStatuses)[number];
export type RiskLevel = "low" | "medium" | "high";
export type WorkspaceRole = "owner" | "admin" | "member";
export type WorkspaceKind = "personal" | "company" | "team";
export type RequestKind = "approval" | "question" | "workflow_gate";
export type SessionCommandStatus = "queued" | "delivered" | "failed" | "sent_unknown";
export type SessionSyncState = "live" | "historical" | "stale";
export const sessionImageMimeTypes = ["image/png", "image/jpeg", "image/webp"] as const;
export type SessionImageMimeType = (typeof sessionImageMimeTypes)[number];
export const sessionImageLimits = {
  maxAttachments: 4,
  maxAttachmentBytes: 5 * 1024 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
  maxChunkBytes: 48 * 1024,
} as const;

export const previewLimits = {
  maxRoutesPerWorkstation: 8,
  minLocalPort: 1_024,
  maxLocalPort: 65_535,
  minRouteDurationMs: 15 * 60_000,
  maxRouteDurationMs: 240 * 60_000,
  maxNameCharacters: 80,
  maxPathBytes: 8 * 1_024,
  maxHeaderCount: 64,
  maxHeaderBytes: 32 * 1_024,
  maxChunkBytes: 32 * 1_024,
  initialWindowBytes: 256 * 1_024,
  maxRequestBytes: 16 * 1_024 * 1_024,
  maxResponseBytes: 64 * 1_024 * 1_024,
  maxConcurrentStreamsPerUser: 8,
  maxConcurrentStreamsPerConnector: 32,
  maxQueuedStreamsPerUser: 64,
  maxQueuedStreamsPerConnector: 128,
  firstByteTimeoutMs: 15_000,
  idleTimeoutMs: 30_000,
  maxLifetimeMs: 10 * 60_000,
} as const;

export type WorkstationPreviewStatus =
  | "active"
  | "unreachable"
  | "connector_offline"
  | "stopped"
  | "expired";
export type PreviewHttpMethod = "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE";
export type PreviewHeader = [name: string, value: string];

export interface ConnectorPreviewRoute {
  routeId: string;
  name: string;
  port: number;
  status: "active" | "unreachable";
  expiresAt: string;
}

export interface WorkstationPreviewSummary {
  id: string;
  workspaceId: string;
  workstationId: string;
  workstationName: string;
  routeId: string;
  name: string;
  port: number;
  status: WorkstationPreviewStatus;
  startedAt: string;
  lastSeenAt: string;
  stoppedAt: string | null;
  expiresAt: string;
  updatedAt: string;
}

export interface PreviewCapability {
  enabled: boolean;
  gatewayOrigin: string | null;
  command: string;
}

export interface PreviewLaunchResult {
  preview: WorkstationPreviewSummary;
  ticket: string;
  gatewayOrigin: string;
  expiresAt: string;
}

export type PreviewTunnelErrorCode =
  | "route_unavailable"
  | "local_connection_failed"
  | "local_timeout"
  | "request_too_large"
  | "response_too_large"
  | "protocol_error"
  | "stream_cancelled";

export type PreviewFlowDirection = "request" | "response";

export type PreviewTunnelServerMessage =
  | {
      type: "preview.welcome";
      connectionEpoch: string;
      maxChunkBytes: number;
      initialWindowBytes: number;
    }
  | {
      type: "preview.http.open";
      streamId: string;
      routeId: string;
      method: PreviewHttpMethod;
      path: string;
      headers: PreviewHeader[];
      bodyLength?: number;
    }
  | { type: "preview.http.request.chunk"; streamId: string; offset: number; data: string }
  | { type: "preview.http.request.end"; streamId: string }
  | { type: "preview.stream.cancel"; streamId: string; reason: string }
  | {
      type: "preview.route.stop";
      routeId: string;
      reason: "user_stopped" | "expired" | "permission_revoked" | "server_shutdown";
    }
  | {
      type: "preview.ws.open";
      streamId: string;
      routeId: string;
      path: string;
      headers: PreviewHeader[];
      protocols: string[];
    }
  | { type: "preview.ws.frame"; streamId: string; sequence: number; binary: boolean; data: string }
  | { type: "preview.ws.close"; streamId: string; code: number; reason: string }
  | {
      type: "preview.flow";
      streamId: string;
      direction: PreviewFlowDirection;
      ackOffset: number;
      creditBytes: number;
    };

export type PreviewTunnelClientMessage =
  | {
      type: "preview.hello";
      protocolVersion: 1;
      connectionEpoch: string;
      routes: ConnectorPreviewRoute[];
    }
  | { type: "preview.routes.snapshot"; revision: number; routes: ConnectorPreviewRoute[] }
  | { type: "preview.http.accepted"; streamId: string }
  | {
      type: "preview.http.response.start";
      streamId: string;
      statusCode: number;
      headers: PreviewHeader[];
    }
  | { type: "preview.http.response.chunk"; streamId: string; offset: number; data: string }
  | { type: "preview.http.response.end"; streamId: string }
  | {
      type: "preview.stream.error";
      streamId: string;
      code: PreviewTunnelErrorCode;
      dispatched: boolean;
    }
  | { type: "preview.ws.accepted"; streamId: string; protocol?: string }
  | { type: "preview.ws.frame"; streamId: string; sequence: number; binary: boolean; data: string }
  | { type: "preview.ws.close"; streamId: string; code: number; reason: string }
  | {
      type: "preview.flow";
      streamId: string;
      direction: PreviewFlowDirection;
      ackOffset: number;
      creditBytes: number;
    };

export interface SessionCommandAttachment {
  attachmentId: string;
  mimeType: SessionImageMimeType;
  byteLength: number;
  sha256: string;
}

export interface SessionCommandAttachmentInput {
  ticket: string;
}
export type WorkstationPairingStatus =
  | "waiting_for_device"
  | "pending_approval"
  | "approved"
  | "cancelled"
  | "expired";

export interface UserSummary {
  id: string;
  email: string;
  name: string;
}

export interface PushCapability {
  enabled: boolean;
  publicKey: string | null;
}

export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  kind: WorkspaceKind;
  role: WorkspaceRole;
  pendingCount: number;
}

export interface WorkspaceInviteCreateResult {
  workspaceId: string;
  workspaceName: string;
  role: Exclude<WorkspaceRole, "owner">;
  token: string;
  expiresAt: string;
  replayed: boolean;
}

export interface WorkspaceMutationResult {
  workspace: WorkspaceSummary;
  replayed: boolean;
}

export interface WorkspaceMemberMutationResult {
  member: MemberSummary;
  replayed: boolean;
}

export interface WorkstationAccessUpdateInput {
  userId: string;
  canView: boolean;
  canRespond: boolean;
  canApproveHighRisk: boolean;
  canManage: boolean;
  canPreview: boolean;
}

export interface WorkstationAccessMutationResult {
  workspaceId: string;
  workstationId: string;
  userId: string;
  canView: boolean;
  canRespond: boolean;
  canApproveHighRisk: boolean;
  canManage: boolean;
  canPreview: boolean;
}

export interface WorkstationSummary {
  id: string;
  workspaceId: string;
  workspaceName: string;
  name: string;
  platform: string;
  connectorVersion: string;
  status: "online" | "offline" | "degraded";
  lastSeenAt: string | null;
  activeSessionCount: number;
  pendingCount: number;
}

export interface WorkstationPairingSummary {
  id: string;
  workspaceId: string;
  workspaceName: string;
  status: WorkstationPairingStatus;
  deviceName: string | null;
  platform: string | null;
  connectorVersion: string | null;
  fingerprint: string | null;
  workstationId: string | null;
  createdByName: string;
  approvedByName: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkstationPairingCreateResult {
  pairing: WorkstationPairingSummary;
  pairCode: string;
  replayed: boolean;
}

export interface ConnectorPairingClaimResult {
  pairingId: string;
  status: WorkstationPairingStatus;
  expiresAt: string;
  workspaceId?: string;
  workstationId?: string;
  connectorToken?: string;
}

export interface SessionSummary {
  id: string;
  workspaceId: string;
  workstationId: string;
  workstationName: string;
  initiatorName: string | null;
  /** Owning agent id (protocol v2, ADR-026); legacy consumers default to codex. */
  agent?: string;
  threadId: string;
  projectKey: string;
  projectName: string;
  projectPath: string;
  model: string;
  status: "running" | "waiting" | "completed" | "failed" | "interrupted";
  syncState: SessionSyncState;
  startedAt: string;
  updatedAt: string;
}

export interface SessionCommandSummary {
  id: string;
  workspaceId: string;
  workstationId: string;
  sessionId: string;
  actorName: string;
  status: SessionCommandStatus;
  contentLength: number;
  attachmentCount: number;
  turnId: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

export interface RequestContext {
  command?: string;
  cwd?: string;
  reason?: string;
  grantRoot?: string;
  /** Agent-specific approval option identifiers (protocol v2, ADR-027). */
  availableDecisions?: string[];
  requestedPermissions?: {
    network?: boolean;
    fileSystem?: Array<{ access: string; path: string }>;
  };
  questions?: Array<{
    id: string;
    header: string;
    question: string;
    isSecret: boolean;
    options: Array<{ label: string; description: string }>;
  }>;
}

export interface RequestSummary {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workstationId: string;
  workstationName: string;
  sessionId: string;
  sessionInitiatorName: string | null;
  projectName: string;
  kind: RequestKind;
  category: string;
  tool: string;
  risk: RiskLevel;
  context: RequestContext;
  status: RequestStatus;
  deliveryStatus: DeliveryStatus;
  assignedToName: string | null;
  decidedByName: string | null;
  decisionReason: string | null;
  requestedAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

export interface MemberSummary {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  workstationCount: number;
  workstationAccess: Array<{
    workstationId: string;
    workstationName: string;
    canView: boolean;
    canRespond: boolean;
    canApproveHighRisk: boolean;
    canManage: boolean;
    canPreview: boolean;
  }>;
}

export interface UsageSummary {
  id: string;
  workspaceId: string;
  workstationId: string;
  workstationName: string;
  sessionId: string;
  projectName: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  quality: "provisional" | "final" | "incomplete";
  estimatedCostMicros: number | null;
  priceVersion: string | null;
  updatedAt: string;
}

export interface AuditSummary {
  id: string;
  workspaceId: string;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string;
  previousState: string | null;
  nextState: string | null;
  occurredAt: string;
  metadata: Record<string, unknown>;
}

export interface Snapshot {
  generatedAt: string;
  scopeWorkspaceId: string | null;
  workspaces: WorkspaceSummary[];
  workstations: WorkstationSummary[];
  previews: WorkstationPreviewSummary[];
  previewCapability: PreviewCapability;
  sessions: SessionSummary[];
  sessionCommands: SessionCommandSummary[];
  requests: RequestSummary[];
  members: MemberSummary[];
  usage: UsageSummary[];
  audit: AuditSummary[];
}

export interface SessionCommandResult {
  command: SessionCommandSummary;
  replayed: boolean;
}

export type ConversationMessageRole = "user" | "assistant";
export type ConversationMessagePhase = "commentary" | "final_answer";
export type ConversationTurnStatus = "in_progress" | "completed" | "failed" | "interrupted";
export type ConversationActivityKind =
  | "command"
  | "file_change"
  | "tool"
  | "web_search"
  | "image"
  | "collaboration"
  | "wait"
  | "review"
  | "context_compaction";
export type ConversationActivityStatus = "in_progress" | "completed" | "failed" | "cancelled";

export type SessionStreamFrame =
  | { kind: "history.start" }
  | {
      kind: "message.start";
      messageId: string;
      turnId: string;
      role: ConversationMessageRole;
      phase?: ConversationMessagePhase;
    }
  | { kind: "message.reset"; messageId: string }
  | { kind: "message.delta"; messageId: string; delta: string }
  | { kind: "message.complete"; messageId: string }
  | {
      kind: "image.start";
      imageId: string;
      turnId: string;
      role: ConversationMessageRole;
      mimeType: SessionImageMimeType;
      byteLength: number;
    }
  | { kind: "image.chunk"; imageId: string; sequence: number; data: string }
  | { kind: "image.complete"; imageId: string; sha256: string }
  | {
      kind: "image.error";
      imageId: string;
      turnId: string;
      role: ConversationMessageRole;
      code:
        | "image_unavailable"
        | "image_invalid"
        | "image_too_large"
        | "image_incomplete"
        | "image_hash_mismatch";
    }
  | {
      kind: "activity.upsert";
      activityId: string;
      turnId: string;
      activity: ConversationActivityKind;
      label: string;
      status: ConversationActivityStatus;
    }
  | { kind: "history.complete" }
  | { kind: "turn.status"; turnId: string; status: ConversationTurnStatus };

export type SessionStreamState = "loading" | "live" | "connector_offline" | "denied" | "error";

export interface ConnectorSessionTitle {
  threadId: string;
  title: string;
}

export interface SessionTitle {
  sessionId: string;
  title: string;
}

export type WebLiveClientMessage =
  | { type: "session.stream.subscribe"; sessionId: string }
  | { type: "session.stream.unsubscribe"; sessionId: string }
  | {
      type: "session.attachment.begin";
      sessionId: string;
      uploadId: string;
      mimeType: SessionImageMimeType;
      byteLength: number;
      sha256: string;
    }
  | {
      type: "session.attachment.chunk";
      sessionId: string;
      uploadId: string;
      offset: number;
      data: string;
    }
  | { type: "session.attachment.complete"; sessionId: string; uploadId: string }
  | { type: "session.attachment.cancel"; sessionId: string; uploadId: string };

export type SessionAttachmentUploadState =
  | "accepted"
  | "progress"
  | "ready"
  | "failed"
  | "cancelled";

export type SessionAttachmentErrorCode =
  | "connector_offline"
  | "permission_denied"
  | "invalid_upload"
  | "invalid_image_type"
  | "image_too_large"
  | "invalid_chunk"
  | "chunk_out_of_order"
  | "image_incomplete"
  | "image_hash_mismatch"
  | "connector_write_failed"
  | "upload_expired";

export type WebLiveServerMessage =
  | { type: "connected"; userId: string }
  | { type: "snapshot.invalidated"; workspaceId: string; requestId?: string; sessionId?: string; commandId?: string; status?: string }
  | { type: "session.titles.snapshot"; titles: SessionTitle[] }
  | { type: "session.stream.status"; sessionId: string; state: SessionStreamState }
  | { type: "session.stream.frame"; sessionId: string; frame: SessionStreamFrame }
  | {
      type: "session.attachment.status";
      sessionId: string;
      uploadId: string;
      state: SessionAttachmentUploadState;
      nextOffset?: number;
      ticket?: string;
      code?: SessionAttachmentErrorCode;
    };

export type ConnectorSessionStreamControl =
  | { type: "session.stream.subscribe"; subscriptionId: string; threadId: string }
  | { type: "session.stream.unsubscribe"; subscriptionId: string; threadId: string }
  | {
      type: "session.attachment.begin";
      transferId: string;
      uploadId: string;
      threadId: string;
      mimeType: SessionImageMimeType;
      byteLength: number;
      sha256: string;
    }
  | {
      type: "session.attachment.chunk";
      transferId: string;
      uploadId: string;
      offset: number;
      data: string;
    }
  | { type: "session.attachment.complete"; transferId: string; uploadId: string }
  | { type: "session.attachment.cancel"; transferId: string; uploadId: string };

export type ConnectorSessionStreamMessage =
  | { type: "session.titles.snapshot"; titles: ConnectorSessionTitle[] }
  | { type: "session.stream.frame"; subscriptionId: string; threadId: string; frame: SessionStreamFrame }
  | { type: "session.stream.error"; subscriptionId: string; threadId: string; code: "thread_unavailable" | "stream_failed" }
  | {
      type: "session.attachment.status";
      transferId: string;
      uploadId: string;
      state: SessionAttachmentUploadState;
      nextOffset?: number;
      attachmentId?: string;
      code?: SessionAttachmentErrorCode;
    };

export interface DecisionInput {
  decision: "approve" | "deny" | "answer";
  reason?: string;
  answers?: Record<string, string[]>;
  highRiskConfirmed?: boolean;
}

export interface DecisionResult {
  request: RequestSummary;
  replayed: boolean;
}

// ---------------------------------------------------------------------------
// Planning workflows (ADR-032..036). Hand-off text and agent output are
// session content: they never enter these payloads — status messages carry
// machine-readable metadata only.
// ---------------------------------------------------------------------------

export type WorkflowReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface WorkflowModelOption {
  id: string;
  displayName: string;
  reasoningEfforts: WorkflowReasoningEffort[];
}

export type WorkflowConditionKind = "agent_confirm" | "criteria_check" | "manual_gate";
export type WorkflowFailureStrategy = "stop" | "manual_intervention";

export interface WorkflowNodeCondition {
  kind: WorkflowConditionKind;
  /** criteria_check only: the user-written criteria text. */
  criteriaText?: string;
  maxRetries: number;
  backoffMs: number;
}

export interface WorkflowNodeDefinition {
  id: string;
  agentKind: string;
  model?: string;
  reasoningEffort?: WorkflowReasoningEffort;
  /** Task template rendered with the workflow variables. */
  task: string;
  /** Hand-off template appended to the next node's prompt after confirmation. */
  handoffPrompt?: string;
  condition: WorkflowNodeCondition;
  turnBudget: number;
  timeoutMs: number;
}

export interface WorkflowDefinitionSnapshot {
  version: 1;
  workflowId: string;
  goal: string;
  workstationId: string;
  /** Linear chain in execution order (v1 validates linearity at the editor). */
  nodes: WorkflowNodeDefinition[];
}

export type WorkflowRunStatus =
  | "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export type WorkflowNodeRunStatus =
  | "pending" | "starting" | "running" | "verifying" | "waiting_approval"
  | "completed" | "failed" | "cancelled" | "interrupted" | "blocked_offline";

export interface WorkflowNodeRunState {
  nodeId: string;
  index: number;
  status: WorkflowNodeRunStatus;
  attempts: number;
  sessionId?: string;
  /** Machine-readable, non-content reason (e.g. timeout, gate_denied). */
  reasonCode?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface WorkflowRunState {
  runId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  currentNodeIndex: number;
  nodes: WorkflowNodeRunState[];
  reasonCode?: string;
  startedAt?: string;
  completedAt?: string;
}

export type ConnectorPayload =
  | {
      type: "workstation.heartbeat";
      name: string;
      platform: string;
      connectorVersion: string;
    }
  | {
      type: "session.upsert";
      threadId: string;
      /** Protocol v2: agent that owns the session (defaults to "codex"). */
      agent?: string;
      /** Protocol v2: agent-neutral alias mirroring threadId. */
      sessionId?: string;
      turnId?: string;
      projectKey: string;
      projectName: string;
      projectPath: string;
      model: string;
      status: SessionSummary["status"];
      syncState: SessionSyncState;
      initiatedByEmail?: string;
      startedAt?: string;
      updatedAt?: string;
    }
  | {
      type: "session.inventory";
      inventoryId: string;
      threadIds: string[];
      /** Protocol v2: agent that owns the inventoried sessions. */
      agent?: string;
      /** Protocol v2: agent-neutral aliases mirroring threadIds. */
      sessionIds?: string[];
    }
  | {
      type: "request.created";
      requestId: string;
      threadId: string;
      /** Protocol v2: agent that raised the request (defaults to "codex"). */
      agent?: string;
      /** Protocol v2: agent-neutral alias mirroring threadId. */
      sessionId?: string;
      turnId: string;
      itemId: string;
      kind: RequestKind;
      category: string;
      tool: string;
      risk: RiskLevel;
      context: RequestContext;
      requestedAt: string;
      expiresAt: string;
    }
  | {
      type: "token.snapshot";
      eventId: string;
      sequence: number;
      threadId: string;
      /** Protocol v2: agent that reported the usage (defaults to "codex"). */
      agent?: string;
      /** Protocol v2: agent-neutral alias mirroring threadId. */
      sessionId?: string;
      turnId: string;
      /** Protocol v2: pricing provider carried from the adapter usage event (defaults to "openai"). */
      provider?: string;
      model: string;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      totalTokens: number;
      quality: "provisional" | "final" | "incomplete";
      observedAt: string;
    }
  | {
      type: "turn.completed";
      threadId: string;
      turnId: string;
      status: "completed" | "failed" | "interrupted";
    }
  | {
      type: "session.command.updated";
      commandId: string;
      threadId: string;
      status: Exclude<SessionCommandStatus, "queued">;
      turnId?: string;
      errorCode?: string;
    }
  | {
      type: "delivery.updated";
      requestId: string;
      deliveryStatus: DeliveryStatus;
    }
  | {
      type: "request.resolved";
      requestId: string;
      status: "cancelled" | "interrupted";
      reason: string;
    }
  | {
      type: "workflow.run.status";
      runId: string;
      status: WorkflowRunStatus;
      reasonCode?: string;
    }
  | {
      type: "workflow.node.status";
      runId: string;
      nodeId: string;
      index: number;
      status: WorkflowNodeRunStatus;
      attempts: number;
      sessionId?: string;
      reasonCode?: string;
    };

export interface TransportEnvelope<T = unknown> {
  type: "event";
  protocolVersion: 1;
  messageId: string;
  streamId: string;
  connectionEpoch: string;
  sequence: number;
  timestamp: string;
  idempotencyKey: string;
  payload: T;
}

export type ConnectorServerMessage =
  | { type: "welcome"; connectionEpoch: string; lastAcceptedSequence: number }
  | {
      type: "workflow.run.dispatch";
      messageId: string;
      sequence: number;
      runId: string;
      definition: WorkflowDefinitionSnapshot;
    }
  | { type: "workflow.run.cancel"; messageId: string; sequence: number; runId: string; reason: string }
  | { type: "ack"; messageId: string; sequence: number }
  | { type: "heartbeat"; timestamp: string }
  | { type: "decision"; messageId: string; sequence: number; requestId: string; decisionId: string; decision: DecisionInput }
  | {
      type: "session.command";
      messageId: string;
      sequence: number;
      commandId: string;
      threadId: string;
      text: string;
      attachments: SessionCommandAttachment[];
    }
  | ConnectorSessionStreamControl;
