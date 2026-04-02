import type { DeploymentRecord } from "./airtable";
import dependenciesRaw from "../../specs/dependencies.json";
import registryRaw from "../../specs/registry.json";
import type { CanonicalManifest, CanonicalManifestService, CanonicalManifestTab } from "@vzw/types";

interface DependencyEntry {
  dependsOn?: string[];
  consumesApis?: string[];
}

interface RegistryService {
  id: string;
  title: string;
  description?: string;
  industry?: string;
  domain?: string;
  filename?: string;
  repo_name?: string;
  repo_flag?: string;
  runtime: string;
  endpoints?: number;
  version?: string;
}

const DEPENDENCIES = dependenciesRaw as Record<string, DependencyEntry>;
const REGISTRY = registryRaw as RegistryService[];

const GRAPH_DEFINITIONS = [
  {
    slug: "emergency-dispatch",
    title: "Emergency Dispatch",
    leaf_service_id: "vzw-city-dispatch-api",
  },
  {
    slug: "private-5-g-campus",
    title: "Private 5G Campus",
    leaf_service_id: "vzw-campus-service-assurance-api",
  },
  {
    slug: "utility-grid",
    title: "Utility Grid",
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

export function buildCanonicalManifest(deployments: DeploymentRecord[]): CanonicalManifest {
  const activeDeployments = new Map<string, DeploymentRecord>();
  for (const d of deployments) {
    if (d.status === "active" && d.spec_id) {
      activeDeployments.set(d.spec_id, d);
    }
  }

  const graphMembershipByService = new Map<string, string>();
  const tabs: CanonicalManifestTab[] = [];
  const fernRuntimeRouteMap: Record<string, string> = {};
  for (const graph of GRAPH_DEFINITIONS) {
    const closure = collectDependsOnClosure(graph.leaf_service_id);
    for (const serviceId of closure) {
      if (!graphMembershipByService.has(serviceId)) {
        graphMembershipByService.set(serviceId, graph.slug);
      }
    }

    const services: CanonicalManifestService[] = Array.from(closure)
      .map((serviceId) => {
        const registryEntry = REGISTRY.find((s) => s.id === serviceId);
        const deployment = activeDeployments.get(serviceId);
        const workspaceId = deployment?.workspace_id || deployment?.workspace_team_id || "";
        const apiSlug = serviceId;
        const routeKey = `${graph.slug}/${apiSlug}`;

        return {
          id: serviceId,
          title: registryEntry?.title ?? serviceId,
          runtime: registryEntry?.runtime ?? "unknown",
          sourceSpec: registryEntry?.filename ?? `repos/${serviceId}/openapi.yaml`,
          workspaceId,
          postmanWorkspaceUrl: `https://verizon-partner-demo.postman.co/workspace/${workspaceId}`,
          apiSlug,
          fernDocsUrl: `https://verizon-demo.docs.buildwithfern.com/${graph.slug}/${apiSlug}`,
          dependsOn: getDependsOn(serviceId),
          consumesApis: getConsumes(serviceId),
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));

    for (const service of services) {
      fernRuntimeRouteMap[`${graph.slug}/${service.apiSlug}`] = service.id;
    }

    tabs.push({
      slug: graph.slug,
      title: graph.title,
      serviceCount: services.length,
      services,
    });
  }

  const allServiceIds = unique([
    ...Object.keys(DEPENDENCIES),
    ...REGISTRY.map((s) => s.id),
  ]);

  const platformServices = allServiceIds
    .filter((serviceId) => !graphMembershipByService.has(serviceId))
    .map((serviceId) => {
      const registryEntry = REGISTRY.find((s) => s.id === serviceId);
      const deployment = activeDeployments.get(serviceId);
      const workspaceId = deployment?.workspace_id || deployment?.workspace_team_id || "";
      const apiSlug = serviceId;
      const routeKey = `platform-services/${apiSlug}`;

      return {
        id: serviceId,
        title: registryEntry?.title ?? serviceId,
        runtime: registryEntry?.runtime ?? "unknown",
        sourceSpec: registryEntry?.filename ?? `repos/${serviceId}/openapi.yaml`,
        workspaceId,
        postmanWorkspaceUrl: `https://verizon-partner-demo.postman.co/workspace/${workspaceId}`,
        apiSlug,
        fernDocsUrl: `https://verizon-demo.docs.buildwithfern.com/platform-services/${apiSlug}`,
        dependsOn: getDependsOn(serviceId),
        consumesApis: getConsumes(serviceId),
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));

  for (const service of platformServices) {
    fernRuntimeRouteMap[`platform-services/${service.apiSlug}`] = service.id;
  }

  tabs.push({
    slug: "platform-services",
    title: "Platform Services",
    serviceCount: platformServices.length,
    services: platformServices,
  });

  const totalServices = tabs.reduce((sum, tab) => sum + tab.serviceCount, 0);

  return {
    manifestVersion: "canonical-manifest.v1",
    docsSiteUrl: "https://verizon-demo.docs.buildwithfern.com",
    postmanWorkspaceBaseUrl: "https://verizon-partner-demo.postman.co/workspace",
    serviceCount: totalServices,
    tabCount: tabs.length,
    tabs,
    fernRuntimeRouteMap,
  };
}
