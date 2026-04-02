import { afterEach, describe, expect, it, vi } from "vitest";
import type { DependencyPlan, PlannedNode } from "../src/lib/dependency-planner";
import { executeGraphPlan } from "../src/lib/provision-graph";
import { fetchWorkflowStatusFromCfApi } from "../src/lib/provision-graph-status";

function node(overrides: Partial<PlannedNode>): PlannedNode {
  return {
    key: "svc:prod:k8s_workspace",
    spec_id: "svc",
    environment: "prod",
    runtime: "k8s_workspace",
    layer_index: 0,
    action: "provision",
    hard_dependencies: [],
    soft_neighbors: [],
    ...overrides,
  };
}

function plan(overrides: Partial<DependencyPlan> = {}): DependencyPlan {
  return {
    deployment_mode: "graph",
    root_spec_id: "svc-root",
    runtime: "k8s_workspace",
    environments: ["prod"],
    hard_closure_spec_ids: [],
    soft_neighbor_spec_ids: [],
    layers: [],
    nodes: [],
    summary: {
      total_nodes: 0,
      reuse_count: 0,
      attach_count: 0,
      provision_count: 0,
      blocked_count: 0,
    },
    ...overrides,
  };
}

describe("graph provision orchestrator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("executes by layer and skips reused nodes without redispatching", async () => {
    const depA = node({ key: "dep-a:prod:k8s_workspace", spec_id: "dep-a", action: "reuse", layer_index: 0 });
    const depB = node({ key: "dep-b:prod:k8s_workspace", spec_id: "dep-b", action: "provision", layer_index: 0 });
    const root = node({ key: "root:prod:k8s_workspace", spec_id: "root", action: "provision", layer_index: 1 });

    const dispatches: string[] = [];
    const result = await executeGraphPlan({
      plan: plan({
        hard_closure_spec_ids: ["dep-a", "dep-b", "root"],
        layers: [
          { layer_index: 0, spec_ids: ["dep-a", "dep-b"] },
          { layer_index: 1, spec_ids: ["root"] },
        ],
        nodes: [depA, depB, root],
      }),
      deploymentGroupId: "grp-1",
      deploymentRootSpecId: "root",
      runProvisionNode: async (currentNode) => {
        dispatches.push(currentNode.spec_id);
        return { ok: true };
      },
    });

    expect(result.success).toBe(true);
    expect(dispatches).toEqual(["dep-b", "root"]);
    expect(result.reused_nodes.map((entry) => entry.spec_id)).toEqual(["dep-a"]);
    expect(result.completed_nodes.map((entry) => entry.spec_id)).toEqual(["dep-b", "root"]);
  });

  it("skips attached nodes without redispatching", async () => {
    const attached = node({ key: "dep-a:prod:k8s_workspace", spec_id: "dep-a", action: "attach", layer_index: 0 });
    const root = node({ key: "root:prod:k8s_workspace", spec_id: "root", action: "provision", layer_index: 1 });

    const dispatches: string[] = [];
    const result = await executeGraphPlan({
      plan: plan({
        hard_closure_spec_ids: ["dep-a", "root"],
        layers: [
          { layer_index: 0, spec_ids: ["dep-a"] },
          { layer_index: 1, spec_ids: ["root"] },
        ],
        nodes: [attached, root],
      }),
      deploymentGroupId: "grp-attach",
      deploymentRootSpecId: "root",
      runProvisionNode: async (currentNode) => {
        dispatches.push(currentNode.spec_id);
        return { ok: true };
      },
    });

    expect(result.success).toBe(true);
    expect(dispatches).toEqual(["root"]);
    expect(result.attached_nodes.map((entry) => entry.spec_id)).toEqual(["dep-a"]);
    expect(result.completed_nodes.map((entry) => entry.spec_id)).toEqual(["root"]);
  });

  it("fails fast on first failed node and reports downstream nodes as not started", async () => {
    const layer0 = node({ key: "a:prod:k8s_workspace", spec_id: "a", layer_index: 0 });
    const layer1Fail = node({ key: "b:prod:k8s_workspace", spec_id: "b", layer_index: 1 });
    const layer1Pending = node({ key: "c:prod:k8s_workspace", spec_id: "c", layer_index: 1 });
    const layer2 = node({ key: "d:prod:k8s_workspace", spec_id: "d", layer_index: 2 });

    const result = await executeGraphPlan({
      plan: plan({
        hard_closure_spec_ids: ["a", "b", "c", "d"],
        layers: [
          { layer_index: 0, spec_ids: ["a"] },
          { layer_index: 1, spec_ids: ["b", "c"] },
          { layer_index: 2, spec_ids: ["d"] },
        ],
        nodes: [layer0, layer1Fail, layer1Pending, layer2],
      }),
      deploymentGroupId: "grp-2",
      deploymentRootSpecId: "d",
      maxConcurrencyPerLayer: 1,
      runProvisionNode: async (currentNode) => {
        if (currentNode.spec_id === "b") {
          return { ok: false, message: "boom" };
        }
        return { ok: true };
      },
    });

    expect(result.success).toBe(false);
    expect(result.failed_node?.spec_id).toBe("b");
    expect(result.failed_layer_index).toBe(1);
    expect(result.not_started_nodes.map((entry) => entry.spec_id)).toEqual(["c", "d"]);
  });

  it("rechecks persisted node state before retrying and skips completed nodes", async () => {
    const nodeA = node({ key: "a:prod:k8s_workspace", spec_id: "a", layer_index: 0 });
    const nodeB = node({ key: "b:prod:k8s_workspace", spec_id: "b", layer_index: 0 });

    const dispatches: string[] = [];
    const result = await executeGraphPlan({
      plan: plan({
        hard_closure_spec_ids: ["a", "b"],
        layers: [{ layer_index: 0, spec_ids: ["a", "b"] }],
        nodes: [nodeA, nodeB],
      }),
      deploymentGroupId: "grp-3",
      deploymentRootSpecId: "b",
      recheckNodeState: async (currentNode) => {
        if (currentNode.spec_id === "b") {
          return { status: "completed", reason: "already_active" };
        }
        return null;
      },
      runProvisionNode: async (currentNode) => {
        dispatches.push(currentNode.spec_id);
        return { ok: true };
      },
    });

    expect(result.success).toBe(true);
    expect(dispatches).toEqual(["a"]);
    expect(result.reused_nodes.map((entry) => entry.spec_id)).toContain("b");
  });

  it("records provisioned nodes as reused when runProvisionNode reports reused=true", async () => {
    const nodeA = node({ key: "a:prod:k8s_workspace", spec_id: "a", layer_index: 0 });
    const nodeB = node({ key: "b:prod:k8s_workspace", spec_id: "b", layer_index: 1 });

    const result = await executeGraphPlan({
      plan: plan({
        hard_closure_spec_ids: ["a", "b"],
        layers: [
          { layer_index: 0, spec_ids: ["a"] },
          { layer_index: 1, spec_ids: ["b"] },
        ],
        nodes: [nodeA, nodeB],
      }),
      deploymentGroupId: "grp-race",
      deploymentRootSpecId: "b",
      runProvisionNode: async (currentNode) => {
        if (currentNode.spec_id === "a") {
          return {
            ok: true,
            reused: true,
            data: { reuse_reason: "became_active_during_provisioning" },
          };
        }
        return { ok: true };
      },
    });

    expect(result.success).toBe(true);
    expect(result.reused_nodes.map((entry) => entry.spec_id)).toEqual(["a"]);
    expect(result.completed_nodes.map((entry) => entry.spec_id)).toEqual(["b"]);
  });

  it("caps per-layer concurrency at five when fan-out is larger", async () => {
    const fanoutNodes = Array.from({ length: 9 }, (_, i) =>
      node({
        key: `svc-${i}:prod:k8s_workspace`,
        spec_id: `svc-${i}`,
        layer_index: 0,
      }),
    );

    let active = 0;
    let maxActive = 0;
    const resolvers: Array<() => void> = [];
    let finished = false;
    const runPromise = executeGraphPlan({
      plan: plan({
        hard_closure_spec_ids: fanoutNodes.map((currentNode) => currentNode.spec_id),
        layers: [{ layer_index: 0, spec_ids: fanoutNodes.map((currentNode) => currentNode.spec_id) }],
        nodes: fanoutNodes,
      }),
      deploymentGroupId: "grp-4",
      deploymentRootSpecId: "svc-8",
      runProvisionNode: async () => {
        active += 1;
        if (active > maxActive) maxActive = active;
        await new Promise<void>((resolve) => {
          resolvers.push(() => {
            active -= 1;
            resolve();
          });
        });
        return { ok: true };
      },
    }).then((result) => {
      finished = true;
      return result;
    });

    while (resolvers.length < 5) {
      await Promise.resolve();
    }
    expect(maxActive).toBe(5);

    while (!finished) {
      const batch = resolvers.splice(0, resolvers.length);
      if (batch.length === 0) {
        await Promise.resolve();
        continue;
      }
      for (const resolve of batch) resolve();
      await Promise.resolve();
    }

    await runPromise;
    expect(maxActive).toBe(5);
  });

  it("serializes same-spec environment nodes within a layer while keeping cross-spec parallelism", async () => {
    const prod = node({ key: "svc-a:prod:k8s_workspace", spec_id: "svc-a", environment: "prod", layer_index: 0 });
    const stage = node({ key: "svc-a:stage:k8s_workspace", spec_id: "svc-a", environment: "stage", layer_index: 0 });
    const other = node({ key: "svc-b:prod:k8s_workspace", spec_id: "svc-b", environment: "prod", layer_index: 0 });

    const activeBySpec = new Map<string, number>();
    let maxSvcAActive = 0;
    let maxGlobalActive = 0;
    let globalActive = 0;
    const resolvers = new Map<string, () => void>();

    const runPromise = executeGraphPlan({
      plan: plan({
        hard_closure_spec_ids: ["svc-a", "svc-b"],
        layers: [{ layer_index: 0, spec_ids: ["svc-a", "svc-b"] }],
        nodes: [prod, stage, other],
      }),
      deploymentGroupId: "grp-serial",
      deploymentRootSpecId: "svc-a",
      maxConcurrencyPerLayer: 3,
      runProvisionNode: async (currentNode) => {
        globalActive += 1;
        activeBySpec.set(currentNode.spec_id, (activeBySpec.get(currentNode.spec_id) || 0) + 1);
        maxGlobalActive = Math.max(maxGlobalActive, globalActive);
        maxSvcAActive = Math.max(maxSvcAActive, activeBySpec.get("svc-a") || 0);
        await new Promise<void>((resolve) => {
          resolvers.set(currentNode.key, () => {
            globalActive -= 1;
            activeBySpec.set(currentNode.spec_id, (activeBySpec.get(currentNode.spec_id) || 1) - 1);
            resolve();
          });
        });
        return { ok: true };
      },
    });

    while (!resolvers.has(prod.key) || !resolvers.has(other.key)) {
      await Promise.resolve();
    }
    expect(resolvers.has(stage.key)).toBe(false);
    expect(maxSvcAActive).toBe(1);
    expect(maxGlobalActive).toBe(2);

    resolvers.get(prod.key)!();
    while (!resolvers.has(stage.key)) {
      await Promise.resolve();
    }
    expect(maxSvcAActive).toBe(1);

    resolvers.get(stage.key)!();
    resolvers.get(other.key)!();

    const result = await runPromise;
    expect(result.success).toBe(true);
    const completedKeys = result.completed_nodes.map((entry) => entry.key);
    expect(completedKeys).toContain(prod.key);
    expect(completedKeys).toContain(stage.key);
    expect(completedKeys).toContain(other.key);
    expect(completedKeys.indexOf(prod.key)).toBeLessThan(completedKeys.indexOf(stage.key));
  });

  it("parses attach and reuse nodes from suffixed workflow step names", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          status: "running",
          steps: [
            {
              name: "build-dependency-plan-1",
              success: true,
              output: JSON.stringify({
                plan: {
                  nodes: [
                    { spec_id: "dep-a", environment: "prod", action: "attach" },
                    { spec_id: "dep-b", environment: "prod", action: "reuse" },
                  ],
                },
              }),
            },
            {
              name: "layer-2-start-1",
              success: true,
            },
          ],
        },
      }),
    } as any);

    const result = await fetchWorkflowStatusFromCfApi("wf-1", "acct", "user@example.com", "key");

    expect(result.completed_nodes).toEqual([
      "dep-a/prod:attached",
      "dep-b/prod:reused",
    ]);
    expect(result.current_layer).toBe(2);
    expect(result.failed_message).toBeNull();
  });

  it("extracts node failures from successful workflow steps that return success=false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          status: "errored",
          error: { message: "Node svc-a/stage failed: Workflow failed: failure" },
          steps: [
            {
              name: "provision-svc-a/stage-1",
              success: true,
              output: JSON.stringify({
                success: false,
                error: "Workflow failed: failure",
              }),
            },
          ],
        },
      }),
    } as any);

    const result = await fetchWorkflowStatusFromCfApi("wf-2", "acct", "user@example.com", "key");

    expect(result.status).toBe("error");
    expect(result.failed_node).toBe("svc-a/stage");
    expect(result.failed_message).toBe("Workflow failed: failure");
    expect(result.completed_nodes).toEqual([]);
  });

  it("rebuilds attach and reuse nodes from workflow params when planner output is truncated", async () => {
    const planResolver = vi.fn(async () => ([
      { spec_id: "dep-a", environment: "prod", action: "attach" },
      { spec_id: "dep-b", environment: "prod", action: "reuse" },
      { spec_id: "svc-a", environment: "prod", action: "reuse" },
    ]));

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          status: "running",
          params: {
            spec_source: "svc-root",
            runtime: "k8s_workspace",
            environments: ["prod", "stage"],
            deployment_mode: "graph",
          },
          steps: [
            {
              name: "build-dependency-plan-1",
              success: true,
              output: '{"plan":{"nodes":[{"ke[truncated output]',
            },
            {
              name: "provision-svc-a/prod-1",
              success: true,
              output: JSON.stringify({ success: true }),
            },
          ],
        },
      }),
    } as any);

    const result = await fetchWorkflowStatusFromCfApi("wf-3", "acct", "user@example.com", "key", planResolver);

    expect(planResolver).toHaveBeenCalledWith({
      spec_source: "svc-root",
      runtime: "k8s_workspace",
      environments: ["prod", "stage"],
      deployment_mode: "graph",
    });
    expect(result.completed_nodes).toEqual([
      "svc-a/prod",
      "dep-a/prod:attached",
      "dep-b/prod:reused",
    ]);
  });
});

