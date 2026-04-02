import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DOCS_PATH = path.join(ROOT, "docs.yml");
const CATALOG_PATH = path.resolve(ROOT, "../internal-catalog/specs/service-catalog.json");
const PAGES_DIR = path.join(ROOT, "pages/services");
const LANDING_PATH = path.join(ROOT, "pages/landing.mdx");

const GRAPH_NAME_BY_TAB = {
  "emergency-dispatch": "Emergency Dispatch Operations",
  "private-5g": "Private 5G Campus Operations",
  "utility-grid": "Utility Grid Intelligence",
  platform: "Platform Services",
};

function escapeMdx(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/\"/g, '\\\"');
}

function compactDescription(description) {
  if (!description) return "Live API reference and service operations metadata.";
  const oneLine = String(description).replace(/\s+/g, " ").trim();
  if (oneLine.length <= 140) return oneLine;
  return oneLine.slice(0, 137).trimEnd() + "...";
}

function getPathname(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "#";
  }
}

async function main() {
  const [catalogRaw, docsRaw] = await Promise.all([
    fs.readFile(CATALOG_PATH, "utf8"),
    fs.readFile(DOCS_PATH, "utf8"),
  ]);

  const catalog = JSON.parse(catalogRaw);

  const serviceById = new Map((catalog.services || []).map((service) => [service.id, service]));

  const tabServices = new Map();
  const lines = docsRaw.split(/\r?\n/);
  let currentTab = null;
  for (const line of lines) {
    const tabMatch = line.match(/^\s*-\s*tab:\s*([\w-]+)/);
    if (tabMatch) {
      currentTab = tabMatch[1];
      if (!tabServices.has(currentTab)) {
        tabServices.set(currentTab, []);
      }
      continue;
    }
    const apiNameMatch = line.match(/^\s*api-name:\s*([\w-]+)/);
    if (apiNameMatch && currentTab) {
      tabServices.get(currentTab).push(apiNameMatch[1]);
    }
  }

  await fs.mkdir(PAGES_DIR, { recursive: true });

  const allServiceIds = new Set();
  for (const ids of tabServices.values()) {
    for (const id of ids) allServiceIds.add(id);
  }
  for (const service of catalog.services || []) {
    allServiceIds.add(service.id);
  }

  const generatedFiles = [];
  for (const serviceId of allServiceIds) {
    const service = serviceById.get(serviceId);
    if (!service) continue;

    let graphName;
    for (const [tab, ids] of tabServices.entries()) {
      if (ids.includes(serviceId)) {
        graphName = GRAPH_NAME_BY_TAB[tab];
        break;
      }
    }

    const lines = [
      "---",
      `title: ${service.title}`,
      "---",
      "",
      'import { ServiceOverview } from "@/components/ServiceOverview"',
      "",
      "<ServiceOverview",
      `  serviceId=\"${escapeMdx(service.id)}\"`,
      `  title=\"${escapeMdx(service.title)}\"`,
      `  description=\"${escapeMdx(service.description || "")}\"`,
      graphName ? `  graphName=\"${escapeMdx(graphName)}\"` : null,
      service.runtime ? `  runtime=\"${escapeMdx(service.runtime)}\"` : null,
      "/>",
      "",
    ].filter(Boolean);

    const filePath = path.join(PAGES_DIR, `${service.id}.mdx`);
    await fs.writeFile(filePath, lines.join("\n"), "utf8");
    generatedFiles.push(filePath);
  }

  const sectionOrder = [
    ["emergency-dispatch", "Emergency Dispatch Operations"],
    ["private-5g", "Private 5G Campus Operations"],
    ["utility-grid", "Utility Grid Intelligence"],
    ["platform", "Platform Services"],
  ];

  const landingLines = [
    "---",
    "title: Verizon Partner API Catalog",
    "---",
    "",
    "Explore 34 enterprise APIs across emergency dispatch, private 5G campus networks, utility grid intelligence, and platform services.",
    "",
  ];

  for (const [tab, sectionTitle] of sectionOrder) {
    landingLines.push(`## ${sectionTitle}`);
    landingLines.push("");
    landingLines.push("<CardGroup cols={3}>");

    const ids = tabServices.get(tab) || [];
    for (const serviceId of ids) {
      const service = serviceById.get(serviceId);
      if (!service) continue;
      const href = getPathname(service.fern_docs_url);
      landingLines.push(`  <Card title=\"${escapeMdx(service.title.replace(/^VZW\s+/, "").replace(/\s+API$/, ""))}\" href=\"${escapeMdx(href)}\">`);
      landingLines.push(`    ${compactDescription(service.description)}`);
      landingLines.push("  </Card>");
    }

    landingLines.push("</CardGroup>");
    landingLines.push("");
  }

  await fs.writeFile(LANDING_PATH, landingLines.join("\n"), "utf8");

  console.log(`Generated ${generatedFiles.length} service overview page(s) in ${PAGES_DIR}`);
  console.log(`Generated landing page at ${LANDING_PATH}`);
}

main().catch((error) => {
  console.error("Failed to generate Fern pages:");
  console.error(error);
  process.exit(1);
});
