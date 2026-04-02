import fs from "node:fs";

const HUB_DOMAINS = new Set(["platform", "identity", "data", "notify"]);

const registryRaw = fs.readFileSync("specs/registry.json", "utf8");
const registry = JSON.parse(registryRaw);

const services = registry
  .map((entry) => ({
    id: String(entry.id || "").trim(),
    domain: String(entry.domain || "unknown").trim() || "unknown",
  }))
  .filter((entry) => entry.id);

const allIds = services.map((entry) => entry.id);
const domainById = new Map(services.map((entry) => [entry.id, entry.domain]));

const idsByDomain = new Map();
for (const service of services) {
  if (!idsByDomain.has(service.domain)) {
    idsByDomain.set(service.domain, []);
  }
  idsByDomain.get(service.domain).push(service.id);
}

const domainOrder = [...idsByDomain.keys()].sort((a, b) => a.localeCompare(b));
const hubIds = services
  .filter((service) => HUB_DOMAINS.has(service.domain))
  .map((service) => service.id);

function stableHash(input) {
  let hash = 0;
  for (const ch of input) {
    hash = (hash * 31 + ch.charCodeAt(0)) % 2147483647;
  }
  return hash;
}

function rotate(values, seed) {
  if (!values.length) return [];
  const offset = Math.abs(seed) % values.length;
  return values.slice(offset).concat(values.slice(0, offset));
}

function appendUnique(target, candidates, maxLength, blocked) {
  for (const candidate of candidates) {
    if (target.length >= maxLength) break;
    if (blocked.has(candidate)) continue;
    blocked.add(candidate);
    target.push(candidate);
  }
}

function buildDomainFallbackOrder(domain) {
  const index = domainOrder.indexOf(domain);
  if (index < 0) return [...domainOrder];
  return domainOrder.slice(index + 1).concat(domainOrder.slice(0, index));
}

const existingRaw = fs.existsSync("specs/dependencies.json")
  ? fs.readFileSync("specs/dependencies.json", "utf8")
  : "{}";
const dependencies = JSON.parse(existingRaw);

let added = 0;
let skipped = 0;

services.forEach((service, index) => {
  const { id, domain } = service;

  if (dependencies[id]) {
    skipped++;
    return;
  }

  added++;
  const totalEdges = 2 + (stableHash(`${id}:total`) % 5); // 2-6

  const earlierIds = allIds.slice(0, index);
  const dependsOn = [];

  if (earlierIds.length > 0) {
    const maxDepends = Math.min(2, totalEdges, earlierIds.length);
    const desiredDepends = 1 + (stableHash(`${id}:depends`) % maxDepends);

    const sameDomainEarlier = earlierIds.filter((candidate) => domainById.get(candidate) === domain);
    const hubEarlier = earlierIds.filter(
      (candidate) => HUB_DOMAINS.has(domainById.get(candidate)) && domainById.get(candidate) !== domain,
    );
    const otherEarlier = earlierIds.filter(
      (candidate) => !sameDomainEarlier.includes(candidate) && !hubEarlier.includes(candidate),
    );

    const blockedDepends = new Set([id]);
    appendUnique(dependsOn, rotate(sameDomainEarlier, stableHash(`${id}:sd`)), desiredDepends, blockedDepends);
    appendUnique(dependsOn, rotate(hubEarlier, stableHash(`${id}:hd`)), desiredDepends, blockedDepends);
    appendUnique(dependsOn, rotate(otherEarlier, stableHash(`${id}:od`)), desiredDepends, blockedDepends);
  }

  const consumesApis = [];
  const consumesTarget = totalEdges - dependsOn.length;
  const blockedConsumes = new Set([id, ...dependsOn]);

  const sameDomain = (idsByDomain.get(domain) || []).filter((candidate) => !blockedConsumes.has(candidate));
  const hubCandidates = hubIds.filter(
    (candidate) => !blockedConsumes.has(candidate) && domainById.get(candidate) !== domain,
  );

  const domainFallback = buildDomainFallbackOrder(domain);
  const nearbyDomainCandidates = domainFallback
    .flatMap((candidateDomain) => idsByDomain.get(candidateDomain) || [])
    .filter((candidate) => !blockedConsumes.has(candidate) && domainById.get(candidate) !== domain);

  const allRemaining = allIds.filter((candidate) => !blockedConsumes.has(candidate));

  appendUnique(consumesApis, rotate(sameDomain, stableHash(`${id}:sc`)), consumesTarget, blockedConsumes);
  appendUnique(consumesApis, rotate(hubCandidates, stableHash(`${id}:hc`)), consumesTarget, blockedConsumes);
  appendUnique(consumesApis, rotate(nearbyDomainCandidates, stableHash(`${id}:nc`)), consumesTarget, blockedConsumes);
  appendUnique(consumesApis, rotate(allRemaining, stableHash(`${id}:ac`)), consumesTarget, blockedConsumes);

  dependencies[id] = {
    dependsOn,
    consumesApis,
  };
});

fs.writeFileSync("specs/dependencies.json", `${JSON.stringify(dependencies, null, 2)}\n`);

console.log(`Dependencies: ${added} added, ${skipped} existing (unchanged). Total: ${Object.keys(dependencies).length} services.`);
