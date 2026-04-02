#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Script } from "node:vm";

function parseArgs(argv = process.argv.slice(2)) {
  return {
    staged: argv.includes("--staged"),
    reportOnly: argv.includes("--report-only"),
  };
}

function normalizeRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entryValue]) => [String(key), String(entryValue)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function formatRecord(record) {
  const entries = Object.entries(record);
  if (entries.length === 0) {
    return "(none)";
  }

  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function parseBunLock(lockfilePath) {
  const source = readFileSync(lockfilePath, "utf8");
  return new Script(`(${source})`).runInNewContext(Object.create(null), { timeout: 1000 });
}

function readStagedFiles(cwd) {
  try {
    const output = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMRT"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function defaultFrozenInstallCheck(cwd) {
  try {
    execFileSync("bun", ["install", "--frozen-lockfile", "--dry-run"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: "" };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      console.warn("[WARN] Skipping bun frozen-lockfile check because 'bun' is not available in PATH.");
      return { ok: true, output: "" };
    }

    const output = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    return { ok: false, output };
  }
}

export function collectBunLockErrors(options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const packageJsonPath = resolve(cwd, "package.json");
  const bunLockPath = resolve(cwd, "bun.lock");
  const errors = [];

  if (!existsSync(packageJsonPath)) {
    return ["package.json not found"];
  }

  if (!existsSync(bunLockPath)) {
    return ["bun.lock not found"];
  }

  const packageJson = readJsonFile(packageJsonPath);
  const bunLock = parseBunLock(bunLockPath);
  const workspace = bunLock?.workspaces?.[""] || {};

  const expectedDependencies = normalizeRecord(packageJson.dependencies);
  const actualDependencies = normalizeRecord(workspace.dependencies);
  if (JSON.stringify(expectedDependencies) !== JSON.stringify(actualDependencies)) {
    errors.push(
      `dependencies in bun.lock do not match package.json: expected ${formatRecord(expectedDependencies)}; received ${formatRecord(actualDependencies)}`,
    );
  }

  const expectedDevDependencies = normalizeRecord(packageJson.devDependencies);
  const actualDevDependencies = normalizeRecord(workspace.devDependencies);
  if (JSON.stringify(expectedDevDependencies) !== JSON.stringify(actualDevDependencies)) {
    errors.push(
      `devDependencies in bun.lock do not match package.json: expected ${formatRecord(expectedDevDependencies)}; received ${formatRecord(actualDevDependencies)}`,
    );
  }

  const expectedOverrides = normalizeRecord(packageJson.overrides);
  const actualOverrides = normalizeRecord(bunLock.overrides);
  if (JSON.stringify(expectedOverrides) !== JSON.stringify(actualOverrides)) {
    errors.push(
      `overrides in bun.lock do not match package.json: expected ${formatRecord(expectedOverrides)}; received ${formatRecord(actualOverrides)}`,
    );
  }

  const stagedFiles = options.stagedFiles || [];
  if (stagedFiles.includes("package.json") && !stagedFiles.includes("bun.lock")) {
    errors.push("package.json is staged but bun.lock is not staged");
  }

  const runFrozenInstallCheck = options.runFrozenInstallCheck || defaultFrozenInstallCheck;
  const frozenInstallResult = runFrozenInstallCheck(cwd);
  if (!frozenInstallResult.ok) {
    errors.push("bun install --frozen-lockfile --dry-run reported drift");
    if (frozenInstallResult.output) {
      errors.push(`bun install output: ${frozenInstallResult.output}`);
    }
  }

  return errors;
}

function main() {
  const args = parseArgs();
  const stagedFiles = args.staged ? readStagedFiles(process.cwd()) : [];
  const errors = collectBunLockErrors({
    cwd: process.cwd(),
    stagedFiles,
  });

  if (errors.length === 0) {
    console.log("bun.lock validation passed.");
    process.exit(0);
  }

  for (const error of errors) {
    console.error(`[ERROR] ${error}`);
  }

  if (args.reportOnly) {
    process.exit(0);
  }

  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
