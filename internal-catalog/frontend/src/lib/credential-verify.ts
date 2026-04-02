import type { TeamRegistryEntry } from "./types";

/**
 * Determines whether a team's credentials should be auto-rechecked.
 * Returns true only when:
 *   - The team exists
 *   - health_status is "unchecked" or "stale"
 *   - Both API key and access token are present
 */
export function shouldTriggerRecheck(team: TeamRegistryEntry | undefined): boolean {
  if (!team) return false;
  const status = team.health_status || "unchecked";
  if (status !== "unchecked" && status !== "stale") return false;
  if (!team.has_api_key || !team.has_access_token) return false;
  return true;
}

/**
 * Merges a health recheck result into the teams array, updating only
 * the team matching the given slug. Returns a new array (immutable).
 */
export function mergeHealthIntoTeams(
  teams: TeamRegistryEntry[],
  slug: string,
  health: { status?: string; message?: string; checked_at?: string; blocked?: boolean },
): TeamRegistryEntry[] {
  return teams.map((t) =>
    t.slug === slug
      ? {
          ...t,
          health_status: (health.status as TeamRegistryEntry["health_status"]) ?? t.health_status,
          health_message: health.message,
          health_checked_at: health.checked_at,
          provisioning_blocked: health.blocked,
        }
      : t,
  );
}
