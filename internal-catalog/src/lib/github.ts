// GitHub API helpers for the provisioning Worker
// All calls go through the GitHub REST API v3

import nacl from "tweetnacl";
import sealedbox from "tweetnacl-sealedbox-js";
import { getCachedInstallationToken } from "./github-app-auth";

const GH_API = "https://api.github.com";
const DEFAULT_ORG = "postman-cs";
const DEFAULT_USER_AGENT = "vzw-partner-demo-worker";

// Mutable org/user-agent — set per-request from customer config
let _org = DEFAULT_ORG;
let _userAgent = DEFAULT_USER_AGENT;

// Token pool for rate limit distribution
// The primary token is always passed via function args; additional tokens
// are registered once at startup via setGitHubTokenPool().
let _tokenPool: string[] = [];

export function setGitHubTokenPool(tokens: string[]): void {
  _tokenPool = tokens.filter((t) => t.trim().length > 0).map((t) => t.trim());
}

export function getGitHubTokenPool(): string[] {
  return [..._tokenPool];
}

export function setGitHubOrg(org: string): void {
  _org = org || DEFAULT_ORG;
}

export function setGitHubUserAgent(ua: string): void {
  _userAgent = ua || DEFAULT_USER_AGENT;
}

export function getOrg(): string {
  return _org;
}

// Backward-compat alias
const ORG = DEFAULT_ORG;

interface GitHubOptions {
  token?: string;
}

interface GitHubAppAuthConfig {
  enabled: boolean;
  appId: string;
  installationId: string;
  privateKeyPem: string;
}

interface GitHubRepoResponse {
  full_name: string;
  html_url: string;
  default_branch: string;
}

interface GitHubTreeResponse {
  sha: string;
}

interface GitHubCommitResponse {
  sha: string;
  tree: { sha: string };
}

interface GitHubRefResponse {
  object: { sha: string };
}

interface GitHubKeyResponse {
  key: string;
  key_id: string;
}

interface GitHubVariablesResponse {
  variables?: Array<{ name: string; value: string }>;
}

interface GitHubSearchUsersResponse {
  total_count: number;
  items: Array<{ login: string }>;
}

interface GitHubWorkflowRunsResponse {
  total_count?: number;
  workflow_runs: Array<GitHubWorkflowRunResponse>;
}

interface GitHubWorkflowRunResponse {
  id: number;
  name?: string;
  path?: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  updated_at: string;
  event?: string;
  head_branch?: string;
  created_at?: string;
}

interface GitHubWorkflowJobsResponse {
  jobs: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    steps?: Array<{
      name: string;
      status: string;
      conclusion: string | null;
      number: number;
    }>;
  }>;
}

let _githubAppAuthConfig: GitHubAppAuthConfig = {
  enabled: false,
  appId: "",
  installationId: "",
  privateKeyPem: "",
};

export function setGitHubAppAuthConfig(
  config: Partial<GitHubAppAuthConfig> | null | undefined,
): void {
  if (!config) {
    _githubAppAuthConfig = { enabled: false, appId: "", installationId: "", privateKeyPem: "" };
    return;
  }
  _githubAppAuthConfig = {
    enabled: Boolean(config.enabled),
    appId: String(config.appId || "").trim(),
    installationId: String(config.installationId || "").trim(),
    privateKeyPem: String(config.privateKeyPem || "").trim(),
  };
}

