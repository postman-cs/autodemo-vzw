import type { DeploymentRecord } from "./airtable";
import { parseEnvironmentDeploymentsJson } from "./environment-deployments";
import dependenciesRaw from "../../specs/dependencies.json";
import registryRaw from "../../specs/registry.json";
import { buildCanonicalManifest } from "./docs-manifest";
import { buildAgentPrompt, buildAgentPromptTitle } from "./agent-prompt-builder";
import { getSpecDescription } from "./spec-description-extractor";

interface DependencyEntry {
  dependsOn?: string[];
  consumesApis?: string[];
}

interface RegistryService {
  id: string;
  title: string;
  description?: string;
  runtime: string;
  endpoints?: number;
}

interface CatalogService {
  id: string;
  title: string;
  runtime: string;
  description?: string;
  fern_docs_url?: string;
  run_in_postman_url?: string;
  agent_prompt?: string;
  agent_prompt_title?: string;
}

interface ServiceCatalogFile {
  services: CatalogService[];
}

interface GraphDefinition {
  graph_id: string;
  graph_name: string;
  root_service_id: string;
  leaf_service_id: string;
}

export type HealthStatus = "healthy" | "degraded" | "offline";

export interface PartnerGraphNode {
  service_id: string;
  title: string;
  runtime: string;
  description?: string;
  deployed: boolean;
  entrypoint_url?: string;
  fern_docs_url?: string;
  run_in_postman_url?: string;
  agent_prompt?: string;
  is_graph_root: boolean;
  is_graph_leaf: boolean;
  upstream_count: number;
  downstream_count: number;
  health: HealthStatus;
}

interface PartnerGraph {
  graph_id: string;
  graph_name: string;
  services: PartnerGraphNode[];
}

interface PartnerGraphsFeed {
  generated_at: string;
  graphs: PartnerGraph[];
  standalone: PartnerGraphNode[];
  totals: {
    deployed: number;
    graphs: number;
    standalone: number;
  };
}

interface PartnerDependencyEdge {
  service_id: string;
  title: string;
  deployed: boolean;
  entrypoint_url?: string;
  fern_docs_url?: string;
  edge_type: "dependsOn" | "consumesApis";
}

interface PartnerServiceDetail {
  generated_at: string;
  service: {
    service_id: string;
    title: string;
    runtime: string;
    description?: string;
    deployed: boolean;
    entrypoint_url?: string;
    fern_docs_url?: string;
    run_in_postman_url?: string;
    agent_prompt?: string;
    graph_id?: string;
    graph_name?: string;
    health: HealthStatus;
  };
  dependencies: {
    upstream: PartnerDependencyEdge[];
    downstream: PartnerDependencyEdge[];
    consumes: PartnerDependencyEdge[];
  };
  environment_deployments: Array<{
    environment: string;
    runtime_url: string;
    status?: string;
    deployed_at?: string;
  }>;
}

const DEPENDENCIES = dependenciesRaw as Record<string, DependencyEntry>;
const REGISTRY = registryRaw as RegistryService[];

const GRAPH_DEFINITIONS: GraphDefinition[] = [
  {
    graph_id: "emergency-dispatch",
    graph_name: "Emergency Dispatch Operations",
    root_service_id: "vzw-incident-intake-gateway-api",
    leaf_service_id: "vzw-city-dispatch-api",
  },
  {
    graph_id: "private-5g-campus",
    graph_name: "Private 5G Campus Operations",
    root_service_id: "vzw-campus-identity-proxy-api",
    leaf_service_id: "vzw-campus-service-assurance-api",
  },
  {
    graph_id: "utility-grid-intelligence",
    graph_name: "Utility Grid Intelligence",
    root_service_id: "vzw-grid-topology-sync-api",
    leaf_service_id: "vzw-regulatory-reporting-api",
  },
];

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function getDependsOn(serviceId: string): string[] {
  return unique(DEPENDENCIES[serviceId]?.dependsOn ?? []);
}

function getConsumes(serviceId: string): string[] {
  return unique(DEPENDENCIES[serviceId]?.consumesApis ?? []);
}

function buildReverseDependsOnMap(): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const [serviceId, dependencyEntry] of Object.entries(DEPENDENCIES)) {
    for (const upstream of dependencyEntry.dependsOn ?? []) {
      const existing = reverse.get(upstream) ?? [];
      existing.push(serviceId);
      reverse.set(upstream, existing);
    }
  }
  for (const [serviceId, dependents] of reverse) {
    reverse.set(serviceId, unique(dependents));
  }
  return reverse;
}

