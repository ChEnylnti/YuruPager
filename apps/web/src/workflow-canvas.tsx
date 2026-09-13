import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  Background,
  Controls,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { Snapshot } from "@yurupager/shared";

import {
  cancelWorkflowRun,
  createWorkflow,
  deleteWorkflow,
  getWorkflowRuns,
  listWorkflows,
  runWorkflow,
  updateWorkflow,
  type WorkflowNodeInput,
  type WorkflowRunSummary,
  type WorkflowSummary,
} from "./api.js";
import { errorLabel, workflowText } from "./i18n.js";

const EFFORTS = ["minimal", "low", "medium", "high"] as const;

interface CanvasNodeData extends Record<string, unknown> {
  label: string;
  agentKind: string;
  model: string;
  reasoningEffort: string;
  task: string;
  handoffPrompt: string;
  conditionKind: string;
  criteriaText: string;
  maxRetries: number;
  backoffMs: number;
  turnBudget: number;
  timeoutMs: number;
  configured: boolean;
}

type CanvasNode = Node<CanvasNodeData>;

function emptyNodeData(agentKind = "codex"): CanvasNodeData {
  return {
    label: "",
    agentKind,
    model: "",
    reasoningEffort: "medium",
    task: "",
    handoffPrompt: "",
    conditionKind: "agent_confirm",
    criteriaText: "",
    maxRetries: 1,
    backoffMs: 5_000,
    turnBudget: 5,
    timeoutMs: 600_000,
    configured: false,
  };
}

function nodeToInput(node: CanvasNode): WorkflowNodeInput {
  const data = node.data;
  const input: WorkflowNodeInput = {
    id: node.id,
    agentKind: data.agentKind,
    task: data.task,
    condition: {
      kind: data.conditionKind,
      ...(data.conditionKind === "criteria_check" ? { criteriaText: data.criteriaText } : {}),
      maxRetries: data.conditionKind === "manual_gate" ? 0 : data.maxRetries,
      backoffMs: data.backoffMs,
    },
    turnBudget: data.turnBudget,
    timeoutMs: data.timeoutMs,
  };
  if (data.model.trim().length > 0) input.model = data.model.trim();
  if (data.handoffPrompt.trim().length > 0) input.handoffPrompt = data.handoffPrompt.trim();
  if (data.reasoningEffort !== "") input.reasoningEffort = data.reasoningEffort;
  return input;
}

/** Linear-chain validation: every node has exactly one predecessor (except
 *  the first) and the chain has no branches, loops, or orphans. */
function validateLinear(nodes: CanvasNode[], edges: Edge[]): string | null {
  if (nodes.length === 0) return workflowText.validationEmpty;
  const successors = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const node of nodes) {
    successors.set(node.id, []);
    indegree.set(node.id, 0);
  }
  for (const edge of edges) {
    if (!successors.has(edge.source) || !indegree.has(edge.target)) continue;
    successors.get(edge.source)?.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const roots = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0);
  if (roots.length !== 1) return workflowText.validationNotLinear;
  for (const node of nodes) {
    if ((successors.get(node.id)?.length ?? 0) > 1) return workflowText.validationBranch;
  }
  let visited = 0;
  const queue = [roots[0]?.id ?? ""];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) return workflowText.validationLoop;
    seen.add(current);
    visited += 1;
    for (const next of successors.get(current) ?? []) queue.push(next);
  }
  if (visited !== nodes.length) return workflowText.validationNotConnected;
  return null;
}

function snapshotToNodes(definition: WorkflowSummary["definition"]): CanvasNode[] {
  return definition.nodes.map((node, index) => ({
    id: node.id,
    position: { x: 60 + index * 280, y: 80 },
    data: {
      ...emptyNodeData(node.agentKind),
      label: `#${index + 1} ${node.agentKind}`,
      agentKind: node.agentKind,
      model: node.model ?? "",
      reasoningEffort: node.reasoningEffort ?? "medium",
      task: node.task,
      handoffPrompt: node.handoffPrompt ?? "",
      conditionKind: node.condition.kind,
      criteriaText: node.condition.criteriaText ?? "",
      maxRetries: node.condition.maxRetries,
      backoffMs: node.condition.backoffMs,
      turnBudget: node.turnBudget,
      timeoutMs: node.timeoutMs,
      configured: true,
    },
  }));
}