async function resolvePrimaryToken(fallbackToken: string): Promise<string> {
  if (!_githubAppAuthConfig.enabled) {
    return normalizeGitHubToken(fallbackToken);
  }

  const { appId, installationId, privateKeyPem } = _githubAppAuthConfig;
  if (!appId || !installationId || !privateKeyPem) {
    console.warn("[github] GITHUB_APP_AUTH_ENABLED=true but app auth config is incomplete; falling back to GH token");
    return normalizeGitHubToken(fallbackToken);
  }

  try {
    return await getCachedInstallationToken(appId, installationId, privateKeyPem);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[github] Failed to resolve GitHub App installation token (${message}); falling back to GH token`);
    return normalizeGitHubToken(fallbackToken);
  }
}

export function normalizeGitHubToken(token: string | null | undefined): string {
  const normalized = (token ?? "").trim();
  if (!normalized) {
    throw new Error("GH_TOKEN is missing or empty after trimming whitespace");
  }
  return normalized;
}

// Maximum retries for GitHub API rate limit responses (403 rate limit + 429)
const RATE_LIMIT_MAX_RETRIES = 5;
const RATE_LIMIT_BASE_DELAY_MS = 10_000;
const RATE_LIMIT_MAX_DELAY_MS = 120_000;
const workflowPollCache = new Map<string, { etag: string; data: unknown }>();

export function clearWorkflowPollCache(): void {
  workflowPollCache.clear();
}

export interface WorkflowRunSummary {
  id: number;
  name: string;
  path: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  updated_at: string;
  event: string;
  head_branch: string;
  created_at: string;
}

const REPO_CREATE_CONFLICT_RETRY_ATTEMPTS = 3;
const REPO_CREATE_CONFLICT_RETRY_DELAY_MS = 250;
const APPEND_COMMIT_MAX_ATTEMPTS = 5;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRepoCreateConflictResponse(status: number, parsedBody: Record<string, unknown> | null, rawBody: string): boolean {
  if (status !== 409 && status !== 422) return false;

  const messages = new Set<string>();
  if (typeof parsedBody?.message === "string") messages.add(parsedBody.message);
  if (Array.isArray(parsedBody?.errors)) {
    for (const entry of parsedBody.errors) {
      if (typeof entry?.message === "string") messages.add(entry.message);
      if (typeof entry?.code === "string") messages.add(entry.code);
    }
  }
  if (rawBody.trim()) messages.add(rawBody);

  const combined = [...messages].join(" ").toLowerCase();
  return combined.includes("already exists")
    || combined.includes("already been taken")
    || combined.includes("name already exists on this account")
    || combined.includes("name already exists");
}

async function getRepoAfterCreateConflict(
  token: string,
  name: string,
): Promise<{ full_name: string; html_url: string; default_branch: string } | null> {
  for (let attempt = 0; attempt < REPO_CREATE_CONFLICT_RETRY_ATTEMPTS; attempt += 1) {
    const resp = await ghFetch(`/repos/${_org}/${name}`, { token });
    if (resp.ok) {
      return await resp.json() as { full_name: string; html_url: string; default_branch: string };
    }
    if (resp.status !== 404) return null;
    if (attempt < REPO_CREATE_CONFLICT_RETRY_ATTEMPTS - 1) {
      await sleepMs(REPO_CREATE_CONFLICT_RETRY_DELAY_MS);
    }
  }
  return null;
}

async function ghFetch(
  path: string,
  opts: GitHubOptions & RequestInit & { json?: unknown }
): Promise<Response> {
  /* istanbul ignore next -- @preserve defensive: all callers use relative paths */
  const url = path.startsWith("http") ? path : `${GH_API}${path}`;
  const fallbackToken = String(opts.token || "").trim();
  const primaryToken = await resolvePrimaryToken(fallbackToken);

  // Build ordered token list: primary first, then pool, then fallback token.
  const tokenSet = new Set<string>();
  tokenSet.add(primaryToken);
  for (const token of _tokenPool) {
    if (token && token !== primaryToken) tokenSet.add(token);
  }
  if (fallbackToken && fallbackToken !== primaryToken) {
    tokenSet.add(fallbackToken);
  }
  const tokens = [...tokenSet];

  for (let tokenIdx = 0; tokenIdx < tokens.length; tokenIdx++) {
    const currentToken = tokens[tokenIdx];
    const headers: Record<string, string> = {
      Authorization: `Bearer ${currentToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": _userAgent,
    };
    if (opts.json) headers["Content-Type"] = "application/json";

    const fetchOpts: RequestInit = {
      method: opts.method || "GET",
      headers: { ...headers, ...(opts.headers as Record<string, string>) },
      body: opts.json ? JSON.stringify(opts.json) : opts.body,
    };

    for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
      const resp = await fetch(url, fetchOpts);

      // Not a rate-limit candidate -- return immediately
      if (resp.status !== 403 && resp.status !== 429) return resp;

      // 429 is always a rate limit; for 403, verify via headers or body
      if (resp.status === 403) {
        const remaining = resp.headers.get("x-ratelimit-remaining");
        const retryAfter = resp.headers.get("retry-after");
        if (remaining !== "0" && !retryAfter) {
          const clone = resp.clone();
          const body = await clone.text().catch(() => "");
          if (!body.toLowerCase().includes("rate limit")) {
            return resp; // Not a rate limit (e.g. permission denied)
          }
        }
      }

      // If there are more tokens to try, skip to the next token immediately
      if (tokenIdx < tokens.length - 1) {
        console.warn(
          `GitHub rate limit on token ${tokenIdx + 1}/${tokens.length}, ` +
          `rotating to next token: ${opts.method || "GET"} ${path}`
        );
        break; // Break retry loop, continue to next token
      }

      // Last token, exhausted retries -- return the rate-limited response
      if (attempt === RATE_LIMIT_MAX_RETRIES) return resp;

      // Calculate wait time from response headers or use exponential backoff
      const waitMs = rateLimitWaitMs(resp, attempt);
      console.warn(
        `GitHub rate limit hit (attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES}), ` +
        `waiting ${Math.round(waitMs / 1000)}s: ${opts.method || "GET"} ${path}`
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  /* istanbul ignore next -- @preserve unreachable after loops */
  return fetch(url, { method: opts.method || "GET" });
}

function rateLimitWaitMs(resp: Response, attempt: number): number {
  // Prefer Retry-After header (secondary rate limits)
  const retryAfter = resp.headers.get("retry-after");
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, RATE_LIMIT_MAX_DELAY_MS);
    }
  }

  // Use x-ratelimit-reset header (primary rate limits)
  const resetHeader = resp.headers.get("x-ratelimit-reset");
  if (resetHeader) {
    const resetEpochMs = parseInt(resetHeader, 10) * 1000;
    const delta = resetEpochMs - Date.now();
    if (delta > 0) {
      return Math.min(delta + 1000, RATE_LIMIT_MAX_DELAY_MS);
    }
  }

  // Fallback: exponential backoff (10s, 20s, 40s, 80s, 120s)
  return Math.min(RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt), RATE_LIMIT_MAX_DELAY_MS);
}

