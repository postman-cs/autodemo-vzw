#!/usr/bin/env node
/**
 * Scans industry subdirectories under specs/ and generates specs/registry.json
 * with a one-to-one mapping of spec_id -> metadata (including industry).
 *
 * Folder structure:
 *   specs/<industry>/*.yaml  →  registry entries with industry field
 *
 * Run: node scripts/generate-registry.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { resolve, basename, join } from "path";
import YAML from "yaml";

const SPECS_DIR = resolve(process.cwd(), "specs");
const OUTPUT = resolve(SPECS_DIR, "registry.json");

const industryDirs = readdirSync(SPECS_DIR)
  .filter((entry) => statSync(resolve(SPECS_DIR, entry)).isDirectory())
  .sort();

console.log(`Found industry directories: ${industryDirs.join(", ") || "(none)"}`);

const registry = [];

for (const industry of industryDirs) {
  const industryPath = resolve(SPECS_DIR, industry);
  const files = readdirSync(industryPath)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  console.log(`  ${industry}: ${files.length} spec files`);

  for (const file of files) {
    const content = readFileSync(resolve(industryPath, file), "utf-8");
    const spec = YAML.parse(content);

    const info = spec.info || {};
    const paths = spec.paths || {};
    const endpointCount = Object.entries(paths).reduce((count, [, methods]) => {
      return count + Object.keys(methods).filter((m) =>
        ["get", "post", "put", "patch", "delete", "head"].includes(m)
      ).length;
    }, 0);

    const repoName = basename(file, ".yaml").replace(/\.yml$/, "");

    const rawTitle = info.title || repoName;
    const displayTitle = rawTitle.replace(/^Acme\s+\w+\s+/i, "");

    registry.push({
      id: info["x-acme-catalog-id"] || repoName,
      title: displayTitle,
      description: (info.description || "").trim(),
      industry,
      domain: info["x-acme-domain"] || "unknown",
      filename: join(industry, file),
      repo_name: repoName,
      endpoints: endpointCount,
      version: info.version || "1.0.0",
    });
  }
}

registry.sort((a, b) => {
  if (a.industry !== b.industry) return a.industry.localeCompare(b.industry);
  if (a.domain !== b.domain) return a.domain.localeCompare(b.domain);
  return a.title.localeCompare(b.title);
});

writeFileSync(OUTPUT, JSON.stringify(registry, null, 2) + "\n");
console.log(`Wrote ${registry.length} entries to specs/registry.json`);

const industries = [...new Set(registry.map((r) => r.industry))].sort();
console.log(`Industries (${industries.length}): ${industries.join(", ")}`);
const domains = [...new Set(registry.map((r) => r.domain))].sort();
console.log(`Domains (${domains.length}): ${domains.join(", ")}`);