function snapshotToEdges(definition: { nodes: Array<{ id: string }> }): Edge[] {
  return definition.nodes.slice(0, -1).map((node, index) => ({
    id: `e-${node.id}-${definition.nodes[index + 1]?.id}`,
    source: node.id,
    target: definition.nodes[index + 1]?.id ?? "",
  }));
}

export interface WorkflowCanvasProps {
  snapshot: Snapshot;
  onToast(message: string, tone?: "success" | "error"): void;
}

export function WorkflowCanvas(props: WorkflowCanvasProps): React.JSX.Element {
  const { onToast } = props;
  const workstations = props.snapshot.workstations;
  const [workstationId, setWorkstationId] = useState(workstations[0]?.id ?? "");
  const workspaceId = workstations.find((workstation) => workstation.id === workstationId)?.workspaceId ?? "";
  const [items, setItems] = useState<WorkflowSummary[]>([]);
  const [selected, setSelected] = useState<WorkflowSummary | null>(null);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [activeRun, setActiveRun] = useState<WorkflowRunSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadedFor = useRef<string | null>(null);

  const [nodes, setNodes, onNodesChangeBase] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<Edge>([]);

  const onNodesChange = useCallback((changes: NodeChange<Node>[]) => {
    onNodesChangeBase(changes as never);
  }, [onNodesChangeBase]);

  const onEdgesChange = useCallback((changes: import("@xyflow/react").EdgeChange<Edge>[]) => {
    onEdgesChangeBase(changes as never);
  }, [onEdgesChangeBase]);

  const loadList = useCallback(async () => {
    if (workstationId === "") return;
    try {
      const all = await listWorkflows(workspaceId);
      setItems(all.filter((workflow) => workflow.workstationId === workstationId));
      setLoadError(null);
    } catch (reason) {
      setLoadError(errorLabel(reason, workflowText.listFailed));
    }
  }, [workspaceId, workstationId]);

  useEffect(() => {
    if (loadedFor.current === workstationId) return;
    loadedFor.current = workstationId;
    void loadList();
  }, [loadList, workstationId]);

  const openWorkflow = useCallback(async (workflow: WorkflowSummary) => {
    setSelected(workflow);
    setName(workflow.name);
    setGoal(workflow.goal);
    setNodes(snapshotToNodes(workflow.definition));
    setEdges(snapshotToEdges(workflow.definition));
    try {
      setRuns(await getWorkflowRuns(workspaceId, workflow.id));
    } catch {
      setRuns([]);
    }
  }, [workspaceId]);

  const handleNew = useCallback(() => {
    setSelected(null);
    setName("");
    setGoal("");
    setNodes([]);
    setEdges([]);
    setRuns([]);
    setActiveRun(null);
  }, []);

  const handleAddNode = useCallback(() => {
    const id = `node-${Date.now().toString(36)}`;
    const newNode: CanvasNode = {
      id,
      position: { x: 60 + nodes.length * 280, y: 80 },
      data: { ...emptyNodeData(), label: `#${nodes.length + 1}` },
    };
    setNodes((current) => [...current, newNode]);
    // v1 is a linear chain: a new node automatically chains to the current tail.
    const tail = nodes.at(-1);
    if (tail !== undefined) {
      setEdges((current) => [...current, { id: `e-${tail.id}-${id}`, source: tail.id, target: id }]);
    }
  }, [nodes, setEdges, setNodes]);

  const handleConnect = useCallback((connection: Connection) => {
    setEdges((current) => addEdge({ ...connection, animated: false }, current));
  }, [setEdges]);

  const updateNodeData = useCallback((nodeId: string, patch: Partial<CanvasNodeData>) => {
    setNodes((current) => current.map((node) => (
      node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node
    )));
  }, [setNodes]);

  const handleDelete = useCallback(async () => {
    if (selected === null) return;
    try {
      await deleteWorkflow(workspaceId, selected.id);
      onToast(workflowText.deletedToast, "success");
      setSelected(null);
      handleNew();
      void loadList();
    } catch (reason) {
      onToast(errorLabel(reason, workflowText.deleteFailed), "error");
    }
  }, [handleNew, loadList, selected, workspaceId]);

  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSave = useCallback(() => {
    if (autoSaveTimer.current !== null) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      void (async () => {
        const nodeInputs = nodes.map(nodeToInput);
        if (name.trim().length === 0 || goal.trim().length === 0 || nodeInputs.length === 0) return;
        const input = { name: name.trim(), goal: goal.trim(), workstationId, nodes: nodeInputs };
        try {
          if (selected === null) {
            const created = await createWorkflow(workspaceId, input);
            setSelected(created);
            void loadList();
          } else {
            const updated = await updateWorkflow(workspaceId, selected.id, input);
            setSelected(updated);
            void loadList();
          }
        } catch {
          // auto-save failures are silent; the explicit save/run surfaces errors
        }
      })();
    }, 800);
  }, [goal, loadList, name, nodes, selected, workspaceId, workstationId]);

  useEffect(() => {
    if (nodes.length === 0 && name.length === 0) return;
    autoSave();
    return () => {
      if (autoSaveTimer.current !== null) clearTimeout(autoSaveTimer.current);
    };
  }, [autoSave, goal, nodes, name]);

  const validate = useCallback((): string | null => {
    const linearError = validateLinear(nodes, edges);
    if (linearError !== null) return linearError;
    for (const node of nodes) {
      const data = node.data;
      if (data.task.trim().length === 0) return workflowText.validationTaskMissing;
      if (data.conditionKind === "criteria_check" && data.criteriaText.trim().length === 0) {
        return workflowText.validationCriteriaMissing;
      }
      if (data.agentKind.trim().length === 0) return workflowText.validationAgentMissing;
    }
    return null;
  }, [edges, nodes]);

  const handleSave = useCallback(async () => {
    const validationError = validate();
    if (validationError !== null) {
      onToast(validationError, "error");
      return;
    }
    const input = {
      name: name.trim() || workflowText.untitledName,
      goal: goal.trim(),
      workstationId,
      nodes: nodes.map(nodeToInput),
    };
    try {
      if (selected === null) {
        const created = await createWorkflow(workspaceId, input);
        setSelected(created);
      } else {
        await updateWorkflow(workspaceId, selected.id, input);
      }
      onToast(workflowText.savedToast, "success");
      void loadList();
    } catch (reason) {
      onToast(errorLabel(reason, workflowText.saveFailed), "error");
    }
  }, [goal, loadList, name, nodes, selected, validate, workstationId, workspaceId]);

  const handleRun = useCallback(async () => {
    const validationError = validate();
    if (validationError !== null) {
      onToast(validationError, "error");
      return;
    }
    if (selected === null) {
      onToast(workflowText.saveBeforeRun, "error");
      return;
    }
    try {
      const run = await runWorkflow(selected.id, workspaceId);
      setActiveRun(run);
      onToast(workflowText.runStartedToast, "success");
      setRuns(await getWorkflowRuns(workspaceId, selected.id));
    } catch (reason) {
      onToast(errorLabel(reason, workflowText.runFailed), "error");
    }
  }, [selected, workspaceId, validate]);

  const handleCancel = useCallback(async () => {
    if (activeRun === null) return;
    try {
      const cancelled = await cancelWorkflowRun(workspaceId, activeRun.id);
      setActiveRun(cancelled);
      onToast(workflowText.cancelledToast, "success");
    } catch (reason) {
      onToast(errorLabel(reason, workflowText.cancelFailed), "error");
    }
  }, [activeRun, props.snapshot.scopeWorkspaceId]);

  const refreshRuns = useCallback(async () => {
    if (selected === null) return;
    try {
      const updated = await getWorkflowRuns(workspaceId, selected.id);
      setRuns(updated);
      const latest = updated[0] ?? null;
      if (latest !== null && (latest.status === "running" || latest.status === "pending")) setActiveRun(latest);
      else if (latest !== null) setActiveRun(null);
    } catch {
      // transient
    }
  }, [selected, workspaceId]);

  useEffect(() => {
    if (selected === null) return;
    const timer = setInterval(() => void refreshRuns(), 4_000);
    return () => clearInterval(timer);
  }, [refreshRuns, selected]);

  const agentKinds = useMemo(() => {
    const kinds = new Set<string>();
    for (const workstation of workstations) {
      for (const session of props.snapshot.sessions) {
        if (session.workstationId === workstation.id && session.agent !== undefined) kinds.add(session.agent);
      }
    }
    kinds.add("codex");
    return [...kinds].sort();
  }, [props.snapshot.sessions, workstations]);

  return React.createElement(ReactFlowProvider, null,
    React.createElement("div", { className: "workflow-view" },
      React.createElement("header", { className: "workflow-toolbar" },
        React.createElement("div", null,
          React.createElement("p", { className: "eyebrow" }, workflowText.eyebrow),
          React.createElement("h1", null, workflowText.heading)),
        React.createElement("select", {
          value: workstationId,
          onChange: (event: { target: { value: string } }) => setWorkstationId(event.target.value),
          "aria-label": workflowText.workstationSelectAria,
        }, workstations.map((workstation) =>
          React.createElement("option", { key: workstation.id, value: workstation.id }, workstation.name))),
        React.createElement("button", { className: "secondary-button", type: "button", onClick: handleNew }, workflowText.newAction),
        React.createElement("button", { className: "secondary-button", type: "button", onClick: handleAddNode, disabled: selected !== null && nodes.length === 0 }, workflowText.addNodeAction),
        React.createElement("button", { className: "secondary-button", type: "button", onClick: handleSave }, workflowText.saveAction),
        React.createElement("button", { className: "primary-button", type: "button", onClick: handleRun, disabled: selected === null }, workflowText.runAction),
        selected !== null && React.createElement("button", { className: "danger-button", type: "button", onClick: handleDelete }, workflowText.deleteAction),
      ),
      loadError !== null && React.createElement("div", { className: "workflow-error", role: "alert" }, loadError),
      items.length > 0 && React.createElement("label", { className: "workflow-open-picker" },
        workflowText.openLabel,
        React.createElement("select", {
          value: selected?.id ?? "",
          onChange: (event: { target: { value: string } }) => {
            const workflow = items.find((item) => item.id === event.target.value);
            if (workflow !== undefined) void openWorkflow(workflow);
          },
        },
          React.createElement("option", { value: "" }, workflowText.openPlaceholder),
          items.map((item) => React.createElement("option", { key: item.id, value: item.id }, item.name)))),
      React.createElement("div", { className: "workflow-meta" },
        React.createElement("label", null, workflowText.nameLabel,
          React.createElement("input", { value: name, onChange: (event: { target: { value: string } }) => setName(event.target.value), placeholder: workflowText.namePlaceholder })),
        React.createElement("label", null, workflowText.goalLabel,
          React.createElement("input", { value: goal, onChange: (event: { target: { value: string } }) => setGoal(event.target.value), placeholder: workflowText.goalPlaceholder }))),
      React.createElement("div", { className: "workflow-body" },
        React.createElement("div", { className: "workflow-canvas" },
          React.createElement(ReactFlow, {
            nodes, edges, onNodesChange, onEdgesChange, onConnect: handleConnect,
            fitView: true, proOptions: { hideAttribution: true },
          }, React.createElement(Background, null), React.createElement(Controls, null)),
          nodes.map((node, index) => React.createElement(NodePanel, {
            key: node.id, node, index, agentKinds,
            onChange: (patch) => updateNodeData(node.id, patch),
          }))),
        runs.length > 0 && React.createElement("section", { className: "workflow-runs", "aria-label": workflowText.runsAria },
          React.createElement("h3", null, workflowText.runsHeading),
          runs.map((run) => React.createElement(RunLine, {
            key: run.id, run,
            ...(run.status === "running" || run.status === "pending"
              ? { onCancel: () => { setActiveRun(run); void handleCancel(); } }
              : {}),
          }))),
      ),
    ),
  );
}

