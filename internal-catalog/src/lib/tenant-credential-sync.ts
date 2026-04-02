/**
 * Tenant credential sync orchestration.
 * Maps TeamConfig -> KV + AWS Secrets Manager writes.
 * SM is written first; KV commit only after SM succeeds.
 */

import type { TeamConfig } from "./team-registry";
import {
  deleteTeam as deleteTeamRecord,
  getTeam as getTeamRecord,
  listTeams as listTeamSlugs,
  putTeam as putTeamRecord,
} from "./team-registry";
import {
  batchGetSecretValue,
  createSecret,
  deleteSecret,
  getSecretString,
  getTenantSecretsPrefix,
  isAwsErrorCode,
  isTenantSecretSyncEnabled,
  listSecrets,
  putSecretValue,
  resolveAwsSecretsManagerConfig,
  restoreSecret,
  tagResource,
  type AwsSecretsManagerEnv,
  type SecretTag,
} from "./aws-secrets-manager";
import { parseTeamConfigsFromEnv } from "./team-registry";
import { logWorkerEvent, type WorkerLogEnv } from "./worker-logs";

export interface TenantSecretRefs {
  apiKeySecretId: string;
  accessTokenSecretId: string;
}

export interface SecretSyncResult {
  secretId: string;
  action: "created" | "updated" | "noop" | "deleted" | "disabled";
}


export interface TenantStoreSyncResult {
  slug: string;
  api_key: SecretSyncResult;
  access_token: SecretSyncResult;
  }

export interface TenantDriftRecord {
  slug: string;
  api_key: "match" | "missing" | "drift" | "disabled";
  access_token: "match" | "missing" | "drift" | "disabled";
}

export interface TenantCredentialSyncDeps {
  getSecretString(secretId: string): Promise<string | null>;
  createSecret(args: { name: string; description: string; value: string; tags?: SecretTag[] }): Promise<void>;
  putSecretValue(args: { secretId: string; value: string }): Promise<void>;
  tagResource(args: { secretId: string; tags: SecretTag[] }): Promise<void>;
  restoreSecret(secretId: string): Promise<void>;
  deleteSecret(args: { secretId: string; recoveryWindowInDays?: number; forceDeleteWithoutRecovery?: boolean }): Promise<void>;
  putTeam(kv: KVNamespace, team: TeamConfig): Promise<void>;
  getTeam(kv: KVNamespace, slug: string): Promise<TeamConfig | null>;
  deleteTeam(kv: KVNamespace, slug: string): Promise<boolean>;
  listTeams(kv: KVNamespace): Promise<string[]>;
  }

