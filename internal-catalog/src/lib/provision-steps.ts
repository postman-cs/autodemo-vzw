export type ProvisionPhase = "postman" | "spec" | "aws" | "postman-env" | "sync" | "complete";

export const PROVISION_STEP_NAMES = {
  INSTALL_POSTMAN_CLI: "Install Postman CLI",
  CREATE_POSTMAN_WORKSPACE: "Create Postman Workspace",
  ASSIGN_WORKSPACE_TO_GOVERNANCE_GROUP: "Assign Workspace to Governance Group",
  INVITE_REQUESTER_TO_WORKSPACE: "Invite Requester to Workspace",
  ADD_TEAM_ADMINS_TO_WORKSPACE: "Add Team Admins to Workspace",
  UPLOAD_SPEC_TO_SPEC_HUB: "Upload Spec to Spec Hub",
  LINT_SPEC_VIA_POSTMAN_CLI: "Lint Spec via Postman CLI",
  GENERATE_COLLECTIONS_FROM_SPEC: "Generate Collections from Spec",
  INJECT_TEST_SCRIPTS_AND_REQUEST_0: "Inject Test Scripts & Request 0",
  TAG_COLLECTIONS: "Tag Collections",
  STORE_POSTMAN_UIDS_AS_REPO_VARIABLES: "Store Postman UIDs as Repo Variables",
  CREATE_INSIGHTS_PROJECT: "Create Insights Project",
  CONFIGURE_AWS_CREDENTIALS: "Configure AWS Credentials",
  PREFLIGHT_ECS_SHARED_INFRASTRUCTURE: "Preflight ECS Shared Infrastructure",
  VALIDATE_INSIGHTS_WORKSPACE_CONFIGURATION: "Validate Insights Workspace Configuration",
  CREATE_POSTMAN_ENVIRONMENTS_ECS_PREDEPLOY: "Create Postman Environments (ECS Pre-Deploy)",
  CONNECT_WORKSPACE_VIA_BIFROST_PREDEPLOY: "Connect Workspace via Bifrost (Pre-Deploy)",
  ASSOCIATE_WORKSPACE_ENVIRONMENT_WITH_SYSTEM_ENV_PREDEPLOY: "Associate Workspace Environment with System Env (Pre-Deploy)",
  BUILD_AND_DEPLOY_ECS_SERVICE_ARM64: "Build & Deploy ECS Service (ARM64)",
  VERIFY_INSIGHTS_SIDECAR_ON_ECS_SERVICE: "Verify Insights Sidecar on ECS Service",
  PERSIST_ECS_ARNS_AS_REPO_VARIABLES: "Persist ECS ARNs as Repo Variables",
  CONFIGURE_KUBECONFIG: "Configure Kubeconfig",
  VALIDATE_DISCOVERY_SHARED_INFRASTRUCTURE: "Validate Discovery Shared Infrastructure",
  DEPLOY_KUBERNETES_WORKLOAD: "Deploy Kubernetes Workload",
  INJECT_INSIGHTS_SIDECAR: "Inject Insights Sidecar",
  APPLY_DISCOVERY_WORKLOAD: "Apply Discovery Workload",
  WAIT_ROLLOUT: "Wait Rollout",
  HEALTH_CHECK_KUBERNETES: "Health Check Kubernetes",
  REFRESH_K8S_CONFIG_MAP: "Refresh Kubernetes ConfigMap",
  CREATE_IAM_EXECUTION_ROLE: "Create IAM Execution Role",
  PACKAGE_LAMBDA: "Package Lambda",
  DEPLOY_LAMBDA_FUNCTIONS: "Deploy Lambda Functions",
  HEALTH_CHECK: "Health Check",
  HEALTH_CHECK_ECS_SERVICE: "Health Check ECS Service",
  CREATE_POSTMAN_ENVIRONMENTS: "Create Postman Environments",
  CREATE_MOCK_SERVER: "Create Mock Server",
  CREATE_SMOKE_MONITOR: "Create Smoke Monitor",
  STORE_AWS_OUTPUTS_AS_REPO_VARIABLES: "Store AWS Outputs as Repo Variables",
  EXPORT_POSTMAN_ARTIFACTS_TO_REPO: "Export Postman Artifacts to Repo",
  CONNECT_WORKSPACE_VIA_BIFROST: "Connect Workspace via Bifrost",
  GENERATE_FERN_DOCS: "Generate Fern Docs",
  COMMIT_ARTIFACTS_AND_REPLACE_PROVISION_WITH_CI_WORKFLOW: "Commit Artifacts & Replace Provision with CI Workflow",
  SUMMARY: "Summary",
} as const;

