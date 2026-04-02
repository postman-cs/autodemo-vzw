// POST /api/provision handler
// Creates repo, pushes files, injects secrets, triggers workflow, streams SSE

import type { ProvisioningEnv as Env } from "./provisioning-env";
import { sleep } from "./sleep";
import {
  createRepo,
  repoExists,
  addCollaborator,
  lookupUser,
  appendCommit,
  createBranchIfMissing,
  createRepoSecrets,
  triggerWorkflow,
  getLatestWorkflowRun,
  getWorkflowRunById,
  getWorkflowJobs,
  getOrg,
  normalizeGitHubToken,
  setGitHubOrg,
  setGitHubUserAgent,
  deleteRepo,
  listRepoVariables,
  getRepoVariable,
} from "./github";
import {
  createDeployment,
  updateDeployment,
  insertDeployment,
  getDeployment,
  listDeployments,
  isAirtableConfigured,
  supportsGraphMembershipsTable,
  getActiveDiscoveryUsedPorts,
  type DeploymentRecord,
  upsertGraphMembership,
} from "./airtable";
import { SSEWriter, type SSEEvent } from "./sse";
import { fetchBoilerplate, generateGitignore, generateEnvExample } from "./boilerplate";
import { generateProvisionWorkflow, generateFernConfig, REFRESH_DEPENDENCIES_WORKFLOW_CONTENT } from "./provision-workflow";
import {
  PROVISION_PHASE_LAST_STEPS,
  PROVISION_STEP_DESCRIPTIONS,
  PROVISION_STEP_PHASE_MAP,
} from "./provision-steps";
import {
  isContainerRuntime,
  isKubernetesRuntime,
  normalizePortalConfig,
  normalizeRuntimeMode,
} from "./config";
import type { PortalConfig, RuntimeMode } from "./config";
import { generateFlaskRoutes } from "./spec-to-flask";
import { buildDerivedResourceInventory } from "./resource-inventory";
import { resolveRuntimeOptionsStatus } from "./runtime-options";
import { runAwsCleanupWorkflow } from "./teardown";
import { acknowledgeWorkspaceWithRetry } from "./insights-onboarding";
import {
  resolveSystemEnvironments,
  buildSystemEnvMap,
  type SystemEnvironment,
  type SystemEnvMap,
} from "./system-envs";
import {
  parseEnvironmentDeploymentsJson,
  type EnvironmentDeploymentRecord,
} from "./environment-deployments";
import { getEnvironmentBranchMap } from "./environment-branches";
import {
  SHARED_ORG_SECRET_NAMES,
  resolveProvisionFeatureFlags,
  resolveCredentialSourcePolicy,
  buildSecretInjectionPlan,
  type ProvisionFeatureFlags,
} from "./provision-credential-policy";
import { setRepoVarRespectingOrgScope } from "./provision-variable-scope";
import { streamRunProgressFromCallbacks } from "./provision-webhooks";
import { getRequestId, logWorkerEvent } from "./worker-logs";
import { resolveTeamCredentials } from "./team-registry";
import {
  areGraphRuntimeCompatible,
  createDependencyPlan,
  DependencyPlannerError,
  type DependencyMap,
  type DeploymentMode,
  type PlannedNode,
} from "./dependency-planner";
import { executeGraphPlan } from "./provision-graph";
import { buildFinalDeploymentSnapshot } from "./deployment-success";
import {
  getResolvedDeployment,
  hasRepoProvisionDriftSignal,
  listResolvedDeployments,
  reconcileSuccessfulDeploymentRecord,
} from "./deployment-state";
import { resolveDependencyTargets } from "./dependency-resolver";
import registry from "../../specs/registry.json";
import dependenciesRaw from "../../specs/dependencies.json";

const DEPENDENCIES = dependenciesRaw as DependencyMap;

interface ProvisionRequest {
  project_name: string;
  domain: string;
  workspace_name?: string;
  application_id?: string;
  requester_email: string;
  product_code?: string;
  environments?: string[];
  spec_source?: string;
  spec_url?: string;
  spec_hub_url?: string;
  spec_content?: string;
  aws_account_id?: string;
  postman_team_id?: string;
  postman_team_slug?: string;
  template?: string;
  template_id?: string;
  runtime?: RuntimeMode;
  workspace_admin_ids?: string[];
  connect_git?: boolean | string;
  github_workspace_sync?: boolean | string;
  environment_sync_enabled?: boolean | string;
  chaos_enabled?: boolean | string;
  chaos_config?: string;
  k8s_discovery_workspace_link?: boolean | string;
  deployment_mode?: DeploymentMode | string;
  workspace_team_id?: number;
  workspace_team_name?: string;
  deployment_group_id?: string;
  deployment_root_spec_id?: string;
  graph_node_layer_index?: number;
  graph_node_environment?: string;
}

interface ProvisionPlanRequest {
  spec_source?: string;
  runtime?: RuntimeMode;
  environments?: string[];
  deployment_mode?: DeploymentMode | string;
}

function resolveEffectivePostmanTeamSelection(
  req: Pick<ProvisionRequest, "postman_team_id" | "postman_team_slug">,
  creds: { team_id: string; slug?: string | null },
): { teamId: string; teamSlug: string } {
  const requestedTeamId = String(req.postman_team_id || "").trim();
  const requestedTeamSlug = String(req.postman_team_slug || "").trim();

  if (requestedTeamSlug) {
    if (requestedTeamId && requestedTeamId !== creds.team_id) {
      throw new Error(
        `Requested postman_team_id '${requestedTeamId}' does not match team slug '${requestedTeamSlug}' (resolved team_id='${creds.team_id}')`,
      );
    }
    return {
      teamId: creds.team_id,
      teamSlug: requestedTeamSlug,
    };
  }

  return {
    teamId: requestedTeamId || creds.team_id,
    teamSlug: requestedTeamSlug || String(creds.slug || "").trim(),
  };
}

type ProvisionRuntime = "lambda" | "ecs_service" | "k8s_workspace" | "k8s_discovery";

// Single source of truth for step-to-phase mapping lives in provision-steps.ts.
const STEP_DESCRIPTIONS = PROVISION_STEP_DESCRIPTIONS;
const STEP_PHASE_MAP = PROVISION_STEP_PHASE_MAP;
const PHASE_LAST_STEP = PROVISION_PHASE_LAST_STEPS;

export function shouldUseCallbackWatchdogOnly(args: {
  callbacksEnabled: boolean;
  callbackState: { status: string; conclusion: string | null; html_url: string } | null;
  callbackError: string | null;
  lastCallbackUpdateAt: number;
  watchdogIntervalMs: number;
  now?: number;
}): boolean {
  const now = args.now ?? Date.now();
  return Boolean(
    args.callbacksEnabled
    && !args.callbackError
    && args.callbackState
    && args.callbackState.status !== "completed"
    && args.lastCallbackUpdateAt > 0
    && (now - args.lastCallbackUpdateAt) < args.watchdogIntervalMs,
  );
}

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
const SPEC_REGISTRY_BY_FILENAME = new Map<string, RegistrySpecEntry>(
  SPEC_REGISTRY.map((entry) => [entry.filename.trim().toLowerCase(), entry])
);

function looksLikeOpenApiSpec(content: string): boolean {
  return (
    content.includes("openapi") &&
    content.includes("paths")
  );
}

function normalizeSpecUrl(raw?: string): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

