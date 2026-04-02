import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { collectBunLockErrors } from "../../scripts/check-bun-lock.mjs";

function writePackageJson(dir: string, packageJson: Record<string, unknown>) {
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(packageJson, null, 2));
}

function writeBunLock(dir: string, bunLockSource: string) {
  writeFileSync(path.join(dir, "bun.lock"), bunLockSource);
}

describe("bun lock validator", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags direct dependency drift between package.json and bun.lock", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bun-lock-validator-"));
    tempDirs.push(dir);

    writePackageJson(dir, {
      name: "fixture",
      dependencies: {
        react: "^19.2.4",
        "@floating-ui/react-dom": "^2.1.8",
      },
      devDependencies: {
        vitest: "^4.1.0",
      },
      overrides: {
        undici: "^7.24.2",
      },
    });

    writeBunLock(
      dir,
      `{
        lockfileVersion: 1,
        workspaces: {
          "": {
            name: "fixture",
            dependencies: {
              react: "^19.2.4",
            },
            devDependencies: {
              vitest: "^4.1.0",
            },
          },
        },
        overrides: {
          undici: "^6.23.0",
        },
      }`,
    );

    const errors = collectBunLockErrors({
      cwd: dir,
      runFrozenInstallCheck: () => ({ ok: true, output: "" }),
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("dependencies in bun.lock do not match package.json"),
        expect.stringContaining("overrides in bun.lock do not match package.json"),
      ]),
    );
  });

  it("flags staged package.json changes when bun.lock is not staged", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bun-lock-validator-"));
    tempDirs.push(dir);

    writePackageJson(dir, {
      name: "fixture",
      dependencies: {
        react: "^19.2.4",
      },
    });

    writeBunLock(
      dir,
      `{
        lockfileVersion: 1,
        workspaces: {
          "": {
            name: "fixture",
            dependencies: {
              react: "^19.2.4",
            },
          },
        },
        overrides: {},
      }`,
    );

    const errors = collectBunLockErrors({
      cwd: dir,
      stagedFiles: ["package.json"],
      runFrozenInstallCheck: () => ({ ok: true, output: "" }),
    });

    expect(errors).toContain("package.json is staged but bun.lock is not staged");
  });

  it("flags frozen install check failures even when direct declarations match", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bun-lock-validator-"));
    tempDirs.push(dir);

    writePackageJson(dir, {
      name: "fixture",
      dependencies: {
        react: "^19.2.4",
      },
      overrides: {
        undici: "^7.24.2",
      },
    });

    writeBunLock(
      dir,
      `{
        lockfileVersion: 1,
        workspaces: {
          "": {
            name: "fixture",
            dependencies: {
              react: "^19.2.4",
            },
          },
        },
        overrides: {
          undici: "^7.24.2",
        },
      }`,
    );

    const errors = collectBunLockErrors({
      cwd: dir,
      runFrozenInstallCheck: () => ({
        ok: false,
        output: "error: lockfile had changes, but lockfile is frozen",
      }),
    });

    expect(errors).toContain("bun install --frozen-lockfile --dry-run reported drift");
  });

  it("returns no errors when declarations match, bun.lock is staged, and frozen install passes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bun-lock-validator-"));
    tempDirs.push(dir);

    writePackageJson(dir, {
      name: "fixture",
      dependencies: {
        react: "^19.2.4",
      },
      devDependencies: {
        vitest: "^4.1.0",
      },
      overrides: {
        undici: "^7.24.2",
      },
    });

    writeBunLock(
      dir,
      `{
        lockfileVersion: 1,
        workspaces: {
          "": {
            name: "fixture",
            dependencies: {
              react: "^19.2.4",
            },
            devDependencies: {
              vitest: "^4.1.0",
            },
          },
        },
        overrides: {
          undici: "^7.24.2",
        },
      }`,
    );

    const errors = collectBunLockErrors({
      cwd: dir,
      stagedFiles: ["package.json", "bun.lock"],
      runFrozenInstallCheck: () => ({ ok: true, output: "" }),
    });

    expect(errors).toEqual([]);
  });
});
