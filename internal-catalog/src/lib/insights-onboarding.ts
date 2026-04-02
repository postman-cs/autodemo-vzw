/**
 * Insights discovery-mode onboarding via Bifrost api-catalog service.
 *
 * After the DaemonSet agent discovers services, these functions link each
 * discovered service to a workspace and git repo in Postman's API Catalog.
 *
 * Flow: listDiscoveredServices -> prepareCollection -> onboardGit -> acknowledgeOnboarding
 */

const BIFROST_BASE = "https://bifrost-premium-https-v4.gw.postman.com/ws/proxy";

function bifrostHeaders(accessToken: string, teamId: string): Record<string, string> {
  return {
    "x-access-token": accessToken,
    "x-entity-team-id": teamId,
    "Content-Type": "application/json",
  };
}

export interface DiscoveredService {
  id: number;
  name: string;
  version: string | null;
  sourceEnvironment: string | null;
  systemEnvironmentId: string | null;
  status: string;
  endpointsCount: number;
  connectionId: number;
  connectionType: string;
  tags: string[];
  discoveredAt: string;
}

interface DiscoveredServicesResponse {
  total: number;
  nextCursor: string | null;
  items: DiscoveredService[];
}

export async function listDiscoveredServices(
  accessToken: string,
  teamId: string,
): Promise<DiscoveredService[]> {
  const response = await fetch(BIFROST_BASE, {
    method: "POST",
    headers: bifrostHeaders(accessToken, teamId),
    body: JSON.stringify({
      service: "api-catalog",
      method: "GET",
      path: "/api/v1/onboarding/discovered-services?status=discovered",
      body: {},
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to list discovered services: ${response.status}`);
  }
  const data = (await response.json()) as DiscoveredServicesResponse;
  return data.items || [];
}

export async function prepareCollection(
  accessToken: string,
  teamId: string,
  serviceId: number,
  workspaceId: string,
): Promise<string> {
  const response = await fetch(BIFROST_BASE, {
    method: "POST",
    headers: bifrostHeaders(accessToken, teamId),
    body: JSON.stringify({
      service: "api-catalog",
      method: "POST",
      path: "/api/v1/onboarding/prepare-collection",
      body: { service_id: String(serviceId), workspace_id: workspaceId },
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`prepare-collection failed: ${response.status} ${text}`);
  }
  const data = (await response.json()) as { id: string };
  return data.id;
}

export interface OnboardGitParams {
  serviceId: number;
  workspaceId: string;
  environmentId: string;
  gitOwner: string;
  gitRepositoryName: string;
  gitRepositoryUrl: string;
  gitApiKey: string;
}

export async function onboardGit(
  accessToken: string,
  teamId: string,
  params: OnboardGitParams,
): Promise<void> {
  const response = await fetch(BIFROST_BASE, {
    method: "POST",
    headers: bifrostHeaders(accessToken, teamId),
    body: JSON.stringify({
      service: "api-catalog",
      method: "POST",
      path: "/api/v1/onboarding/git",
      body: {
        via_integrations: false,
        git_service_name: "github",
        workspace_id: params.workspaceId,
        git_repository_url: params.gitRepositoryUrl,
        git_api_key: params.gitApiKey,
        service_id: params.serviceId,
        environment_id: params.environmentId,
      },
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`onboarding/git failed: ${response.status} ${text}`);
  }
  const data = (await response.json()) as { message?: string; error?: { message?: string } };
  if (data.error?.message) {
    throw new Error(`onboarding/git error: ${data.error.message}`);
  }
}

export interface AcknowledgeParams {
  providerServiceId: string;
  workspaceId: string;
  systemEnvironmentId: string;
}

export async function acknowledgeOnboarding(
  accessToken: string,
  teamId: string,
  services: AcknowledgeParams[],
): Promise<void> {
  const response = await fetch(BIFROST_BASE, {
    method: "POST",
    headers: bifrostHeaders(accessToken, teamId),
    body: JSON.stringify({
      service: "akita",
      method: "POST",
      path: "/v2/api-catalog/services/onboard",
      body: {
        services: services.map((s) => ({
          service_id: s.providerServiceId,
          workspace_id: s.workspaceId,
          system_env: s.systemEnvironmentId,
        })),
      },
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Insights onboard acknowledgment failed: ${response.status} ${text}`);
  }
}

export async function acknowledgeWorkspace(
  accessToken: string,
  teamId: string,
  workspaceId: string,
): Promise<void> {
  const response = await fetch(BIFROST_BASE, {
    method: "POST",
    headers: bifrostHeaders(accessToken, teamId),
    body: JSON.stringify({
      service: "akita",
      method: "POST",
      path: `/v2/workspaces/${workspaceId}/onboarding/acknowledge`,
      body: {},
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Workspace acknowledge failed: ${response.status} ${text}`);
  }
}

export interface AcknowledgeRetryResult {
  success: boolean;
  attempts: number;
  lastError?: string;
}

/**
 * Retry wrapper for acknowledgeWorkspace with exponential backoff.
 * Returns a result object instead of throwing, so the caller can
 * decide how to surface the failure (SSE event, log, etc.).
 */
export async function acknowledgeWorkspaceWithRetry(
  accessToken: string,
  teamId: string,
  workspaceId: string,
  maxAttempts = 3,
): Promise<AcknowledgeRetryResult> {
  const BACKOFF_MS = [2_000, 4_000, 8_000];
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await acknowledgeWorkspace(accessToken, teamId, workspaceId);
      return { success: true, attempts: attempt };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts) {
        const delay = BACKOFF_MS[attempt - 1] || 8_000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  return { success: false, attempts: maxAttempts, lastError };
}

export async function getTeamVerificationToken(
  accessToken: string,
  teamId: string,
  workspaceId: string,
): Promise<string | null> {
  const response = await fetch(BIFROST_BASE, {
    method: "POST",
    headers: bifrostHeaders(accessToken, teamId),
    body: JSON.stringify({
      service: "akita",
      method: "GET",
      path: `/v2/workspaces/${workspaceId}/team-verification-token`,
      body: {},
    }),
  });
  if (!response.ok) {
    return null;
  }
  const data = (await response.json()) as { team_verification_token?: string };
  return data.team_verification_token || null;
}

export async function resolveProviderServiceId(
  accessToken: string,
  teamId: string,
  specId: string,
  clusterName: string,
): Promise<string | null> {
  const response = await fetch(BIFROST_BASE, {
    method: "POST",
    headers: bifrostHeaders(accessToken, teamId),
    body: JSON.stringify({
      service: "akita",
      method: "GET",
      path: "/v2/api-catalog/services?status=discovered&populate_endpoints=false&populate_discovery_metadata=true",
      body: {},
    }),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { services?: Array<{ id: string; name: string }> };
  const fullName = `${clusterName}/${specId}`;
  const match = (data.services || []).find((s) => s.name === fullName)
    || (data.services || []).find((s) => s.name.endsWith(`/${specId}`));
  return match?.id || null;
}

export function findDiscoveredService(
  services: DiscoveredService[],
  specId: string,
  clusterName: string,
): DiscoveredService | undefined {
  const fullName = `${clusterName}/${specId}`;
  return services.find((s) => s.name === fullName)
    || services.find((s) => s.name.endsWith(`/${specId}`));
}

/**
 * Create an application binding via the Observability agent API.
 * This goes directly to api.observability.postman.com, NOT through Bifrost.
 */
export async function createApplication(
  apiKey: string,
  workspaceId: string,
  systemEnv: string,
): Promise<{ application_id: string; service_id: string }> {
  const response = await fetch(
    `https://api.observability.postman.com/v2/agent/api-catalog/workspaces/${encodeURIComponent(workspaceId)}/applications`,
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "x-postman-env": "production",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ system_env: systemEnv }),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Application binding failed: ${response.status} ${text}`);
  }
  return response.json() as Promise<{ application_id: string; service_id: string }>;
}

/**
 * Delete discovered service entries from Insights for a given spec.
 * Called during teardown to prevent stale discovered services from
 * persisting in the Insights UI after the deployment is removed.
 */
export async function deleteDiscoveredServiceEntries(
  accessToken: string,
  teamId: string,
  specId: string,
  clusterName: string,
): Promise<{ deleted: number; errors: number }> {
  let deleted = 0;
  let errors = 0;
  try {
    const providerId = await resolveProviderServiceId(accessToken, teamId, specId, clusterName);
    if (!providerId) return { deleted: 0, errors: 0 };

    const response = await fetch(BIFROST_BASE, {
      method: "POST",
      headers: bifrostHeaders(accessToken, teamId),
      body: JSON.stringify({
        service: "akita",
        method: "DELETE",
        path: `/v2/api-catalog/services/${providerId}`,
        body: {},
      }),
    });
    if (response.ok) {
      deleted++;
    } else {
      errors++;
    }
  } catch {
    errors++;
  }
  return { deleted, errors };
}
