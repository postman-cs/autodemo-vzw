/**
 * Team Runtime Metadata - Shared backend helper for deriving canonical team identity
 * and org-mode/runtime metadata from credentials.
 *
 * This module provides a unified interface for resolving team identity and detecting
 * org-mode status from Postman API credentials. It is used by:
 * - Team registration (POST /api/teams/registry)
 * - Health recheck (POST /api/teams/registry/:slug/health/recheck)
 * - Registry listing (GET /api/teams/registry)
 */

import {
  discoverIdentityProfileFromAccessToken,
  fetchApiKeyProfile,
  type CredentialProfile,
} from "./team-credential-health";

/**
 * Represents a single team from the Postman /api/teams endpoint.
 * This shape matches what the Provision page expects.
 */
export interface WorkspaceTeam {
  id: number;
  name: string;
  handle: string;
  memberCount: number;
}

/**
 * Runtime metadata derived from team credentials.
 * This is the canonical shape returned by deriveTeamRuntimeMetadata.
 */
export interface TeamRuntimeMetadata {
  /** Canonical team identity from credentials */
  identity: {
    team_id: string | undefined;
    team_name: string | undefined;
    slug: string | undefined;
  };
  /** List of teams accessible to the credentials */
  workspace_teams: WorkspaceTeam[];
  /** Count of accessible teams */
  workspace_team_count: number;
  /** Derived org-mode flag: true if user has access to more than 1 team */
  detected_org_mode: boolean;
  /** When metadata was resolved */
  resolved_at: string;
}

/**
 * Input options for deriving runtime metadata.
 */
export interface DeriveMetadataOptions {
  /** Postman API key (for identity resolution and /api/teams fetch) */
  api_key?: string;
  /** Postman access token (for identity resolution) */
  access_token?: string;
  /** Optional explicit team ID (for context in multi-team scenarios) */
  team_id?: string;
}

/**
 * Fetches accessible teams from the Postman API using the provided API key.
 * This uses the same endpoint and data shape as the Provision page's /api/teams call.
 *
 * @param apiKey - Postman API key
 * @param accessToken - Optional access token, currently unused
 * @returns Array of accessible teams
 */
export async function fetchAccessibleTeams(apiKey: string, accessToken?: string): Promise<WorkspaceTeam[]> {
  void accessToken;

  const resp = await fetch("https://api.getpostman.com/teams", {
    headers: {
      "X-Api-Key": apiKey,
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Failed to fetch teams: ${resp.status} ${text}`);
  }

  const body = (await resp.json()) as { data?: WorkspaceTeam[] };
  return body.data || [];
}

/**
 * Derives canonical team runtime metadata from credentials.
 *
 * This function:
 * 1. Resolves team identity from API key and/or access token
 * 2. Fetches accessible teams using the API key
 * 3. Derives org-mode status from team count
 * 4. Returns a canonical metadata shape for reuse across registration, health, and listing
 *
 * @param options - Credentials and optional context
 * @returns TeamRuntimeMetadata with identity, teams list, and derived flags
 */
export async function deriveTeamRuntimeMetadata(
  options: DeriveMetadataOptions,
): Promise<TeamRuntimeMetadata> {
  const { api_key, access_token, team_id } = options;

  // Resolve identity from available credentials
  let apiKeyProfile: CredentialProfile | undefined;
  let accessTokenProfile: CredentialProfile | undefined;

  if (api_key) {
    try {
      apiKeyProfile = await fetchApiKeyProfile(api_key);
    } catch {
      // Allow failure - we'll still try to get teams if access_token works
    }
  }

  if (access_token) {
    try {
      accessTokenProfile = await discoverIdentityProfileFromAccessToken(access_token, team_id);
    } catch {
      // Allow failure - identity resolution is best-effort
    }
  }

  // Merge identities: prefer API key for team_id, but fill in gaps from access token
  const mergedIdentity: CredentialProfile = {
    team_id: apiKeyProfile?.team_id || accessTokenProfile?.team_id,
    team_name: apiKeyProfile?.team_name || accessTokenProfile?.team_name,
    slug: apiKeyProfile?.slug || accessTokenProfile?.slug,
  };

  // Fetch accessible teams (requires API key, access token optional for Bifrost)
  let workspaceTeams: WorkspaceTeam[] = [];
  if (api_key) {
    try {
      workspaceTeams = await fetchAccessibleTeams(api_key, access_token);
    } catch {
      // Teams fetch failure is non-fatal for metadata derivation
      workspaceTeams = [];
    }
  }

  const workspaceTeamCount = workspaceTeams.length;
  const detectedOrgMode = workspaceTeamCount > 1;

  return {
    identity: {
      team_id: mergedIdentity.team_id,
      team_name: mergedIdentity.team_name,
      slug: mergedIdentity.slug,
    },
    workspace_teams: workspaceTeams,
    workspace_team_count: workspaceTeamCount,
    detected_org_mode: detectedOrgMode,
    resolved_at: new Date().toISOString(),
  };
}

/**
 * Validates that the resolved identity matches expected values.
 * Throws if there's a mismatch between credentials or with expected values.
 *
 * @param metadata - The derived runtime metadata
 * @param expected - Optional expected values to validate against
 * @throws Error if identity mismatch is detected
 */
export function validateIdentityConsistency(
  metadata: TeamRuntimeMetadata,
  expected?: {
    team_id?: string;
    slug?: string;
    team_name?: string;
  },
): void {
  const { identity } = metadata;

  if (expected?.team_id && identity.team_id && identity.team_id !== expected.team_id) {
    throw new Error(
      `Team ID mismatch: resolved ${identity.team_id} but expected ${expected.team_id}`,
    );
  }

  if (expected?.slug && identity.slug && identity.slug !== expected.slug) {
    throw new Error(`Team slug mismatch: resolved ${identity.slug} but expected ${expected.slug}`);
  }

  if (expected?.team_name && identity.team_name && identity.team_name !== expected.team_name) {
    throw new Error(
      `Team name mismatch: resolved ${identity.team_name} but expected ${expected.team_name}`,
    );
  }
}

/**
 * Summarizes workspace teams for display/storage purposes.
 * Returns a condensed representation without full member counts.
 *
 * @param teams - Array of workspace teams
 * @returns Summary array with essential fields only
 */
export function summarizeWorkspaceTeams(
  teams: WorkspaceTeam[],
): Array<{ id: number; name: string; handle: string }> {
  return teams.map((t) => ({
    id: t.id,
    name: t.name,
    handle: t.handle,
  }));
}
