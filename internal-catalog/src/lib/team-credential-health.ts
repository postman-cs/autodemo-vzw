/**
 * Credential health validation for team registry entries.
 * Validates API keys and access tokens against Postman APIs and
 * produces structured health summaries for the frontend.
 */

import {
  deriveTeamRuntimeMetadata,
  type TeamRuntimeMetadata,
} from "./team-runtime-metadata";

export interface CredentialProfile {
  team_id?: string;
  team_name?: string;
  slug?: string;
}

export interface CredentialHealthSummary {
  status: "healthy" | "warning" | "invalid" | "stale" | "unchecked";
  code?: string;
  message?: string;
  checked_at?: string;
  api_key_identity?: CredentialProfile;
  access_token_identity?: CredentialProfile;
  blocked?: boolean;
  /** Derived runtime metadata including org-mode detection and workspace teams */
  runtime_metadata?: TeamRuntimeMetadata;
}

interface AccessTokenIdentityOptions {
  teamId?: string;
  orgMode?: boolean;
}

function normalizeAccessTokenIdentityOptions(options?: string | AccessTokenIdentityOptions): AccessTokenIdentityOptions {
  if (typeof options === "string") {
    return { teamId: options };
  }
  return options ?? {};
}

export async function withRuntimeMetadata(
  summary: CredentialHealthSummary,
  credentials: { api_key?: string; access_token?: string; team_id?: string },
): Promise<CredentialHealthSummary> {
  if (!credentials.api_key || !credentials.access_token) {
    return summary;
  }

  try {
    const runtimeMetadata = await deriveTeamRuntimeMetadata({
      api_key: credentials.api_key,
      access_token: credentials.access_token,
      team_id: credentials.team_id,
    });

    const previousRuntimeMetadata = summary.runtime_metadata;
    const previousHasTeams = Boolean(
      previousRuntimeMetadata && (
        previousRuntimeMetadata.workspace_team_count > 0
        || previousRuntimeMetadata.workspace_teams.length > 0
      ),
    );
    const derivedHasTeams = runtimeMetadata.workspace_team_count > 0 || runtimeMetadata.workspace_teams.length > 0;
    const derivedHasIdentity = Boolean(
      runtimeMetadata.identity.team_id
      || runtimeMetadata.identity.team_name
      || runtimeMetadata.identity.slug,
    );

    if (previousRuntimeMetadata && previousHasTeams && !derivedHasTeams) {
      return {
        ...summary,
        runtime_metadata: previousRuntimeMetadata,
      };
    }

    if (previousRuntimeMetadata && !derivedHasIdentity && !derivedHasTeams) {
      return {
        ...summary,
        runtime_metadata: previousRuntimeMetadata,
      };
    }

    return {
      ...summary,
      runtime_metadata: runtimeMetadata,
    };
  } catch {
    return summary;
  }
}

export async function discoverIdentityProfileFromAccessToken(
  accessToken: string,
  options?: string | AccessTokenIdentityOptions,
): Promise<CredentialProfile> {
  const { teamId, orgMode } = normalizeAccessTokenIdentityOptions(options);

  // Primary: iapub sessions endpoint returns full identity (teamId, teamName, slug)
  // for both org-mode and non-org-mode access tokens.
  try {
    const resp = await fetch("https://iapub.postman.co/api/sessions/current", {
      headers: { "x-access-token": accessToken },
    });
    if (resp.ok) {
      const payload = (await resp.json()) as {
        session?: {
          status?: string;
          data?: { user?: Record<string, unknown> };
          identity?: { team?: string | number; domain?: string; user?: string | number };
        };
      };
      const session = payload?.session;
      if (session?.status === "active") {
        const identity = session.identity;
        const userData = session.data?.user;
        const discovered: CredentialProfile = {
          team_id: identity?.team != null ? String(identity.team) : undefined,
          team_name: typeof userData?.teamName === "string" ? userData.teamName : undefined,
          slug: typeof identity?.domain === "string" ? identity.domain : undefined,
        };
        if (discovered.team_id || discovered.team_name || discovered.slug) {
          return discovered;
        }
      }
    }
  } catch {
    // iapub unreachable; fall through to Bifrost fallback.
  }

  // Fallback: Bifrost api-catalog system-envs (returns teamId but not teamName/slug).
  // Covers cases where iapub is down but Bifrost is reachable.
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-access-token": accessToken,
    };
    if (orgMode === true && teamId && String(teamId).trim()) {
      headers["x-entity-team-id"] = String(teamId).trim();
    }
    const query: Record<string, string> = {};
    if (teamId && String(teamId).trim()) query.teamId = String(teamId).trim();

    const resp = await fetch("https://bifrost-premium-https-v4.gw.postman.com/ws/proxy", {
      method: "POST",
      headers,
      body: JSON.stringify({
        service: "api-catalog",
        method: "GET",
        path: "/api/system-envs",
        query,
        body: {},
      }),
    });
    if (resp.ok) {
      const payload = (await resp.json()) as { data?: Array<{ teamId?: string | number }> };
      const records = Array.isArray(payload.data) ? payload.data : [];
      for (const record of records) {
        const recordTeamId = record.teamId != null ? String(record.teamId).trim() : undefined;
        if (recordTeamId) {
          return { team_id: recordTeamId };
        }
      }
    }
  } catch {
    // Bifrost fallback failure is non-fatal.
  }

  return {};
}

