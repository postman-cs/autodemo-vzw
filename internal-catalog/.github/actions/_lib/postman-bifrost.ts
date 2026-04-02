export const BIFROST_BASE = "https://bifrost-premium-https-v4.gw.postman.com/ws/proxy";

export interface BifrostAssociationEntry {
  environmentUid: string;
  systemEnvironmentId: string;
}

interface BifrostAssociationsResponse {
  data?: {
    systemEnvironmentId?: string;
    workspaces?: Array<{
      workspaceId: string;
      associations?: Array<{
        id?: string;
        systemEnvironmentId?: string;
        postmanEnvironmentId?: string;
        workspaceId?: string;
        associatedAt?: string;
        workspaceName?: string;
        truncatedPostmanEnvironmentId?: string;
      }>;
    }>;
  };
}

export async function getSystemEnvAssociations(
  systemEnvironmentId: string,
  accessToken: string,
  teamId: string,
): Promise<Array<{ workspaceId: string; postmanEnvironmentIds: string[] }>> {
  const response = await fetch(BIFROST_BASE, {
    method: "POST",
    headers: bifrostHeaders(accessToken, teamId),
    body: JSON.stringify({
      service: "api-catalog",
      method: "GET",
      path: "/api/system-envs/associations",
      query: { systemEnvironmentId },
      body: {},
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Bifrost GET associations failed: HTTP ${response.status} ${text}`);
  }

  const data = (await response.json()) as BifrostAssociationsResponse;
  return normalizeWorkspaceEntries(data?.data?.workspaces || []);
}

export async function putSystemEnvAssociations(
  systemEnvironmentId: string,
  accessToken: string,
  teamId: string,
  workspaceEntries: Array<{ workspaceId: string; postmanEnvironmentIds: string[] }>,
): Promise<void> {
  const response = await fetch(BIFROST_BASE, {
    method: "POST",
    headers: bifrostHeaders(accessToken, teamId),
    body: JSON.stringify({
      service: "api-catalog",
      method: "PUT",
      path: "/api/system-envs/associations",
      body: {
        systemEnvironmentId,
        workspaceEntries,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bifrost PUT associations failed: HTTP ${response.status} ${text}`);
  }
}

export function bifrostHeaders(accessToken: string, teamId: string): Record<string, string> {
  return {
    "x-access-token": accessToken,
    "x-entity-team-id": teamId,
    "Content-Type": "application/json",
  };
}

export function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeWorkspaceEntries(
  workspaces: NonNullable<NonNullable<BifrostAssociationsResponse["data"]>["workspaces"]>,
): Array<{ workspaceId: string; postmanEnvironmentIds: string[] }> {
  const merged = new Map<string, string[]>();
  for (const workspace of workspaces) {
    const workspaceId = String(workspace?.workspaceId || "").trim();
    if (!workspaceId) continue;
    const envIds = dedupeStrings(
      (workspace.associations || []).map((association) => String(association?.postmanEnvironmentId || "")),
    );
    if (envIds.length === 0) continue;
    merged.set(workspaceId, dedupeStrings([...(merged.get(workspaceId) || []), ...envIds]));
  }
  return Array.from(merged.entries()).map(([workspaceId, postmanEnvironmentIds]) => ({
    workspaceId,
    postmanEnvironmentIds,
  }));
}

export function dedupeAssociations(entries: BifrostAssociationEntry[]): BifrostAssociationEntry[] {
  const seen = new Set<string>();
  const result: BifrostAssociationEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.environmentUid}::${entry.systemEnvironmentId}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }
  return result;
}

function replaceWorkspaceEntry(
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

export async function associateSystemEnvironmentBatch(
  workspaceId: string,
  associations: Array<{ envUid: string; systemEnvId: string }>,
  accessToken: string,
  teamId: string,
): Promise<void> {
  const grouped = new Map<string, string[]>();
  for (const association of associations) {
    const systemEnvId = String(association.systemEnvId || "").trim();
    const envUid = String(association.envUid || "").trim();
    if (!systemEnvId || !envUid) continue;
    grouped.set(systemEnvId, [...(grouped.get(systemEnvId) || []), envUid]);
  }

  for (const [systemEnvId, envUids] of grouped.entries()) {
    const existing = await getSystemEnvAssociations(systemEnvId, accessToken, teamId);
    const currentEnvUids = existing.find((entry) => entry.workspaceId === workspaceId)?.postmanEnvironmentIds || [];
    const merged = replaceWorkspaceEntry(existing, workspaceId, [...currentEnvUids, ...envUids]);

    try {
      await putSystemEnvAssociations(systemEnvId, accessToken, teamId, merged);
    } catch {
      // Retry with only the target workspace entries when an existing workspace snapshot is stale.
      const fresh = replaceWorkspaceEntry([], workspaceId, envUids);
      await putSystemEnvAssociations(systemEnvId, accessToken, teamId, fresh);
    }
  }
}
