import { UnifiedEnv } from "../index";
import { DeploymentRecord } from "./airtable";
import { listResolvedDeployments } from "./deployment-state";
import dependenciesRaw from "../../specs/dependencies.json";
import registry from "../../specs/registry.json";

const DEPENDENCIES = dependenciesRaw as Record<string, { dependsOn: string[]; consumesApis: string[] }>;

interface RegistrySpecEntry {
  id: string;
  filename: string;
  domain?: string;
  repo_name?: string;
}

const SPEC_REGISTRY = registry as RegistrySpecEntry[];
const SPEC_REGISTRY_BY_ID = new Map<string, RegistrySpecEntry>(
  SPEC_REGISTRY.map((entry) => [entry.id.trim(), entry])
);

interface DependencyConfig {
  hard: string[];
  soft: string[];
}

export async function resolveDependencyTargets(opts: {
  specId: string;
  projectName: string;
  repoName: string;
  runtimeMode: string;
  environments: string[];
  k8sIngressBaseDomain: string | undefined;
  k8sNamespace: string;
  githubAppToken: string;
  env: UnifiedEnv;
}): Promise<string> {
  const {
    specId,
    projectName,
    repoName,
    runtimeMode,
    environments,
    k8sIngressBaseDomain,
    k8sNamespace,
    githubAppToken,
    env,
  } = opts;

  const containerRuntime = runtimeMode !== "lambda";

  const dependencyGraphKey = [specId, projectName, repoName]
    .map((value) => String(value || "").trim())
    .filter((value) => value && value !== "legacy_spec_url")
    .find((value) => Boolean(DEPENDENCIES[value]))
    || "";

  const deps = DEPENDENCIES[dependencyGraphKey] || { dependsOn: [], consumesApis: [] };

  const hardDepIds = Array.from(new Set(deps.dependsOn));
  const softDepIds = Array.from(new Set(deps.consumesApis)).filter(id => !hardDepIds.includes(id));

  const dependencyConfig: DependencyConfig = { hard: [], soft: [] };

  if (containerRuntime && (hardDepIds.length > 0 || softDepIds.length > 0)) {
    const isK8s = runtimeMode === "k8s_workspace" || runtimeMode === "k8s_discovery";
    if (isK8s) {
      const resolveUrls = (ids: string[]) => {
        const urls: string[] = [];
        const seen = new Set<string>();
        for (const depId of ids) {
          const registryEntry = SPEC_REGISTRY_BY_ID.get(depId);
          const depServiceName = String(registryEntry?.repo_name || depId).trim() || depId;
          for (const envName of environments) {
            const useEnvironmentScopedTargets = environments.length > 1 || envName !== "prod";
            const envSuffix = useEnvironmentScopedTargets ? `-${envName}` : "";
            const svcName = `${depServiceName}${envSuffix}`;
            const url = `http://${svcName}.${k8sNamespace}.svc.cluster.local/svc/${svcName}`;
            if (!seen.has(url)) { seen.add(url); urls.push(url); }
          }
        }
        return urls;
      };
      dependencyConfig.hard = resolveUrls(hardDepIds);
      dependencyConfig.soft = resolveUrls(softDepIds);

      // Guard: all K8s dependency URLs must use ClusterIP DNS, not NLB/external hostnames
      const allK8sUrls = [...dependencyConfig.hard, ...dependencyConfig.soft];
      const nonClusterUrls = allK8sUrls.filter(u => !u.includes('.svc.cluster.local'));
      if (nonClusterUrls.length > 0) {
        throw new Error(
          `Dependency targets contain non-ClusterIP URLs that will break Insights graph correlation: ${nonClusterUrls.join(', ')}`
        );
      }
    } else {
      // Lambda/ECS: resolve from already-deployed Airtable records
      try {
        const allDeployments = await listResolvedDeployments(env, githubAppToken);
        const resolveAirtableUrls = (ids: string[]) => {
          return allDeployments
            .filter((d: DeploymentRecord) => d.status === "active" && ids.includes(d.spec_id))
            .map((d: DeploymentRecord) => d.runtime_base_url || d.aws_invoke_url)
            .filter(Boolean) as string[];
        };
        dependencyConfig.hard = resolveAirtableUrls(hardDepIds);
        dependencyConfig.soft = resolveAirtableUrls(softDepIds);
      } catch (err) {
        console.warn("Failed to fetch dependency URLs:", err);
      }
    }  }

  return JSON.stringify(dependencyConfig);
}