export async function fetchApiKeyProfile(apiKey: string): Promise<CredentialProfile> {
  const meResp = await fetch("https://api.getpostman.com/me", {
    headers: { "X-Api-Key": apiKey },
  });
  if (!meResp.ok) {
    const text = await meResp.text().catch(() => "");
    throw new Error(`API key validation failed: ${meResp.status} ${text}`);
  }
  const meData = (await meResp.json()) as { user?: Record<string, unknown> };
  const user = meData?.user || {};
  return {
    team_id: typeof user.teamId === "string" || typeof user.teamId === "number" ? String(user.teamId) : undefined,
    team_name: typeof user.teamName === "string" ? user.teamName : undefined,
    slug: typeof user.teamDomain === "string" ? user.teamDomain : undefined,
  };
}

export async function validateAccessTokenForTeam(
  accessToken: string,
  options: { teamId?: string; orgMode?: boolean },
): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-access-token": accessToken,
  };
  if (options.orgMode === true && options.teamId) {
    headers["x-entity-team-id"] = options.teamId;
  }

  const validateResp = await fetch("https://bifrost-premium-https-v4.gw.postman.com/ws/proxy", {
    method: "POST",
    headers,
    body: JSON.stringify({
      service: "api-catalog",
      method: "GET",
      path: "/api/system-envs",
      query: options.teamId ? { teamId: options.teamId } : {},
      body: {},
    }),
  });
  if (!validateResp.ok) {
    const text = await validateResp.text().catch(() => "");
    throw new Error(`Access token validation failed: ${validateResp.status} ${text}`);
  }
}

export function assertMatchingTeamIdentity(args: {
  expectedTeamId?: string;
  expectedSlug?: string;
  expectedTeamName?: string;
  apiKeyProfile?: CredentialProfile;
  accessTokenProfile?: CredentialProfile;
}): void {
  const normalize = (value?: string) => String(value || "").trim().toLowerCase();
  const expectedTeamId = String(args.expectedTeamId || "").trim();
  const expectedSlug = normalize(args.expectedSlug);
  const expectedTeamName = normalize(args.expectedTeamName);

  const candidates = [
    { label: "API key", profile: args.apiKeyProfile },
    { label: "access token", profile: args.accessTokenProfile },
  ].filter((entry) => entry.profile);

  for (const { label, profile } of candidates) {
    const profileTeamId = String(profile?.team_id || "").trim();
    const profileSlug = normalize(profile?.slug);
    const profileTeamName = normalize(profile?.team_name);
    if (expectedTeamId && profileTeamId && profileTeamId !== expectedTeamId) {
      throw new Error(`${label} team_id ${profileTeamId} does not match expected team_id ${expectedTeamId}`);
    }
    if (expectedSlug && profileSlug && profileSlug !== expectedSlug) {
      throw new Error(`${label} team slug ${profile?.slug} does not match expected slug ${args.expectedSlug}`);
    }
    if (expectedTeamName && profileTeamName && profileTeamName !== expectedTeamName) {
      throw new Error(`${label} team name ${profile?.team_name} does not match expected team_name ${args.expectedTeamName}`);
    }
  }

  if (args.apiKeyProfile && args.accessTokenProfile) {
    const apiTeamId = String(args.apiKeyProfile.team_id || "").trim();
    const tokenTeamId = String(args.accessTokenProfile.team_id || "").trim();
    if (apiTeamId && tokenTeamId && apiTeamId !== tokenTeamId) {
      throw new Error(`API key team_id ${apiTeamId} does not match access token team_id ${tokenTeamId}`);
    }

    const apiSlug = normalize(args.apiKeyProfile.slug);
    const tokenSlug = normalize(args.accessTokenProfile.slug);
    if (apiSlug && tokenSlug && apiSlug !== tokenSlug) {
      throw new Error(`API key team slug ${args.apiKeyProfile.slug} does not match access token team slug ${args.accessTokenProfile.slug}`);
    }
  }
}

