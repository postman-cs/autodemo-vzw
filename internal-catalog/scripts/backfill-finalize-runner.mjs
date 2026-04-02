#!/usr/bin/env node

/**
 * Backfill finalize runner hardening in existing provision.yml workflows.
 *
 * Enforces in finalize job:
 *   - runs-on: ubuntu-latest
 *   - timeout-minutes: 4
 *
 * Usage:
 *   node scripts/backfill-finalize-runner.mjs                      # dry-run
 *   node scripts/backfill-finalize-runner.mjs --apply              # write updates
 *   node scripts/backfill-finalize-runner.mjs --include-repo af-core-ledger
 *   node scripts/backfill-finalize-runner.mjs --apply --include-repo af-core-ledger --include-repo af-cards-3ds
 *
 * Required env:
 *   GH_TOKEN, AIRTABLE_API_KEY, AIRTABLE_BASE_ID
 *
 * Optional env:
 *   GITHUB_ORG (default: postman-cs)
 */

const API = "https://api.github.com";
const WORKFLOW_PATH = ".github/workflows/provision.yml";

const GH_TOKEN = (process.env.GH_TOKEN || "").trim();
const AIRTABLE_API_KEY = (process.env.AIRTABLE_API_KEY || "").trim();
const AIRTABLE_BASE_ID = (process.env.AIRTABLE_BASE_ID || "").trim();
const GITHUB_ORG = (process.env.GITHUB_ORG || "postman-cs").trim();
const APPLY = process.argv.includes("--apply");
const INCLUDE_REPOS = parseMultiArg("--include-repo");

if (!GH_TOKEN || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error("Missing required env vars. Required: GH_TOKEN, AIRTABLE_API_KEY, AIRTABLE_BASE_ID");
  process.exit(1);
}

const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Deployments`;

function parseMultiArg(flag) {
  const values = [];
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] !== flag) continue;
    const next = String(process.argv[i + 1] || "").trim();
    if (!next || next.startsWith("--")) continue;
    values.push(next);
    i += 1;
  }
  return values;
}

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function repoNameFromFields(fields) {
  return readString(fields.github_repo_name) || readString(fields.spec_id);
}

async function airtableFetch(pathSuffix = "", options = {}) {
  return fetch(`${AIRTABLE_API}${pathSuffix}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

