import { parseEnvironmentDeployments } from "./deployment-metadata";
import {
  runtimeLabel,
  type Deployment,
  type PlannedNodeBlockedReason,
  type PlannedNodePreview,
  type ProvisionPlan,
  type RuntimeMode,
} from "./types";

export interface BlockedGraphRegistryEntry {
  id: string;
  title: string;
  repo_name: string;
}

export interface BlockedGraphNodeDetail {
  key: string;
  spec_id: string;
  title: string;
  environment: string;
  blocked_reason: PlannedNodeBlockedReason;
  project_name: string;
  message: string;
}

export interface BlockedGraphTeardownTarget {
  spec_id: string;
  project_name: string;
}

function normalizeRuntime(mode: unknown): RuntimeMode | null {
  const value = typeof mode === "string" ? mode.trim() : "";
  if (!value) return null;
  if (value === "k8s_roadmap") return "k8s_workspace";
  if (value === "lambda" || value === "ecs_service" || value === "k8s_workspace" || value === "k8s_discovery") {
    return value;
  }
  return null;
}

function deploymentContainsEnvironment(deployment: Deployment, environment: string): boolean {
  const parsed = parseEnvironmentDeployments(deployment);
  if (parsed.length > 0) {
    return parsed.some((entry) => entry.environment === environment);
  }

  const envsRaw = String(deployment.environments_json || "").trim();
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

function findBlockingDeployment(node: PlannedNodePreview, deployments: Deployment[]): Deployment | null {
  const scoped = deployments.filter((deployment) =>
    deployment.spec_id === node.spec_id && deploymentContainsEnvironment(deployment, node.environment),
  );

  if (scoped.length === 0) return null;

  if (node.blocked_reason === "incompatible_runtime") {
    const activeMismatch = scoped.find((deployment) =>
      deployment.status === "active"
      && normalizeRuntime(deployment.runtime_mode) !== null
      && normalizeRuntime(deployment.runtime_mode) !== node.runtime,
    );
    return activeMismatch || scoped.find((deployment) => deployment.status === "active") || scoped[0];
  }

  if (node.blocked_reason === "invalid_state") {
    return scoped.find((deployment) => deployment.status !== "active" && deployment.status !== "failed") || scoped[0];
  }

  return scoped[0];
}

function formatBlockedMessage(reason: PlannedNodeBlockedReason, deployment: Deployment | null): string {
  if (reason === "incompatible_runtime") {
    const runtime = normalizeRuntime(deployment?.runtime_mode);
    return runtime ? `Active on ${runtimeLabel(runtime)}` : "Active on another runtime";
  }

  const status = String(deployment?.status || "").trim();
  return status ? `Status ${status}` : "Deployment in a non-terminal state";
}

export function buildBlockedGraphNodeDetails(
  plan: ProvisionPlan | null,
  deployments: Deployment[],
  registry: BlockedGraphRegistryEntry[],
): BlockedGraphNodeDetail[] {
  if (!plan) return [];

  const specById = new Map(registry.map((entry) => [entry.id, entry]));
  return plan.nodes
    .filter((node) => node.action === "blocked" && node.blocked_reason)
    .map((node) => {
      const spec = specById.get(node.spec_id);
      const deployment = findBlockingDeployment(node, deployments);
      return {
        key: node.key,
        spec_id: node.spec_id,
        title: spec?.title || node.spec_id,
        environment: node.environment,
        blocked_reason: node.blocked_reason!,
        project_name: String(deployment?.github_repo_name || spec?.repo_name || node.spec_id).trim() || node.spec_id,
        message: formatBlockedMessage(node.blocked_reason!, deployment),
      };
    })
    .sort((a, b) => {
      if (a.title !== b.title) return a.title.localeCompare(b.title);
      if (a.environment !== b.environment) return a.environment.localeCompare(b.environment);
      return a.spec_id.localeCompare(b.spec_id);
    });
}

export function collectBlockedGraphTeardownTargets(
  blockedNodes: BlockedGraphNodeDetail[],
): BlockedGraphTeardownTarget[] {
  const deduped = new Map<string, BlockedGraphTeardownTarget>();
  for (const node of blockedNodes) {
    const projectName = node.project_name.trim();
    if (!projectName) continue;
    const dedupeKey = projectName.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    if (!deduped.has(dedupeKey)) {
      deduped.set(dedupeKey, {
        spec_id: node.spec_id,
        project_name: projectName,
      });
    }
  }
  return Array.from(deduped.values());
}
