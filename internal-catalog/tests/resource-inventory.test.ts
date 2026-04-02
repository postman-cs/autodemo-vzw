import { describe, it, expect } from "vitest";
import { buildDerivedResourceInventory, buildResourceInventory } from "../src/lib/resource-inventory";
import { TEST_AWS_REGION, TEST_K8S_NAMESPACE, TEST_WORKER_URL } from "./helpers/constants";

describe("resource inventory", () => {
  it("builds lambda inventory with API Gateway and Lambda ARN details", () => {
    const inventory = buildDerivedResourceInventory(
      {
        spec_id: "af-cards-3ds",
        status: "active",
        runtime_mode: "lambda",
        aws_region: TEST_AWS_REGION,
        aws_invoke_url: "https://abc123.execute-api.eu-west-2.amazonaws.com/",
        lambda_function_name: "af-cards-3ds-dev",
      },
      {
        AWS_REGION: TEST_AWS_REGION,
        AWS_LAMBDA_ROLE_ARN: "arn:aws:iam::780401591112:role/vzw-partner-demo-lambda-execution-role",
      },
    );

    expect(inventory.runtime_mode).toBe("lambda");
    expect(inventory.source).toBe("derived");
    expect(inventory.resources.some((resource) => resource.kind === "lambda_function")).toBe(true);
    expect(inventory.resources.some((resource) => resource.kind === "api_gateway_http_api")).toBe(true);
    expect(inventory.resources.some((resource) => resource.kind === "ecs_cluster")).toBe(false);
    expect(inventory.resources.some((resource) => resource.kind === "ecs_service")).toBe(false);
    expect(inventory.resources.some((resource) => resource.kind === "ecs_task_definition")).toBe(false);

    const gateway = inventory.resources.find((resource) => resource.kind === "api_gateway_http_api");
    expect(gateway?.id).toBe("abc123");
    expect(gateway?.arn).toContain("arn:aws:execute-api:eu-west-2:780401591112:abc123");
  });

  it("builds ecs_service inventory with route and ECS metadata", () => {
    const inventory = buildDerivedResourceInventory(
      {
        spec_id: "af-core-deposits",
        status: "active",
        runtime_mode: "ecs_service",
        aws_region: TEST_AWS_REGION,
        runtime_base_url: `${TEST_WORKER_URL}/services/af-core-deposits`,
        aws_invoke_url: `${TEST_WORKER_URL}/services/af-core-deposits`,
        ecs_cluster_name: "demo-ecs-cluster",
        ecs_service_name: "demo-ecs-service",
        ecs_task_definition: "demo-ecs-task",
      },
      {
        AWS_REGION: TEST_AWS_REGION,
      },
    );

    expect(inventory.runtime_mode).toBe("ecs_service");
    expect(inventory.resources.some((resource) => resource.kind === "runtime_route")).toBe(true);
    expect(inventory.resources.some((resource) => resource.kind === "ecs_cluster")).toBe(true);
    expect(inventory.resources.some((resource) => resource.kind === "ecs_service")).toBe(true);
    expect(inventory.resources.some((resource) => resource.kind === "ecs_task_definition")).toBe(true);
    expect(inventory.resources.some((resource) => resource.kind === "lambda_function")).toBe(false);
    expect(inventory.resources.some((resource) => resource.kind === "api_gateway_http_api")).toBe(false);
  });

  it("builds kubernetes inventory with namespace, deployment, service, and ingress resources", () => {
    const inventory = buildDerivedResourceInventory(
      {
        spec_id: "af-ledger-reporting",
        status: "active",
        runtime_mode: "k8s_discovery",
        runtime_base_url: "https://api.catalog.example.com/svc/af-ledger-reporting",
        k8s_namespace: TEST_K8S_NAMESPACE,
        k8s_deployment_name: "af-ledger-reporting",
        k8s_service_name: "af-ledger-reporting",
        k8s_ingress_name: "af-ledger-reporting-ing",
      },
      {
        AWS_REGION: TEST_AWS_REGION,
      },
    );

    expect(inventory.runtime_mode).toBe("k8s_discovery");
    expect(inventory.resources.some((resource) => resource.kind === "k8s_namespace")).toBe(true);
    expect(inventory.resources.some((resource) => resource.kind === "k8s_deployment")).toBe(true);
    expect(inventory.resources.some((resource) => resource.kind === "k8s_service")).toBe(true);
    expect(inventory.resources.some((resource) => resource.kind === "k8s_ingress")).toBe(true);
    expect(inventory.resources.some((resource) => resource.kind === "lambda_function")).toBe(false);
    expect(inventory.resources.some((resource) => resource.kind === "ecs_service")).toBe(false);

    const ingress = inventory.resources.find((resource) => resource.kind === "k8s_ingress");
    expect(ingress?.provider).toBe("kubernetes");
    expect(ingress?.url).toBe("https://api.catalog.example.com/svc/af-ledger-reporting");
  });

  it("derives per-environment kubernetes resources without double-appending the environment suffix", () => {
    const inventory = buildDerivedResourceInventory(
      {
        spec_id: "af-ledger-reporting",
        status: "active",
        runtime_mode: "k8s_workspace",
        k8s_namespace: TEST_K8S_NAMESPACE,
        k8s_deployment_name: "af-ledger-reporting-prod",
        k8s_service_name: "af-ledger-reporting-prod",
        k8s_ingress_name: "af-ledger-reporting-prod-ingress",
        environment_deployments: JSON.stringify([
          { environment: "prod", runtime_url: "https://runtime.example/svc/af-ledger-reporting-prod", status: "active" },
          { environment: "stage", runtime_url: "https://runtime.example/svc/af-ledger-reporting-stage", status: "active" },
        ]),
      },
      {
        AWS_REGION: TEST_AWS_REGION,
      },
    );

    const deployments = inventory.resources.filter((resource) => resource.kind === "k8s_deployment");
    const ingresses = inventory.resources.filter((resource) => resource.kind === "k8s_ingress");

    expect(deployments.map((resource) => resource.name)).toEqual(["af-ledger-reporting-prod", "af-ledger-reporting-stage"]);
    expect(ingresses.map((resource) => resource.name)).toEqual(["af-ledger-reporting-prod-ingress", "af-ledger-reporting-stage-ingress"]);
    expect(deployments.map((resource) => resource.metadata?.environment)).toEqual(["prod", "stage"]);
  });

  it("derives per-environment lambda and API Gateway resources from environment_deployments", () => {
    const inventory = buildDerivedResourceInventory(
      {
        spec_id: "af-cards-3ds",
        status: "active",
        runtime_mode: "lambda",
        aws_region: TEST_AWS_REGION,
        lambda_function_name: "af-cards-3ds-prod",
        environment_deployments: JSON.stringify([
          {
            environment: "prod",
            runtime_url: "https://prod123.execute-api.eu-west-2.amazonaws.com",
            api_gateway_id: "prod123",
            status: "active",
          },
          {
            environment: "stage",
            runtime_url: "https://stage123.execute-api.eu-west-2.amazonaws.com",
            api_gateway_id: "stage123",
            status: "active",
          },
        ]),
      },
      {
        AWS_REGION: TEST_AWS_REGION,
        AWS_LAMBDA_ROLE_ARN: "arn:aws:iam::780401591112:role/vzw-partner-demo-lambda-execution-role",
      },
    );

    const functions = inventory.resources.filter((resource) => resource.kind === "lambda_function");
    const gateways = inventory.resources.filter((resource) => resource.kind === "api_gateway_http_api");

    expect(functions.map((resource) => resource.name)).toEqual(["af-cards-3ds-prod", "af-cards-3ds-stage"]);
    expect(functions.map((resource) => resource.metadata?.environment)).toEqual(["prod", "stage"]);
    expect(gateways.map((resource) => resource.id)).toEqual(["prod123", "stage123"]);
    expect(gateways.map((resource) => resource.metadata?.environment)).toEqual(["prod", "stage"]);
  });

  it("prefers persisted Airtable inventory when available", () => {
    const inventory = buildResourceInventory(
      {
        spec_id: "af-cards-activation",
        status: "active",
        runtime_mode: "lambda",
        resource_inventory_json: JSON.stringify({
          runtime_mode: "lambda",
          generated_at: "2026-02-27T18:00:00Z",
          resources: [
            {
              provider: "aws",
              kind: "api_gateway_http_api",
              name: "af-cards-activation-dev-api",
              id: "persisted123",
              region: TEST_AWS_REGION,
            },
          ],
        }),
      },
      {
        AWS_REGION: TEST_AWS_REGION,
      },
    );

    expect(inventory.source).toBe("airtable");
    expect(inventory.resources).toHaveLength(1);
    expect(inventory.resources[0].id).toBe("persisted123");
  });

  it("falls back to derived inventory when persisted data drops environment metadata", () => {
    const inventory = buildResourceInventory(
      {
        spec_id: "af-core-deposits",
        status: "active",
        runtime_mode: "ecs_service",
        aws_region: TEST_AWS_REGION,
        ecs_cluster_name: "demo-ecs-cluster",
        ecs_service_name: "af-core-deposits-svc-prod",
        ecs_task_definition: "af-core-deposits-task-prod",
        environment_deployments: JSON.stringify([
          { environment: "prod", runtime_url: "https://runtime.example/svc/af-core-deposits-prod", status: "active" },
          { environment: "stage", runtime_url: "https://runtime.example/svc/af-core-deposits-stage", status: "active" },
        ]),
        resource_inventory_json: JSON.stringify({
          runtime_mode: "ecs_service",
          generated_at: "2026-02-27T18:00:00Z",
          resources: [
            {
              provider: "aws",
              kind: "runtime_route",
              name: "Shared runtime route",
              url: "https://runtime.example/svc/af-core-deposits-prod",
            },
          ],
        }),
      },
      {
        AWS_REGION: TEST_AWS_REGION,
      },
    );

    expect(inventory.source).toBe("derived");
    expect(inventory.resources.filter((resource) => resource.kind === "ecs_service").map((resource) => resource.name))
      .toEqual(["af-core-deposits-svc-prod", "af-core-deposits-svc-stage"]);
    expect(inventory.resources.filter((resource) => resource.kind === "ecs_service").map((resource) => resource.metadata?.environment))
      .toEqual(["prod", "stage"]);
  });
});