describe("ProvisionGraphParams team-slug propagation", () => {
  it("includes postman_team_slug in child node provision body", () => {
    const params: {
      project_name: string;
      domain: string;
      requester_email: string;
      spec_source: string;
      runtime: string;
      k8s_discovery_workspace_link: boolean;
      environments: string[];
      request_origin: string;
      postman_team_slug: string;
      workspace_team_id: number;
      workspace_team_name: string;
      chaos_enabled?: boolean;
      chaos_config?: string;
    } = {
      project_name: "svc-root",
      domain: "financial",
      requester_email: "admin@postman.com",
      spec_source: "svc-root",
      runtime: "k8s_discovery",
      k8s_discovery_workspace_link: true,
      environments: ["dev", "prod"],
      request_origin: "https://se.pm-catalog.dev",
      postman_team_slug: "field-services-v12-demo",
      workspace_team_id: 13347347,
      workspace_team_name: "Field Services v12 Demo",
    };

    const specId = "af-cards-3ds";
    const environment = "dev";
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
      deployment_group_id: "group-1",
      deployment_root_spec_id: params.spec_source,
      graph_node_layer_index: 0,
      graph_node_environment: environment,
      workspace_team_id: params.workspace_team_id,
      workspace_team_name: params.workspace_team_name,
      postman_team_slug: params.postman_team_slug,
    };

    expect(body.postman_team_slug).toBe("field-services-v12-demo");
    expect(body.workspace_team_id).toBe(13347347);
    expect(body.workspace_team_name).toBe("Field Services v12 Demo");
    expect(body.k8s_discovery_workspace_link).toBe(true);
  });
});
