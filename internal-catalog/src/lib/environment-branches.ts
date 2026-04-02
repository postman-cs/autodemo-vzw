const ENV_BRANCH_PREFIX = "env";

function normalizeSegment(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function getEnvironmentBranchName(environment: string): string {
  const slug = normalizeSegment(environment) || "prod";
  return `${ENV_BRANCH_PREFIX}/${slug}`;
}

export function getEnvironmentBranchMap(environments: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const environment of environments) {
    const normalized = normalizeSegment(environment);
    if (!normalized) continue;
    map[normalized] = getEnvironmentBranchName(normalized);
  }
  return map;
}
