import type { WorkflowDefinitionSnapshot } from "@yurupager/shared";

export interface WorkflowTemplateVariables {
  goal: string;
  nodeTask: string;
  prevFinalMessage: string | null;
  prevCheckSummary: string | null;
}

/**
 * Renders node/hand-off prompt templates (ADR-032). The v1 variable set is
 * fixed: {{workflow.goal}}, {{node.task}}, {{prev.finalMessage}},
 * {{prev.checkSummary}}. Unknown placeholders are left untouched so authors
 * can see their mistakes instead of silently losing content. Rendering
 * happens in Connector memory only — the output never persists.
 */
export function renderTemplate(template: string, variables: WorkflowTemplateVariables): string {
  return template
    .replaceAll("{{workflow.goal}}", variables.goal)
    .replaceAll("{{node.task}}", variables.nodeTask)
    .replaceAll("{{prev.finalMessage}}", variables.prevFinalMessage ?? "")
    .replaceAll("{{prev.checkSummary}}", variables.prevCheckSummary ?? "");
}

/** The fixed self-check prompt for agent_confirm (ADR-033). Authors cannot
 *  rewrite it, which keeps the PASS/FAIL contract injection-resistant. */
export function agentConfirmPrompt(nodeTask: string): string {
  return [
    "Self-check request. Review the work you completed for the task below.",
    `Task: ${nodeTask}`,
    "Answer with exactly one line starting with PASS or FAIL, followed by ' - ' and a one-sentence reason.",
    "Do not perform any new work in this turn.",
  ].join("\n");
}

export function criteriaCheckPrompt(nodeTask: string, criteriaText: string): string {
  return [
    "Verification request. Check the work you completed for the task below against the acceptance criteria.",
    `Task: ${nodeTask}`,
    `Acceptance criteria: ${criteriaText}`,
    "Answer with exactly one line starting with PASS or FAIL, followed by ' - ' and a one-sentence reason.",
    "Do not perform any new work in this turn.",
  ].join("\n");
}

export type ConditionVerdict = { verdict: "PASS" | "FAIL"; reason: string };

/** Parses "PASS - reason" / "FAIL: reason" style verdict lines. Anything
 *  else fails closed: an unparseable reply is a FAIL with a stable reason. */
export function parseConditionVerdict(reply: string): ConditionVerdict {
  const line = reply
    .split("\n")
    .map((part) => part.trim())
    .find((part) => /^(PASS|FAIL)\b/i.test(part));
  if (line === undefined) {
    return { verdict: "FAIL", reason: "verifier_reply_unparseable" };
  }
  const verdict = /^PASS\b/i.test(line) ? "PASS" : "FAIL";
  const reason = line.replace(/^(PASS|FAIL)\b\s*[-:—]?\s*/i, "").trim();
  return { verdict, reason: reason.length > 0 ? reason : "no_reason_given" };
}

/** Validates that a definition is a linear chain (v1): unique node ids,
 *  positive guards, reachable condition kinds. Throws with a stable reason
 *  code prefix so the editor can surface them verbatim. */
export function validateDefinition(definition: WorkflowDefinitionSnapshot): void {
  if (definition.version !== 1) throw new Error(`workflow_definition_version_unsupported: ${String(definition.version)}`);
  if (definition.nodes.length === 0) throw new Error("workflow_definition_empty");
  const seen = new Set<string>();
  for (const [index, node] of definition.nodes.entries()) {
    if (typeof node.id !== "string" || node.id.length === 0) throw new Error("workflow_node_id_missing");
    if (seen.has(node.id)) throw new Error(`workflow_node_id_duplicate: ${node.id}`);
    seen.add(node.id);
    if (typeof node.agentKind !== "string" || node.agentKind.length === 0) {
      throw new Error(`workflow_node_agent_missing: ${node.id}`);
    }
    if (typeof node.task !== "string" || node.task.trim().length === 0) {
      throw new Error(`workflow_node_task_missing: ${node.id}`);
    }
    if (!Number.isSafeInteger(node.turnBudget) || node.turnBudget < 1) {
      throw new Error(`workflow_node_turn_budget_invalid: ${node.id}`);
    }
    if (!Number.isSafeInteger(node.timeoutMs) || node.timeoutMs < 1_000) {
      throw new Error(`workflow_node_timeout_invalid: ${node.id}`);
    }
    const condition = node.condition;
    if (condition === undefined || condition === null || typeof condition !== "object") {
      throw new Error(`workflow_node_condition_missing: ${node.id}`);
    }
    if (condition.kind === "criteria_check" && (condition.criteriaText === undefined || condition.criteriaText.trim().length === 0)) {
      throw new Error(`workflow_node_criteria_text_missing: ${node.id}`);
    }
    if (!Number.isSafeInteger(condition.maxRetries) || condition.maxRetries < 0) {
      throw new Error(`workflow_node_retries_invalid: ${node.id}`);
    }
    if (index < definition.nodes.length - 1 && node.condition.kind === "manual_gate" && condition.maxRetries !== 0) {
      // manual_gate is a human decision: retries do not apply.
      throw new Error(`workflow_node_gate_retries_invalid: ${node.id}`);
    }
  }
}
