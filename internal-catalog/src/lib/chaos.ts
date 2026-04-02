import type { DeploymentRecord } from "./airtable";
import { getDeployment, isAirtableConfigured, updateDeployment } from "./airtable";
import { createRepoVariable, normalizeGitHubToken } from "./github";
import type { ProvisioningEnv as Env } from "./provisioning-env";
import { parseEnvironmentDeploymentsJson } from "./environment-deployments";

export interface ChaosToggleResult {
  service_id: string;
  enabled: boolean;
  /** The specific environment that was targeted, or undefined when all environments were toggled. */
  environment?: string;
  updated_urls: string[];
  failed_urls: Array<{ url: string; error: string }>;
}

/**
 * Collect runtime URLs from a deployment record.
 *
 * @param record - The Airtable deployment record.
 * @param environment - When provided, only URLs for that environment slug are returned.
 *   When omitted, all URLs are returned (including the legacy singleton fields
 *   `runtime_base_url` and `aws_invoke_url` which cannot be attributed to a specific env).
 */
function collectRuntimeUrls(record: DeploymentRecord, environment?: string): string[] {
  const urls: string[] = [];
  const envDeployments = parseEnvironmentDeploymentsJson(String(record.environment_deployments || ""));

  for (const deploy of envDeployments) {
    if (environment && deploy.environment !== environment) continue;
    const url = String(deploy.runtime_url || deploy.url || "").trim();
    if (url) urls.push(url.replace(/\/+$/, ""));
  }

  // Include the legacy singleton URL fields only when not filtering to a specific environment,
  // since they cannot be reliably attributed to a single env slug.
  if (!environment) {
    const runtimeBaseUrl = String(record.runtime_base_url || "").trim();
    if (runtimeBaseUrl) urls.push(runtimeBaseUrl.replace(/\/+$/, ""));
    const invokeUrl = String(record.aws_invoke_url || "").trim();
    if (invokeUrl) urls.push(invokeUrl.replace(/\/+$/, ""));
  }

  return Array.from(new Set(urls));
}

/**
 * Parse the stored `chaos_enabled_map` JSON string into a plain object.
 * Returns an empty object if the field is absent or malformed.
 */
function parseChaosMap(record: DeploymentRecord): Record<string, boolean> {
  const raw = String(record.chaos_enabled_map || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>;
    }
  } catch { /* fall through */ }
  return {};
}

async function patchRuntimeChaos(url: string, enabled: boolean): Promise<void> {
  const endpoint = `${url}/chaos`;
  const response = await fetch(endpoint, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} ${body}`);
  }
}

/**
 * Toggle chaos for a service, optionally scoped to a single environment.
 *
 * @param serviceId  - The spec_id / Airtable service identifier.
 * @param enabled    - `true` to enable chaos, `false` to disable.
 * @param env        - Worker environment bindings.
 * @param environment - When provided, only the runtime URL(s) for that environment slug
 *   are patched and the per-env `chaos_enabled_map` entry is updated.
 *   When omitted, all runtime URLs are patched and the aggregate `chaos_enabled` flag
 *   (plus a fully-populated `chaos_enabled_map`) is written to Airtable.
 */
export async function toggleServiceChaos(
  serviceId: string,
  enabled: boolean,
  env: Env,
  environment?: string,
): Promise<ChaosToggleResult> {
  if (!isAirtableConfigured(env as unknown as Record<string, unknown>)) {
    throw new Error("Airtable not configured");
  }

  const deployment = await getDeployment(env as unknown as Record<string, unknown>, serviceId);
  if (!deployment?.id) {
    throw new Error(`Deployment not found for ${serviceId}`);
  }

  const updatedUrls: string[] = [];
  const failedUrls: Array<{ url: string; error: string }> = [];
  const urls = collectRuntimeUrls(deployment, environment);

  for (const url of urls) {
    try {
      await patchRuntimeChaos(url, enabled);
      updatedUrls.push(url);
    } catch (err: unknown) {
      failedUrls.push({
        url,
        error: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  // ── Airtable metadata update ────────────────────────────────────────────────
  // `chaos_enabled_map` stores per-env state as a JSON string so operators can
  // see which environments have chaos active independently of one another.
  // `chaos_enabled` is the aggregate OR kept for backward compatibility (e.g.
  // existing dashboards/scripts that only read the single boolean field).
  const envDeployments = parseEnvironmentDeploymentsJson(
    String(deployment.environment_deployments || ""),
  );
  const chaosMap = parseChaosMap(deployment);

  // For partial failures, we only update state for environments where the URL successfully patched.
  // To do this, we map successful URLs back to their environment slugs.
  const successfulEnvs = new Set<string>();
  for (const deploy of envDeployments) {
    const url = String(deploy.runtime_url || deploy.url || "").trim().replace(/\/+$/, "");
    if (updatedUrls.includes(url)) {
      successfulEnvs.add(deploy.environment);
    }
  }

  let aggregateChaosEnabled: boolean;
  if (environment) {
    // Per-env toggle: update only the targeted slot in the map, if it succeeded.
    if (successfulEnvs.has(environment)) {
      chaosMap[environment] = enabled;
    }
    // Aggregate is true if any known environment now has chaos on.
    aggregateChaosEnabled = Object.values(chaosMap).some(Boolean);
  } else {
    // Global toggle: stamp every known environment with the same value, if it succeeded.
    for (const deploy of envDeployments) {
      if (successfulEnvs.has(deploy.environment)) {
        chaosMap[deploy.environment] = enabled;
      }
    }
    aggregateChaosEnabled = Object.values(chaosMap).some(Boolean);
  }

  await updateDeployment(
    env as unknown as Record<string, unknown>,
    deployment.id,
    {
      chaos_enabled: aggregateChaosEnabled,
      chaos_enabled_map: JSON.stringify(chaosMap),
    },
  );

  // ── GitHub repo variable (best-effort) ─────────────────────────────────────
  // Reflects the aggregate state so that CI/CD workflows can read a single flag.
  const repoName = String(deployment.github_repo_name || deployment.spec_id || "").trim();
  const ghToken = normalizeGitHubToken(env.GH_TOKEN);
  if (repoName && ghToken) {
    try {
      await createRepoVariable(
        ghToken,
        repoName,
        "CHAOS_ENABLED",
        aggregateChaosEnabled ? "true" : "false",
      );
    } catch {
      // Best-effort only; metadata was already persisted in Airtable.
    }
  }

  return {
    service_id: serviceId,
    enabled,
    environment,
    updated_urls: updatedUrls,
    failed_urls: failedUrls,
  };
}
