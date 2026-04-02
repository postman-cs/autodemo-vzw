import type { DeploymentRecord } from "./airtable";
import { normalizeRuntimeMode, type RuntimeMode } from "./config";
import { parseEnvironmentDeploymentsJson } from "./environment-deployments";

export type DeploymentMode = "single" | "graph";

export interface DependencyNode {
  dependsOn: string[];
  consumesApis: string[];
}

export type DependencyMap = Record<string, DependencyNode>;

export type NodeAction = "reuse" | "attach" | "provision" | "blocked";
export type NodeBlockedReason = "incompatible_runtime" | "invalid_state";

export interface PlannedNode {
  key: string;
  spec_id: string;
  environment: string;
  runtime: RuntimeMode;
  layer_index: number;
  action: NodeAction;
  blocked_reason?: NodeBlockedReason;
  hard_dependencies: string[];
  soft_neighbors: string[];
}

export interface PlannedLayer {
  layer_index: number;
  spec_ids: string[];
}

export interface SingleModeMissingPrerequisite {
  spec_id: string;
  environment: string;
  reason: "missing_active_deployment" | "blocked_incompatible_runtime" | "blocked_invalid_state";
}

export interface SingleModeGuidance {
  recommend_graph_mode: boolean;
  missing_hard_prerequisites: SingleModeMissingPrerequisite[];
}

export interface DependencyPlan {
  deployment_mode: DeploymentMode;
  root_spec_id: string;
  runtime: RuntimeMode;
  environments: string[];
  hard_closure_spec_ids: string[];
  soft_neighbor_spec_ids: string[];
  layers: PlannedLayer[];
  nodes: PlannedNode[];
  summary: {
    total_nodes: number;
    reuse_count: number;
    attach_count: number;
    provision_count: number;
    blocked_count: number;
  };
  single_mode_guidance?: SingleModeGuidance;
}

interface CreateDependencyPlanInput {
  rootSpecId: string;
  runtime: RuntimeMode;
  environments: string[];
  deploymentMode: DeploymentMode;
  dependencies: DependencyMap;
  deployments: DeploymentRecord[];
}

interface NodeClassification {
  action: NodeAction;
  blockedReason?: NodeBlockedReason;
}

const GRAPH_SUPPORTED_RUNTIMES = new Set<RuntimeMode>(["k8s_workspace", "k8s_discovery"]);

function graphRuntimeFamily(runtime: RuntimeMode): string {
  return GRAPH_SUPPORTED_RUNTIMES.has(runtime) ? "kubernetes" : runtime;
}

export function areGraphRuntimeCompatible(existingRuntime: RuntimeMode, requestedRuntime: RuntimeMode): boolean {
  return graphRuntimeFamily(existingRuntime) === graphRuntimeFamily(requestedRuntime);
}

export class DependencyPlannerError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DependencyPlannerError";
    this.code = code;
    this.details = details;
  }
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function normalizeDependencies(raw: DependencyMap): DependencyMap {
  const normalized: DependencyMap = {};
  const ids = Object.keys(raw).map((id) => id.trim()).filter(Boolean);
  const idSet = new Set(ids);

  for (const id of ids) {
    const entry = raw[id];
    const dependsOn = uniqueSorted(Array.isArray(entry?.dependsOn) ? entry.dependsOn : []);
    const consumesApis = uniqueSorted(Array.isArray(entry?.consumesApis) ? entry.consumesApis : []);
    const overlap = dependsOn.filter((target) => consumesApis.includes(target));
    if (overlap.length > 0) {
      throw new DependencyPlannerError(
        "overlapping_edges",
        `Service '${id}' has overlapping dependsOn and consumesApis edges`,
        { service: id, overlap },
      );
    }
    if (dependsOn.includes(id) || consumesApis.includes(id)) {
      throw new DependencyPlannerError(
        "self_edge",
        `Service '${id}' cannot depend on itself`,
        { service: id },
      );
    }
    normalized[id] = { dependsOn, consumesApis };
  }

  for (const [id, entry] of Object.entries(normalized)) {
    for (const target of [...entry.dependsOn, ...entry.consumesApis]) {
      if (!idSet.has(target)) {
        throw new DependencyPlannerError(
          "unknown_dependency_reference",
          `Service '${id}' references unknown dependency '${target}'`,
          { service: id, target },
        );
      }
    }
  }

  return normalized;
}

function findHardCycle(graph: DependencyMap): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    visiting.add(node);
    stack.push(node);

    for (const dep of graph[node].dependsOn) {
      if (visited.has(dep)) continue;
      if (visiting.has(dep)) {
        const idx = stack.indexOf(dep);
        return [...stack.slice(idx), dep];
      }
      const cycle = visit(dep);
      if (cycle) return cycle;
    }

    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  };

  for (const node of Object.keys(graph).sort()) {
    if (visited.has(node)) continue;
    const cycle = visit(node);
    if (cycle) return cycle;
  }

  return null;
}

