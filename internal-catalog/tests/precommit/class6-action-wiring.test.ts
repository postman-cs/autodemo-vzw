import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { buildProvisionWorkflowDefinition } from "../../src/lib/provision-workflow";

interface ActionInputSpec {
  required: boolean;
}

const ACTIONS_DIR = path.resolve(__dirname, "../../.github/actions");

function parseActionInputs(actionYaml: string): Map<string, ActionInputSpec> {
  const doc = parseYaml(actionYaml) as { inputs?: Record<string, { required?: boolean }> } | null;
  return new Map(
    Object.entries(doc?.inputs || {}).map(([name, spec]) => [name, { required: Boolean(spec?.required) }]),
  );
}

function extractConsumedInputs(source: string): Set<string> {
  const regex = /core\.getInput\(['"]([^'"]+)['"]\s*(?:,|\))/g;
  const keys = new Set<string>();
  for (const match of source.matchAll(regex)) keys.add(match[1]);
  return keys;
}

describe("precommit class 6 action wiring", () => {
  const workflow = buildProvisionWorkflowDefinition();
  const localActionSteps = Object.values(workflow.jobs)
    .flatMap((job) => job.steps || [])
    .filter((step) => step.uses?.includes(".github/actions/") && step.uses?.startsWith("./.actions/"));

  it("provides only declared inputs to local actions", () => {
    for (const step of localActionSteps) {
      const actionName = step.uses!.split("/").pop()!;
      const actionYaml = fs.readFileSync(path.join(ACTIONS_DIR, actionName, "action.yml"), "utf8");
      const declaredInputs = parseActionInputs(actionYaml);
      const withKeys = Object.keys(step.with || {});

      const unknownKeys = withKeys.filter((key) => !declaredInputs.has(key));
      expect(unknownKeys, `${actionName} received unknown inputs: ${unknownKeys.join(", ")}`).toEqual([]);
    }
  });

  it("provides all required action.yml inputs to local actions", () => {
    for (const step of localActionSteps) {
      const actionName = step.uses!.split("/").pop()!;
      const actionYaml = fs.readFileSync(path.join(ACTIONS_DIR, actionName, "action.yml"), "utf8");
      const declaredInputs = parseActionInputs(actionYaml);
      const missingRequired = [...declaredInputs.entries()]
        .filter(([, spec]) => spec.required)
        .map(([name]) => name)
        .filter((name) => !(name in (step.with || {})));

      expect(missingRequired, `${actionName} is missing required inputs: ${missingRequired.join(", ")}`).toEqual([]);
    }
  });

  it("keeps action.yml declarations aligned with core.getInput usage", () => {
    const actionDirs = fs.readdirSync(ACTIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const actionName of actionDirs) {
      const actionYamlPath = path.join(ACTIONS_DIR, actionName, "action.yml");
      const sourcePath = path.join(ACTIONS_DIR, actionName, "src", "index.ts");
      if (!fs.existsSync(actionYamlPath) || !fs.existsSync(sourcePath)) continue;

      const declaredInputs = parseActionInputs(fs.readFileSync(actionYamlPath, "utf8"));
      const consumedInputs = extractConsumedInputs(fs.readFileSync(sourcePath, "utf8"));
      const undeclared = [...consumedInputs].filter((name) => !declaredInputs.has(name));

      expect(undeclared, `${actionName} consumes undeclared inputs: ${undeclared.join(", ")}`).toEqual([]);
    }
  });
});
