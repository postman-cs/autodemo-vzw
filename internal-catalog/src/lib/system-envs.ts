// System environment discovery and Bifrost association utilities.
// Resolves available system environments from Postman's Bifrost API
// and manages workspace-to-system-environment associations.

const BIFROST_BASE = "https://bifrost-premium-https-v4.gw.postman.com/ws/proxy";

export interface SystemEnvironment {
  id: string;
  name: string;
  slug: string;
}

export interface SystemEnvMap {
  [slug: string]: string;
}

const SLUG_MAP: Record<string, string> = {
  production: "prod",
  staging: "stage",
  stage: "stage",
  development: "dev",
  qa: "qa",
  test: "qa",
};

export function deriveSlug(name: string): string {
  const normalized = name.trim().toLowerCase();
  return SLUG_MAP[normalized] || normalized.replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function dedupeBySlug(envs: SystemEnvironment[]): SystemEnvironment[] {
  const seen = new Map<string, SystemEnvironment>();
  for (const env of envs) {
    if (!seen.has(env.slug)) {
      seen.set(env.slug, env);
    }
  }
  return Array.from(seen.values());
}

function isAuthFailureMessage(message: string, responseText: string): boolean {
  const combined = `${message} ${responseText}`.toLowerCase();
  return /\b401\b|\b403\b/.test(combined)
    || combined.includes("authenticationerror")
    || combined.includes("not authenticated")
    || combined.includes("unauthorized");
}

export async function fetchSystemEnvironments(
  teamId: string,
  accessToken: string,
): Promise<SystemEnvironment[]> {
  const headers: Record<string, string> = {
    "x-access-token": accessToken,
    "x-entity-team-id": teamId,
    "Content-Type": "application/json",
  };

  async function requestSystemEnvs(body: Record<string, unknown>) {
    const response = await fetch(BIFROST_BASE, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      const err = new Error(`Bifrost system-envs request failed: HTTP ${response.status}`);
      (err as Error & { responseText?: string }).responseText = responseText;
      throw err;
    }
    return response.json() as Promise<{
      data?: Array<{ id: string; name: string; slug?: string }>;
    }>;
  }

  // Primary path: current Bifrost proxy contract used by desktop/web clients.
  // Keep legacy payload fallback for compatibility with older gateways.
  let data: { data?: Array<{ id: string; name: string; slug?: string }> };
  try {
    data = await requestSystemEnvs({
      service: "api-catalog",
      method: "GET",
      path: "/api/system-envs",
      query: { teamId },
      body: {},
    });
  } catch (err) {
    const responseText = String((err as Error & { responseText?: string }).responseText || "");
    const shouldFallback = responseText.includes("invalidPathError") || responseText.includes("not allowed");
    if (!shouldFallback) {
      throw err;
    }
    data = await requestSystemEnvs({
      service: "publishing",
      method: "get",
      path: `/api/system-envs?teamId=${encodeURIComponent(teamId)}`,
    });
  }

  const raw = data?.data;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Bifrost returned no system environments");
  }

  const envs: SystemEnvironment[] = raw.map((entry) => ({
    id: entry.id,
    name: entry.name,
    slug: entry.slug || deriveSlug(entry.name),
  }));

  return dedupeBySlug(envs);
}

export function buildFallbackSystemEnvironments(
  env: Record<string, unknown>,
): SystemEnvironment[] {
  const jsonRaw = String(env.POSTMAN_SYSTEM_ENVS_JSON || "").trim();
  if (jsonRaw) {
    try {
      const parsed = JSON.parse(jsonRaw) as Array<{ id: string; name: string; slug?: string }>;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return dedupeBySlug(
          parsed.map((e) => ({
            id: e.id,
            name: e.name,
            slug: e.slug || deriveSlug(e.name),
          })),
        );
      }
    } catch {
      // Fall through to POSTMAN_SYSTEM_ENV_PROD
    }
  }

  const prodId = String(env.POSTMAN_SYSTEM_ENV_PROD || "").trim();
  if (!prodId) return [];
  return [{ id: prodId, name: "Production", slug: "prod" }];
}

