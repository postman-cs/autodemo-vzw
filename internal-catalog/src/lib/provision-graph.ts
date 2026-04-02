import type { DependencyPlan, PlannedNode } from "./dependency-planner";
import type { SSEEvent } from "./sse";

export interface GraphNodeState {
  status: string;
  reason?: string;
}

export interface GraphNodeExecutionResult {
  ok: boolean;
  reused?: boolean;
  attached?: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

export interface GraphNodeSummary {
  key: string;
  spec_id: string;
  environment: string;
  layer_index: number;
  reason?: string;
}

export interface GraphFailedNodeSummary extends GraphNodeSummary {
  message: string;
}

export interface GraphExecutionResult {
  success: boolean;
  deployment_group_id: string;
  deployment_root_spec_id: string;
  total_nodes: number;
  reused_nodes: GraphNodeSummary[];
  attached_nodes: GraphNodeSummary[];
  completed_nodes: GraphNodeSummary[];
  failed_node?: GraphFailedNodeSummary;
  failed_layer_index?: number;
  not_started_nodes: GraphNodeSummary[];
}

export interface ExecuteGraphPlanOptions {
  plan: DependencyPlan;
  deploymentGroupId: string;
  deploymentRootSpecId: string;
  maxConcurrencyPerLayer?: number;
  recheckNodeState?: (node: PlannedNode) => Promise<GraphNodeState | null>;
  runProvisionNode: (node: PlannedNode) => Promise<GraphNodeExecutionResult>;
  onEvent?: (event: SSEEvent) => void;
}

function nodeSort(a: PlannedNode, b: PlannedNode): number {
  if (a.spec_id !== b.spec_id) return a.spec_id.localeCompare(b.spec_id);
  return a.environment.localeCompare(b.environment);
}

function groupLayerNodesBySpec(layerNodes: PlannedNode[]): PlannedNode[][] {
  const grouped: PlannedNode[][] = [];
  for (const currentNode of layerNodes) {
    const previousGroup = grouped[grouped.length - 1];
    if (previousGroup && previousGroup[0]?.spec_id === currentNode.spec_id) {
      previousGroup.push(currentNode);
      continue;
    }
    grouped.push([currentNode]);
  }
  return grouped;
}

function toNodeSummary(node: PlannedNode, reason?: string): GraphNodeSummary {
  return {
    key: node.key,
    spec_id: node.spec_id,
    environment: node.environment,
    layer_index: node.layer_index,
    reason,
  };
}

function emit(
  options: ExecuteGraphPlanOptions,
  node: PlannedNode | null,
  status: SSEEvent["status"],
  message: string,
  phase = "graph",
  extraData: Record<string, unknown> = {},
): void {
  if (!options.onEvent) return;
  options.onEvent({
    phase,
    status,
    message,
    data: {
      deployment_group_id: options.deploymentGroupId,
      deployment_root_spec_id: options.deploymentRootSpecId,
      current_spec_id: node?.spec_id || "",
      layer_index: node?.layer_index ?? -1,
      ...extraData,
    },
  });
}

function isNodeAlreadyComplete(state: GraphNodeState | null): boolean {
  if (!state) return false;
  const normalized = String(state.status || "").trim().toLowerCase();
  return normalized === "active" || normalized === "completed" || normalized === "reused" || normalized === "attached";
}

export async function executeGraphPlan(options: ExecuteGraphPlanOptions): Promise<GraphExecutionResult> {
  const maxConcurrencyPerLayer = Math.max(1, Math.min(5, options.maxConcurrencyPerLayer || 5));
  const reusedNodes: GraphNodeSummary[] = [];
  const attachedNodes: GraphNodeSummary[] = [];
  const completedNodes: GraphNodeSummary[] = [];
  const started = new Set<string>();
  const allNodes = [...options.plan.nodes].sort((a, b) => {
    if (a.layer_index !== b.layer_index) return a.layer_index - b.layer_index;
    return nodeSort(a, b);
  });
  let failedNode: GraphFailedNodeSummary | undefined;
  let failedLayerIndex: number | undefined;
  let failed = false;

  emit(
    options,
    null,
    "running",
    `Starting graph deployment (${allNodes.length} node${allNodes.length === 1 ? "" : "s"})`,
    "graph",
    { node_count: allNodes.length },
  );

  const uniqueLayerIndexes = Array.from(new Set(options.plan.layers.map((layer) => layer.layer_index))).sort((a, b) => a - b);
  const graphStartTime = Date.now();
  let completedNodeCount = 0;
  let timeoutWarningEmitted = false;

  for (const layerIndex of uniqueLayerIndexes) {
    if (failed) break;
    const layerNodes = allNodes
      .filter((node) => node.layer_index === layerIndex)
      .sort(nodeSort);
    if (layerNodes.length === 0) continue;
    const layerNodeGroups = groupLayerNodesBySpec(layerNodes);

    // Estimate remaining time; emit warning if >10 minutes
    if (!timeoutWarningEmitted && completedNodeCount > 0) {
      const elapsedMs = Date.now() - graphStartTime;
      const avgNodeMs = elapsedMs / completedNodeCount;
      const remainingNodes = allNodes.length - completedNodeCount;
      const estimatedRemainingMs = remainingNodes * avgNodeMs;
      if (estimatedRemainingMs > 10 * 60 * 1000) {
        timeoutWarningEmitted = true;
        emit(options, null, "running", "Stream timeout warning: estimated remaining time exceeds 10 minutes. Use poll_url to track progress if disconnected.", "stream_timeout_warning", {
          estimated_remaining_ms: Math.round(estimatedRemainingMs),
          remaining_nodes: remainingNodes,
          avg_node_ms: Math.round(avgNodeMs),
          poll_url: `/api/deployments/${options.deploymentRootSpecId}`,
        });
      }
    }

    emit(options, null, "running", `Executing graph layer ${layerIndex}`, "graph-layer", {
      layer_index: layerIndex,
      layer_size: layerNodes.length,
      service_group_count: layerNodeGroups.length,
      max_concurrency: maxConcurrencyPerLayer,
    });

    let cursor = 0;
    const executeNode = async (currentNode: PlannedNode): Promise<void> => {
      started.add(currentNode.key);

      if (currentNode.action === "reuse") {
        reusedNodes.push(toNodeSummary(currentNode, "planner_reuse"));
        emit(options, currentNode, "complete", `Reused existing deployment for ${currentNode.spec_id}/${currentNode.environment}`, "graph-node", {
          node_status: "reused",
        });
        completedNodeCount++;
        return;
      }

      if (currentNode.action === "attach") {
        attachedNodes.push(toNodeSummary(currentNode, "planner_attach"));
        emit(options, currentNode, "complete", `Attached existing deployment for ${currentNode.spec_id}/${currentNode.environment}`, "graph-node", {
          node_status: "attached",
        });
        completedNodeCount++;
        return;
      }

      if (currentNode.action === "blocked") {
        failed = true;
        failedLayerIndex = layerIndex;
        const message = currentNode.blocked_reason
          ? `Blocked node ${currentNode.spec_id}/${currentNode.environment}: ${currentNode.blocked_reason}`
          : `Blocked node ${currentNode.spec_id}/${currentNode.environment}`;
        failedNode = {
          ...toNodeSummary(currentNode, currentNode.blocked_reason || "blocked"),
          message,
        };
        emit(options, currentNode, "error", message, "graph-node", {
          node_status: "blocked",
          blocked_reason: currentNode.blocked_reason || "",
        });
        return;
      }

      if (options.recheckNodeState) {
        const persistedState = await options.recheckNodeState(currentNode);
        if (isNodeAlreadyComplete(persistedState)) {
          const reason = persistedState?.reason || persistedState?.status || "recheck_complete";
          const normalizedStatus = String(persistedState?.status || "").trim().toLowerCase();
          if (normalizedStatus === "attached") {
            attachedNodes.push(toNodeSummary(currentNode, reason));
          } else {
            reusedNodes.push(toNodeSummary(currentNode, reason));
          }
          emit(options, currentNode, "complete", `Skipped ${currentNode.spec_id}/${currentNode.environment}; already complete`, "graph-node", {
            node_status: normalizedStatus === "attached" ? "attached" : "reused",
            reuse_reason: reason,
          });
          completedNodeCount++;
          return;
        }
      }

      emit(options, currentNode, "running", `Provisioning ${currentNode.spec_id}/${currentNode.environment}`, "graph-node", {
        node_status: "running",
      });

      const result = await options.runProvisionNode(currentNode);
      if (!result.ok) {
        failed = true;
        failedLayerIndex = layerIndex;
        const message = result.message || `Provisioning failed for ${currentNode.spec_id}/${currentNode.environment}`;
        failedNode = {
          ...toNodeSummary(currentNode, "provision_failed"),
          message,
        };
        emit(options, currentNode, "error", message, "graph-node", {
          node_status: "failed",
          ...result.data,
        });
        return;
      }

      if (result.attached) {
        attachedNodes.push(toNodeSummary(currentNode, "became_attachable_during_provisioning"));
        emit(options, currentNode, "complete", `Attached ${currentNode.spec_id}/${currentNode.environment} to the graph`, "graph-node", {
          node_status: "attached",
          ...result.data,
        });
      } else if (result.reused) {
        reusedNodes.push(toNodeSummary(currentNode, "became_active_during_provisioning"));
        emit(options, currentNode, "complete", `Reused ${currentNode.spec_id}/${currentNode.environment} (became active during provisioning)`, "graph-node", {
          node_status: "reused",
          ...result.data,
        });
      } else {
        completedNodes.push(toNodeSummary(currentNode));
        emit(options, currentNode, "complete", `Provisioned ${currentNode.spec_id}/${currentNode.environment}`, "graph-node", {
          node_status: "completed",
          ...result.data,
        });
      }
      completedNodeCount++;
    };

    const runNodeGroup = async (): Promise<void> => {
      while (true) {
        if (failed) return;
        const index = cursor;
        cursor += 1;
        if (index >= layerNodeGroups.length) return;

        for (const currentNode of layerNodeGroups[index]) {
          if (failed) return;
          await executeNode(currentNode);
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(maxConcurrencyPerLayer, layerNodeGroups.length) },
      () => runNodeGroup(),
    );
    await Promise.all(workers);
  }

  const notStartedNodes = failed
    ? allNodes
      .filter((node) => !started.has(node.key))
      .map((node) => toNodeSummary(node, "not_started"))
    : [];

  if (failed) {
    emit(
      options,
      null,
      "error",
      `Graph deployment failed at layer ${failedLayerIndex ?? -1}`,
      "graph",
      {
        failed_layer_index: failedLayerIndex ?? -1,
        failed_node_key: failedNode?.key || "",
        not_started_count: notStartedNodes.length,
      },
    );
    return {
      success: false,
      deployment_group_id: options.deploymentGroupId,
      deployment_root_spec_id: options.deploymentRootSpecId,
      total_nodes: allNodes.length,
      reused_nodes: reusedNodes,
      attached_nodes: attachedNodes,
      completed_nodes: completedNodes,
      failed_node: failedNode,
      failed_layer_index: failedLayerIndex,
      not_started_nodes: notStartedNodes,
    };
  }

  emit(
    options,
    null,
    "complete",
    "Graph deployment complete",
    "graph",
    {
      completed_count: completedNodes.length,
      attached_count: attachedNodes.length,
      reused_count: reusedNodes.length,
    },
  );

  return {
    success: true,
    deployment_group_id: options.deploymentGroupId,
    deployment_root_spec_id: options.deploymentRootSpecId,
    total_nodes: allNodes.length,
    reused_nodes: reusedNodes,
    attached_nodes: attachedNodes,
    completed_nodes: completedNodes,
    not_started_nodes: [],
  };
}
