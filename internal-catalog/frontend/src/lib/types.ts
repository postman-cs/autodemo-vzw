/**
 * Shared type definitions used across multiple frontend components.
 */

export type RuntimeMode = "lambda" | "ecs_service" | "k8s_workspace" | "k8s_discovery";
export type DeploymentMode = "single" | "graph";

export type PlannedNodeAction = "reuse" | "attach" | "provision" | "blocked";
export type PlannedNodeBlockedReason = "incompatible_runtime" | "invalid_state";

export interface PlannedNodePreview {
  key: string;
  spec_id: string;
  environment: string;
  runtime: RuntimeMode;
  layer_index: number;
  action: PlannedNodeAction;
  blocked_reason?: PlannedNodeBlockedReason;
  hard_dependencies: string[];
  soft_neighbors: string[];
}

export interface PlannedLayerPreview {
  layer_index: number;
  spec_ids: string[];
}

export interface SingleModeMissingPrerequisite {
  spec_id: string;
  environment: string;
  reason: "missing_active_deployment" | "blocked_incompatible_runtime" | "blocked_invalid_state";
}

export interface SingleModeGuidance {
  recommend_graph_mode: boolean;
  missing_hard_prerequisites: SingleModeMissingPrerequisite[];
}

export interface ProvisionPlan {
  deployment_mode: DeploymentMode;
  root_spec_id: string;
  runtime: RuntimeMode;
  environments: string[];
  hard_closure_spec_ids: string[];
  soft_neighbor_spec_ids: string[];
  layers: PlannedLayerPreview[];
  nodes: PlannedNodePreview[];
  summary: {
    total_nodes: number;
    reuse_count: number;
    attach_count: number;
    provision_count: number;
    blocked_count: number;
  };
  single_mode_guidance?: SingleModeGuidance;
}

export interface ProvisionPlanResponse {
  plan: ProvisionPlan;
  warnings?: string[];
}

export interface EnvironmentDeployment {
  environment: string;
  url?: string;
  runtime_url?: string;
  api_gateway_id?: string;
  postman_env_uid?: string;
  system_env_id?: string;
  status?: string;
  deployed_at?: string;
  branch?: string;
  /** Human-readable label for the system environment, if available. */
  system_env_name?: string;
}

export interface Deployment {
  spec_id: string;
  status: string;
  postman_team_slug?: string;
  runtime_mode?: string;
  runtime_base_url?: string;
  github_repo_name?: string;
  github_repo_url?: string;
  postman_workspace_url?: string;
  aws_invoke_url?: string;
  aws_region?: string;
  deployed_at?: string;
  environments_json?: string;
  environment_deployments?: string;
  chaos_enabled?: boolean;
  /** JSON map of environment slug → boolean, e.g. `{"prod":true,"stage":false}`. */
  chaos_enabled_map?: string;
  /** URL to the published Fern API docs for this service. */
  fern_docs_url?: string;
  /** URL to the Postman mock server for this service. */
  mock_url?: string;
}

export interface RuntimeConfig {
  mode: RuntimeMode;
  available: boolean;
  needsSetup?: boolean;
}

export interface EcsRuntimeConfig extends RuntimeConfig {
  activeServices: number;
  maxServices: number;
  remainingServices: number;
  unavailableReason?: string;
}

export interface K8sRuntimeConfig extends RuntimeConfig {
  namespace: string;
  unavailableReason?: string;
  activeServices?: number;
  sharedInfraActive?: boolean;
  sharedInfraStatus?: string;
  sharedInfraComponent?: string;
  daemonsetName?: string;
}

export interface ConfigData {
  aws_region?: string;
  github_org?: string;
  github_org_url?: string;
  runtime?: {
    lambda: RuntimeConfig;
    ecs_service: EcsRuntimeConfig;
    k8s_workspace: K8sRuntimeConfig;
    k8s_discovery: K8sRuntimeConfig;
  };
}

export type HealthStatus = "healthy" | "warning" | "invalid" | "stale" | "unchecked";

export interface TeamRegistryEntry {
  slug: string;
  team_id: string;
  team_name: string;
  system_env_id?: string;
  org_mode?: boolean;
  has_api_key?: boolean;
  has_access_token?: boolean;
  health_status?: HealthStatus;
  health_code?: string;
  health_message?: string;
  health_checked_at?: string;
  provisioning_blocked?: boolean;
  detected_org_mode?: boolean;
  workspace_team_count?: number;
}

export interface BatchRunState {
  running: boolean;
  total: number;
  completed: number;
  success: number;
  failed: number;
  queued: number;
  inFlight: number;
}

export interface BatchFailure {
  specId: string;
  title: string;
  message: string;
}

export interface BatchSummary {
  total: number;
  success: number;
  failed: number;
  failures: BatchFailure[];
}

export interface ResourceDescriptor {
  provider: "aws" | "kubernetes";
  kind: string;
  name: string;
  id?: string;
  arn?: string;
  region?: string;
  url?: string;
  metadata?: Record<string, string>;
}

export interface ResourceInventory {
  service: string;
  status: string;
  runtime_mode: RuntimeMode;
  generated_at: string;
  source: "airtable" | "derived";
  resources: ResourceDescriptor[];
}

export function runtimeLabel(mode: RuntimeMode): string {
  switch (mode) {
    case "ecs_service":
      return "ECS (ARM64)";
    case "k8s_workspace":
      return "Kubernetes (Workspace)";
    case "k8s_discovery":
      return "Kubernetes (Discovery)";
    default:
      return "Lambda";
  }
}

export interface RegistryEntry {
  id: string;
  title: string;
  description: string;
  industry: string;
  domain: string;
  filename: string;
  repo_name: string;
  endpoints: number;
}

export interface DeploymentsResponse {
  deployments?: Deployment[];
  recoverable_failures?: unknown[];
}

export interface TeamsRegistryResponse {
  teams?: TeamRegistryEntry[];
}

export function toCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