async function ghFetchCachedJson<T>(path: string, token: string): Promise<T | null> {
  const cached = workflowPollCache.get(path);
  const resp = await ghFetch(path, {
    token,
    headers: cached?.etag ? { "If-None-Match": cached.etag } : undefined,
  });
  if (resp.status === 304) {
    return (cached?.data as T | undefined) ?? null;
  }
  if (!resp.ok) return null;
  const data = (await resp.json()) as T;
  const etag = String(resp.headers.get("etag") || "").trim();
  if (etag) workflowPollCache.set(path, { etag, data });
  else workflowPollCache.delete(path);
  return data;
}

const CREATE_REPO_5XX_MAX_ATTEMPTS = 3;
const CREATE_REPO_5XX_BASE_DELAY_MS = 2000;

export async function createRepo(
  token: string,
  name: string,
  description: string
): Promise<{ full_name: string; html_url: string; default_branch: string }> {
  let repo: { full_name: string; html_url: string; default_branch: string } | null = null;

  for (let attempt = 0; attempt < CREATE_REPO_5XX_MAX_ATTEMPTS; attempt++) {
    const resp = await ghFetch(`/orgs/${_org}/repos`, {
      token,
      method: "POST",
      json: {
        name,
        description,
        private: true,
        auto_init: true,
        has_issues: true,
        has_projects: false,
        has_wiki: false,
      },
    });

    if (resp.ok) {
      repo = await resp.json() as GitHubRepoResponse;
      break;
    }

    const rawBody = await resp.text().catch(() => "");

    // Retry only on 5xx (502, 503, 504, etc.); do not retry on 4xx
    const is5xx = resp.status >= 500 && resp.status < 600;
    if (is5xx && attempt < CREATE_REPO_5XX_MAX_ATTEMPTS - 1) {
      const waitMs = CREATE_REPO_5XX_BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(
        `GitHub create repo ${name} returned ${resp.status} (attempt ${attempt + 1}/${CREATE_REPO_5XX_MAX_ATTEMPTS}), retrying in ${Math.round(waitMs / 1000)}s`
      );
      await sleepMs(waitMs);
      continue;
    }

    // Non-retryable or exhausted retries: handle error
    let message = `HTTP ${resp.status}`;
    let parsedBody: Record<string, unknown> | null = null;
    if (rawBody.trim()) {
      try {
        parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        parsedBody = null;
      }
    }

    if (isRepoCreateConflictResponse(resp.status, parsedBody, rawBody)) {
      repo = await getRepoAfterCreateConflict(token, name);
    }

    if (!repo) {
      if (typeof parsedBody?.message === "string" && parsedBody.message.trim()) {
        message = parsedBody.message.trim();
      } else if (rawBody.trim()) {
        message = rawBody.trim();
      }
      const hint = resp.status === 401
        ? " (check GH_TOKEN value/scope and strip trailing whitespace/newlines)"
        : "";
      throw new Error(`Failed to create repo: ${message}${hint}`);
    }
    break;
  }

  if (!repo) {
    throw new Error("Failed to create repo: unexpected state (repo is null)");
  }

  // Tag the repo with vzw-partner-demo for easy filtering
  try {
    await ghFetch(`/repos/${_org}/${name}/topics`, {
      token,
      method: "PUT",
      json: { names: ["vzw-partner-demo"] },
    });
  } catch {
    // Non-fatal: topic tagging can fail without blocking provisioning
  }

  return repo;
}

