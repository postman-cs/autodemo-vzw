import {
  fetchApiKeyProfile,
  discoverIdentityProfileFromAccessToken,
} from "./team-credential-health";

export interface TeamConfig {
  slug: string;
  team_id: string;
  team_name: string;
  api_key: string;
  access_token: string;
  system_env_id?: string;
  org_mode?: boolean;
}

const TEAM_INDEX_KEY = "team-index";

function normalizeSlug(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function teamKey(slug: string): string {
  return `team:${normalizeSlug(slug)}`;
}

function teamByIdKey(teamId: string): string {
  return `team-by-id:${String(teamId || "").trim()}`;
}

async function readIndex(kv: KVNamespace): Promise<string[]> {
  const raw = await kv.get(TEAM_INDEX_KEY, "json");
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => normalizeSlug(String(entry || ""))).filter(Boolean);
}

async function writeIndex(kv: KVNamespace, slugs: string[]): Promise<void> {
  const unique = Array.from(new Set(slugs.map(normalizeSlug).filter(Boolean)));
  await kv.put(TEAM_INDEX_KEY, JSON.stringify(unique));
}

export async function listTeams(kv: KVNamespace): Promise<string[]> {
  return readIndex(kv);
}

export async function getTeam(kv: KVNamespace, slug: string): Promise<TeamConfig | null> {
  const key = teamKey(slug);
  const parsed = await kv.get(key, "json");
  if (!parsed || typeof parsed !== "object") return null;
  const team = parsed as TeamConfig;
  if (!team.slug || !team.team_id) return null;
  return {
    ...team,
    slug: normalizeSlug(team.slug),
    team_id: String(team.team_id || "").trim(),
    team_name: String(team.team_name || "").trim(),
    api_key: String(team.api_key || "").trim(),
    access_token: String(team.access_token || "").trim(),
    system_env_id: String(team.system_env_id || "").trim() || undefined,
    org_mode: team.org_mode === true,
  };
}

export async function getTeamById(kv: KVNamespace, teamId: string): Promise<TeamConfig | null> {
  const slug = await kv.get(teamByIdKey(teamId));
  if (!slug) return null;
  return getTeam(kv, slug);
}

export async function putTeam(kv: KVNamespace, config: TeamConfig): Promise<void> {
  const slug = normalizeSlug(config.slug);
  const teamId = String(config.team_id || "").trim();
  if (!slug) throw new Error("Team slug is required");
  if (!teamId) throw new Error("team_id is required");
  if (!String(config.api_key || "").trim()) throw new Error("api_key is required");
  if (!String(config.access_token || "").trim()) throw new Error("access_token is required");

  const payload: TeamConfig = {
    slug,
    team_id: teamId,
    team_name: String(config.team_name || "").trim() || slug,
    api_key: String(config.api_key || "").trim(),
    access_token: String(config.access_token || "").trim(),
    system_env_id: String(config.system_env_id || "").trim() || undefined,
    org_mode: config.org_mode === true,
  };

  await kv.put(teamKey(slug), JSON.stringify(payload));
  await kv.put(teamByIdKey(teamId), slug);
  const slugs = await readIndex(kv);
  await writeIndex(kv, [...slugs, slug]);
}

export async function deleteTeam(kv: KVNamespace, slug: string): Promise<boolean> {
  const existing = await getTeam(kv, slug);
  if (!existing) return false;
  await kv.delete(teamKey(existing.slug));
  await kv.delete(teamByIdKey(existing.team_id));
  const slugs = await readIndex(kv);
  await writeIndex(kv, slugs.filter((entry) => entry !== existing.slug));
  return true;
}

export async function resolveTeamCredentials(
  kv: KVNamespace | undefined,
  env: Record<string, unknown>,
  teamSlug?: string,
): Promise<{ api_key: string; access_token: string; team_id: string; team_name: string; slug?: string; org_mode?: boolean }> {
  const requestedSlug = normalizeSlug(String(teamSlug || "").trim());
  if (!requestedSlug) {
    throw new Error("Missing or invalid team_slug. Cannot resolve tenant context.");
  }
  
  if (kv) {
    const match = await getTeam(kv, requestedSlug);
    if (match) {
      return {
        api_key: match.api_key,
        access_token: match.access_token,
        team_id: match.team_id,
        team_name: match.team_name,
        slug: match.slug,
        org_mode: match.org_mode,
      };
    }

    const envMatch = parseTeamConfigsFromEnv(env).find((team) => team.slug === requestedSlug);
    if (!envMatch) {
      throw new Error(`Unknown team slug '${requestedSlug}'`);
    }
    return {
      api_key: envMatch.api_key,
      access_token: envMatch.access_token,
      team_id: envMatch.team_id,
      team_name: envMatch.team_name,
      slug: envMatch.slug,
      org_mode: envMatch.org_mode,
    };
  }

  const envMatch = parseTeamConfigsFromEnv(env).find((team) => team.slug === requestedSlug);
  if (envMatch) {
    return {
      api_key: envMatch.api_key,
      access_token: envMatch.access_token,
      team_id: envMatch.team_id,
      team_name: envMatch.team_name,
      slug: envMatch.slug,
      org_mode: envMatch.org_mode,
    };
  }

  throw new Error("TEAM_REGISTRY KV binding is required to resolve tenant credentials.");
}