async function fetchSpecFromUrl(specUrl: string): Promise<string> {
  const response = await fetch(specUrl, {
    headers: {
      "User-Agent": "vzw-partner-demo-worker",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch spec URL (${response.status}): ${specUrl}`);
  }

  const content = (await response.text()).trim();
  if (!content) {
    throw new Error(`Fetched spec URL was empty: ${specUrl}`);
  }
  if (!looksLikeOpenApiSpec(content)) {
    throw new Error(`Fetched URL does not look like an OpenAPI spec: ${specUrl}`);
  }

  return content;
}

async function fetchSpecFromAssets(specUrl: string, env: Pick<Env, "ASSETS"> | null | undefined): Promise<Response | null> {
  if (!env?.ASSETS) return null;
  return env.ASSETS.fetch(new Request(specUrl, {
    method: "GET",
    headers: {
      "User-Agent": "vzw-partner-demo-worker",
    },
  }));
}

function validateFetchedSpec(content: string, specUrl: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error(`Fetched spec URL was empty: ${specUrl}`);
  }
  if (!looksLikeOpenApiSpec(trimmed)) {
    throw new Error(`Fetched URL does not look like an OpenAPI spec: ${specUrl}`);
  }
  return trimmed;
}

function parseSpecFilenameFromUrl(specUrl: string): string | null {
  try {
    const parsed = new URL(specUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const specsIdx = segments.indexOf("specs");
    if (specsIdx < 0 || specsIdx === segments.length - 1) return null;
    // Path after /specs/ (e.g. "financial/af-cards-3ds.yaml" or legacy "af-cards-3ds.yaml")
    const pathAfterSpecs = segments.slice(specsIdx + 1).map(s => decodeURIComponent(s)).join("/").trim();
    return pathAfterSpecs ? pathAfterSpecs.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function resolveBooleanInput(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
  }
  return defaultValue;
}

function resolveK8sDiscoveryWorkspaceLink(value: unknown): boolean {
  return resolveBooleanInput(value, false);
}

function resolveGithubWorkspaceSync(
  req: ProvisionRequest,
  runtimeMode: ProvisionRuntime,
  k8sDiscoveryWorkspaceLink: boolean,
): boolean {
  const requested = req.github_workspace_sync ?? req.connect_git;
  const enabled = resolveBooleanInput(requested, true);
  if (runtimeMode === "k8s_discovery" && !k8sDiscoveryWorkspaceLink) {
    return false;
  }
  return enabled;
}

function resolveEnvironmentSyncEnabled(req: ProvisionRequest): boolean {
  return resolveBooleanInput(req.environment_sync_enabled, true);
}

function resolveChaosEnabled(req: ProvisionRequest): boolean {
  return resolveBooleanInput(req.chaos_enabled, true);
}

function findRegistryEntryByUrl(specUrl: string): RegistrySpecEntry | null {
  const filename = parseSpecFilenameFromUrl(specUrl);
  if (!filename) return null;
  return SPEC_REGISTRY_BY_FILENAME.get(filename) || null;
}

/**
 * Returns a publicly-reachable origin from the raw URL, or null.
 *
 * Rejects localhost, loopback, and RFC-1918 private addresses so that
 * workflow-dispatched spec URLs are always externally reachable — even when
 * provisioning is triggered from a local dev server (wrangler dev).
 */
function normalizeRequestOrigin(raw?: string): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]" ||
      host === "0.0.0.0" ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function deriveCanonicalSpecUrl(
  entry: RegistrySpecEntry,
  requestOrigin?: string,
  requestSpecUrl?: string | null,
  fallbackOrigin?: unknown,
): string {
  const origin = normalizeRequestOrigin(requestOrigin)
    || normalizeRequestOrigin(requestSpecUrl || undefined)
    || normalizeRequestOrigin(typeof fallbackOrigin === "string" ? fallbackOrigin : undefined);
  if (!origin) {
    throw new Error(`Unable to determine request origin for spec_source '${entry.id}'`);
  }
  return new URL(`/specs/${entry.filename}`, origin).toString();
}

async function fetchRegistrySpec(
  entry: RegistrySpecEntry,
  specUrl: string,
  env?: Pick<Env, "ASSETS"> | null
): Promise<string> {
  let assetStatus: number | null = null;
  let networkStatus: number | null = null;

  const assetResponse = await fetchSpecFromAssets(specUrl, env);
  if (assetResponse) {
    assetStatus = assetResponse.status;
    if (assetResponse.ok) {
      try {
        return validateFetchedSpec(await assetResponse.text(), specUrl);
      } catch {
        // Fall back to network fetch below for resilience.
      }
    }
  }

  const networkResponse = await fetch(specUrl, {
    headers: {
      "User-Agent": "vzw-partner-demo-worker",
    },
  });
  networkStatus = networkResponse.status;
  if (networkResponse.ok) {
    return validateFetchedSpec(await networkResponse.text(), specUrl);
  }

  throw new Error(
    `Failed to load registry spec ${entry.id} (${entry.filename}): assets=${assetStatus ?? "n/a"} network=${networkStatus ?? "n/a"} url=${specUrl}`
  );
}

interface ResolvedSpec {
  content?: string;
  source: string;
  specUrl: string;
}

interface ResolveSpecOptions {
  requestOrigin?: string;
  env?: (Pick<Env, "ASSETS"> & { WORKER_ORIGIN?: unknown }) | null;
}

function hasActiveEnvSignal(record: DeploymentRecord): boolean {
  return record.status === "active"
    || Boolean(record.runtime_base_url)
    || Boolean(record.aws_invoke_url)
    || Boolean(record.github_repo_url)
    || Boolean(record.postman_workspace_url)
    || Boolean(record.workspace_id);
}

export async function resolveSpec(
  req: ProvisionRequest,
  config?: PortalConfig | null,
  options?: ResolveSpecOptions
): Promise<ResolvedSpec> {
  const selectedSource = (req.spec_source || "").trim();
  const requestSpecUrl = normalizeSpecUrl(req.spec_hub_url || req.spec_url);
  const requestSpecContent = req.spec_content?.trim();
  void config;

  if (requestSpecContent) {
    throw new Error("Inline spec_content is no longer supported; select a spec from the registry");
  }

  if (selectedSource === "custom-upload" || selectedSource === "custom-url") {
    throw new Error("Custom spec sources are no longer supported; select a spec from the registry");
  }

  if (selectedSource) {
    const entry = SPEC_REGISTRY_BY_ID.get(selectedSource);
    if (!entry) {
      throw new Error(`Unknown spec_source '${selectedSource}'; select a valid registry spec`);
    }
    const canonicalSpecUrl = deriveCanonicalSpecUrl(entry, options?.requestOrigin, requestSpecUrl, options?.env?.WORKER_ORIGIN);
    if (requestSpecUrl && requestSpecUrl !== canonicalSpecUrl) {
      console.warn(`Ignoring mismatched spec_url for ${selectedSource}: ${requestSpecUrl} -> ${canonicalSpecUrl}`);
    }
    return {
      content: await fetchRegistrySpec(entry, canonicalSpecUrl, options?.env),
      source: selectedSource,
      specUrl: canonicalSpecUrl,
    };
  }

  if (!requestSpecUrl) {
    throw new Error("spec_source is required (legacy spec_url-only requests are temporarily supported)");
  }

  const legacyEntry = findRegistryEntryByUrl(requestSpecUrl);
  if (legacyEntry) {
    const canonicalSpecUrl = deriveCanonicalSpecUrl(legacyEntry, options?.requestOrigin, requestSpecUrl, options?.env?.WORKER_ORIGIN);
    return {
      content: await fetchRegistrySpec(legacyEntry, canonicalSpecUrl, options?.env),
      source: legacyEntry.id,
      specUrl: canonicalSpecUrl,
    };
  }

  console.warn(`Using legacy non-registry spec_url provisioning path: ${requestSpecUrl}`);
  return {
    content: await fetchSpecFromUrl(requestSpecUrl),
    source: "legacy_spec_url",
    specUrl: requestSpecUrl,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function resolveDeploymentMode(raw: unknown): DeploymentMode {
  const normalized = String(raw || "single").trim().toLowerCase();
  if (normalized === "single" || normalized === "graph") {
    return normalized as DeploymentMode;
  }
  throw new DependencyPlannerError(
    "invalid_deployment_mode",
    "deployment_mode must be one of: single, graph",
  );
}

function normalizePlanEnvironments(raw: unknown): string[] {
  if (raw === undefined) return ["prod"];
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string")) {
    throw new DependencyPlannerError(
      "invalid_environments",
      "environments must be an array of strings",
    );
  }
  const normalized = Array.from(new Set(raw.map((value) => value.trim()).filter(Boolean)));
  return normalized.length > 0 ? normalized : ["prod"];
}

interface SSESink {
  send(event: SSEEvent): void;
  close(): void;
}

interface PipelineResult {
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

interface RunPipelineOptions {
  closeStream?: boolean;
  requestId?: string;
}

function safeResolveDeploymentMode(raw: unknown): DeploymentMode {
  try {
    return resolveDeploymentMode(raw);
  } catch {
    return "single";
  }
}

function deploymentIncludesEnvironment(record: DeploymentRecord, environment: string): boolean {
  const env = environment.trim();
  const explicit = parseEnvironmentDeploymentsJson(record.environment_deployments || "");
  if (explicit.length > 0) {
    return explicit.some((entry) => entry.environment === env);
  }
  const rawEnvs = String(record.environments_json || "").trim();
  if (rawEnvs) {
    try {
      const parsed = JSON.parse(rawEnvs) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((value) => String(value || "").trim()).includes(env);
      }
    } catch {
      // Ignore malformed JSON and fall through to default behavior.
    }
  }
  return env === "prod";
}

function deploymentEnvironmentIsActive(record: DeploymentRecord, environment: string): boolean {
  const env = environment.trim();
  const explicit = parseEnvironmentDeploymentsJson(record.environment_deployments || "");
  if (explicit.length > 0) {
    const match = explicit.find((entry) => entry.environment === env);
    if (!match) return false;
    const status = String(match.status || "").trim().toLowerCase();
    if (status && status !== "active") return false;
    return Boolean(match.runtime_url || match.url || status === "active");
  }

  // If there are no explicit environment records, we cannot rely solely on inclusion logic
  // because that only implies the environment was requested, not actually successful.
  if (record.status !== "active") {
    return false;
  }

  return deploymentIncludesEnvironment(record, env);
}

function makeGraphNodeMeta(req: ProvisionRequest, runtimeMode: ProvisionRuntime): string {
  if (req.graph_node_layer_index === undefined && !req.graph_node_environment) {
    return "";
  }
  return JSON.stringify({
    layer_index: req.graph_node_layer_index ?? -1,
    environment: String(req.graph_node_environment || "").trim(),
    runtime_mode: runtimeMode,
    spec_source: String(req.spec_source || "").trim(),
  });
}

/** Derive a deterministic deployment group ID from root spec + runtime mode.
 *  Idempotent: same inputs always produce the same ID, so teardown/reprovision
 *  cycles reuse graph membership records instead of orphaning them. */
function deriveDeploymentGroupId(rootSpecId: string, runtimeMode: string): string {
  const input = `${rootSpecId}::${runtimeMode}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return `dg-${rootSpecId}-${(hash >>> 0).toString(36)}`;
}

function graphData(
  deploymentGroupId: string,
  deploymentRootSpecId: string,
  node: Pick<PlannedNode, "spec_id" | "layer_index"> | null,
  extraData: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    deployment_group_id: deploymentGroupId,
    deployment_root_spec_id: deploymentRootSpecId,
    current_spec_id: node?.spec_id || "",
    layer_index: node?.layer_index ?? -1,
    ...extraData,
  };
}

export async function handleProvisionPlan(request: Request, env: Env): Promise<Response> {
  let body: ProvisionPlanRequest;
  try {
    body = (await request.json()) as ProvisionPlanRequest;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const specSource = String(body.spec_source || "").trim();
  if (!specSource) {
    return jsonResponse({ error: "spec_source is required" }, 400);
  }
  if (!SPEC_REGISTRY_BY_ID.has(specSource)) {
    return jsonResponse({ error: `Unknown spec_source '${specSource}'` }, 400);
  }

  try {
    const runtime = normalizeRuntimeMode(body.runtime || "lambda");
    const deploymentMode = resolveDeploymentMode(body.deployment_mode);
    const environments = normalizePlanEnvironments(body.environments);
    const warnings: string[] = [];

    let deployments: DeploymentRecord[] = [];
    if (isAirtableConfigured(env)) {
      deployments = await listResolvedDeployments(
        env,
        String(env.GH_TOKEN || "").trim(),
      );
    } else {
      warnings.push("Airtable not configured; reuse estimates assume no existing active deployments.");
    }

    const plan = createDependencyPlan({
      rootSpecId: specSource,
      runtime,
      environments,
      deploymentMode,
      dependencies: DEPENDENCIES,
      deployments,
    });

    return jsonResponse({ plan, warnings });
  } catch (err) {
    if (err instanceof DependencyPlannerError) {
      return jsonResponse({
        error: err.message,
        code: err.code,
        details: err.details || undefined,
      }, 400);
    }
    const message = err instanceof Error ? err.message : "Failed to build provision plan";
    return jsonResponse({ error: message }, 500);
  }
}

async function runGraphPipeline(
  req: ProvisionRequest,
  env: Env,
  sse: SSESink,
  config?: PortalConfig | null,
  requestOrigin?: string,
  options?: RunPipelineOptions,
): Promise<void> {
  const normalizedConfig = config ? normalizePortalConfig(config) : null;
  const deploymentRootSpecId = String(req.spec_source || "").trim();
  const runtimeMode = resolveRuntimeMode(req, normalizedConfig);
  const deploymentGroupId = String(req.deployment_group_id || "").trim() || deriveDeploymentGroupId(deploymentRootSpecId, runtimeMode);
  let graphMembershipsEnabled = false;

  const persistGraphMetadata = async (args: {
    specId: string;
    environment: string;
    layerIndex: number;
    nodeStatus: string;
    nodeAction: string;
  }): Promise<void> => {
    const graphNodeMeta = JSON.stringify({
      spec_id: args.specId,
      environment: args.environment,
      layer_index: args.layerIndex,
      node_status: args.nodeStatus,
      node_action: args.nodeAction,
      runtime_mode: runtimeMode,
    });

    if (graphMembershipsEnabled) {
      await upsertGraphMembership(env, {
        deployment_group_id: deploymentGroupId,
        deployment_root_spec_id: deploymentRootSpecId,
        spec_id: args.specId,
        environment: args.environment,
        layer_index: args.layerIndex,
        node_status: args.nodeStatus,
        node_action: args.nodeAction,
        runtime_mode: runtimeMode,
        graph_node_meta_json: graphNodeMeta,
      });
      return;
    }

    const entry = SPEC_REGISTRY_BY_ID.get(args.specId);
    const recordKey = String(entry?.repo_name || args.specId).trim() || args.specId;
    const record = await getDeployment(env, recordKey);
    if (!record?.id) return;
    await updateDeployment(env, record.id, {
      deployment_mode: "graph",
      deployment_group_id: deploymentGroupId,
      deployment_root_spec_id: deploymentRootSpecId,
      graph_node_meta_json: graphNodeMeta,
    });
  };

  try {
    if (!deploymentRootSpecId) {
      throw new Error("spec_source is required for deployment_mode=graph");
    }
    if (!SPEC_REGISTRY_BY_ID.has(deploymentRootSpecId)) {
      throw new Error(`Unknown spec_source '${deploymentRootSpecId}'`);
    }
    if (!isAirtableConfigured(env)) {
      throw new Error("Airtable is required for graph provisioning");
    }
    graphMembershipsEnabled = await supportsGraphMembershipsTable(env);

    const creds = await resolveTeamCredentials(
      env.TEAM_REGISTRY,
      env,
      req.postman_team_slug,
    );
    resolveEffectivePostmanTeamSelection(req, creds);
    const resolvedSystemEnvs = await resolveSystemEnvironments(
      creds.team_id,
      creds.access_token,
      env,
    );
    const systemEnvMap = buildSystemEnvMap(resolvedSystemEnvs);
    let environments: string[];
    if (Array.isArray(req.environments) && req.environments.length > 0) {
      const invalid = req.environments.filter((slug) => !(slug in systemEnvMap));
      if (invalid.length > 0) {
        throw new Error(`Unrecognized environments: ${invalid.join(", ")}. Valid options for this team: ${Object.keys(systemEnvMap).sort().join(", ")}`);
      }
      environments = Array.from(new Set(req.environments.map((value) => value.trim()).filter(Boolean)));
    } else {
      environments = Object.keys(systemEnvMap);
    }
    if (environments.length === 0) environments = ["prod"];

    const allDeployments = await listResolvedDeployments(
      env,
      String(env.GH_TOKEN || "").trim(),
    );
    const plan = createDependencyPlan({
      rootSpecId: deploymentRootSpecId,
      runtime: runtimeMode,
      environments,
      deploymentMode: "graph",
      dependencies: DEPENDENCIES,
      deployments: allDeployments,
    });

    sse.send({
      phase: "graph",
      status: "running",
      message: `Planning dependency graph for ${deploymentRootSpecId}`,
      data: graphData(deploymentGroupId, deploymentRootSpecId, null, {
        environments,
        total_nodes: plan.summary.total_nodes,
        reuse_count: plan.summary.reuse_count,
        attach_count: plan.summary.attach_count,
        provision_count: plan.summary.provision_count,
        blocked_count: plan.summary.blocked_count,
      }),
    });

    const execution = await executeGraphPlan({
      plan,
      deploymentGroupId,
      deploymentRootSpecId,
      recheckNodeState: async (node) => {
        const entry = SPEC_REGISTRY_BY_ID.get(node.spec_id);
        const recordKey = String(entry?.repo_name || node.spec_id).trim() || node.spec_id;
        const existing = await getResolvedDeployment(
          env,
          recordKey,
          String(env.GH_TOKEN || "").trim(),
        );
        if (!existing) return null;
        if (existing.status !== "active") {
          return { status: existing.status || "unknown" };
        }
        if (!deploymentIncludesEnvironment(existing, node.environment)) {
          return null;
        }
        if (!deploymentEnvironmentIsActive(existing, node.environment)) {
          return { status: "environment_inactive" };
        }
        const existingRuntime = normalizeRuntimeMode(existing.runtime_mode || "lambda");
        if (existingRuntime === runtimeMode) {
          return { status: "completed", reason: "active_match" };
        }
        if (areGraphRuntimeCompatible(existingRuntime, runtimeMode)) {
          return {
            status: "attached",
            reason: `active_compatible_runtime:${existingRuntime}`,
          };
        }
        return { status: "runtime_mismatch" };
      },
      runProvisionNode: async (node) => {
        const entry = SPEC_REGISTRY_BY_ID.get(node.spec_id);
        const childProjectName = String(entry?.repo_name || node.spec_id).trim() || node.spec_id;
        const childDomain = String(entry?.domain || req.domain || "").trim() || req.domain;
        const childReq: ProvisionRequest = {
          ...req,
          project_name: childProjectName,
          domain: childDomain,
          environments: [node.environment],
          spec_source: node.spec_id,
          deployment_mode: "single",
          deployment_group_id: deploymentGroupId,
          deployment_root_spec_id: deploymentRootSpecId,
          graph_node_layer_index: node.layer_index,
          graph_node_environment: node.environment,
        };

        const forwardSse: SSESink = {
          send: (event) => {
            sse.send({
              ...event,
              spec_id: node.spec_id,
              data: graphData(
                deploymentGroupId,
                deploymentRootSpecId,
                node,
                { ...(event.data || {}) },
              ),
            });
          },
          close: () => { /* no-op: graph pipeline owns stream lifecycle */ },
        };

        const childResult = await runPipeline(
          childReq,
          env,
          forwardSse,
          normalizedConfig,
          requestOrigin,
          { closeStream: false, requestId: options?.requestId },
        );

        return {
          ok: childResult.success,
          reused: Boolean(childResult.data?.reused),
          attached: Boolean(childResult.data?.attached),
          message: childResult.error,
        };
      },
      onEvent: (event) => {
        const currentSpecId = String(event.data?.current_spec_id || "").trim();
        const layerIndex = Number(event.data?.layer_index ?? -1);
        sse.send({
          ...event,
          spec_id: currentSpecId || undefined,
          data: graphData(
            deploymentGroupId,
            deploymentRootSpecId,
            currentSpecId ? { spec_id: currentSpecId, layer_index: layerIndex } : null,
            { ...(event.data || {}) },
          ),
        });
      },
    });

    for (const reused of execution.reused_nodes) {
      await persistGraphMetadata({
        specId: reused.spec_id,
        environment: reused.environment,
        layerIndex: reused.layer_index,
        nodeStatus: "reused",
        nodeAction: "reused",
      });
    }
    for (const attached of execution.attached_nodes) {
      await persistGraphMetadata({
        specId: attached.spec_id,
        environment: attached.environment,
        layerIndex: attached.layer_index,
        nodeStatus: "attached",
        nodeAction: "attached",
      });
    }
    for (const done of execution.completed_nodes) {
      await persistGraphMetadata({
        specId: done.spec_id,
        environment: done.environment,
        layerIndex: done.layer_index,
        nodeStatus: "completed",
        nodeAction: "provisioned",
      });
    }
    if (execution.failed_node) {
      await persistGraphMetadata({
        specId: execution.failed_node.spec_id,
        environment: execution.failed_node.environment,
        layerIndex: execution.failed_node.layer_index,
        nodeStatus: "failed",
        nodeAction: "failed",
      });
    }

    if (execution.success) {
      sse.send({
        phase: "complete",
        status: "complete",
        message: "Graph provisioning complete!",
        data: graphData(deploymentGroupId, deploymentRootSpecId, null, {
          graph_summary: execution,
        }),
      });
    } else {
      sse.send({
        phase: "complete",
        status: "error",
        message: execution.failed_node?.message || "Graph provisioning failed",
        data: graphData(deploymentGroupId, deploymentRootSpecId, null, {
          graph_summary: execution,
          failed_layer_index: execution.failed_layer_index ?? -1,
        }),
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Graph provisioning failed";
    sse.send({
      phase: "error",
      status: "error",
      message,
      data: graphData(deploymentGroupId, deploymentRootSpecId, null),
    });
  } finally {
    sse.close();
  }
}

function resolveChaosConfig(req: ProvisionRequest): string {
  if (req.chaos_config) {
    return typeof req.chaos_config === "string" ? req.chaos_config : JSON.stringify(req.chaos_config);
  }
  // Default tier policies — each fault type has its own independent rate
  return JSON.stringify({
    prod:    { error_rate: 0,    status_code: 503, latency_rate: 0.05, latency_ms: 1500, timeout_rate: 0 },
    stage:   { error_rate: 0.20, status_code: 503, latency_rate: 0.05, latency_ms: 1000, timeout_rate: 0 },
    dev:     { error_rate: 0.50, status_code: 500, latency_rate: 0.10, latency_ms: 1000, timeout_rate: 0.02 },
    default: { error_rate: 0.20, status_code: 503, latency_rate: 0,    latency_ms: 1000, timeout_rate: 0 },
  });
}

export async function handleProvision(
  request: Request,
  env: Env,
  config?: PortalConfig | null
): Promise<Response> {
  let body: ProvisionRequest;
  try {
    body = (await request.json()) as ProvisionRequest;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  if (!body.project_name || !body.requester_email) {
    return new Response(
      JSON.stringify({ error: "project_name and requester_email are required" }),
      { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
    );
  }

  if (body.environments !== undefined && (!Array.isArray(body.environments) || body.environments.some((e) => typeof e !== "string"))) {
    return new Response(
      JSON.stringify({ error: "environments must be an array of strings" }),
      { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
    );
  }

  let deploymentMode: DeploymentMode;
  try {
    deploymentMode = resolveDeploymentMode(body.deployment_mode);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid deployment_mode";
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  const normalizedConfig = config ? normalizePortalConfig(config) : null;
  const requestId = getRequestId(request);

  // Apply portal config to GitHub module if available
  if (normalizedConfig?.backend) {
    setGitHubOrg(normalizedConfig.backend.github_org);
    setGitHubUserAgent(normalizedConfig.backend.user_agent);
  }

  const sse = new SSEWriter();
  const response = sse.toResponse();

  const specSource = String(body.spec_source || "").trim();
  sse.send({
    phase: "init",
    status: "running",
    message: "Provisioning stream started",
    resumption_token: specSource,
    data: { resumption_token: specSource, poll_url: `/api/deployments/${specSource}` },
  });

  // Run the provisioning pipeline asynchronously
  const pipeline = deploymentMode === "graph"
    ? runGraphPipeline(body, env, sse, normalizedConfig, new URL(request.url).origin, { requestId })
    : runPipeline(body, env, sse, normalizedConfig, new URL(request.url).origin, { requestId });

  // Use waitUntil to keep the Worker alive while streaming
  // (The response is already being streamed to the client)
  // We need to handle this carefully -- the pipeline promise
  // will keep running after we return the response.
  /* istanbul ignore next -- @preserve defensive: runPipeline has internal try/catch */
  pipeline.catch((err) => {
    console.error("Pipeline error:", err);
    sse.send({ phase: "error", status: "error", message: err.message });
    sse.close();
  });

  return response;
}

async function runPipeline(
  req: ProvisionRequest,
  env: Env,
  sse: SSESink,
  config?: PortalConfig | null,
  requestOrigin?: string,
  options?: RunPipelineOptions,
): Promise<PipelineResult> {
  const normalizedConfig = config ? normalizePortalConfig(config) : null;
  const repoName = req.project_name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const deploymentMode = safeResolveDeploymentMode(req.deployment_mode);
  const deploymentGroupId = String(req.deployment_group_id || "").trim();
  const deploymentRootSpecId = String(req.deployment_root_spec_id || "").trim();
  const domainCode = getDomainCode(req.domain, normalizedConfig);
  const platformName = normalizedConfig?.platform?.name || "Portal";
  const creds = await resolveTeamCredentials(
    env.TEAM_REGISTRY,
    env,
    req.postman_team_slug,
  );
  const { teamId: canonicalTeamId, teamSlug: canonicalTeamSlug } = resolveEffectivePostmanTeamSelection(req, creds);
  const org = getOrg();
  const defaultTeamId = String(env.POSTMAN_TEAM_ID || "").trim();
  const isNonDefaultTeam = Boolean(defaultTeamId && creds.team_id && creds.team_id !== defaultTeamId);
  const featureFlags: ProvisionFeatureFlags = resolveProvisionFeatureFlags(env);
  const credentialPolicy = resolveCredentialSourcePolicy(featureFlags, {
    forceRepoMode: isNonDefaultTeam,
  });
  const githubAppTokenRaw = String(env.GH_TOKEN || "").trim();
  const githubAppToken = githubAppTokenRaw
    ? normalizeGitHubToken(githubAppTokenRaw)
    : (featureFlags.githubAppAuthEnabled ? "__github_app_auth__" : normalizeGitHubToken(env.GH_TOKEN));
  console.log("[provision][flags]", {
    orgSecretsEnabled: featureFlags.orgSecretsEnabled,
    orgVarsEnabled: featureFlags.orgVarsEnabled,
    patFallbackEnabled: featureFlags.patFallbackEnabled,
    oidcAwsEnabled: featureFlags.oidcAwsEnabled,
    githubAppAuthEnabled: featureFlags.githubAppAuthEnabled,
    workflowCallbacksEnabled: featureFlags.workflowCallbacksEnabled,
    isNonDefaultTeam,
    secretSourceMode: credentialPolicy.secretSourceMode,
    variableSourceMode: credentialPolicy.variableSourceMode,
  });
  const resolvedSpec = await resolveSpec(req, normalizedConfig, { requestOrigin, env });
  const runtimeMode = resolveRuntimeMode(req, normalizedConfig);
  const runtimeStatus = await resolveRuntimeOptionsStatus(
    normalizedConfig,
    env,
    canonicalTeamSlug,
  );
  const ecsRuntime = runtimeStatus.ecs_service;
  const k8sWorkspaceRuntime = runtimeStatus.k8s_workspace;
  const k8sDiscoveryRuntime = runtimeStatus.k8s_discovery;

  // Resolve system environments dynamically
  const resolvedSystemEnvs = await resolveSystemEnvironments(
    creds.team_id,
    creds.access_token,
    env,
  );
  const systemEnvMap = buildSystemEnvMap(resolvedSystemEnvs);

  let environments: string[];
  if (Array.isArray(req.environments) && req.environments.length > 0) {
    // Explicit selection provided - validate that all requested slugs are recognized
    const invalid = req.environments.filter((slug) => !(slug in systemEnvMap));
    if (invalid.length > 0) {
      throw new Error(`Unrecognized environments: ${invalid.join(", ")}. Valid options for this team: ${Object.keys(systemEnvMap).sort().join(", ")}`);
    }
    environments = req.environments;
  } else {
    // Default to all discovered system environments
    environments = Object.keys(systemEnvMap);
  }

  // Final safety check: if no environments resolved (Bifrost empty + no fallback), default to prod
  if (environments.length === 0) {
    environments = ["prod"];
  }

  const systemEnvProd = systemEnvMap.prod || String(env.POSTMAN_SYSTEM_ENV_PROD || "").trim();
  const k8sNamespace = String(env.K8S_NAMESPACE || "").trim() || "vzw-partner-demo";
  const k8sContext = String(env.K8S_CONTEXT || "").trim();
  const k8sIngressBaseDomain = String(env.K8S_INGRESS_BASE_DOMAIN || "").trim();
  const insightsClusterName = String(env.POSTMAN_INSIGHTS_CLUSTER_NAME || "").trim();
  const k8sDiscoveryWorkspaceLink = runtimeMode === "k8s_discovery"
    ? resolveK8sDiscoveryWorkspaceLink(req.k8s_discovery_workspace_link)
    : false;
  const githubWorkspaceSync = resolveGithubWorkspaceSync(req, runtimeMode, k8sDiscoveryWorkspaceLink);
  const environmentSyncEnabled = resolveEnvironmentSyncEnabled(req);
  const chaosEnabled = resolveChaosEnabled(req);
  const sharedAlbHost = ecsRuntime.infra.albDnsName.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const normalizedK8sIngressBaseDomain = k8sIngressBaseDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const containerRuntime = isContainerRuntime(runtimeMode);
  if (runtimeMode === "ecs_service") {
    if (!systemEnvProd) {
      throw new Error("POSTMAN_SYSTEM_ENV_PROD is required for ecs_service runtime");
    }
    if (!isUuid(systemEnvProd)) {
      throw new Error("POSTMAN_SYSTEM_ENV_PROD must be a valid UUID");
    }
  }
  if (runtimeMode === "k8s_workspace" && !k8sWorkspaceRuntime.available) {
    throw new Error(k8sWorkspaceRuntime.unavailableReason || "k8s_workspace runtime is currently unavailable");
  }
  if (runtimeMode === "k8s_discovery" && !k8sDiscoveryRuntime.available) {
    throw new Error(k8sDiscoveryRuntime.unavailableReason || "k8s_discovery runtime is currently unavailable");
  }
  const ecsServiceName = runtimeMode === "ecs_service" ? `${repoName}-svc` : "";
  const ecsTaskDefinition = runtimeMode === "ecs_service" ? `${repoName}-task` : "";
  const runtimeBaseUrl = !containerRuntime
    ? ""
    : runtimeMode === "ecs_service"
      ? (sharedAlbHost ? `http://${sharedAlbHost}/svc/${repoName}` : "")
      : (normalizedK8sIngressBaseDomain ? `https://${repoName}.${normalizedK8sIngressBaseDomain}` : "");

  // Airtable tracking: create deployment record at the start
  let airtableRecordId: string | undefined;
  const logs: string[] = [];
  const workerLogTasks: Promise<void>[] = [];
  const appendLog = (msg: string) => {
    const ts = new Date().toISOString().substring(11, 19);
    logs.push(`[${ts}] ${msg}`);
    if (options?.requestId) {
      workerLogTasks.push(
        logWorkerEvent(env, {
          request_id: options.requestId,
          route: "/api/provision",
          method: "POST",
          event: "provision.log",
          level: msg.startsWith("ERROR:") ? "error" : "info",
          message: msg,
          spec_id: req.spec_source,
          metadata: {
            runtime: runtimeMode,
            deployment_mode: resolveDeploymentMode(req.deployment_mode),
          },
        }),
      );
    }
  };
  const flushToAirtable = async (fields: Partial<DeploymentRecord>) => {
    if (!airtableRecordId) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await updateDeployment(env, airtableRecordId, { ...fields, logs: logs.join("\n") });
        return;
      } catch (e) {
        console.warn(`Airtable update failed (attempt ${attempt + 1}/3):`, e);
        if (attempt < 2) await sleep(1000);
      }
    }
    console.error("Airtable update failed after 3 retries — state may be inconsistent");
  };
  const flushInventoryToAirtable = async (fields: Partial<DeploymentRecord>) => {
    const normalizedRuntime = normalizeRuntimeMode(fields.runtime_mode || runtimeMode);
    const inventory = buildDerivedResourceInventory(
      {
        spec_id: repoName,
        status: (fields.status as DeploymentRecord["status"]) || "provisioning",
        runtime_mode: normalizedRuntime,
        aws_region: String(fields.aws_region || env.AWS_REGION || "eu-central-1"),
        aws_invoke_url: String(fields.aws_invoke_url || ""),
        lambda_function_name: String(fields.lambda_function_name || ""),
        api_gateway_id: String(fields.api_gateway_id || ""),
        runtime_base_url: String(fields.runtime_base_url || ""),
        ecs_cluster_name: String(fields.ecs_cluster_name || ""),
        ecs_service_name: String(fields.ecs_service_name || ""),
        ecs_task_definition: String(fields.ecs_task_definition || ""),
        k8s_namespace: String(fields.k8s_namespace || ""),
        k8s_deployment_name: String(fields.k8s_deployment_name || ""),
        k8s_service_name: String(fields.k8s_service_name || ""),
        k8s_ingress_name: String(fields.k8s_ingress_name || ""),
        environment_deployments: String(fields.environment_deployments || ""),
        deployed_at: String(fields.deployed_at || new Date().toISOString()),
      },
      env,
    );
    await flushToAirtable({
      ...fields,
      resource_inventory_json: JSON.stringify({
        ...inventory,
        source: "airtable",
      }),
    });
  };

  // Track created resources for cleanup on failure
  let createdRepoName: string | undefined;
  let createdWorkspaceId: string | undefined;
  let outcome: PipelineResult = { success: false, error: "Provisioning did not complete" };
  let isRetry = false;

  try {
    // Airtable is mandatory — fail fast if not configured
    if (!isAirtableConfigured(env)) {
      throw new Error("Airtable is not configured (AIRTABLE_API_KEY + AIRTABLE_BASE_ID required). Cannot provision without state tracking.");
    }
    const graphMembershipsEnabled = Boolean(deploymentGroupId && deploymentRootSpecId)
      && await supportsGraphMembershipsTable(env);

    // Block if already active/provisioning — must deprovision first.
    // Use the raw Airtable record here so previously failed rows can still
    // flow through the retry + remote reconciliation path if GitHub already
    // completed successfully.
    const existing = await getDeployment(env, repoName);
    const hasActiveEnv = existing?.status === "active" || (
      existing?.status === "failed" &&
      parseEnvironmentDeploymentsJson(existing?.environment_deployments || "").some(e => String(e.status || "").toLowerCase() === "active")
    );

    let isEnvironmentExpansion = false;

    // Skip processing for deprovisioned tombstones - treat them as if no deployment exists
    if (existing?.id && (existing.status as string) !== "deprovisioned" && (existing.status !== "failed" || hasActiveEnv)) {
      // Handle race condition: if this is a graph node deployment and the dependency
      // became active between planning and execution, treat it as a successful reuse.
      // This can happen when multiple graph nodes are provisioned concurrently.
      if (
        deploymentRootSpecId &&
        existing.status === "active" &&
        deploymentEnvironmentIsActive(existing, environments[0] || "prod")
      ) {
        const existingRuntime = normalizeRuntimeMode(existing.runtime_mode || "lambda");
        const reused = existingRuntime === runtimeMode;
        const attached = !reused && areGraphRuntimeCompatible(existingRuntime, runtimeMode);
        if (!reused && !attached) {
          throw new Error(`Service ${repoName} is already active on ${existingRuntime} and cannot join this graph runtime.`);
        }
        sse.send({
          phase: "graph",
          status: "complete",
          message: reused
            ? `Dependency ${repoName} became active during graph provisioning — treating as reused`
            : `Dependency ${repoName} is active on a compatible Kubernetes runtime — attaching to the graph`,
          data: {
            deployment_group_id: deploymentGroupId,
            deployment_root_spec_id: deploymentRootSpecId,
            current_spec_id: repoName,
            node_status: attached ? "attached" : "reused",
            reuse_reason: reused
              ? "became_active_during_provisioning"
              : `active_compatible_runtime:${existingRuntime}`,
          },
        });
        return {
          success: true,
          data: {
            reused,
            attached,
            spec_id: repoName,
            runtime_mode: runtimeMode,
            environment: environments[0] || "prod",
          },
        };
      }

      const requestedEnvironmentsAreActive = environments.every(envName => deploymentEnvironmentIsActive(existing, envName));
      if (!requestedEnvironmentsAreActive) {
        isEnvironmentExpansion = true;
        appendLog(`Service ${repoName} is already active, but missing requested environments. Initiating environment expansion.`);
      } else {
        throw new Error(`Service ${repoName} is already ${existing.status} in the catalog. Deprovision it first.`);
      }
    }
    // Upsert deployment record (reuses existing row if one exists for this spec_id)
    let mergedEnvironments = [...environments];
    if (existing?.environments_json) {
      try {
        const existingEnvs = JSON.parse(existing.environments_json) as string[];
        if (Array.isArray(existingEnvs)) {
          mergedEnvironments = Array.from(new Set([...existingEnvs, ...environments]));
        }
      } catch (e) {
        // ignore
      }
    }

    isRetry = existing?.status === "failed";
    
    const deploymentPayload = {
      spec_id: repoName,
      status: "provisioning" as const,
      workspace_team_id: req.workspace_team_id ? String(req.workspace_team_id) : undefined,
      workspace_team_name: req.workspace_team_name || undefined,
      postman_team_id: String(canonicalTeamId || ""),
      runtime_mode: runtimeMode,
      deployment_mode: deploymentMode,
      github_repo_url: `https://github.com/${org}/${repoName}`,
      github_repo_name: repoName,
      aws_region: String(env.AWS_REGION || "eu-central-1"),
      deployed_at: new Date().toISOString(),
      environments_json: JSON.stringify(mergedEnvironments),
      system_env_map: JSON.stringify(systemEnvMap),
      postman_team_slug: canonicalTeamSlug,
      request_context_json: JSON.stringify({
        requester_email: req.requester_email,
        github_workspace_sync: githubWorkspaceSync,
        environment_sync_enabled: environmentSyncEnabled,
        k8s_discovery_workspace_link: k8sDiscoveryWorkspaceLink,
      }),
      ...(!graphMembershipsEnabled && deploymentGroupId && deploymentRootSpecId
        ? {
          deployment_group_id: deploymentGroupId,
          deployment_root_spec_id: deploymentRootSpecId,
          graph_node_meta_json: makeGraphNodeMeta(req, runtimeMode),
        }
        : {}),
      ...(isRetry ? { failed_at_step: "", error_message: "", logs: "" } : {}),
    };

    if (existing?.id) {
      const { spec_id: _drop, ...updates } = deploymentPayload;
      await updateDeployment(env, existing.id, updates);
      airtableRecordId = existing.id;
    } else {
      const record = await insertDeployment(env, deploymentPayload);
      airtableRecordId = record.id;
    }

    appendLog(isRetry ? "Retrying previously failed deployment" : "Airtable deployment record created");

    // Pre-flight validation checks
    sse.send({ phase: "github", status: "running", message: "Running pre-flight checks..." });
    appendLog("Running pre-flight checks");

    if (runtimeMode === "ecs_service") {
      if (!ecsRuntime.available) {
        throw new Error(ecsRuntime.unavailableReason || "ECS runtime is currently unavailable");
      }
      appendLog(
        `ECS capacity check passed (${ecsRuntime.activeServices}/${ecsRuntime.maxServices} in use, ${ecsRuntime.remainingServices} available)`,
      );
    }
    if (runtimeMode === "k8s_workspace") {
      if (!k8sWorkspaceRuntime.available) {
        throw new Error(k8sWorkspaceRuntime.unavailableReason || "k8s_workspace runtime is currently unavailable");
      }
      appendLog(`Kubernetes workspace-mode preflight passed (namespace=${k8sWorkspaceRuntime.namespace})`);
    }
    if (runtimeMode === "k8s_discovery") {
      if (!k8sDiscoveryRuntime.available) {
        throw new Error(k8sDiscoveryRuntime.unavailableReason || "k8s_discovery runtime is currently unavailable");
      }
      appendLog(
        `Kubernetes discovery-mode preflight passed (namespace=${k8sDiscoveryRuntime.namespace}, workspace_link=${k8sDiscoveryWorkspaceLink ? "on" : "off"})`,
      );
      if (!k8sDiscoveryWorkspaceLink) {
        sse.send({
          phase: "github",
          status: "running",
          message: "Workspace creation skipped (k8s_discovery_workspace_link=false). Set to true to create a linked Postman workspace.",
        });
        appendLog("Workspace creation skipped: k8s_discovery_workspace_link=false");
      }
    }

    // Allocate unique host port for k8s_discovery (hostNetwork requires unique ports per service)
    // Prefer sticky port from previous deployment (supports teardown/reprovision idempotency)
    let hostPort = "";
    if (runtimeMode === "k8s_discovery") {
      const existingRecord = await getDeployment(env, repoName);
      if (existingRecord?.dedicated_port) {
        hostPort = String(existingRecord.dedicated_port);
        appendLog(`Reusing sticky host port ${hostPort} from previous deployment`);
      } else {
        const K8S_HOST_PORT_BASE = 5001;
        const existingPorts = await getActiveDiscoveryUsedPorts(env);
        const usedPorts = new Set(existingPorts);
        let candidate = K8S_HOST_PORT_BASE;
        while (usedPorts.has(candidate)) candidate++;
        hostPort = String(candidate);
        appendLog(`Allocated host port ${hostPort} for k8s_discovery hostNetwork mode`);
      }
    }

    const repoAlreadyExists = await repoExists(githubAppToken, repoName);
    if (repoAlreadyExists && !isEnvironmentExpansion) {
      // If the Airtable record shows a failed deployment, auto-teardown before retrying
      if (existing?.status === "failed" && !hasActiveEnv) {
        sse.send({ phase: "github", status: "running", message: "Previous failed deployment detected -- running auto-teardown..." });
        appendLog(`Auto-teardown: cleaning up failed deployment for ${repoName}`);
        try {
          await autoTeardownForRetry(repoName, existing, env, githubAppToken, appendLog);
          appendLog("Auto-teardown completed");
          sse.send({ phase: "github", status: "running", message: "Previous deployment cleaned up" });
        } catch (teardownErr: unknown) {
          const teardownMsg = teardownErr instanceof Error ? teardownErr.message : String(teardownErr);
          throw new Error(
            `Auto-teardown of failed deployment failed: ${teardownMsg}. ` +
            `Run manual teardown for ${repoName} before retrying.`
          );
        }
      } else if (existing?.status === "failed" && hasActiveEnv) {
        throw new Error(`GitHub repo ${org}/${repoName} already exists and has active environments, but deployment is marked as failed. Auto-teardown bypassed for safety. Deprovision manually.`);
      } else {
        throw new Error(`GitHub repo ${org}/${repoName} already exists. Deprovision it first or choose a different name.`);
      }
    }

    sse.send({ phase: "github", status: "running", message: "Pre-flight checks passed" });
    appendLog("Pre-flight checks passed");
    sse.send({ phase: "github", status: "running", message: "Resolving API specification..." });

    // Phase: Repo Bootstrap
    let repoUrl = `https://github.com/${org}/${repoName}`;
    let repoDefaultBranch = "main";

    if (!isEnvironmentExpansion) {
      sse.send({ phase: "github", status: "running", message: "Creating repository..." });

      const repo = await createRepo(
        githubAppToken,
        repoName,
        `${req.project_name} -- Auto-provisioned by ${platformName}`
      );
      repoUrl = repo.html_url;
      if (repo.default_branch) repoDefaultBranch = repo.default_branch;

      sse.send({ phase: "github", status: "running", message: "Fetching boilerplate files..." });

      // Fetch boilerplate and build the initial file tree
      const boilerplate = await fetchBoilerplate(githubAppToken);
      const provisionYml = generateProvisionWorkflow(normalizedConfig, { fallbackTeamId: creds.team_id });
      const localFernConfig = generateFernConfig(req.project_name);

      if (resolvedSpec.content) {
        const specIdx = boilerplate.findIndex(f => f.path === "index.yaml");
        if (specIdx >= 0) {
          boilerplate[specIdx].content = resolvedSpec.content;
        } else {
          boilerplate.push({ path: "index.yaml", content: resolvedSpec.content });
        }
      }

      // Generate Flask routes from the resolved registry spec that will be committed.
      const specForRoutes = resolvedSpec.content
        || boilerplate.find(f => f.path === "index.yaml")?.content;
      if (specForRoutes) {
        try {
          const generated = generateFlaskRoutes(specForRoutes);
          const routesIdx = boilerplate.findIndex(f => f.path === "app/routes.py");
          if (routesIdx >= 0) boilerplate[routesIdx].content = generated.routes;
          const modelsIdx = boilerplate.findIndex(f => f.path === "app/models.py");
          if (modelsIdx >= 0) boilerplate[modelsIdx].content = generated.models;
          const initIdx = boilerplate.findIndex(f => f.path === "app/__init__.py");
          if (initIdx >= 0) boilerplate[initIdx].content = generated.initPy;
        } catch (err) {
          console.warn("Flask route generation failed, using boilerplate defaults:", err);
          sse.send({ phase: "github", status: "running", message: "Route generation failed -- using default boilerplate" });
        }
      }

      const files = [
        ...boilerplate,
        { path: ".gitignore", content: generateGitignore() },
        { path: ".env.example", content: generateEnvExample(req.project_name) },
        { path: ".github/workflows/provision.yml", content: provisionYml },
        { path: ".github/workflows/refresh-dependencies.yml", content: REFRESH_DEPENDENCIES_WORKFLOW_CONTENT },
        { path: "fern/fern.config.json", content: localFernConfig.configJson },
        { path: "fern/generators.yml", content: localFernConfig.generatorsYml },
        { path: "fern/docs.yml", content: localFernConfig.docsYml },
      ];

      sse.send({ phase: "github", status: "running", message: "Pushing initial commit..." });
      await appendCommit(githubAppToken, repoName, files, `feat: initial API scaffold (${platformName} provisioned)`);
    } else {
      sse.send({ phase: "github", status: "running", message: "Environment expansion: Bypassing boilerplate, injecting provision workflow..." });
      const provisionYml = generateProvisionWorkflow(normalizedConfig, { fallbackTeamId: creds.team_id });
      const files = [
        { path: ".github/workflows/provision.yml", content: provisionYml },
      ];
      await appendCommit(githubAppToken, repoName, files, `fix: environment expansion provision workflow injection by ${platformName}`);
    }

    const environmentBranchMap = getEnvironmentBranchMap(environments);
    const selectedBranches = Object.values(environmentBranchMap);

    // Grant requester access
    if (!isEnvironmentExpansion) {
      sse.send({ phase: "github", status: "running", message: "Granting collaborator access..." });
      const ghUsername = await lookupUser(githubAppToken, req.requester_email);
      if (ghUsername) {
        await addCollaborator(githubAppToken, repoName, ghUsername);
      }
    }

    // Inject secrets
    sse.send({ phase: "github", status: "running", message: "Injecting secrets..." });
    if (!creds.access_token || !creds.access_token.trim()) {
      console.warn("[provision] WARNING: POSTMAN_ACCESS_TOKEN is empty — Bifrost operations will fail. " +
        `Source: ${creds.slug ? `team registry (${creds.slug})` : "environment fallback"}`);
    }
    const allSecrets: Record<string, string> = {
      POSTMAN_API_KEY: creds.api_key,
      POSTMAN_ACCESS_TOKEN: creds.access_token,
      GH_TOKEN: githubAppTokenRaw,
      AWS_ACCESS_KEY_ID: String(env.AWS_ACCESS_KEY_ID || "").trim(),
      AWS_SECRET_ACCESS_KEY: String(env.AWS_SECRET_ACCESS_KEY || "").trim(),
      AWS_LAMBDA_ROLE_ARN: String(env.AWS_LAMBDA_ROLE_ARN || "").trim(),
      FERN_TOKEN: String(env.FERN_TOKEN || "").trim(),
      KUBECONFIG_B64: String(env.KUBECONFIG_B64 || "").trim(),
    };
    const requiredSecrets = new Set<string>(["POSTMAN_API_KEY"]);
    if (
      runtimeMode === "ecs_service"
      || runtimeMode === "k8s_workspace"
      || (runtimeMode === "k8s_discovery" && k8sDiscoveryWorkspaceLink)
    ) {
      requiredSecrets.add("POSTMAN_ACCESS_TOKEN");
    }
    if (isKubernetesRuntime(runtimeMode)) {
      requiredSecrets.add("KUBECONFIG_B64");
    }
    if (featureFlags.patFallbackEnabled) {
      requiredSecrets.add("GH_TOKEN");
    }

    const secretPlan = buildSecretInjectionPlan(
      allSecrets,
      credentialPolicy.secretSourceMode,
      [...SHARED_ORG_SECRET_NAMES],
      featureFlags.patFallbackEnabled ? ["GH_TOKEN"] : [],
    );
    const skippedShared = new Set(secretPlan.skippedBecauseOrgScoped);
    const requiredRepoSecretNames = [...requiredSecrets].filter((name) => !skippedShared.has(name));

    console.log("[provision][secrets] injection plan", {
      mode: credentialPolicy.secretSourceMode,
      totalConfigured: Object.keys(allSecrets).length,
      injectRepoCount: Object.keys(secretPlan.injectRepoSecrets).length,
      injectedRepoSecretNames: Object.keys(secretPlan.injectRepoSecrets).sort(),
      skippedOrgScopedSecretNames: [...secretPlan.skippedBecauseOrgScoped].sort(),
      requiredRepoSecretNames: requiredRepoSecretNames.sort(),
    });

    for (const name of requiredRepoSecretNames) {
      if (!secretPlan.injectRepoSecrets[name]) {
        throw new Error(`Required secret ${name} is missing from worker environment`);
      }
    }

    try {
      const failures = await createRepoSecrets(githubAppToken, repoName, secretPlan.injectRepoSecrets);
      for (const [name, errorMessage] of Object.entries(failures)) {
        if (requiredRepoSecretNames.includes(name)) {
          throw new Error(`Failed to set required repo secret ${name}: ${errorMessage}`);
        }
        console.warn(`Failed to set secret ${name}: ${errorMessage}`);
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to inject repository secrets: ${errMessage}`);
    }

    if (!isEnvironmentExpansion) {
      sse.send({
        phase: "github",
        status: "complete",
        message: "Repository created",
        data: { repo_url: repoUrl },
      });
      createdRepoName = repoName;
      appendLog(`GitHub repo created: ${repoUrl}`);
      await flushToAirtable({ github_repo_url: repoUrl });
    } else {
      sse.send({
        phase: "github",
        status: "complete",
        message: "Repository ready for environment expansion",
        data: { repo_url: repoUrl },
      });
      appendLog(`GitHub repo prepared for environment expansion: ${repoUrl}`);
    }

    const ecsInfra = ecsRuntime.infra;
    const ecsClusterName = runtimeMode === "ecs_service" ? ecsInfra.clusterName : "";
    await flushInventoryToAirtable({
      status: "provisioning",
      runtime_mode: runtimeMode,
      runtime_base_url: runtimeBaseUrl,
      aws_invoke_url: containerRuntime ? runtimeBaseUrl : "",
      aws_region: String(env.AWS_REGION || "eu-central-1"),
      ecs_cluster_name: ecsClusterName,
      ecs_service_name: ecsServiceName,
      ecs_task_definition: ecsTaskDefinition,
    });

    // Set repo variables needed by provision workflow
    try {
      const setProvisionVar = async (name: string, value: string): Promise<void> => {
        await setRepoVarRespectingOrgScope(
          githubAppToken,
          repoName,
          name,
          value,
          credentialPolicy.variableSourceMode,
        );
      };

      await setProvisionVar("CROSS_REPO_PAT_FALLBACK", "true");
      await setProvisionVar("POSTMAN_TEAM_ID", canonicalTeamId);
      if (canonicalTeamSlug) {
        await setProvisionVar("POSTMAN_TEAM_SLUG", canonicalTeamSlug);
      }
      await setProvisionVar("RUNTIME_MODE", runtimeMode);
      await setProvisionVar("RUNTIME_BASE_URL", runtimeBaseUrl);
      if (req.workspace_admin_ids?.length) {
        await setProvisionVar("WORKSPACE_ADMIN_USER_IDS", req.workspace_admin_ids.join(","));
      }
      await setProvisionVar("CI_ENVIRONMENT", "Production");
      await setProvisionVar("CHAOS_ENABLED", chaosEnabled ? "true" : "false");

      // Set system environment UIDs as repo variables for all runtimes.
      // Used for environment creation and Bifrost associations.
      if (systemEnvProd) {
        await setProvisionVar("POSTMAN_SYSTEM_ENV_PROD", systemEnvProd);
      }
      for (const sysEnv of resolvedSystemEnvs) {
        if (sysEnv.slug !== "prod") {
          const sanitizedSlug = sysEnv.slug.toUpperCase().replace(/-/g, "_");
          await setProvisionVar(`POSTMAN_SYSTEM_ENV_${sanitizedSlug}`, sysEnv.id);
        }
      }
      if (selectedBranches.length > 0) {
        await setProvisionVar("ENV_BRANCH_MAP_JSON", JSON.stringify(environmentBranchMap));
      }

      if (runtimeMode === "ecs_service") {
        await setProvisionVar("ECS_CLUSTER_NAME", ecsClusterName);
        await setProvisionVar("ECS_VPC_ID", ecsInfra.vpcId);
        await setProvisionVar("ECS_SUBNET_IDS", ecsInfra.subnetIds.join(","));
        await setProvisionVar("ECS_SECURITY_GROUP_IDS", ecsInfra.securityGroupIds.join(","));
        await setProvisionVar("ECS_EXECUTION_ROLE_ARN", ecsInfra.executionRoleArn);
        await setProvisionVar("ECS_TASK_ROLE_ARN", ecsInfra.taskRoleArn || "");
        await setProvisionVar("ECS_ALB_LISTENER_ARN", ecsInfra.albListenerArn);
        await setProvisionVar("ECS_ALB_DNS_NAME", ecsInfra.albDnsName);
        await setProvisionVar("ECS_ECR_REPOSITORY", ecsInfra.ecrRepository);
        await setProvisionVar("ECS_MAX_SERVICES", String(ecsRuntime.maxServices));
        await setProvisionVar("ECS_SERVICE_NAME", ecsServiceName);
        await setProvisionVar("ECS_TASK_DEFINITION", ecsTaskDefinition);
      }
      if (isKubernetesRuntime(runtimeMode)) {
        await setProvisionVar("K8S_NAMESPACE", k8sNamespace);
        await setProvisionVar("K8S_INGRESS_BASE_DOMAIN", k8sIngressBaseDomain);
        if (k8sContext) {
          await setProvisionVar("K8S_CONTEXT", k8sContext);
        }
        if (runtimeMode === "k8s_discovery") {
          await setProvisionVar("POSTMAN_INSIGHTS_CLUSTER_NAME", insightsClusterName);
          if (hostPort) {
            await setProvisionVar("K8S_HOST_PORT", hostPort);
          }
        }
      }
    } catch (err) {
      console.warn("Failed to set provisioning repo variables:", err);
    }

    if (selectedBranches.length > 1) {
      sse.send({ phase: "github", status: "running", message: "Creating environment branches..." });
      for (const branch of selectedBranches) {
        await createBranchIfMissing(githubAppToken, repoName, branch, repoDefaultBranch);
      }
      appendLog(`Environment branches ready: ${selectedBranches.join(", ")}`);
    }

    // Resolve runtime dependencies to URLs.
    const depTargetsJson = await resolveDependencyTargets({
      specId: resolvedSpec.source,
      projectName: req.project_name,
      repoName,
      runtimeMode,
      environments,
      k8sIngressBaseDomain,
      k8sNamespace,
      githubAppToken,
      env,
    });

    // Capture the baseline run (if any) before we trigger, so the correlation
    // guard below can detect a genuinely NEW run rather than accepting a stale
    // run left over from a previous provision attempt on the same repo.
    let previousRun: { id: number } | null = null;
    try {
      previousRun = await getLatestWorkflowRun(githubAppToken, repoName, "provision.yml");
    } catch {
      // If the repo was just created there may be no runs yet — that's fine.
    }

    // Trigger provision.yml (retry — GitHub Actions may need time to index new workflow)
    sse.send({ phase: "postman", status: "running", message: "Triggering provisioning workflow..." });

    // Store allocated host port in Airtable
    if (runtimeMode === "k8s_discovery" && hostPort && airtableRecordId) {
      await updateDeployment(env, airtableRecordId, { dedicated_port: hostPort });
    }

    let triggerAttempts = 0;
    while (triggerAttempts < 5) {
      try {
        await triggerWorkflow(githubAppToken, repoName, "provision.yml", {
          project_name: req.project_name,
          domain: req.domain,
          domain_code: domainCode,
          requester_email: req.requester_email,
          environments: JSON.stringify(environments),
          system_env_map: JSON.stringify(systemEnvMap),
          postman_team_id: canonicalTeamId,
          postman_team_slug: canonicalTeamSlug,
          workspace_team_id: (req.workspace_team_id != null && req.workspace_team_id > 0) ? String(req.workspace_team_id) : "",
          workspace_team_name: req.workspace_team_name || "",
          runtime_mode: runtimeMode,
          deployment_mode: deploymentMode,
          spec_url: resolvedSpec.specUrl,
          chaos_enabled: chaosEnabled ? "true" : "false",
          chaos_config: resolveChaosConfig(req),
          github_workspace_sync: githubWorkspaceSync ? "true" : "false",
          environment_sync_enabled: environmentSyncEnabled ? "true" : "false",
          k8s_discovery_workspace_link: runtimeMode === "k8s_discovery"
            ? String(k8sDiscoveryWorkspaceLink)
            : "false",
          host_port: hostPort,
          dependency_targets_json: depTargetsJson,
        });
        break;
      } catch (err: unknown) {
        triggerAttempts++;
        if (triggerAttempts >= 5) throw err;
        await sleep(3000);
      }
    }

    // Wait for workflow run visibility after dispatch
    let runId: number | null = null;
    let runUrl = "";
    let runStatus = "queued";
    let runConclusion: string | null = null;
    let runUpdatedAt = "";
    let attempts = 0;
    while (!runId && attempts < 30) {
      const run = await getLatestWorkflowRun(githubAppToken, repoName, "provision.yml");
      /* istanbul ignore next -- @preserve */
      if (run && (!previousRun || run.id !== previousRun.id)) {
        runId = run.id;
        runUrl = run.html_url;
        runStatus = run.status;
        runConclusion = run.conclusion;
        runUpdatedAt = run.updated_at || "";
        sse.send({
          phase: "postman",
          status: "running",
          message: "Workflow started...",
          data: { run_url: run.html_url },
        });
      } else {
        /* istanbul ignore next -- @preserve */
        await sleep(2000);
        /* istanbul ignore next -- @preserve */
        attempts++;
      }
    }

    /* istanbul ignore next -- @preserve timeout requires 40s of polling */
    if (!runId) {
      sse.send({ phase: "postman", status: "error", message: "Workflow did not start within correlation timeout" });
      throw new Error("Workflow did not start within correlation timeout");
    }

    // Poll jobs/steps until terminal state
    let completed = false;
    let lastStepsSeen = 0;
    let stepFailed = false;
    const pollStartTime = Date.now();
    let inFinalPhase = false;
    let supportsRunById = true;
    let lastRunUpdatedAt = runUpdatedAt;
    let lastJobsPolledAt = 0;
    const MIN_JOBS_POLL_INTERVAL_MS = featureFlags.workflowCallbacksEnabled ? 60_000 : 15_000;
    let callbackState: { status: string; conclusion: string | null; html_url: string } | null = null;
    let lastCallbackUpdateAt = 0;
    let callbackError: string | null = null;
    if (featureFlags.workflowCallbacksEnabled && runId) {
      sse.send({
        phase: "postman",
        status: "running",
        message: "Workflow callback shadow mode enabled; polling watchdog interval set to 60s",
      });
      streamRunProgressFromCallbacks({
        env,
        repoName,
        runId,
        sse,
        timeoutMs: 20 * 60 * 1000,
        onUpdate: (state) => {
          callbackState = state;
          lastCallbackUpdateAt = Date.now();
        },
      })
        .then((state) => {
          if (state.status === "completed") {
            callbackState = state;
            lastCallbackUpdateAt = Date.now();
          }
        })
        .catch((err) => {
          callbackError = err instanceof Error ? err.message : String(err);
          console.warn("[provision][callbacks] callback stream failed; continuing watchdog polling", callbackError);
        });
    }

    while (!completed) {
      // Adaptive polling with phase awareness
      const elapsed = Date.now() - pollStartTime;
      let base: number;
      if (inFinalPhase) {
        base = 3500; // Fast polling near completion
      } else if (runStatus === "queued") {
        base = 12_000; // Slow down while queued; little changes before runners start
      } else if (elapsed < 45_000) {
        base = 5000;
      } else if (elapsed < 180_000) {
        base = 10_000;
      } else {
        base = 20_000;
      }
      if (featureFlags.workflowCallbacksEnabled) {
        base = Math.max(base, 60_000);
      }
      const jitter = Math.round(base * 0.2 * (Math.random() * 2 - 1));
      await sleep(base + jitter);

      type CallbackState = { status: string; conclusion: string | null; html_url: string };
      const completedCallbackState: CallbackState | null = (() => {
        const snapshot = callbackState as CallbackState | null;
        if (snapshot && snapshot.status === "completed") {
          return snapshot;
        }
        return null;
      })();
      let currentRunConclusion = runConclusion;
      let currentRunUpdatedAt = runUpdatedAt;
      if (completedCallbackState) {
        runStatus = "completed";
        currentRunConclusion = completedCallbackState.conclusion;
        runUrl = completedCallbackState.html_url || runUrl;
      }

      if (shouldUseCallbackWatchdogOnly({
        callbacksEnabled: featureFlags.workflowCallbacksEnabled,
        callbackState,
        callbackError,
        lastCallbackUpdateAt,
        watchdogIntervalMs: MIN_JOBS_POLL_INTERVAL_MS,
      })) {
        continue;
      }

      if (supportsRunById) {
        try {
          const run = await getWorkflowRunById(githubAppToken, repoName, runId);
          if (run) {
            runUrl = run.html_url || runUrl;
            runStatus = run.status;
            currentRunConclusion = run.conclusion;
            currentRunUpdatedAt = run.updated_at || currentRunUpdatedAt;
          } else {
            // Fallback for environments where /actions/runs/{id} is unavailable.
            supportsRunById = false;
          }
        } catch {
          supportsRunById = false;
        }
      }

      const now = Date.now();
      const runChanged = supportsRunById
        ? currentRunUpdatedAt !== lastRunUpdatedAt
        : true;
      const shouldPollJobs = !supportsRunById
        || lastJobsPolledAt === 0
        || runChanged
        || runStatus === "completed"
        || now - lastJobsPolledAt >= MIN_JOBS_POLL_INTERVAL_MS;

      if (supportsRunById) {
        lastRunUpdatedAt = currentRunUpdatedAt;
      }
      runUpdatedAt = currentRunUpdatedAt;
      runConclusion = currentRunConclusion;

      if (!shouldPollJobs) {
        continue;
      }
      lastJobsPolledAt = now;

      const jobs = await getWorkflowJobs(githubAppToken, repoName, runId);

      for (const job of jobs) {
        for (const step of job.steps) {
          /* istanbul ignore next -- @preserve dedup guard: step already processed in prior poll */
          if (step.number <= lastStepsSeen) continue;

          if (!(step.name in STEP_PHASE_MAP)) {
            if (step.status === "completed") lastStepsSeen = Math.max(lastStepsSeen, step.number);
            continue;
          }

          const phase = STEP_PHASE_MAP[step.name];
          const desc = STEP_DESCRIPTIONS[step.name] || step.name;

          if (stepFailed) {
            if (step.status === "completed") lastStepsSeen = Math.max(lastStepsSeen, step.number);
            continue;
          }

          if (step.status === "in_progress") {
            sse.send({ phase, status: "running", message: desc });
          } else if (step.status === "completed") {
            if (step.conclusion === "success") {
              sse.send({ phase, status: "complete", message: desc });
              if ((PHASE_LAST_STEP[phase] || []).includes(step.name)) {
                appendLog(`Phase "${phase}" completed`);
                try {
                  if (phase === "postman") {
                    appendLog("Postman phase completed (workspace created, collections next)");
                    sse.send({ phase, status: "complete", message: desc });
                  } else if (phase === "spec") {
                    // Bulk-fetch all vars at phase boundary (1-2 calls instead of ~7)
                    const phaseVars = await listRepoVariables(githubAppToken, repoName);
                    const wsId = phaseVars.POSTMAN_WORKSPACE_ID || "";
                    if (wsId) {
                      createdWorkspaceId = wsId;
                      appendLog(`Postman workspace provisioned: ${wsId}`);
                    }
                    const lintData = await fetchLintVars(githubAppToken, repoName, phaseVars);
                    const smokeUid = phaseVars.POSTMAN_SMOKE_COLLECTION_UID || "";
                    const contractUid = phaseVars.POSTMAN_CONTRACT_COLLECTION_UID || "";
                    const baselineUid = phaseVars.POSTMAN_BASELINE_COLLECTION_UID || "";
                    const specUid = phaseVars.POSTMAN_SPEC_UID || "";
                    appendLog(`Collections provisioned: baseline=${baselineUid} smoke=${smokeUid} contract=${contractUid}`);
                    appendLog(`Spec UID: ${specUid}`);
                    await flushToAirtable({
                      workspace_id: wsId,
                      postman_workspace_url: wsId ? `https://go.postman.co/workspace/${wsId}` : "",
                      postman_collection_uids: [baselineUid, smokeUid, contractUid].filter(Boolean).join(","),
                      postman_spec_uid: specUid,
                    });
                    sse.send({ phase, status: "complete", message: desc, data: lintData });
                  } else if (phase === "aws") {
                    // Bulk-fetch all vars at phase boundary (1-2 calls instead of ~7)
                    const phaseVars = await listRepoVariables(githubAppToken, repoName);
                    const devGwUrl = phaseVars.DEV_GW_URL || "";
                    const funcName = phaseVars.FUNCTION_NAME || "";
                    const apiGatewayId = phaseVars.DEV_API_ID || "";
                    const runtimeModeValue = phaseVars.RUNTIME_MODE || runtimeMode;
                    const runtimeBase = phaseVars.RUNTIME_BASE_URL || runtimeBaseUrl;
                    const ecsTargetGroupArn = runtimeMode === "ecs_service"
                      ? (phaseVars.ECS_TARGET_GROUP_ARN || "")
                      : "";
                    const ecsListenerRuleArn = runtimeMode === "ecs_service"
                      ? (phaseVars.ECS_LISTENER_RULE_ARN || "")
                      : "";
                    appendLog(`AWS provisioned: function=${funcName} gateway=${devGwUrl} api=${apiGatewayId || "n/a"}`);
                    if (ecsTargetGroupArn || ecsListenerRuleArn) {
                      appendLog(`ECS ARNs: tg=${ecsTargetGroupArn} rule=${ecsListenerRuleArn}`);
                    }
                    await flushInventoryToAirtable({
                      status: "provisioning",
                      runtime_mode: runtimeModeValue,
                      aws_invoke_url: devGwUrl,
                      runtime_base_url: runtimeBase,
                      api_gateway_id: apiGatewayId,
                      lambda_function_name: funcName,
                      aws_region: String(env.AWS_REGION || "eu-central-1"),
                      ecs_cluster_name: ecsClusterName,
                      ecs_service_name: ecsServiceName,
                      ecs_task_definition: ecsTaskDefinition,
                      ecs_target_group_arn: ecsTargetGroupArn,
                      ecs_listener_rule_arn: ecsListenerRuleArn,
                    });
                    sse.send({ phase, status: "complete", message: desc });
                    inFinalPhase = true; // Accelerate polling for final phase
                  } else if (phase === "postman-env") {
                    // Bulk-fetch all vars at phase boundary (1-2 calls instead of ~2)
                    const phaseVars = await listRepoVariables(githubAppToken, repoName);
                    const envUid = phaseVars.POSTMAN_ENVIRONMENT_UID || "";
                    const mockUrl = phaseVars.MOCK_URL || "";
                    appendLog(`Postman env provisioned: env=${envUid} mock=${mockUrl}`);
                    await flushToAirtable({
                      postman_environment_uid: envUid,
                      mock_url: mockUrl,
                    });
                    sse.send({ phase, status: "complete", message: desc });
                  } else {
                    sse.send({ phase, status: "complete", message: desc });
                  }
                } catch {
                  sse.send({ phase, status: "complete", message: desc });
                }
              }
            } else if (step.conclusion === "failure") {
              appendLog(`FAILED at step: ${step.name} (phase: ${phase})`);
              sse.send({ phase, status: "error", message: `Failed: ${desc}` });
              stepFailed = true;
              await flushToAirtable({
                status: "failed",
                failed_at_step: step.name,
                error_message: `Failed: ${desc}`,
              });
            }
            lastStepsSeen = Math.max(lastStepsSeen, step.number);
          }
        }
      }

      // If finalize has started, tighten polling cadence.
      if (!inFinalPhase) {
        inFinalPhase = jobs.some((job) => {
          const jobName = String(job.name || "").toLowerCase();
          return jobName.includes("finalize") && job.status !== "queued";
        });
      }

      const runCompleted = runStatus === "completed";
      const allJobsCompleted = jobs.length > 0 && jobs.every(j => j.status === "completed");
      const terminalStateReached = allJobsCompleted || (runCompleted && jobs.length === 0);
      if (terminalStateReached) {
        if (callbackError) {
          appendLog(`Callback stream error: ${callbackError} (watchdog polling completed run)`);
        }
        completed = true;

        const anyFailed = jobs.some(j => j.conclusion === "failure" || j.conclusion === "cancelled")
          || (runCompleted && runConclusion !== null && runConclusion !== "success");
        if (!anyFailed) {
          // Build final data from repo variables
          const snapshot = await buildFinalDeploymentSnapshot({
            token: githubAppToken,
            repoName,
            projectName: req.project_name,
            requestedEnvironments: environments,
            defaultAwsRegion: String(env.AWS_REGION || "eu-central-1"),
            existingRecord: existing,
          });
          const finalData = snapshot.finalData;

          sse.send({
            phase: "complete",
            status: "complete",
            message: "Provisioning complete!",
            data: finalData,
          });
          outcome = { success: true, data: finalData };
          appendLog("Provisioning complete!");

          // Update Airtable with all final resource data
          await flushInventoryToAirtable(snapshot.airtableFields);

          // Acknowledge workspace onboarding for k8s_discovery with workspace linkage.
          // The finalize action attempts this inside a per-environment try/catch which
          // can silently skip it if earlier onboarding steps fail. This server-side
          // call acts as a safety net so the Insights agent resolves proper identity.
          const shouldAcknowledgeWorkspace = createdWorkspaceId && (runtimeMode !== "k8s_discovery" || k8sDiscoveryWorkspaceLink);
          if (shouldAcknowledgeWorkspace) {
            const accessToken = creds.access_token;
            const teamId = canonicalTeamId;
            if (accessToken && teamId) {
              const ackResult = await acknowledgeWorkspaceWithRetry(accessToken, teamId, createdWorkspaceId!);
              if (ackResult.success) {
                appendLog(`Workspace onboarding acknowledged: ${createdWorkspaceId} (attempt ${ackResult.attempts})`);
              } else {
                appendLog(`Workspace acknowledge failed after ${ackResult.attempts} attempts: ${ackResult.lastError}`);
                sse.send({
                  phase: "complete",
                  status: "complete",
                  message: "Provisioning complete (workspace acknowledge pending)",
                  data: { bifrost_acknowledge_failed: true, error: ackResult.lastError },
                });
              }
            }
          }
        } else {
          const failedJob = jobs.find(j => j.conclusion === "failure" || j.conclusion === "cancelled");
          const failMsg = `Workflow failed: ${failedJob?.conclusion || runConclusion || "failure"}`;
          appendLog(failMsg);
          sse.send({
            phase: "complete",
            status: "error",
            message: failMsg,
            data: { run_url: runUrl },
          });
          outcome = { success: false, error: failMsg };

          // Try to fetch workspace ID from repo vars if not captured during SSE
          if (!createdWorkspaceId) {
            try {
              createdWorkspaceId = await fetchRepoVar(githubAppToken, repoName, "POSTMAN_WORKSPACE_ID");
              appendLog(`Found workspace ID from repo vars: ${createdWorkspaceId}`);
            } catch { /* workspace may not have been created */ }
          }

          // Retain workspace and repo for teardown/recovery -- do NOT delete inline.
          // Teardown handles full resource cleanup (AWS, Postman, GitHub) using repo variables.
          if (createdWorkspaceId) {
            appendLog(`Postman workspace ${createdWorkspaceId} retained for teardown/recovery`);
          }
          if (createdRepoName) {
            appendLog(`GitHub repo ${org}/${createdRepoName} retained for teardown/recovery`);
          }

          await flushToAirtable({
            status: "failed",
            failed_at_step: "github-actions-workflow",
            error_message: failMsg,
          });
        }
      }
    }
    /* istanbul ignore next -- @preserve */
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const hasRepoCreationSignal = /already exists/i.test(errorMsg) || /repository creation failed/i.test(errorMsg);
    const existingRecord = hasRepoCreationSignal
      ? await getDeployment(env, repoName)
      : null;
    const shouldAttemptRemoteRecovery = Boolean(existingRecord && hasActiveEnvSignal(existingRecord))
      || (hasRepoCreationSignal && isRetry);
    if (shouldAttemptRemoteRecovery) {
      const reconciledRecord = await reconcileSuccessfulDeploymentRecord(
        env,
        existingRecord,
        githubAppToken,
        { force: true },
      );
      if (reconciledRecord?.status === "active") {
        const snapshot = await buildFinalDeploymentSnapshot({
          token: githubAppToken,
          repoName,
          projectName: req.project_name,
          requestedEnvironments: environments,
          defaultAwsRegion: String(env.AWS_REGION || "eu-central-1"),
          existingRecord,
        });
        appendLog("Recovered successful deployment state from GitHub metadata after local pipeline error");
        await flushInventoryToAirtable(snapshot.airtableFields);
        sse.send({
          phase: "complete",
          status: "complete",
          message: "Provisioning complete!",
          data: snapshot.finalData,
        });
        return {
          success: true,
          data: snapshot.finalData,
        };
      }
    }

    outcome = { success: false, error: errorMsg };
    appendLog(`ERROR: ${errorMsg}`);
    sse.send({ phase: "error", status: "error", message: errorMsg });

    // Retain workspace and repo for teardown/recovery -- do NOT delete inline.
    if (createdWorkspaceId) {
      appendLog(`Postman workspace ${createdWorkspaceId} retained for teardown/recovery`);
    }
    if (createdRepoName) {
      appendLog(`GitHub repo ${org}/${createdRepoName} retained for teardown/recovery`);
    }

    await flushToAirtable({
      status: "failed",
      failed_at_step: "pipeline",
      error_message: errorMsg,
    });
  } finally {
    await Promise.allSettled(workerLogTasks);
    if (options?.closeStream !== false) {
      sse.close();
    }
  }
  return outcome;
}