export async function repoExists(token: string, name: string): Promise<boolean> {
  const resp = await ghFetch(`/repos/${_org}/${name}`, { token });
  return resp.ok;
}

export async function addCollaborator(
  token: string,
  repo: string,
  username: string,
  permission = "admin"
): Promise<void> {
  const resp = await ghFetch(
    `/repos/${_org}/${repo}/collaborators/${username}`,
    { token, method: "PUT", json: { permission } }
  );
  if (!resp.ok && resp.status !== 204) {
    console.warn(`Failed to add collaborator ${username}: ${resp.status}`);
  }
}

export async function lookupUser(
  token: string,
  email: string
): Promise<string | null> {
  const resp = await ghFetch(
    `/search/users?q=${encodeURIComponent(email)}+in:email`,
    { token }
  );
  if (!resp.ok) return null;
  const data = (await resp.json()) as GitHubSearchUsersResponse;
  return data.total_count > 0 ? data.items[0].login : null;
}

// Retry helper for transient GitHub API failures (e.g. repo not yet ready after creation)
/* istanbul ignore next -- @preserve default params */
async function retryFetch(
  fn: () => Promise<Response>,
  label: string,
  maxRetries = 3,
  baseDelay = 1000
): Promise<Response> {
  let lastResp: Response | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fn();
    if (resp.ok) return resp;
    lastResp = resp;
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, baseDelay * Math.pow(2, attempt)));
    }
  }
  const body = await lastResp!.text().catch(() => "");
  throw new Error(`${label}: ${lastResp!.status} ${body}`.trim());
}

