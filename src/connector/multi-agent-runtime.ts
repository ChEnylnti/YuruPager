import type { ConnectorPayload, ConnectorSessionStreamMessage, WorkflowDefinitionSnapshot } from "@yurupager/shared";

import type { AgentEventSink, AgentRuntime } from "../agents/types.js";

import type { WorkflowEngine } from "../workflow/engine.js";
import type {
  ConnectorCloudClient,
  RemoteAttachmentControl,
} from "../transport/connector-cloud-client.js";

export interface MultiAgentRuntimeOptions {
  cloud: ConnectorCloudClient;
  /** Enabled agent runtimes in priority order; the first is the default owner. */
  agents: AgentRuntime[];
  /** Planning-workflow engine; receives dispatch/cancel and gate decisions. */
  workflowEngine?: WorkflowEngine;
}

/**
 * Fan-out orchestrator over `{agentId → AgentRuntime}` (ADR-024). It owns the
 * single shared ConnectorCloudClient and routes its callbacks to the owning
 * runtime. Cloud callbacks are addressed by threadId/uploadId, so the
 * orchestrator keeps ownership tables; unknown owners fall back to the first
 * runtime, which is fail-closed today because only one runtime is enabled —
 * Phase 2 refines decision routing once a second agent reports open requests.
 */
/** Implements the agent event sink over the single shared cloud client. */
export class CloudAgentEventSink implements AgentEventSink {
  constructor(readonly cloud: ConnectorCloudClient) {}

  send(payload: ConnectorPayload, idempotencyKey?: string): void {
    this.cloud.send(payload, idempotencyKey);
  }

  sendEphemeral(message: ConnectorSessionStreamMessage): void {
    this.cloud.sendEphemeral(message);
  }
}

export class MultiAgentRuntime {
  readonly #cloud: ConnectorCloudClient;
  readonly #agents = new Map<string, AgentRuntime>();
  readonly #defaultAgentId: string;
  readonly #sessionOwners = new Map<string, string>();
  readonly #uploadOwners = new Map<string, string>();
  readonly #workflowEngine: WorkflowEngine | undefined;

  constructor(options: MultiAgentRuntimeOptions) {
    for (const agent of options.agents) {
      if (this.#agents.has(agent.agentId)) {
        throw new Error(`Duplicate agent runtime: ${agent.agentId}`);
      }
      this.#agents.set(agent.agentId, agent);
    }
    if (this.#agents.size === 0) {
      throw new Error("MultiAgentRuntime requires at least one agent runtime");
    }
    this.#defaultAgentId = options.agents[0]?.agentId as string;
    this.#cloud = options.cloud;
    this.#workflowEngine = options.workflowEngine;
    // Wire the shared event sink so every runtime publishes sessions,
    // frames, and usage through the fan-out's single cloud connection.
    const sink = new CloudAgentEventSink(this.#cloud);
    for (const agent of options.agents) agent.attach(sink);
    this.#cloud.onDecision((decision) => {
      // workflow_gate decisions are consumed by the planning-workflow engine;
      // everything else routes to the owning agent runtime.
      if (this.#workflowEngine?.handleGateDecision({
        requestId: decision.requestId,
        decision: decision.decision.decision === "approve" ? "approve" : "deny",
      }) === true) return;
      void this.#default().handleDecision(decision);
    });
    this.#cloud.onWorkflowDispatch((runId, definition, messageId, sequence) => {
      if (this.#workflowEngine === undefined) return;
      this.#workflowEngine.dispatchRun(definition as WorkflowDefinitionSnapshot, runId);
      void messageId; void sequence;
    });
    this.#cloud.onWorkflowCancel((runId, reason) => {
      this.#workflowEngine?.cancelRun(runId, reason);
    });
    this.#cloud.onCommand((command) => {
      void this.#resolveOwner(command.threadId).handleSessionCommand(command);
    });
    this.#cloud.onSessionStream((control) => {
      void this.#resolveOwner(control.threadId).handleSessionStream(control);
    });
    this.#cloud.onAttachment((control) => {
      const agent = this.#resolveAttachmentOwner(control);
      if (agent.handleAttachment === undefined) return;
      void agent.handleAttachment(control);
    });
    this.#cloud.onStatus((online) => {
      if (!online) return;
      for (const agent of this.#agents.values()) agent.handleCloudOnline();
    });
  }

  /** Registers a session→agent ownership binding (used by Phase 2 runtimes). */
  learnSessionOwner(threadId: string, agentId: string): void {
    if (this.#agents.has(agentId)) this.#sessionOwners.set(threadId, agentId);
  }

  async start(): Promise<void> {
    // ADR-027: a throwing capability probe disables the agent instead of
    // silently supervising an unknown surface; failing everything refuses
    // to start rather than supervising nothing.
    const enabled = new Map<string, AgentRuntime>();
    for (const [agentId, agent] of this.#agents) {
      try {
        await agent.capabilities();
        enabled.set(agentId, agent);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Agent ${agentId} failed its capability probe and is disabled: ${detail}\n`);
      }
    }
    if (enabled.size === 0) {
      throw new Error("Every agent runtime failed its capability probe; refusing to start");
    }
    for (const agent of enabled.values()) {
      await agent.start();
    }
  }

  async stop(): Promise<void> {
    for (const agent of this.#agents.values()) {
      try {
        await agent.stop();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Agent ${agent.agentId} stop failed: ${detail}\n`);
      }
    }
    this.#sessionOwners.clear();
    this.#uploadOwners.clear();
  }

  #default(): AgentRuntime {
    return this.#agents.get(this.#defaultAgentId) as AgentRuntime;
  }

  #resolveOwner(threadId: string): AgentRuntime {
    const owner = this.#sessionOwners.get(threadId);
    if (owner !== undefined) {
      const agent = this.#agents.get(owner);
      if (agent !== undefined) return agent;
    }
    return this.#default();
  }

  #resolveAttachmentOwner(control: RemoteAttachmentControl): AgentRuntime {
    if (control.type === "session.attachment.begin") {
      const agent = this.#resolveOwner(control.threadId);
      this.#uploadOwners.set(control.uploadId, agent.agentId);
      return agent;
    }
    const owner = this.#uploadOwners.get(control.uploadId);
    if (owner !== undefined) {
      const agent = this.#agents.get(owner);
      if (agent !== undefined) return agent;
    }
    return this.#default();
  }
}
