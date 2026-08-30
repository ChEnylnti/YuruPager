import type { AgentModelOption, AgentSessionOptions } from "./types.js";

/**
 * Fail-closed session option validation (ADR-034): a requested model or
 * reasoning effort must exist in the runtime's capability catalogue; an
 * empty catalogue means only the agent default exists and any explicit
 * option is refused rather than silently ignored.
 */
export function assertSessionOptionsSupported(
  agentId: string,
  options: AgentSessionOptions | undefined,
  models: AgentModelOption[],
): void {
  if (options?.model === undefined && options?.reasoningEffort === undefined) return;
  if (models.length === 0) {
    throw new Error(`Agent ${agentId} exposes no model catalogue; requested session options fail closed (ADR-034)`);
  }
  if (options.model !== undefined) {
    const model = models.find((candidate) => candidate.id === options.model);
    if (model === undefined) {
      throw new Error(`Model ${options.model} is not available for agent ${agentId}`);
    }
    if (options.reasoningEffort !== undefined && !model.reasoningEfforts.includes(options.reasoningEffort)) {
      throw new Error(`Reasoning effort ${options.reasoningEffort} is not available for model ${model.id}`);
    }
    return;
  }
  const effort = options.reasoningEffort;
  if (effort !== undefined && !models.some((model) => model.reasoningEfforts.includes(effort))) {
    throw new Error(`Reasoning effort ${effort} is not available for agent ${agentId}`);
  }
}
