#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const injectBadUrl = process.argv.includes("--bad-url-fixture");

const env = {
  ...process.env,
  ...(injectBadUrl ? { FERN_HARNESS_INJECT_BAD_URL: "1" } : {}),
};

const args = [
  "vitest",
  "run",
  "tests/fern-regression-harness.test.ts",
  "--project",
  "node",
];

try {
  execFileSync("npx", args, {
    cwd: new URL("..", import.meta.url),
    stdio: "inherit",
    env,
  });
} catch (error) {
  if (injectBadUrl) {
    console.error("fern regression harness correctly failed with an injected stale URL fixture");
  }
  process.exit(error && typeof error.status === "number" ? error.status : 1);
}
