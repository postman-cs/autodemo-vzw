import { createRepoVariable } from "./github";
import type { CredentialSourceMode } from "./provision-credential-policy";

export const SHARED_INFRA_VARS = new Set([
  "ECS_CLUSTER_NAME",
  "ECS_VPC_ID",
  "ECS_SUBNET_IDS",
  "ECS_SECURITY_GROUP_IDS",
  "K8S_NAMESPACE",
  "K8S_INGRESS_BASE_DOMAIN",
  "K8S_CONTEXT",
  "POSTMAN_INSIGHTS_CLUSTER_NAME",
  "ECS_ALB_LISTENER_ARN",
  "ECS_EXECUTION_ROLE_ARN",
  "ECS_TASK_ROLE_ARN",
  "ECS_ECR_REPOSITORY",
  "ECS_ALB_DNS_NAME",
  "ECS_MAX_SERVICES",
]);

export function isSharedInfraVar(name: string): boolean {
  return SHARED_INFRA_VARS.has(String(name || "").trim());
}

export async function setRepoVarRespectingOrgScope(
  token: string,
  repoName: string,
  name: string,
  value: string,
  variableSourceMode: CredentialSourceMode,
): Promise<"written" | "skipped"> {
  if (variableSourceMode !== "repo" && isSharedInfraVar(name)) {
    console.log(`[provision][vars] skip repo var ${name}; expecting org-scoped value`);
    return "skipped";
  }

  await createRepoVariable(token, repoName, name, value);
  return "written";
}
