import { describe, it, expect } from "vitest";
import {
  SERVICE_REGISTRY_SCHEMA,
  CATALOG_API_CONTRACT,
  PROVISIONER_API_CONTRACT,
  TWO_WORKER_TOPOLOGY,
  validateTopologyContracts,
} from "../src/lib/two-worker-contract";

describe("two-worker topology contract", () => {
  it("defines exactly two active workers with clear responsibilities", () => {
    expect(TWO_WORKER_TOPOLOGY.workers).toHaveLength(2);
    expect(TWO_WORKER_TOPOLOGY.workers.map((worker) => worker.id).sort()).toEqual([
      "catalog",
      "provisioner",
    ]);

    const provisioner = TWO_WORKER_TOPOLOGY.workers.find((worker) => worker.id === "provisioner");
    const catalog = TWO_WORKER_TOPOLOGY.workers.find((worker) => worker.id === "catalog");

    expect(provisioner?.responsibilities).toContain("service_lifecycle");
    expect(catalog?.responsibilities).toContain("service_catalog_read");
  });
});

describe("provisioner API contract", () => {
  it("captures required lifecycle endpoints and methods", () => {
    const endpoints = PROVISIONER_API_CONTRACT.endpoints;
    const signature = endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort();

    expect(signature).toEqual([
      "GET /api/health",
      "GET /api/status",
      "GET /api/teams",
      "POST /api/provision",
      "POST /api/teardown",
      "POST /api/teardown/batch",
    ]);
  });
});

describe("catalog API contract", () => {
  it("defines read-only service catalog surface", () => {
    const endpoints = CATALOG_API_CONTRACT.endpoints;
    const signature = endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort();

    expect(signature).toEqual([
      "GET /api/catalog",
      "GET /api/catalog/:service_id",
      "GET /api/health",
    ]);
  });
});

describe("service registry KV schema", () => {
  it("defines canonical service and index key namespaces", () => {
    expect(SERVICE_REGISTRY_SCHEMA.record_key_prefix).toBe("service:");
    expect(SERVICE_REGISTRY_SCHEMA.index_key_prefixes).toEqual([
      "index:status:",
      "index:runtime:",
      "index:region:",
      "index:env:",
    ]);
  });

  it("declares required service metadata fields for catalog use", () => {
    expect(SERVICE_REGISTRY_SCHEMA.required_fields).toEqual([
      "service_id",
      "project_name",
      "runtime_mode",
      "aws_region",
      "status",
      "environment_urls",
      "updated_at",
    ]);
  });
});

describe("contract consistency", () => {
  it("validates topology and API contracts as internally consistent", () => {
    const result = validateTopologyContracts();
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("keeps catalog contract read-only", () => {
    const methods = new Set(CATALOG_API_CONTRACT.endpoints.map((endpoint) => endpoint.method));
    expect(Array.from(methods)).toEqual(["GET"]);
  });
});
