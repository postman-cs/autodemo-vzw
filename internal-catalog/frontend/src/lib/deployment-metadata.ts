import type { Deployment, EnvironmentDeployment } from "./types";

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseEnvironmentDeployments(deployment: Deployment): EnvironmentDeployment[] {
  const raw = str(deployment.environment_deployments);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const result = parsed
          .map((entry) => {
            const env = entry as EnvironmentDeployment;
            const url = str(env.runtime_url) || str(env.url);
            return {
              ...env,
              environment: str(env.environment),
              url,
              runtime_url: str(env.runtime_url) || url,
              api_gateway_id: str(env.api_gateway_id) || undefined,
              postman_env_uid: str(env.postman_env_uid) || undefined,
              system_env_id: str(env.system_env_id) || undefined,
              system_env_name: str(env.system_env_name) || undefined,
              status: str(env.status) || undefined,
              deployed_at: str(env.deployed_at) || undefined,
              branch: str(env.branch) || undefined,
            };
          })
          .filter((entry) => Boolean(entry.environment));
        if (result.length > 0) return result;
      }
    } catch {
      // fall through to legacy fallback
    }
  }

  const envsRaw = str(deployment.environments_json);
  if (envsRaw) {
    try {
      const envNames = JSON.parse(envsRaw);
      if (Array.isArray(envNames)) {
        const result = envNames
          .map((name) => str(name))
          .filter(Boolean)
          .map((name): EnvironmentDeployment => ({
            environment: name,
            status: deployment.status === "active" ? "active" : undefined,
            runtime_url: str(deployment.runtime_base_url) || str(deployment.aws_invoke_url),
          }));
        if (result.length > 0) return result;
      }
    } catch {
      // fall through
    }
  }

  if (deployment.status === "active") {
    return [{
      environment: "prod",
      status: "active",
      runtime_url: str(deployment.runtime_base_url) || str(deployment.aws_invoke_url),
    }];
  }

  return [];
}

export function parseChaosEnabledMap(deployment: Deployment): Record<string, boolean> {
  const raw = String(deployment.chaos_enabled_map || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>;
    }
  } catch {
    // ignore malformed data and use aggregate fallback
  }
  return {};
}

export function isChaosEnabled(deployment: Deployment, environment?: string): boolean {
  const map = parseChaosEnabledMap(deployment);
  if (environment) return Boolean(map[environment]);
  return Boolean(deployment.chaos_enabled);
}

export function environmentMappingSummary(env: EnvironmentDeployment): string {
  const parts: string[] = [];
  if (env.system_env_name) {
    parts.push(`System ${env.system_env_name}`);
  } else if (env.system_env_id) {
    parts.push(`System ${env.system_env_id}`);
  }
  if (env.postman_env_uid) parts.push(`Postman ${env.postman_env_uid}`);
  if (env.branch) parts.push(`Branch ${env.branch}`);
  if (env.api_gateway_id) parts.push(`Gateway ${env.api_gateway_id}`);
  if (env.status) parts.push(`Status ${env.status}`);
  if (env.deployed_at) parts.push(`Deployed ${env.deployed_at}`);
  if (env.runtime_url) parts.push(`Runtime ${env.runtime_url}`);
  return parts.join(" | ");
}

/** Returns a short status label for the environment deployment. */
export function environmentStatusLabel(env: EnvironmentDeployment): string {
  return str(env.status) || "unknown";
}
