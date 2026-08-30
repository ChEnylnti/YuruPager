/**
 * Known agent presets (ADR-024/028/029). A config entry may reference a
 * preset by `kind` and omit `command`; the composition layer resolves the
 * preset's command and arguments. `codex`, `acp`, and `cursor` are runtime
 * kinds handled directly by the orchestrator wiring; every other preset maps
 * onto the ACP runtime with its own stable agentId.
 */
export interface AgentPreset {
  runtime: "acp" | "cursor" | "zcode";
  command: string;
  args: string[];
}

export const AGENT_PRESETS: Record<string, AgentPreset> = {
  // ZCode rides its native ZCode Protocol app-server (ADR-030); supervision
  // forces --mode build unless the operator configures edit.
  zcode: { runtime: "zcode", command: "zcode", args: [] },
  // Claude Code rides the claude-agent-acp adapter (ADR-028: adapter path
  // adopted; the native stream-json path stays a conditional fallback).
  "claude-code": { runtime: "acp", command: "claude-agent-acp", args: [] },
  gemini: { runtime: "acp", command: "gemini", args: ["--acp"] },
  opencode: { runtime: "acp", command: "opencode", args: ["acp"] },
  amp: { runtime: "acp", command: "amp", args: ["acp"] },
  crush: { runtime: "acp", command: "crush", args: ["acp"] },
  "qwen-code": { runtime: "acp", command: "qwen", args: ["--acp"] },
};

export function resolveAgentPreset(kind: string): AgentPreset | null {
  return AGENT_PRESETS[kind] ?? null;
}
