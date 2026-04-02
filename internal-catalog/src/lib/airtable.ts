/**
 * Airtable REST API wrapper for Deployments and Infrastructure tables.
 *
 * Requires env vars: AIRTABLE_API_KEY, AIRTABLE_BASE_ID
 */

import { sleep } from "./sleep";

const AIRTABLE_API = "https://api.airtable.com/v0";
const AIRTABLE_FALLBACK_MIN_SPACING_MS = 250;
const AIRTABLE_429_MAX_RETRIES = 4;
const AIRTABLE_429_BACKOFF_BASE_MS = 500;
const AIRTABLE_429_BACKOFF_MAX_MS = 10_000;
const GRAPH_MEMBERSHIPS_TABLE = "GraphMemberships";

interface AirtableLimiterState {
  queue: Promise<void>;
  lastRequestAt: number;
}

const airtableLimiterByBase = new Map<string, AirtableLimiterState>();
const graphMembershipTableSupportByBase = new Map<string, boolean>();

export interface DeploymentRecord {
  id?: string; // Airtable record ID
  spec_id: string;
  status: "provisioning" | "active" | "failed" | "deprovisioned";
  workspace_team_id?: string;
  workspace_team_name?: string;
  runtime_mode?: string;
  runtime_base_url?: string;
  github_repo_url?: string;
  github_repo_name?: string;
  postman_workspace_url?: string;
  workspace_id?: string;
  postman_spec_uid?: string;
  postman_collection_uids?: string;
  postman_run_url?: string;
  postman_environment_uid?: string;
  postman_team_slug?: string;
  postman_team_id?: string;
  postman_insights_project_id?: string;
  request_context_json?: string;
  mock_url?: string;
  aws_invoke_url?: string;
  aws_region?: string;
  lambda_function_name?: string;
  api_gateway_id?: string;
  ecs_cluster_name?: string;
  ecs_service_name?: string;
  ecs_task_definition?: string;
  ecs_target_group_arn?: string;
  ecs_listener_rule_arn?: string;
  k8s_namespace?: string;
  k8s_deployment_name?: string;
  k8s_service_name?: string;
  k8s_ingress_name?: string;
  k8s_cluster_name?: string;
  dedicated_ip?: string;
  dedicated_port?: string;
  graph_transport_url?: string;
  node_name?: string;
  resource_inventory_json?: string;
  iam_role_name?: string;
  deployed_at?: string;
  logs?: string;
  failed_at_step?: string;
  error_message?: string;
  fern_docs_url?: string;
  system_env_map?: string;
  environments_json?: string;
  environment_deployments?: string;
  deployment_mode?: string;
  deployment_group_id?: string;
  deployment_root_spec_id?: string;
  graph_node_meta_json?: string;
  chaos_enabled?: boolean;
  chaos_config?: string;
  /**
   * JSON map of environment slug → boolean (e.g. `{"prod":true,"stage":false}`).
   * Tracks per-environment chaos state independently of the aggregate `chaos_enabled` flag.
   * Written as a text field in Airtable; silently omitted if the column doesn't exist yet
   * (the updateDeployment self-healing logic strips unknown fields automatically).
   */
  chaos_enabled_map?: string;
}

/** Canonical tombstone field values for deprovisioned deployment records.
 *  Used by teardown.ts and deployment-recovery.ts -- keep in sync here. */
export const DEPLOYMENT_TOMBSTONE_FIELDS: Record<string, string | boolean> = {
  failed_at_step: "",
  error_message: "Deprovisioned",
  aws_invoke_url: "",
  lambda_function_name: "",
  api_gateway_id: "",
  github_repo_url: "",
  github_repo_name: "",
  postman_workspace_url: "",
  workspace_id: "",
  postman_spec_uid: "",
  postman_collection_uids: "",
  postman_run_url: "",
  postman_environment_uid: "",
  postman_insights_project_id: "",
  mock_url: "",
  environment_deployments: "",
  ecs_cluster_name: "",
  ecs_service_name: "",
  ecs_task_definition: "",
  ecs_target_group_arn: "",
  ecs_listener_rule_arn: "",
  k8s_namespace: "",
  k8s_deployment_name: "",
  k8s_service_name: "",
  k8s_ingress_name: "",
  resource_inventory_json: "",
  iam_role_name: "",
  chaos_enabled: false,
  chaos_enabled_map: "",
};

