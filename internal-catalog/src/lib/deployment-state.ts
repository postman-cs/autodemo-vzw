import {
  getDeployment,
  listDeployments,
  type DeploymentRecord,
  updateDeployment,
  invalidateDeploymentsCache,
} from "./airtable";
import { buildFinalDeploymentSnapshot } from "./deployment-success";
import { parseEnvironmentDeploymentsJson } from "./environment-deployments";
import { listWorkflowRuns, type WorkflowRunSummary } from "./github";

interface DeploymentStateEnv {
  AIRTABLE_API_KEY?: string;
  AIRTABLE_BASE_ID?: string;
  AWS_REGION?: string;
  [key: string]: unknown;
}

const RESOLVED_DEPLOYMENTS_CACHE_TTL_MS = 30_000;
let _resolvedDeploymentsCache: {
  timestamp: number;
  records: DeploymentRecord[];
} | null = null;

export function invalidateResolvedDeploymentsCache(): void {
  _resolvedDeploymentsCache = null;
  invalidateDeploymentsCache();
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseRepoNameFromUrl(url: string): string {
  const cleaned = readString(url).replace(/\/+$/, "");
  if (!cleaned) return "";
  return cleaned.split("/").pop() || "";
}

function resolveRepoName(record: DeploymentRecord): string {
  return readString(record.github_repo_name)
    || parseRepoNameFromUrl(readString(record.github_repo_url))
    || readString(record.spec_id);
}

function readRequestedEnvironments(record: DeploymentRecord): string[] {
  const explicit = parseEnvironmentDeploymentsJson(readString(record.environment_deployments));
  if (explicit.length > 0) {
    return explicit.map((deployment) => deployment.environment);
  }

  const rawEnvironments = readString(record.environments_json);
  if (!rawEnvironments) return [];
  try {
    const parsed = JSON.parse(rawEnvironments) as unknown;
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.map((value) => readString(value)).filter(Boolean)));
  } catch {
    return [];
  }
}

function isProvisionWorkflowRun(run: WorkflowRunSummary): boolean {
  const path = readString(run.path).toLowerCase();
  const name = readString(run.name).toLowerCase();
  return path.endsWith("/provision.yml") || name === "provision api lifecycle";
}

export function hasRepoProvisionDriftSignal(record: DeploymentRecord): boolean {
  const failedAtStep = readString(record.failed_at_step).toLowerCase();
  const errorMessage = readString(record.error_message).toLowerCase();
  if (!errorMessage && !failedAtStep) return false;

  const mentionsRepoConflict = errorMessage.includes("repository creation failed")
    || errorMessage.includes("failed to create repo")
    || errorMessage.includes("already exists");
  const provisioningPhase = failedAtStep === "provisioning" || failedAtStep === "github";
  return mentionsRepoConflict && provisioningPhase;
}

function shouldAttemptSuccessReconciliation(record: DeploymentRecord): boolean {
  if (!record.id) return false;
  if (!resolveRepoName(record)) return false;
  if (record.status !== "active") return hasRepoProvisionDriftSignal(record);
  return Boolean(readString(record.failed_at_step) || readString(record.error_message));
}

export async function reconcileSuccessfulDeploymentRecord(
  env: DeploymentStateEnv,
  record: DeploymentRecord | null,
  ghToken: string,
  options?: { force?: boolean },
): Promise<DeploymentRecord | null> {
  if (!record) return null;
  const force = Boolean(options?.force);
  if (!force) {
    if (record.status !== "active") {
      if (!shouldAttemptSuccessReconciliation(record)) return record;
    } else if (!shouldAttemptSuccessReconciliation(record)) {
      return record;
    }
  }

  const token = readString(ghToken);
  if (!token) return record;

  const repoName = resolveRepoName(record);
  if (!repoName) return record;

  try {
    const runs = await listWorkflowRuns(token, repoName, 10);
    const latestProvisionRun = runs.find(isProvisionWorkflowRun);
    if (!latestProvisionRun) return record;
    if (latestProvisionRun.status !== "completed" || latestProvisionRun.conclusion !== "success") {
      return record;
    }

    const snapshot = await buildFinalDeploymentSnapshot({
      token,
      repoName,
      projectName: record.github_repo_name || record.spec_id,
      requestedEnvironments: readRequestedEnvironments(record),
      defaultAwsRegion: readString(record.aws_region) || readString(env.AWS_REGION) || "eu-central-1",
      existingRecord: record,
    });
    if (!snapshot.hasSuccessMarkers) return record;

    await updateDeployment(env, record.id!, snapshot.airtableFields);
    invalidateResolvedDeploymentsCache();
    return {
      ...record,
      ...snapshot.airtableFields,
      id: record.id,
    };
  } catch (error) {
    console.warn(
      `[deployment-state] success reconciliation skipped for ${repoName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return record;
  }
}

export async function getResolvedDeployment(
  env: DeploymentStateEnv,
  specId: string,
  ghToken: string,
): Promise<DeploymentRecord | null> {
  const record = await getDeployment(env, specId);
  return reconcileSuccessfulDeploymentRecord(env, record, ghToken);
}

export async function listResolvedDeployments(
  env: DeploymentStateEnv,
  ghToken: string,
): Promise<DeploymentRecord[]> {
  if (
    _resolvedDeploymentsCache
    && Date.now() - _resolvedDeploymentsCache.timestamp < RESOLVED_DEPLOYMENTS_CACHE_TTL_MS
  ) {
    return _resolvedDeploymentsCache.records;
  }

  const deployments = await listDeployments(env);
  const token = readString(ghToken);
  const resolved = token
    ? await Promise.all(
        deployments.map((record) => reconcileSuccessfulDeploymentRecord(env, record, token)),
      ).then((r) => r.filter((record): record is DeploymentRecord => record !== null))
    : deployments;

  _resolvedDeploymentsCache = { timestamp: Date.now(), records: resolved };
  return resolved;
}
