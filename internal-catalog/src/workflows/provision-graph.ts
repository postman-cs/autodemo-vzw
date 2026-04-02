import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";

export interface ProvisionGraphParams {
  project_name: string;
  domain: string;
  requester_email: string;
  spec_source: string;
  runtime: string;
  k8s_discovery_workspace_link?: boolean;
  environments: string[];
  chaos_enabled?: boolean;
  chaos_config?: string;
  request_origin: string;
  postman_team_slug?: string;
  workspace_team_id?: number;
  workspace_team_name?: string;
}

interface PlannedNode {
  spec_id: string;
  environment: string;
  layer_index: number;
  action: string;
}

interface Env {
  WORKER_ORIGIN: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  GH_TOKEN?: string;
  [key: string]: unknown;
}

async function provisionSingleNode(
  origin: string,
  params: ProvisionGraphParams,
  specId: string,
  environment: string,
  layerIndex: number,
  deploymentGroupId: string,
  accessHeaders: Record<string, string>,
): Promise<{ success: boolean; error?: string; runUrl?: string }> {
  const body = {
    project_name: specId,
    domain: params.domain,
    requester_email: params.requester_email,
    spec_source: specId,
    runtime: params.runtime,
    k8s_discovery_workspace_link: params.k8s_discovery_workspace_link,
    environments: [environment],
    deployment_mode: "single",
    chaos_enabled: params.chaos_enabled,
    chaos_config: params.chaos_config,
    deployment_group_id: deploymentGroupId,
    deployment_root_spec_id: params.spec_source,
    graph_node_layer_index: layerIndex,
    graph_node_environment: environment,
    workspace_team_id: params.workspace_team_id,
    workspace_team_name: params.workspace_team_name,
    postman_team_slug: params.postman_team_slug,
  };

  const resp = await fetch(`${origin}/api/provision`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...accessHeaders,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok && !resp.body) {
    return { success: false, error: `HTTP ${resp.status}` };
  }

  const reader = resp.body?.getReader();
  if (!reader) return { success: false, error: "No response body" };

  const decoder = new TextDecoder();
  let buffer = "";
  let lastPhase = "";
  let lastStatus = "";
  let lastMessage = "";
  let runUrl: string | undefined = undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      if (!chunk.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(chunk.slice(6));
        lastPhase = event.phase || lastPhase;
        lastStatus = event.status || lastStatus;
        lastMessage = event.message || lastMessage;
        if (event.phase === "github" && event.status === "running" && event.data?.run_url) {
          runUrl = event.data.run_url;
        }
      } catch {
        // ignore malformed SSE chunks
      }
    }
  }

  if (lastStatus === "error") {
    return { success: false, error: lastMessage || "Provisioning failed" };
  }
  if ((lastPhase === "complete" || lastPhase === "graph") && lastStatus === "complete") {
    return { success: true, runUrl };
  }

  return { success: false, error: lastMessage || "Unexpected end of provision stream" };
}

export class ProvisionGraphWorkflow extends WorkflowEntrypoint<Env, ProvisionGraphParams> {
  async run(event: WorkflowEvent<ProvisionGraphParams>, step: WorkflowStep) {
    const params = event.payload;
    const instanceId = event.instanceId;
    const deploymentGroupId = instanceId;
    const origin = this.env.WORKER_ORIGIN || params.request_origin;

    const accessHeaders: Record<string, string> = {};
    if (this.env.CF_ACCESS_CLIENT_ID && this.env.CF_ACCESS_CLIENT_SECRET) {
      accessHeaders["CF-Access-Client-Id"] = this.env.CF_ACCESS_CLIENT_ID;
      accessHeaders["CF-Access-Client-Secret"] = this.env.CF_ACCESS_CLIENT_SECRET;
    }

    await step.do("reconcile-stalled-records", async () => {
      const resp = await fetch(`${origin}/api/deployments`, {
        headers: accessHeaders,
      });
      if (!resp.ok) return;
      await resp.text();
    });

    const plan = await step.do("build-dependency-plan", async () => {
      const resp = await fetch(`${origin}/api/provision/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...accessHeaders },
        body: JSON.stringify({
          spec_source: params.spec_source,
          runtime: params.runtime,
          environments: params.environments,
          deployment_mode: "graph",
        }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Plan failed: ${resp.status} ${body}`);
      }
      return (await resp.json()) as { plan: { nodes: PlannedNode[]; summary: Record<string, number> } };
    });

    const nodes = plan.plan.nodes;
    const provisionNodes = nodes.filter((n) => n.action === "provision");
    const layers = [...new Set(provisionNodes.map((n) => n.layer_index))].sort((a, b) => a - b);

    for (const layerIndex of layers) {
      const layerNodes = provisionNodes.filter((n) => n.layer_index === layerIndex);

      await step.do(`layer-${layerIndex}-start`, async () => {
        // Layer boundary; status derived from CF REST API step parsing
      });

      const specGroups = new Map<string, PlannedNode[]>();
      for (const node of layerNodes) {
        const existing = specGroups.get(node.spec_id) || [];
        existing.push(node);
        specGroups.set(node.spec_id, existing);
      }

      for (const [specId, envNodes] of specGroups) {
        for (const node of envNodes) {
          const nodeKey = `${specId}/${node.environment}`;

          const result = await step.do(`provision-${nodeKey}`, {
            retries: { limit: 1, delay: 10000 },
            timeout: "15 minutes",
          }, async () => {
            const res = await provisionSingleNode(
              origin,
              params,
              specId,
              node.environment,
              layerIndex,
              deploymentGroupId,
              accessHeaders,
            );
            if (res.success && res.runUrl) {
              return { success: true, runUrl: res.runUrl };
            }
            return res;
          });

          if (!result.success) {
            await step.do(`fail-${nodeKey}`, async () => {
              // Failure recorded via step name/result; status endpoint parses from CF REST API
            });
            throw new Error(`Node ${nodeKey} failed: ${result.error}`);
          }
        }
      }
    }

    const githubAppTokenRaw = String(this.env.GH_TOKEN || "").trim();
    const githubAppToken = githubAppTokenRaw; // Assuming it's available in env

    await step.do("finalize", async () => {
      try {
        const mainRepo = 'postman-cs/vzw-partner-demo';
        const payload = {
          event_type: 'provision_success',
          client_payload: {
            service_id: params.spec_source,
            repo: `postman-cs/${params.project_name.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`,
            runtime_mode: params.runtime,
            success_timestamp: new Date().toISOString()
          }
        };
        const res = await fetch(`https://api.github.com/repos/${mainRepo}/dispatches`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${githubAppToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'vzw-partner-demo-worker'
          },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          console.warn(`Failed to trigger unified-fern-publish.yml: HTTP ${res.status} ${await res.text()}`);
        }
      } catch (e) {
        console.warn(`Failed to trigger unified-fern-publish.yml: ${e}`);
      }
      // Complete; status derived from CF REST API
    });
  }
}
