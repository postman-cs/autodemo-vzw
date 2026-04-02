import type { DeploymentRecord } from "./airtable";
import {
  isContainerRuntime,
  normalizeRuntimeMode,
  type CanonicalRuntimeMode,
} from "./config";
import {
  normalizeEnvironmentDeployment,
  parseEnvironmentDeploymentsJson,
  type EnvironmentDeploymentRecord,
} from "./environment-deployments";
import { getEnvironmentBranchName } from "./environment-branches";
import { getOrg, listRepoVariables } from "./github";

export interface FinalProvisionData {
  [key: string]: unknown;
  project: string;
  runtime: {
    mode: CanonicalRuntimeMode;
    base_url: string;
  };
  chaos_enabled: boolean;
  chaos_config: string;
  environment_deployments: EnvironmentDeploymentRecord[];
  postman: {
    workspace_url: string;
    spec_uid: string;
    baseline_uid: string;
    smoke_uid: string;
    contract_uid: string;
    run_url: string;
    mock_url: string;
  };
  github: {
    repo_url: string;
  };
  aws: {
    invoke_url: string;
    api_gateway_id: string;
    function_name: string;
    ecs_cluster_name: string;
    ecs_service_name: string;
    ecs_task_definition: string;
    ecs_target_group_arn: string;
    ecs_listener_rule_arn: string;
  };
  lint: {
    warnings: number;
    errors: number;
  };
  fern: {
    docs_url: string;
  };
}

export interface FinalDeploymentSnapshot {
  repoVariables: Record<string, string>;
  finalData: FinalProvisionData;
  airtableFields: Partial<Omit<DeploymentRecord, "id">>;
  environmentDeployments: EnvironmentDeploymentRecord[];
  runtimeMode: CanonicalRuntimeMode;
  runtimeBaseUrl: string;
  invokeUrl: string;
  hasSuccessMarkers: boolean;
}

interface BuildFinalDeploymentSnapshotOptions {
  token: string;
  repoName: string;
  projectName?: string;
  requestedEnvironments?: string[];
  defaultAwsRegion?: string;
  existingRecord?: Pick<DeploymentRecord, "environment_deployments" | "environments_json"> | null;
}

function parseVarJsonMap(raw: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed || {})) {
      const normalizedKey = String(key || "").trim();
      const normalizedValue = String(value || "").trim();
      if (normalizedKey && normalizedValue) {
        result[normalizedKey] = normalizedValue;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function normalizeRequestedEnvironments(raw: string[] | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(raw.map((value) => String(value || "").trim()).filter(Boolean)));
}

function uniqueEnvironments(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function parseEnvList(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.map((value) => String(value || "").trim()).filter(Boolean)));
  } catch {
    return [];
  }
}

function hasActiveEnvironmentDeployment(environmentDeployments: EnvironmentDeploymentRecord[]): boolean {
  return environmentDeployments.some((deployment) => {
    const status = String(deployment.status || "").trim().toLowerCase();
    return (status === "" || status === "active") && Boolean(deployment.runtime_url || deployment.url);
  });
}

function buildEnvironmentDeployments(
  vars: Record<string, string>,
  runtimeMode: CanonicalRuntimeMode,
  requestedEnvironments: string[],
): EnvironmentDeploymentRecord[] {
  const envUidMap = parseVarJsonMap(vars.POSTMAN_ENV_UIDS_JSON || "");
  const envBranchMap = parseVarJsonMap(vars.ENV_BRANCH_MAP_JSON || "");
  if (!envUidMap.prod && vars.POSTMAN_ENVIRONMENT_UID) {
    envUidMap.prod = vars.POSTMAN_ENVIRONMENT_UID;
  }

  const explicitEnvironmentDeployments = parseEnvironmentDeploymentsJson(vars.ENVIRONMENT_DEPLOYMENTS_JSON || "");
  if (explicitEnvironmentDeployments.length > 0) {
    return explicitEnvironmentDeployments.map((deployment) => {
      if (deployment.branch) return deployment;
      return {
        ...deployment,
        branch: envBranchMap[deployment.environment] || getEnvironmentBranchName(deployment.environment),
      };
    });
  }

  const targetEnvironments = requestedEnvironments.length > 0
    ? requestedEnvironments
    : (Object.keys(envUidMap).length > 0 ? Object.keys(envUidMap) : ["prod"]);

  return targetEnvironments.map((slug) => {
    let envUrl = vars.RUNTIME_BASE_URL || "";
    let apiId = "";
    if (runtimeMode === "lambda") {
      const slugUpper = slug.toUpperCase();
      envUrl = vars[`${slugUpper}_GW_URL`] || (slug === "prod" ? vars.PROD_GW_URL : vars.DEV_GW_URL) || "";
      apiId = vars[`${slugUpper}_API_ID`] || (slug === "prod" ? vars.PROD_API_ID : vars.DEV_API_ID) || "";
    }

    const slugUpper = slug.toUpperCase();
    const normalizedRuntimeUrl = envUrl.replace(/\/+$/, "");
    const postmanEnvUid = envUidMap[slug] || (slug === "prod" ? vars.POSTMAN_ENVIRONMENT_UID || "" : "");
    const systemEnvId = vars[`POSTMAN_SYSTEM_ENV_${slugUpper}`] || (slug === "prod" ? vars.POSTMAN_SYSTEM_ENV_PROD || "" : "");
    return normalizeEnvironmentDeployment({
      environment: slug,
      runtime_url: normalizedRuntimeUrl,
      url: normalizedRuntimeUrl,
      api_gateway_id: apiId,
      postman_env_uid: postmanEnvUid,
      system_env_id: systemEnvId,
      status: normalizedRuntimeUrl ? "active" : "pending",
      deployed_at: "",
      branch: envBranchMap[slug] || getEnvironmentBranchName(slug),
    }) || {
      environment: slug,
      runtime_url: normalizedRuntimeUrl,
      url: normalizedRuntimeUrl,
      branch: envBranchMap[slug] || getEnvironmentBranchName(slug),
    };
  });
}

