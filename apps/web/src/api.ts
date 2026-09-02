import type {
  DecisionInput,
  DecisionResult,
  PreviewLaunchResult,
  PushCapability,
  PushSubscriptionInput,
  SessionCommandResult,
  Snapshot,
  UserSummary,
  WorkstationAccessMutationResult,
  WorkstationPreviewSummary,
  WorkstationPairingCreateResult,
  WorkstationPairingSummary,
  WorkspaceInviteCreateResult,
  WorkspaceKind,
  WorkspaceMemberMutationResult,
  WorkspaceMutationResult,
  WorkspaceRole,
} from "@yurupager/shared";

import { appUrl } from "./base-path.js";

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function getCurrentUser(): Promise<UserSummary> {
  const result = await request<{ user: UserSummary }>(appUrl("api/auth/me"));
  return result.user;
}

export async function login(email: string, password: string): Promise<UserSummary> {
  const result = await request<{ user: UserSummary }>(appUrl("api/auth/login"), {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return result.user;
}

export async function logout(): Promise<void> {
  await request<void>(appUrl("api/auth/logout"), { method: "POST" });
}

export async function getSnapshot(workspaceId: string | null): Promise<Snapshot> {
  const query = workspaceId === null ? "" : `?workspaceId=${encodeURIComponent(workspaceId)}`;
  return request<Snapshot>(appUrl(`api/snapshot${query}`));
}

export async function createWorkspace(name: string, kind: WorkspaceKind, idempotencyKey: string): Promise<WorkspaceMutationResult> {
  return request<WorkspaceMutationResult>(appUrl("api/workspaces"), {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ name, kind }),
  });
}

export async function createWorkspaceInvite(
  workspaceId: string,
  role: Exclude<WorkspaceRole, "owner">,
  idempotencyKey: string,
): Promise<WorkspaceInviteCreateResult> {
  return request<WorkspaceInviteCreateResult>(appUrl("api/workspace-invites"), {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ workspaceId, role }),
  });
}

export async function joinWorkspaceInvite(token: string): Promise<import("@yurupager/shared").WorkspaceSummary> {
  const result = await request<{ workspace: import("@yurupager/shared").WorkspaceSummary }>(appUrl("api/workspace-invites/join"), {
    method: "POST",
    body: JSON.stringify({ token }),
  });
  return result.workspace;
}