// Push a full tree in one commit via the Git Data API
export async function pushTree(
  token: string,
  repo: string,
  files: { path: string; content: string }[],
  message: string,
  branch = "main",
  retryDelay = 1000
): Promise<string> {
  // Pass content inline — GitHub creates blobs automatically (saves N blob calls)
  const tree = files.map((file) => ({
    path: file.path,
    mode: "100644" as const,
    type: "blob" as const,
    content: file.content,
  }));

  // Create tree
  const treeResp = await retryFetch(
    () => ghFetch(`/repos/${_org}/${repo}/git/trees`, {
      token,
      method: "POST",
      json: { tree },
    }),
    "Failed to create tree",
    3,
    retryDelay
  );
  const treeData = (await treeResp.json()) as GitHubTreeResponse;

  // Create commit (no parent = initial commit)
  const commitResp = await ghFetch(`/repos/${_org}/${repo}/git/commits`, {
    token,
    method: "POST",
    json: { message, tree: treeData.sha },
  });
  if (!commitResp.ok) throw new Error("Failed to create commit");
  const commit = (await commitResp.json()) as GitHubCommitResponse;

  // Create ref (main branch)
  const refResp = await ghFetch(`/repos/${_org}/${repo}/git/refs`, {
    token,
    method: "POST",
    json: { ref: `refs/heads/${branch}`, sha: commit.sha },
  });
  if (!refResp.ok) throw new Error("Failed to create ref");

  return commit.sha;
}

// Append a commit to an existing branch
export async function appendCommit(
  token: string,
  repo: string,
  files: { path: string; content: string }[],
  message: string,
  branch = "main",
  retryDelay = 1000
): Promise<string> {
  for (let attempt = 0; attempt < APPEND_COMMIT_MAX_ATTEMPTS; attempt += 1) {
    // Get current ref
    const refResp = await ghFetch(
      `/repos/${_org}/${repo}/git/refs/heads/${branch}`,
      { token }
    );
    if (!refResp.ok) {
      if (attempt < APPEND_COMMIT_MAX_ATTEMPTS - 1 && (refResp.status === 404 || refResp.status === 409 || refResp.status >= 500)) {
        await sleepMs(retryDelay * Math.pow(2, attempt));
        continue;
      }
      throw new Error(`Failed to get ref: ${refResp.status}`);
    }
    const refData = (await refResp.json()) as GitHubRefResponse;
    const parentSha = refData.object.sha;

    // Get parent commit's tree
    const parentCommitResp = await ghFetch(
      `/repos/${_org}/${repo}/git/commits/${parentSha}`,
      { token }
    );
    if (!parentCommitResp.ok) {
      if (attempt < APPEND_COMMIT_MAX_ATTEMPTS - 1 && (parentCommitResp.status === 404 || parentCommitResp.status >= 500)) {
        await sleepMs(retryDelay * Math.pow(2, attempt));
        continue;
      }
      throw new Error(`Failed to get parent commit: ${parentCommitResp.status}`);
    }
    const parentCommit = (await parentCommitResp.json()) as GitHubCommitResponse;

    // Pass content inline — GitHub creates blobs automatically (saves N blob calls)
    const tree = files.map((file) => ({
      path: file.path,
      mode: "100644" as const,
      type: "blob" as const,
      content: file.content,
    }));

    // Create tree with base (retry on transient failures -- repo may still be initializing)
    const treeResp = await ghFetch(`/repos/${_org}/${repo}/git/trees`, {
      token,
      method: "POST",
      json: { base_tree: parentCommit.tree.sha, tree },
    });
    if (!treeResp.ok) {
      const treeBody = await treeResp.text().catch(() => "");
      if (attempt < APPEND_COMMIT_MAX_ATTEMPTS - 1 && (treeResp.status === 409 || treeResp.status >= 500)) {
        await sleepMs(retryDelay * Math.pow(2, attempt));
        continue;
      }
      throw new Error(`Failed to create tree: ${treeResp.status} ${treeBody}`.trim());
    }
    const treeData = (await treeResp.json()) as GitHubTreeResponse;

    // Create commit
    const commitResp = await ghFetch(`/repos/${_org}/${repo}/git/commits`, {
      token,
      method: "POST",
      json: { message, tree: treeData.sha, parents: [parentSha] },
    });
    if (!commitResp.ok) {
      const commitBody = await commitResp.text().catch(() => "");
      throw new Error(`Failed to create commit: ${commitResp.status} ${commitBody}`.trim());
    }
    const commit = (await commitResp.json()) as GitHubCommitResponse;

    // Update ref
    const updateResp = await ghFetch(
      `/repos/${_org}/${repo}/git/refs/heads/${branch}`,
      { token, method: "PATCH", json: { sha: commit.sha } }
    );
    if (updateResp.ok) {
      return commit.sha;
    }
    if (attempt < APPEND_COMMIT_MAX_ATTEMPTS - 1 && (updateResp.status === 409 || updateResp.status === 422)) {
      await sleepMs(retryDelay * Math.pow(2, attempt));
      continue;
    }
    throw new Error(`Failed to update ref: ${updateResp.status}`);
  }

  throw new Error("Failed to update ref");
}