function buildCatalogIndex(deployments: DeploymentRecord[]): Map<string, CatalogService> {
  const index = new Map<string, CatalogService>();
  const manifest = buildCanonicalManifest(deployments);
  
  for (const tab of manifest.tabs) {
    for (const service of tab.services) {
      const registryEntry = REGISTRY.find(r => r.id === service.id);
      const deps = (DEPENDENCIES[service.id] || { dependsOn: [], consumesApis: [] }) as DependencyEntry;
      const specDesc = getSpecDescription(service.id);
      const agentPrompt = buildAgentPrompt({
        title: service.title,
        description: registryEntry?.description || "",
        specDescription: specDesc.description,
        endpointSummaries: specDesc.endpointSummaries,
        endpointCount: registryEntry?.endpoints || 0,
        dependsOn: deps.dependsOn || [],
        consumesApis: deps.consumesApis || [],
        fernDocsUrl: service.fernDocsUrl,
        runtime: service.runtime,
      });
      index.set(service.id, {
        id: service.id,
        title: service.title,
        runtime: service.runtime,
        description: registryEntry?.description,
        fern_docs_url: service.fernDocsUrl,
        run_in_postman_url: service.postmanWorkspaceUrl,
        agent_prompt: agentPrompt,
        agent_prompt_title: buildAgentPromptTitle(service.title),
      });
    }
  }
  return index;
}

function resolveEntrypointUrl(deployment?: DeploymentRecord): string | undefined {
  if (!deployment) return undefined;
  const runtimeBaseUrl = deployment.runtime_base_url?.trim();
  if (runtimeBaseUrl) return runtimeBaseUrl;
  const awsInvokeUrl = deployment.aws_invoke_url?.trim();
  if (awsInvokeUrl) return awsInvokeUrl;
  return undefined;
}

function buildActiveDeploymentsIndex(deployments: DeploymentRecord[]): Map<string, DeploymentRecord> {
  const index = new Map<string, DeploymentRecord>();
  for (const deployment of deployments) {
    if (deployment.status !== "active") continue;
    if (!deployment.spec_id) continue;
    const existing = index.get(deployment.spec_id);
    const existingEntrypoint = resolveEntrypointUrl(existing);
    const candidateEntrypoint = resolveEntrypointUrl(deployment);
    if (!existing || (!!candidateEntrypoint && !existingEntrypoint)) {
      index.set(deployment.spec_id, deployment);
    }
  }
  return index;
}

function collectDependsOnClosure(leafServiceId: string): Set<string> {
  const visited = new Set<string>();
  const stack = [leafServiceId];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const upstream of getDependsOn(current)) {
      if (!visited.has(upstream)) stack.push(upstream);
    }
  }

  return visited;
}

function deriveHealth(deployment: DeploymentRecord | undefined, entrypointUrl: string | undefined): HealthStatus {
  if (!deployment) return "offline";
  if (deployment.status === "active" && entrypointUrl) return "healthy";
  if (deployment.status === "failed") return "degraded";
  return "offline";
}

function buildGraphNode(
  serviceId: string,
  graph: GraphDefinition,
  catalogIndex: Map<string, CatalogService>,
  reverseDependsOn: Map<string, string[]>,
  activeDeployments: Map<string, DeploymentRecord>,
): PartnerGraphNode {
  const service = catalogIndex.get(serviceId);
  const deployment = activeDeployments.get(serviceId);
  const entrypointUrl = resolveEntrypointUrl(deployment);
  const deployed = Boolean(deployment);

  return {
    service_id: serviceId,
    title: service?.title ?? serviceId,
    runtime: service?.runtime ?? "unknown",
    description: service?.description,
    deployed,
    ...(deployed && entrypointUrl ? { entrypoint_url: entrypointUrl } : {}),
    fern_docs_url: service?.fern_docs_url || undefined,
    ...(deployed && service?.run_in_postman_url ? { run_in_postman_url: service.run_in_postman_url } : {}),
    ...(service?.agent_prompt ? { agent_prompt: service.agent_prompt } : {}),
    is_graph_root: serviceId === graph.root_service_id,
    is_graph_leaf: serviceId === graph.leaf_service_id,
    upstream_count: getDependsOn(serviceId).length,
    downstream_count: (reverseDependsOn.get(serviceId) ?? []).length,
    health: deriveHealth(deployment, entrypointUrl),
  };
}

function buildDependencyEdge(
  serviceId: string,
  edgeType: "dependsOn" | "consumesApis",
  catalogIndex: Map<string, CatalogService>,
  activeDeployments: Map<string, DeploymentRecord>,
): PartnerDependencyEdge {
  const service = catalogIndex.get(serviceId);
  const deployment = activeDeployments.get(serviceId);
  const entrypointUrl = resolveEntrypointUrl(deployment);
  const deployed = Boolean(deployment);

  return {
    service_id: serviceId,
    title: service?.title ?? serviceId,
    deployed,
    ...(deployed && entrypointUrl ? { entrypoint_url: entrypointUrl } : {}),
    fern_docs_url: service?.fern_docs_url || undefined,
    edge_type: edgeType,
  };
}