function buildHardClosure(rootSpecId: string, graph: DependencyMap): Set<string> {
  const closure = new Set<string>();
  const visit = (node: string): void => {
    if (closure.has(node)) return;
    closure.add(node);
    for (const dep of graph[node].dependsOn) {
      visit(dep);
    }
  };
  visit(rootSpecId);
  return closure;
}

function buildTopologicalLayers(closure: Set<string>, graph: DependencyMap): PlannedLayer[] {
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, Set<string>>();
  for (const specId of closure) {
    indegree.set(specId, 0);
    outgoing.set(specId, new Set<string>());
  }

  for (const specId of closure) {
    for (const dep of graph[specId].dependsOn) {
      if (!closure.has(dep)) continue;
      indegree.set(specId, (indegree.get(specId) || 0) + 1);
      outgoing.get(dep)?.add(specId);
    }
  }

  const layers: PlannedLayer[] = [];
  let frontier = Array.from(closure).filter((id) => (indegree.get(id) || 0) === 0).sort();
  let processed = 0;
  let layerIndex = 0;

  while (frontier.length > 0) {
    const current = [...frontier].sort();
    frontier = [];

    layers.push({
      layer_index: layerIndex,
      spec_ids: current,
    });
    layerIndex += 1;
    processed += current.length;

    for (const specId of current) {
      for (const downstream of outgoing.get(specId) || []) {
        const nextInDegree = (indegree.get(downstream) || 0) - 1;
        indegree.set(downstream, nextInDegree);
        if (nextInDegree === 0) frontier.push(downstream);
      }
    }
  }

  if (processed !== closure.size) {
    throw new DependencyPlannerError(
      "hard_dependency_cycle",
      "Cycle detected while building dependency layers",
      { processed, expected: closure.size },
    );
  }

  return layers;
}

function normalizeEnvironments(input: string[]): string[] {
  const normalized = uniqueSorted(input);
  return normalized.length > 0 ? normalized : ["prod"];
}

function deploymentContainsEnvironment(record: DeploymentRecord, environment: string): boolean {
  const parsed = parseEnvironmentDeploymentsJson(record.environment_deployments || "");
  if (parsed.length > 0) {
    return parsed.some((entry) => entry.environment === environment);
  }
  const envsRaw = String(record.environments_json || "").trim();
  if (envsRaw) {
    try {
      const parsedJson = JSON.parse(envsRaw) as unknown;
      if (Array.isArray(parsedJson)) {
        return parsedJson.map((value) => String(value || "").trim()).includes(environment);
      }
    } catch {
      // Ignore malformed JSON and fall back below.
    }
  }
  return environment === "prod";
}

function environmentIsActive(record: DeploymentRecord, environment: string): boolean {
  const parsed = parseEnvironmentDeploymentsJson(record.environment_deployments || "");
  if (parsed.length > 0) {
    const matched = parsed.find((entry) => entry.environment === environment);
    if (!matched) return false;
    const status = String(matched.status || "").trim().toLowerCase();
    if (status && status !== "active") return false;
    return Boolean(matched.runtime_url || matched.url || status === "active");
  }

  // If there are no explicit environment records, we cannot rely solely on inclusion logic
  // because that only implies the environment was requested, not actually successful.
  if (record.status !== "active") {
    return false;
  }

  return deploymentContainsEnvironment(record, environment);
}

function classifyNode(
  specId: string,
  runtime: RuntimeMode,
  environment: string,
  deployments: DeploymentRecord[],
): NodeClassification {
  const TERMINAL_TOMBSTONE_STATUSES = new Set(["deprovisioned"]);
  const scoped = deployments.filter(
    (deployment) => deployment.spec_id === specId
      && deploymentContainsEnvironment(deployment, environment)
      && !TERMINAL_TOMBSTONE_STATUSES.has(deployment.status),
  );

  // A deployment can be considered "active" (reusable or blocking-via-runtime) if:
  // 1. the overall status is "active"
  // 2. OR the overall status is "failed" but this specific environment successfully completed
  const active = scoped.filter((deployment) => deployment.status === "active" || (deployment.status === "failed" && environmentIsActive(deployment, environment)));
  const activeMatchingRuntime = active.filter((deployment) => normalizeRuntimeMode(deployment.runtime_mode || "lambda") === runtime);
  if (activeMatchingRuntime.some((deployment) => environmentIsActive(deployment, environment))) {
    return { action: "reuse" };
  }

  const activeCompatibleRuntime = active.filter((deployment) => {
    const deploymentRuntime = normalizeRuntimeMode(deployment.runtime_mode || "lambda");
    return deploymentRuntime !== runtime && areGraphRuntimeCompatible(deploymentRuntime, runtime);
  });
  if (activeCompatibleRuntime.some((deployment) => environmentIsActive(deployment, environment))) {
    return { action: "attach" };
  }

  const activeDifferentRuntime = active.filter((deployment) => {
    const deploymentRuntime = normalizeRuntimeMode(deployment.runtime_mode || "lambda");
    return deploymentRuntime !== runtime && !areGraphRuntimeCompatible(deploymentRuntime, runtime);
  });
  if (activeDifferentRuntime.some((deployment) => environmentIsActive(deployment, environment))) {
    return { action: "blocked", blockedReason: "incompatible_runtime" };
  }

  const hasInvalidState = scoped.some((deployment) => deployment.status !== "active" && deployment.status !== "failed");
  if (hasInvalidState) {
    return { action: "blocked", blockedReason: "invalid_state" };
  }

  return { action: "provision" };
}