async function autoTeardownForRetry(
  repoName: string,
  existingRecord: DeploymentRecord | null,
  env: Env,
  githubAppToken: string,
  appendLog: (msg: string) => void,
): Promise<void> {
  const org = getOrg();
  let repoVariables: Record<string, string> = {};
  try {
    repoVariables = await listRepoVariables(githubAppToken, repoName);
  } catch {
    repoVariables = {};
  }
  const getVar = (name: string): string | null => {
    const value = repoVariables[name];
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    return trimmed || null;
  };

  const workspaceId = existingRecord?.workspace_id || getVar("POSTMAN_WORKSPACE_ID");
  const insightsProjectId = existingRecord?.postman_insights_project_id || getVar("POSTMAN_INSIGHTS_PROJECT_ID");
  const postmanTeamId = existingRecord?.postman_team_id || getVar("POSTMAN_TEAM_ID");
  const postmanTeamSlug = existingRecord?.postman_team_slug || getVar("POSTMAN_TEAM_SLUG");
  const runtimeModeValue = existingRecord?.runtime_mode || getVar("RUNTIME_MODE");
  const runtimeMode = runtimeModeValue ? normalizeRuntimeMode(runtimeModeValue) : "lambda";
  const functionName = existingRecord?.lambda_function_name || getVar("FUNCTION_NAME");
  const gatewayUrl = existingRecord?.aws_invoke_url || getVar("DEV_GW_URL");
  const ecsClusterName = existingRecord?.ecs_cluster_name || getVar("ECS_CLUSTER_NAME");
  const ecsServiceName = existingRecord?.ecs_service_name || getVar("ECS_SERVICE_NAME");
  const ecsTargetGroupArn = existingRecord?.ecs_target_group_arn || getVar("ECS_TARGET_GROUP_ARN");
  const ecsListenerRuleArn = existingRecord?.ecs_listener_rule_arn || getVar("ECS_LISTENER_RULE_ARN");
  const k8sNamespace = existingRecord?.k8s_namespace || getVar("K8S_NAMESPACE");
  const k8sDeploymentName = existingRecord?.k8s_deployment_name || getVar("K8S_DEPLOYMENT_NAME");
  const k8sServiceName = existingRecord?.k8s_service_name || getVar("K8S_SERVICE_NAME");
  const k8sIngressName = existingRecord?.k8s_ingress_name || getVar("K8S_INGRESS_NAME");
  const environmentDeploymentsJson = existingRecord?.environment_deployments || getVar("ENVIRONMENT_DEPLOYMENTS_JSON");
  const envResourceNamesJson = getVar("ENV_RESOURCE_NAMES_JSON");

  const teamCreds = await resolveTeamCredentials(
    env.TEAM_REGISTRY,
    env,
    postmanTeamSlug || undefined,
  );

  // Delete Insights project
  if (insightsProjectId && teamCreds.access_token) {
    try {
      // Use the Bifrost proxy to delete the Insights service
      const headers: Record<string, string> = {
        "x-access-token": teamCreds.access_token,
        "Content-Type": "application/json",
      };
      if (postmanTeamId) {
        headers["x-entity-team-id"] = postmanTeamId;
      }
      await fetch("https://bifrost-premium-https-v4.gw.postman.com/ws/proxy", {
        method: "POST",
        headers,
        body: JSON.stringify({
          service: "akita",
          method: "delete",
          path: `/v2/services/${insightsProjectId}`,
          body: {},
        }),
      });
      appendLog(`Auto-teardown: deleted Insights project ${insightsProjectId}`);
    } catch {
      appendLog("Auto-teardown: Insights project delete failed (may already be deleted)");
    }
  }

  // Delete Postman workspace
  if (workspaceId) {
    try {
      await fetch(`https://api.getpostman.com/workspaces/${workspaceId}`, {
        method: "DELETE",
        headers: { "X-Api-Key": teamCreds.api_key },
      });
      appendLog(`Auto-teardown: deleted workspace ${workspaceId}`);
    } catch {
      appendLog("Auto-teardown: workspace delete failed (may already be deleted)");
    }
  }

  // AWS cleanup via teardown workflow (if Lambda/ECS resources exist)
  const hasAwsResources = Boolean(
    functionName
      || gatewayUrl
      || runtimeMode === "ecs_service"
      || isKubernetesRuntime(runtimeMode),
  );
  if (hasAwsResources) {
    try {
      const cleanupOptions = runtimeMode === "ecs_service"
        ? {
            ecs_cluster_name: ecsClusterName,
            ecs_service_name: ecsServiceName,
            ecs_target_group_arn: ecsTargetGroupArn,
            ecs_listener_rule_arn: ecsListenerRuleArn,
            env_resource_names_json: envResourceNamesJson,
            environment_deployments_json: environmentDeploymentsJson,
          }
        : isKubernetesRuntime(runtimeMode)
          ? {
              k8s_namespace: k8sNamespace,
              k8s_deployment_name: k8sDeploymentName,
              k8s_service_name: k8sServiceName,
              k8s_ingress_name: k8sIngressName,
              env_resource_names_json: envResourceNamesJson,
              environment_deployments_json: environmentDeploymentsJson,
            }
          : {};
      await runAwsCleanupWorkflow(repoName, repoName, runtimeMode, env, githubAppToken, cleanupOptions);
      appendLog("Auto-teardown: AWS cleanup workflow completed");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog(`Auto-teardown: AWS cleanup failed: ${msg} (continuing with repo deletion)`);
    }
  }

  // Delete GitHub repo last (needed for variable lookups above)
  try {
    await deleteRepo(githubAppToken, repoName);
    appendLog(`Auto-teardown: deleted repo ${org}/${repoName}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not delete existing failed repo ${org}/${repoName}: ${message}`);
  }

  // Wait until GitHub confirms the repository is gone before re-creating it.
  for (let attempt = 0; attempt < 10; attempt++) {
    const stillExists = await repoExists(githubAppToken, repoName);
    if (!stillExists) return;
    await sleep(3000);
  }
  throw new Error(`Repo ${org}/${repoName} still exists after auto-teardown`);
}

