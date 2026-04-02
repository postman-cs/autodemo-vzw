import { describe, expect, it } from "vitest";
import { createDependencyPlan, DependencyPlannerError, type DependencyMap } from "../src/lib/dependency-planner";
import type { DeploymentRecord } from "../src/lib/airtable";

function deployment(overrides: Partial<DeploymentRecord>): DeploymentRecord {
  return {
    spec_id: "svc-root",
    status: "active",
    ...overrides,
  } as DeploymentRecord;
}

describe("dependency planner", () => {
  const dependencies: DependencyMap = {
    "svc-root": {
      dependsOn: ["svc-a", "svc-b"],
      consumesApis: ["svc-neighbor"],
    },
    "svc-a": {
      dependsOn: ["svc-c"],
      consumesApis: ["svc-neighbor"],
    },
    "svc-b": {
      dependsOn: [],
      consumesApis: [],
    },
    "svc-c": {
      dependsOn: [],
      consumesApis: [],
    },
    "svc-neighbor": {
      dependsOn: [],
      consumesApis: [],
    },
  };

  it("uses dependsOn for closure and treats consumesApis as informational metadata", () => {
    const plan = createDependencyPlan({
      rootSpecId: "svc-root",
      runtime: "k8s_workspace",
      environments: ["prod"],
      deploymentMode: "graph",
      dependencies,
      deployments: [],
    });

    expect(plan.hard_closure_spec_ids).toEqual(["svc-b", "svc-c", "svc-a", "svc-root"]);
    expect(plan.soft_neighbor_spec_ids).toEqual(["svc-neighbor"]);
    expect(plan.layers.map((layer) => layer.spec_ids)).toEqual([
      ["svc-b", "svc-c"],
      ["svc-a"],
      ["svc-root"],
    ]);
  });

  it("classifies nodes by spec_id + environment + runtime for reuse/attach/provision/blocked", () => {
    const plan = createDependencyPlan({
      rootSpecId: "svc-root",
      runtime: "k8s_workspace",
      environments: ["prod"],
      deploymentMode: "graph",
      dependencies,
      deployments: [
        deployment({
          spec_id: "svc-c",
          status: "active",
          runtime_mode: "k8s_workspace",
          environment_deployments: JSON.stringify([
            { environment: "prod", runtime_url: "https://svc-c.prod.internal", status: "active" },
          ]),
        }),
        deployment({
          spec_id: "svc-a",
          status: "provisioning",
          runtime_mode: "k8s_workspace",
          environments_json: JSON.stringify(["prod"]),
        }),
        deployment({
          spec_id: "svc-b",
          status: "active",
          runtime_mode: "k8s_discovery",
          environments_json: JSON.stringify(["prod"]),
        }),
      ],
    });

    const nodeBySpec = new Map(plan.nodes.map((node) => [node.spec_id, node]));
    expect(nodeBySpec.get("svc-c")?.action).toBe("reuse");
    expect(nodeBySpec.get("svc-a")?.action).toBe("blocked");
    expect(nodeBySpec.get("svc-a")?.blocked_reason).toBe("invalid_state");
    expect(nodeBySpec.get("svc-b")?.action).toBe("attach");
    expect(nodeBySpec.get("svc-root")?.action).toBe("provision");

    expect(plan.summary).toEqual({
      total_nodes: 4,
      reuse_count: 1,
      attach_count: 1,
      provision_count: 1,
      blocked_count: 1,
    });
  });

  it("keeps incompatible non-kubernetes runtimes blocked in graph mode", () => {
    const plan = createDependencyPlan({
      rootSpecId: "svc-root",
      runtime: "k8s_workspace",
      environments: ["prod"],
      deploymentMode: "graph",
      dependencies,
      deployments: [
        deployment({
          spec_id: "svc-b",
          status: "active",
          runtime_mode: "lambda",
          environments_json: JSON.stringify(["prod"]),
        }),
      ],
    });

    const nodeBySpec = new Map(plan.nodes.map((node) => [node.spec_id, node]));
    expect(nodeBySpec.get("svc-b")?.action).toBe("blocked");
    expect(nodeBySpec.get("svc-b")?.blocked_reason).toBe("incompatible_runtime");
  });

  it("treats deprovisioned tombstones as absent (eligible for fresh provisioning)", () => {
    const plan = createDependencyPlan({
      rootSpecId: "svc-root",
      runtime: "k8s_workspace",
      environments: ["prod"],
      deploymentMode: "graph",
      dependencies,
      deployments: [
        deployment({
          spec_id: "svc-a",
          status: "deprovisioned" as any,
          runtime_mode: "k8s_workspace",
          environments_json: JSON.stringify(["prod"]),
        }),
      ],
    });

    const nodeBySpec = new Map(plan.nodes.map((node) => [node.spec_id, node]));
    expect(nodeBySpec.get("svc-a")?.action).toBe("provision");
    expect(nodeBySpec.get("svc-root")?.action).toBe("provision");
  });

  it("expands closure across multiple environments and deduplicates by spec+environment+runtime", () => {
    const plan = createDependencyPlan({
      rootSpecId: "svc-root",
      runtime: "k8s_workspace",
      environments: ["prod", "stage"],
      deploymentMode: "graph",
      dependencies,
      deployments: [
        deployment({
          spec_id: "svc-root",
          runtime_mode: "k8s_workspace",
          status: "active",
          environment_deployments: JSON.stringify([
            { environment: "stage", runtime_url: "https://svc-root.stage.internal", status: "active" },
          ]),
        }),
      ],
    });

    expect(plan.nodes).toHaveLength(8);
    expect(plan.nodes.filter((node) => node.spec_id === "svc-root" && node.action === "reuse")).toHaveLength(1);
    expect(plan.nodes.filter((node) => node.spec_id === "svc-root" && node.action === "provision")).toHaveLength(1);
    expect(new Set(plan.nodes.map((node) => node.key)).size).toBe(plan.nodes.length);
  });

  it("reports missing hard prerequisites in single mode and recommends graph mode", () => {
    const plan = createDependencyPlan({
      rootSpecId: "svc-root",
      runtime: "k8s_workspace",
      environments: ["prod"],
      deploymentMode: "single",
      dependencies,
      deployments: [],
    });

    expect(plan.single_mode_guidance?.recommend_graph_mode).toBe(true);
    expect(plan.single_mode_guidance?.missing_hard_prerequisites.map((entry) => entry.spec_id)).toEqual([
      "svc-b",
      "svc-c",
      "svc-a",
    ]);
  });

  it("rejects graph mode for unsupported runtimes and reports hard-graph cycles", () => {
    expect(() => createDependencyPlan({
      rootSpecId: "svc-root",
      runtime: "lambda",
      environments: ["prod"],
      deploymentMode: "graph",
      dependencies,
      deployments: [],
    })).toThrowError(DependencyPlannerError);

    const cyclic: DependencyMap = {
      "svc-root": { dependsOn: ["svc-a"], consumesApis: [] },
      "svc-a": { dependsOn: ["svc-root"], consumesApis: [] },
    };
    expect(() => createDependencyPlan({
      rootSpecId: "svc-root",
      runtime: "k8s_workspace",
      environments: ["prod"],
      deploymentMode: "graph",
      dependencies: cyclic,
      deployments: [],
    })).toThrowError(DependencyPlannerError);
  });
});
