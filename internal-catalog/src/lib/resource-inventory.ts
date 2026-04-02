import type { DeploymentRecord } from "./airtable";
import {
  isKubernetesRuntime,
  normalizeRuntimeMode,
  type CanonicalRuntimeMode,
} from "./config";
import { parseEnvironmentDeploymentsJson } from "./environment-deployments";

export type ResourceKind =
  | "lambda_function"
  | "api_gateway_http_api"
  | "runtime_route"
  | "ecs_cluster"
  | "ecs_service"
  | "ecs_task_definition"
  | "k8s_namespace"
  | "k8s_deployment"
  | "k8s_service"
  | "k8s_ingress";

export interface ResourceDescriptor {
  provider: "aws" | "kubernetes";
  kind: ResourceKind;
  name: string;
  id?: string;
  arn?: string;
  region?: string;
  url?: string;
  metadata?: Record<string, string>;
}

export interface ServiceResourceInventory {
  service: string;
  status: string;
  runtime_mode: CanonicalRuntimeMode;
  generated_at: string;
  source: "airtable" | "derived";
  resources: ResourceDescriptor[];
}

export interface ResourceInventoryEnv {
  AWS_REGION?: string;
  AWS_LAMBDA_ROLE_ARN?: string;
  [key: string]: unknown;
}

const API_GATEWAY_HOST_RE = /^https?:\/\/([a-z0-9]+)\.execute-api\.([a-z0-9-]+)\.amazonaws\.com\/?/i;

function resolveRuntimeMode(record: DeploymentRecord): CanonicalRuntimeMode {
  if (record.runtime_mode?.trim()) {
    return normalizeRuntimeMode(record.runtime_mode);
  }
  if ((record.lambda_function_name || "").trim().toLowerCase() === "ecs-shared-runtime") {
    return "ecs_service";
  }
  if ((record.ecs_cluster_name || "").trim() || (record.ecs_service_name || "").trim()) {
    return "ecs_service";
  }
  return "lambda";
}

function parseAwsAccountId(roleArn: string): string | null {
  const match = roleArn.match(/^arn:aws:iam::(\d{12}):/i);
  return match ? match[1] : null;
}

function parseApiGatewayParts(invokeUrl?: string): { apiId: string; region: string } | null {
  const normalized = (invokeUrl || "").trim();
  if (!normalized) return null;
  const match = normalized.match(API_GATEWAY_HOST_RE);
  if (!match) return null;
  return {
    apiId: match[1],
    region: match[2],
  };
}

function lambdaArn(region: string, accountId: string, functionName: string): string {
  return `arn:aws:lambda:${region}:${accountId}:function:${functionName}`;
}

function apiGatewayArn(region: string, accountId: string, apiId: string): string {
  return `arn:aws:execute-api:${region}:${accountId}:${apiId}`;
}

function sanitizeResourceDescriptor(candidate: unknown): ResourceDescriptor | null {
  if (!candidate || typeof candidate !== "object") return null;
  const value = candidate as Record<string, unknown>;
  const kind = String(value.kind || "").trim() as ResourceKind;
  const name = String(value.name || "").trim();
  if (!kind || !name) return null;
  const provider = value.provider === "kubernetes" ? "kubernetes" : "aws";

  const descriptor: ResourceDescriptor = {
    provider,
    kind,
    name,
  };
  if (typeof value.id === "string" && value.id.trim()) descriptor.id = value.id.trim();
  if (typeof value.arn === "string" && value.arn.trim()) descriptor.arn = value.arn.trim();
  if (typeof value.region === "string" && value.region.trim()) descriptor.region = value.region.trim();
  if (typeof value.url === "string" && value.url.trim()) descriptor.url = value.url.trim();
  if (value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)) {
    const metadata: Record<string, string> = {};
    for (const [key, metadataValue] of Object.entries(value.metadata as Record<string, unknown>)) {
      if (typeof metadataValue === "string" && metadataValue.trim()) {
        metadata[key] = metadataValue.trim();
      }
    }
    if (Object.keys(metadata).length > 0) descriptor.metadata = metadata;
  }
  return descriptor;
}

