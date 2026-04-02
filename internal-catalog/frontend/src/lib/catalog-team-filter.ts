import type { TeamRegistryEntry } from "./types";

function normalize(value: string | null | undefined): string {
  return (value || "").trim();
}

export function normalizeCatalogTeamSlug(
  selectedTeamSlug: string | null | undefined,
  teams: TeamRegistryEntry[],
): string {
  const normalized = normalize(selectedTeamSlug);
  if (!normalized) return "";
  return teams.some((team) => team.slug === normalized) ? normalized : "";
}

export function matchesCatalogTeam(
  selectedTeamSlug: string,
  entryTeamSlug?: string,
): boolean {
  const selected = normalize(selectedTeamSlug);
  if (!selected) return true;
  return normalize(entryTeamSlug) === selected;
}

export function resolveCatalogTeamLabel(
  teamSlug: string | undefined,
  teams: TeamRegistryEntry[],
): string {
  const normalized = normalize(teamSlug);
  if (!normalized) return "";
  return teams.find((team) => team.slug === normalized)?.team_name || normalized;
}