function NodePanel(props: {
  node: CanvasNode;
  index: number;
  agentKinds: string[];
  onChange(patch: Partial<CanvasNodeData>): void;
}): React.JSX.Element {
  const { node, index, onChange } = props;
  const data = node.data;
  return React.createElement("fieldset", { className: "workflow-node-panel", style: { left: `${16 + index * 286}px`, right: "auto" } },
    React.createElement("legend", null, `#${index + 1}`),
    React.createElement("label", null, workflowText.agentLabel,
      React.createElement("select", {
        value: data.agentKind,
        onChange: (event: { target: { value: string } }) => onChange({ agentKind: event.target.value }),
      }, props.agentKinds.map((kind) => React.createElement("option", { key: kind, value: kind }, kind)))),
    React.createElement("label", null, workflowText.modelLabel,
      React.createElement("input", {
        value: data.model,
        onChange: (event: { target: { value: string } }) => onChange({ model: event.target.value }),
        placeholder: workflowText.modelDefaultPlaceholder,
      })),
    React.createElement("label", null, workflowText.effortLabel,
      React.createElement("select", {
        value: data.reasoningEffort,
        onChange: (event: { target: { value: string } }) => onChange({ reasoningEffort: event.target.value }),
      }, EFFORTS.map((effort) => React.createElement("option", { key: effort, value: effort }, effort)))),
    React.createElement("label", null, workflowText.taskLabel,
      React.createElement("textarea", {
        value: data.task, rows: 2,
        onChange: (event: { target: { value: string } }) => onChange({ task: event.target.value }),
        placeholder: workflowText.taskPlaceholder,
      })),
    React.createElement("label", null, workflowText.conditionLabel,
      React.createElement("select", {
        value: data.conditionKind,
        onChange: (event: { target: { value: string } }) => onChange({ conditionKind: event.target.value }),
      },
        React.createElement("option", { value: "agent_confirm" }, workflowText.conditionAgentConfirm),
        React.createElement("option", { value: "criteria_check" }, workflowText.conditionCriteriaCheck),
        React.createElement("option", { value: "manual_gate" }, workflowText.conditionManualGate))),
    data.conditionKind === "criteria_check" && React.createElement("label", null, workflowText.criteriaLabel,
      React.createElement("textarea", {
        value: data.criteriaText, rows: 2,
        onChange: (event: { target: { value: string } }) => onChange({ criteriaText: event.target.value }),
      })),
    React.createElement("label", null, workflowText.handoffLabel,
      React.createElement("textarea", {
        value: data.handoffPrompt, rows: 2,
        onChange: (event: { target: { value: string } }) => onChange({ handoffPrompt: event.target.value }),
        placeholder: workflowText.handoffPlaceholder,
      })),
  );
}

function RunLine(props: { run: WorkflowRunSummary; onCancel?: (() => void) | undefined }): React.JSX.Element {
  return React.createElement("div", { className: `workflow-run-line run-${props.run.status}` },
    React.createElement("div", null,
      React.createElement("strong", null, props.run.id.slice(0, 8)),
      React.createElement("span", { className: "run-status-badge" }, props.run.status)),
    props.run.nodes !== undefined && React.createElement("div", { className: "run-nodes" },
      (props.run.nodes ?? []).map((node) => React.createElement("span", { key: node.nodeId, className: `run-node-badge node-${node.status}` }, `${node.nodeId.slice(0, 8)}:${node.status}`))),
    props.onCancel !== undefined && React.createElement("button", { className: "secondary-button", type: "button", onClick: props.onCancel }, workflowText.cancel),
  );
}
