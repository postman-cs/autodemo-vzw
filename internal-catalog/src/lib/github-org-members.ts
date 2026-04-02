import type { ProvisioningEnv as Env } from "./provisioning-env";
import { normalizeGitHubToken, getOrg } from "./github";

const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

interface GitHubCollaborator {
  id: number;
  login: string;
}

interface GitHubUserDetail {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

const REFERENCE_REPO = "vzw-partner-demo";
const CONCURRENCY = 10;

function jsonResponse(data: unknown, statusOrHeaders: number | Record<string, string> = 200, extraHeaders: Record<string, string> = {}): Response {
  const statusCode = typeof statusOrHeaders === "number" ? statusOrHeaders : 200;
  const headers = typeof statusOrHeaders === "object" ? statusOrHeaders : extraHeaders;
  return new Response(JSON.stringify(data), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

async function fetchOrgMembers(org: string, ghHeaders: Record<string, string>): Promise<GitHubCollaborator[] | null> {
  const resp = await fetch(
    `https://api.github.com/orgs/${org}/members?per_page=100`,
    { headers: ghHeaders },
  );
  if (!resp.ok) return null;
  const members = (await resp.json()) as GitHubCollaborator[];
  return members.length > 0 ? members : null;
}

async function fetchRepoCollaborators(org: string, ghHeaders: Record<string, string>): Promise<GitHubCollaborator[]> {
  const resp = await fetch(
    `https://api.github.com/repos/${org}/${REFERENCE_REPO}/collaborators?per_page=100`,
    { headers: ghHeaders },
  );
  if (!resp.ok) return [];
  return (await resp.json()) as GitHubCollaborator[];
}

async function enrichMembers(
  raw: GitHubCollaborator[],
  ghHeaders: Record<string, string>,
): Promise<Array<{ id: number; login: string; name: string; email: string }>> {
  const enriched: Array<{ id: number; login: string; name: string; email: string }> = [];

  for (let i = 0; i < raw.length; i += CONCURRENCY) {
    const batch = raw.slice(i, i + CONCURRENCY);
    const details = await Promise.all(
      batch.map(async (m) => {
        try {
          const resp = await fetch(`https://api.github.com/users/${m.login}`, {
            headers: ghHeaders,
          });
          if (!resp.ok) return { id: m.id, login: m.login, name: m.login, email: "" };
          const detail = (await resp.json()) as GitHubUserDetail;
          return {
            id: detail.id,
            login: detail.login,
            name: detail.name || detail.login,
            email: detail.email || "",
          };
        } catch {
          return { id: m.id, login: m.login, name: m.login, email: "" };
        }
      }),
    );
    enriched.push(...details);
  }

  return enriched;
}

export async function handleGitHubOrgMembers(env: Env): Promise<Response> {
  let token: string;
  try {
    token = normalizeGitHubToken(env.GH_TOKEN);
  } catch {
    return jsonResponse({ members: [], error: "GH_TOKEN not configured" }, 503);
  }

  const org = getOrg();
  const ghHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "vzw-partner-demo-worker",
  };

  try {
    let raw = await fetchOrgMembers(org, ghHeaders);
    let source: "org-members" | "repo-collaborators" = "org-members";

    if (!raw || raw.length === 0) {
      source = "repo-collaborators";
      raw = await fetchRepoCollaborators(org, ghHeaders);
    }

    if (raw.length === 0) {
      return jsonResponse({ members: [], source, error: "No members found via org members or repo collaborators" }, 502);
    }

    const enriched = await enrichMembers(raw, ghHeaders);

    return jsonResponse({ members: enriched, source }, {
      "Cache-Control": "public, max-age=300",
    });
  } catch (err) {
    console.error("Failed to fetch org members:", err);
    return jsonResponse({ members: [], error: "Failed to fetch org members" }, 502);
  }
}