async function getBranchHeadSha(
  token: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  const refResp = await ghFetch(
    `/repos/${_org}/${repo}/git/refs/heads/${branch}`,
    { token },
  );
  if (!refResp.ok) return null;
  const refData = (await refResp.json()) as Partial<GitHubRefResponse>;
  return String(refData?.object?.sha || "").trim() || null;
}

export async function createBranchIfMissing(
  token: string,
  repo: string,
  branch: string,
  fromBranch = "main",
): Promise<"created" | "exists" | "skipped"> {
  const normalizedBranch = String(branch || "").trim().replace(/^refs\/heads\//, "");
  if (!normalizedBranch) return "skipped";

  const existingHead = await getBranchHeadSha(token, repo, normalizedBranch);
  if (existingHead) return "exists";

  const sourceHead = await getBranchHeadSha(token, repo, fromBranch);
  if (!sourceHead) {
    throw new Error(`Failed to resolve source branch head: ${fromBranch}`);
  }

  const createResp = await ghFetch(`/repos/${_org}/${repo}/git/refs`, {
    token,
    method: "POST",
    json: { ref: `refs/heads/${normalizedBranch}`, sha: sourceHead },
  });

  if (createResp.ok) return "created";

  // Idempotent create: GitHub returns 422 when branch already exists.
  if (createResp.status === 422) return "exists";

  const body = await createResp.text().catch(() => "");
  throw new Error(`Failed to create branch ${normalizedBranch}: ${createResp.status} ${body}`.trim());
}

// Encrypt a secret value using the repo's public key (libsodium sealed box via BLAKE2b)
export function encryptSecret(publicKeyB64: string, secretValue: string): string {
  const publicKey = Uint8Array.from(atob(publicKeyB64), (c) => c.charCodeAt(0));
  const messageBytes = new TextEncoder().encode(secretValue);
  const sealed = sealedbox.seal(messageBytes, publicKey);
  return btoa(String.fromCharCode(...sealed));
}

// Per-run cache for repo public keys (avoids re-fetching per secret)
const _repoPublicKeyCache = new Map<string, { key: string; key_id: string; fetchedAt: number }>();
const PUBLIC_KEY_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function clearRepoPublicKeyCache(): void {
  _repoPublicKeyCache.clear();
}

async function getRepoPublicKey(
  token: string,
  repo: string,
  forceRefresh = false
): Promise<{ key: string; key_id: string }> {
  const cacheKey = `${_org}/${repo}`;
  const cached = _repoPublicKeyCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < PUBLIC_KEY_CACHE_TTL_MS) {
    return { key: cached.key, key_id: cached.key_id };
  }
  const keyResp = await ghFetch(
    `/repos/${_org}/${repo}/actions/secrets/public-key`,
    { token }
  );
  if (!keyResp.ok) throw new Error("Failed to get repo public key");
  const keyData = (await keyResp.json()) as GitHubKeyResponse;
  _repoPublicKeyCache.set(cacheKey, { key: keyData.key, key_id: keyData.key_id, fetchedAt: Date.now() });
  return { key: keyData.key, key_id: keyData.key_id };
}

