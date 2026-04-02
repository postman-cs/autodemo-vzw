import { updateDeployment, DEPLOYMENT_TOMBSTONE_FIELDS, type DeploymentRecord } from "./airtable";
import { getOrg } from "./github";

export type RecoverableFailureReason = "github_repo_conflict" | "residual_resources" | "stale_provisioning";

const STALE_PROVISIONING_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

export interface RecoverableFailure {
  spec_id: string;
  status: "failed";
  reason: RecoverableFailureReason;
  project_name: string;
  postman_team_slug?: string;
  runtime_mode?: string;
  error_message?: string;
  failed_at_step?: string;
  deployed_at?: string;
  github_repo_name?: string;
  github_repo_url?: string;
  workspace_id?: string;
  aws_region?: string;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseRepoNameFromUrl(url: string): string {
  const cleaned = readString(url).replace(/\/+$/, "");
  if (!cleaned) return "";
  const last = cleaned.split("/").pop() || "";
  return last.trim();
}

function resolveProjectName(record: DeploymentRecord): string {
  return readString(record.github_repo_name)
    || parseRepoNameFromUrl(readString(record.github_repo_url))
    || readString(record.spec_id);
}

function isDeprovisionedTombstone(record: DeploymentRecord): boolean {
  const message = readString(record.error_message).toLowerCase();
  return message === "deprovisioned" || message.startsWith("deprovisioned ");
}

function isGitHubRepoConflict(record: DeploymentRecord): boolean {
  const message = readString(record.error_message).toLowerCase();
  if (!message) return false;
  if (!message.includes("repo")) return false;
  if (!message.includes("already exists")) return false;
  return true;
}

function isStaleProvisioning(record: DeploymentRecord, now?: number): boolean {
  if (record.status !== "provisioning") return false;
  const deployedAt = readString(record.deployed_at);
  if (!deployedAt) return true; // no timestamp = assume stale
  const ms = Date.parse(deployedAt);
  if (!Number.isFinite(ms)) return true;
  return (now ?? Date.now()) - ms >= STALE_PROVISIONING_THRESHOLD_MS;
}

function hasResidualResourceSignals(record: DeploymentRecord): boolean {
  const hints = [
    record.github_repo_name,
    record.github_repo_url,
    record.workspace_id,
    record.postman_workspace_url,
    record.postman_spec_uid,
    record.postman_collection_uids,
    record.postman_run_url,
    record.postman_environment_uid,
    record.mock_url,
    record.aws_invoke_url,
    record.lambda_function_name,
    record.api_gateway_id,
    record.ecs_cluster_name,
    record.ecs_service_name,
    record.ecs_task_definition,
    record.resource_inventory_json,
    record.iam_role_name,
  ];

  return hints.some((value) => readString(value).length > 0);
}

function buildRecoverableFailure(
  record: DeploymentRecord,
  reason: RecoverableFailureReason,
): RecoverableFailure {
  const rawError = readString(record.error_message);
  const synthesizedError = reason === "stale_provisioning" && !rawError
    ? "Provisioning exceeded 30 minutes without terminal workflow state."
    : rawError;
  return {
    spec_id: readString(record.spec_id),
    status: "failed",
    reason,
    project_name: resolveProjectName(record),
    postman_team_slug: readString(record.postman_team_slug),
    runtime_mode: readString(record.runtime_mode),
    error_message: synthesizedError,
    failed_at_step: readString(record.failed_at_step),
    deployed_at: readString(record.deployed_at),
    github_repo_name: readString(record.github_repo_name),
    github_repo_url: readString(record.github_repo_url),
    workspace_id: readString(record.workspace_id),
    aws_region: readString(record.aws_region),
  };
}

function failureGroupKey(failure: RecoverableFailure): string {
  const bySpec = readString(failure.spec_id).toLowerCase();
  if (bySpec) return `spec:${bySpec}`;
  const byProject = readString(failure.project_name).toLowerCase();
  if (byProject) return `project:${byProject}`;
  return `fallback:${readString(failure.github_repo_url).toLowerCase()}`;
}

function parseDateMs(value: string | undefined): number {
  const raw = readString(value || "");
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function isNewer(a: RecoverableFailure, b: RecoverableFailure): boolean {
  const aMs = parseDateMs(a.deployed_at);
  const bMs = parseDateMs(b.deployed_at);
  if (aMs !== bMs) return aMs > bMs;
  return readString(a.spec_id).localeCompare(readString(b.spec_id)) < 0;
}

export function classifyRecoverableFailure(record: DeploymentRecord, now?: number): RecoverableFailure | null {
  if (isStaleProvisioning(record, now)) {
    return buildRecoverableFailure(record, "stale_provisioning");
  }
  if (record.status !== "failed") return null;
  if (isDeprovisionedTombstone(record)) return null;

  if (isGitHubRepoConflict(record)) {
    return buildRecoverableFailure(record, "github_repo_conflict");
  }

  if (hasResidualResourceSignals(record)) {
    return buildRecoverableFailure(record, "residual_resources");
  }

  return null;
}

export function buildRecoverableFailures(deployments: DeploymentRecord[], now?: number): RecoverableFailure[] {
  const latestByKey = new Map<string, RecoverableFailure>();

  for (const record of deployments) {
    const classified = classifyRecoverableFailure(record, now);
    if (!classified) continue;
    const key = failureGroupKey(classified);
    const existing = latestByKey.get(key);
    if (!existing || isNewer(classified, existing)) {
      latestByKey.set(key, classified);
    }
  }

  return Array.from(latestByKey.values()).sort((a, b) => {
    const bMs = parseDateMs(b.deployed_at);
    const aMs = parseDateMs(a.deployed_at);
    if (aMs !== bMs) return bMs - aMs;
    return readString(a.spec_id).localeCompare(readString(b.spec_id));
  });
}

// Use the shared canonical tombstone field list from airtable.ts
const TOMBSTONE_FIELDS = DEPLOYMENT_TOMBSTONE_FIELDS;

/**
 * For each `residual_resources` failure, check whether the GitHub repo still
 * exists.  If it's gone, the resources are already cleaned up — auto-resolve
 * by tombstoning the Airtable record and removing the item from the list.
 *
 * Runs fire-and-forget per item (best-effort, never throws).
 */
export async function autoResolveGhostFailures(
  failures: RecoverableFailure[],
  deployments: DeploymentRecord[],
  ghToken: string,
  env: any,
): Promise<RecoverableFailure[]> {
  if (!ghToken || failures.length === 0) return failures;

  const residual = failures.filter((f) => f.reason === "residual_resources" && readString(f.github_repo_name));
  if (residual.length === 0) return failures;

  const org = getOrg();
  const resolved = new Set<string>();

  await Promise.all(
    residual.map(async (f) => {
      try {
        const resp = await fetch(
          `https://api.github.com/repos/${org}/${f.github_repo_name}`,
          { headers: { Authorization: `token ${ghToken}`, Accept: "application/vnd.github+json" } },
        );
        if (resp.status !== 404) return; // repo still exists or auth error — leave it

        // Repo is gone — tombstone the Airtable record
        const record = deployments.find((d) =>
          readString(d.spec_id) === f.spec_id
          || readString(d.github_repo_name) === f.github_repo_name,
        );
        if (record?.id) {
          await updateDeployment(env, record.id, {
            status: "failed",
            logs: `Auto-resolved at ${new Date().toISOString()} (repo not found)`,
            ...TOMBSTONE_FIELDS,
          });
        }
        resolved.add(f.spec_id);
      } catch {
        // best-effort — skip this item
      }
    }),
  );

  if (resolved.size === 0) return failures;
  return failures.filter((f) => !resolved.has(f.spec_id));
}