/**
 * Parse POSTMAN_TEAM__<SLUG>__<FIELD> env vars into TeamConfig[].
 *
 * Convention:
 *   POSTMAN_TEAM__<SLUG>__API_KEY
 *   POSTMAN_TEAM__<SLUG>__ACCESS_TOKEN
 *   POSTMAN_TEAM__<SLUG>__TEAM_ID
 *   POSTMAN_TEAM__<SLUG>__TEAM_NAME
 *   POSTMAN_TEAM__<SLUG>__SYSTEM_ENV_ID  (optional)
 *   POSTMAN_TEAM__<SLUG>__ORG_MODE       (optional, "true"/"false")
 *
 * The SLUG portion uses underscores which are converted to hyphens when
 * normalised (e.g. FIELD_SERVICES -> field-services).
 */
export function parseTeamConfigsFromEnv(env: Record<string, unknown>): TeamConfig[] {
  const PREFIX = "POSTMAN_TEAM__";
  const grouped: Record<string, Record<string, string>> = {};

  for (const [key, rawValue] of Object.entries(env)) {
    if (typeof rawValue !== "string") continue;
    if (!key.startsWith(PREFIX)) continue;

    const rest = key.slice(PREFIX.length); // e.g. "FIELD_SERVICES__API_KEY"
    const sepIdx = rest.indexOf("__");
    if (sepIdx < 1) continue;

    const rawSlug = rest.slice(0, sepIdx);  // e.g. "FIELD_SERVICES"
    const field = rest.slice(sepIdx + 2);   // e.g. "API_KEY"
    if (!rawSlug || !field) continue;

    const slugKey = rawSlug.toLowerCase();
    if (!grouped[slugKey]) grouped[slugKey] = {};
    grouped[slugKey][field] = rawValue;
  }

  const configs: TeamConfig[] = [];

  for (const [rawSlugKey, fields] of Object.entries(grouped)) {
    const slug = normalizeSlug(rawSlugKey.replace(/_/g, "-"));
    if (!slug) continue;

    const apiKey = (fields.API_KEY || "").trim();
    const accessToken = (fields.ACCESS_TOKEN || "").trim();
    const teamId = (fields.TEAM_ID || "").trim();
    const teamName = (fields.TEAM_NAME || "").trim() || slug;

    if (!apiKey || !accessToken) continue;

    configs.push({
      slug,
      team_id: teamId,
      team_name: teamName,
      api_key: apiKey,
      access_token: accessToken,
      system_env_id: (fields.SYSTEM_ENV_ID || "").trim() || undefined,
      org_mode: (fields.ORG_MODE || "").trim().toLowerCase() === "true",
    });
  }

  return configs;
}

/**
 * Seed TEAM_REGISTRY KV from POSTMAN_TEAM__* env vars.
 * Upserts every team parsed from env. Returns the list of seeded slugs.
 */
export async function seedTeamsFromEnv(
  kv: KVNamespace,
  env: Record<string, unknown>,
): Promise<string[]> {
  const teams = parseTeamConfigsFromEnv(env);
  const seeded: string[] = [];
  for (const team of teams) {
    if (!team.team_id) {
      try {
        const profile = await fetchApiKeyProfile(team.api_key);
        if (profile.team_id) {
          team.team_id = profile.team_id;
          if (!team.team_name || team.team_name === team.slug) {
            team.team_name = profile.team_name || team.team_name;
          }
        }
      } catch (apiKeyErr) {
        try {
          const profile = await discoverIdentityProfileFromAccessToken(team.access_token);
          if (profile.team_id) {
            team.team_id = profile.team_id;
            if (!team.team_name || team.team_name === team.slug) {
              team.team_name = profile.team_name || team.team_name;
            }
          }
        } catch (tokenErr) {
          console.warn(`[seed] ${team.slug}: could not resolve team_id (api_key: ${apiKeyErr instanceof Error ? apiKeyErr.message : String(apiKeyErr)}, token: ${tokenErr instanceof Error ? tokenErr.message : String(tokenErr)})`);
        }
      }
    }
    if (team.team_id) {
      await putTeam(kv, team);
      seeded.push(team.slug);
    }
  }
  return seeded;
}