export interface InfraRecord {
  id?: string; // Airtable record ID
  component: string;
  status: string;
  cluster_name: string;
  vpc_id: string;
  subnet_ids: string;
  security_group_ids: string;
  execution_role_arn: string;
  task_role_arn: string;
  alb_arn: string;
  alb_listener_arn: string;
  alb_dns_name: string;
  ecr_repository: string;
  alb_sg_id: string;
  ecs_sg_id: string;
  aws_region: string;
  created_at: string;
  updated_at: string;
  last_error: string;
  last_run_url: string;
  k8s_namespace: string;
  k8s_daemonset_name: string;
  k8s_cluster_name: string;
  k8s_context: string;
}

export interface GraphMembershipRecord {
  id?: string;
  deployment_group_id: string;
  deployment_root_spec_id: string;
  spec_id: string;
  environment: string;
  layer_index?: number;
  node_status: string;
  node_action?: string;
  runtime_mode: string;
  graph_node_meta_json?: string;
}

interface AirtableEnv {
  AIRTABLE_API_KEY?: string;
  AIRTABLE_BASE_ID?: string;
  [key: string]: unknown;
}

function getConfig(env: AirtableEnv) {
  const apiKey = env.AIRTABLE_API_KEY;
  const baseId = env.AIRTABLE_BASE_ID;
  if (!apiKey || !baseId) {
    throw new Error("AIRTABLE_API_KEY and AIRTABLE_BASE_ID are required");
  }
  return { apiKey, baseId };
}

function getBaseId(env: AirtableEnv): string {
  return getConfig(env).baseId;
}

function getLimiterState(baseId: string): AirtableLimiterState {
  const existing = airtableLimiterByBase.get(baseId);
  if (existing) return existing;
  const state: AirtableLimiterState = {
    queue: Promise.resolve(),
    lastRequestAt: 0,
  };
  airtableLimiterByBase.set(baseId, state);
  return state;
}

async function waitForAirtableRateLimitSlot(baseId: string): Promise<void> {
  const limiter = getLimiterState(baseId);
  const queueItem = limiter.queue.then(async () => {
    const waitMs = Math.max(
      0,
      (limiter.lastRequestAt + AIRTABLE_FALLBACK_MIN_SPACING_MS) - Date.now(),
    );
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    limiter.lastRequestAt = Date.now();
  });

  limiter.queue = queueItem.catch(() => undefined);
  await queueItem;
}

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }

  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return null;
}

function get429RetryDelayMs(resp: Response, attempt: number): number {
  const retryAfterMs = parseRetryAfterMs(resp.headers.get("Retry-After"));
  if (retryAfterMs !== null) return retryAfterMs;

  const fallbackBackoff = AIRTABLE_429_BACKOFF_BASE_MS * (2 ** attempt);
  return Math.min(fallbackBackoff, AIRTABLE_429_BACKOFF_MAX_MS);
}