export async function resolveSystemEnvironments(
  teamId: string,
  accessToken: string,
  env: Record<string, unknown>,
  forceRefresh: boolean = false,
): Promise<SystemEnvironment[]> {
  const kv = env.WORKER_LOGS as { get: (key: string, type: "json") => Promise<unknown>; put: (key: string, value: string, options?: { expirationTtl: number }) => Promise<void> } | undefined;
  const cacheKey = `bifrost:system-envs:${teamId}`;
  let cached: SystemEnvironment[] | null = null;

  if (kv) {
    try {
      const stored = await kv.get(cacheKey, "json") as SystemEnvironment[] | null;
      if (Array.isArray(stored) && stored.length > 0) {
        cached = stored;
      }
    } catch {
      // Ignore cache read errors
    }
  }

  try {
    const envs = await fetchSystemEnvironments(teamId, accessToken);
    if (kv && envs.length > 0) {
      try {
        await kv.put(cacheKey, JSON.stringify(envs), { expirationTtl: 3600 });
      } catch {
        // Ignore cache write errors
      }
    }
    return envs;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const responseText = String((error as Error & { responseText?: string })?.responseText || "");
    if (isAuthFailureMessage(message, responseText)) {
      throw error;
    }
    if (!forceRefresh && cached && cached.length > 0) {
      return cached;
    }
    return buildFallbackSystemEnvironments(env);
  }
}

export function buildSystemEnvMap(envs: SystemEnvironment[]): SystemEnvMap {
  const map: SystemEnvMap = {};
  for (const e of envs) {
    map[e.slug] = e.id;
  }
  return map;
}

import {
  getSystemEnvAssociations,
  putSystemEnvAssociations,
  dedupeStrings,
  dedupeAssociations,
  associateSystemEnvironmentBatch,
  type BifrostAssociationEntry
} from "../../.github/actions/_lib/postman-bifrost";

export { dedupeAssociations };

// --- Association utilities ---

export async function associateSystemEnvironment(
  workspaceId: string,
  envUid: string,
  systemEnvId: string,
  accessToken: string,
  teamId: string,
): Promise<void> {
  await associateSystemEnvironmentBatch(
    workspaceId,
    [{ envUid, systemEnvId }],
    accessToken,
    teamId,
  );
}

export async function disassociateWorkspaceFromSystemEnvironments(
  workspaceId: string,
  accessToken: string,
  teamId: string,
  envUidsToRemove?: string[],
): Promise<void> {
  const systemEnvironments = await fetchSystemEnvironments(teamId, accessToken);
  const systemEnvIds = dedupeStrings(systemEnvironments.map((env) => env.id));
  if (systemEnvIds.length === 0) return;

  const removeSet = envUidsToRemove && envUidsToRemove.length > 0
    ? new Set(dedupeStrings(envUidsToRemove))
    : null;

  for (const systemEnvId of systemEnvIds) {
    const existing = await getSystemEnvAssociations(systemEnvId, accessToken, teamId);
    const workspaceEntry = existing.find((entry) => entry.workspaceId === workspaceId);
    if (!workspaceEntry) continue;

    let nextEntries = existing;
    if (removeSet) {
      const remainingEnvUids = workspaceEntry.postmanEnvironmentIds.filter((envUid) => !removeSet.has(envUid));
      if (remainingEnvUids.length === workspaceEntry.postmanEnvironmentIds.length) {
        continue;
      }
      for (const envUid of workspaceEntry.postmanEnvironmentIds) {
        removeSet.delete(envUid);
      }
      
      // Need a replacement for internal replaceWorkspaceEntry:
      nextEntries = replaceWorkspaceEntryLocal(existing, workspaceId, remainingEnvUids);
    } else {
      nextEntries = replaceWorkspaceEntryLocal(existing, workspaceId, []);
    }

    await putSystemEnvAssociations(systemEnvId, accessToken, teamId, nextEntries);

    if (removeSet && removeSet.size === 0) {
      break;
    }
  }
}

function replaceWorkspaceEntryLocal(
  existingEntries: Array<{ workspaceId: string; postmanEnvironmentIds: string[] }>,
  workspaceId: string,
  nextEnvUids: string[],
): Array<{ workspaceId: string; postmanEnvironmentIds: string[] }> {
  const normalizedWorkspaceId = String(workspaceId || "").trim();
  const normalizedEnvUids = dedupeStrings(nextEnvUids);
  const result: Array<{ workspaceId: string; postmanEnvironmentIds: string[] }> = [];
  let replaced = false;

  for (const entry of existingEntries) {
    if (entry.workspaceId !== normalizedWorkspaceId) {
      result.push({
        workspaceId: entry.workspaceId,
        postmanEnvironmentIds: dedupeStrings(entry.postmanEnvironmentIds),
      });
      continue;
    }
    replaced = true;
    if (normalizedEnvUids.length > 0) {
      result.push({
        workspaceId: normalizedWorkspaceId,
        postmanEnvironmentIds: normalizedEnvUids,
      });
    }
  }

  if (!replaced && normalizedEnvUids.length > 0) {
    result.push({
      workspaceId: normalizedWorkspaceId,
      postmanEnvironmentIds: normalizedEnvUids,
    });
  }

  return result;
}

// Ensure associateSystemEnvironmentBatch is exported for index.ts
export { associateSystemEnvironmentBatch };
