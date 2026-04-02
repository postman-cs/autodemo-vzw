/**
 * Provision Progress Normalization Module
 *
 * Provides a unified RunUnit model for provisioning execution progress,
 * with adapter functions for SSE-based and Graph-based progress events.
 *
 * Normalization Rules:
 * - SSE "success" -> "completed"
 * - SSE "error" -> "failed"
 * - Graph statuses preserved as-is
 * - Graph "skipped" is terminal and immutable
 * - runUrl, result, and error details are preserved through normalization
 */

// ============================================================================
// Source Types (from SSE and Graph APIs)
// ============================================================================

/** SSE provision status values as received from the worker */
export type SseProvisionStatus = "queued" | "running" | "success" | "error";

/** SSE provision item from /api/provision event stream */
export interface SseProvisionItem {
  spec_id: string;
  status: SseProvisionStatus;
  phase: string;
  message: string;
  runUrl?: string;
  result?: Record<string, unknown>;
  error?: string;
}

/** Graph node status values from Workflow step states */
export type GraphNodeStatus =
  | "queued"
  | "running"
  | "reused"
  | "attached"
  | "completed"
  | "failed"
  | "skipped";

/** Graph board node from /api/provision/graph/:id polling */
export interface GraphBoardNode {
  key: string;
  spec_id: string;
  environment: string;
  layer_index: number;
  status: GraphNodeStatus;
  message: string;
  runUrl?: string;
  result?: Record<string, unknown>;
}

// ============================================================================
// Normalized Types (unified contract)
// ============================================================================

/** Unified run unit status covering both SSE and Graph states */
export type RunUnitStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "reused"
  | "attached"
  | "skipped";

/** Normalized run unit - the unified contract for progress display */
export interface RunUnit {
  id: string;
  displayName: string;
  environment?: string;
  layerIndex?: number;
  status: RunUnitStatus;
  message: string;
  contextLabel?: string;
  cssClass: string;
  runUrl?: string;
  result?: Record<string, unknown>;
  error?: string;
  isTerminal: boolean;
}

/** Overall provision execution state composed of run units */
export interface ProvisionExecutionState {
  units: RunUnit[];
  isComplete: boolean;
  hasFailures: boolean;
  hasSkipped: boolean;
}

// ============================================================================
// Terminal Status Logic
// ============================================================================

const TERMINAL_STATUSES: readonly RunUnitStatus[] = [
  "completed",
  "failed",
  "reused",
  "attached",
  "skipped",
];

/**
 * Check if a status is terminal (no further transitions allowed)
 */
export function isTerminalStatus(status: RunUnitStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// ============================================================================
// CSS Class Resolution
// ============================================================================

/**
 * Resolve CSS class for a run unit status.
 * Follows the existing convention from ProvisionPage.tsx.
 *
 * Note: "completed" maps to "status-provision-success" and
 * "failed" maps to "status-provision-error" for backward compatibility.
 */
export function resolveRunUnitCssClass(status: RunUnitStatus): string {
  const classMap: Record<RunUnitStatus, string> = {
    queued: "status-provision-queued",
    running: "status-provision-running",
    completed: "status-provision-success",
    failed: "status-provision-error",
    reused: "status-provision-reused",
    attached: "status-provision-attached",
    skipped: "status-provision-skipped",
  };

  return classMap[status] ?? `status-provision-${status}`;
}

// ============================================================================
// SSE Adapter
// ============================================================================

/**
 * Map SSE provision item to normalized RunUnit.
 *
 * Normalization:
 * - "success" -> "completed"
 * - "error" -> "failed"
 * - "queued" -> "queued"
 * - "running" -> "running"
 */
export function mapSseItemToRunUnit(item: SseProvisionItem, phaseLabel?: string): RunUnit {
  const normalizedStatus = normalizeSseStatus(item.status);

  return {
    id: item.spec_id,
    displayName: item.spec_id,
    status: normalizedStatus,
    message: item.message,
    contextLabel: phaseLabel,
    cssClass: resolveRunUnitCssClass(normalizedStatus),
    runUrl: item.runUrl,
    result: item.result,
    error: item.error,
    isTerminal: isTerminalStatus(normalizedStatus),
  };
}

/**
 * Normalize SSE status to RunUnitStatus.
 * - "success" -> "completed"
 * - "error" -> "failed"
 */
function normalizeSseStatus(status: SseProvisionStatus): RunUnitStatus {
  switch (status) {
    case "success":
      return "completed";
    case "error":
      return "failed";
    default:
      return status;
  }
}

// ============================================================================
// Graph Adapter
// ============================================================================

/**
 * Map Graph board node to normalized RunUnit.
 *
 * Graph statuses are preserved as-is since they already match RunUnitStatus.
 * Skipped nodes are marked as terminal and immutable.
 */
export function mapGraphNodeToRunUnit(node: GraphBoardNode): RunUnit {
  const normalizedStatus = normalizeGraphStatus(node.status);

  return {
    id: node.key,
    displayName: node.spec_id,
    environment: node.environment,
    layerIndex: node.layer_index,
    status: normalizedStatus,
    message: node.message,
    contextLabel: node.layer_index >= 0 ? `Layer ${node.layer_index}` : undefined,
    cssClass: resolveRunUnitCssClass(normalizedStatus),
    runUrl: node.runUrl,
    result: node.result,
    error: extractErrorFromNode(node),
    isTerminal: isTerminalStatus(normalizedStatus),
  };
}

/**
 * Normalize Graph node status to RunUnitStatus.
 * All graph statuses directly map to RunUnitStatus.
 */
function normalizeGraphStatus(status: GraphNodeStatus): RunUnitStatus {
  // Graph statuses already match RunUnitStatus exactly
  return status;
}

/**
 * Extract error details from graph node.
 * Graph nodes don't always have a separate error field;
 * the error is often embedded in the message for failed states.
 */
function extractErrorFromNode(node: GraphBoardNode): string | undefined {
  if (node.status === "failed") {
    return node.message;
  }
  return undefined;
}

// ============================================================================
// Display Helpers
// ============================================================================

/**
 * Get a human-readable display label for a run unit status.
 */
export function getRunUnitDisplayLabel(status: RunUnitStatus): string {
  const labelMap: Record<RunUnitStatus, string> = {
    queued: "Queued",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    reused: "Reused",
    attached: "Attached",
    skipped: "Skipped",
  };

  return labelMap[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

// ============================================================================
// State Aggregation
// ============================================================================

/**
 * Build provision execution state from an array of run units.
 */
export function buildExecutionState(units: RunUnit[]): ProvisionExecutionState {
  return {
    units,
    isComplete: units.every((u) => u.isTerminal),
    hasFailures: units.some((u) => u.status === "failed"),
    hasSkipped: units.some((u) => u.status === "skipped"),
  };
}

/**
 * Aggregate SSE items into execution state.
 */
export function aggregateSseItems(items: SseProvisionItem[]): ProvisionExecutionState {
  return buildExecutionState(items.map(item => mapSseItemToRunUnit(item)));
}

/**
 * Aggregate Graph nodes into execution state.
 */
export function aggregateGraphNodes(nodes: GraphBoardNode[]): ProvisionExecutionState {
  return buildExecutionState(nodes.map(mapGraphNodeToRunUnit));
}