async function airtableFetch(
  env: AirtableEnv,
  table: string,
  path = "",
  options: RequestInit & { json?: unknown } = {}
): Promise<Response> {
  const { apiKey, baseId } = getConfig(env);
  const url = `${AIRTABLE_API}/${baseId}/${encodeURIComponent(table)}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  for (let attempt = 0; attempt <= AIRTABLE_429_MAX_RETRIES; attempt++) {
    await waitForAirtableRateLimitSlot(baseId);

    const resp = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.json ? JSON.stringify(options.json) : undefined,
    });
    if (resp.status !== 429 || attempt === AIRTABLE_429_MAX_RETRIES) {
      return resp;
    }

    const delayMs = get429RetryDelayMs(resp, attempt);
    console.warn(
      `Airtable rate limit hit (429). Retrying in ${delayMs}ms (attempt ${attempt + 1}/${AIRTABLE_429_MAX_RETRIES + 1})`,
    );
    await sleep(delayMs);
  }

  throw new Error("Airtable fetch retry loop exhausted unexpectedly");
}

function extractUnknownFieldName(errorText: string): string | null {
  try {
    const parsed = JSON.parse(errorText);
    if (parsed?.error?.type === "UNKNOWN_FIELD_NAME") {
      const match = parsed.error.message?.match(/Unknown field name:\s*"([^"]+)"/);
      return match?.[1] || null;
    }
  } catch { /* not JSON */ }
  return null;
}

function compactFields<T extends Record<string, unknown>>(fields: T): T {
  const compacted = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
  return compacted as T;
}

function toAirtableFields<T extends Record<string, unknown>>(fields: T): Record<string, unknown> {
  const normalized = { ...fields } as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(normalized, "postman_team_slug")) {
    normalized["Postman Team"] = normalized.postman_team_slug;
    delete normalized.postman_team_slug;
  }
  return normalized;
}

function escapeFormulaValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isMissingTableResponse(resp: Response, errorText: string): boolean {
  if (resp.status !== 404 && resp.status !== 422) {
    return false;
  }
  const normalized = errorText.toLowerCase();
  return normalized.includes("table")
    || normalized.includes("model_not_found")
    || normalized.includes("not found");
}

// ── Record mapper ──

function mapRecord(rec: { id: string; fields: Record<string, unknown> }): DeploymentRecord {
  const f = rec.fields;
  const str = (key: string) => String(f[key] || "");
  return {
    id: rec.id,
    spec_id: str("spec_id"),
    status: (f.status as DeploymentRecord["status"]) || "provisioning",
    workspace_team_id: str("workspace_team_id") || undefined,
    workspace_team_name: str("workspace_team_name") || undefined,
    runtime_mode: str("runtime_mode"),
    runtime_base_url: str("runtime_base_url"),
    github_repo_url: str("github_repo_url"),
    github_repo_name: str("github_repo_name"),
    postman_workspace_url: str("postman_workspace_url"),
    workspace_id: str("workspace_id"),
    postman_spec_uid: str("postman_spec_uid"),
    postman_collection_uids: str("postman_collection_uids"),
    postman_run_url: str("postman_run_url"),
    postman_environment_uid: str("postman_environment_uid"),
    postman_team_slug: str("postman_team_slug") || str("Postman Team"),
    postman_team_id: str("postman_team_id") || undefined,
    postman_insights_project_id: str("postman_insights_project_id") || undefined,
    request_context_json: str("request_context_json") || undefined,
    mock_url: str("mock_url"),
    aws_invoke_url: str("aws_invoke_url"),
    aws_region: str("aws_region"),
    lambda_function_name: str("lambda_function_name"),
    api_gateway_id: str("api_gateway_id"),
    ecs_cluster_name: str("ecs_cluster_name"),
    ecs_service_name: str("ecs_service_name"),
    ecs_task_definition: str("ecs_task_definition"),
    ecs_target_group_arn: str("ecs_target_group_arn"),
    ecs_listener_rule_arn: str("ecs_listener_rule_arn"),
    k8s_namespace: str("k8s_namespace"),
    k8s_deployment_name: str("k8s_deployment_name"),
    k8s_service_name: str("k8s_service_name"),
    k8s_ingress_name: str("k8s_ingress_name"),
    k8s_cluster_name: str("k8s_cluster_name"),
    dedicated_ip: str("dedicated_ip"),
    dedicated_port: str("dedicated_port"),
    graph_transport_url: str("graph_transport_url"),
    node_name: str("node_name"),
    resource_inventory_json: str("resource_inventory_json"),
    iam_role_name: str("iam_role_name"),
    deployed_at: str("deployed_at"),
    logs: str("logs"),
    failed_at_step: str("failed_at_step"),
    error_message: str("error_message"),
    fern_docs_url: str("fern_docs_url"),
    system_env_map: str("system_env_map"),
    environments_json: str("environments_json"),
    environment_deployments: str("environment_deployments"),
    deployment_mode: str("deployment_mode"),
    deployment_group_id: str("deployment_group_id"),
    deployment_root_spec_id: str("deployment_root_spec_id"),
    graph_node_meta_json: str("graph_node_meta_json"),
    chaos_enabled: Boolean(f.chaos_enabled),
    chaos_config: str("chaos_config") || undefined,
    chaos_enabled_map: str("chaos_enabled_map") || undefined,
  };
}

function mapInfraRecord(rec: { id: string; fields: Record<string, unknown> }): InfraRecord {
  const f = rec.fields;
  const str = (key: string) => String(f[key] || "");
  return {
    id: rec.id,
    component: str("component"),
    status: str("status"),
    cluster_name: str("cluster_name"),
    vpc_id: str("vpc_id"),
    subnet_ids: str("subnet_ids"),
    security_group_ids: str("security_group_ids"),
    execution_role_arn: str("execution_role_arn"),
    task_role_arn: str("task_role_arn"),
    alb_arn: str("alb_arn"),
    alb_listener_arn: str("alb_listener_arn"),
    alb_dns_name: str("alb_dns_name"),
    ecr_repository: str("ecr_repository"),
    alb_sg_id: str("alb_sg_id"),
    ecs_sg_id: str("ecs_sg_id"),
    aws_region: str("aws_region"),
    created_at: str("created_at"),
    updated_at: str("updated_at"),
    last_error: str("last_error"),
    last_run_url: str("last_run_url"),
    k8s_namespace: str("k8s_namespace"),
    k8s_daemonset_name: str("k8s_daemonset_name"),
    k8s_cluster_name: str("k8s_cluster_name"),
    k8s_context: str("k8s_context"),
  };
}

function mapGraphMembershipRecord(
  rec: { id: string; fields: Record<string, unknown> },
): GraphMembershipRecord {
  const f = rec.fields;
  const str = (key: string) => String(f[key] || "");
  const num = (key: string) => {
    const raw = f[key];
    const parsed = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    id: rec.id,
    deployment_group_id: str("deployment_group_id"),
    deployment_root_spec_id: str("deployment_root_spec_id"),
    spec_id: str("spec_id"),
    environment: str("environment"),
    layer_index: num("layer_index"),
    node_status: str("node_status"),
    node_action: str("node_action") || undefined,
    runtime_mode: str("runtime_mode"),
    graph_node_meta_json: str("graph_node_meta_json") || undefined,
  };
}

// ── Deployments table ──

let _deploymentsCache: { timestamp: number; records: DeploymentRecord[] } | null = null;
const CACHE_TTL_MS = 60_000;

export function _clearDeploymentsCacheForTests() {
  _deploymentsCache = null;
}

export function invalidateDeploymentsCache(): void {
  _deploymentsCache = null;
}

export async function listDeployments(env: AirtableEnv, noCache = false): Promise<DeploymentRecord[]> {
  if (!noCache && _deploymentsCache && Date.now() - _deploymentsCache.timestamp < CACHE_TTL_MS) {
    return _deploymentsCache.records;
  }

  const records: DeploymentRecord[] = [];
  let offset: string | undefined;

  do {
    const params = new URLSearchParams();
    if (offset) params.set("offset", offset);

    const resp = await airtableFetch(env, "Deployments", `?${params}`);
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Airtable list failed: ${resp.status} ${err}`);
    }
    const data = (await resp.json()) as {
      records: { id: string; fields: Record<string, unknown> }[];
      offset?: string;
    };

    for (const rec of data.records) {
      records.push(mapRecord(rec));
    }

    offset = data.offset;
  } while (offset);

  _deploymentsCache = { timestamp: Date.now(), records };
  return records;
}

