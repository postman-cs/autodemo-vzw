import { describe, it, expect } from "vitest";
import { generateProvisionWorkflow, generateFernConfig } from "../src/lib/provision-workflow";
import {
  PROVISION_PHASE_LAST_STEPS,
  PROVISION_STEP_DESCRIPTIONS,
  PROVISION_STEP_PHASE_MAP,
  PROVISION_TRACKED_STEP_NAMES,
} from "../src/lib/provision-steps";
import type { ProvisionStepName } from "../src/lib/provision-steps";

function extractActionPaths(workflow: string): Set<string> {
  const paths = new Set<string>();
  for (const match of workflow.matchAll(/uses:\s+(.+)/gm)) {
    const path = match[1].trim();
    if (path.includes(".github/actions/")) paths.add(path);
  }
  return paths;
}

describe("generateProvisionWorkflow", () => {
  const workflow = generateProvisionWorkflow();

  it("returns a non-empty string", () => {
    expect(workflow.length).toBeGreaterThan(0);
  });

  it("declares required workflow_dispatch inputs", () => {
    const inputsSection = workflow.split("workflow_dispatch:")[1]?.split("concurrency:")[0] || "";
    expect(workflow).toContain("project_name:");
    expect(workflow).toContain("domain:");
    expect(workflow).toContain("domain_code:");
    expect(workflow).toContain("requester_email:");
    expect(workflow).toContain("spec_url:");
    expect(workflow).toContain("environments:");
    expect(workflow).toContain("system_env_map:");
    expect(workflow).toContain("runtime_mode:");
    expect(workflow).toContain("chaos_enabled:");
    expect(workflow).toContain("chaos_config:");
    expect(workflow).toContain("github_workspace_sync:");
    expect(workflow).toContain("environment_sync_enabled:");
    expect(workflow).toContain("k8s_discovery_workspace_link:");
    expect(workflow).toContain("dependency_targets_json:");
    expect(workflow).not.toContain("ecs_cluster_name:");
    expect(workflow).not.toContain("ecs_vpc_id:");
    expect(workflow).not.toContain("ecs_subnet_ids:");
    expect(workflow).not.toContain("ecs_security_group_ids:");
    expect(workflow).not.toContain("ecs_execution_role_arn:");
    expect(workflow).not.toContain("ecs_alb_listener_arn:");
    expect(workflow).not.toContain("ecs_alb_dns_name:");
    expect(workflow).not.toContain("ecs_ecr_repository:");
    expect(inputsSection).not.toContain("runtime_base_url:");
    expect(inputsSection).not.toContain("cleanup_on_failure:");
    expect(workflow).toContain('environment_sync_enabled: { required: false, type: string, default: "true" }');
  });

  it("contains split provisioning jobs", () => {
    expect(workflow).toContain("postman_bootstrap:");
    expect(workflow).toContain("docker_build:");
    expect(workflow).toContain("aws_deploy:");
    expect(workflow).toContain("finalize:");
  });

  it("pins aws_deploy and finalize runners", () => {
    const awsDeploySection = workflow.split("aws_deploy:")[1]?.split("\n  finalize:")[0] || "";
    const finalizeSection = workflow.split("finalize:")[1]?.split("\n  cleanup:")[0] || "";
    expect(awsDeploySection).toContain("runs-on: ubuntu-24.04-arm");
    expect(finalizeSection).toContain("runs-on: ubuntu-latest-8-cores");
    expect(finalizeSection).toContain("timeout-minutes: 8");
  });

  it("keeps Fern config local-only for provisioned repos", () => {
    const fernConfig = generateFernConfig("test-api");
    expect(fernConfig.docsYml).toContain("title: test-api | Verizon Partner APIs");
    expect(fernConfig.docsYml).not.toContain("instances:");
    expect(fernConfig.docsYml).not.toContain("verizon-demo.docs.buildwithfern.com");
  });

  it("aws_deploy job includes setup-python with pip cache for lambda mode", () => {
    const awsDeploySection = workflow.split("aws_deploy:")[1]?.split("\n  finalize:")[0] || "";
    expect(awsDeploySection).toContain("actions/setup-python@v6.2.0");
    expect(awsDeploySection).toContain("cache: 'pip'");
    expect(awsDeploySection).toContain("inputs.runtime_mode == 'lambda'");
  });

  it("passes multi-environment deploy contracts through aws_deploy and finalize", () => {
    const bootstrapSection = workflow.split("postman_bootstrap:")[1]?.split("\n  docker_build:")[0] || "";
    const awsDeploySection = workflow.split("aws_deploy:")[1]?.split("\n  finalize:")[0] || "";
    const finalizeSection = workflow.split("finalize:")[1]?.split("\n  cleanup:")[0] || "";
    const dockerSection = workflow.split("docker_build:")[1]?.split("\n  aws_deploy:")[0] || "";
    expect(dockerSection).toContain("outputs:");
    expect(dockerSection).toContain("image_uri: ${{ steps.docker_build.outputs.image_uri }}");
    expect(dockerSection).toContain("persist_repo_variables: 'false'");
    expect(bootstrapSection).toContain("postman_team_slug: ${{ inputs.postman_team_slug || vars.POSTMAN_TEAM_SLUG }}");
    expect(bootstrapSection).toContain("workspace-team-id: ${{ inputs.workspace_team_id }}");
    expect(awsDeploySection).toContain("environments: ${{ inputs.environments }}");
    expect(awsDeploySection).toContain("system_env_map: ${{ inputs.system_env_map }}");
    expect(awsDeploySection).toContain("chaos_enabled: ${{ inputs.chaos_enabled }}");
    expect(awsDeploySection).toContain("chaos_config: ${{ inputs.chaos_config }}");
    expect(awsDeploySection).toContain("github_workspace_sync: ${{ inputs.github_workspace_sync }}");
    expect(awsDeploySection).toContain("environment_sync_enabled: ${{ inputs.environment_sync_enabled }}");
    expect(awsDeploySection).toContain("image_uri: ${{ needs.docker_build.outputs.image_uri }}");
    expect(awsDeploySection).toContain("runtime_base_url: ${{ needs.docker_build.outputs.runtime_base_url }}");
    expect(awsDeploySection).toContain("service_name: ${{ needs.docker_build.outputs.service_name }}");
    expect(awsDeploySection).toContain("task_family: ${{ needs.docker_build.outputs.task_family }}");
    expect(awsDeploySection).toContain("target_group_name: ${{ needs.docker_build.outputs.target_group_name }}");
    expect(awsDeploySection).toContain("project_slug: ${{ needs.docker_build.outputs.project_slug }}");
    expect(awsDeploySection).toContain("persist_predeploy_env_repo_variables: 'false'");
    expect(awsDeploySection).toContain("env_runtime_urls_json: ${{ steps.deploy.outputs.env_runtime_urls_json }}");
    expect(awsDeploySection).toContain("environment_deployments_json: ${{ steps.deploy.outputs.environment_deployments_json }}");
    expect(awsDeploySection).toContain("gh_fallback_token: ${{ secrets.GH_TOKEN || '' }}");
    expect(awsDeploySection).toContain("BIFROST_ENV_ASSOCIATION_ENABLED: ${{ vars.BIFROST_ENV_ASSOCIATION_ENABLED || 'true' }}");
    expect(finalizeSection).not.toContain("chaos_enabled: ${{ inputs.chaos_enabled }}");
    expect(finalizeSection).toContain("github_workspace_sync: ${{ inputs.github_workspace_sync }}");
    expect(finalizeSection).toContain("environment_sync_enabled: ${{ inputs.environment_sync_enabled }}");
    expect(finalizeSection).toContain("image_uri: ${{ needs.aws_deploy.outputs.image_uri }}");
    expect(finalizeSection).toContain("ecs_target_group_arn: ${{ needs.aws_deploy.outputs.ecs_target_group_arn }}");
    expect(finalizeSection).toContain("ecs_listener_rule_arn: ${{ needs.aws_deploy.outputs.ecs_listener_rule_arn }}");
    expect(finalizeSection).toContain("ecs_task_definition: ${{ needs.aws_deploy.outputs.ecs_task_definition }}");
    expect(finalizeSection).toContain("k8s_namespace: ${{ needs.aws_deploy.outputs.k8s_namespace }}");
    expect(finalizeSection).toContain("k8s_deployment_name: ${{ needs.aws_deploy.outputs.k8s_deployment_name }}");
    expect(finalizeSection).toContain("k8s_service_name: ${{ needs.aws_deploy.outputs.k8s_service_name }}");
    expect(finalizeSection).toContain("k8s_ingress_name: ${{ needs.aws_deploy.outputs.k8s_ingress_name }}");
    expect(finalizeSection).toContain("env_uids: ${{ needs.aws_deploy.outputs.env_uids_json }}");
    expect(finalizeSection).toContain("BIFROST_ENV_ASSOCIATION_ENABLED: ${{ vars.BIFROST_ENV_ASSOCIATION_ENABLED || 'true' }}");
    expect(finalizeSection).toContain("env_runtime_urls_json: ${{ needs.aws_deploy.outputs.env_runtime_urls_json }}");
    expect(finalizeSection).toContain("environment_deployments_json: ${{ needs.aws_deploy.outputs.environment_deployments_json }}");
    expect(finalizeSection).toContain("gh_fallback_token: ${{ secrets.GH_TOKEN || '' }}");
  });

  it("keeps generated workflow under 380 lines for readability", () => {
    expect(workflow.split("\n").length).toBeLessThanOrEqual(380);
  });

  it("references all five composite actions", () => {
    const actionPaths = extractActionPaths(workflow);
    const expectedLocalActions = ["resolve-credentials", "docker-build", "aws-deploy", "finalize", "cleanup"];
    for (const action of expectedLocalActions) {
      const found = [...actionPaths].some((p) => p.includes(`./.actions/internal-catalog/.github/actions/${action}`));
      expect(found, `Action "${action}" not referenced in generated workflow`).toBe(true);
    }
    // postman-bootstrap is a published action, not a local composite action
    expect(workflow).toContain("postman-cs/postman-bootstrap-action@");
  });

  it("uses resolve-credentials plus single primary action per job", () => {
    const jobSections = {
      docker_build: workflow.split("docker_build:")[1]?.split("\n  aws_deploy:")[0] || "",
      aws_deploy: workflow.split("aws_deploy:")[1]?.split("\n  finalize:")[0] || "",
      finalize: workflow.split("finalize:")[1]?.split("\n  cleanup:")[0] || "",
    };
    for (const [jobName, section] of Object.entries(jobSections)) {
      const actionRefs = (section.match(/uses:\s+\.\/\.actions\/internal-catalog\/\.github\/actions\//g) || []).length;
      expect(actionRefs, `Job "${jobName}" should have exactly 2 action references (resolve-credentials + primary), found ${actionRefs}`).toBe(2);
      expect(section, `Job "${jobName}" must use resolve-credentials`).toContain("uses: ./.actions/internal-catalog/.github/actions/resolve-credentials");
    }
    // Bootstrap uses resolve-credentials (local) + postman-bootstrap-action (published)
    const bootstrapSection = workflow.split("postman_bootstrap:")[1]?.split("\n  docker_build:")[0] || "";
    expect(bootstrapSection).toContain("uses: ./.actions/internal-catalog/.github/actions/resolve-credentials");
    expect(bootstrapSection).toContain("postman-cs/postman-bootstrap-action@");
  });

  it("uses checkout-with-token pattern and main default ref", () => {
    expect(workflow).toContain("repository: postman-cs/vzw-partner-demo");
    expect(workflow).toContain("path: .actions");
    expect(workflow).toContain("token: ${{ secrets.GH_TOKEN }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("ref: ${{ vars.PROVISION_ACTIONS_REF || 'main' }}");
  });

  it("uses non-persisted credentials for same-repo finalize checkout", () => {
    const finalizeSection = workflow.split("finalize:")[1]?.split("\n  cleanup:")[0] || "";
    expect(finalizeSection).toContain("- uses: actions/checkout@v6.0.2");
    expect(finalizeSection).toContain("with:");
    expect(finalizeSection).toContain("token: ${{ github.token }}");
    expect(finalizeSection).toContain("persist-credentials: false");
    expect(finalizeSection).toContain("push_token: ${{ secrets.GH_TOKEN }}");
  });

  it("finalize job tolerates skipped aws_deploy", () => {
    const finalizeSection = workflow.slice(workflow.indexOf("finalize:"));
    expect(finalizeSection).toContain("needs.postman_bootstrap.result == 'success' || needs.postman_bootstrap.result == 'skipped'");
    expect(finalizeSection).toContain("needs.aws_deploy.result == 'success' || needs.aws_deploy.result == 'skipped'");
  });

  it("contains the cleanup job for failure", () => {
    expect(workflow).toContain("cleanup:");
    expect(workflow).toContain("if: ${{ failure() && vars.CLEANUP_ON_FAILURE == 'true' }}");
  });

  it("contains only valid GitHub Actions expression contexts", () => {
    // GitHub Actions expressions (${{ }}) can only reference known contexts:
    // steps, inputs, secrets, env, github, needs, runner, matrix, strategy, job
    const VALID_CONTEXTS = [
      "steps", "inputs", "secrets", "env", "github", "needs",
      "runner", "matrix", "strategy", "job", "vars", "format", "failure",
      "always", "cancelled", "success", "contains",
    ];
    // Match all ${{ ... }} expressions (after TypeScript template literal unescaping,
    // the generated YAML has literal ${{ ... }} -- but in the TS source they appear as \${{ ... }}).
    // In the generated string, they are actual ${{ ... }}.
    const exprRegex = /\$\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)/g;
    const foundContexts = new Set<string>();
    for (const match of workflow.matchAll(exprRegex)) {
      const context = match[1];
      if (!context) continue;
      foundContexts.add(context);
    }
    for (const ctx of foundContexts) {
      expect(
        VALID_CONTEXTS.includes(ctx),
        `Invalid GitHub Actions expression context: '${ctx}' -- only ${VALID_CONTEXTS.join(", ")} are allowed`
      ).toBe(true);
    }
  });

  it("uses only supported top-level GITHUB_TOKEN permission scopes", () => {
    const permissionsSection = workflow.split("permissions:")[1]?.split("concurrency:")[0] || "";
    const permissionKeys = [...permissionsSection.matchAll(/^\s{2}([a-zA-Z-]+):\s+(read|write|none)\s*$/gm)]
      .map((match) => match[1]);
    const validScopes = new Set([
      "actions",
      "attestations",
      "checks",
      "contents",
      "deployments",
      "discussions",
      "id-token",
      "issues",
      "models",
      "packages",
      "pages",
      "pull-requests",
      "repository-projects",
      "security-events",
      "statuses",
    ]);

    expect(permissionKeys.length).toBeGreaterThan(0);
    for (const key of permissionKeys) {
      expect(validScopes.has(key), `Unsupported workflow permission scope: ${key}`).toBe(true);
    }
    expect(permissionKeys).not.toContain("workflows");
  });



  describe("credential availability regression guards", () => {
    it("maps static AWS secrets into every resolve-credentials step", () => {
      const resolveStepCount = (workflow.match(/- name: Resolve Credentials/g) || []).length;
      const accessKeyEnvCount = (workflow.match(/AWS_ACCESS_KEY_ID: "\$\{\{ vars\.OIDC_AWS_ENABLED != 'true' && secrets\.AWS_ACCESS_KEY_ID \|\| '' \}\}"/g) || []).length;
      const secretKeyEnvCount = (workflow.match(/AWS_SECRET_ACCESS_KEY: "\$\{\{ vars\.OIDC_AWS_ENABLED != 'true' && secrets\.AWS_SECRET_ACCESS_KEY \|\| '' \}\}"/g) || []).length;

      expect(resolveStepCount).toBeGreaterThan(0);
      expect(accessKeyEnvCount).toBe(resolveStepCount);
      expect(secretKeyEnvCount).toBe(resolveStepCount);
    });

    it("postman_bootstrap job resolves credentials and passes them via env", () => {
      const bootstrapSection = workflow.split("postman_bootstrap:")[1]?.split("docker_build:")[0] || "";
      expect(bootstrapSection).toContain("uses: ./.actions/internal-catalog/.github/actions/resolve-credentials");
      expect(bootstrapSection).toContain("postman-api-key: ${{ env.POSTMAN_API_KEY }}");
      expect(bootstrapSection).toContain("postman-access-token: ${{ env.POSTMAN_ACCESS_TOKEN }}");
    });

    it("docker_build job gates AWS key secrets and enables OIDC", () => {
      const dockerSection = workflow.split("docker_build:")[1]?.split("aws_deploy:")[0] || "";
      expect(dockerSection).toContain("Configure AWS credentials (OIDC)");
    expect(dockerSection).toContain("aws-actions/configure-aws-credentials@v6.0.0");
      expect(dockerSection).toContain("aws_access_key_id: ${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_ACCESS_KEY_ID || '' }}");
      expect(dockerSection).toContain("aws_secret_access_key: ${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_SECRET_ACCESS_KEY || '' }}");
      expect(dockerSection).toContain("gh_fallback_token: ${{ secrets.GH_TOKEN || '' }}");
    });

    it("aws_deploy job passes all required secrets", () => {
      const awsDeploySection = workflow.split("aws_deploy:")[1]?.split("finalize:")[0] || "";
      expect(awsDeploySection).toContain("Configure AWS credentials (OIDC)");
      expect(awsDeploySection).toContain("aws_access_key_id: ${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_ACCESS_KEY_ID || '' }}");
      expect(awsDeploySection).toContain("aws_secret_access_key: ${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_SECRET_ACCESS_KEY || '' }}");
      expect(awsDeploySection).toContain("postman_api_key: ${{ env.POSTMAN_API_KEY }}");
      expect(awsDeploySection).toContain("postman_access_token: ${{ env.POSTMAN_ACCESS_TOKEN }}");
      expect(awsDeploySection).toContain("github_app_token: ${{ github.token }}");
      expect(awsDeploySection).toContain("gh_fallback_token: ${{ secrets.GH_TOKEN || '' }}");
      expect(awsDeploySection).toContain("gh_auth_mode: ${{ vars.GH_AUTH_MODE || 'github_token_first' }}");
    });

    it("finalize job passes Postman and Fern secrets", () => {
      const finalizeSection = workflow.split("finalize:")[1]?.split("cleanup:")[0] || "";
      expect(finalizeSection).toContain("postman_api_key: ${{ env.POSTMAN_API_KEY }}");
      expect(finalizeSection).toContain("postman_access_token: ${{ env.POSTMAN_ACCESS_TOKEN }}");
      expect(finalizeSection).toContain("github_app_token: ${{ github.token }}");
      expect(finalizeSection).toContain("gh_fallback_token: ${{ secrets.GH_TOKEN || '' }}");
      expect(finalizeSection).toContain("gh_auth_mode: ${{ vars.GH_AUTH_MODE || 'github_token_first' }}");
      expect(finalizeSection).toContain("fern_token: ${{ secrets.FERN_TOKEN }}");
    });

    it("cleanup job passes AWS and Postman cleanup secrets", () => {
      const cleanupSection = workflow.split("cleanup:")[1] || "";
      expect(cleanupSection).toContain("postman_api_key: ${{ env.POSTMAN_API_KEY }}");
      expect(cleanupSection).toContain("aws_access_key_id: ${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_ACCESS_KEY_ID || '' }}");
      expect(cleanupSection).toContain("aws_secret_access_key: ${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_SECRET_ACCESS_KEY || '' }}");
    });

    it("all jobs invoke resolve-credentials with required inputs", () => {
      const jobs = ["postman_bootstrap", "docker_build", "aws_deploy", "finalize", "cleanup"];
      for (const job of jobs) {
        const startIdx = workflow.indexOf(`${job}:`);
        const nextJobIdx = jobs.indexOf(job) < jobs.length - 1
          ? workflow.indexOf(`${jobs[jobs.indexOf(job) + 1]}:`, startIdx + 1)
          : workflow.length;
        const section = workflow.slice(startIdx, nextJobIdx);
        expect(section, `${job} must use resolve-credentials`).toContain("uses: ./.actions/internal-catalog/.github/actions/resolve-credentials");
        expect(section, `${job} must pass postman_team_slug`).toContain("postman_team_slug:");
        expect(section, `${job} must pass aws_region`).toContain("aws_region:");
      }
    });
  });
});

describe("provision workflow step contract", () => {
  const workflow = generateProvisionWorkflow();

  it("references actions rather than inline steps", () => {
    // Step names like "Install Postman CLI" are internal to the composite actions;
    // the generated workflow only has job-level step names.
    const actionPaths = extractActionPaths(workflow);
    expect(actionPaths.size).toBeGreaterThanOrEqual(5);
  });

  it("keeps metadata contract in sync for descriptions, phase mapping, and terminal phase steps", () => {
    const tracked = new Set(PROVISION_TRACKED_STEP_NAMES);
    const phaseMapKeys = Object.keys(PROVISION_STEP_PHASE_MAP);
    const descriptionKeys = Object.keys(PROVISION_STEP_DESCRIPTIONS);
    expect(new Set(phaseMapKeys)).toEqual(tracked);
    expect(new Set(descriptionKeys)).toEqual(tracked);

    for (const terminalSteps of Object.values(PROVISION_PHASE_LAST_STEPS)) {
      for (const stepName of terminalSteps) {
        expect(tracked.has(stepName as ProvisionStepName)).toBe(true);
      }
    }
  });

  it("predeploy steps in phase map use canonical names", () => {
    expect(PROVISION_STEP_PHASE_MAP["Connect Workspace via Bifrost (Pre-Deploy)"]).toBe("aws");
    expect(PROVISION_STEP_PHASE_MAP["Associate Workspace Environment with System Env (Pre-Deploy)"]).toBe("aws");
  });
});

describe("shared ECS infra setup workflow file", () => {
  it("includes required dispatch inputs, concurrency, and key setup steps", async () => {
    const workflow = (await import("../.github/workflows/ecs-infra-setup.yml?raw")).default as string;
    expect(workflow).toContain("name: ECS Shared Infrastructure Setup");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("aws_region:");
    expect(workflow).toContain("resource_prefix:");
    expect(workflow).toContain("group: ecs-infra-lifecycle");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("uses: aws-actions/configure-aws-credentials@v6.0.0");
    expect(workflow).toContain("AIRTABLE_API_KEY");
    expect(workflow).toContain("AIRTABLE_BASE_ID");
    expect(workflow).toContain("set -euo pipefail");
    expect(workflow).toContain("ResourceGroup=vzw-partner-demo");
    expect(workflow).toContain("Upsert Airtable record (provisioning)");
    expect(workflow).toContain("Update Airtable record (active)");
    expect(workflow).toContain("Create ECR repository");
    expect(workflow).toContain("Create ECS cluster");
    expect(workflow).toContain("Create ALB listener");
    expect(workflow).toContain("Create CloudWatch log group");
  });
});

describe("shared ECS infra teardown workflow file", () => {
  it("includes required dispatch inputs, concurrency, and key teardown guards", async () => {
    const workflow = (await import("../.github/workflows/ecs-infra-teardown.yml?raw")).default as string;
    expect(workflow).toContain("name: ECS Shared Infrastructure Teardown");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("aws_region:");
    expect(workflow).toContain("resource_prefix:");
    expect(workflow).toContain("airtable_record_id:");
    expect(workflow).toContain("group: ecs-infra-lifecycle");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("uses: aws-actions/configure-aws-credentials@v6.0.0");
    expect(workflow).toContain("Read Airtable record");
    expect(workflow).toContain("Mark Airtable tearing_down");
    expect(workflow).toContain("Check for active ECS services");
    expect(workflow).toContain("Delete ALB listener rules");
    expect(workflow).toContain("Delete ALB listener");
    expect(workflow).toContain("Delete ALB");
    expect(workflow).toContain("Delete target groups");
    expect(workflow).toContain("Delete ECS cluster");
    expect(workflow).toContain("Delete ECR repository");
    expect(workflow).toContain("Delete security groups");
    expect(workflow).toContain("Delete IAM roles");
    expect(workflow).toContain("Delete CloudWatch log group");
    expect(workflow).toContain("Delete Airtable record");
  });
});

describe("shared Kubernetes discovery infra workflow files", () => {
  it("setup workflow sanitizes kubeconfig profile references", async () => {
    const workflow = (await import("../.github/workflows/k8s-discovery-infra-setup.yml?raw")).default as string;
    expect(workflow).toContain("name: Kubernetes Discovery Shared Infrastructure Setup");
    expect(workflow).toContain("Configure kubeconfig");
    expect(workflow).toContain("sed -i '/^[[:space:]]*- --profile=.*/d' \"$HOME/.kube/config\"");
    expect(workflow).toContain("sed -i '/^[[:space:]]*- name: AWS_PROFILE$/ {N;d;}' \"$HOME/.kube/config\"");
    expect(workflow).toContain("sed -i '/^[[:space:]]*- name: AWS_DEFAULT_PROFILE$/ {N;d;}' \"$HOME/.kube/config\"");
    expect(workflow).toContain("kubeconfig still contains AWS profile references after sanitization");
  });

  it("teardown workflow sanitizes kubeconfig profile references", async () => {
    const workflow = (await import("../.github/workflows/k8s-discovery-infra-teardown.yml?raw")).default as string;
    expect(workflow).toContain("name: Kubernetes Discovery Shared Infrastructure Teardown");
    expect(workflow).toContain("Configure kubeconfig");
    expect(workflow).toContain("sed -i '/^[[:space:]]*- --profile=.*/d' \"$HOME/.kube/config\"");
    expect(workflow).toContain("sed -i '/^[[:space:]]*- name: AWS_PROFILE$/ {N;d;}' \"$HOME/.kube/config\"");
    expect(workflow).toContain("sed -i '/^[[:space:]]*- name: AWS_DEFAULT_PROFILE$/ {N;d;}' \"$HOME/.kube/config\"");
    expect(workflow).toContain("kubeconfig still contains AWS profile references after sanitization");
  });
});