function mergeEnvironmentDeployments(
  current: EnvironmentDeploymentRecord[],
  existingRecord: Pick<DeploymentRecord, "environment_deployments" | "environments_json"> | null | undefined,
): EnvironmentDeploymentRecord[] {
  const existing = parseEnvironmentDeploymentsJson(existingRecord?.environment_deployments || "").map((deployment) => ({
    ...deployment,
    branch: deployment.branch || getEnvironmentBranchName(deployment.environment),
  }));

  if (existing.length === 0) return current;

  const merged = new Map<string, EnvironmentDeploymentRecord>();
  for (const deployment of existing) {
    merged.set(deployment.environment, deployment);
  }
  for (const deployment of current) {
    merged.set(deployment.environment, deployment);
  }

  return [...merged.values()].sort((a, b) => a.environment.localeCompare(b.environment));
}

export async function buildFinalDeploymentSnapshot(
  options: BuildFinalDeploymentSnapshotOptions,
): Promise<FinalDeploymentSnapshot> {
  const vars = await listRepoVariables(options.token, options.repoName);
  const runtimeMode = normalizeRuntimeMode(vars.RUNTIME_MODE);
  const requestedEnvironments = normalizeRequestedEnvironments(options.requestedEnvironments);
  const environmentDeployments = mergeEnvironmentDeployments(
    buildEnvironmentDeployments(vars, runtimeMode, requestedEnvironments),
    options.existingRecord,
  );
  const primaryEnvironmentDeployment = environmentDeployments.find((deployment) => deployment.environment === "prod")
    || environmentDeployments[0];
  const activeEnvironments = environmentDeployments.map((deployment) => deployment.environment);

  const derivedRuntimeBaseUrl = (vars.RUNTIME_BASE_URL || "").replace(/\/+$/, "")
    || (isContainerRuntime(runtimeMode) ? String(environmentDeployments[0]?.runtime_url || environmentDeployments[0]?.url || "").trim() : "");
  const lambdaInvokeUrl = (
    vars.DEV_GW_URL
    || vars.PROD_GW_URL
    || vars.STAGE_GW_URL
    || String(environmentDeployments[0]?.runtime_url || environmentDeployments[0]?.url || "")
  ).replace(/\/+$/, "");
  const invokeUrl = isContainerRuntime(runtimeMode) ? derivedRuntimeBaseUrl : lambdaInvokeUrl;
  const workspaceId = String(vars.POSTMAN_WORKSPACE_ID || "").trim();
  const workspaceUrl = workspaceId ? `https://go.postman.co/workspace/${workspaceId}` : "";
  const baselineUid = String(vars.POSTMAN_BASELINE_COLLECTION_UID || "").trim();
  const smokeUid = String(vars.POSTMAN_SMOKE_COLLECTION_UID || "").trim();
  const contractUid = String(vars.POSTMAN_CONTRACT_COLLECTION_UID || "").trim();
  const postmanEnvUid = String(vars.POSTMAN_ENVIRONMENT_UID || "").trim()
    || String(environmentDeployments.find((deployment) => deployment.environment === "prod")?.postman_env_uid || "").trim();
  const apiGatewayId = String(vars.DEV_API_ID || environmentDeployments[0]?.api_gateway_id || "").trim();
  const functionName = String(
    vars.FUNCTION_NAME
    || (runtimeMode === "ecs_service" ? (vars.ECS_SERVICE_NAME || `${options.repoName}-svc`) : ""),
  ).trim();

  const finalData: FinalProvisionData = {
    project: String(options.projectName || options.repoName || "").trim(),
    runtime: {
      mode: runtimeMode,
      base_url: derivedRuntimeBaseUrl,
    },
    chaos_enabled: vars.CHAOS_ENABLED === "true",
    chaos_config: vars.CHAOS_CONFIG || "",
    environment_deployments: environmentDeployments,
    postman: {
      workspace_url: workspaceUrl,
      spec_uid: vars.POSTMAN_SPEC_UID || "",
      baseline_uid: baselineUid,
      smoke_uid: smokeUid,
      contract_uid: contractUid,
      run_url: vars.POSTMAN_RUN_URL || "",
      mock_url: vars.MOCK_URL || "",
    },
    github: {
      repo_url: `https://github.com/${getOrg()}/${options.repoName}`,
    },
    aws: {
      invoke_url: invokeUrl,
      api_gateway_id: apiGatewayId,
      function_name: functionName,
      ecs_cluster_name: vars.ECS_CLUSTER_NAME || "",
      ecs_service_name: vars.ECS_SERVICE_NAME || "",
      ecs_task_definition: vars.ECS_TASK_DEFINITION || "",
      ecs_target_group_arn: vars.ECS_TARGET_GROUP_ARN || "",
      ecs_listener_rule_arn: vars.ECS_LISTENER_RULE_ARN || "",
    },
    lint: {
      warnings: parseInt(vars.LINT_WARNINGS || "0", 10),
      errors: parseInt(vars.LINT_ERRORS || "0", 10),
    },
    fern: {
      docs_url: vars.FERN_DOCS_URL || "",
    },
  };

  const hasSuccessMarkers = hasActiveEnvironmentDeployment(environmentDeployments)
    || (runtimeMode === "lambda" && Boolean(lambdaInvokeUrl && (functionName || apiGatewayId)))
    || (isContainerRuntime(runtimeMode) && Boolean(derivedRuntimeBaseUrl));

  const resolvedEnvironments = uniqueEnvironments([
    ...activeEnvironments,
    ...requestedEnvironments,
    ...parseEnvList(vars.ENVIRONMENTS_JSON || ""),
    ...parseEnvList(options.existingRecord?.environments_json || ""),
  ]);

  return {
    repoVariables: vars,
    finalData,
    environmentDeployments,
    runtimeMode,
    runtimeBaseUrl: derivedRuntimeBaseUrl,
    invokeUrl,
    hasSuccessMarkers,
    airtableFields: {
      status: "active",
      runtime_mode: runtimeMode,
      runtime_base_url: derivedRuntimeBaseUrl,
      postman_workspace_url: workspaceUrl,
      workspace_id: workspaceId,
      postman_team_id: vars.POSTMAN_TEAM_ID || "",
      postman_insights_project_id: vars.POSTMAN_INSIGHTS_PROJECT_ID || "",
      postman_environment_uid: postmanEnvUid,
      aws_invoke_url: invokeUrl,
      lambda_function_name: functionName,
      api_gateway_id: apiGatewayId,
      aws_region: String(options.defaultAwsRegion || "").trim(),
      ecs_cluster_name: vars.ECS_CLUSTER_NAME || "",
      ecs_service_name: vars.ECS_SERVICE_NAME || "",
      ecs_task_definition: vars.ECS_TASK_DEFINITION || "",
      ecs_target_group_arn: vars.ECS_TARGET_GROUP_ARN || "",
      ecs_listener_rule_arn: vars.ECS_LISTENER_RULE_ARN || "",
      dedicated_ip: primaryEnvironmentDeployment?.dedicated_ip || "",
      dedicated_port: primaryEnvironmentDeployment?.dedicated_port || "",
      graph_transport_url: primaryEnvironmentDeployment?.graph_transport_url || "",
      node_name: primaryEnvironmentDeployment?.node_name || "",
      mock_url: vars.MOCK_URL || "",
      postman_collection_uids: [baselineUid, smokeUid, contractUid].filter(Boolean).join(","),
      postman_spec_uid: vars.POSTMAN_SPEC_UID || "",
      postman_run_url: vars.POSTMAN_RUN_URL || "",
      fern_docs_url: vars.FERN_DOCS_URL || "",
      environment_deployments: JSON.stringify(environmentDeployments),
      environments_json: JSON.stringify(resolvedEnvironments),
      chaos_enabled: vars.CHAOS_ENABLED === "true",
      chaos_config: vars.CHAOS_CONFIG || "",
      failed_at_step: "",
      error_message: "",
    },
  };
}