export function getPartnerGraphsFeed(deployments: DeploymentRecord[]): PartnerGraphsFeed {
  const catalogIndex = buildCatalogIndex(deployments);
  const reverseDependsOn = buildReverseDependsOnMap();
  const activeDeployments = buildActiveDeploymentsIndex(deployments);

  const graphMembershipByService = new Map<string, string>();

  const graphs = GRAPH_DEFINITIONS.map((graph) => {
    const closure = collectDependsOnClosure(graph.leaf_service_id);
    for (const serviceId of closure) {
      if (!graphMembershipByService.has(serviceId)) {
        graphMembershipByService.set(serviceId, graph.graph_id);
      }
    }

    const services = Array.from(closure)
      .map((serviceId) => buildGraphNode(serviceId, graph, catalogIndex, reverseDependsOn, activeDeployments))
      .sort((a, b) => a.title.localeCompare(b.title));

    return {
      graph_id: graph.graph_id,
      graph_name: graph.graph_name,
      services,
    };
  });

  const allServiceIds = unique([
    ...Object.keys(DEPENDENCIES),
    ...REGISTRY.map((service) => service.id),
  ]);

  const standalone = allServiceIds
    .filter((serviceId) => !graphMembershipByService.has(serviceId))
    .filter((serviceId) => getDependsOn(serviceId).length === 0)
    .filter((serviceId) => (reverseDependsOn.get(serviceId) ?? []).length === 0)
    .map((serviceId) => buildGraphNode(
      serviceId,
      {
        graph_id: "standalone",
        graph_name: "Standalone",
        root_service_id: "",
        leaf_service_id: "",
      },
      catalogIndex,
      reverseDependsOn,
      activeDeployments,
    ))
    .sort((a, b) => a.title.localeCompare(b.title));

  return {
    generated_at: new Date().toISOString(),
    graphs,
    standalone,
    totals: {
      deployed: allServiceIds.filter((serviceId) => activeDeployments.has(serviceId)).length,
      graphs: graphs.length,
      standalone: standalone.length,
    },
  };
}

export function getPartnerServiceDetail(
  serviceId: string,
  deployments: DeploymentRecord[],
): PartnerServiceDetail | null {
  const catalogIndex = buildCatalogIndex(deployments);
  if (!catalogIndex.has(serviceId) && !DEPENDENCIES[serviceId]) {
    return null;
  }

  const activeDeployments = buildActiveDeploymentsIndex(deployments);

  const graph = GRAPH_DEFINITIONS.find((candidate) => collectDependsOnClosure(candidate.leaf_service_id).has(serviceId));
  const service = catalogIndex.get(serviceId);
  const deployment = activeDeployments.get(serviceId);
  const entrypointUrl = resolveEntrypointUrl(deployment);
  const deployed = Boolean(deployment);

  const reverseDependsOn = buildReverseDependsOnMap();
  const upstream = getDependsOn(serviceId)
    .map((upstreamServiceId) => buildDependencyEdge(upstreamServiceId, "dependsOn", catalogIndex, activeDeployments))
    .sort((a, b) => a.title.localeCompare(b.title));

  const downstream = (reverseDependsOn.get(serviceId) ?? [])
    .map((downstreamServiceId) => buildDependencyEdge(downstreamServiceId, "dependsOn", catalogIndex, activeDeployments))
    .sort((a, b) => a.title.localeCompare(b.title));

  const consumes = getConsumes(serviceId)
    .map((consumedServiceId) => buildDependencyEdge(consumedServiceId, "consumesApis", catalogIndex, activeDeployments))
    .sort((a, b) => a.title.localeCompare(b.title));

  return {
    generated_at: new Date().toISOString(),
    service: {
      service_id: serviceId,
      title: service?.title ?? serviceId,
      runtime: service?.runtime ?? "unknown",
      deployed,
      ...(deployed && entrypointUrl ? { entrypoint_url: entrypointUrl } : {}),
      fern_docs_url: service?.fern_docs_url || undefined,
      ...(deployed && service?.run_in_postman_url ? { run_in_postman_url: service.run_in_postman_url } : {}),
      ...(service?.agent_prompt ? { agent_prompt: service.agent_prompt } : {}),
      ...(service?.agent_prompt_title ? { agent_prompt_title: service.agent_prompt_title } : {}),
      ...(graph ? { graph_id: graph.graph_id, graph_name: graph.graph_name } : {}),
      health: deriveHealth(deployment, entrypointUrl),
    },
    dependencies: {
      upstream,
      downstream,
      consumes,
    },
    environment_deployments: deployment
      ? parseEnvironmentDeploymentsJson(deployment.environment_deployments || "")
          .map((ed) => ({
            environment: ed.environment,
            runtime_url: ed.runtime_url,
            ...(ed.status ? { status: ed.status } : {}),
            ...(ed.deployed_at ? { deployed_at: ed.deployed_at } : {}),
          }))
      : [],
  };
}
