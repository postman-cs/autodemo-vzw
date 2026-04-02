export type CredentialSourceMode = "repo" | "org" | "hybrid";

export interface ProvisionFeatureFlags {
  orgSecretsEnabled: boolean;
  orgVarsEnabled: boolean;
  patFallbackEnabled: boolean;
  oidcAwsEnabled: boolean;
  githubAppAuthEnabled: boolean;
  workflowCallbacksEnabled: boolean;
}

export interface CredentialSourcePolicy {
  secretSourceMode: CredentialSourceMode;
  variableSourceMode: CredentialSourceMode;
}

export interface SecretInjectionPlan {
  injectRepoSecrets: Record<string, string>;
  requiredAtRuntime: string[];
  skippedBecauseOrgScoped: string[];
}

export const SHARED_ORG_SECRET_NAMES = [
  "KUBECONFIG_B64",
  "FERN_TOKEN",
  "GH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_LAMBDA_ROLE_ARN",
] as const;

function parseBooleanFlag(raw: unknown, defaultValue = false): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

export function resolveProvisionFeatureFlags(env: Record<string, unknown>): ProvisionFeatureFlags {
  return {
    orgSecretsEnabled: parseBooleanFlag(env.ORG_SECRETS_ENABLED, true),
    orgVarsEnabled: parseBooleanFlag(env.ORG_VARS_ENABLED, false),
    patFallbackEnabled: parseBooleanFlag(env.PAT_FALLBACK_ENABLED, false),
    oidcAwsEnabled: parseBooleanFlag(env.OIDC_AWS_ENABLED, false),
    githubAppAuthEnabled: parseBooleanFlag(env.GITHUB_APP_AUTH_ENABLED, false),
    workflowCallbacksEnabled: parseBooleanFlag(env.WORKFLOW_CALLBACKS_ENABLED, false),
  };
}

export function resolveCredentialSourcePolicy(
  flags: ProvisionFeatureFlags,
  options?: { forceRepoMode?: boolean },
): CredentialSourcePolicy {
  if (options?.forceRepoMode) {
    return {
      secretSourceMode: "repo",
      variableSourceMode: "repo",
    };
  }
  return {
    secretSourceMode: flags.orgSecretsEnabled
      ? (flags.patFallbackEnabled ? "hybrid" : "org")
      : "repo",
    variableSourceMode: flags.orgVarsEnabled ? "org" : "repo",
  };
}

export function buildSecretInjectionPlan(
  allSecrets: Record<string, string>,
  mode: CredentialSourceMode,
  sharedOrgSecretNames: string[],
  repoFallbackSecretNames: string[] = [],
): SecretInjectionPlan {
  const sharedSet = new Set(sharedOrgSecretNames);
  const fallbackSet = new Set(repoFallbackSecretNames);
  const injectRepoSecrets: Record<string, string> = {};
  const skippedBecauseOrgScoped: string[] = [];

  for (const [name, value] of Object.entries(allSecrets)) {
    const normalizedValue = String(value || "").trim();
    if (!normalizedValue) continue;

    const isShared = sharedSet.has(name);
    const shouldInjectRepo = !isShared
      || mode === "repo"
      || (mode === "hybrid" && fallbackSet.has(name));

    if (shouldInjectRepo) {
      injectRepoSecrets[name] = normalizedValue;
    } else {
      skippedBecauseOrgScoped.push(name);
    }
  }

  return {
    injectRepoSecrets,
    requiredAtRuntime: Object.keys(allSecrets),
    skippedBecauseOrgScoped,
  };
}
