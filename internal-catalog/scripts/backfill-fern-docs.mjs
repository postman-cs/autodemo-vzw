#!/usr/bin/env node

/**
 * Backfill Fern docs for existing active deployments.
 *
 * For each active deployment that does not yet have a `fern_docs_url`:
 *   1. Clone the repo (shallow) into a temp directory
 *   2. Write fern/ config files (fern.config.json, generators.yml, docs.yml)
 *   3. Append docs job to .github/workflows/ci.yml (if missing)
 *   4. Commit and push
 *   5. Set FERN_TOKEN as a repo secret via `gh` CLI
 *   6. Run `fern generate --docs` from the fern/ directory
 *   7. Set FERN_DOCS_URL as a repo variable via `gh` CLI
 *   8. Update Airtable record with fern_docs_url
 *
 * Usage:
 *   node scripts/backfill-fern-docs.mjs            # dry-run
 *   node scripts/backfill-fern-docs.mjs --apply     # execute changes
 *
 * Required env:
 *   GH_TOKEN          - GitHub personal access token (repo scope)
 *   AIRTABLE_API_KEY  - Airtable API key
 *   AIRTABLE_BASE_ID  - Airtable base ID
 *   FERN_TOKEN        - Fern org-level CLI token
 *
 * Optional env:
 *   GITHUB_ORG        - GitHub org (default: postman-cs)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GH_TOKEN = (process.env.GH_TOKEN || "").trim();
const AIRTABLE_API_KEY = (process.env.AIRTABLE_API_KEY || "").trim();
const AIRTABLE_BASE_ID = (process.env.AIRTABLE_BASE_ID || "").trim();
const FERN_TOKEN = (process.env.FERN_TOKEN || "").trim();
const GITHUB_ORG = (process.env.GITHUB_ORG || "postman-cs").trim();
const APPLY = process.argv.includes("--apply");

if (!GH_TOKEN || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !FERN_TOKEN) {
  console.error(
    "Missing required env vars. Required: GH_TOKEN, AIRTABLE_API_KEY, AIRTABLE_BASE_ID, FERN_TOKEN"
  );
  process.exit(1);
}

const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Deployments`;

// ── Helpers ──

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts }).trim();
}

// ── Airtable ──

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

async function updateDeployment(recordId, fields) {
  const response = await airtableFetch(`/${encodeURIComponent(recordId)}`, {
    method: "PATCH",
    body: { fields },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Airtable update failed for ${recordId} (${response.status}): ${body}`
    );
  }
}

// ── Fern config generation (mirrors provision-workflow.ts) ──

function generateFernConfig(projectName, specPath = "index.yaml") {
  const configJson = JSON.stringify(
    { organization: "catalog-demo-996491", version: "0.x.x" },
    null,
    2
  );

  const generatorsYml = `api:\n  specs:\n    - openapi: ../${specPath}\n`;

  const docsYml = `instances:
  - url: ${projectName}.docs.buildwithfern.com

title: ${projectName} | API Documentation

navigation:
  - api: API Reference

colors:
  accentPrimary: "#f97316"
`;

  return { configJson, generatorsYml, docsYml };
}

// Docs job YAML to append to ci.yml (must match CI_WORKFLOW_CONTENT in provision-workflow.ts)
const DOCS_JOB_YAML = `  docs:
    runs-on: ubuntu-latest-16-cores
    if: github.event_name == 'push'
    steps:
      - uses: actions/checkout@v4
      - name: Rebuild Fern Docs
        if: \${{ vars.FERN_DOCS_URL != '' }}
        env:
          FERN_TOKEN: \${{ secrets.FERN_TOKEN }}
        run: |
          if [ ! -d "fern" ] || [ -z "\${FERN_TOKEN}" ]; then
            echo "Fern not configured, skipping"
            exit 0
          fi
          npm install -g fern-api
          cd fern && fern generate --docs --log-level info
`;

// ── Core backfill logic ──

function repoNameFromFields(fields) {
  return readString(fields.github_repo_name) || readString(fields.spec_id);
}

function specFileExists(dir, name) {
  return fs.existsSync(path.join(dir, name));
}

function findSpecPath(dir) {
  for (const candidate of [
    "index.yaml",
    "openapi.yaml",
    "postman/specs/openapi.yaml",
  ]) {
    if (specFileExists(dir, candidate)) return candidate;
  }
  return "index.yaml"; // fallback
}

function backfillRepo(repoName, specId) {
  const docsUrl = `https://${repoName}.docs.buildwithfern.com`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `fern-backfill-`));

  try {
    // 1. Shallow clone
    console.log(`  Cloning ${GITHUB_ORG}/${repoName}...`);
    run(
      `git clone --depth 1 https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_ORG}/${repoName}.git ${tmpDir}/repo`
    );
    const repoDir = path.join(tmpDir, "repo");

    // 2. Write fern/ config
    const specPath = findSpecPath(repoDir);
    const fern = generateFernConfig(repoName, specPath);
    const fernDir = path.join(repoDir, "fern");
    fs.mkdirSync(fernDir, { recursive: true });
    fs.writeFileSync(
      path.join(fernDir, "fern.config.json"),
      fern.configJson + "\n"
    );
    fs.writeFileSync(
      path.join(fernDir, "generators.yml"),
      fern.generatorsYml
    );
    fs.writeFileSync(path.join(fernDir, "docs.yml"), fern.docsYml);
    console.log(`  Wrote fern/ config (spec: ${specPath})`);

    // 3. Append docs job to ci.yml if missing
    const ciPath = path.join(repoDir, ".github", "workflows", "ci.yml");
    if (fs.existsSync(ciPath)) {
      const ciContent = fs.readFileSync(ciPath, "utf-8");
      if (!ciContent.includes("Rebuild Fern Docs")) {
        fs.writeFileSync(ciPath, ciContent + "\n" + DOCS_JOB_YAML);
        console.log(`  Appended docs job to ci.yml`);
      } else {
        console.log(`  ci.yml already has docs job`);
      }
    } else {
      console.log(`  No ci.yml found, skipping docs job append`);
    }

    // 4. Commit and push
    run(`git -C ${repoDir} add -A`);
    const hasChanges =
      run(`git -C ${repoDir} status --porcelain`).length > 0;
    if (hasChanges) {
      run(
        `git -C ${repoDir} -c user.name="Catalog Admin" -c user.email="platform@postman.com" commit -m "chore: add Fern docs configuration"`
      );
      run(`git -C ${repoDir} push origin main`);
      console.log(`  Pushed fern config to ${GITHUB_ORG}/${repoName}`);
    } else {
      console.log(`  No changes to push (fern/ already exists)`);
    }

    // 5. Set FERN_TOKEN secret
    console.log(`  Setting FERN_TOKEN secret...`);
    run(
      `gh secret set FERN_TOKEN --repo ${GITHUB_ORG}/${repoName} --body "${FERN_TOKEN}"`,
      { env: { ...process.env, GH_TOKEN } }
    );

    // 6. Run fern generate --docs
    console.log(`  Running fern generate --docs...`);
    try {
      const fernOutput = run(`cd ${fernDir} && fern generate --docs --log-level info`, {
        env: { ...process.env, FERN_TOKEN },
        timeout: 120_000,
      });
      console.log(`  Fern docs generated: ${docsUrl}`);
      if (fernOutput) console.log(`  ${fernOutput.split("\n").slice(-2).join("\n  ")}`);
    } catch (err) {
      console.warn(
        `  ⚠ fern generate --docs failed (docs may still deploy via CI): ${err.message?.split("\n")[0]}`
      );
    }

    // 7. Set FERN_DOCS_URL repo variable
    console.log(`  Setting FERN_DOCS_URL variable...`);
    run(
      `gh variable set FERN_DOCS_URL --repo ${GITHUB_ORG}/${repoName} --body "${docsUrl}"`,
      { env: { ...process.env, GH_TOKEN } }
    );

    return docsUrl;
  } finally {
    // Cleanup temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Main ──

async function main() {
  console.log(`Backfill Fern Docs — mode: ${APPLY ? "APPLY" : "dry-run"}`);
  console.log(`GitHub org: ${GITHUB_ORG}\n`);

  const all = await listDeployments();
  const candidates = all.filter((record) => {
    const fields = record.fields || {};
    const status = readString(fields.status).toLowerCase();
    const docsUrl = readString(fields.fern_docs_url);
    return status === "active" && !docsUrl;
  });

  console.log(
    `Active deployments missing fern_docs_url: ${candidates.length}\n`
  );

  const summary = {
    total: candidates.length,
    processed: 0,
    succeeded: 0,
    skippedNoRepo: 0,
    failed: 0,
  };

  for (const record of candidates) {
    const fields = record.fields || {};
    const specId = readString(fields.spec_id) || record.id;
    const repoName = repoNameFromFields(fields);

    if (!repoName) {
      summary.skippedNoRepo += 1;
      console.log(
        `[skip] ${specId} (${record.id}) — no github_repo_name or spec_id`
      );
      continue;
    }

    summary.processed += 1;
    const docsUrl = `https://${repoName}.docs.buildwithfern.com`;

    if (!APPLY) {
      console.log(
        `[dry-run] ${specId} (${repoName}) — would set fern_docs_url=${docsUrl}`
      );
      continue;
    }

    try {
      console.log(`\n[apply] ${specId} (${repoName})`);
      const url = backfillRepo(repoName, specId);

      // 8. Update Airtable
      await updateDeployment(record.id, { fern_docs_url: url });
      console.log(`  Updated Airtable record with fern_docs_url=${url}`);
      summary.succeeded += 1;
    } catch (err) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  [error] ${specId} (${repoName}) — ${message}`);
    }
  }

  console.log("\n── Summary ──");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});
