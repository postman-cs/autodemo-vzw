import { describe, expect, it } from "vitest";
import {
  buildBlockedGraphNodeDetails,
  collectBlockedGraphTeardownTargets,
} from "../frontend/src/lib/blocked-graph";
import type { Deployment, ProvisionPlan } from "../frontend/src/lib/types";

const registry = [
  {
    id: "svc-a",
    title: "Service A",
    repo_name: "svc-a-repo",
  },
  {
    id: "svc-b",
    title: "Service B",
    repo_name: "svc-b-repo",
  },
] as const;

function deployment(overrides: Partial<Deployment>): Deployment {
  return {
    spec_id: "svc-a",
    status: "active",
    ...overrides,
  };
}

function plan(nodes: ProvisionPlan["nodes"]): ProvisionPlan {
  return {
    deployment_mode: "graph",
    root_spec_id: "svc-root",
    runtime: "k8s_workspace",
    environments: ["prod", "stage"],
    hard_closure_spec_ids: ["svc-a", "svc-b"],
    soft_neighbor_spec_ids: [],
    layers: [],
    nodes,
    summary: {
      total_nodes: nodes.length,
      reuse_count: 0,
      attach_count: 0,
      provision_count: 0,
      blocked_count: nodes.length,
    },
  };
}

describe("blocked graph helpers", () => {
  it("maps blocked nodes to deployment-backed messages", () => {
    const blockedNodes = buildBlockedGraphNodeDetails(
      plan([
        {
          key: "svc-a:prod:k8s_workspace",
          spec_id: "svc-a",
          environment: "prod",
          runtime: "k8s_workspace",
          layer_index: 0,
          action: "blocked",
          blocked_reason: "incompatible_runtime",
          hard_dependencies: [],
          soft_neighbors: [],
        },
        {
          key: "svc-b:stage:k8s_workspace",
          spec_id: "svc-b",
          environment: "stage",
          runtime: "k8s_workspace",
          layer_index: 1,
          action: "blocked",
          blocked_reason: "invalid_state",
          hard_dependencies: [],
          soft_neighbors: [],
        },
      ]),
      [
        deployment({
          spec_id: "svc-a",
          runtime_mode: "lambda",
          github_repo_name: "svc-a-legacy",
          environment_deployments: JSON.stringify([
            { environment: "prod", status: "active", runtime_url: "https://svc-a.prod.internal" },
          ]),
        }),
        deployment({
          spec_id: "svc-b",
          status: "provisioning",
          github_repo_name: "svc-b-stage",
          environments_json: JSON.stringify(["stage"]),
        }),
      ],
      [...registry],
    );

    expect(blockedNodes).toEqual([
      expect.objectContaining({
        spec_id: "svc-a",
        environment: "prod",
        project_name: "svc-a-legacy",
        message: "Active on Lambda",
      }),
      expect.objectContaining({
        spec_id: "svc-b",
        environment: "stage",
        project_name: "svc-b-stage",
        message: "Status provisioning",
      }),
    ]);
  });

  it("deduplicates teardown targets by project name across environments", () => {
    const blockedNodes = buildBlockedGraphNodeDetails(
      plan([
        {
          key: "svc-a:prod:k8s_workspace",
          spec_id: "svc-a",
          environment: "prod",
          runtime: "k8s_workspace",
          layer_index: 0,
          action: "blocked",
          blocked_reason: "invalid_state",
          hard_dependencies: [],
          soft_neighbors: [],
        },
        {
          key: "svc-a:stage:k8s_workspace",
          spec_id: "svc-a",
          environment: "stage",
          runtime: "k8s_workspace",
          layer_index: 0,
          action: "blocked",
          blocked_reason: "invalid_state",
          hard_dependencies: [],
          soft_neighbors: [],
        },
      ]),
      [
        deployment({
          spec_id: "svc-a",
          status: "provisioning",
          github_repo_name: "svc-a-repo",
          environments_json: JSON.stringify(["prod", "stage"]),
        }),
      ],
      [...registry],
    );

    expect(collectBlockedGraphTeardownTargets(blockedNodes)).toEqual([
      {
        spec_id: "svc-a",
        project_name: "svc-a-repo",
      },
    ]);
  });
});