async function putRepoSecret(
  token: string,
  repo: string,
  name: string,
  encryptedValue: string,
  keyId: string
): Promise<Response> {
  return ghFetch(
    `/repos/${_org}/${repo}/actions/secrets/${name}`,
    {
      token,
      method: "PUT",
      json: {
        encrypted_value: encryptedValue,
        key_id: keyId,
      },
    }
  );
}

export async function createRepoSecrets(
  token: string,
  repo: string,
  secrets: Record<string, string>
): Promise<Record<string, string>> {
  const failures: Record<string, string> = {};
  const entries = Object.entries(secrets).filter(([name, value]) => Boolean(name) && Boolean(value));
  if (entries.length === 0) return failures;

  let keyData = await getRepoPublicKey(token, repo);

  for (const [name, value] of entries) {
    let encryptedValue = encryptSecret(keyData.key, value);
    let resp = await putRepoSecret(token, repo, name, encryptedValue, keyData.key_id);
    if (resp.ok || resp.status === 204) continue;

    // Retry once with a refreshed key to handle key rotation.
    try {
      keyData = await getRepoPublicKey(token, repo, true);
      encryptedValue = encryptSecret(keyData.key, value);
      resp = await putRepoSecret(token, repo, name, encryptedValue, keyData.key_id);
    } catch (err) {
      failures[name] = err instanceof Error ? err.message : String(err);
      continue;
    }

    if (!resp.ok && resp.status !== 204) {
      failures[name] = `Failed to create secret ${name}: ${resp.status}`;
    }
  }

  return failures;
}

export async function createRepoSecret(
  token: string,
  repo: string,
  name: string,
  value: string
): Promise<void> {
  const failures = await createRepoSecrets(token, repo, { [name]: value });
  if (failures[name]) {
    throw new Error(failures[name]);
  }
}

export async function createRepoVariable(
  token: string,
  repo: string,
  name: string,
  value: string
): Promise<void> {
  const createResp = await ghFetch(
    `/repos/${_org}/${repo}/actions/variables`,
    { token, method: "POST", json: { name, value } }
  );
  if (createResp.ok || createResp.status === 201) return;

  if (createResp.status === 409 || createResp.status === 422) {
    const updateResp = await ghFetch(
      `/repos/${_org}/${repo}/actions/variables/${name}`,
      { token, method: "PATCH", json: { name, value } }
    );
    if (updateResp.ok || updateResp.status === 204) return;
    console.warn(`Failed to update variable ${name}: ${updateResp.status}`);
    return;
  }

  console.warn(`Failed to create variable ${name}: ${createResp.status}`);
}