async function fetchRepoVar(
  token: string,
  repoName: string,
  name: string
): Promise<string> {
  const value = await getRepoVariable(token, repoName, name);
  if (!value) throw new Error(`Variable ${name} not found`);
  return value;
}

async function fetchLintVars(
  token: string,
  repoName: string,
  cachedVars?: Record<string, string>
): Promise<{ passed: boolean; warnings: number; errors: number }> {
  // Use cached vars if available, otherwise fetch individually
  if (cachedVars) {
    const warnings = parseInt(cachedVars.LINT_WARNINGS || "0", 10);
    const errors = parseInt(cachedVars.LINT_ERRORS || "0", 10);
    return { passed: errors === 0, warnings, errors };
  }
  const fetchVar = async (name: string): Promise<string> => {
    try {
      return await getRepoVariable(token, repoName, name);
    } catch {
      return "0";
    }
  };

  const warnings = parseInt(await fetchVar("LINT_WARNINGS"), 10);
  const errors = parseInt(await fetchVar("LINT_ERRORS"), 10);
  return { passed: errors === 0, warnings, errors };
}

export async function buildFinalData(
  token: string,
  repoName: string,
  req: ProvisionRequest
): Promise<Record<string, unknown>> {
  const snapshot = await buildFinalDeploymentSnapshot({
    token,
    repoName,
    projectName: req.project_name,
    requestedEnvironments: req.environments,
  });
  return snapshot.finalData;
}

export function getDomainCode(domain: string, config?: PortalConfig | null): string {
  // Use portal config domain codes if available
  if (config?.domains) {
    const match = config.domains.find((d) => d.value === domain);
    if (match?.code) return match.code;
  }
  // Use first 4 chars of domain in uppercase as the code
  return (domain || "MISC").substring(0, 4).toUpperCase();
}

function resolveRuntimeMode(req: ProvisionRequest, config?: PortalConfig | null): ProvisionRuntime {
  if (req.runtime) return normalizeRuntimeMode(req.runtime);

  const templateId = req.template_id || req.template || "";
  if (templateId && config?.templates?.length) {
    const template = config.templates.find((candidate) =>
      String(candidate.id || "").toLowerCase() === String(templateId).toLowerCase()
      || String(candidate.title || "").toLowerCase() === String(templateId).toLowerCase(),
    );
    if (template?.runtime) return normalizeRuntimeMode(template.runtime);
  }

  return normalizeRuntimeMode(config?.backend?.runtime_defaults?.default_runtime);
}

// Re-exported from ./sleep so existing imports still work
export { sleep } from "./sleep";
