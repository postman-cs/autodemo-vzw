import type { ProvisioningEnv as Env } from "./provisioning-env";
import type { PortalConfig } from "./config";

export interface RuntimeAllocation {
  runtime: "ecs_service";
  project: string;
  assignment_key: string;
  route_url: string;
  base_url: string;
  created_at: string;
}

function sanitizeSegment(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";
}

function resolvePoolBaseUrl(config: PortalConfig | null | undefined, env: Env): { baseUrl: string; fromConfig: boolean } {
  const configBase = config?.backend?.runtime_defaults?.ecs_base_url?.trim();
  const envBase =
    (env as unknown as { RUNTIME_POOL_BASE_URL?: string }).RUNTIME_POOL_BASE_URL?.trim() ||
    (env as unknown as { ECS_POOL_BASE_URL?: string }).ECS_POOL_BASE_URL?.trim();
  const fallback = "https://se.pm-catalog.dev";
  const baseUrl = (configBase || envBase || fallback).replace(/\/+$/, "");
  return { baseUrl, fromConfig: Boolean(configBase) };
}

function assignmentKey(project: string): string {
  return `runtime_pool:assignment:${project}`;
}

function buildRouteUrl(baseUrl: string, project: string, fromConfig: boolean): string {
  if (fromConfig) {
    const templated = baseUrl
      .replace(/\{project\}/g, project)
      .replace(/\{repo\}/g, project);

    // For explicit config values, treat URL as final unless it intentionally
    // includes placeholders.
    return templated;
  }

  // Shared runtime pool mode: derive route under /services/<project>.
  return `${baseUrl}/services/${project}`;
}

export async function allocateTenantRoute(
  projectName: string,
  config: PortalConfig | null | undefined,
  env: Env,
): Promise<RuntimeAllocation> {
  const project = sanitizeSegment(projectName);
  const key = assignmentKey(project);
  const { baseUrl, fromConfig } = resolvePoolBaseUrl(config, env);
  const routeUrl = buildRouteUrl(baseUrl, project, fromConfig);

  const existingRaw = await env.PORTAL_CONFIG.get(key, "text");
  if (existingRaw) {
    try {
      return JSON.parse(existingRaw) as RuntimeAllocation;
    } catch {
      // ignore malformed cached assignment and overwrite
    }
  }

  const allocation: RuntimeAllocation = {
    runtime: "ecs_service",
    project,
    assignment_key: key,
    route_url: routeUrl,
    base_url: baseUrl,
    created_at: new Date().toISOString(),
  };

  await env.PORTAL_CONFIG.put(key, JSON.stringify(allocation));
  return allocation;
}

export async function releaseTenantRoute(
  projectName: string,
  _slug: string | null | undefined,
  env: Env,
): Promise<void> {
  const key = assignmentKey(sanitizeSegment(projectName));
  await env.PORTAL_CONFIG.delete(key);
}
