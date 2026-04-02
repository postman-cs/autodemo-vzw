import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT_SOURCE = path.join(process.cwd(), "scripts", "sync-1password.sh");
const DEFAULT_VAULT_ID = "m6hrbahxfdgv56kkxrntu3aqya";

function writeExecutable(filePath: string, content: string) {
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

function createFakeOp(dir: string) {
  const fakeOpScript = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'cmd="${1:-}"',
    "shift || true",
    'case "$cmd" in',
    "  whoami)",
    "    exit 0",
    "    ;;",
    "  item)",
    '    sub="${1:-}"',
    "    shift || true",
    '    case "$sub" in',
    "      get)",
    "        exit 1",
    "        ;;",
    "      create|edit)",
    "        exit 0",
    "        ;;",
    "      *)",
    "        exit 2",
    "        ;;",
    "    esac",
    "    ;;",
    "  *)",
    "    exit 0",
    "    ;;",
    "esac",
    "",
  ].join("\n");

  writeExecutable(path.join(dir, "op"), fakeOpScript);
}

function setupTempRepo(envBody: string) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "sync-1password-"));
  const scriptsDir = path.join(tempDir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  copyFileSync(SCRIPT_SOURCE, path.join(scriptsDir, "sync-1password.sh"));
  chmodSync(path.join(scriptsDir, "sync-1password.sh"), 0o755);
  writeFileSync(path.join(tempDir, ".env"), envBody);
  createFakeOp(tempDir);
  spawnSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
  return tempDir;
}

function runSyncScript(cwd: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [path.join(cwd, "scripts", "sync-1password.sh")], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${cwd}:${process.env.PATH || ""}`,
      ...extraEnv,
    },
  });
}

describe("sync-1password pre-commit hook script", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to the configured vault id when no env override is present", () => {
    const dir = setupTempRepo([
      "POSTMAN_TEAM__FAKE__API_KEY=test-api-key",
      "POSTMAN_TEAM__FAKE__ACCESS_TOKEN=test-access-token",
      "",
    ].join("\n"));
    tempDirs.push(dir);

    const result = runSyncScript(dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`1Password vault: ${DEFAULT_VAULT_ID}`);
    expect(result.stdout).toContain("Synced 1 tenant(s) to 1Password.");
  });

  it("detects export-prefixed team credential lines in .env", () => {
    const dir = setupTempRepo([
      "export POSTMAN_TEAM__FIELD_SERVICES__API_KEY=test-api-key",
      "export POSTMAN_TEAM__FIELD_SERVICES__ACCESS_TOKEN=test-access-token",
      "",
    ].join("\n"));
    tempDirs.push(dir);

    const result = runSyncScript(dir, { ONEPASSWORD_VAULT_ID: DEFAULT_VAULT_ID });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("field-services: Creating new item in 1Password...");
    expect(result.stdout).toContain("Synced 1 tenant(s) to 1Password.");
  });
});
