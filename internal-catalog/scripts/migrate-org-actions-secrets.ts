/* eslint-disable no-console */
import sealedbox from "tweetnacl-sealedbox-js";

const API = "https://api.github.com";
const DEFAULT_ORG = "postman-cs";
const DEFAULT_REPO_PREFIX = "af-";
const DEFAULT_SECRET_NAMES = [
  "POSTMAN_API_KEY",
  "POSTMAN_ACCESS_TOKEN",
  "KUBECONFIG_B64",
  "FERN_TOKEN",
  "GH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_LAMBDA_ROLE_ARN",
];

interface RepoInfo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
}

function argValue(flag: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parseCsv(input: string): string[] {
  return String(input || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function gh<T>(token: string, path: string, method = "GET", body?: unknown): Promise<T> {
  const resp = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`${method} ${path} -> ${resp.status} ${text}`);
  }
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

function b64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function bytesToB64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

async function listTargetRepos(token: string, org: string, repoPrefix: string): Promise<RepoInfo[]> {
  const repos: RepoInfo[] = [];
  let page = 1;
  while (true) {
    const batch = await gh<RepoInfo[]>(token, `/orgs/${org}/repos?type=private&per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    repos.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return repos.filter((repo) => repo.name.startsWith(repoPrefix));
}

async function upsertRepoVariable(token: string, org: string, repo: string, name: string, value: string): Promise<void> {
  const patch = await fetch(`${API}/repos/${org}/${repo}/actions/variables/${name}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, value }),
  });

  if (patch.ok) return;

  const create = await fetch(`${API}/repos/${org}/${repo}/actions/variables`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, value }),
  });

  if (!create.ok) {
    const text = await create.text();
    throw new Error(`Failed to upsert ${name} on ${repo}: ${create.status} ${text}`);
  }
}

async function migrateOrgSecrets(): Promise<void> {
  const org = argValue("--org") || DEFAULT_ORG;
  const repoPrefix = argValue("--repo-prefix") || DEFAULT_REPO_PREFIX;
  const visibility = argValue("--visibility") || "selected";
  const token = String(process.env.GH_ADMIN_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  const dryRun = hasFlag("--dry-run");
  const rollback = hasFlag("--rollback");
  const secretNames = parseCsv(argValue("--secrets"));
  const targetSecretNames = secretNames.length > 0 ? secretNames : [...DEFAULT_SECRET_NAMES];

  if (!["selected", "private", "all"].includes(visibility)) {
    throw new Error(`Invalid --visibility value: ${visibility} (must be selected, private, or all)`);
  }

  if (!token) {
    throw new Error("GH_ADMIN_TOKEN or GITHUB_TOKEN or GH_TOKEN is required");
  }

  const needsRepoList = visibility === "selected" || rollback;
  let repos: RepoInfo[] = [];
  let selectedRepositoryIds: number[] = [];

  if (needsRepoList) {
    repos = await listTargetRepos(token, org, repoPrefix);
    if (repos.length === 0) {
      throw new Error(`No repositories found for ${org} with prefix ${repoPrefix}`);
    }
    selectedRepositoryIds = repos.map((repo) => repo.id);
  }

  console.log(`[org-secrets] target org=${org} visibility=${visibility}${needsRepoList ? ` prefix=${repoPrefix} repos=${repos.length}` : ""}`);

  if (rollback) {
    console.log("[org-secrets] rollback mode: setting ORG_SECRETS_ENABLED=false on target repos");
    for (const repo of repos) {
      if (dryRun) {
        console.log(`[dry-run] repo variable ${repo.full_name}: ORG_SECRETS_ENABLED=false`);
        continue;
      }
      await upsertRepoVariable(token, org, repo.name, "ORG_SECRETS_ENABLED", "false");
      console.log(`[org-secrets] rollback flag set: ${repo.full_name}`);
    }
    return;
  }

  const key = await gh<{ key: string; key_id: string }>(token, `/orgs/${org}/actions/secrets/public-key`);
  const keyBytes = b64ToBytes(key.key);

  for (const secretName of targetSecretNames) {
    const secretValue = String(process.env[secretName] || "").trim();
    if (!secretValue) {
      console.warn(`[org-secrets] skipping ${secretName}: value not set in environment`);
      continue;
    }

    const encrypted = sealedbox.seal(new TextEncoder().encode(secretValue), keyBytes);
    const body: Record<string, unknown> = {
      encrypted_value: bytesToB64(encrypted),
      key_id: key.key_id,
      visibility,
    };
    if (visibility === "selected") {
      body.selected_repository_ids = selectedRepositoryIds;
    }

    if (dryRun) {
      console.log(`[dry-run] upsert org secret ${secretName} (visibility=${visibility}${visibility === "selected" ? ` repos=${selectedRepositoryIds.length}` : ""})`);
      continue;
    }

    await gh(token, `/orgs/${org}/actions/secrets/${secretName}`, "PUT", body);
    console.log(`[org-secrets] upserted ${secretName}`);
  }

  if (visibility === "selected") {
    for (const repo of repos) {
      if (dryRun) {
        console.log(`[dry-run] repo variable ${repo.full_name}: ORG_SECRETS_ENABLED=true`);
        continue;
      }
      await upsertRepoVariable(token, org, repo.name, "ORG_SECRETS_ENABLED", "true");
    }
  }

  console.log("[org-secrets] completed");
}

migrateOrgSecrets().catch((err) => {
  console.error(`[org-secrets] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