function parseResourceEnvironment(resource: ResourceDescriptor): string {
  return String(resource.metadata?.environment || "").trim();
}

function parseRecordEnvironmentSet(record: DeploymentRecord): Set<string> {
  return new Set(
    parseEnvironmentDeploymentsJson(record.environment_deployments || "")
      .map((deployment) => deployment.environment)
      .filter(Boolean),
  );
}

function persistedInventoryMatchesRecord(
  record: DeploymentRecord,
  inventory: ServiceResourceInventory,
): boolean {
  const recordEnvironments = parseRecordEnvironmentSet(record);
  if (recordEnvironments.size === 0) return true;

  const inventoryEnvironments = new Set(
    inventory.resources
      .map((resource) => parseResourceEnvironment(resource))
      .filter(Boolean),
  );
  if (inventoryEnvironments.size === 0) return false;

  for (const environment of recordEnvironments) {
    if (!inventoryEnvironments.has(environment)) return false;
  }
  return true;
}

function preferredPrimaryEnvironment(
  deployments: ReturnType<typeof parseEnvironmentDeploymentsJson>,
): string {
  return deployments.find((deployment) => deployment.environment === "prod")?.environment
    || deployments[0]?.environment
    || "prod";
}

function deriveScopedName(primaryName: string, primaryEnvironment: string, environment: string): string {
  const trimmed = primaryName.trim();
  if (!trimmed) return "";
  if (environment === primaryEnvironment) return trimmed;

  const suffix = `-${primaryEnvironment}`;
  const base = trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed;
  return `${base}-${environment}`;
}

function parsePersistedInventory(record: DeploymentRecord): ServiceResourceInventory | null {
  const raw = (record.resource_inventory_json || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceResourceInventory>;
    if (!Array.isArray(parsed.resources)) return null;
    const resources = parsed.resources
      .map((candidate) => sanitizeResourceDescriptor(candidate))
      .filter((candidate): candidate is ResourceDescriptor => Boolean(candidate));

    return {
      service: record.spec_id,
      status: record.status,
      runtime_mode: normalizeRuntimeMode(parsed.runtime_mode || record.runtime_mode),
      generated_at: typeof parsed.generated_at === "string" && parsed.generated_at.trim()
        ? parsed.generated_at.trim()
        : (record.deployed_at || new Date().toISOString()),
      source: "airtable",
      resources,
    };
  } catch {
    return null;
  }
}

function buildLambdaInventory(record: DeploymentRecord, env: ResourceInventoryEnv): ResourceDescriptor[] {
  const resources: ResourceDescriptor[] = [];
  const defaultRegion = (record.aws_region || env.AWS_REGION || "eu-central-1").trim();
  const accountId = parseAwsAccountId(String(env.AWS_LAMBDA_ROLE_ARN || "").trim());
  const envDeployments = parseEnvironmentDeploymentsJson(record.environment_deployments || "");

  if (envDeployments.length > 0) {
    const primaryEnvironment = preferredPrimaryEnvironment(envDeployments);
    const primaryFunctionName = (record.lambda_function_name || "").trim();
    const projectSlug = (record.github_repo_name || record.spec_id || "").trim();

    for (const deployment of envDeployments) {
      const gatewayUrl = (deployment.runtime_url || deployment.url || "").trim();
      const gatewayParts = parseApiGatewayParts(gatewayUrl);
      const region = (gatewayParts?.region || defaultRegion).trim();
      const functionName = deriveScopedName(primaryFunctionName, primaryEnvironment, deployment.environment)
        || `${projectSlug}-${deployment.environment}`;

      resources.push({
        provider: "aws",
        kind: "lambda_function",
        name: functionName,
        id: functionName,
        region,
        arn: accountId ? lambdaArn(region, accountId, functionName) : undefined,
        metadata: { environment: deployment.environment },
      });

      const apiId = (deployment.api_gateway_id || "").trim() || gatewayParts?.apiId || "";
      if (apiId || gatewayUrl) {
        resources.push({
          provider: "aws",
          kind: "api_gateway_http_api",
          name: `${functionName}-api`,
          id: apiId || undefined,
          arn: accountId && apiId ? apiGatewayArn(region, accountId, apiId) : undefined,
          region,
          url: gatewayUrl || undefined,
          metadata: { environment: deployment.environment },
        });
      }
    }

    return resources;
  }

  const functionName = (record.lambda_function_name || "").trim();
  if (functionName) {
    const lambdaResource: ResourceDescriptor = {
      provider: "aws",
      kind: "lambda_function",
      name: functionName,
      id: functionName,
      region: defaultRegion,
    };
    if (accountId) lambdaResource.arn = lambdaArn(defaultRegion, accountId, functionName);
    resources.push(lambdaResource);
  }

  const invokeUrl = (record.aws_invoke_url || "").trim();
  const apiParts = parseApiGatewayParts(invokeUrl);
  const apiId = (record.api_gateway_id || "").trim() || apiParts?.apiId || "";
  const apiRegion = (apiParts?.region || defaultRegion).trim();
  if (apiId || invokeUrl) {
    const apiResource: ResourceDescriptor = {
      provider: "aws",
      kind: "api_gateway_http_api",
      name: functionName ? `${functionName}-api` : `${record.spec_id}-api`,
      region: apiRegion,
    };
    if (apiId) apiResource.id = apiId;
    if (invokeUrl) apiResource.url = invokeUrl;
    if (accountId && apiId) apiResource.arn = apiGatewayArn(apiRegion, accountId, apiId);
    resources.push(apiResource);
  }

  return resources;
}

