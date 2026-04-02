import type { DeploymentMode, PlannedNodePreview, ProvisionPlan, RuntimeMode } from "./types";

export type GraphBoardNodeStatus =
  | "queued"
  | "running"
  | "reused"
  | "attached"
  | "completed"
  | "failed"
  | "skipped";

export interface GraphBoardEvent {
  phase?: string;
  status?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface GraphBoardNodeState {
  key: string;
  spec_id: string;
  environment: string;
  layer_index: number;
  action: PlannedNodePreview["action"];
  status: GraphBoardNodeStatus;
  message: string;
  runUrl?: string;
  result?: Record<string, unknown>;
}

export interface GraphSubmitSummary {
  rootSpecId: string;
  additionalServices: number;
  totalNodes: number;
  reuseCount: number;
  attachCount: number;
  provisionCount: number;
}

const GRAPH_RUNTIMES = new Set<RuntimeMode>(["k8s_workspace", "k8s_discovery"]);

export function supportsGraphDeploymentMode(runtime: RuntimeMode): boolean {
  return GRAPH_RUNTIMES.has(runtime);
}

export function coerceDeploymentMode(runtime: RuntimeMode, requested: DeploymentMode): DeploymentMode {
  if (requested === "graph" && !supportsGraphDeploymentMode(runtime)) {
    return "single";
  }
  return requested;
}

export function normalizeRuntimeForGraphModeSelection(runtime: RuntimeMode): RuntimeMode {
  return runtime === "k8s_discovery" ? "k8s_discovery" : "k8s_workspace";
}

export function applySelectionToggle(
  selectedIds: Set<string>,
  specId: string,
  deploymentMode: DeploymentMode,
): Set<string> {
  if (deploymentMode === "graph") {
    return selectedIds.has(specId) ? new Set<string>() : new Set<string>([specId]);
  }

  const next = new Set(selectedIds);
  if (next.has(specId)) next.delete(specId);
  else next.add(specId);
  return next;
}

export function applyVisibleSelection(
  selectedIds: Set<string>,
  visibleIds: string[],
  deploymentMode: DeploymentMode,
): Set<string> {
  if (deploymentMode === "graph") {
    return selectedIds;
  }

  const next = new Set(selectedIds);
  for (const id of visibleIds) {
    next.add(id);
  }
  return next;
}

export function ensureSingleRootSelection(
  selectedIds: Set<string>,
  deploymentMode: DeploymentMode,
): Set<string> {
  if (deploymentMode !== "graph" || selectedIds.size <= 1) {
    return selectedIds;
  }

  const [first] = selectedIds;
  return new Set<string>(first ? [first] : []);
}

export function summarizeGraphSubmit(plan: ProvisionPlan): GraphSubmitSummary {
  const uniqueSpecs = new Set(plan.hard_closure_spec_ids);
  return {
    rootSpecId: plan.root_spec_id,
    additionalServices: Math.max(0, uniqueSpecs.size - 1),
    totalNodes: plan.summary.total_nodes,
    reuseCount: plan.summary.reuse_count,
    attachCount: plan.summary.attach_count,
    provisionCount: plan.summary.provision_count,
  };
}

export function buildInitialGraphBoardNodes(plan: ProvisionPlan): GraphBoardNodeState[] {
  return [...plan.nodes]
    .sort((a, b) => {
      if (a.layer_index !== b.layer_index) return a.layer_index - b.layer_index;
      if (a.spec_id !== b.spec_id) return a.spec_id.localeCompare(b.spec_id);
      return a.environment.localeCompare(b.environment);
    })
    .map((node) => ({
      key: node.key,
      spec_id: node.spec_id,
      environment: node.environment,
      layer_index: node.layer_index,
      action: node.action,
      status: node.action === "reuse" ? "reused" : node.action === "attach" ? "attached" : node.action === "blocked" ? "skipped" : "queued",
      message: node.action === "reuse"
        ? "Reused existing deployment"
        : node.action === "attach"
          ? "Attached existing deployment"
          : node.action === "blocked"
            ? "Skipped due to missing hard dependency"
            : "Queued",
    }));
}

export function resolveGraphEventNodeStatus(event: GraphBoardEvent): GraphBoardNodeStatus | null {
  const hinted = String(event.data?.node_status || "").trim();
  if (hinted === "reused") return "reused";
  if (hinted === "attached") return "attached";
  if (hinted === "running") return "running";
  if (hinted === "completed") return "completed";
  if (hinted === "failed" || hinted === "blocked") return "failed";

  if (event.status === "error") return "failed";
  if (event.status === "running") return "running";
  // Only mark the *node* as completed if the *entire* overarching process phase is "complete"
  if (event.phase === "complete" && event.status === "complete") return "completed";

  return null;
}

export function applyGraphEventToBoard(
  nodes: GraphBoardNodeState[],
  event: GraphBoardEvent,
): GraphBoardNodeState[] {
  const specId = String(event.data?.current_spec_id || "").trim();
  const layerIndex = Number(event.data?.layer_index ?? -1);
  const nextStatus = resolveGraphEventNodeStatus(event);

  if (!specId) {
    return nodes;
  }

  const candidateIndex = nodes.findIndex((node) => {
    if (node.spec_id !== specId) return false;
    if (layerIndex >= 0 && node.layer_index !== layerIndex) return false;

    // We want to allow message updates even if nextStatus is null, so just match the active node
    // for this specId if there's no state change, OR if the state change is valid.
    if (nextStatus) {
      if (nextStatus === "running") return node.status === "queued" || node.status === "running";
      if (nextStatus === "reused") return node.status === "queued" || node.status === "running";
      if (nextStatus === "attached") return node.status === "queued" || node.status === "running";
      if (nextStatus === "completed") return node.status === "queued" || node.status === "running";
    }

    // Fallback: match whichever node for this spec currently is active
    return node.status === "queued" || node.status === "running";
  });

  if (candidateIndex === -1) {
    return nodes;
  }

  const runUrl = typeof event.data?.run_url === "string" ? event.data.run_url : undefined;
  return nodes.map((node, index) => index === candidateIndex
    ? {
      ...node,
      status: nextStatus || node.status,
      message: event.message || node.message,
      runUrl: runUrl || node.runUrl,
      result: event.data || node.result,
    }
    : node);
}
