import { handleProvision, handleProvisionPlan } from "./lib/provision";
import type { RuntimeMode } from "./lib/config";

let _ProvisionGraphWorkflow: any;
try {
  const mod = await import("./workflows/provision-graph");
  _ProvisionGraphWorkflow = mod.ProvisionGraphWorkflow;
} catch {
  // Node/Vitest: cloudflare:workers not available
}
export const ProvisionGraphWorkflow = _ProvisionGraphWorkflow;
import {
  handleInfraSetup,
  handleInfraTeardown,
  handleK8sDiscoveryInfraSetup,
  handleK8sDiscoveryInfraTeardown,
} from "./lib/infra";
import { handleTeams } from "./lib/teams";
import { handleUsers } from "./lib/users";
import { getTeam, listTeams, parseTeamConfigsFromEnv, resolveTeamCredentials, seedTeamsFromEnv, type TeamConfig } from "./lib/team-registry";
import { registerTeamWithSync, updateTeamWithSync, deleteTeamWithSync, bootstrapTeamsFromEnvToAuthority, reconcileRegistryFromAuthority } from "./lib/tenant-credential-sync";

import {
  discoverIdentityProfileFromAccessToken,
  fetchApiKeyProfile,
  validateAccessTokenForTeam,
  assertMatchingTeamIdentity,
  checkCredentialHealth,
  withRuntimeMetadata,
  type CredentialHealthSummary,
} from "./lib/team-credential-health";
import {
  deriveTeamRuntimeMetadata,
  type TeamRuntimeMetadata,
} from "./lib/team-runtime-metadata";
import { handleGitHubOrgMembers } from "./lib/github-org-members";
import { handleBatchTeardown, handleTeardown, handleStatus } from "./lib/teardown";
import {
  setGitHubOrg,
  setGitHubUserAgent,
  setGitHubTokenPool,
  setGitHubAppAuthConfig,
} from "./lib/github";
import {
  getServiceRecord,
  listServiceRecords,
  normalizeCatalogQuery,
} from "./lib/catalog-registry";
import {
  listDeployments,
  getDeployment,
  getInfraRecord,
  createDeployment,
  updateDeployment,
  isAirtableConfigured,
  type DeploymentRecord,
  type InfraRecord,
} from "./lib/airtable";
import { buildBackstageCatalogYaml } from "./lib/backstage-feed";
import { buildRecoverableFailures, autoResolveGhostFailures } from "./lib/deployment-recovery";
import { getResolvedDeployment, listResolvedDeployments } from "./lib/deployment-state";
import type { ProvisioningEnv } from "./lib/provisioning-env";
import { buildResourceInventory } from "./lib/resource-inventory";
import { resolveRuntimeOptionsStatus } from "./lib/runtime-options";
import { toggleServiceChaos } from "./lib/chaos";
import {
  buildUnauthenticatedResponse,
  isLocalDevAuthBypassEnabled,
  isAuthBypassPath,
  normalizeCfAccessConfig,
  validateCfAccessRequest,
} from "./lib/auth";
import {
  getRequestId,
  listWorkerLogsForRequest,
  logWorkerEvent,
  withRequestId,
  withRequestIdHeader,
} from "./lib/worker-logs";
import { fetchWorkflowStatusFromCfApi } from "./lib/provision-graph-status";
import {
  resolveSystemEnvironments,
  buildSystemEnvMap,
} from "./lib/system-envs";
import { handleGitHubWebhook } from "./lib/provision-webhooks";
import { resolveDependencyTargets } from "./lib/dependency-resolver";
import { parseEnvironmentDeploymentsJson } from "./lib/environment-deployments";
import { REFRESH_DEPENDENCIES_WORKFLOW_CONTENT } from "./lib/provision-workflow";
import { triggerWorkflow, appendCommit } from "./lib/github";
import { createDependencyPlan, type DependencyMap } from "./lib/dependency-planner";
import { buildCanonicalManifest } from "./lib/docs-manifest";
import { getPartnerGraphsFeed, getPartnerServiceDetail } from "./lib/partner-catalog";
import dependenciesRaw from "../specs/dependencies.json";
import serviceCatalogRaw from "../specs/service-catalog.json";

const DEPENDENCIES = dependenciesRaw as DependencyMap;
const SERVICE_CATALOG = serviceCatalogRaw as {
  available_repo_flags: string[];
  default_repo_flag: string;
  services: Array<Record<string, unknown>>;
};

export interface UnifiedEnv extends ProvisioningEnv {
  GITHUB_TARGET_ORG?: string;
  GITHUB_TARGET_USER_AGENT?: string;
  SERVICE_REGISTRY?: KVNamespace;
  TEAM_REGISTRY?: KVNamespace;
  AIRTABLE_API_KEY?: string;
  AIRTABLE_BASE_ID?: string;
  AWS_REGION?: string;
  AWS_LAMBDA_ROLE_ARN?: string;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  PROVISION_GRAPH_WORKFLOW?: Workflow;
  WORKER_ORIGIN?: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  CF_ACCOUNT_ID?: string;
  CF_EMAIL?: string;
  CF_API_KEY?: string;
  TENANT_SECRETS_SYNC_ENABLED?: string;
  TENANT_SECRETS_AWS_ACCESS_KEY_ID?: string;
  TENANT_SECRETS_AWS_SECRET_ACCESS_KEY?: string;
  TENANT_SECRETS_AWS_SESSION_TOKEN?: string;
  TENANT_SECRETS_AWS_REGION?: string;
  TENANT_SECRETS_PREFIX?: string;
}

const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Request-Id",
  "Access-Control-Expose-Headers": "X-Request-Id",
};

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

async function ensureLocalTeamRegistryHydrated(request: Request, env: UnifiedEnv): Promise<void> {
  if (!env.TEAM_REGISTRY) return;
  if (!isLocalDevAuthBypassEnabled(request, env as Record<string, unknown>)) return;

  try {
    const existingSlugs = new Set(await listTeams(env.TEAM_REGISTRY));
    const envTeams = parseTeamConfigsFromEnv(env as Record<string, unknown>);
    const missingFromKv = envTeams.filter((t) => !existingSlugs.has(t.slug));

    if (missingFromKv.length === 0) return;

    try {
      const seeded = await seedTeamsFromEnv(env.TEAM_REGISTRY, env);
      if (seeded.length > 0) {
        return;
      }
    } catch (error) {
      console.warn("[local-dev] Team seed from env failed:", error);
    }

    try {
      await bootstrapTeamsFromEnvToAuthority(env.TEAM_REGISTRY, env);
    } catch (error) {
      console.warn("[local-dev] Team bootstrap from env failed:", error);
    }

    const afterBootstrap = await listTeams(env.TEAM_REGISTRY);
    if (afterBootstrap.length > 0) return;

    try {
      await reconcileRegistryFromAuthority(env.TEAM_REGISTRY, env, undefined);
    } catch (error) {
      console.warn("[local-dev] Team reconcile from authority failed:", error);
    }
  } catch (error) {
    console.warn("[local-dev] Team registry hydration failed:", error);
  }
}