export type ProvisionStepName = (typeof PROVISION_STEP_NAMES)[keyof typeof PROVISION_STEP_NAMES];

interface ProvisionSseStep {
  completesPhase?: boolean;
  description: string;
  name: ProvisionStepName;
  phase: ProvisionPhase;
}

export const PROVISION_SSE_STEPS: readonly ProvisionSseStep[] = [
  {
    name: PROVISION_STEP_NAMES.INSTALL_POSTMAN_CLI,
    description: "Installing Postman CLI on runner",
    phase: "postman",
  },
  {
    name: PROVISION_STEP_NAMES.CREATE_POSTMAN_WORKSPACE,
    description: "Creating team workspace",
    phase: "postman",
  },
  {
    name: PROVISION_STEP_NAMES.ASSIGN_WORKSPACE_TO_GOVERNANCE_GROUP,
    description: "Assigning workspace to governance group",
    phase: "postman",
  },
  {
    name: PROVISION_STEP_NAMES.INVITE_REQUESTER_TO_WORKSPACE,
    description: "Granting requester editor access",
    phase: "postman",
  },
  {
    name: PROVISION_STEP_NAMES.ADD_TEAM_ADMINS_TO_WORKSPACE,
    description: "Adding team admins to workspace",
    phase: "postman",
    completesPhase: true,
  },
  {
    name: PROVISION_STEP_NAMES.UPLOAD_SPEC_TO_SPEC_HUB,
    description: "Uploading OpenAPI spec to Spec Hub",
    phase: "spec",
  },
  {
    name: PROVISION_STEP_NAMES.LINT_SPEC_VIA_POSTMAN_CLI,
    description: "Validating spec against governance rules",
    phase: "spec",
  },
  {
    name: PROVISION_STEP_NAMES.GENERATE_COLLECTIONS_FROM_SPEC,
    description: "Generating Baseline, Smoke, and Contract collections",
    phase: "spec",
  },
  {
    name: PROVISION_STEP_NAMES.INJECT_TEST_SCRIPTS_AND_REQUEST_0,
    description: "Injecting test scripts and secrets resolver",
    phase: "spec",
  },
  {
    name: PROVISION_STEP_NAMES.TAG_COLLECTIONS,
    description: "Tagging collections (generated, smoke, contract)",
    phase: "spec",
  },
  {
    name: PROVISION_STEP_NAMES.STORE_POSTMAN_UIDS_AS_REPO_VARIABLES,
    description: "Storing Postman UIDs as repo variables",
    phase: "spec",
    completesPhase: true,
  },
  {
    name: PROVISION_STEP_NAMES.CREATE_INSIGHTS_PROJECT,
    description: "Creating Insights project for API observability",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.CONFIGURE_AWS_CREDENTIALS,
    description: "Configuring AWS credentials",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.PREFLIGHT_ECS_SHARED_INFRASTRUCTURE,
    description: "Validating shared ECS infrastructure and capacity",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.VALIDATE_INSIGHTS_WORKSPACE_CONFIGURATION,
    description: "Validating Insights workspace-mode configuration",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.CREATE_POSTMAN_ENVIRONMENTS_ECS_PREDEPLOY,
    description: "Creating Postman environment before ECS sidecar onboarding",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.CONNECT_WORKSPACE_VIA_BIFROST_PREDEPLOY,
    description: "Linking Postman workspace to repository before Insights onboarding (Pre-Deploy)",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.ASSOCIATE_WORKSPACE_ENVIRONMENT_WITH_SYSTEM_ENV_PREDEPLOY,
    description: "Associating environments with system environments (Pre-Deploy)",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.BUILD_AND_DEPLOY_ECS_SERVICE_ARM64,
    description: "Building ARM64 image and deploying dedicated ECS service",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.VERIFY_INSIGHTS_SIDECAR_ON_ECS_SERVICE,
    description: "Verifying Insights sidecar is running on ECS tasks",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.PERSIST_ECS_ARNS_AS_REPO_VARIABLES,
    description: "Persisting ECS resource ARNs to repo variables",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.CONFIGURE_KUBECONFIG,
    description: "Configuring Kubernetes access credentials for deployment",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.VALIDATE_DISCOVERY_SHARED_INFRASTRUCTURE,
    description: "Validating shared Kubernetes discovery infrastructure is active",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.DEPLOY_KUBERNETES_WORKLOAD,
    description: "Deploying workload manifests to the Kubernetes runtime",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.INJECT_INSIGHTS_SIDECAR,
    description: "Injecting Insights sidecar for Kubernetes workspace-mode onboarding",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.APPLY_DISCOVERY_WORKLOAD,
    description: "Deploying discovery-mode workload manifests to the Kubernetes runtime",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.WAIT_ROLLOUT,
    description: "Waiting for Kubernetes rollout to complete",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.HEALTH_CHECK_KUBERNETES,
    description: "Running health checks against the Kubernetes service endpoint",
    phase: "aws",
    completesPhase: true,
  },
  {
    name: PROVISION_STEP_NAMES.CREATE_IAM_EXECUTION_ROLE,
    description: "Creating Lambda execution role",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.PACKAGE_LAMBDA,
    description: "Packaging Flask app for Lambda",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.DEPLOY_LAMBDA_FUNCTIONS,
    description: "Deploying Lambda functions with API Gateway",
    phase: "aws",
  },
  {
    name: PROVISION_STEP_NAMES.HEALTH_CHECK,
    description: "Running health checks against deployed functions",
    phase: "aws",
    completesPhase: true,
  },
  {
    name: PROVISION_STEP_NAMES.HEALTH_CHECK_ECS_SERVICE,
    description: "Running health checks against dedicated ECS service",
    phase: "aws",
    completesPhase: true,
  },
  {
    name: PROVISION_STEP_NAMES.CREATE_POSTMAN_ENVIRONMENTS,
    description: "Creating Postman environments with deploy URLs",
    phase: "postman-env",
  },
  {
    name: PROVISION_STEP_NAMES.CREATE_MOCK_SERVER,
    description: "Creating mock server from baseline collection",
    phase: "postman-env",
  },
  {
    name: PROVISION_STEP_NAMES.CREATE_SMOKE_MONITOR,
    description: "Creating smoke test monitor from collection",
    phase: "postman-env",
    completesPhase: true,
  },
  {
    name: PROVISION_STEP_NAMES.STORE_AWS_OUTPUTS_AS_REPO_VARIABLES,
    description: "Storing deploy URLs as repo variables",
    phase: "sync",
  },
  {
    name: PROVISION_STEP_NAMES.EXPORT_POSTMAN_ARTIFACTS_TO_REPO,
    description: "Exporting collections and environments to repo",
    phase: "sync",
  },
  {
    name: PROVISION_STEP_NAMES.CONNECT_WORKSPACE_VIA_BIFROST,
    description: "Connecting workspace to source control",
    phase: "sync",
  },
  {
    name: PROVISION_STEP_NAMES.GENERATE_FERN_DOCS,
    description: "Generating API documentation via Fern",
    phase: "sync",
  },
  {
    name: PROVISION_STEP_NAMES.COMMIT_ARTIFACTS_AND_REPLACE_PROVISION_WITH_CI_WORKFLOW,
    description: "Committing CI/CD pipeline, removing provisioning workflow",
    phase: "sync",
    completesPhase: true,
  },
  {
    name: PROVISION_STEP_NAMES.SUMMARY,
    description: "Generating provisioning summary",
    phase: "complete",
  },
];

export const PROVISION_TRACKED_STEP_NAMES = PROVISION_SSE_STEPS.map((step) => step.name);

export const PROVISION_STEP_DESCRIPTIONS: Record<string, string> = Object.fromEntries(
  PROVISION_SSE_STEPS.map((step) => [step.name, step.description])
);

export const PROVISION_STEP_PHASE_MAP: Record<string, ProvisionPhase> = Object.fromEntries(
  PROVISION_SSE_STEPS.map((step) => [step.name, step.phase])
) as Record<string, ProvisionPhase>;

const phaseLastSteps: Record<string, string[]> = {};
for (const step of PROVISION_SSE_STEPS) {
  if (!step.completesPhase) continue;
  (phaseLastSteps[step.phase] ||= []).push(step.name);
}
export const PROVISION_PHASE_LAST_STEPS = phaseLastSteps;
