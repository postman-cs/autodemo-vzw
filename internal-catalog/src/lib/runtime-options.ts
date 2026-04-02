import {
  getInfraRecord,
  isAirtableConfigured,
  getActiveEcsServiceCount,
  getActiveK8sDiscoveryServiceCount,
  type DeploymentRecord,
  type InfraRecord,
} from "./airtable";
import { normalizeRuntimeMode, type CanonicalRuntimeMode, type PortalConfig } from "./config";
import { buildFallbackSystemEnvironments, resolveSystemEnvironments } from "./system-envs";
import { resolveTeamCredentials } from "./team-registry";
import { getWorkerSecretBundle } from "./worker-config-cache";

export interface EcsRuntimeInfra {
  clusterName: string;
  vpcId: string;
  subnetIds: string[];
  securityGroupIds: string[];
  executionRoleArn: string;
  taskRoleArn: string;
  albListenerArn: string;
  albDnsName: string;
  ecrRepository: string;
  maxServices: number;
}

export interface EcsRuntimeStatus {
  mode: "ecs_service";
  available: boolean;
  needsSetup?: boolean;
  activeServices: number;
  maxServices: number;
  remainingServices: number;
  unavailableReason: string;
  infra: EcsRuntimeInfra;
}

export interface K8sRuntimeStatus {
  mode: "k8s_workspace" | "k8s_discovery";
  available: boolean;
  needsSetup?: boolean;
  unavailableReason: string;
  namespace: string;
  activeServices?: number;
  sharedInfraActive?: boolean;
  sharedInfraStatus?: string;
  sharedInfraComponent?: string;
  daemonsetName?: string;
}

export interface RuntimeOptionsStatus {
  lambda: {
    mode: "lambda";
    available: true;
  };
  ecs_service: EcsRuntimeStatus;
  k8s_workspace: K8sRuntimeStatus;
  k8s_discovery: K8sRuntimeStatus;
}

const DEFAULT_ECS_MAX_SERVICES = 100;

type RuntimeEnv = Record<string, unknown>;

function readString(...candidates: Array<unknown>): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

