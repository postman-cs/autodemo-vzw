export interface EnvironmentDeploymentRecord {
  environment: string;
  runtime_url: string;
  // Legacy key still emitted/accepted for backward compatibility.
  url?: string;
  dedicated_ip?: string;
  dedicated_port?: string;
  graph_transport_url?: string;
  node_name?: string;
  api_gateway_id?: string;
  postman_env_uid?: string;
  system_env_id?: string;
  status?: string;
  deployed_at?: string;
  branch?: string;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeEnvironmentDeployment(
  entry: Partial<EnvironmentDeploymentRecord>,
): EnvironmentDeploymentRecord | null {
  const environment = asString(entry.environment);
  if (!environment) return null;

  const runtimeUrl = asString(entry.runtime_url) || asString(entry.url);
  const normalizedRuntimeUrl = runtimeUrl.replace(/\/+$/, "");
  const normalized: EnvironmentDeploymentRecord = {
    environment,
    runtime_url: normalizedRuntimeUrl,
    url: normalizedRuntimeUrl,
  };

  const apiGatewayId = asString(entry.api_gateway_id);
  const dedicatedIp = asString(entry.dedicated_ip);
  const dedicatedPort = asString(entry.dedicated_port);
  const graphTransportUrl = asString(entry.graph_transport_url);
  const nodeName = asString(entry.node_name);
  const postmanEnvUid = asString(entry.postman_env_uid);
  const systemEnvId = asString(entry.system_env_id);
  const status = asString(entry.status);
  const deployedAt = asString(entry.deployed_at);
  const branch = asString(entry.branch);

  if (apiGatewayId) normalized.api_gateway_id = apiGatewayId;
  if (dedicatedIp) normalized.dedicated_ip = dedicatedIp;
  if (dedicatedPort) normalized.dedicated_port = dedicatedPort;
  if (graphTransportUrl) normalized.graph_transport_url = graphTransportUrl.replace(/\/+$/, "");
  if (nodeName) normalized.node_name = nodeName;
  if (postmanEnvUid) normalized.postman_env_uid = postmanEnvUid;
  if (systemEnvId) normalized.system_env_id = systemEnvId;
  if (status) normalized.status = status;
  if (deployedAt) normalized.deployed_at = deployedAt;
  if (branch) normalized.branch = branch;

  return normalized;
}

export function parseEnvironmentDeploymentsJson(raw: string): EnvironmentDeploymentRecord[] {
  const normalizedRaw = asString(raw);
  if (!normalizedRaw) return [];
  try {
    const parsed = JSON.parse(normalizedRaw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const result: EnvironmentDeploymentRecord[] = [];
    for (const candidate of parsed) {
      if (!candidate || typeof candidate !== "object") continue;
      const normalized = normalizeEnvironmentDeployment(candidate as Partial<EnvironmentDeploymentRecord>);
      if (normalized) result.push(normalized);
    }
    return result;
  } catch {
    return [];
  }
}