export async function checkCredentialHealth(
  apiKey: string,
  accessToken: string,
  options?: string | AccessTokenIdentityOptions,
): Promise<CredentialHealthSummary> {
  const { teamId: expectedTeamId, orgMode } = normalizeAccessTokenIdentityOptions(options);
  const now = new Date().toISOString();

  let apiKeyProfile: CredentialProfile | undefined;
  try {
    apiKeyProfile = await fetchApiKeyProfile(apiKey);
  } catch (err) {
    if (err instanceof TypeError || (err instanceof Error && /fetch failed|network/i.test(err.message))) {
      return {
        status: "warning",
        code: "postman_unreachable",
        message: "Could not verify credentials -- Postman API unreachable. Last known status may be stale.",
        checked_at: now,
        blocked: false,
      };
    }
    return {
      status: "invalid",
      code: "api_key_invalid",
      message: "API key is invalid or revoked. Generate a new one in Postman and update this team's credentials.",
      checked_at: now,
      blocked: true,
    };
  }

  let accessTokenProfile: CredentialProfile | undefined;
  try {
    accessTokenProfile = await discoverIdentityProfileFromAccessToken(accessToken, {
      teamId: expectedTeamId,
      orgMode,
    });
    if (!accessTokenProfile.team_id && !accessTokenProfile.team_name && !accessTokenProfile.slug) {
      return {
        status: "invalid",
        code: "access_token_invalid",
        message: "Access token could not resolve to any team. It may be expired or revoked. Re-authenticate with the Postman CLI and re-import credentials.",
        checked_at: now,
        api_key_identity: apiKeyProfile,
        blocked: true,
      };
    }
  } catch (err) {
    if (err instanceof TypeError || (err instanceof Error && /fetch failed|network/i.test(err.message))) {
      return {
        status: "warning",
        code: "postman_unreachable",
        message: "Could not verify access token -- Postman API unreachable. Last known status may be stale.",
        checked_at: now,
        api_key_identity: apiKeyProfile,
        blocked: false,
      };
    }
    return {
      status: "invalid",
      code: "access_token_invalid",
      message: "Access token validation failed. It may be expired or revoked. Re-authenticate with the Postman CLI and re-import credentials.",
      checked_at: now,
      api_key_identity: apiKeyProfile,
      blocked: true,
    };
  }

  const apiTeamId = String(apiKeyProfile.team_id || "").trim();
  const tokenTeamId = String(accessTokenProfile.team_id || "").trim();
  if (apiTeamId && tokenTeamId && apiTeamId !== tokenTeamId) {
    const apiName = apiKeyProfile.team_name || apiKeyProfile.slug || apiTeamId;
    const tokenName = accessTokenProfile.team_name || accessTokenProfile.slug || tokenTeamId;
    return {
      status: "invalid",
      code: "team_identity_mismatch",
      message: `API key belongs to '${apiName}' (${apiTeamId}) but access token belongs to '${tokenName}' (${tokenTeamId}). Update one or both credentials so they reference the same team.`,
      checked_at: now,
      api_key_identity: apiKeyProfile,
      access_token_identity: accessTokenProfile,
      blocked: true,
    };
  }

  return {
    status: "healthy",
    code: "healthy",
    message: undefined,
    checked_at: now,
    api_key_identity: apiKeyProfile,
    access_token_identity: accessTokenProfile,
    blocked: false,
  };
}