export async function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: Exclude<WorkspaceRole, "owner">,
): Promise<WorkspaceMemberMutationResult> {
  return request<WorkspaceMemberMutationResult>(appUrl(`api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`), {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export async function removeMember(workspaceId: string, userId: string): Promise<void> {
  await request<void>(appUrl(`api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`), { method: "DELETE" });
}

export async function updateWorkstationAccess(
  workspaceId: string,
  workstationId: string,
  input: { userId: string; canView: boolean; canRespond: boolean; canApproveHighRisk: boolean; canManage: boolean; canPreview: boolean },
): Promise<WorkstationAccessMutationResult> {
  return request<WorkstationAccessMutationResult>(appUrl(`api/workspaces/${encodeURIComponent(workspaceId)}/workstations/${encodeURIComponent(workstationId)}/access`), {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function revokeWorkstation(workspaceId: string, workstationId: string): Promise<void> {
  await request<{ revoked: true }>(appUrl(`api/workspaces/${encodeURIComponent(workspaceId)}/workstations/${encodeURIComponent(workstationId)}/revoke`), {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export interface WorkflowNodeInput {
  id: string;
  agentKind: string;
  model?: string;
  reasoningEffort?: string;
  task: string;
  handoffPrompt?: string;
  condition: { kind: string; criteriaText?: string; maxRetries: number; backoffMs: number };
  turnBudget: number;
  timeoutMs: number;
}

export interface WorkflowSummary {
  id: string;
  workspaceId: string;
  workstationId: string;
  name: string;
  goal: string;
  definition: { version: 1; workflowId: string; goal: string; workstationId: string; nodes: WorkflowNodeInput[] };
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunSummary {
  id: string;
  workflowId: string;
  workstationId: string;
  status: string;
  currentNodeIndex: number;
  reasonCode?: string;
  createdAt: string;
  updatedAt: string;
  nodes?: Array<{ nodeId: string; status: string; attempts: number; reasonCode?: string }>;
}

export async function createWorkflow(
  workspaceId: string,
  input: { name: string; goal: string; workstationId: string; nodes: WorkflowNodeInput[] },
): Promise<WorkflowSummary> {
  return request<WorkflowSummary>(appUrl("api/workflows"), {
    method: "POST",
    body: JSON.stringify({ workspaceId, ...input }),
  });
}

export async function listWorkflows(workspaceId: string): Promise<WorkflowSummary[]> {
  return request<WorkflowSummary[]>(appUrl(`api/workflows?workspaceId=${encodeURIComponent(workspaceId)}`));
}

export async function getWorkflow(workspaceId: string, workflowId: string): Promise<WorkflowSummary & { runs: WorkflowRunSummary[] }> {
  return request(appUrl(`api/workflows/${encodeURIComponent(workflowId)}?workspaceId=${encodeURIComponent(workspaceId)}`));
}

export async function updateWorkflow(
  workspaceId: string,
  workflowId: string,
  input: { name: string; goal: string; workstationId: string; nodes: WorkflowNodeInput[] },
): Promise<WorkflowSummary> {
  return request<WorkflowSummary>(appUrl(`api/workflows/${encodeURIComponent(workflowId)}`), {
    method: "PUT",
    body: JSON.stringify({ workspaceId, ...input }),
  });
}

export async function deleteWorkflow(workspaceId: string, workflowId: string): Promise<void> {
  await request(appUrl(`api/workflows/${encodeURIComponent(workflowId)}?workspaceId=${encodeURIComponent(workspaceId)}`), { method: "DELETE" });
}

export async function runWorkflow(workflowId: string, workspaceId: string): Promise<WorkflowRunSummary> {
  return request<WorkflowRunSummary>(appUrl(`api/workflows/${encodeURIComponent(workflowId)}/run`), {
    method: "POST",
    body: JSON.stringify({ workspaceId }),
  });
}

export async function cancelWorkflowRun(workspaceId: string, runId: string): Promise<WorkflowRunSummary> {
  return request<WorkflowRunSummary>(appUrl(`api/workflow-runs/${encodeURIComponent(runId)}/cancel`), {
    method: "POST",
    body: JSON.stringify({ workspaceId }),
  });
}

export async function getWorkflowRuns(workspaceId: string, workflowId: string): Promise<WorkflowRunSummary[]> {
  return request<WorkflowRunSummary[]>(appUrl(`api/workflows/${encodeURIComponent(workflowId)}/runs?workspaceId=${encodeURIComponent(workspaceId)}`));
}

export async function getPushCapability(): Promise<PushCapability> {
  return request<PushCapability>(appUrl("api/push/config"));
}

export async function registerPushSubscription(subscription: PushSubscriptionInput): Promise<void> {
  await request<{ subscribed: true }>(appUrl("api/push/subscriptions"), {
    method: "POST",
    body: JSON.stringify(subscription),
  });
}

export async function unregisterPushSubscription(endpoint: string): Promise<void> {
  await request<void>(appUrl("api/push/subscriptions"), {
    method: "DELETE",
    body: JSON.stringify({ endpoint }),
  });
}

export async function getWorkstationPairings(workspaceId: string | null): Promise<WorkstationPairingSummary[]> {
  const query = workspaceId === null ? "" : `?workspaceId=${encodeURIComponent(workspaceId)}`;
  const result = await request<{ pairings: WorkstationPairingSummary[] }>(appUrl(`api/workstation-pairings${query}`));
  return result.pairings;
}

export async function createWorkstationPairing(
  workspaceId: string,
  idempotencyKey: string,
): Promise<WorkstationPairingCreateResult> {
  return request<WorkstationPairingCreateResult>(appUrl("api/workstation-pairings"), {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ workspaceId }),
  });
}

export async function approveWorkstationPairing(
  pairingId: string,
  workstationName: string,
): Promise<WorkstationPairingSummary> {
  const result = await request<{ pairing: WorkstationPairingSummary }>(appUrl(`api/workstation-pairings/${encodeURIComponent(pairingId)}/approve`), {
    method: "POST",
    body: JSON.stringify({ workstationName }),
  });
  return result.pairing;
}

export async function cancelWorkstationPairing(pairingId: string): Promise<WorkstationPairingSummary> {
  const result = await request<{ pairing: WorkstationPairingSummary }>(appUrl(`api/workstation-pairings/${encodeURIComponent(pairingId)}/cancel`), {
    method: "POST",
    body: JSON.stringify({}),
  });
  return result.pairing;
}

export async function launchPreview(previewId: string): Promise<PreviewLaunchResult> {
  return request<PreviewLaunchResult>(appUrl(`api/previews/${encodeURIComponent(previewId)}/launch`), {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function stopPreview(previewId: string): Promise<WorkstationPreviewSummary> {
  const result = await request<{ preview: WorkstationPreviewSummary }>(appUrl(`api/previews/${encodeURIComponent(previewId)}/stop`), {
    method: "POST",
    body: JSON.stringify({}),
  });
  return result.preview;
}

export async function submitDecision(
  requestId: string,
  idempotencyKey: string,
  input: DecisionInput,
): Promise<DecisionResult> {
  return request<DecisionResult>(appUrl(`api/requests/${encodeURIComponent(requestId)}/decision`), {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

export async function sendSessionMessage(
  sessionId: string,
  idempotencyKey: string,
  content: string,
  attachmentTickets: string[] = [],
): Promise<SessionCommandResult> {
  return request<SessionCommandResult>(appUrl(`api/sessions/${encodeURIComponent(sessionId)}/commands`), {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({
      content,
      attachments: attachmentTickets.map((ticket) => ({ ticket })),
    }),
  });
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    let body: ApiErrorBody = {};
    try { body = (await response.json()) as ApiErrorBody; } catch { /* non-JSON proxy error */ }
    throw new ApiError(
      response.status,
      body.error?.code ?? "request_failed",
      body.error?.message ?? `Request failed (${response.status})`,
      body.error?.details,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
