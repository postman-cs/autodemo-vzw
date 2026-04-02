#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";

const roots = ["tests", "src"];
const forbidden = [
  { name: '.reply(204, "")', regex: /\.reply\(\s*204\s*,\s*""\s*\)/g },
  { name: ".reply(204)", regex: /\.reply\(\s*204\s*\)/g },
  { name: ".reply(204, null)", regex: /\.reply\(\s*204\s*,\s*null\s*\)/g },
  { name: 'statusCode: 204, data: ""', regex: /statusCode:\s*204\s*,\s*data:\s*""/g },
  { name: "statusCode: 204, data: null", regex: /statusCode:\s*204\s*,\s*data:\s*null/g },
  { name: 'new Response("", { status: 204', regex: /new\s+Response\(\s*""\s*,\s*\{[^}]*status:\s*204/g },
];

function walk(dir, out) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (extname(full) === ".ts") out.push(full);
  }
}

function lineAt(content, index) {
  return content.slice(0, index).split("\n").length;
}

const files = [];
for (const root of roots) walk(root, files);

const violations = [];
for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const rule of forbidden) {
    rule.regex.lastIndex = 0;
    let match;
    while ((match = rule.regex.exec(content)) !== null) {
      const line = lineAt(content, match.index);
      violations.push({
        file,
        line,
        snippet: match[0],
        rule: rule.name,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("Found invalid 204 no-content response patterns:");
  for (const v of violations) {
    console.error(`- ${v.file}:${v.line} [${v.rule}] ${v.snippet}`);
  }
  process.exit(1);
}

console.log("No invalid 204 no-content response patterns found.");
