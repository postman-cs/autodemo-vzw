import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const ACTIONS_DIR = path.resolve(__dirname, "../.github/actions");

type ActionContract = {
  name: string;
  declaredInputs: Set<string>;
  requiredDeclaredInputs: Set<string>;
  consumedInputs: Set<string>;
  requiredConsumedInputs: Set<string>;
};

function extractConsumedInputs(source: string): Set<string> {
  const regex = /core\.getInput\('([^']+)'\s*(?:,|\))/g;
  const keys = new Set<string>();
  for (const match of source.matchAll(regex)) {
    keys.add(match[1]);
  }
  return keys;
}

function extractRequiredConsumedInputs(source: string): Set<string> {
  const regex = /core\.getInput\('([^']+)'\s*,\s*\{\s*required:\s*true\s*}\s*\)/g;
  const keys = new Set<string>();
  for (const match of source.matchAll(regex)) {
    keys.add(match[1]);
  }
  return keys;
}

function loadActionContracts(): ActionContract[] {
  const dirs = fs.readdirSync(ACTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const contracts: ActionContract[] = [];
  for (const dir of dirs) {
    const actionYmlPath = path.join(ACTIONS_DIR, dir, "action.yml");
    const srcPath = path.join(ACTIONS_DIR, dir, "src", "index.ts");
    if (!fs.existsSync(actionYmlPath) || !fs.existsSync(srcPath)) continue;

    const actionDoc = parseYaml(fs.readFileSync(actionYmlPath, "utf8")) as { inputs?: Record<string, unknown> } | null;
    const inputDefs = actionDoc?.inputs || {};
    const declaredInputs = new Set(Object.keys(inputDefs));
    const requiredDeclaredInputs = new Set(
      Object.entries(inputDefs)
        .filter(([, def]) => Boolean((def as { required?: boolean }).required))
        .map(([name]) => name),
    );
    const source = fs.readFileSync(srcPath, "utf8");
    const consumedInputs = extractConsumedInputs(source);
    const requiredConsumedInputs = extractRequiredConsumedInputs(source);

    contracts.push({
      name: dir,
      declaredInputs,
      requiredDeclaredInputs,
      consumedInputs,
      requiredConsumedInputs,
    });
  }

  return contracts;
}

describe("GitHub action input contracts", () => {
  const contracts = loadActionContracts();

  it("finds local custom action contracts", () => {
    expect(contracts.length).toBeGreaterThan(0);
  });

  for (const contract of contracts) {
    it(`${contract.name} declares every core.getInput key in action.yml`, () => {
      const missing = [...contract.consumedInputs].filter((key) => !contract.declaredInputs.has(key));
      expect(missing).toEqual([]);
    });

    it(`${contract.name} marks required core.getInput keys as required in action.yml`, () => {
      const missingRequired = [...contract.requiredConsumedInputs]
        .filter((key) => !contract.requiredDeclaredInputs.has(key));
      expect(missingRequired).toEqual([]);
    });
  }
});