export async function getRepoVariable(
  token: string,
  repo: string,
  name: string,
): Promise<string> {
  const resp = await ghFetch(
    `/repos/${_org}/${repo}/actions/variables/${name}`,
    { token, method: "GET" },
  );
  if (resp.status === 404) return "";
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Failed to fetch variable ${name}: ${resp.status} ${text}`.trim());
  }
  const data = (await resp.json()) as { value?: string };
  return String(data.value || "");
}

// Fetch all repo variables in bulk (paginated, max 30 per page)
export async function listRepoVariables(
  token: string,
  repo: string
): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};
  let page = 1;
  while (true) {
    const resp = await ghFetch(
      `/repos/${_org}/${repo}/actions/variables?per_page=30&page=${page}`,
      { token }
    );
    if (!resp.ok) break;
    const data = (await resp.json()) as GitHubVariablesResponse;
    for (const v of data.variables || []) {
      vars[v.name] = v.value;
    }
    if ((data.variables || []).length < 30) break;
    page++;
  }
  return vars;
}

export async function triggerWorkflow(
  token: string,
  repo: string,
  workflow: string,
  inputs: Record<string, string>,
  ref = "main"
): Promise<void> {
  const resp = await ghFetch(
    `/repos/${_org}/${repo}/actions/workflows/${workflow}/dispatches`,
    { token, method: "POST", json: { ref, inputs } }
  );
  if (!resp.ok && resp.status !== 204) {
    const err = await resp.text();
    throw new Error(`Failed to trigger workflow: ${err}`);
  }
}

export async function getLatestWorkflowRun(
  token: string,
  repo: string,
  workflow: string
): Promise<{ id: number; status: string; conclusion: string | null; html_url: string; updated_at: string } | null> {
  const data = await ghFetchCachedJson<GitHubWorkflowRunsResponse>(
    `/repos/${_org}/${repo}/actions/workflows/${workflow}/runs?per_page=1`,
    token,
  );
  if (!data) return null;
  if (data.total_count === 0) return null;
  const run = data.workflow_runs[0];
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    html_url: run.html_url,
    updated_at: run.updated_at || "",
  };
}

export async function listWorkflowRuns(
  token: string,
  repo: string,
  perPage = 20,
): Promise<WorkflowRunSummary[]> {
  const pageSize = Math.min(100, Math.max(1, Math.trunc(perPage || 20)));
  const data = await ghFetchCachedJson<GitHubWorkflowRunsResponse>(
    `/repos/${_org}/${repo}/actions/runs?per_page=${pageSize}`,
    token,
  );
  if (!data || !Array.isArray(data.workflow_runs)) return [];

  return data.workflow_runs.map((run) => ({
    id: Number(run.id || 0),
    name: String(run.name || ""),
    path: String(run.path || ""),
    status: String(run.status || ""),
    conclusion: run.conclusion === null || run.conclusion === undefined
      ? null
      : String(run.conclusion),
    html_url: String(run.html_url || ""),
    updated_at: String(run.updated_at || ""),
    event: String(run.event || ""),
    head_branch: String(run.head_branch || ""),
    created_at: String(run.created_at || ""),
  }));
}

// Poll a specific run by ID (avoids list-runs after correlation)
export async function getWorkflowRunById(
  token: string,
  repo: string,
  runId: number
): Promise<{ id: number; status: string; conclusion: string | null; html_url: string; updated_at: string } | null> {
  const run = await ghFetchCachedJson<GitHubWorkflowRunResponse>(
    `/repos/${_org}/${repo}/actions/runs/${runId}`,
    token,
  );
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    html_url: run.html_url,
    updated_at: run.updated_at || "",
  };
}

export async function getWorkflowJobs(
  token: string,
  repo: string,
  runId: number
): Promise<{ name: string; status: string; conclusion: string | null; steps: { name: string; status: string; conclusion: string | null; number: number }[] }[]> {
  const data = await ghFetchCachedJson<GitHubWorkflowJobsResponse>(
    `/repos/${_org}/${repo}/actions/runs/${runId}/jobs`,
    token,
  );
  if (!data) return [];
  return data.jobs.map((j) => ({
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    steps: (j.steps || []).map((s) => ({
      name: s.name,
      status: s.status,
      conclusion: s.conclusion,
      number: s.number,
    })),
  }));
}

export async function deleteRepo(
  token: string,
  repo: string
): Promise<void> {
  const resp = await ghFetch(`/repos/${_org}/${repo}`, { token, method: "DELETE" });
  if (resp.status === 200 || resp.status === 204 || resp.status === 404) return;

  let message = `HTTP ${resp.status}`;
  try {
    const err = await resp.json() as { message?: string };
    if (typeof err?.message === "string" && err.message.trim()) {
      message = err.message.trim();
    }
  } catch {
    const text = await resp.text().catch(() => "");
    if (text.trim()) {
      message = text.trim();
    }
  }

  const hint = resp.status === 403
    ? " (GH_TOKEN requires repo delete permissions)"
    : "";
  throw new Error(`Failed to delete repo ${_org}/${repo}: ${message}${hint}`);
}

export {
  ORG,
  GH_API,
  retryFetch,
  RATE_LIMIT_MAX_RETRIES,
  RATE_LIMIT_BASE_DELAY_MS,
  rateLimitWaitMs,
};