function buildSingleModeGuidance(nodes: PlannedNode[], rootSpecId: string): SingleModeGuidance | undefined {
  const missing = nodes
    .filter((node) => node.spec_id !== rootSpecId)
    .filter((node) => node.action === "provision" || node.action === "blocked")
    .map((node) => ({
      spec_id: node.spec_id,
      environment: node.environment,
      reason: node.action === "blocked"
        ? (node.blocked_reason === "incompatible_runtime" ? "blocked_incompatible_runtime" : "blocked_invalid_state")
        : "missing_active_deployment",
    })) as SingleModeMissingPrerequisite[];

  if (missing.length === 0) return undefined;

  return {
    recommend_graph_mode: true,
    missing_hard_prerequisites: missing,
  };
}

export function createDependencyPlan(input: CreateDependencyPlanInput): DependencyPlan {
  const rootSpecId = String(input.rootSpecId || "").trim();
  if (!rootSpecId) {
    throw new DependencyPlannerError("missing_root_spec", "rootSpecId is required");
  }

  const deploymentMode: DeploymentMode = input.deploymentMode === "graph" ? "graph" : "single";
  const runtime = normalizeRuntimeMode(input.runtime || "lambda");
  if (deploymentMode === "graph" && !GRAPH_SUPPORTED_RUNTIMES.has(runtime)) {
    throw new DependencyPlannerError(
      "graph_mode_runtime_not_supported",
      `Graph deployment mode is not supported for runtime '${runtime}'`,
      { runtime },
    );
  }

  const dependencies = normalizeDependencies(input.dependencies);
  if (!dependencies[rootSpecId]) {
    throw new DependencyPlannerError(
      "unknown_root_spec",
      `Unknown root spec '${rootSpecId}'`,
      { rootSpecId },
    );
  }

  const cyclePath = findHardCycle(dependencies);
  if (cyclePath) {
    throw new DependencyPlannerError(
      "hard_dependency_cycle",
      `Cycle detected in hard dependency graph: ${cyclePath.join(" -> ")}`,
      { cycle_path: cyclePath },
    );
  }

  const environments = normalizeEnvironments(input.environments);
  const hardClosure = buildHardClosure(rootSpecId, dependencies);
  const layers = buildTopologicalLayers(hardClosure, dependencies);
  const hardClosureSpecIds = layers.flatMap((layer) => layer.spec_ids);

  const hardClosureSet = new Set(hardClosureSpecIds);
  const softNeighborSpecIds = uniqueSorted(
    hardClosureSpecIds.flatMap((specId) => dependencies[specId].consumesApis).filter((specId) => !hardClosureSet.has(specId)),
  );

  const nodes: PlannedNode[] = [];
  for (const layer of layers) {
    for (const specId of layer.spec_ids) {
      for (const environment of environments) {
        const classification = classifyNode(specId, runtime, environment, input.deployments);
        nodes.push({
          key: `${specId}:${environment}:${runtime}`,
          spec_id: specId,
          environment,
          runtime,
          layer_index: layer.layer_index,
          action: classification.action,
          blocked_reason: classification.blockedReason,
          hard_dependencies: [...dependencies[specId].dependsOn],
          soft_neighbors: [...dependencies[specId].consumesApis],
        });
      }
    }
  }

  const summary = {
    total_nodes: nodes.length,
    reuse_count: nodes.filter((node) => node.action === "reuse").length,
    attach_count: nodes.filter((node) => node.action === "attach").length,
    provision_count: nodes.filter((node) => node.action === "provision").length,
    blocked_count: nodes.filter((node) => node.action === "blocked").length,
  };

  return {
    deployment_mode: deploymentMode,
    root_spec_id: rootSpecId,
    runtime,
    environments,
    hard_closure_spec_ids: hardClosureSpecIds,
    soft_neighbor_spec_ids: softNeighborSpecIds,
    layers,
    nodes,
    summary,
    single_mode_guidance: deploymentMode === "single"
      ? buildSingleModeGuidance(nodes, rootSpecId)
      : undefined,
  };
}
