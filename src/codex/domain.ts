export type JsonRpcId = number | string;

export interface CodexServerRequest {
  id: JsonRpcId;
  method: string;
  params: unknown;
}

export interface CodexServerNotification {
  method: string;
  params: unknown;
}

export type ApprovalCategory = "command" | "fileChange" | "permissions";

export type ApprovalDecision = "approve" | "deny" | "cancel";

export interface ApprovalContext {
  command?: string;
  cwd?: string;
  reason?: string;
  grantRoot?: string;
  availableDecisions?: string[];
  requestedPermissions?: {
    network?: boolean;
    fileSystem?: Array<{
      access: string;
      path: string;
    }>;
  };
}

export interface ApprovalRequest {
  type: "approval.requested";
  requestId: string;
  category: ApprovalCategory;
  threadId: string;
  turnId: string;
  itemId: string;
  startedAt: string;
  context: ApprovalContext;
  source: {
    rpcId: JsonRpcId;
    method: string;
  };
}

export interface UserQuestionOption {
  label: string;
  description: string;
}

export interface UserQuestion {
  id: string;
  header: string;
  question: string;
  isSecret: boolean;
  options: UserQuestionOption[];
}

export interface QuestionRequest {
  type: "question.requested";
  requestId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: UserQuestion[];
  source: {
    rpcId: JsonRpcId;
    method: string;
  };
}

export type DomainRequest = ApprovalRequest | QuestionRequest;

export interface TokenUsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface ThreadTokenUsage {
  last: TokenUsageBreakdown;
  total: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface TokenUsageUpdatedEvent {
  type: "token.usage.updated";
  threadId: string;
  turnId: string;
  usage: ThreadTokenUsage;
}

export interface TurnCompletedEvent {
  type: "turn.completed";
  threadId: string;
  turnId: string;
  status: "completed" | "interrupted" | "failed" | "inProgress" | "unknown";
}

export interface TurnFailedEvent {
  type: "turn.failed";
  threadId: string;
  turnId: string;
  willRetry: boolean;
  errorCode: string;
}

export interface ServerRequestResolvedEvent {
  type: "server.request.resolved";
  threadId: string;
  rpcRequestId: JsonRpcId;
  decision: null;
}

export type DomainEvent =
  | TokenUsageUpdatedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ServerRequestResolvedEvent;

export interface AdaptedRequest<T extends DomainRequest = DomainRequest> {
  domain: T;
  createCodexResponse(input: DomainResponseInput): unknown;
}

export type DomainResponseInput =
  | {
      kind: "approval";
      decision: ApprovalDecision;
    }
  | {
      kind: "answers";
      answers: Record<string, string[]>;
    };
