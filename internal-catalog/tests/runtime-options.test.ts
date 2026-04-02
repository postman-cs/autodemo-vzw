import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveEcsRuntimeInfra, resolveRuntimeOptionsStatus } from "../src/lib/runtime-options";
import { TEST_K8S_NAMESPACE, TEST_MOCK_SYSTEM_ENV_ID, TEST_MOCK_AIRTABLE_API_KEY, TEST_MOCK_AIRTABLE_BASE_ID, TEST_MOCK_KUBECONFIG_B64, TEST_MOCK_K8S_INGRESS_BASE_DOMAIN, TEST_MOCK_AWS_ACCOUNT_ID, TEST_MOCK_REGION } from "./helpers/constants";
import { _clearDeploymentsCacheForTests, invalidateInfraCache } from "../src/lib/airtable";
import { makeTeamRegistryKV, TEST_TEAM_SLUG } from "./helpers/team-registry";

beforeEach(() => {
  _clearDeploymentsCacheForTests();
  invalidateInfraCache();
});

function makeInfraResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    records: [
      {
        id: "rec_infra_1",
        fields: {
          component: "ecs_shared",
          status: "active",
          cluster_name: "shared-cluster",
          vpc_id: "vpc-123",
          subnet_ids: "subnet-a,subnet-b",
          security_group_ids: "sg-a,sg-b",
          execution_role_arn: `arn:aws:iam::${TEST_MOCK_AWS_ACCOUNT_ID}:role/shared-exec`,
          task_role_arn: `arn:aws:iam::${TEST_MOCK_AWS_ACCOUNT_ID}:role/shared-task`,
          alb_listener_arn: `arn:aws:elasticloadbalancing:${TEST_MOCK_REGION}:${TEST_MOCK_AWS_ACCOUNT_ID}:listener/app/shared/abc/def`,
          alb_dns_name: `shared-alb.${TEST_MOCK_REGION}.elb.amazonaws.com`,
          ecr_repository: "shared-ecr-repo",
          ...overrides,
        },
      },
    ],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("resolveEcsRuntimeInfra", () => {
  it("returns empty infra when no env and no config are provided", async () => {
    const infra = await resolveEcsRuntimeInfra(null, {});

    expect(infra.clusterName).toBe("");
    expect(infra.vpcId).toBe("");
    expect(infra.subnetIds).toEqual([]);
    expect(infra.securityGroupIds).toEqual([]);
    expect(infra.executionRoleArn).toBe("");
    expect(infra.taskRoleArn).toBe("");
    expect(infra.albListenerArn).toBe("");
    expect(infra.albDnsName).toBe("");
    expect(infra.ecrRepository).toBe("");
    expect(infra.maxServices).toBe(100);
  });

  it("fills missing infra fields from active Airtable ecs_shared record", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(makeInfraResponse());

    try {
      const infra = await resolveEcsRuntimeInfra(null, {
        AIRTABLE_API_KEY: TEST_MOCK_AIRTABLE_API_KEY,
        AIRTABLE_BASE_ID: TEST_MOCK_AIRTABLE_BASE_ID,
      });

      expect(infra.clusterName).toBe("shared-cluster");
      expect(infra.vpcId).toBe("vpc-123");
      expect(infra.subnetIds).toEqual(["subnet-a", "subnet-b"]);
      expect(infra.securityGroupIds).toEqual(["sg-a", "sg-b"]);
      expect(infra.executionRoleArn).toBe(`arn:aws:iam::${TEST_MOCK_AWS_ACCOUNT_ID}:role/shared-exec`);
      expect(infra.taskRoleArn).toBe(`arn:aws:iam::${TEST_MOCK_AWS_ACCOUNT_ID}:role/shared-task`);
      expect(infra.albListenerArn).toContain(":listener/app/shared/");
      expect(infra.albDnsName).toBe(`shared-alb.${TEST_MOCK_REGION}.elb.amazonaws.com`);
      expect(infra.ecrRepository).toBe("shared-ecr-repo");
      expect(infra.maxServices).toBe(100);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps env values and only uses Airtable to fill missing fields", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(makeInfraResponse({
      cluster_name: "airtable-cluster",
      subnet_ids: "subnet-x,subnet-y",
      ecr_repository: "airtable-ecr",
    }));

    try {
      const infra = await resolveEcsRuntimeInfra(null, {
        AIRTABLE_API_KEY: TEST_MOCK_AIRTABLE_API_KEY,
        AIRTABLE_BASE_ID: TEST_MOCK_AIRTABLE_BASE_ID,
        RUNTIME_POOL_ECS_CLUSTER_NAME: "env-cluster",
        RUNTIME_POOL_ECS_SUBNET_IDS: "subnet-env-1,subnet-env-2",
        RUNTIME_POOL_ECS_ECR_REPOSITORY: "env-ecr",
      });

      expect(infra.clusterName).toBe("env-cluster");
      expect(infra.subnetIds).toEqual(["subnet-env-1", "subnet-env-2"]);
      expect(infra.ecrRepository).toBe("env-ecr");
      expect(infra.vpcId).toBe("vpc-123");
      expect(infra.securityGroupIds).toEqual(["sg-a", "sg-b"]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("resolveRuntimeOptionsStatus", () => {
  it("uses team registry credentials when team slug is provided", async () => {
    const kv = {
      get: vi.fn(async (key: string, type?: "json") => {
        if (key === "team:field-services-v12-demo" && type === "json") {
          return {
            slug: "field-services-v12-demo",
            team_id: "13347347",
            team_name: "Field Services v12 Demo",
            api_key: "registry-key",
            access_token: "registry-token",
          };
        }
        return null;
      }),
    } as unknown as KVNamespace;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "uuid-prod", name: "Production" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    try {
      await resolveRuntimeOptionsStatus(null, {
        TEAM_REGISTRY: kv,
        KUBECONFIG_B64: TEST_MOCK_KUBECONFIG_B64,
        K8S_INGRESS_BASE_DOMAIN: TEST_MOCK_K8S_INGRESS_BASE_DOMAIN,
        POSTMAN_INSIGHTS_CLUSTER_NAME: "cluster-1",
      }, "field-services-v12-demo");

      expect(fetchSpy).toHaveBeenCalled();
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(String(init?.body || "")).toContain('"teamId":"13347347"');
      expect(init?.headers).toMatchObject({
        "x-access-token": "registry-token",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("marks both k8s modes unavailable when kubeconfig is missing", async () => {
    const status = await resolveRuntimeOptionsStatus(null, {
      K8S_INGRESS_BASE_DOMAIN: TEST_MOCK_K8S_INGRESS_BASE_DOMAIN,
    });

    expect(status.lambda.mode).toBe("lambda");
    expect(status.lambda.available).toBe(true);
    expect(status.ecs_service.mode).toBe("ecs_service");

    expect(status.k8s_workspace.mode).toBe("k8s_workspace");
    expect(status.k8s_workspace.available).toBe(false);
    expect(status.k8s_workspace.unavailableReason).toContain("KUBECONFIG_B64");
    expect(status.k8s_workspace.namespace).toBe(TEST_K8S_NAMESPACE);

    expect(status.k8s_discovery.mode).toBe("k8s_discovery");
    expect(status.k8s_discovery.available).toBe(false);
    expect(status.k8s_discovery.unavailableReason).toContain("KUBECONFIG_B64");
    expect(status.k8s_discovery.namespace).toBe(TEST_K8S_NAMESPACE);
  });

  it("marks k8s_workspace unavailable when no system environments are configured", async () => {
    const status = await resolveRuntimeOptionsStatus(null, {
      KUBECONFIG_B64: TEST_MOCK_KUBECONFIG_B64,
      K8S_INGRESS_BASE_DOMAIN: TEST_MOCK_K8S_INGRESS_BASE_DOMAIN,
      POSTMAN_INSIGHTS_CLUSTER_NAME: "cluster-1",
    });

    expect(status.k8s_workspace.available).toBe(false);
    expect(status.k8s_workspace.unavailableReason).toContain("at least one configured system environment");
    expect(status.k8s_discovery.available).toBe(false);
    expect(status.k8s_discovery.unavailableReason).toContain("Airtable is not configured");
  });

  it("marks k8s_discovery unavailable when cluster name is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.url === "https://bifrost-premium-https-v4.gw.postman.com/ws/proxy") {
        return new Response(JSON.stringify({
          data: [
            { id: TEST_MOCK_SYSTEM_ENV_ID, name: "Production", slug: "prod" },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    try {
      const status = await resolveRuntimeOptionsStatus(null, {
        KUBECONFIG_B64: TEST_MOCK_KUBECONFIG_B64,
        K8S_INGRESS_BASE_DOMAIN: TEST_MOCK_K8S_INGRESS_BASE_DOMAIN,
        POSTMAN_ACCESS_TOKEN: "access-token",
        POSTMAN_TEAM_ID: "13347347",
        TEAM_REGISTRY: makeTeamRegistryKV(),
      }, TEST_TEAM_SLUG);

      expect(status.k8s_workspace.available).toBe(true);
      expect(status.k8s_discovery.available).toBe(false);
      expect(status.k8s_discovery.unavailableReason).toContain("POSTMAN_INSIGHTS_CLUSTER_NAME");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("marks k8s_discovery unavailable when shared infra state cannot be resolved", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.url === "https://bifrost-premium-https-v4.gw.postman.com/ws/proxy") {
        return new Response(JSON.stringify({
          data: [
            { id: TEST_MOCK_SYSTEM_ENV_ID, name: "Production", slug: "prod" },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    try {
      const status = await resolveRuntimeOptionsStatus(null, {
        KUBECONFIG_B64: TEST_MOCK_KUBECONFIG_B64,
        K8S_INGRESS_BASE_DOMAIN: TEST_MOCK_K8S_INGRESS_BASE_DOMAIN,
        K8S_NAMESPACE: "payments",
        POSTMAN_ACCESS_TOKEN: "access-token",
        POSTMAN_TEAM_ID: "13347347",
        POSTMAN_INSIGHTS_CLUSTER_NAME: "cluster-1",
        TEAM_REGISTRY: makeTeamRegistryKV(),
      }, TEST_TEAM_SLUG);

      expect(status.k8s_workspace.available).toBe(true);
      expect(status.k8s_workspace.unavailableReason).toBe("");
      expect(status.k8s_workspace.namespace).toBe("payments");

      expect(status.k8s_discovery.available).toBe(false);
      expect(status.k8s_discovery.unavailableReason).toContain("Airtable is not configured");
      expect(status.k8s_discovery.namespace).toBe("payments");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("marks k8s_discovery available when shared infra record is active", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/Infrastructure")) {
        return new Response(JSON.stringify({
          records: [{
            id: "rec_k8s_discovery",
            fields: {
              component: "k8s_discovery_shared",
              status: "active",
              k8s_namespace: "payments",
              k8s_daemonset_name: "postman-insights-agent",
            },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/Deployments")) {
        return new Response(JSON.stringify({ records: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ records: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    try {
      const status = await resolveRuntimeOptionsStatus(null, {
        AIRTABLE_API_KEY: TEST_MOCK_AIRTABLE_API_KEY,
        AIRTABLE_BASE_ID: TEST_MOCK_AIRTABLE_BASE_ID,
        KUBECONFIG_B64: TEST_MOCK_KUBECONFIG_B64,
        K8S_INGRESS_BASE_DOMAIN: TEST_MOCK_K8S_INGRESS_BASE_DOMAIN,
        K8S_NAMESPACE: "payments",
        POSTMAN_SYSTEM_ENV_PROD: TEST_MOCK_SYSTEM_ENV_ID,
        POSTMAN_INSIGHTS_CLUSTER_NAME: "cluster-1",
      });

      expect(status.k8s_discovery.available).toBe(true);
      expect(status.k8s_discovery.unavailableReason).toBe("");
      expect(status.k8s_discovery.namespace).toBe("payments");
      expect(status.k8s_discovery.activeServices).toBe(0);
      expect(status.k8s_discovery.sharedInfraActive).toBe(true);
      expect(status.k8s_discovery.sharedInfraStatus).toBe("active");
      expect(status.k8s_discovery.daemonsetName).toBe("postman-insights-agent");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("reports active k8s_discovery service count from Airtable deployments", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/Infrastructure")) {
        return new Response(JSON.stringify({
          records: [{
            id: "rec_k8s_discovery",
            fields: {
              component: "k8s_discovery_shared",
              status: "active",
              k8s_namespace: "payments",
              k8s_daemonset_name: "postman-insights-agent",
            },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/Deployments")) {
        return new Response(JSON.stringify({
          records: [{
            id: "rec_dep_1",
            fields: {
              spec_id: "af-payments-core",
              status: "active",
              runtime_mode: "k8s_discovery",
            },
          }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ records: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    try {
      const status = await resolveRuntimeOptionsStatus(null, {
        AIRTABLE_API_KEY: TEST_MOCK_AIRTABLE_API_KEY,
        AIRTABLE_BASE_ID: TEST_MOCK_AIRTABLE_BASE_ID,
        KUBECONFIG_B64: TEST_MOCK_KUBECONFIG_B64,
        K8S_INGRESS_BASE_DOMAIN: TEST_MOCK_K8S_INGRESS_BASE_DOMAIN,
        K8S_NAMESPACE: "payments",
        POSTMAN_SYSTEM_ENV_PROD: TEST_MOCK_SYSTEM_ENV_ID,
        POSTMAN_INSIGHTS_CLUSTER_NAME: "cluster-1",
      });

      expect(status.k8s_discovery.available).toBe(true);
      expect(status.k8s_discovery.activeServices).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
