/**
 * Fetches workflow instance status from Cloudflare REST API and transforms to
 * the frontend progress format (completed_nodes, failed_node, current_node, etc.).
 */

interface CfStep {
  name?: string;
  start?: string;
  end?: string | null;
  success?: boolean;
  output?: string;
  error?: string;
}

interface CfInstanceResponse {
  result?: {
    id?: string;
    status?: string;
    error?: string | { message?: string; name?: string };
    output?: unknown;
    params?: Record<string, unknown>;
    steps?: CfStep[];
  };
  success?: boolean;
  errors?: Array<{ message?: string }>;
}

export interface WorkflowPlanResolverInput {
  spec_source: string;
  runtime: string;
  environments: string[];
  deployment_mode?: string;
}

interface WorkflowPlanNode {
  spec_id?: string;
  environment?: string;
  action?: string;
}

type WorkflowPlanResolver = (params: WorkflowPlanResolverInput) => Promise<WorkflowPlanNode[] | null>;

interface GraphStatusResult {
  instance_id: string;
  workflow_status: string;
  status: string;
  completed_nodes: string[];
  failed_node: string | null;
  failed_message: string | null;
  current_node: string | null;
  current_layer: number;
  plan_json?: string;
  run_urls: Record<string, string>;
}

function parseStepOutput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function extractErrorMessage(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const record = raw as { message?: unknown; error?: unknown };
    if (typeof record.message === "string" && record.message.trim()) return record.message;
    if (typeof record.error === "string" && record.error.trim()) return record.error;
  }
  return String(raw);
}

function normalizePlanResolverInput(raw: unknown): WorkflowPlanResolverInput | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const specSource = typeof record.spec_source === "string" ? record.spec_source.trim() : "";
  const runtime = typeof record.runtime === "string" ? record.runtime.trim() : "";
  const environments = Array.isArray(record.environments)
    ? Array.from(new Set(record.environments.map((value) => String(value || "").trim()).filter(Boolean)))
    : [];
  const deploymentMode = typeof record.deployment_mode === "string" ? record.deployment_mode.trim() : "";
  if (!specSource || !runtime) return null;
  return {
    spec_source: specSource,
    runtime,
    environments,
    deployment_mode: deploymentMode || undefined,
  };
}

function extractPlanNodes(raw: unknown): WorkflowPlanNode[] | null {
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const nodes = Array.isArray((parsed as { plan?: { nodes?: unknown } })?.plan?.nodes)
      ? (parsed as { plan: { nodes: WorkflowPlanNode[] } }).plan.nodes
      : [];
    return nodes;
  } catch {
    return null;
  }
}

export async function fetchWorkflowStatusFromCfApi(
  instanceId: string,
  accountId: string,
  email: string,
  apiKey: string,
  planResolver?: WorkflowPlanResolver,
): Promise<GraphStatusResult> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workflows/provision-graph/instances/${instanceId}`;
  const res = await fetch(url, {
    headers: {
      "X-Auth-Email": email,
      "X-Auth-Key": apiKey,
      "Content-Type": "application/json",
    },
  });

  const body = (await res.json()) as CfInstanceResponse;
  if (!res.ok || !body.success) {
    const errMsg = body.errors?.[0]?.message || `CF API ${res.status}`;
    throw new Error(errMsg);
  }

  const result = body.result;
  const steps = result?.steps || [];
  const wfStatus = String(result?.status || "unknown");
  const wfError = extractErrorMessage(result?.error);

  const completedNodes = new Set<string>();
  const provisionStepNodes = new Set<string>();
  const runUrls: Record<string, string> = {};
  let failedNode: string | null = null;
  let failedMessage: string | null = wfError || null;
  let currentNode: string | null = null;
  let currentLayer = -1;
  let planJson: string | undefined;
  let planNodes: WorkflowPlanNode[] | null = null;

  for (const step of steps) {
    const rawName = step.name || "";
    const name = rawName.replace(/-\d+$/, "");

    if (name === "build-dependency-plan" && step.output) {
      const parsedNodes = extractPlanNodes(step.output);
      if (parsedNodes) {
        planNodes = parsedNodes;
        planJson = typeof step.output === "string" ? step.output : JSON.stringify(step.output);
      }
    }

    const layerMatch = name.match(/^layer-(\d+)-start$/);
    if (layerMatch) {
      currentLayer = parseInt(layerMatch[1], 10);
    }

    const provisionMatch = name.match(/^provision-(.+)$/);
    if (provisionMatch) {
      const nodeKey = provisionMatch[1];
      provisionStepNodes.add(nodeKey);
      const output = parseStepOutput(step.output) as { success?: boolean; error?: unknown; runUrl?: string } | string | null;
      if (typeof output === "object" && output !== null && typeof output.runUrl === "string" && output.runUrl) {
        runUrls[nodeKey] = output.runUrl;
      }
      const nodeFailed = step.success === false
        || (typeof output === "object" && output !== null && output.success === false);
      if (!nodeFailed) {
        if (step.end !== null) {
          completedNodes.add(nodeKey);
        }
      } else {
        failedNode = nodeKey;
        if (step.error) failedMessage = step.error;
        else if (typeof output === "object" && output !== null && output.error) {
          failedMessage = extractErrorMessage(output.error);
        }
      }
    }

    const failMatch = name.match(/^fail-(.+)$/);
    if (failMatch) {
      const failKey = failMatch[1];
      if (!failedNode) failedNode = failKey;
    }

    if (step.end == null && step.success == null) {
      if (provisionMatch) {
        currentNode = provisionMatch[1];
      } else if (name.startsWith("layer-") && name.endsWith("-start")) {
        const nextProvision = steps.find(
          (s) => {
            const sName = (s.name || "").replace(/-\d+$/, "");
            return sName.startsWith("provision-") && s.end == null;
          },
        );
        if (nextProvision?.name) {
          const sName = nextProvision.name.replace(/-\d+$/, "");
          const m = sName.match(/^provision-(.+)$/);
          if (m) currentNode = m[1];
        }
      }
    }
  }

  if (!planNodes && planResolver) {
    const params = normalizePlanResolverInput(result?.params);
    if (params) {
      try {
        planNodes = await planResolver(params);
      } catch (err) {
        console.warn(`[provision-graph-status] planResolver fallback failed:`, err);
        planNodes = null;
      }
    }
  }

  for (const node of planNodes || []) {
    const specId = String(node.spec_id || "").trim();
    const environment = String(node.environment || "").trim();
    const action = String(node.action || "").trim();
    if (!specId || !environment) continue;
    const nodeKey = `${specId}/${environment}`;
    if (provisionStepNodes.has(nodeKey)) continue;
    if (action === "reuse") {
      completedNodes.add(`${nodeKey}:reused`);
    } else if (action === "attach") {
      completedNodes.add(`${nodeKey}:attached`);
    }
  }

  let status: string;
  if (wfStatus === "complete" || wfStatus === "fulfilled") {
    status = "complete";
  } else if (wfStatus === "errored" || wfStatus === "terminated") {
    status = "error";
  } else {
    status = failedNode ? "error" : "running";
  }

  return {
    instance_id: instanceId,
    workflow_status: wfStatus,
    status,
    completed_nodes: Array.from(completedNodes),
    failed_node: failedNode,
    failed_message: failedMessage,
    current_node: currentNode,
    current_layer: currentLayer,
    plan_json: planJson,
    run_urls: runUrls,
  };
}