function normalizeSlug(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildSecretDescription(kind: "api-key" | "access-token", team: TeamConfig): string {
  return `Postman ${kind} for ${team.slug} (${team.team_name})`;
}

function buildSecretTags(team: TeamConfig): SecretTag[] {
  return [
    { Key: "managed-by", Value: "verizon-partner-demo-worker" },
    { Key: "tenant-slug", Value: team.slug },
    { Key: "team-id", Value: team.team_id },
  ];
}

export function buildTenantSecretRefs(prefix: string, slug: string): TenantSecretRefs {
  const normalizedPrefix = String(prefix || "/postman/tenants").replace(/\/+$/, "") || "/postman/tenants";
  const normalizedSlug = normalizeSlug(slug);
  return {
    apiKeySecretId: `${normalizedPrefix}/${normalizedSlug}/api-key`,
    accessTokenSecretId: `${normalizedPrefix}/${normalizedSlug}/access-token`,
  };
}

export function createDefaultDeps(env: AwsSecretsManagerEnv): TenantCredentialSyncDeps {
  const config = resolveAwsSecretsManagerConfig(env);

  return {
    getSecretString: (secretId) => getSecretString(config, secretId),
    createSecret: (args) => createSecret({ config, ...args }),
    putSecretValue: (args) => putSecretValue({ config, ...args }),
    tagResource: (args) => tagResource({ config, ...args }),
    restoreSecret: (secretId) => restoreSecret(config, secretId),
    deleteSecret: (args) => deleteSecret({ config, ...args }),
    putTeam: putTeamRecord,
    getTeam: getTeamRecord,
    deleteTeam: deleteTeamRecord,
    listTeams: listTeamSlugs,
      };
}

async function readRemoteValue(deps: TenantCredentialSyncDeps, secretId: string): Promise<string | null> {
  try {
    return await deps.getSecretString(secretId);
  } catch (error) {
    if (isAwsErrorCode(error, "ResourceNotFoundException")) return null;
    if (isAwsErrorCode(error, "InvalidRequestException") && /scheduled for deletion/i.test(String((error as Error).message))) {
      return null;
    }
    throw error;
  }
}

async function ensureSecretValue(args: {
  deps: TenantCredentialSyncDeps;
  secretId: string;
  desiredValue: string;
  description: string;
  tags: SecretTag[];
}): Promise<SecretSyncResult> {
  const { deps, secretId, desiredValue, description, tags } = args;
  const currentValue = await readRemoteValue(deps, secretId);

  const ensureTags = async () => {
    if (tags.length > 0) {
      await deps.tagResource({ secretId, tags });
    }
  };

  if (currentValue === desiredValue) {
    await ensureTags();
    return { secretId, action: "noop" };
  }

  if (currentValue === null) {
    try {
      await deps.createSecret({ name: secretId, description, value: desiredValue, tags });
      return { secretId, action: "created" };
    } catch (error) {
      if (!isAwsErrorCode(error, "ResourceExistsException")) throw error;
    }
  }

  await deps.putSecretValue({ secretId, value: desiredValue });
  await ensureTags();
  return { secretId, action: "updated" };
}

export async function ensureTenantSecretsSynced(
  env: AwsSecretsManagerEnv,
  team: TeamConfig,
  deps?: TenantCredentialSyncDeps,
): Promise<TenantStoreSyncResult> {
  const resolvedDeps = deps ?? createDefaultDeps(env);
  const slug = normalizeSlug(team.slug);
  const refs = buildTenantSecretRefs(getTenantSecretsPrefix(env), slug);

  if (!isTenantSecretSyncEnabled(env)) {
    return {
      slug,
      api_key: { secretId: refs.apiKeySecretId, action: "disabled" },
      access_token: { secretId: refs.accessTokenSecretId, action: "disabled" },
    };
  }

  const tags = buildSecretTags(team);

  const api_key = await ensureSecretValue({
    deps: resolvedDeps,
    secretId: refs.apiKeySecretId,
    desiredValue: String(team.api_key || "").trim(),
    description: buildSecretDescription("api-key", team),
    tags,
  });

  const access_token = await ensureSecretValue({
    deps: resolvedDeps,
    secretId: refs.accessTokenSecretId,
    desiredValue: String(team.access_token || "").trim(),
    description: buildSecretDescription("access-token", team),
    tags,
  });

  return { slug, api_key, access_token };
}

export async function registerTeamWithSync(
  kv: KVNamespace,
  env: AwsSecretsManagerEnv,
  team: TeamConfig,
  deps?: TenantCredentialSyncDeps,
  logContext?: { requestId: string; route: string; method: string; env?: WorkerLogEnv },
): Promise<{ team: TeamConfig; sync: TenantStoreSyncResult }> {
  const resolvedDeps = deps ?? createDefaultDeps(env);
  
  // Helper to log sync events
  const logSyncEvent = (level: "info" | "warn" | "error", event: string, metadata?: Record<string, unknown>) => {
    if (logContext?.env) {
      void logWorkerEvent(logContext.env, {
        request_id: logContext.requestId,
        route: logContext.route,
        method: logContext.method,
        event,
        level,
        metadata: {
          slug: team.slug,
          ...metadata,
        },
      });
    }
  };

  // Step 1: Sync to AWS Secrets Manager (authority)
  const sync = await ensureTenantSecretsSynced(env, team, resolvedDeps);
  logSyncEvent("info", "team.sm_sync.completed", { api_key_action: sync.api_key.action, access_token_action: sync.access_token.action });

  // Step 2: Write to KV immediately after SM succeeds — KV is the runtime cache
  await resolvedDeps.putTeam(kv, team);
  logSyncEvent("info", "team.kv_write.completed");

  // Build complete sync result
  return { team, sync };
}

export async function updateTeamWithSync(
  kv: KVNamespace,
  env: AwsSecretsManagerEnv,
  slug: string,
  updates: Partial<TeamConfig>,
  deps?: TenantCredentialSyncDeps,
  logContext?: { requestId: string; route: string; method: string; env?: WorkerLogEnv },
): Promise<{ team: TeamConfig; sync: TenantStoreSyncResult } | null> {
  const resolvedDeps = deps ?? createDefaultDeps(env);
  
  const logSyncEvent = (level: "info" | "warn" | "error", event: string, metadata?: Record<string, unknown>) => {
    if (logContext?.env) {
      void logWorkerEvent(logContext.env, {
        request_id: logContext.requestId,
        route: logContext.route,
        method: logContext.method,
        event,
        level,
        metadata: {
          slug,
          ...metadata,
        },
      });
    }
  };

  const existing = await resolvedDeps.getTeam(kv, slug);
  if (!existing) {
    logSyncEvent("warn", "team.update.not_found");
    return null;
  }

  const merged: TeamConfig = {
    slug: existing.slug,
    team_id: existing.team_id,
    team_name: typeof updates.team_name === "string" && updates.team_name.trim()
      ? updates.team_name.trim()
      : existing.team_name,
    api_key: typeof updates.api_key === "string" && updates.api_key.trim()
      ? updates.api_key.trim()
      : existing.api_key,
    access_token: typeof updates.access_token === "string" && updates.access_token.trim()
      ? updates.access_token.trim()
      : existing.access_token,
    system_env_id: typeof updates.system_env_id === "string"
      ? (updates.system_env_id.trim() || undefined)
      : existing.system_env_id,
    org_mode: typeof updates.org_mode === "boolean" ? updates.org_mode : existing.org_mode,
  };

  const sync = await ensureTenantSecretsSynced(env, merged, resolvedDeps);
  logSyncEvent("info", "team.sm_sync.completed", { api_key_action: sync.api_key.action, access_token_action: sync.access_token.action });

  await resolvedDeps.putTeam(kv, merged);
  logSyncEvent("info", "team.kv_write.completed");

  

  const fullSync: TenantStoreSyncResult = {
    ...sync,
  };

  return { team: merged, sync: fullSync };
}

export async function deleteTeamWithSync(
  kv: KVNamespace,
  env: AwsSecretsManagerEnv,
  slug: string,
  deps?: TenantCredentialSyncDeps,
  options: { recoveryWindowInDays?: number; forceDeleteWithoutRecovery?: boolean } = {},
  logContext?: { requestId: string; route: string; method: string; env?: WorkerLogEnv },
): Promise<{ deleted: boolean; sync?: TenantStoreSyncResult }> {
  const resolvedDeps = deps ?? createDefaultDeps(env);
  
  const logSyncEvent = (level: "info" | "warn" | "error", event: string, metadata?: Record<string, unknown>) => {
    if (logContext?.env) {
      void logWorkerEvent(logContext.env, {
        request_id: logContext.requestId,
        route: logContext.route,
        method: logContext.method,
        event,
        level,
        metadata: {
          slug,
          ...metadata,
        },
      });
    }
  };

  const existing = await resolvedDeps.getTeam(kv, slug);
  if (!existing) {
    logSyncEvent("warn", "team.delete.not_found");
    return { deleted: false };
  }

  const refs = buildTenantSecretRefs(getTenantSecretsPrefix(env), existing.slug);

  
  if (isTenantSecretSyncEnabled(env)) {
    

    const deleteOne = async (secretId: string): Promise<SecretSyncResult> => {
      try {
        await resolvedDeps.deleteSecret({
          secretId,
          recoveryWindowInDays: options.recoveryWindowInDays ?? 7,
          forceDeleteWithoutRecovery: options.forceDeleteWithoutRecovery,
        });
        return { secretId, action: "deleted" };
      } catch (error) {
        if (isAwsErrorCode(error, "ResourceNotFoundException")) {
          return { secretId, action: "noop" };
        }
        throw error;
      }
    };

    const sync: TenantStoreSyncResult = {
      slug: existing.slug,
      api_key: await deleteOne(refs.apiKeySecretId),
      access_token: await deleteOne(refs.accessTokenSecretId),
    };

    await resolvedDeps.deleteTeam(kv, existing.slug);
    logSyncEvent("info", "team.delete.completed", { slug: existing.slug });
    return { deleted: true, sync };
  }

  await resolvedDeps.deleteTeam(kv, existing.slug);
  logSyncEvent("info", "team.delete.completed", { slug: existing.slug, sm_disabled: true });
  return {
    deleted: true,
    sync: {
      slug: existing.slug,
      api_key: { secretId: refs.apiKeySecretId, action: "disabled" },
      access_token: { secretId: refs.accessTokenSecretId, action: "disabled" },
    },
  };
}

// -- SM-authoritative reconciliation (SM -> KV) --

export interface ReconciliationResult {
  activeSlugs: string[];
  prunedSlugs: string[];
  errors: string[];
}

/**
 * Discover all team slugs that have secrets in SM tagged with managed-by=verizon-partner-demo-worker.
 * Extracts slugs from secret names matching {prefix}/{slug}/api-key.
 */
export async function discoverAuthorityTeams(env: AwsSecretsManagerEnv): Promise<string[]> {
  if (!isTenantSecretSyncEnabled(env)) return [];
  const config = resolveAwsSecretsManagerConfig(env);
  const prefix = getTenantSecretsPrefix(env);

  const secrets = await listSecrets(config, [
    { Key: "tag-key", Values: ["managed-by"] },
    { Key: "tag-value", Values: ["verizon-partner-demo-worker"] },
  ]);

  const slugs = new Set<string>();
  const apiKeySuffix = "/api-key";
  const normalizedPrefix = prefix.replace(/\/+$/, "") + "/";

  for (const secret of secrets) {
    if (secret.DeletedDate) continue;
    const name = secret.Name || "";
    if (!name.startsWith(normalizedPrefix) || !name.endsWith(apiKeySuffix)) continue;
    const slug = name.slice(normalizedPrefix.length, -apiKeySuffix.length);
    if (slug && !slug.includes("/")) {
      slugs.add(normalizeSlug(slug));
    }
  }

  return Array.from(slugs);
}

/**
 * Read both api-key and access-token from SM for a single team using BatchGetSecretValue.
 */
export async function readAuthorityBundle(
  env: AwsSecretsManagerEnv,
  slug: string,
): Promise<{ api_key: string | null; access_token: string | null } | null> {
  const config = resolveAwsSecretsManagerConfig(env);
  const prefix = getTenantSecretsPrefix(env);
  const refs = buildTenantSecretRefs(prefix, slug);

  const entries = await batchGetSecretValue(config, [
    refs.apiKeySecretId,
    refs.accessTokenSecretId,
  ]);

  const result: { api_key: string | null; access_token: string | null } = {
    api_key: null,
    access_token: null,
  };

  for (const entry of entries) {
    if (entry.Name === refs.apiKeySecretId && typeof entry.SecretString === "string") {
      result.api_key = entry.SecretString.trim() || null;
    }
    if (entry.Name === refs.accessTokenSecretId && typeof entry.SecretString === "string") {
      result.access_token = entry.SecretString.trim() || null;
    }
  }

  if (!result.api_key && !result.access_token) return null;
  return result;
}

export async function reconcileRegistryFromAuthority(
  kv: KVNamespace,
  env: AwsSecretsManagerEnv,
  deps?: TenantCredentialSyncDeps,
  logContext?: { requestId: string; route: string; method: string; env?: WorkerLogEnv },
): Promise<ReconciliationResult> {
  const logSyncEvent = (level: "info" | "warn" | "error", event: string, metadata?: Record<string, unknown>) => {
    if (logContext?.env) {
      void logWorkerEvent(logContext.env, {
        request_id: logContext.requestId,
        route: logContext.route,
        method: logContext.method,
        event,
        level,
        metadata,
      });
    }
  };

  if (!isTenantSecretSyncEnabled(env)) {
    logSyncEvent("warn", "reconcile.disabled");
    return { activeSlugs: [], prunedSlugs: [], errors: ["Tenant secret sync is disabled"] };
  }

  const resolvedDeps = deps ?? createDefaultDeps(env);
  const authoritySlugs = await discoverAuthorityTeams(env);
  logSyncEvent("info", "reconcile.authority_discovered", { count: authoritySlugs.length });

  const activeSlugs: string[] = [];
  const errors: string[] = [];
  const teamConfigs: Map<string, TeamConfig> = new Map();

  for (const slug of authoritySlugs) {
    try {
      const bundle = await readAuthorityBundle(env, slug);
      if (!bundle || !bundle.api_key || !bundle.access_token) {
        const errorMsg = `${slug}: incomplete credentials in SM (api_key=${!!bundle?.api_key}, access_token=${!!bundle?.access_token})`;
        errors.push(errorMsg);
        logSyncEvent("warn", "reconcile.incomplete_credentials", { slug, hasApiKey: !!bundle?.api_key, hasAccessToken: !!bundle?.access_token });
        continue;
      }

      const existing = await resolvedDeps.getTeam(kv, slug);
      const team: TeamConfig = {
        slug,
        team_id: existing?.team_id || "",
        team_name: existing?.team_name || slug,
        api_key: bundle.api_key,
        access_token: bundle.access_token,
        system_env_id: existing?.system_env_id,
        org_mode: existing?.org_mode,
      };

      try {
        await resolvedDeps.putTeam(kv, team);
        activeSlugs.push(slug);
        teamConfigs.set(slug, team);
        logSyncEvent("info", "reconcile.team_synced", { slug });
      } catch (kvErr) {
        const errorMsg = `${slug}: KV write failed — ${kvErr instanceof Error ? kvErr.message : String(kvErr)}`;
        errors.push(errorMsg);
        logSyncEvent("error", "reconcile.kv_write_failed", { slug, error: kvErr instanceof Error ? kvErr.message : String(kvErr) });
      }
    } catch (err) {
      const errorMsg = `${slug}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(errorMsg);
      logSyncEvent("error", "reconcile.team_failed", { slug, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const kvSlugs = await resolvedDeps.listTeams(kv);
  const authoritySet = new Set(activeSlugs);
  const prunedSlugs: string[] = [];

  for (const kvSlug of kvSlugs) {
    if (!authoritySet.has(kvSlug)) {
      await resolvedDeps.deleteTeam(kv, kvSlug);
      prunedSlugs.push(kvSlug);
      logSyncEvent("info", "reconcile.pruned", { slug: kvSlug });
    }
  }

  logSyncEvent("info", "reconcile.completed", {
    active_count: activeSlugs.length,
    pruned_count: prunedSlugs.length,
    error_count: errors.length,
  });

  return {
    activeSlugs,
    prunedSlugs,
    errors,
  };
}

/**
 * Bootstrap teams from env vars into SM, then reconcile SM -> KV.
 * Replaces the old seedTeamsFromEnv + reconcileTenantSecrets two-step.
 */
export async function bootstrapTeamsFromEnvToAuthority(
  kv: KVNamespace,
  env: AwsSecretsManagerEnv & Record<string, unknown>,
): Promise<string[]> {
  const teams = parseTeamConfigsFromEnv(env).filter((t) => t.team_id);
  if (teams.length === 0) return [];

  const seeded: string[] = [];
  for (const team of teams) {
    await ensureTenantSecretsSynced(env, team);
    seeded.push(team.slug);
  }

  await reconcileRegistryFromAuthority(kv, env);
  return seeded;
}
