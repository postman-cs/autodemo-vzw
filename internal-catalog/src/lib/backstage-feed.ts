import YAML from "yaml";
import type { DeploymentRecord } from "./airtable";
import { parseEnvironmentDeploymentsJson } from "./environment-deployments";
import registry from "../../specs/registry.json";
import dependenciesRaw from "../../specs/dependencies.json";

const DEPENDENCIES = dependenciesRaw as Record<string, { dependsOn: string[]; consumesApis: string[] }>;
const DEPENDENCIES_DIGEST = Object.keys(DEPENDENCIES)
  .sort()
  .map((id) => {
    const entry = DEPENDENCIES[id] || { dependsOn: [], consumesApis: [] };
    const dependsOn = [...(entry.dependsOn || [])].sort().join(",");
    const consumesApis = [...(entry.consumesApis || [])].sort().join(",");
    return `${id}:${dependsOn}|${consumesApis}`;
  })
  .join(";");

interface RegistryEntry {
  id: string;
  title?: string;
  description?: string;
  domain?: string;
  endpoints?: number;
}

interface FeedEnv {
  POSTMAN_API_KEY?: string;
  BACKSTAGE_OWNER_ENTITY?: string;
  [key: string]: unknown;
}

interface BuildBackstageFeedOptions {
  deployments: DeploymentRecord[];
  env: FeedEnv;
  requestOrigin?: string;
  scope?: "all" | "active";
}

const POSTMAN_API_BASE = "https://api.getpostman.com";
const FEED_CACHE_TTL_MS = 5 * 60 * 1000;
const SPEC_CACHE_TTL_MS = 5 * 60 * 1000;

const REGISTRY = registry as RegistryEntry[];
const REGISTRY_BY_ID = new Map<string, RegistryEntry>(
  REGISTRY.map((entry) => [String(entry.id || "").trim(), entry])
);

let feedCache:
  | {
    digest: string;
    expiresAt: number;
    yaml: string;
  }
  | null = null;

const specCache = new Map<string, { definition: string; expiresAt: number }>();

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseBooleanMap(raw: string): Record<string, boolean> {
  const normalized = readString(raw);
  if (!normalized) return {};
  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const slug = readString(key);
      if (!slug) continue;
      out[slug] = Boolean(value);
    }
    return out;
  } catch {
    return {};
  }
}

function isGitHubHost(hostname: string): boolean {
  return (
    hostname === "github.com" ||
    hostname.endsWith(".github.com") ||
    hostname.startsWith("github.") ||
    hostname.includes("github")
  );
}

function extractGitHubProjectSlug(repoUrl: string): string {
  const normalized = readString(repoUrl);
  if (!normalized) return "";

  const candidate = normalized.startsWith("url:") ? normalized.slice(4) : normalized;
  if (!/^https?:\/\//i.test(candidate)) return "";

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return "";
  }

  if (!isGitHubHost(parsed.hostname.toLowerCase())) {
    return "";
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    return "";
  }

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!owner || !repo) {
    return "";
  }

  return `${owner}/${repo}`;
}

function sanitizeEntityName(input: string): string {
  const sanitized = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown-service";
}

function parseTimestamp(value: string): number {
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : 0;
}

function resolveOwnerEntity(env: FeedEnv): string {
  return readString(env.BACKSTAGE_OWNER_ENTITY) || "group:default/postman-cs";
}

function looksLikeOpenApiDefinition(value: string): boolean {
  const text = value.trim();
  return /(^|\W)openapi(\W|$)/i.test(text) && /(^|\W)paths(\W|$)/i.test(text);
}

async function fetchSpecDefinition(
  specUid: string,
  workspaceId: string,
  env: FeedEnv,
): Promise<string> {
  const apiKey = readString(env.POSTMAN_API_KEY);
  if (!apiKey) {
    throw new Error("POSTMAN_API_KEY is not configured");
  }

  const cacheKey = `${specUid}::${workspaceId || "_"}`;
  const now = Date.now();
  const cached = specCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.definition;
  }

  const fetchSpec = async (withWorkspace: boolean): Promise<string> => {
    const url = new URL(`${POSTMAN_API_BASE}/specs/${encodeURIComponent(specUid)}/files/index.yaml`);
    if (withWorkspace && workspaceId) {
      url.searchParams.set("workspaceId", workspaceId);
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-Api-Key": apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Spec Hub lookup failed (${response.status})`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const content = typeof payload.content === "string" ? payload.content.trim() : "";
    if (!content || !looksLikeOpenApiDefinition(content)) {
      throw new Error("Spec Hub response did not include OpenAPI content");
    }
    return content;
  };

  let definition = "";
  try {
    definition = await fetchSpec(Boolean(workspaceId));
  } catch (err) {
    if (!workspaceId) throw err;
    definition = await fetchSpec(false);
  }

  specCache.set(cacheKey, {
    definition,
    expiresAt: now + SPEC_CACHE_TTL_MS,
  });

  return definition;
}