function buildEcsInventory(record: DeploymentRecord): ResourceDescriptor[] {
  const resources: ResourceDescriptor[] = [];
  const envDeployments = parseEnvironmentDeploymentsJson(record.environment_deployments || "");
  const cluster = (record.ecs_cluster_name || "").trim();
  if (cluster) {
    resources.push({
      provider: "aws",
      kind: "ecs_cluster",
      name: cluster,
      id: cluster,
      region: (record.aws_region || "").trim() || undefined,
    });
  }

  if (envDeployments.length > 0) {
    const primaryEnvironment = preferredPrimaryEnvironment(envDeployments);
    const serviceName = (record.ecs_service_name || "").trim();
    const taskDefinition = (record.ecs_task_definition || "").trim();
    const defaultServiceName = `${(record.github_repo_name || record.spec_id || "").trim()}-svc`;
    const defaultTaskDefinition = `${(record.github_repo_name || record.spec_id || "").trim()}-task`;
    const region = (record.aws_region || "").trim() || undefined;

    for (const deployment of envDeployments) {
      const runtimeUrl = (deployment.runtime_url || deployment.url || "").trim();
      if (runtimeUrl) {
        resources.push({
          provider: "aws",
          kind: "runtime_route",
          name: `Runtime route (${deployment.environment})`,
          url: runtimeUrl,
          metadata: { environment: deployment.environment, ownership: "shared_pool" },
        });
      }

      const scopedServiceName = deriveScopedName(serviceName, primaryEnvironment, deployment.environment)
        || deriveScopedName(defaultServiceName, primaryEnvironment, deployment.environment);
      resources.push({
        provider: "aws",
        kind: "ecs_service",
        name: scopedServiceName,
        id: scopedServiceName,
        region,
        metadata: { environment: deployment.environment },
      });

      const scopedTaskDefinition = deriveScopedName(taskDefinition, primaryEnvironment, deployment.environment)
        || deriveScopedName(defaultTaskDefinition, primaryEnvironment, deployment.environment);
      resources.push({
        provider: "aws",
        kind: "ecs_task_definition",
        name: scopedTaskDefinition,
        id: scopedTaskDefinition,
        region,
        metadata: { environment: deployment.environment },
      });
    }

    return resources;
  }

  const runtimeUrl = (record.runtime_base_url || record.aws_invoke_url || "").trim();
  if (runtimeUrl) {
    resources.push({
      provider: "aws",
      kind: "runtime_route",
      name: "Shared runtime route",
      url: runtimeUrl,
      metadata: { ownership: "shared_pool" },
    });
  }

  const service = (record.ecs_service_name || "").trim();
  if (service) {
    resources.push({
      provider: "aws",
      kind: "ecs_service",
      name: service,
      id: service,
      region: (record.aws_region || "").trim() || undefined,
    });
  }

  const taskDefinition = (record.ecs_task_definition || "").trim();
  if (taskDefinition) {
    resources.push({
      provider: "aws",
      kind: "ecs_task_definition",
      name: taskDefinition,
      id: taskDefinition,
      region: (record.aws_region || "").trim() || undefined,
    });
  }

  return resources;
}

