#!/usr/bin/env node
/**
 * Build-time script: extract info.description and endpoint summaries from
 * every OpenAPI spec referenced in registry.json.
 *
 * Output: specs/spec-descriptions.json
 * Usage: node scripts/extract-spec-descriptions.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const specsDir = resolve(__dirname, "../specs");
const registry = JSON.parse(readFileSync(resolve(specsDir, "registry.json"), "utf-8"));
const output = {};

for (const entry of registry) {
  if (!entry.filename) continue;
  const specPath = resolve(specsDir, entry.filename);
  try {
    const content = readFileSync(specPath, "utf-8");
    const doc = parseYaml(content);
    const description = String(doc?.info?.description || "").trim();

    const summaries = [];
    const seen = new Set();
    const paths = doc?.paths || {};

    for (const methods of Object.values(paths)) {
      if (!methods || typeof methods !== "object") continue;
      for (const [method, operation] of Object.entries(methods)) {
        if (method.startsWith("x-") || typeof operation !== "object" || !operation) continue;
        const summary = String(operation.summary || "").trim();
        if (summary && !seen.has(summary.toLowerCase())) {
          seen.add(summary.toLowerCase());
          summaries.push(summary);
        }
        if (summaries.length >= 7) break;
      }
      if (summaries.length >= 7) break;
    }

    output[entry.id] = { description, endpointSummaries: summaries };
  } catch (err) {
    console.warn(`Failed to extract from ${entry.id}: ${err.message}`);
    output[entry.id] = { description: "", endpointSummaries: [] };
  }
}

const outPath = resolve(specsDir, "spec-descriptions.json");
writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
console.log(`Extracted descriptions for ${Object.keys(output).length} specs -> ${outPath}`);
