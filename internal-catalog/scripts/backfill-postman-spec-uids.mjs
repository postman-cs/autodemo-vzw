#!/usr/bin/env node

/**
 * Backfill missing `postman_spec_uid` values in Airtable Deployments records
 * by reading POSTMAN_SPEC_UID from each provisioned GitHub repository variable.
 *
 * Usage:
 *   node scripts/backfill-postman-spec-uids.mjs            # dry-run
 *   node scripts/backfill-postman-spec-uids.mjs --apply    # write updates
 *
 * Required env:
 *   GH_TOKEN, AIRTABLE_API_KEY, AIRTABLE_BASE_ID
 *
 * Optional env:
 *   GITHUB_ORG (default: postman-cs)
 */

const GH_TOKEN = (process.env.GH_TOKEN || "").trim();
const AIRTABLE_API_KEY = (process.env.AIRTABLE_API_KEY || "").trim();
const AIRTABLE_BASE_ID = (process.env.AIRTABLE_BASE_ID || "").trim();
const GITHUB_ORG = (process.env.GITHUB_ORG || "postman-cs").trim();
const APPLY = process.argv.includes("--apply");

if (!GH_TOKEN || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error("Missing required env vars. Required: GH_TOKEN, AIRTABLE_API_KEY, AIRTABLE_BASE_ID");
  process.exit(1);
}

const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Deployments`;

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function airtableFetch(path = "", options = {}) {
  return fetch(`${AIRTABLE_API}${path}`, {
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

async function readGitHubVariable(repo, variable) {
  const url = `https://api.github.com/repos/${encodeURIComponent(GITHUB_ORG)}/${encodeURIComponent(repo)}/actions/variables/${encodeURIComponent(variable)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "catalog-admin-worker",
    },
  });

  if (response.status === 404) return "";
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub variable lookup failed for ${repo}/${variable} (${response.status}): ${body}`);
  }

  const data = await response.json();
  return readString(data.value);
}

async function updateDeployment(recordId, fields) {
  const response = await airtableFetch(`/${encodeURIComponent(recordId)}`, {
    method: "PATCH",
    body: { fields },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Airtable update failed for ${recordId} (${response.status}): ${body}`);
  }
}

function deploymentRepoName(fields) {
  return readString(fields.github_repo_name) || readString(fields.spec_id);
}

async function main() {
  console.log(`Backfill mode: ${APPLY ? "apply" : "dry-run"}`);
  console.log(`GitHub org: ${GITHUB_ORG}`);

  const all = await listDeployments();
  const candidates = all.filter((record) => {
    const fields = record.fields || {};
    const status = readString(fields.status).toLowerCase();
    const specUid = readString(fields.postman_spec_uid);
    return status === "active" && !specUid;
  });

  console.log(`Active records missing postman_spec_uid: ${candidates.length}`);

  const summary = {
    total: candidates.length,
    checked: 0,
    foundInGitHub: 0,
    updated: 0,
    skippedMissingRepo: 0,
    skippedMissingVar: 0,
    failed: 0,
  };

  for (const record of candidates) {
    summary.checked += 1;
    const fields = record.fields || {};
    const specId = readString(fields.spec_id) || record.id;
    const repoName = deploymentRepoName(fields);

    if (!repoName) {
      summary.skippedMissingRepo += 1;
      console.log(`[skip] ${specId} (${record.id}) -> missing github_repo_name/spec_id`);
      continue;
    }

    try {
      const specUid = await readGitHubVariable(repoName, "POSTMAN_SPEC_UID");
      if (!specUid) {
        summary.skippedMissingVar += 1;
        console.log(`[skip] ${specId} (${repoName}) -> POSTMAN_SPEC_UID not set`);
        continue;
      }

      summary.foundInGitHub += 1;
      if (APPLY) {
        await updateDeployment(record.id, { postman_spec_uid: specUid });
        summary.updated += 1;
        console.log(`[update] ${specId} (${repoName}) -> postman_spec_uid=${specUid}`);
      } else {
        console.log(`[dry-run] ${specId} (${repoName}) -> would set postman_spec_uid=${specUid}`);
      }
    } catch (err) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[error] ${specId} (${repoName}) -> ${message}`);
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