function buildKubernetesInventory(record: DeploymentRecord): ResourceDescriptor[] {
  const resources: ResourceDescriptor[] = [];
  const namespace = (record.k8s_namespace || "vzw-partner-demo").trim();
  const baseName = (record.k8s_deployment_name || record.lambda_function_name || record.spec_id).trim();

  resources.push({
    provider: "kubernetes",
    kind: "k8s_namespace",
    name: namespace,
    id: namespace,
  });

  const envDeployments = parseEnvironmentDeploymentsJson(record.environment_deployments || "");
  if (envDeployments.length > 0) {
    const primaryEnvironment = preferredPrimaryEnvironment(envDeployments);
    const primaryResourceName = (
      record.k8s_deployment_name
      || record.k8s_service_name
      || record.lambda_function_name
      || record.spec_id
    ).trim();
    for (const envDep of envDeployments) {
      const envResourceName = deriveScopedName(primaryResourceName, primaryEnvironment, envDep.environment)
        || `${baseName}-${envDep.environment}`;
      const depName = envResourceName;
      const svcName = envResourceName;
      const ingName = `${depName}-ingress`;
      const url = (envDep.runtime_url || envDep.url || "").trim();

      resources.push({
        provider: "kubernetes",
        kind: "k8s_deployment",
        name: depName,
        id: `${namespace}/${depName}`,
        metadata: { namespace, environment: envDep.environment },
      });
      resources.push({
        provider: "kubernetes",
        kind: "k8s_service",
        name: svcName,
        id: `${namespace}/${svcName}`,
        metadata: { namespace, environment: envDep.environment },
      });
      resources.push({
        provider: "kubernetes",
        kind: "k8s_ingress",
        name: ingName,
        id: `${namespace}/${ingName}`,
        url: url || undefined,
        metadata: { namespace, environment: envDep.environment },
      });
    }
  } else {
    const serviceName = (record.k8s_service_name || baseName).trim();
    const ingressName = (record.k8s_ingress_name || `${baseName}-ing`).trim();
    const runtimeUrl = (record.runtime_base_url || record.aws_invoke_url || "").trim();

    if (baseName) {
      resources.push({
        provider: "kubernetes",
        kind: "k8s_deployment",
        name: baseName,
        id: `${namespace}/${baseName}`,
        metadata: { namespace },
      });
    }
    if (serviceName) {
      resources.push({
        provider: "kubernetes",
        kind: "k8s_service",
        name: serviceName,
        id: `${namespace}/${serviceName}`,
        metadata: { namespace },
      });
    }
    if (ingressName) {
      resources.push({
        provider: "kubernetes",
        kind: "k8s_ingress",
        name: ingressName,
        id: `${namespace}/${ingressName}`,
        url: runtimeUrl || undefined,
        metadata: { namespace },
      });
    }
  }

  return resources;
}

export function buildDerivedResourceInventory(
  record: DeploymentRecord,
  env: ResourceInventoryEnv,
): ServiceResourceInventory {
  const runtimeMode = resolveRuntimeMode(record);
  const resources = runtimeMode === "ecs_service"
    ? buildEcsInventory(record)
    : isKubernetesRuntime(runtimeMode)
      ? buildKubernetesInventory(record)
      : buildLambdaInventory(record, env);

  return {
    service: record.spec_id,
    status: record.status,
    runtime_mode: runtimeMode,
    generated_at: new Date().toISOString(),
    source: "derived",
    resources,
  };
}

export function buildResourceInventory(
  record: DeploymentRecord,
  env: ResourceInventoryEnv,
): ServiceResourceInventory {
  const persisted = parsePersistedInventory(record);
  if (persisted && persistedInventoryMatchesRecord(record, persisted)) {
    return persisted;
  }
  return buildDerivedResourceInventory(record, env);
}