export async function getActiveEcsServiceCount(env: AirtableEnv): Promise<number> {
  const params = new URLSearchParams({
    filterByFormula: 'AND({status}="active", {runtime_mode}="ecs_service")',
  });
  let count = 0;
  let offset: string | undefined;
  do {
    if (offset) params.set("offset", offset);
    const resp = await airtableFetch(env, "Deployments", `?${params.toString()}`);
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Airtable filtered query failed: ${resp.status} ${err}`);
    }
    const data = await resp.json() as { records: any[], offset?: string };
    count += data.records.length;
    offset = data.offset;
    params.delete("offset");
  } while (offset);
  return count;
}

export async function getActiveK8sDiscoveryServiceCount(env: AirtableEnv): Promise<number> {
  const params = new URLSearchParams({
    filterByFormula: 'AND({status}="active", {runtime_mode}="k8s_discovery")',
  });
  let count = 0;
  let offset: string | undefined;
  do {
    if (offset) params.set("offset", offset);
    const resp = await airtableFetch(env, "Deployments", `?${params.toString()}`);
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Airtable filtered query failed: ${resp.status} ${err}`);
    }
    const data = await resp.json() as { records: any[], offset?: string };
    count += data.records.length;
    offset = data.offset;
    params.delete("offset");
  } while (offset);
  return count;
}