function readStringList(...candidates: Array<unknown>): string[] {
  const raw = readString(...candidates);
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readPositiveInt(defaultValue: number, ...candidates: Array<unknown>): number {
  for (const candidate of candidates) {
    const parsed = Number.parseInt(String(candidate ?? "").trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return defaultValue;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function inferRuntimeMode(record: DeploymentRecord): CanonicalRuntimeMode {
  if (record.runtime_mode?.trim()) {
    return normalizeRuntimeMode(record.runtime_mode);
  }
  if ((record.ecs_cluster_name || "").trim() || (record.ecs_service_name || "").trim()) {
    return "ecs_service";
  }
  return "lambda";
}

async function resolveEffectiveRuntimeEnv(env: RuntimeEnv): Promise<RuntimeEnv> {
  const needsWorkerBundle = !readString(env.KUBECONFIG_B64)
    || !readString(env.K8S_INGRESS_BASE_DOMAIN)
    || !readString(env.POSTMAN_INSIGHTS_CLUSTER_NAME)
    || !readString(env.K8S_NAMESPACE);

  if (!needsWorkerBundle) return env;

  const accessKeyId = readString(env.AWS_ACCESS_KEY_ID);
  const secretAccessKey = readString(env.AWS_SECRET_ACCESS_KEY);
  const region = readString(env.AWS_REGION) || "eu-central-1";

  if (!accessKeyId || !secretAccessKey) {
    return env;
  }

  const bundle = await getWorkerSecretBundle({
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    AWS_REGION: region,
  });

  return {
    ...env,
    KUBECONFIG_B64: readString(env.KUBECONFIG_B64, bundle.KUBECONFIG_B64),
    K8S_INGRESS_BASE_DOMAIN: readString(env.K8S_INGRESS_BASE_DOMAIN, bundle.K8S_INGRESS_BASE_DOMAIN),
    POSTMAN_INSIGHTS_CLUSTER_NAME: readString(env.POSTMAN_INSIGHTS_CLUSTER_NAME, bundle.POSTMAN_INSIGHTS_CLUSTER_NAME),
    K8S_NAMESPACE: readString(env.K8S_NAMESPACE, bundle.K8S_NAMESPACE),
  };
}

function joinMissingInfraParts(infra: EcsRuntimeInfra): string[] {
  const missing: string[] = [];
  if (!infra.clusterName) missing.push("cluster");
  if (!infra.vpcId) missing.push("vpc");
  if (!infra.subnetIds.length) missing.push("subnets");
  if (!infra.securityGroupIds.length) missing.push("security_groups");
  if (!infra.executionRoleArn) missing.push("execution_role_arn");
  if (!infra.albListenerArn) missing.push("alb_listener_arn");
  if (!infra.albDnsName) missing.push("alb_dns_name");
  if (!infra.ecrRepository) missing.push("ecr_repository");
  return missing;
}

function mapInfraRecordToRuntime(record: InfraRecord): EcsRuntimeInfra {
  return {
    clusterName: readString(record.cluster_name),
    vpcId: readString(record.vpc_id),
    subnetIds: readStringList(record.subnet_ids),
    securityGroupIds: readStringList(record.security_group_ids),
    executionRoleArn: readString(record.execution_role_arn),
    taskRoleArn: readString(record.task_role_arn),
    albListenerArn: readString(record.alb_listener_arn),
    albDnsName: readString(record.alb_dns_name),
    ecrRepository: readString(record.ecr_repository),
    maxServices: DEFAULT_ECS_MAX_SERVICES,
  };
}

function mergeInfra(base: EcsRuntimeInfra, fallback: EcsRuntimeInfra): EcsRuntimeInfra {
  return {
    clusterName: readString(base.clusterName, fallback.clusterName),
    vpcId: readString(base.vpcId, fallback.vpcId),
    subnetIds: base.subnetIds.length > 0 ? base.subnetIds : fallback.subnetIds,
    securityGroupIds: base.securityGroupIds.length > 0 ? base.securityGroupIds : fallback.securityGroupIds,
    executionRoleArn: readString(base.executionRoleArn, fallback.executionRoleArn),
    taskRoleArn: readString(base.taskRoleArn, fallback.taskRoleArn),
    albListenerArn: readString(base.albListenerArn, fallback.albListenerArn),
    albDnsName: readString(base.albDnsName, fallback.albDnsName),
    ecrRepository: readString(base.ecrRepository, fallback.ecrRepository),
    maxServices: base.maxServices,
  };
}

export async function resolveEcsRuntimeInfra(
  config: PortalConfig | null | undefined,
  env: RuntimeEnv,
): Promise<EcsRuntimeInfra> {
  const defaults = config?.backend?.runtime_defaults;
  const infraFromConfig = {
    clusterName: readString(
      defaults?.ecs_cluster_name,
      env.RUNTIME_POOL_ECS_CLUSTER_NAME,
      env.ECS_POOL_CLUSTER_NAME,
    ),
    vpcId: readString(
      defaults?.ecs_vpc_id,
      env.RUNTIME_POOL_ECS_VPC_ID,
      env.ECS_POOL_VPC_ID,
    ),
    subnetIds: readStringList(
      defaults?.ecs_subnet_ids,
      env.RUNTIME_POOL_ECS_SUBNET_IDS,
      env.ECS_POOL_SUBNET_IDS,
    ),
    securityGroupIds: readStringList(
      defaults?.ecs_security_group_ids,
      env.RUNTIME_POOL_ECS_SECURITY_GROUP_IDS,
      env.ECS_POOL_SECURITY_GROUP_IDS,
    ),
    executionRoleArn: readString(
      defaults?.ecs_execution_role_arn,
      env.RUNTIME_POOL_ECS_EXECUTION_ROLE_ARN,
      env.ECS_POOL_EXECUTION_ROLE_ARN,
    ),
    taskRoleArn: readString(
      defaults?.ecs_task_role_arn,
      env.RUNTIME_POOL_ECS_TASK_ROLE_ARN,
      env.ECS_POOL_TASK_ROLE_ARN,
    ),
    albListenerArn: readString(
      defaults?.ecs_alb_listener_arn,
      env.RUNTIME_POOL_ECS_ALB_LISTENER_ARN,
      env.ECS_POOL_ALB_LISTENER_ARN,
    ),
    albDnsName: readString(
      defaults?.ecs_alb_dns_name,
      env.RUNTIME_POOL_ECS_ALB_DNS_NAME,
      env.ECS_POOL_ALB_DNS_NAME,
    ),
    ecrRepository: readString(
      defaults?.ecs_ecr_repository,
      env.RUNTIME_POOL_ECS_ECR_REPOSITORY,
      env.ECS_POOL_ECR_REPOSITORY,
    ),
    maxServices: readPositiveInt(
      DEFAULT_ECS_MAX_SERVICES,
      defaults?.ecs_max_services,
      env.RUNTIME_POOL_ECS_MAX_SERVICES,
      env.ECS_POOL_MAX_SERVICES,
    ),
  };

  if (!isAirtableConfigured(env)) {
    return infraFromConfig;
  }

  if (joinMissingInfraParts(infraFromConfig).length === 0) {
    return infraFromConfig;
  }

  let infraRecord: InfraRecord | null = null;
  try {
    infraRecord = await getInfraRecord(env, "ecs_shared");
  } catch {
    return infraFromConfig;
  }
  if (!infraRecord || infraRecord.status !== "active") {
    return infraFromConfig;
  }

  return mergeInfra(infraFromConfig, mapInfraRecordToRuntime(infraRecord));
}

export function countActiveEcsServices(deployments: DeploymentRecord[]): number {
  return deployments.filter((record) => {
    if (record.status === "failed") return false;
    return inferRuntimeMode(record) === "ecs_service";
  }).length;
}

export function countActiveK8sDiscoveryServices(deployments: DeploymentRecord[]): number {
  return deployments.filter((record) => {
    if (record.status === "failed") return false;
    return normalizeRuntimeMode(record.runtime_mode) === "k8s_discovery";
  }).length;
}

export async function resolveRuntimeOptionsStatus(
  config: PortalConfig | null | undefined,
  env: RuntimeEnv,
  teamSlug?: string,
): Promise<RuntimeOptionsStatus> {
  const effectiveEnv = await resolveEffectiveRuntimeEnv(env);
  const defaultK8sNamespace = readString(effectiveEnv.K8S_NAMESPACE) || "vzw-partner-demo";
  const kubeconfigB64 = readString(effectiveEnv.KUBECONFIG_B64);
  const ingressBaseDomain = readString(effectiveEnv.K8S_INGRESS_BASE_DOMAIN);
  const clusterName = readString(effectiveEnv.POSTMAN_INSIGHTS_CLUSTER_NAME);

  let systemEnvs: any[] = buildFallbackSystemEnvironments(effectiveEnv);
  if (teamSlug) {
    try {
      const creds = await resolveTeamCredentials(
        effectiveEnv.TEAM_REGISTRY as KVNamespace | undefined,
        effectiveEnv,
        teamSlug,
      );
      systemEnvs = await resolveSystemEnvironments(creds.team_id, creds.access_token, effectiveEnv);
    } catch {
      // ignore
    }
  }

  const missingK8sShared = [];
  if (!kubeconfigB64) missingK8sShared.push("KUBECONFIG_B64");
  if (!ingressBaseDomain) missingK8sShared.push("K8S_INGRESS_BASE_DOMAIN");
  const sharedK8sReason = missingK8sShared.length > 0
    ? `Kubernetes runtime is missing required configuration: ${missingK8sShared.join(", ")}`
    : "";

  const k8sWorkspaceReason = sharedK8sReason
    || (systemEnvs.length === 0
      ? "Kubernetes workspace mode requires at least one configured system environment"
      : "");

  let k8sDiscoveryReason = sharedK8sReason
    || (!clusterName ? "Kubernetes discovery mode requires POSTMAN_INSIGHTS_CLUSTER_NAME" : "");
  let discoveryInfraRecord: InfraRecord | null = null;
  if (!k8sDiscoveryReason) {
    if (!isAirtableConfigured(effectiveEnv)) {
      k8sDiscoveryReason = "Airtable is not configured; Kubernetes discovery shared infrastructure status is unavailable";
    } else {
      try {
        discoveryInfraRecord = await getInfraRecord(effectiveEnv, "k8s_discovery_shared");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        k8sDiscoveryReason = `Unable to verify Kubernetes discovery shared infrastructure: ${message}`;
      }
      if (!k8sDiscoveryReason) {
        const sharedStatus = (discoveryInfraRecord?.status || "").trim();
        if (sharedStatus !== "active") {
          k8sDiscoveryReason = sharedStatus
            ? `Kubernetes discovery shared infrastructure is ${sharedStatus}; run discovery setup`
            : "Kubernetes discovery shared infrastructure is not active; run discovery setup";
        }
      }
    }
  }
  const discoveryNamespace = readString(discoveryInfraRecord?.k8s_namespace, defaultK8sNamespace) || "vzw-partner-demo";
  const discoveryDaemonsetName = readString(discoveryInfraRecord?.k8s_daemonset_name);
  const discoverySharedStatus = readString(discoveryInfraRecord?.status);

  const infra = await resolveEcsRuntimeInfra(config, effectiveEnv);
  const missingInfra = joinMissingInfraParts(infra);

  let activeServices = 0;
  let activeK8sDiscoveryServices = 0;
  let trackingError = "";
  if (isAirtableConfigured(effectiveEnv)) {
    try {
      activeServices = await getActiveEcsServiceCount(effectiveEnv);
      activeK8sDiscoveryServices = await getActiveK8sDiscoveryServiceCount(effectiveEnv);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trackingError = `Unable to read deployment records: ${message}`;
    }
  } else {
    trackingError = "Airtable is not configured; ECS capacity tracking is unavailable";
  }

  const capReached = activeServices >= infra.maxServices;
  const unavailableReason = trackingError
    || (missingInfra.length > 0
      ? `Shared ECS infrastructure is incomplete: ${missingInfra.join(", ")}`
      : capReached
        ? `ECS capacity reached (${activeServices}/${infra.maxServices})`
        : "");

  return {
    lambda: {
      mode: "lambda",
      available: true,
    },
    ecs_service: {
      mode: "ecs_service",
      available: !unavailableReason,
      needsSetup: missingInfra.length > 0 && !trackingError,
      activeServices,
      maxServices: infra.maxServices,
      remainingServices: Math.max(0, infra.maxServices - activeServices),
      unavailableReason,
      infra,
    },
    k8s_workspace: {
      mode: "k8s_workspace",
      available: !k8sWorkspaceReason,
      unavailableReason: k8sWorkspaceReason,
      namespace: defaultK8sNamespace,
    },
    k8s_discovery: {
      mode: "k8s_discovery",
      available: !k8sDiscoveryReason,
      needsSetup: discoverySharedStatus !== "active" && !sharedK8sReason,
      unavailableReason: k8sDiscoveryReason,
      namespace: discoveryNamespace,
      activeServices: activeK8sDiscoveryServices,
      sharedInfraActive: discoverySharedStatus === "active",
      sharedInfraStatus: discoverySharedStatus,
      sharedInfraComponent: discoveryInfraRecord?.component || "k8s_discovery_shared",
      daemonsetName: discoveryDaemonsetName,
    },
  };
}
