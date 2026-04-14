// Generate the provision.yml GitHub Actions workflow for new repos

import { parse as parseYaml } from "yaml";
import type { PortalConfig } from "./config";
import {
  CI_WORKFLOW_TEMPLATE,
  REFRESH_DEPENDENCIES_WORKFLOW_TEMPLATE,
  renderProvisionWorkflowTemplate,
} from "./provision-workflow-templates";

// CI/CD workflow content that gets written to provisioned repos
// This is the ci.yml that replaces provision.yml after provisioning completes
export const CI_WORKFLOW_CONTENT = CI_WORKFLOW_TEMPLATE;

// Lightweight dependency refresh workflow
export const REFRESH_DEPENDENCIES_WORKFLOW_CONTENT = REFRESH_DEPENDENCIES_WORKFLOW_TEMPLATE;

// ── Fern docs config generation ──

export interface FernConfig {
  configJson: string;     // fern/fern.config.json
  generatorsYml: string;  // fern/generators.yml
  docsYml: string;        // fern/docs.yml
}

export interface WorkflowStep {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}

export interface WorkflowJob {
  if?: string;
  needs?: string[] | string;
  permissions?: Record<string, string>;
  runsOn?: string;
  "runs-on"?: string;
  outputs?: Record<string, string>;
  steps: WorkflowStep[];
}

export interface WorkflowDefinition {
  name: string;
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
}

export function generateFernConfig(projectName: string, specPath = "index.yaml"): FernConfig {
  const configJson = JSON.stringify({
    organization: "vzw-demo",
    version: "0.x.x",
  }, null, 2);

  const generatorsYml = `api:
  specs:
    - openapi: ../${specPath}
`;

  const docsYml = `title: ${projectName} | Verizon Partner APIs

navigation:
  - api: API Reference

colors:
  accent-primary:
    light: "#EE0000"
    dark: "#FF3333"
  background:
    light: "#FFFFFF"
    dark: "#111111"
`;

  return { configJson, generatorsYml, docsYml };
}

export function generateProvisionWorkflow(
  config?: PortalConfig | null,
  options?: { fallbackTeamId?: string },
): string {
  const platformName = config?.platform?.name || "Portal";
  const committerName = config?.backend?.git_committer_name || `${platformName} Platform`;
  const committerEmail = config?.backend?.git_committer_email || "platform@postman.com";
  const fallbackTeamId = options?.fallbackTeamId || config?.backend?.fallback_team_id?.toString() || "13347347";

  // Governance group mapping: domain -> group UUID (Bifrost ruleset API).
  // These IDs must be created via the Bifrost governance API before use.
  // See docs/workspace-governance-rules.md for the create-group contract.
  let governanceMapping = '{}';
  if (config?.domains?.length) {
    const mapping: Record<string, string> = {};
    for (const d of config.domains) {
      if (d.value && d.governance_group) {
        mapping[d.value] = d.governance_group;
      }
    }
    governanceMapping = JSON.stringify(mapping);
  }

  return renderProvisionWorkflowTemplate({
    committerEmail,
    committerName,
    fallbackTeamId,
    governanceMapping,
  });
}

export function buildProvisionWorkflowDefinition(config?: PortalConfig | null): WorkflowDefinition {
  return parseYaml(generateProvisionWorkflow(config)) as WorkflowDefinition;
}
