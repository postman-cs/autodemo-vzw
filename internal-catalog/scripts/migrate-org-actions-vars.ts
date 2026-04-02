/* eslint-disable no-console */

const API = "https://api.github.com";
const DEFAULT_ORG = "postman-cs";
const DEFAULT_REPO_PREFIX = "af-";
const DEFAULT_VAR_NAMES = [
  "ECS_CLUSTER_NAME",
  "ECS_VPC_ID",
  "ECS_SUBNET_IDS",
  "ECS_SECURITY_GROUP_IDS",
  "K8S_NAMESPACE",
  "K8S_INGRESS_BASE_DOMAIN",
  "K8S_CONTEXT",
  "POSTMAN_INSIGHTS_CLUSTER_NAME",
  "ECS_ALB_LISTENER_ARN",
  "ECS_EXECUTION_ROLE_ARN",
  "ECS_TASK_ROLE_ARN",
  "ECS_ECR_REPOSITORY",
  "ECS_ALB_DNS_NAME",
  "ECS_MAX_SERVICES",
];

interface RepoInfo {
  id: number;
  name: string;
  full_name: string;
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

async function upsertOrgVariable(token: string, org: string, name: string, value: string, selectedRepositoryIds: number[]): Promise<void> {
  const patch = await fetch(`${API}/orgs/${org}/actions/variables/${name}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      value,
      visibility: "selected",
      selected_repository_ids: selectedRepositoryIds,
    }),
  });

  if (patch.ok) return;

  const create = await fetch(`${API}/orgs/${org}/actions/variables`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      value,
      visibility: "selected",
      selected_repository_ids: selectedRepositoryIds,
    }),
  });

  if (!create.ok) {
    const text = await create.text();
    throw new Error(`Failed to upsert org variable ${name}: ${create.status} ${text}`);
  }
}

async function migrateOrgVariables(): Promise<void> {
  const org = argValue("--org") || DEFAULT_ORG;
  const repoPrefix = argValue("--repo-prefix") || DEFAULT_REPO_PREFIX;
  const token = String(process.env.GH_ADMIN_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  const dryRun = hasFlag("--dry-run");
  const rollback = hasFlag("--rollback");
  const variableNames = parseCsv(argValue("--vars"));
  const targetVariableNames = variableNames.length > 0 ? variableNames : [...DEFAULT_VAR_NAMES];

  if (!token) {
    throw new Error("GH_ADMIN_TOKEN or GITHUB_TOKEN or GH_TOKEN is required");
  }

  const repos = await listTargetRepos(token, org, repoPrefix);
  if (repos.length === 0) {
    throw new Error(`No repositories found for ${org} with prefix ${repoPrefix}`);
  }

  const selectedRepositoryIds = repos.map((repo) => repo.id);
  console.log(`[org-vars] target org=${org} prefix=${repoPrefix} repos=${repos.length}`);

  if (rollback) {
    console.log("[org-vars] rollback mode: setting ORG_VARS_ENABLED=false on target repos");
    for (const repo of repos) {
      if (dryRun) {
        console.log(`[dry-run] repo variable ${repo.full_name}: ORG_VARS_ENABLED=false`);
        continue;
      }
      await upsertRepoVariable(token, org, repo.name, "ORG_VARS_ENABLED", "false");
      console.log(`[org-vars] rollback flag set: ${repo.full_name}`);
    }
    return;
  }

  for (const varName of targetVariableNames) {
    const varValue = String(process.env[varName] || "").trim();
    if (!varValue) {
      console.warn(`[org-vars] skipping ${varName}: value not set in environment`);
      continue;
    }

    if (dryRun) {
      console.log(`[dry-run] upsert org variable ${varName} (repos=${selectedRepositoryIds.length})`);
      continue;
    }

    await upsertOrgVariable(token, org, varName, varValue, selectedRepositoryIds);
    console.log(`[org-vars] upserted ${varName}`);
  }

  for (const repo of repos) {
    if (dryRun) {
      console.log(`[dry-run] repo variable ${repo.full_name}: ORG_VARS_ENABLED=true`);
      continue;
    }
    await upsertRepoVariable(token, org, repo.name, "ORG_VARS_ENABLED", "true");
  }

  console.log("[org-vars] completed");
}

migrateOrgVariables().catch((err) => {
  console.error(`[org-vars] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