function buildFallbackDefinition(serviceId: string, title: string): string {
  const fallback = {
    openapi: "3.0.3",
    info: {
      title,
      version: "1.0.0",
      description: `Placeholder definition for ${serviceId}. Spec Hub content is unavailable.`,
    },
    paths: {},
  };
  return YAML.stringify(fallback).trim();
}

function buildDeploymentsDigest(deployments: DeploymentRecord[]): string {
  const parts = deployments
    .filter((record) => record.status === "active")
    .map((record) => [
      readString(record.spec_id),
      readString(record.status),
      readString(record.workspace_id),
      readString(record.postman_spec_uid),
      readString(record.postman_run_url),
      readString(record.runtime_mode),
      readString(record.aws_region),
      readString(record.github_repo_url),
      readString(record.postman_workspace_url),
      readString(record.runtime_base_url),
      readString(record.aws_invoke_url),
      readString(record.deployed_at),
    ].join("|"))
    .sort();
  return parts.join("||");
}

function pickLatestActiveDeployments(deployments: DeploymentRecord[]): DeploymentRecord[] {
  const bySpec = new Map<string, DeploymentRecord>();
  for (const record of deployments) {
    if (record.status !== "active") continue;
    const specId = readString(record.spec_id);
    if (!specId) continue;

    const existing = bySpec.get(specId);
    if (!existing) {
      bySpec.set(specId, record);
      continue;
    }

    const existingTs = parseTimestamp(readString(existing.deployed_at));
    const incomingTs = parseTimestamp(readString(record.deployed_at));
    if (incomingTs >= existingTs) {
      bySpec.set(specId, record);
    }
  }

  return [...bySpec.values()].sort((a, b) => {
    return readString(a.spec_id).localeCompare(readString(b.spec_id));
  });
}

function withStringValues(input: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const trimmed = readString(value);
    if (trimmed) output[key] = trimmed;
  }
  return output;
}

function pushLink(
  links: Array<{ url: string; title: string; icon?: string; type?: string }>,
  url: string,
  title: string,
  icon?: string,
  type?: string,
): void {
  const normalizedUrl = readString(url);
  if (!normalizedUrl) return;
  links.push({ url: normalizedUrl, title, icon, type });
}