async function listDeployments() {
  const records = [];
  let offset = "";
  do {
    const qs = new URLSearchParams();
    if (offset) qs.set("offset", offset);
    const response = await airtableFetch(`?${qs.toString()}`);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Airtable list failed (${response.status}): ${body}`);
    }
    const data = await response.json();
    records.push(...(data.records || []));
    offset = data.offset || "";
  } while (offset);
  return records;
}

async function gh(path, options = {}) {
  return fetch(`${API}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "catalog-admin-worker",
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

async function readProvisionWorkflow(repo) {
  const path = `/repos/${encodeURIComponent(GITHUB_ORG)}/${encodeURIComponent(repo)}/contents/${WORKFLOW_PATH}`;
  const response = await gh(path, { method: "GET" });

  if (response.status === 404) return { status: "missing" };
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub GET ${repo}/${WORKFLOW_PATH} failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  const sha = readString(data.sha);
  const encoded = readString(data.content).replace(/\n/g, "");
  const content = Buffer.from(encoded, "base64").toString("utf-8");
  return { status: "ok", sha, content };
}

async function writeProvisionWorkflow(repo, sha, content) {
  const path = `/repos/${encodeURIComponent(GITHUB_ORG)}/${encodeURIComponent(repo)}/contents/${WORKFLOW_PATH}`;
  const response = await gh(path, {
    method: "PUT",
    body: {
      message: "chore: harden finalize runner selection",
      content: Buffer.from(content, "utf-8").toString("base64"),
      sha,
      branch: "main",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub PUT ${repo}/${WORKFLOW_PATH} failed (${response.status}): ${body}`);
  }
}

function patchFinalizeRunner(workflow) {
  const hasTrailingNewline = workflow.endsWith("\n");
  const lines = workflow.split(/\r?\n/);

  const finalizeStart = lines.findIndex((line) => /^  finalize:\s*$/.test(line));
  if (finalizeStart < 0) return { status: "no-finalize" };

  let finalizeEnd = lines.length;
  for (let i = finalizeStart + 1; i < lines.length; i += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      finalizeEnd = i;
      break;
    }
  }

  const runsOnIndex = lines.findIndex(
    (line, idx) => idx > finalizeStart && idx < finalizeEnd && /^    runs-on:\s*/.test(line)
  );
  if (runsOnIndex < 0) return { status: "no-finalize" };

  const timeoutIndexes = [];
  for (let i = finalizeStart + 1; i < finalizeEnd; i += 1) {
    if (/^    timeout-minutes:\s*/.test(lines[i])) timeoutIndexes.push(i);
  }

  const isCompliantRunner = /^    runs-on:\s*ubuntu-latest\s*$/.test(lines[runsOnIndex]);
  const isCompliantTimeout =
    timeoutIndexes.length === 1 && /^    timeout-minutes:\s*4\s*$/.test(lines[timeoutIndexes[0]]);

  if (isCompliantRunner && isCompliantTimeout) {
    return { status: "already-compliant" };
  }

  lines[runsOnIndex] = "    runs-on: ubuntu-latest";

  if (timeoutIndexes.length === 0) {
    lines.splice(runsOnIndex + 1, 0, "    timeout-minutes: 4");
  } else {
    lines[timeoutIndexes[0]] = "    timeout-minutes: 4";
    for (let i = timeoutIndexes.length - 1; i >= 1; i -= 1) {
      lines.splice(timeoutIndexes[i], 1);
    }
  }

  const updated = lines.join("\n");
  return { status: "patched", content: hasTrailingNewline ? `${updated}\n` : updated };
}

async function main() {
  console.log(`Backfill mode: ${APPLY ? "apply" : "dry-run"}`);
  console.log(`GitHub org: ${GITHUB_ORG}`);
  console.log(`Included repos: ${INCLUDE_REPOS.length > 0 ? INCLUDE_REPOS.join(", ") : "(none)"}`);

  const all = await listDeployments();
  const activeRepos = all
    .filter((record) => readString(record?.fields?.status).toLowerCase() === "active")
    .map((record) => repoNameFromFields(record.fields || {}))
    .filter(Boolean);

  const targetRepos = unique([...activeRepos, ...INCLUDE_REPOS]);
  const summary = {
    total: targetRepos.length,
    patched: 0,
    alreadyCompliant: 0,
    skippedNoWorkflow: 0,
    skippedNoFinalize: 0,
    failed: 0,
  };

  console.log(`Target repositories: ${targetRepos.length}`);

  for (const repo of targetRepos) {
    try {
      const workflow = await readProvisionWorkflow(repo);
      if (workflow.status === "missing") {
        summary.skippedNoWorkflow += 1;
        console.log(`[skip:no-workflow] ${repo}`);
        continue;
      }

      const patch = patchFinalizeRunner(workflow.content);
      if (patch.status === "no-finalize") {
        summary.skippedNoFinalize += 1;
        console.log(`[skip:no-finalize] ${repo}`);
        continue;
      }
      if (patch.status === "already-compliant") {
        summary.alreadyCompliant += 1;
        console.log(`[ok] ${repo} already compliant`);
        continue;
      }

      summary.patched += 1;
      if (APPLY) {
        await writeProvisionWorkflow(repo, workflow.sha, patch.content);
        console.log(`[patched] ${repo}`);
      } else {
        console.log(`[dry-run:patched] ${repo}`);
      }
    } catch (err) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[error] ${repo}: ${message}`);
    }
  }

  console.log("\nSummary");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});