export async function getActiveDiscoveryUsedPorts(env: AirtableEnv): Promise<number[]> {
  const params = new URLSearchParams({
    filterByFormula: 'AND(OR({status}="active", {status}="deploying", {status}="failed", {status}="queued", {status}="deprovisioned"), {runtime_mode}="k8s_discovery")',
  });
  const ports: number[] = [];
  let offset: string | undefined;
  do {
    if (offset) params.set("offset", offset);
    const resp = await airtableFetch(env, "Deployments", `?${params.toString()}`);
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Airtable filtered query failed: ${resp.status} ${err}`);
    }
    const data = await resp.json() as { records: { fields: { dedicated_port?: string } }[], offset?: string };
    for (const rec of data.records) {
      if (rec.fields.dedicated_port) {
        const port = parseInt(rec.fields.dedicated_port, 10);
        if (!isNaN(port)) ports.push(port);
      }
    }
    offset = data.offset;
    params.delete("offset");
  } while (offset);
  return ports;
}

export async function getDeployment(
  env: AirtableEnv,
  specId: string
): Promise<DeploymentRecord | null> {
  const params = new URLSearchParams({
    filterByFormula: `{spec_id}="${specId}"`,
    maxRecords: "1",
  });
  const resp = await airtableFetch(env, "Deployments", `?${params}`);
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    records: { id: string; fields: Record<string, unknown> }[];
  };
  if (data.records.length === 0) return null;
  const rec = data.records[0];
  return mapRecord(rec);
}

/**
 * Upsert a deployment record keyed on `spec_id`.
 *
 * If a record with the same `spec_id` already exists it is PATCHed with the
 * supplied fields; otherwise a new record is created.  This prevents duplicate
 * rows for the same slug regardless of how many times the caller fires.
 */
export async function insertDeployment(
  env: AirtableEnv,
  record: Omit<DeploymentRecord, "id">
): Promise<DeploymentRecord> {
  let fields: Record<string, unknown> = toAirtableFields({ ...record });
  const strippedUnknownFields = new Set<string>();

  while (true) {
    const resp = await airtableFetch(env, "Deployments", "", {
      method: "POST",
      json: { fields },
    });
    if (resp.ok) {
      const data = (await resp.json()) as { id: string; fields: Record<string, unknown> };
      invalidateDeploymentsCache();
      return { id: data.id, ...record };
    }

    const err = await resp.text();
    const unknownField = extractUnknownFieldName(err);
    if (
      resp.status === 422
      && unknownField
      && Object.prototype.hasOwnProperty.call(fields, unknownField)
      && !strippedUnknownFields.has(unknownField)
    ) {
      console.warn(`Airtable: stripping unknown field "${unknownField}" and retrying`);
      strippedUnknownFields.add(unknownField);
      delete fields[unknownField];
      continue;
    }
    throw new Error(`Airtable create failed: ${resp.status} ${err}`);
  }
}

/**
 * Creates or updates a deployment record for the given spec_id.
 * This function performs an initial read to determine if an upsert is required;
 * if you know the record does not exist or have already fetched it, use insertDeployment
 * or updateDeployment directly to avoid the extra Airtable API call.
 */
export async function createDeployment(
  env: AirtableEnv,
  record: Omit<DeploymentRecord, "id">
): Promise<DeploymentRecord> {
  // ── Look for an existing row with this spec_id ──
  const existing = await getDeployment(env, record.spec_id);
  if (existing?.id) {
    // PATCH the existing row with the new fields
    const { spec_id: _drop, ...updates } = record;
    await updateDeployment(env, existing.id, updates);
    return { ...existing, ...record };
  }

  return insertDeployment(env, record);
}

export async function updateDeployment(
  env: AirtableEnv,
  recordId: string,
  fields: Partial<Omit<DeploymentRecord, "id">>
): Promise<void> {
  let payload: Record<string, unknown> = toAirtableFields({ ...fields });
  const strippedUnknownFields = new Set<string>();

  while (true) {
    const resp = await airtableFetch(env, "Deployments", `/${recordId}`, {
      method: "PATCH",
      json: { fields: payload },
    });
    if (resp.ok) {
      invalidateDeploymentsCache();
      return;
    }

    const err = await resp.text();
    const unknownField = extractUnknownFieldName(err);
    if (
      resp.status === 422
      && unknownField
      && Object.prototype.hasOwnProperty.call(payload, unknownField)
      && !strippedUnknownFields.has(unknownField)
    ) {
      console.warn(`Airtable: stripping unknown field "${unknownField}" and retrying`);
      strippedUnknownFields.add(unknownField);
      delete payload[unknownField];
      continue;
    }
    throw new Error(`Airtable update failed: ${resp.status} ${err}`);
  }
}

export async function isDeployed(env: AirtableEnv, specId: string): Promise<boolean> {
  const record = await getDeployment(env, specId);
  return record !== null && record.status !== "failed";
}

export function isAirtableConfigured(env: AirtableEnv): boolean {
  return !!(env.AIRTABLE_API_KEY && env.AIRTABLE_BASE_ID);
}

export async function supportsGraphMembershipsTable(env: AirtableEnv): Promise<boolean> {
  const baseId = getBaseId(env);
  const cached = graphMembershipTableSupportByBase.get(baseId);
  if (cached !== undefined) {
    return cached;
  }

  const resp = await airtableFetch(env, GRAPH_MEMBERSHIPS_TABLE, "?maxRecords=1");
  if (resp.ok) {
    graphMembershipTableSupportByBase.set(baseId, true);
    return true;
  }

  const err = await resp.text();
  if (isMissingTableResponse(resp, err)) {
    graphMembershipTableSupportByBase.set(baseId, false);
    return false;
  }

  throw new Error(`Airtable graph membership probe failed: ${resp.status} ${err}`);
}

async function getGraphMembership(
  env: AirtableEnv,
  deploymentGroupId: string,
  specId: string,
  environment: string,
): Promise<GraphMembershipRecord | null> {
  const params = new URLSearchParams({
    filterByFormula: `AND({deployment_group_id}="${escapeFormulaValue(deploymentGroupId)}",{spec_id}="${escapeFormulaValue(specId)}",{environment}="${escapeFormulaValue(environment)}")`,
    maxRecords: "1",
  });
  const resp = await airtableFetch(env, GRAPH_MEMBERSHIPS_TABLE, `?${params}`);
  if (!resp.ok) {
    const err = await resp.text();
    if (isMissingTableResponse(resp, err)) {
      const baseId = getBaseId(env);
      graphMembershipTableSupportByBase.set(baseId, false);
      return null;
    }
    throw new Error(`Airtable graph membership lookup failed: ${resp.status} ${err}`);
  }
  const data = (await resp.json()) as {
    records: { id: string; fields: Record<string, unknown> }[];
  };
  if (data.records.length === 0) return null;
  return mapGraphMembershipRecord(data.records[0]);
}

async function createGraphMembership(
  env: AirtableEnv,
  record: Omit<GraphMembershipRecord, "id">,
): Promise<GraphMembershipRecord> {
  let fields: Record<string, unknown> = compactFields({ ...record });
  const strippedUnknownFields = new Set<string>();

  while (true) {
    const resp = await airtableFetch(env, GRAPH_MEMBERSHIPS_TABLE, "", {
      method: "POST",
      json: { fields },
    });
    if (resp.ok) {
      const data = (await resp.json()) as { id: string; fields: Record<string, unknown> };
      return mapGraphMembershipRecord(data);
    }

    const err = await resp.text();
    const unknownField = extractUnknownFieldName(err);
    if (
      resp.status === 422
      && unknownField
      && Object.prototype.hasOwnProperty.call(fields, unknownField)
      && !strippedUnknownFields.has(unknownField)
    ) {
      console.warn(`Airtable: stripping unknown field "${unknownField}" and retrying`);
      strippedUnknownFields.add(unknownField);
      delete fields[unknownField];
      continue;
    }

    if (isMissingTableResponse(resp, err)) {
      const baseId = getBaseId(env);
      graphMembershipTableSupportByBase.set(baseId, false);
    }
    throw new Error(`Airtable graph membership create failed: ${resp.status} ${err}`);
  }
}

async function updateGraphMembership(
  env: AirtableEnv,
  recordId: string,
  fields: Partial<Omit<GraphMembershipRecord, "id">>,
): Promise<void> {
  let payload: Record<string, unknown> = compactFields({ ...fields });
  const strippedUnknownFields = new Set<string>();

  while (true) {
    const resp = await airtableFetch(env, GRAPH_MEMBERSHIPS_TABLE, `/${recordId}`, {
      method: "PATCH",
      json: { fields: payload },
    });
    if (resp.ok) return;

    const err = await resp.text();
    const unknownField = extractUnknownFieldName(err);
    if (
      resp.status === 422
      && unknownField
      && Object.prototype.hasOwnProperty.call(payload, unknownField)
      && !strippedUnknownFields.has(unknownField)
    ) {
      console.warn(`Airtable: stripping unknown field "${unknownField}" and retrying`);
      strippedUnknownFields.add(unknownField);
      delete payload[unknownField];
      continue;
    }

    if (isMissingTableResponse(resp, err)) {
      const baseId = getBaseId(env);
      graphMembershipTableSupportByBase.set(baseId, false);
    }
    throw new Error(`Airtable graph membership update failed: ${resp.status} ${err}`);
  }
}

export async function upsertGraphMembership(
  env: AirtableEnv,
  record: Omit<GraphMembershipRecord, "id">,
): Promise<GraphMembershipRecord | null> {
  if (!(await supportsGraphMembershipsTable(env))) {
    return null;
  }

  const existing = await getGraphMembership(
    env,
    record.deployment_group_id,
    record.spec_id,
    record.environment,
  );
  if (existing?.id) {
    await updateGraphMembership(env, existing.id, record);
    return { ...existing, ...record };
  }

  return createGraphMembership(env, record);
}

// ── Infrastructure table ──

const INFRA_CACHE_TTL_MS = 300_000;
const _infraCache = new Map<string, { timestamp: number; record: InfraRecord }>();

export function invalidateInfraCache(component?: string): void {
  if (component) {
    _infraCache.delete(component);
  } else {
    _infraCache.clear();
  }
}

export async function listInfraRecords(env: AirtableEnv): Promise<InfraRecord[]> {
  const records: InfraRecord[] = [];
  let offset: string | undefined;

  do {
    const params = new URLSearchParams();
    if (offset) params.set("offset", offset);

    const resp = await airtableFetch(env, "Infrastructure", `?${params}`);
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Airtable list infrastructure failed: ${resp.status} ${err}`);
    }
    const data = (await resp.json()) as {
      records: { id: string; fields: Record<string, unknown> }[];
      offset?: string;
    };

    for (const rec of data.records) {
      records.push(mapInfraRecord(rec));
    }

    offset = data.offset;
  } while (offset);

  return records;
}

export async function getInfraRecord(
  env: AirtableEnv,
  component: string,
): Promise<InfraRecord | null> {
  const cached = _infraCache.get(component);
  if (cached && Date.now() - cached.timestamp < INFRA_CACHE_TTL_MS) {
    return cached.record;
  }

  const params = new URLSearchParams({
    filterByFormula: `{component}="${component}"`,
    maxRecords: "1",
  });
  const resp = await airtableFetch(env, "Infrastructure", `?${params}`);
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    records: { id: string; fields: Record<string, unknown> }[];
  };
  if (data.records.length === 0) return null;
  const record = mapInfraRecord(data.records[0]);
  _infraCache.set(component, { timestamp: Date.now(), record });
  return record;
}
