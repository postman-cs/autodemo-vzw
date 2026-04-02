#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

const vitestArgs = [
  "run",
  ...args,
];

const result = spawnSync("vitest", vitestArgs, {
  stdio: "inherit",
  shell: true,
});

if (typeof result.status === "number") {
  process.exit(result.status);
}
process.exit(1);
