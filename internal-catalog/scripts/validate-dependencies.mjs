import fs from "node:fs";

const registryRaw = fs.readFileSync("specs/registry.json", "utf8");
const registry = JSON.parse(registryRaw);
const registryIds = registry.map((entry) => String(entry.id || "").trim()).filter(Boolean);
const registryIdSet = new Set(registryIds);

const depsRaw = fs.readFileSync("specs/dependencies.json", "utf8");
const dependencies = JSON.parse(depsRaw);

let hasErrors = false;

function error(message) {
  console.error(`[ERROR] ${message}`);
  hasErrors = true;
}

function assertStringArray(label, value) {
  if (!Array.isArray(value)) {
    error(`${label} must be an array`);
    return [];
  }
  const invalid = value.filter((item) => typeof item !== "string" || !item.trim());
  if (invalid.length > 0) {
    error(`${label} must contain only non-empty strings`);
  }
  return value.map((item) => String(item).trim()).filter(Boolean);
}

if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
  error("dependencies.json must be a JSON object keyed by registry service id");
}

const dependencyIds = Object.keys(dependencies || {});
const dependencyIdSet = new Set(dependencyIds);

for (const id of registryIds) {
  if (!dependencyIdSet.has(id)) {
    error(`dependencies.json is missing registry service '${id}'`);
  }
}
for (const id of dependencyIds) {
  if (!registryIdSet.has(id)) {
    error(`dependencies.json contains unknown service key '${id}'`);
  }
}

const graph = {};

for (const id of dependencyIds) {
  const entry = dependencies[id];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    error(`Service '${id}' entry must be an object`);
    continue;
  }

  const dependsOn = assertStringArray(`${id}.dependsOn`, entry.dependsOn);
  const consumesApis = assertStringArray(`${id}.consumesApis`, entry.consumesApis);

  const allEdges = [...dependsOn, ...consumesApis];
  const totalEdgeCount = allEdges.length;
  if (totalEdgeCount < 2 || totalEdgeCount > 6) {
    error(`Service '${id}' must have between 2 and 6 total edges; found ${totalEdgeCount}`);
  }

  for (const target of allEdges) {
    if (!registryIdSet.has(target)) {
      error(`Service '${id}' references unknown service '${target}'`);
    }
  }

  if (allEdges.includes(id)) {
    error(`Service '${id}' cannot reference itself`);
  }

  if (new Set(dependsOn).size !== dependsOn.length) {
    error(`Service '${id}' has duplicate dependsOn edges`);
  }
  if (new Set(consumesApis).size !== consumesApis.length) {
    error(`Service '${id}' has duplicate consumesApis edges`);
  }

  const overlap = dependsOn.filter((target) => consumesApis.includes(target));
  if (overlap.length > 0) {
    error(`Service '${id}' has overlapping dependsOn/consumesApis edges: ${overlap.join(", ")}`);
  }

  graph[id] = dependsOn;
}

// DAG validation for dependsOn.
const visited = new Set();
const recursionStack = new Set();

function dfs(node) {
  if (recursionStack.has(node)) {
    return true;
  }
  if (visited.has(node)) {
    return false;
  }

  visited.add(node);
  recursionStack.add(node);

  for (const neighbor of graph[node] || []) {
    if (dfs(neighbor)) {
      return true;
    }
  }

  recursionStack.delete(node);
  return false;
}

for (const node of Object.keys(graph)) {
  if (!visited.has(node) && dfs(node)) {
    error(`Cycle detected in dependsOn graph involving '${node}'`);
  }
}

if (hasErrors) {
  process.exit(1);
}

console.log("Dependency graph validation passed.");