function normalizeRoute(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

function requireMethod(request: Request, method: string): Response | null {
  if (request.method === method) return null;
  return json({ error: `Method ${request.method} not allowed` }, 405, { Allow: method });
}



function applyGitHubTarget(env: UnifiedEnv): void {
  setGitHubOrg(env.GITHUB_TARGET_ORG?.trim() || "postman-cs");
  setGitHubUserAgent(env.GITHUB_TARGET_USER_AGENT?.trim() || "vzw-partner-demo-worker");

  // Build token pool from primary + secondary tokens for rate limit distribution
  const tokens: string[] = [];
  const primary = typeof env.GH_TOKEN === "string" ? env.GH_TOKEN.trim() : "";
  if (primary) tokens.push(primary);
  const secondary = typeof (env as Record<string, unknown>).GH_TOKEN_SECONDARY === "string"
    ? ((env as Record<string, unknown>).GH_TOKEN_SECONDARY as string).trim()
    : "";
  if (secondary) tokens.push(secondary);
  setGitHubTokenPool(tokens);

  const parseBool = (raw: unknown): boolean => {
    const value = String(raw || "").trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "on";
  };
  const appId = String((env as Record<string, unknown>).GITHUB_APP_ID || "").trim();
  const installationId = String((env as Record<string, unknown>).GITHUB_APP_INSTALLATION_ID || "").trim();
  const privateKeyPem = String((env as Record<string, unknown>).GITHUB_APP_PRIVATE_KEY_PEM || "").trim();
  // Some deployments provide App credentials but omit/disable the explicit flag.
  // In that case, auto-enable App auth so we avoid PAT-only org restrictions.
  const appAuthEnabled = parseBool((env as Record<string, unknown>).GITHUB_APP_AUTH_ENABLED)
    || (appId.length > 0 && installationId.length > 0 && privateKeyPem.length > 0);
  setGitHubAppAuthConfig({
    enabled: appAuthEnabled,
    appId,
    installationId,
    privateKeyPem,
  });
}

function githubTargetOrg(env: UnifiedEnv): string {
  return env.GITHUB_TARGET_ORG?.trim() || "postman-cs";
}

function resolveRegistryBinding(env: UnifiedEnv): KVNamespace | null {
  if (env.SERVICE_REGISTRY) return env.SERVICE_REGISTRY;
  if (env.PORTAL_CONFIG) return env.PORTAL_CONFIG;
  return null;
}

type InfraComponent = "ecs_shared" | "k8s_discovery_shared";

interface InfraResourceDescriptor {
  provider: "aws" | "kubernetes";
  kind: string;
  name: string;
  id?: string;
  arn?: string;
  region?: string;
  url?: string;
  metadata?: Record<string, string>;
}

interface InfraResourceInventory {
  service: InfraComponent;
  status: string;
  runtime_mode: "ecs_service" | "k8s_discovery";
  generated_at: string;
  source: "airtable";
  resources: InfraResourceDescriptor[];
}

function readBearerToken(request: Request): string {
  const raw = request.headers.get("Authorization") || "";
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function isAuthorizedBackstageFeedRequest(request: Request, env: UnifiedEnv): boolean {
  const expected = (env.CATALOG_BACKSTAGE_FEED_TOKEN || "").trim();
  if (!expected) return false;
  return readBearerToken(request) === expected;
}

function listFlaggedServices(repoFlag?: string): Array<Record<string, unknown>> {
  const targetFlag = (repoFlag || SERVICE_CATALOG.default_repo_flag || "").trim();
  const services = Array.isArray(SERVICE_CATALOG.services) ? SERVICE_CATALOG.services : [];
  if (!targetFlag) {
    return services;
  }
  return services.filter((service) => String(service.repo_flag || "").trim() === targetFlag);
}

interface RepoFlagInventoryItem {
  id: string;
  title: string;
  repo_name: string;
  repo_path: string;
  repo_flag: string;
  runtime: string;
  visibility?: string;
  spec_path: string;
}

function buildRepoFlagInventory(repoFlag?: string): RepoFlagInventoryItem[] {
  return listFlaggedServices(repoFlag).map((service) => ({
    id: String(service.id || service.repo_name || service.spec_path || ""),
    title: String(service.title || service.repo_name || service.id || ""),
    repo_name: String(service.repo_name || service.id || ""),
    repo_path: String(service.repo_path || ""),
    repo_flag: String(service.repo_flag || ""),
    runtime: String(service.runtime || "lambda"),
    visibility: service.visibility ? String(service.visibility) : undefined,
    spec_path: String(service.spec_path || ""),
  }));
}

function buildDemoDeployments(): Array<Record<string, unknown>> {
  return listFlaggedServices(SERVICE_CATALOG.default_repo_flag).map((service) => {
    const runtimeMode = String(service.runtime || "lambda");
    const slug = String(service.id || service.repo_name || "service");
    const baseUrl = runtimeMode === "k8s_workspace"
      ? `https://vzw.pm-demo.dev/svc/${slug}`
      : runtimeMode === "ecs_service"
        ? `https://vzw.pm-demo.dev/runtime/${slug}`
        : `https://vzw.pm-demo.dev/lambda/${slug}`;
    return {
      spec_id: slug,
      status: "active",
      runtime_mode: runtimeMode,
      runtime_base_url: baseUrl,
      github_repo_name: service.repo_name,
      github_repo_url: `https://github.com/postman-cs/${service.repo_name}`,
      postman_workspace_url: `https://go.postman.co/workspace/${slug}`,
      aws_region: "eu-central-1",
      deployed_at: "2026-03-26T19:00:00Z",
      postman_team_slug: "verizon-partner-demo",
      fern_docs_url: service.fern_docs_url,
      mock_url: `${baseUrl}/mock`,
    };
  });
}

function mergeDemoDeployments(existing: DeploymentRecord[]): Array<Record<string, unknown>> {
  const bySpecId = new Map<string, Record<string, unknown>>();
  for (const deployment of existing) {
    bySpecId.set(String(deployment.spec_id || ""), { ...deployment });
  }
  for (const deployment of buildDemoDeployments()) {
    const specId = String(deployment.spec_id || "");
    const existingRecord = bySpecId.get(specId);
    if (!existingRecord || existingRecord.status !== "active") {
      bySpecId.set(specId, deployment);
    }
  }
  return Array.from(bySpecId.values());
}

function resolveDeploymentsForEnvironment(
  deployments: DeploymentRecord[],
  targetEnvironment: string,
): DeploymentRecord[] {
  const normalizedEnvironment = targetEnvironment.trim().toLowerCase() || "prod";
  return deployments.map((deployment) => {
    const environmentDeployments = parseEnvironmentDeploymentsJson(
      deployment.environment_deployments || "",
    );
    const match = environmentDeployments.find(
      (entry) => entry.environment.trim().toLowerCase() === normalizedEnvironment,
    );
    if (!match?.runtime_url) return deployment;
    return {
      ...deployment,
      runtime_base_url: match.runtime_url,
    };
  });
}

function sanitizeTeamConfig(
  team: TeamConfig,
): Omit<TeamConfig, "api_key" | "access_token"> & {
  has_api_key: boolean;
  has_access_token: boolean;
  detected_org_mode?: boolean;
  workspace_team_count?: number;
  workspace_teams?: Array<{ id: number; name: string; handle: string }>;
  detected_team_name?: string;
  detected_slug?: string;
  detected_team_id?: string;
} {
  return {
    slug: team.slug,
    team_id: team.team_id,
    team_name: team.team_name,
    system_env_id: team.system_env_id,
    org_mode: team.org_mode,
    has_api_key: !!team.api_key,
    has_access_token: !!team.access_token,
  };
}

function readCsv(value: string): string[] {
  return (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseArnName(arn: string): string {
  const trimmed = (arn || "").trim();
  if (!trimmed) return "";
  const slashTail = trimmed.split("/").pop() || trimmed;
  return slashTail.split(":").pop() || slashTail;
}

function buildEcsInfraResourceInventory(record: InfraRecord): InfraResourceInventory {
  const resources: InfraResourceDescriptor[] = [];
  const region = (record.aws_region || "").trim() || undefined;

  const clusterName = (record.cluster_name || "").trim();
  if (clusterName) {
    resources.push({
      provider: "aws",
      kind: "ecs_cluster",
      name: clusterName,
      id: clusterName,
      region,
    });
  }

  const vpcId = (record.vpc_id || "").trim();
  if (vpcId) {
    resources.push({
      provider: "aws",
      kind: "vpc",
      name: "Default VPC",
      id: vpcId,
      region,
    });
  }

  for (const subnetId of readCsv(record.subnet_ids || "")) {
    resources.push({
      provider: "aws",
      kind: "subnet",
      name: subnetId,
      id: subnetId,
      region,
    });
  }

  const securityGroupIds = new Set<string>([
    ...readCsv(record.security_group_ids || ""),
    ...(record.alb_sg_id ? [record.alb_sg_id.trim()] : []),
    ...(record.ecs_sg_id ? [record.ecs_sg_id.trim()] : []),
  ]);
  for (const securityGroupId of securityGroupIds) {
    if (!securityGroupId) continue;
    resources.push({
      provider: "aws",
      kind: "security_group",
      name: securityGroupId,
      id: securityGroupId,
      region,
    });
  }

  const executionRoleArn = (record.execution_role_arn || "").trim();
  if (executionRoleArn) {
    resources.push({
      provider: "aws",
      kind: "iam_role",
      name: parseArnName(executionRoleArn) || "ecs_execution_role",
      arn: executionRoleArn,
      region,
    });
  }

  const taskRoleArn = (record.task_role_arn || "").trim();
  if (taskRoleArn) {
    resources.push({
      provider: "aws",
      kind: "iam_role",
      name: parseArnName(taskRoleArn) || "ecs_task_role",
      arn: taskRoleArn,
      region,
    });
  }

  const albArn = (record.alb_arn || "").trim();
  if (albArn) {
    resources.push({
      provider: "aws",
      kind: "load_balancer",
      name: parseArnName(albArn) || "shared_alb",
      arn: albArn,
      region,
    });
  }

  const listenerArn = (record.alb_listener_arn || "").trim();
  if (listenerArn) {
    resources.push({
      provider: "aws",
      kind: "listener",
      name: parseArnName(listenerArn) || "shared_alb_listener",
      arn: listenerArn,
      region,
    });
  }

  const albDnsName = (record.alb_dns_name || "").trim();
  if (albDnsName) {
    const normalizedDns = albDnsName.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    resources.push({
      provider: "aws",
      kind: "runtime_route",
      name: "Shared ALB endpoint",
      id: normalizedDns,
      region,
      url: `https://${normalizedDns}`,
    });
  }

  const ecrRepository = (record.ecr_repository || "").trim();
  if (ecrRepository) {
    resources.push({
      provider: "aws",
      kind: "ecr_repository",
      name: ecrRepository,
      id: ecrRepository,
      region,
    });
  }

  return {
    service: "ecs_shared",
    status: (record.status || "").trim() || "unknown",
    runtime_mode: "ecs_service",
    generated_at: (record.updated_at || "").trim() || new Date().toISOString(),
    source: "airtable",
    resources,
  };
}

function buildK8sDiscoveryInfraResourceInventory(record: InfraRecord): InfraResourceInventory {
  const resources: InfraResourceDescriptor[] = [];
  const namespace = (record.k8s_namespace || "").trim() || "vzw-partner-demo";
  const daemonsetName = (record.k8s_daemonset_name || "").trim() || "postman-insights-agent";
  const clusterName = (record.k8s_cluster_name || "").trim() || "vzw-partner-demo";
  const contextName = (record.k8s_context || "").trim();
  const ingressBaseDomain = (record.alb_dns_name || "").trim();

  resources.push({
    provider: "kubernetes",
    kind: "k8s_namespace",
    name: namespace,
    id: namespace,
  });
  resources.push({
    provider: "kubernetes",
    kind: "k8s_daemonset",
    name: daemonsetName,
    id: `${namespace}/${daemonsetName}`,
    metadata: {
      namespace,
      cluster_name: clusterName,
      ...(contextName ? { context: contextName } : {}),
    },
  });
  if (ingressBaseDomain) {
    const normalizedDns = ingressBaseDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    resources.push({
      provider: "kubernetes",
      kind: "runtime_route",
      name: "Kubernetes ingress route",
      id: normalizedDns,
      url: `https://${normalizedDns}`,
      metadata: {
        namespace,
        cluster_name: clusterName,
      },
    });
  }

  return {
    service: "k8s_discovery_shared",
    status: (record.status || "").trim() || "unknown",
    runtime_mode: "k8s_discovery",
    generated_at: (record.updated_at || "").trim() || new Date().toISOString(),
    source: "airtable",
    resources,
  };
}

function buildInfraResourceInventory(record: InfraRecord, component: InfraComponent): InfraResourceInventory {
  if (component === "k8s_discovery_shared") {
    return buildK8sDiscoveryInfraResourceInventory(record);
  }
  return buildEcsInfraResourceInventory(record);
}

function workerInfo(env: UnifiedEnv): Record<string, unknown> {
  return {
    worker: "vzw-partner-demo",
    status: "ok",
    routes: [
      "GET  /api/health",
      "GET  /api/worker-logs?request_id=...",
      "GET  /api/config",
      "GET  /api/deployments",
      "POST /api/deployments",
      "GET  /api/deployments/:spec_id",
      "PATCH /api/deployments/:spec_id",
      "PATCH /api/deployments/:spec_id/dependencies",
      "POST /api/provision",
      "GET  /api/teams",
      "GET  /api/users",
      "GET  /api/github/org-members",
      "POST /api/github/webhook",
      "POST /api/teardown",
      "POST /api/teardown/batch",
      "GET  /api/status",
      "GET  /api/infra/resources",
      "POST /api/infra/setup",
      "POST /api/infra/teardown",
      "POST /api/infra/k8s-discovery/setup",
      "POST /api/infra/k8s-discovery/teardown",
      "GET  /api/resources",
      "GET  /api/resources/:service",
      "GET  /api/backstage/catalog.yaml",
      "GET  /api/catalog",
      "GET  /api/catalog/:service_id",
      "PATCH /api/catalog/:service_id/chaos",
      "GET  /api/system-envs",
    ],
    github_target_org: githubTargetOrg(env),
  };
}

function isStaticAssetPath(pathname: string): boolean {
  return /\.[a-zA-Z0-9]+$/.test(pathname);
}

function requestOrigin(request: Request, fallbackUrl: URL): string {
  const host = request.headers.get("Host") ?? request.headers.get("X-Forwarded-Host");
  if (host) return `${fallbackUrl.protocol}//${host}`;
  const origin = request.headers.get("Origin");
  if (origin) return origin;
  return fallbackUrl.origin;
}

export default {
  async fetch(request: Request, env: UnifiedEnv, ctx: ExecutionContext): Promise<Response> {
    const requestId = getRequestId(request);
    const url = new URL(request.url);
    const route = normalizeRoute(url.pathname);
    const track = (promise: Promise<unknown>) => {
      if (ctx?.waitUntil) {
        ctx.waitUntil(promise);
      } else {
        void promise;
      }
    };

    track(
      logWorkerEvent(env, {
        request_id: requestId,
        route,
        method: request.method,
        event: "request.received",
        level: "info",
        metadata: { pathname: url.pathname },
      }),
    );

    try {
      const response = await (async (): Promise<Response> => {

        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        const cfAccess = normalizeCfAccessConfig(env as Record<string, unknown>);
        const isBackstageFeedRoute = route === "/api/backstage/catalog.yaml";
        if (route === "/api/github/webhook") {
          applyGitHubTarget(env);
          const invalid = requireMethod(request, "POST");
          if (invalid) return invalid;
          return handleGitHubWebhook(request, env as Record<string, unknown>);
        }

        if (route === "/auth/logout") {
          if (cfAccess.enabled && cfAccess.logoutUrl) {
            return Response.redirect(cfAccess.logoutUrl, 302);
          }
          return Response.redirect("/", 302);
        }

        if (cfAccess.enabled && !isAuthBypassPath(route)) {
          if (isBackstageFeedRoute && isAuthorizedBackstageFeedRequest(request, env)) {
            // Dedicated machine endpoint auth (shared bearer token).
          } else {
            if (!isLocalDevAuthBypassEnabled(request, env as Record<string, unknown>)) {
              const claims = await validateCfAccessRequest(request, env as Record<string, unknown>);
              if (!claims) {
                return buildUnauthenticatedResponse(request);
              }
            }
          }
        }

        if (route.startsWith("/api/")) {
          applyGitHubTarget(env);
          const legacyEnv = env;

          switch (route) {
            case "/api/health": {
              const invalid = requireMethod(request, "GET");
              if (invalid) return invalid;
              return json({
                status: "ok",
                worker: "vzw-internal-catalog",
                airtable: isAirtableConfigured(env),
              });
            }

            case "/api/worker-logs": {
              const invalid = requireMethod(request, "GET");
              if (invalid) return invalid;
              const targetRequestId = url.searchParams.get("request_id")?.trim() || "";
              if (!targetRequestId) {
                return json({ error: "request_id is required" }, 400);
              }
              const limit = Number(url.searchParams.get("limit") || 200);
              const logs = await listWorkerLogsForRequest(env, targetRequestId, Number.isFinite(limit) ? limit : 200);
              return json({ request_id: targetRequestId, logs });
            }

            case "/api/config": {
              const invalid = requireMethod(request, "GET");
              if (invalid) return invalid;
              const teamSlug = (url.searchParams.get("team_slug") || "").trim();
              const runtime = await resolveRuntimeOptionsStatus(null, env as Record<string, unknown>, teamSlug);
              return json({
                aws_region: env.AWS_REGION || "eu-central-1",
                github_org: githubTargetOrg(env),
                github_org_url: `https://github.com/${githubTargetOrg(env)}`,
                worker_origin: env.WORKER_ORIGIN || "https://vzw.pm-demo.dev",
                internal_domain: "https://vzw.pm-demo.dev",
                partner_domain: "https://partner.vzw.pm-demo.dev",
                runtime,
              });
            }

            case "/api/docs-manifest": {
              const invalid = requireMethod(request, "GET");
              if (invalid) return invalid;
              if (!isAirtableConfigured(env)) {
                return json({ error: "Airtable not configured" }, 503);
              }
              try {
                const deployments = await listResolvedDeployments(
                  env,
                  typeof env.GH_TOKEN === "string" ? env.GH_TOKEN.trim() : "",
                );
                const manifest = buildCanonicalManifest(deployments);
                return json(manifest);
              } catch (err: unknown) {
                const e = err as Error;
                return json({ error: e.message }, 500);
              }
            }

            case "/api/public/service-map": {
              const invalid = requireMethod(request, "GET");
              if (invalid) return invalid;
              if (!isAirtableConfigured(env)) {
                return json({ error: "Airtable not configured" }, 503);
              }
              try {
                const deployments = await listResolvedDeployments(
                  env,
                  typeof env.GH_TOKEN === "string" ? env.GH_TOKEN.trim() : "",
                );
                const manifest = buildCanonicalManifest(deployments);
                return json(manifest.fernRuntimeRouteMap);
              } catch (err: unknown) {
                const e = err as Error;
                return json({ error: e.message }, 500);
              }
            }

            case "/api/partner/graphs": {
              const invalid = requireMethod(request, "GET");
              if (invalid) return invalid;

              const targetEnvironment = (url.searchParams.get("env") || "prod").trim() || "prod";
              const rawDeployments = isAirtableConfigured(env)
                ? await listDeployments(env)
                : [];
              const deployments = mergeDemoDeployments(rawDeployments) as typeof rawDeployments;
              const scopedDeployments = resolveDeploymentsForEnvironment(deployments, targetEnvironment);
              return json(getPartnerGraphsFeed(scopedDeployments));
            }

            case "/api/repo-flags": {
              const invalid = requireMethod(request, "GET");
              if (invalid) return invalid;
              const repoFlag = (url.searchParams.get("repo_flag") || SERVICE_CATALOG.default_repo_flag || "").trim();
              const repoFlagInventory = buildRepoFlagInventory(repoFlag);
              return json({
                repo_flag: repoFlag,
                available_repo_flags: SERVICE_CATALOG.available_repo_flags,
                services: repoFlagInventory,
                derived_specs: repoFlagInventory.map((service) => ({
                  id: service.id,
                  title: service.title,
                  spec_path: service.spec_path,
                  repo_path: service.repo_path,
                })),
                postman_actions: {
                  bootstrap: {
                    type: "github_action",
                    repo: "postman-cs/vzw-partner-demo",
                    path: ".github/actions/postman-bootstrap",
                    label: "Bootstrap API Resources",
                  },
                  repo_sync: {
                    type: "github_action",
                    repo: "postman-cs/vzw-partner-demo",
                    path: ".github/actions/postman-repo-sync",
                    label: "Sync Repo to Postman",
                  },
                  onboarding: {
                    type: "github_action",
                    repo: "postman-cs/vzw-partner-demo",
                    path: ".github/actions/postman-api-onboarding",
                    label: "Onboard to API Catalog",
                  },
                  insights: {
                    type: "github_action",
                    repo: "postman-cs/vzw-partner-demo",
                    path: ".github/actions/postman-insights-onboarding",
                    label: "Onboard to Insights",
                  },
                },
                airtable: {
                  configured: isAirtableConfigured(env),
                  base_id: env.AIRTABLE_BASE_ID ? String(env.AIRTABLE_BASE_ID) : "",
                },
              });
            }

            case "/api/system-envs": {
              const invalid = requireMethod(request, "GET");
              if (invalid) return invalid;
              const teamSlug = (url.searchParams.get("team_slug") || "").trim();
              try {
                const creds = await resolveTeamCredentials(env.TEAM_REGISTRY, env, teamSlug);
                const envs = await resolveSystemEnvironments(
                  creds.team_id,
                  creds.access_token,
                  env as Record<string, unknown>,
                );
                return json({ system_environments: envs, map: buildSystemEnvMap(envs) });
              } catch (err: unknown) {
                const e = err as Error;
                return json({ error: e.message, system_environments: [], map: {} }, 500);
              }
            }

            case "/api/system-envs/refresh": {
              const invalid = requireMethod(request, "POST");
              if (invalid) return invalid;
              const teamSlug = (url.searchParams.get("team_slug") || "").trim();
              try {
                const creds = await resolveTeamCredentials(env.TEAM_REGISTRY, env, teamSlug);
                const envs = await resolveSystemEnvironments(creds.team_id, creds.access_token, env as Record<string, unknown>, true);
                return json({ system_environments: envs, map: buildSystemEnvMap(envs) });
              } catch (err: unknown) {
                const e = err as Error;
                return json({ error: e.message, system_environments: [], map: {} }, 500);
              }
            }

            case "/api/deployments": {
              if (request.method === "GET") {
                if (!isAirtableConfigured(env)) {
                  return json({ deployments: [], recoverable_failures: [], error: "Airtable not configured" });
                }
                try {
                  const deployments = await listResolvedDeployments(
                    env,
                    typeof env.GH_TOKEN === "string" ? env.GH_TOKEN.trim() : "",
                  );
                  let recoverableFailures = buildRecoverableFailures(deployments);
                  const ghToken = typeof env.GH_TOKEN === "string" ? env.GH_TOKEN.trim() : "";
                  if (ghToken) {
                    recoverableFailures = await autoResolveGhostFailures(
                      recoverableFailures, deployments, ghToken, env,
                    );
                  }
                  return json({ deployments, recoverable_failures: recoverableFailures });
                } catch (err: unknown) {
                  const e = err as Error;
                  return json({ deployments: [], recoverable_failures: [], error: e.message }, 500);
                }
              }
              if (request.method === "POST") {
                if (!isAirtableConfigured(env)) {
                  return json({ error: "Airtable not configured" }, 503);
                }
                try {
                  const body = (await request.json()) as {
                    spec_id: string;
                    github_repo_url?: string;
                  };
                  const record = await createDeployment(env, {
                    spec_id: body.spec_id,
                    status: "provisioning",
                    github_repo_url: body.github_repo_url || "",
                    aws_region: env.AWS_REGION || "eu-central-1",
                    deployed_at: new Date().toISOString(),
                  });
                  return json({ deployment: record }, 201);
                } catch (err: unknown) {
                  const e = err as Error;
                  return json({ error: e.message }, 500);
                }
              }
              return json({ error: "Method not allowed" }, 405);
            }

            case "/api/provision": {
              const invalid = requireMethod(request, "POST");
              if (invalid) return invalid;
              return handleProvision(withRequestId(request, requestId), legacyEnv, null);
            }

            case "/api/provision/plan": {
              const invalid = requireMethod(request, "POST");
              if (invalid) return invalid;
              return handleProvisionPlan(request, legacyEnv);
            }

            case "/api/provision/graph": {
              if (request.method === "POST") {
                if (!env.PROVISION_GRAPH_WORKFLOW) {
                  return json({ error: "Workflow binding not configured" }, 503);
                }
                let body: Record<string, unknown>;
                try {
                  body = (await request.json()) as Record<string, unknown>;
                } catch {
                  return json({ error: "Invalid JSON body" }, 400);
                }
                const instanceId = crypto.randomUUID();
                const params = {
                  ...body,
                  postman_team_slug: typeof body.postman_team_slug === "string" ? body.postman_team_slug : undefined,
                  workspace_team_id: typeof body.workspace_team_id === "number" ? body.workspace_team_id : undefined,
                  workspace_team_name: typeof body.workspace_team_name === "string" ? body.workspace_team_name : undefined,
                  request_origin: new URL(request.url).origin,
                };
                const instance = await env.PROVISION_GRAPH_WORKFLOW.create({
                  id: instanceId,
                  params,
                });
                return json({
                  instance_id: instance.id,
                  status: "queued",
                  status_url: `/api/provision/graph/${instance.id}`,
                }, 202);
              }
              return json({ error: "Method not allowed" }, 405);
            }

            case "/api/teams": {
              const invalid = requireMethod(request, "GET");
              if (invalid) return invalid;
              const teamSlug = (url.searchParams.get("team_slug") || "").trim();
              const directApiKey = (url.searchParams.get("api_key") || "").trim();
              if (directApiKey) {
                return handleTeams(legacyEnv, directApiKey);
              }
              const creds = await resolveTeamCredentials(env.TEAM_REGISTRY, env, teamSlug);
              return handleTeams(legacyEnv, creds.api_key);
            }
            case "/api/teams/registry": {
              if (request.method === "GET") {
                if (!env.TEAM_REGISTRY) return json({ error: "TEAM_REGISTRY binding is required" }, 503);
                await ensureLocalTeamRegistryHydrated(request, env);
                const slugs = await listTeams(env.TEAM_REGISTRY);
                const teams = await Promise.all(slugs.map(async (slug) => {
                  const team = await getTeam(env.TEAM_REGISTRY as KVNamespace, slug);
                  if (!team) return null;
                  const sanitized = sanitizeTeamConfig(team);
                  const healthRaw = await (env.TEAM_REGISTRY as KVNamespace).get(`team-health:${slug}`, "json");
                  let health = (healthRaw && typeof healthRaw === "object") ? healthRaw as CredentialHealthSummary : null;
                  if (!health?.runtime_metadata && team.api_key && team.access_token) {
                    try {
                      const runtimeMetadata = await deriveTeamRuntimeMetadata({
                        api_key: team.api_key,
                        access_token: team.access_token,
                        team_id: team.team_id,
                      });
                      health = {
                        ...(health ?? { status: "unchecked", blocked: false }),
                        runtime_metadata: runtimeMetadata,
                      };
                      await (env.TEAM_REGISTRY as KVNamespace).put(`team-health:${slug}`, JSON.stringify(health));
                    } catch {
                    }
                  }
                  const runtime = health?.runtime_metadata;
                  return {
                    ...sanitized,
                    health_status: health?.status ?? "unchecked",
                    health_code: health?.code,
                    health_message: health?.message,
                    health_checked_at: health?.checked_at,
                    provisioning_blocked: health?.blocked ?? false,
                    detected_org_mode: runtime?.detected_org_mode ?? team.org_mode ?? false,
                    workspace_team_count: runtime?.workspace_team_count ?? 0,
                    workspace_teams: runtime?.workspace_teams?.map((t) => ({ id: t.id, name: t.name, handle: t.handle })) ?? [],
                    detected_team_name: runtime?.identity?.team_name ?? team.team_name,
                    detected_slug: runtime?.identity?.slug ?? team.slug,
                    detected_team_id: runtime?.identity?.team_id ?? team.team_id,
                  };
                }));
                const validTeams = teams.filter(Boolean);
                return json({ teams: validTeams });
              }
              if (request.method === "POST") {
                if (!env.TEAM_REGISTRY) return json({ error: "TEAM_REGISTRY binding is required" }, 503);
                const body = (await request.json()) as TeamConfig & { access_token?: string; api_key?: string };

                if (!body.access_token || !String(body.access_token).trim()) {
                  return json({ error: "access_token is required to register a team" }, 400);
                }

                const accessToken = String(body.access_token).trim();
                let apiKey = body.api_key ? String(body.api_key).trim() : "";

                // Step 1: Derive runtime metadata from access token to get identity
                let runtimeMetadata: TeamRuntimeMetadata;
                try {
                  runtimeMetadata = await deriveTeamRuntimeMetadata({ access_token: accessToken });
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  return json({ error: `Error deriving team identity: ${message}` }, 422);
                }

                const derivedIdentity = runtimeMetadata.identity;
                const slug = derivedIdentity.slug || body.slug;
                const teamId = derivedIdentity.team_id || body.team_id;
                const teamName = derivedIdentity.team_name || body.team_name;

                if (!slug || !teamId) {
                  return json({ error: "Could not discover team_id or slug from access token; please provide them manually." }, 400);
                }

                // Step 2: Generate API key if not provided
                if (!apiKey) {
                  try {
                    const tokenName = `catalog-demo-${slug}-${Date.now()}`;
                    const bifrostHeaders: Record<string, string> = {
                      "content-type": "application/json",
                      "x-access-token": accessToken,
                    };
                    const resp = await fetch("https://bifrost-premium-https-v4.gw.postman.com/ws/proxy", {
                      method: "POST",
                      headers: bifrostHeaders,
                      body: JSON.stringify({
                        service: "identity",
                        method: "POST",
                        path: "/api/keys",
                        body: { apikey: { name: tokenName, type: "v2" } }
                      }),
                    });

                    if (!resp.ok) {
                      const text = await resp.text();
                      return json({ error: `Failed to generate API Key via Bifrost: ${resp.status} ${text}` }, 500);
                    }
                    const data = await resp.json() as { apikey?: { key?: string } };
                    if (data?.apikey?.key) {
                      apiKey = data.apikey.key;
                    } else {
                      return json({ error: "Unexpected response from Bifrost identity service: missing apikey.key", data }, 500);
                    }
                  } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return json({ error: `Error generating API Key: ${message}` }, 500);
                  }
                }

                // Step 3: Re-derive metadata with API key to get teams list for org-mode detection
                try {
                  runtimeMetadata = await deriveTeamRuntimeMetadata({ api_key: apiKey, access_token: accessToken, team_id: teamId });
                } catch {
                  // Non-fatal: use existing metadata if re-derivation fails
                }

                // Step 4: Validate credentials match
                try {
                  const apiKeyProfile = await fetchApiKeyProfile(apiKey);
                  const accessTokenProfile = await discoverIdentityProfileFromAccessToken(accessToken, {
                    teamId,
                    orgMode: runtimeMetadata.detected_org_mode,
                  });
                  assertMatchingTeamIdentity({
                    expectedTeamId: teamId,
                    expectedSlug: slug,
                    expectedTeamName: teamName,
                    apiKeyProfile,
                    accessTokenProfile,
                  });
                  await validateAccessTokenForTeam(accessToken, {
                    teamId,
                    orgMode: runtimeMetadata.detected_org_mode,
                  });
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  return json({ error: message }, 422);
                }

                // Step 5: Build canonical team config with server-derived org_mode (ignore client-supplied)
                const teamConfig: TeamConfig = {
                  slug,
                  team_id: teamId,
                  team_name: teamName || slug,
                  api_key: apiKey,
                  access_token: accessToken,
                  system_env_id: body.system_env_id,
                  org_mode: runtimeMetadata.detected_org_mode,
                };

                const { sync } = await registerTeamWithSync(
                  env.TEAM_REGISTRY,
                  env,
                  teamConfig,
                  undefined,
                  { requestId, route, method: request.method, env },
                );

                // Step 6: Run health check with runtime metadata and store result
                try {
                  const healthCheck = await checkCredentialHealth(apiKey, accessToken, {
                    teamId,
                    orgMode: runtimeMetadata.detected_org_mode,
                  });
                  const healthWithRuntime: CredentialHealthSummary = await withRuntimeMetadata(
                    {
                      ...healthCheck,
                      runtime_metadata: runtimeMetadata,
                    },
                    { api_key: apiKey, access_token: accessToken, team_id: teamId },
                  );
                  await (env.TEAM_REGISTRY as KVNamespace).put(`team-health:${slug}`, JSON.stringify(healthWithRuntime));
                } catch { /* best effort */ }

                // Step 7: Return sanitized config with derived fields
                const sanitized = sanitizeTeamConfig(teamConfig);
                const responseTeam = {
                  ...sanitized,
                  detected_org_mode: runtimeMetadata.detected_org_mode,
                  workspace_team_count: runtimeMetadata.workspace_team_count,
                  workspace_teams: runtimeMetadata.workspace_teams.map((t) => ({ id: t.id, name: t.name, handle: t.handle })),
                  detected_team_name: runtimeMetadata.identity.team_name,
                  detected_slug: runtimeMetadata.identity.slug,
                  detected_team_id: runtimeMetadata.identity.team_id,
                };

                return json({ ok: true, team: responseTeam, sync }, 201);
              }
              return json({ error: "Method not allowed" }, 405);
            }

            case "/api/users": {
              const invalid = requireMethod(request, "GET");
              if (invalid) return invalid;
              const teamSlug = (url.searchParams.get("team_slug") || "").trim();
              const creds = await resolveTeamCredentials(env.TEAM_REGISTRY, env, teamSlug);
              return handleUsers(legacyEnv, creds.api_key);
            }

            case "/api/github/org-members": {
              const invalid = requireMethod(request, "GET");
              if (invalid) return invalid;
              return handleGitHubOrgMembers(legacyEnv);
            }

            case "/api/teardown": {
              const invalid = requireMethod(request, "POST");
              if (invalid) return invalid;
              return handleTeardown(request, legacyEnv, ctx);
            }

            case "/api/teardown/batch": {
              const invalid = requireMethod(request, "POST");
              if (invalid) return invalid;
              return handleBatchTeardown(request, legacyEnv, ctx);
            }

            case "/api/status": {
              const invalid = requireMethod(request, "GET");
              if (invalid) return invalid;
              return handleStatus(request, legacyEnv);
            }

            case "/api/infra/resources": {
              const invalid = requireMethod(request, "GET");
              if (invalid) return invalid;
              if (!isAirtableConfigured(env)) {
                return json({ error: "Airtable not configured" }, 503);
              }
              const componentRaw = (url.searchParams.get("component") || "").trim();
              const component: InfraComponent = componentRaw === "k8s_discovery_shared"
                ? "k8s_discovery_shared"
                : "ecs_shared";
              const record = await getInfraRecord(env, component);
              if (!record) {
                return json({ error: "Shared infrastructure record not found" }, 404);
              }
              return json({ resource: buildInfraResourceInventory(record, component) });
            }

            case "/api/infra/setup": {
              const invalid = requireMethod(request, "POST");
              if (invalid) return invalid;
              return handleInfraSetup(request, legacyEnv);
            }

            case "/api/infra/teardown": {
              const invalid = requireMethod(request, "POST");
              if (invalid) return invalid;
              return handleInfraTeardown(request, legacyEnv);
            }

            case "/api/infra/k8s-discovery/setup": {
              const invalid = requireMethod(request, "POST");
              if (invalid) return invalid;
              return handleK8sDiscoveryInfraSetup(request, legacyEnv);
            }

            case "/api/infra/k8s-discovery/teardown": {
              const invalid = requireMethod(request, "POST");
              if (invalid) return invalid;
              return handleK8sDiscoveryInfraTeardown(request, legacyEnv);
            }

            case "/api/resources": {
              const invalid = requireMethod(request, "GET");
              if (invalid) return invalid;
              if (!isAirtableConfigured(env)) {
                return json({ error: "Airtable not configured" }, 503);
              }
              try {
                const deployments = await listResolvedDeployments(
                  env,
                  typeof env.GH_TOKEN === "string" ? env.GH_TOKEN.trim() : "",
                );
                const resources = deployments
                  .filter((deployment) => deployment.status !== "failed")
                  .map((deployment) => buildResourceInventory(deployment, env));
                return json({ resources, total: resources.length });
              } catch (err: unknown) {
                const e = err as Error;
                return json({ resources: [], total: 0, error: e.message }, 500);
              }
            }

            case "/api/backstage/catalog.yaml": {
              const invalid = requireMethod(request, "GET");
              if (invalid) return invalid;
              if (!isAuthorizedBackstageFeedRequest(request, env)) {
                return json({ error: "Unauthorized" }, 401);
              }
              if (!isAirtableConfigured(env)) {
                return json({ error: "Airtable not configured" }, 503);
              }

              try {
                const deployments = await listResolvedDeployments(
                  env,
                  typeof env.GH_TOKEN === "string" ? env.GH_TOKEN.trim() : "",
                );
                const scope = url.searchParams.get("scope") === "active" ? "active" : "all";
                const yaml = await buildBackstageCatalogYaml({
                  deployments,
                  env: env as Record<string, unknown>,
                  requestOrigin: url.origin,
                  scope,
                });
                return new Response(yaml, {
                  status: 200,
                  headers: {
                    "Content-Type": "text/yaml; charset=utf-8",
                    "Cache-Control": "private, max-age=300",
                    ...CORS_HEADERS,
                  },
                });
              } catch (err: unknown) {
                const e = err as Error;
                return json({ error: e.message || "Failed to build Backstage feed" }, 500);
              }
            }

            case "/api/catalog": {
              const invalid = requireMethod(request, "GET");
              if (invalid) return invalid;
              const registry = resolveRegistryBinding(env);
              if (!registry) return json({ error: "SERVICE_REGISTRY binding is required" }, 503);
              const query = normalizeCatalogQuery(url);
              const result = await listServiceRecords(registry, query);
              return json(result);
            }

            case "/api/validate-key": {
              const invalid = requireMethod(request, "POST");
              if (invalid) return invalid;
              const body = (await request.json()) as { api_key?: string };
              const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
              if (!apiKey) return json({ error: "api_key is required" }, 400);
              try {
                const profile = await fetchApiKeyProfile(apiKey);
                return json({ valid: true, team_id: profile.team_id, team_name: profile.team_name, slug: profile.slug });
              } catch {
                return json({ valid: false }, 200);
              }
            }

            default: {
              if (route.startsWith("/api/provision/graph/")) {
                const instanceId = decodeURIComponent(route.slice("/api/provision/graph/".length));
                const invalid = requireMethod(request, "GET");
                if (invalid) return invalid;

                const accountId = String((env as Record<string, unknown>).CF_ACCOUNT_ID || "").trim();
                const email = String((env as Record<string, unknown>).CF_EMAIL || "").trim();
                const apiKey = String((env as Record<string, unknown>).CF_API_KEY || "").trim();

                if (accountId && email && apiKey) {
                  try {
                    const result = await fetchWorkflowStatusFromCfApi(
                      instanceId,
                      accountId,
                      email,
                      apiKey,
                      async (params) => {
                        if (!isAirtableConfigured(env)) return null;
                        const deployments = await listDeployments(env);
                        return createDependencyPlan({
                          rootSpecId: params.spec_source,
                          runtime: params.runtime as RuntimeMode,
                          environments: params.environments,
                          deploymentMode: "graph",
                          dependencies: DEPENDENCIES,
                          deployments,
                        }).nodes;
                      },
                    );
                    return json(result);
                  } catch (err: unknown) {
                    const e = err as Error;
                    return json({ error: e.message }, 500);
                  }
                }

                if (env.PROVISION_GRAPH_WORKFLOW) {
                  try {
                    const instance = await env.PROVISION_GRAPH_WORKFLOW.get(instanceId);
                    const wfStatus = await instance.status();
                    const result: Record<string, unknown> = {
                      instance_id: instanceId,
                      workflow_status: wfStatus.status,
                      status: wfStatus.status === "complete" ? "complete" : wfStatus.status === "errored" ? "error" : "running",
                      completed_nodes: [],
                      failed_node: null,
                      failed_message: wfStatus.error || null,
                      current_node: null,
                      current_layer: -1,
                    };
                    if (wfStatus.error) result.failed_message = wfStatus.error;
                    return json(result);
                  } catch {
                    return json({ instance_id: instanceId, workflow_status: "unknown" });
                  }
                }

                return json({ error: "Workflow status not configured (set CF_ACCOUNT_ID, CF_EMAIL, CF_API_KEY)" }, 503);
              }

              if (route.startsWith("/api/resources/")) {
                const invalid = requireMethod(request, "GET");
                if (invalid) return invalid;
                if (!isAirtableConfigured(env)) {
                  return json({ error: "Airtable not configured" }, 503);
                }
                const service = decodeURIComponent(route.slice("/api/resources/".length));
                const deployment = await getDeployment(env, service);
                if (!deployment || deployment.status === "failed") {
                  return json({ error: "Not found" }, 404);
                }
                return json({ resource: buildResourceInventory(deployment, env) });
              }

              if (route.startsWith("/api/catalog/")) {
                if (route.endsWith("/chaos")) {
                  const serviceId = decodeURIComponent(route.slice("/api/catalog/".length, -"/chaos".length));
                  if (request.method !== "PATCH") {
                    return json({ error: `Method ${request.method} not allowed` }, 405, { Allow: "PATCH" });
                  }
                  if (!isAirtableConfigured(env)) {
                    return json({ error: "Airtable not configured" }, 503);
                  }
                  try {
                    const body = (await request.json()) as { enabled?: unknown; environment?: unknown };
                    if (typeof body.enabled !== "boolean") {
                      return json({ error: "enabled boolean is required" }, 400);
                    }
                    const environment =
                      typeof body.environment === "string" && body.environment.trim()
                        ? body.environment.trim()
                        : undefined;
                    const result = await toggleServiceChaos(serviceId, body.enabled, env as ProvisioningEnv, environment);
                    return json(result);
                  } catch (err: unknown) {
                    const e = err as Error;
                    return json({ error: e.message }, 500);
                  }
                }

                const invalid = requireMethod(request, "GET");
                if (invalid) return invalid;
                const registry = resolveRegistryBinding(env);
                if (!registry) return json({ error: "SERVICE_REGISTRY binding is required" }, 503);
                const serviceId = decodeURIComponent(route.slice("/api/catalog/".length));
                const record = await getServiceRecord(registry, serviceId);
                if (!record) return json({ error: "Service not found" }, 404);
                return json({ service: record });
              }

              if (route.match(/^\/api\/partner\/services\/[^/]+\/live$/)) {
                const invalid = requireMethod(request, "GET");
                if (invalid) return invalid;

                const serviceId = decodeURIComponent(route.slice("/api/partner/services/".length, -"/live".length));
                if (!serviceId) return json({ error: "service_id is required" }, 400);

                const targetEnvironment = (url.searchParams.get("env") || "prod").trim() || "prod";
                const rawDeployments = isAirtableConfigured(env)
                  ? await listDeployments(env)
                  : [];
                const deployments = mergeDemoDeployments(rawDeployments) as typeof rawDeployments;
                const scopedDeployments = resolveDeploymentsForEnvironment(deployments, targetEnvironment);
                const detail = getPartnerServiceDetail(serviceId, scopedDeployments);
                if (!detail) return json({ error: "Service not found" }, 404);

                const corsHeaders = new Headers({
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                  "Access-Control-Allow-Methods": "GET, OPTIONS",
                  "Access-Control-Allow-Headers": "Content-Type",
                  "Cache-Control": "public, max-age=30, stale-while-revalidate=120",
                });

                return new Response(JSON.stringify(detail), { status: 200, headers: corsHeaders });
              }

              if (route.startsWith("/api/partner/services/")) {
                const invalid = requireMethod(request, "GET");
                if (invalid) return invalid;

                const serviceId = decodeURIComponent(route.slice("/api/partner/services/".length));
                if (!serviceId) return json({ error: "service_id is required" }, 400);

                const targetEnvironment = (url.searchParams.get("env") || "prod").trim() || "prod";
                const rawDeployments = isAirtableConfigured(env)
                  ? await listDeployments(env)
                  : [];
                const deployments = mergeDemoDeployments(rawDeployments) as typeof rawDeployments;
                const scopedDeployments = resolveDeploymentsForEnvironment(deployments, targetEnvironment);
                const detail = getPartnerServiceDetail(serviceId, scopedDeployments);
                if (!detail) return json({ error: "Service not found" }, 404);
                return json(detail);
              }

              if (route.startsWith("/api/deployments/")) {
                if (route.endsWith("/dependencies") && request.method === "PATCH") {
                  if (!isAirtableConfigured(env)) {
                    return json({ error: "Airtable not configured" }, 503);
                  }
                  const specId = decodeURIComponent(route.slice("/api/deployments/".length, -"/dependencies".length));
                  try {
                    const deployment = await getDeployment(env, specId);
                    if (!deployment?.id) return json({ error: "Deployment not found" }, 404);
                    if (!deployment.github_repo_name) return json({ error: "Deployment has no GitHub repository" }, 400);

                    const githubAppToken = typeof env.GH_TOKEN === "string" ? env.GH_TOKEN.trim() : "";
                    const environments = JSON.parse(deployment.environments_json || '["prod"]');

                    const depTargetsJson = await resolveDependencyTargets({
                      specId: deployment.spec_id,
                      projectName: deployment.spec_id, // Best effort if project_name not in record
                      repoName: deployment.github_repo_name,
                      runtimeMode: deployment.runtime_mode || "k8s_workspace",
                      environments,
                      k8sIngressBaseDomain: env.K8S_INGRESS_BASE_DOMAIN,
                      k8sNamespace: env.K8S_NAMESPACE || "vzw-partner-demo",
                      githubAppToken,
                      env: env,
                    });

                    // Ensure the refresh workflow exists in the repo
                    await appendCommit(githubAppToken, deployment.github_repo_name, [
                      { path: ".github/workflows/refresh-dependencies.yml", content: REFRESH_DEPENDENCIES_WORKFLOW_CONTENT }
                    ], "chore: inject dependency refresh workflow");

                    await triggerWorkflow(githubAppToken, deployment.github_repo_name, "refresh-dependencies.yml", {
                      project_name: deployment.spec_id,
                      runtime_mode: deployment.runtime_mode || "k8s_workspace",
                      environments: JSON.stringify(environments),
                      dependency_targets_json: depTargetsJson,
                    });

                    return json({ ok: true, message: "Dependency refresh triggered" });
                  } catch (err: unknown) {
                    const e = err as Error;
                    return json({ error: e.message }, 500);
                  }
                }

                const specId = decodeURIComponent(route.slice("/api/deployments/".length));
                if (request.method === "PATCH") {
                  if (!isAirtableConfigured(env)) {
                    return json({ error: "Airtable not configured" }, 503);
                  }
                  try {
                    const body = (await request.json()) as Record<string, unknown>;
                    const existing = await getDeployment(env, specId);
                    if (!existing?.id) return json({ error: "Deployment not found" }, 404);
                    await updateDeployment(env, existing.id, body);
                    return json({ ok: true });
                  } catch (err: unknown) {
                    const e = err as Error;
                    return json({ error: e.message }, 500);
                  }
                }
                if (request.method === "GET") {
                  if (!isAirtableConfigured(env)) {
                    return json({ error: "Airtable not configured" }, 503);
                  }
                  const record = await getResolvedDeployment(
                    env,
                    specId,
                    typeof env.GH_TOKEN === "string" ? env.GH_TOKEN.trim() : "",
                  );
                  if (!record) return json({ error: "Not found" }, 404);
                  return json({ deployment: record });
                }
              }

              if (route === "/api/teams/registry/reconcile") {
                if (!env.TEAM_REGISTRY) return json({ error: "TEAM_REGISTRY binding is required" }, 503);
                const invalid = requireMethod(request, "POST");
                if (invalid) return invalid;
                const result = await reconcileRegistryFromAuthority(
                  env.TEAM_REGISTRY,
                  env,
                  undefined,
                  { requestId, route, method: request.method, env },
                );
                return json({ result });
              }

              if (route.startsWith("/api/teams/registry/")) {
                if (!env.TEAM_REGISTRY) return json({ error: "TEAM_REGISTRY binding is required" }, 503);
                const subPath = route.slice("/api/teams/registry/".length);

                // Health endpoints: /api/teams/registry/:slug/health and /health/recheck
                const healthMatch = subPath.match(/^([^/]+)\/health(\/recheck)?$/);
                if (healthMatch) {
                  const slug = decodeURIComponent(healthMatch[1]);
                  const isRecheck = !!healthMatch[2];
                  if (isRecheck) {
                    const invalid = requireMethod(request, "POST");
                    if (invalid) return invalid;
                    const team = await getTeam(env.TEAM_REGISTRY, slug);
                    if (!team) return json({ error: "Team not found" }, 404);
                    if (!team.api_key || !team.access_token) {
                      return json({ error: "Team is missing credentials" }, 400);
                    }
                    const existingHealthRaw = await (env.TEAM_REGISTRY as KVNamespace).get(`team-health:${slug}`, "json");
                    const existingHealth = (existingHealthRaw && typeof existingHealthRaw === "object")
                      ? existingHealthRaw as CredentialHealthSummary
                      : undefined;
                    const health = await checkCredentialHealth(team.api_key, team.access_token, {
                      teamId: team.team_id,
                      orgMode: existingHealth?.runtime_metadata?.detected_org_mode ?? team.org_mode,
                    });
                    const healthWithRuntime: CredentialHealthSummary = await withRuntimeMetadata(
                      {
                        ...health,
                        runtime_metadata: existingHealth?.runtime_metadata,
                      },
                      {
                        api_key: team.api_key,
                        access_token: team.access_token,
                        team_id: team.team_id,
                      },
                    );
                    await (env.TEAM_REGISTRY as KVNamespace).put(`team-health:${slug}`, JSON.stringify(healthWithRuntime));
                    return json({ health: healthWithRuntime });
                  }
                  const invalid = requireMethod(request, "GET");
                  if (invalid) return invalid;
                  const healthRaw = await (env.TEAM_REGISTRY as KVNamespace).get(`team-health:${slug}`, "json");
                  return json({ health: healthRaw ?? { status: "unchecked" } });
                }

                const slug = decodeURIComponent(subPath);
                if (!slug) return json({ error: "team slug is required" }, 400);
                if (request.method === "DELETE") {
                  const { deleted, sync } = await deleteTeamWithSync(
                    env.TEAM_REGISTRY,
                    env,
                    slug,
                    undefined,
                    {},
                    { requestId, route, method: request.method, env },
                  );
                  if (deleted) {
                    await (env.TEAM_REGISTRY as KVNamespace).delete(`team-health:${slug}`);
                  }
                  return json({ ok: deleted, sync });
                }
                if (request.method === "PATCH") {
                  const existing = await getTeam(env.TEAM_REGISTRY, slug);
                  if (!existing) return json({ error: "Team not found" }, 404);
                  const body = (await request.json()) as Partial<TeamConfig>;
                  const existingHealthRaw = await (env.TEAM_REGISTRY as KVNamespace).get(`team-health:${existing.slug}`, "json");
                  const existingHealth = (existingHealthRaw && typeof existingHealthRaw === "object")
                    ? existingHealthRaw as CredentialHealthSummary
                    : undefined;
                  try {
                    const validateApiKey = typeof body.api_key === "string" && body.api_key.trim();
                    const validateAccessToken = typeof body.access_token === "string" && body.access_token.trim();
                    const apiKeyProfile = validateApiKey ? await fetchApiKeyProfile(body.api_key!) : undefined;
                    const accessTokenProfile = (validateApiKey || validateAccessToken)
                      ? await discoverIdentityProfileFromAccessToken(body.access_token || existing.access_token, {
                        teamId: existing.team_id,
                        orgMode: existingHealth?.runtime_metadata?.detected_org_mode ?? existing.org_mode,
                      })
                      : undefined;
                    assertMatchingTeamIdentity({
                      expectedTeamId: existing.team_id,
                      expectedSlug: existing.slug,
                      expectedTeamName: body.team_name || existing.team_name,
                      apiKeyProfile,
                      accessTokenProfile,
                    });
                    if (validateAccessToken) {
                      await validateAccessTokenForTeam(body.access_token!, {
                        teamId: existing.team_id,
                        orgMode: existingHealth?.runtime_metadata?.detected_org_mode ?? existing.org_mode,
                      });
                    }
                  } catch (err) {
                    return json({ error: err instanceof Error ? err.message : String(err) }, 422);
                  }
                  const result = await updateTeamWithSync(
                    env.TEAM_REGISTRY,
                    env,
                    slug,
                    body,
                    undefined,
                    { requestId, route, method: request.method, env },
                  );
                  if (!result) return json({ error: "Team not found" }, 404);
                  const { team: merged, sync } = result;

                  // Refresh health after credential update
                  try {
                    const existingHealthRaw = await (env.TEAM_REGISTRY as KVNamespace).get(`team-health:${merged.slug}`, "json");
                    const existingHealth = (existingHealthRaw && typeof existingHealthRaw === "object")
                      ? existingHealthRaw as CredentialHealthSummary
                      : undefined;
                    const health = await checkCredentialHealth(merged.api_key, merged.access_token, {
                      teamId: merged.team_id,
                      orgMode: existingHealth?.runtime_metadata?.detected_org_mode ?? merged.org_mode,
                    });
                    const healthWithRuntime = await withRuntimeMetadata(
                      {
                        ...health,
                        runtime_metadata: existingHealth?.runtime_metadata,
                      },
                      {
                        api_key: merged.api_key,
                        access_token: merged.access_token,
                        team_id: merged.team_id,
                      },
                    );
                    await (env.TEAM_REGISTRY as KVNamespace).put(`team-health:${merged.slug}`, JSON.stringify(healthWithRuntime));
                  } catch { /* best effort */ }

                  return json({ team: sanitizeTeamConfig(merged), sync });
                }
                return json({ error: "Method not allowed" }, 405);
              }

              return json({ error: "Not found" }, 404);
            }
          }
        }

        if (request.method !== "GET" && request.method !== "HEAD") {
          return json({ error: `Method ${request.method} not allowed` }, 405, {
            Allow: "GET, HEAD",
          });
        }

        if (!env.ASSETS) {
          if (route !== "/" && !isStaticAssetPath(route)) {
            const rootUrl = new URL("/", requestOrigin(request, url));
            const rootRequest = new Request(rootUrl.toString(), request);
            try {
              const rootResponse = await fetch(rootRequest);
              const contentType = rootResponse.headers.get("Content-Type") || "";
              if (rootResponse.ok && contentType.includes("text/html")) {
                return rootResponse;
              }
            } catch (error) {
              track(
                logWorkerEvent(env, {
                  request_id: requestId,
                  route,
                  method: request.method,
                  event: "assets.root_fetch_failed",
                  level: "warn",
                  message: error instanceof Error ? error.message : String(error),
                }),
              );
            }
          }
          return json(workerInfo(env), 503);
        }

        let directAssetResponse: Response;
        try {
          directAssetResponse = await env.ASSETS.fetch(request);
        } catch (error) {
          track(
            logWorkerEvent(env, {
              request_id: requestId,
              route,
              method: request.method,
              event: "assets.direct_fetch_failed",
              level: "warn",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
          return json(workerInfo(env), 503);
        }
        if (directAssetResponse.status !== 404) {
          return directAssetResponse;
        }

        if (isStaticAssetPath(route)) {
          return directAssetResponse;
        }

        const rootUrl = new URL("/", requestOrigin(request, url));
        const rootRequest = new Request(rootUrl.toString(), request);
        try {
          return await env.ASSETS.fetch(rootRequest);
        } catch (error) {
          track(
            logWorkerEvent(env, {
              request_id: requestId,
              route,
              method: request.method,
              event: "assets.spa_fallback_fetch_failed",
              level: "warn",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
          return json(workerInfo(env), 503);
        }
      })();

      track(
        logWorkerEvent(env, {
          request_id: requestId,
          route,
          method: request.method,
          event: "request.completed",
          level: response.status >= 500 ? "error" : "info",
          metadata: { status: response.status },
        }),
      );

      return withRequestIdHeader(response, requestId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      track(
        logWorkerEvent(env, {
          request_id: requestId,
          route,
          method: request.method,
          event: "request.failed",
          level: "error",
          message,
        }),
      );
      return withRequestIdHeader(json({ error: message }, 500), requestId);
    }
  },

  async scheduled(event: ScheduledEvent, env: UnifiedEnv, ctx: ExecutionContext) {
    if (!env.TEAM_REGISTRY) return;
    const isDaily = String(event.cron).startsWith("47");

    ctx.waitUntil(
      (async () => {
        // Bootstrap env vars -> SM -> KV
        try {
          const seeded = await bootstrapTeamsFromEnvToAuthority(env.TEAM_REGISTRY!, env);
          if (seeded.length > 0) {
            console.log(`[scheduled] Bootstrapped ${seeded.length} teams from env to authority: ${seeded.join(", ")}`);
          }
        } catch (err) {
          console.error("[scheduled] Team env bootstrap failed:", err);
        }

        // Reconcile SM -> KV (prune orphans)
        try {
          const result = await reconcileRegistryFromAuthority(env.TEAM_REGISTRY!, env, undefined);
          console.log(`[scheduled] Registry reconciliation: ${result.activeSlugs.length} active, ${result.prunedSlugs.length} pruned`);
          if (result.prunedSlugs.length > 0) {
            console.log(`[scheduled] Pruned teams: ${result.prunedSlugs.join(", ")}`);
          }
          if (result.errors.length > 0) {
            console.warn(`[scheduled] Reconciliation errors: ${result.errors.join("; ")}`);
          }
        } catch (err) {
          console.error("[scheduled] Registry reconciliation failed:", err);
        }

        // Daily: refresh credential health for all teams
        if (isDaily) {
          try {
            const slugs = await listTeams(env.TEAM_REGISTRY!);
            for (const slug of slugs) {
              const team = await getTeam(env.TEAM_REGISTRY!, slug);
              if (!team?.api_key || !team?.access_token) continue;
              const existingHealthRaw = await env.TEAM_REGISTRY!.get(`team-health:${slug}`, "json");
              const existingHealth = (existingHealthRaw && typeof existingHealthRaw === "object")
                ? existingHealthRaw as CredentialHealthSummary
                : undefined;
              const health = await checkCredentialHealth(team.api_key, team.access_token, {
                teamId: team.team_id,
                orgMode: existingHealth?.runtime_metadata?.detected_org_mode ?? team.org_mode,
              });
              const healthWithRuntime = await withRuntimeMetadata(
                {
                  ...health,
                  runtime_metadata: existingHealth?.runtime_metadata,
                },
                {
                  api_key: team.api_key,
                  access_token: team.access_token,
                  team_id: team.team_id,
                },
              );
              await env.TEAM_REGISTRY!.put(
                `team-health:${slug}`,
                JSON.stringify(healthWithRuntime),
              );
            }
            console.log(`[scheduled] Health refresh completed for ${slugs.length} teams`);
          } catch (err) {
            console.error("[scheduled] Health refresh failed:", err);
          }
        }
      })(),
    );
  },
};