export async function buildBackstageCatalogYaml(options: BuildBackstageFeedOptions): Promise<string> {
  const { deployments, env, requestOrigin, scope = "all" } = options;
  const ownerEntity = resolveOwnerEntity(env);
  const active = pickLatestActiveDeployments(deployments);
  const digest = `${ownerEntity}|${readString(requestOrigin)}|${scope}|${DEPENDENCIES_DIGEST}|${buildDeploymentsDigest(active)}`;
  const now = Date.now();

  if (feedCache && feedCache.digest === digest && feedCache.expiresAt > now) {
    return feedCache.yaml;
  }

  const entities: Array<Record<string, unknown>> = [];
  const activeBySpecId = new Map(active.map(d => [readString(d.spec_id), d]));

  if (scope === "active" && !active.length) {
    const emptyYaml = "[]\n";
    feedCache = {
      digest,
      expiresAt: now + FEED_CACHE_TTL_MS,
      yaml: emptyYaml,
    };
    return emptyYaml;
  }

  // Iterate over registry so we emit graph nodes for all known services
  for (const registryEntry of REGISTRY) {
    const specId = registryEntry.id;
    const record = activeBySpecId.get(specId);

    // If scope=active and service is NOT deployed, skip it.
    if (scope === "active" && !record) {
      continue;
    }

    // Build base entity properties
    const title = readString(registryEntry.title) || specId;
    const description = readString(registryEntry.description) || (record ? `Deployed API service for ${specId}` : `API service for ${specId}`);
    const domain = readString(registryEntry.domain) || "unknown";
    const endpoints = Number(registryEntry.endpoints || 0);
    const componentName = sanitizeEntityName(specId);
    const apiName = sanitizeEntityName(`${specId}-api`);

    // Graph edges from static dependencies
    const deps = DEPENDENCIES[specId] || { dependsOn: [], consumesApis: [] };
    const dependsOn = deps.dependsOn.map(id => `component:default/${sanitizeEntityName(id)}`);
    const consumesApis = deps.consumesApis.map(id => `api:default/${sanitizeEntityName(id + "-api")}`);

    // Add implicit self-consumption
    consumesApis.push(`api:default/${apiName}`);

    // Production (deployed) vs Development (undeployed)
    if (record) {
      const runtimeMode = readString(record.runtime_mode) || "lambda";
      const runtimeUrl = readString(record.runtime_base_url) || readString(record.aws_invoke_url);
      const workspaceUrl = readString(record.postman_workspace_url);
      const runUrl = readString(record.postman_run_url);
      const githubRepoUrl = readString(record.github_repo_url);
      const githubProjectSlug = extractGitHubProjectSlug(githubRepoUrl);
      const actionUrl = runUrl || workspaceUrl;
      const actionLabel = runUrl ? "Run in Postman" : (workspaceUrl ? "Open in Postman" : "");

      let definition = "";
      let definitionError = "";
      try {
        const specUid = readString(record.postman_spec_uid);
        const workspaceId = readString(record.workspace_id);
        if (!specUid) {
          throw new Error("postman_spec_uid is missing");
        }
        definition = await fetchSpecDefinition(specUid, workspaceId, env);
      } catch (err) {
        definitionError = err instanceof Error ? err.message : "unknown spec retrieval error";
        definition = buildFallbackDefinition(specId, title);
      }

      const links: Array<{ url: string; title: string; icon?: string; type?: string }> = [];
      pushLink(links, githubRepoUrl, "GitHub Repository", "github", "repo");
      pushLink(links, runtimeUrl, "Runtime URL", "dashboard", "runtime");
      pushLink(links, workspaceUrl, "Postman Workspace", "catalog", "postman-workspace");
      if (actionUrl) {
        pushLink(links, actionUrl, actionLabel, "web", "postman-action");
      }
      if (requestOrigin) {
        pushLink(
          links,
          `${requestOrigin.replace(/\/+$/, "")}/api/resources/${encodeURIComponent(specId)}`,
          "Catalog Admin Resources API",
          "dashboard",
          "resources",
        );
      }

      const fernDocsUrl = readString(record.fern_docs_url);
      if (fernDocsUrl) {
        pushLink(links, fernDocsUrl, "API Documentation", "docs", "docs");
      }

      const annotations: Record<string, string> = {
        "catalog-admin.postman.com/spec-id": specId,
        "catalog-admin.postman.com/runtime-mode": runtimeMode,
        "catalog-admin.postman.com/deployment-status": readString(record.status),
        "catalog-admin.postman.com/aws-region": readString(record.aws_region),
        "catalog-admin.postman.com/postman-workspace-url": workspaceUrl,
        "catalog-admin.postman.com/postman-run-url": runUrl,
        "catalog-admin.postman.com/postman-action-url": actionUrl,
        "catalog-admin.postman.com/postman-action-label": actionLabel,
        "catalog-admin.postman.com/postman-spec-uid": readString(record.postman_spec_uid),
        "catalog-admin.postman.com/spec-source": "postman-spec-hub",
        "catalog-admin.postman.com/runtime-url": runtimeUrl,
        "catalog-admin.postman.com/spec-load-error": definitionError,
        "catalog-admin.postman.com/deployed-at": readString(record.deployed_at),
        "catalog-admin.postman.com/fern-docs-url": fernDocsUrl,
        "catalog-admin.postman.com/chaos-enabled": record.chaos_enabled ? "true" : "false",
        "catalog-admin.postman.com/chaos-config": readString(record.chaos_config),
        "github.com/project-slug": githubProjectSlug,
      };

      // Add per-environment deployments
      if (record.environment_deployments) {
        const envDeploys = parseEnvironmentDeploymentsJson(record.environment_deployments);
        if (envDeploys.length > 0) {
          annotations["catalog-admin.postman.com/environment-deployments-json"] = JSON.stringify(envDeploys);
          const envSlugs = envDeploys
            .map((d) => readString(d.environment))
            .filter(Boolean);
          annotations["catalog-admin.postman.com/environments"] = envSlugs.join(",");
          const chaosMap = parseBooleanMap(readString(record.chaos_enabled_map));
          for (const deploy of envDeploys) {
            const slug = readString(deploy.environment);
            const url = readString(deploy.runtime_url) || readString(deploy.url);
            const postmanEnvUid = readString(deploy.postman_env_uid);
            const systemEnvId = readString(deploy.system_env_id);
            const envStatus = readString(deploy.status);
            const deployedAt = readString(deploy.deployed_at);
            const branch = readString(deploy.branch);
            if (slug && url) {
              annotations[`catalog-admin.postman.com/runtime-url-${slug}`] = url;
              pushLink(links, url, `Runtime URL (${slug})`, "dashboard", `runtime-${slug}`);
            }
            if (slug && postmanEnvUid) {
              annotations[`catalog-admin.postman.com/postman-env-uid-${slug}`] = postmanEnvUid;
              const envLink = workspaceUrl
                ? `${workspaceUrl.replace(/\/+$/, "")}/environment/${postmanEnvUid}`
                : "";
              pushLink(links, envLink, `Postman Env (${slug})`, "catalog", `postman-env-${slug}`);
            }
            if (slug && systemEnvId) {
              annotations[`catalog-admin.postman.com/system-env-id-${slug}`] = systemEnvId;
            }
            if (slug && envStatus) {
              annotations[`catalog-admin.postman.com/environment-status-${slug}`] = envStatus;
            }
            if (slug && deployedAt) {
              annotations[`catalog-admin.postman.com/deployed-at-${slug}`] = deployedAt;
            }
            if (slug && branch) {
              annotations[`catalog-admin.postman.com/environment-branch-${slug}`] = branch;
            }
            const apiGatewayId = readString(deploy.api_gateway_id);
            if (slug && apiGatewayId) {
              annotations[`catalog-admin.postman.com/api-gateway-id-${slug}`] = apiGatewayId;
            }
            if (slug && Object.prototype.hasOwnProperty.call(chaosMap, slug)) {
              annotations[`catalog-admin.postman.com/chaos-enabled-${slug}`] = chaosMap[slug] ? "true" : "false";
            }
          }
        }
      }

      const finalAnnotations = withStringValues(annotations);

      entities.push({
        apiVersion: "backstage.io/v1alpha1",
        kind: "Component",
        metadata: {
          name: componentName,
          title,
          description,
          tags: [domain, "vzw-partner-demo", "deployed"].filter(Boolean),
          links,
          annotations: finalAnnotations,
        },
        spec: {
          type: "service",
          lifecycle: "production",
          owner: ownerEntity,
          system: "vzw-partner-demo",
          providesApis: [`api:default/${apiName}`],
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
          consumesApis: consumesApis.length > 0 ? Array.from(new Set(consumesApis)) : undefined,
        },
      });

      entities.push({
        apiVersion: "backstage.io/v1alpha1",
        kind: "API",
        metadata: {
          name: apiName,
          title: `${title} API`,
          description: `${description}${endpoints > 0 ? ` (${endpoints} endpoints)` : ""}`,
          tags: [domain, "openapi", "vzw-partner-demo"].filter(Boolean),
          links,
          annotations,
        },
        spec: {
          type: "openapi",
          lifecycle: "production",
          owner: ownerEntity,
          system: "vzw-partner-demo",
          definition,
        },
      });
    } else {
      // Development (undeployed)
      const annotations = withStringValues({
        "catalog-admin.postman.com/spec-id": specId,
      });

      entities.push({
        apiVersion: "backstage.io/v1alpha1",
        kind: "Component",
        metadata: {
          name: componentName,
          title,
          description,
          tags: [domain, "vzw-partner-demo", "undeployed"].filter(Boolean),
          annotations,
        },
        spec: {
          type: "service",
          lifecycle: "development",
          owner: ownerEntity,
          system: "vzw-partner-demo",
          providesApis: [`api:default/${apiName}`],
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
          consumesApis: consumesApis.length > 0 ? Array.from(new Set(consumesApis)) : undefined,
        },
      });

      entities.push({
        apiVersion: "backstage.io/v1alpha1",
        kind: "API",
        metadata: {
          name: apiName,
          title: `${title} API`,
          description: `${description}${endpoints > 0 ? ` (${endpoints} endpoints)` : ""}`,
          tags: [domain, "openapi", "vzw-partner-demo"].filter(Boolean),
          annotations,
        },
        spec: {
          type: "openapi",
          lifecycle: "development",
          owner: ownerEntity,
          system: "vzw-partner-demo",
          definition: buildFallbackDefinition(specId, title),
        },
      });
    }
  }

  const yaml = entities
    .map((entity) => YAML.stringify(entity).trimEnd())
    .join("\n---\n")
    .concat("\n");

  feedCache = {
    digest,
    expiresAt: now + FEED_CACHE_TTL_MS,
    yaml,
  };

  return yaml;
}

export function resetBackstageFeedCacheForTests(): void {
  feedCache = null;
  specCache.clear();
}
