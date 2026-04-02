export type WorkerId = "provisioner" | "catalog";

export interface WorkerTopology {
  id: WorkerId;
  entrypoint: string;
  responsibilities: string[];
  route_scope: string[];
  required_bindings: string[];
}

export interface TwoWorkerTopologyContract {
  workers: WorkerTopology[];
}

export interface ApiEndpointContract {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  purpose: string;
}

export interface WorkerApiContract {
  worker: WorkerId;
  endpoints: ApiEndpointContract[];
}

export interface ServiceRegistrySchemaContract {
  record_key_prefix: string;
  index_key_prefixes: string[];
  required_fields: string[];
}

export interface ContractValidationResult {
  valid: boolean;
  errors: string[];
}

export const TWO_WORKER_TOPOLOGY: TwoWorkerTopologyContract = {
  workers: [
    {
      id: "provisioner",
      entrypoint: "src/catalog-provision.ts",
      responsibilities: [
        "service_lifecycle",
        "aws_provisioning_orchestration",
        "registry_write",
      ],
      route_scope: [
        "/api/health",
        "/api/provision",
        "/api/status",
        "/api/teardown",
        "/api/teardown/batch",
        "/api/teams",
      ],
      required_bindings: [
        "PORTAL_CONFIG",
        "SERVICE_REGISTRY",
        "POSTMAN_API_KEY",
        "POSTMAN_ACCESS_TOKEN",
        "GH_TOKEN",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
      ],
    },
    {
      id: "catalog",
      entrypoint: "src/catalog.ts",
      responsibilities: [
        "service_catalog_read",
        "registry_query",
      ],
      route_scope: ["/api/health", "/api/catalog", "/catalog"],
      required_bindings: ["SERVICE_REGISTRY"],
    },
  ],
};

export const PROVISIONER_API_CONTRACT: WorkerApiContract = {
  worker: "provisioner",
  endpoints: [
    { method: "GET", path: "/api/health", purpose: "worker_liveness" },
    { method: "POST", path: "/api/provision", purpose: "create_or_update_service" },
    { method: "GET", path: "/api/teams", purpose: "list_available_postman_teams" },
    { method: "POST", path: "/api/teardown", purpose: "teardown_service" },
    { method: "POST", path: "/api/teardown/batch", purpose: "teardown_services_batch" },
    { method: "GET", path: "/api/status", purpose: "retrieve_service_status" },
  ],
};

export const CATALOG_API_CONTRACT: WorkerApiContract = {
  worker: "catalog",
  endpoints: [
    { method: "GET", path: "/api/health", purpose: "worker_liveness" },
    { method: "GET", path: "/api/catalog", purpose: "list_services" },
    { method: "GET", path: "/api/catalog/:service_id", purpose: "get_service_detail" },
  ],
};

export const SERVICE_REGISTRY_SCHEMA: ServiceRegistrySchemaContract = {
  record_key_prefix: "service:",
  index_key_prefixes: [
    "index:status:",
    "index:runtime:",
    "index:region:",
    "index:env:",
  ],
  required_fields: [
    "service_id",
    "project_name",
    "runtime_mode",
    "aws_region",
    "status",
    "environment_urls",
    "updated_at",
  ],
};

function endpointInScope(path: string, scopes: string[]): boolean {
  return scopes.some((scope) => {
    if (scope === path) return true;
    if (scope.endsWith("/:service_id")) {
      const base = scope.slice(0, -":service_id".length);
      return path.startsWith(base);
    }
    return path.startsWith(scope);
  });
}

export function validateTopologyContracts(): ContractValidationResult {
  const errors: string[] = [];

  const workerIds = new Set(TWO_WORKER_TOPOLOGY.workers.map((worker) => worker.id));
  if (workerIds.size !== 2 || !workerIds.has("provisioner") || !workerIds.has("catalog")) {
    errors.push("Topology must include exactly 'provisioner' and 'catalog' workers.");
  }

  const contracts: WorkerApiContract[] = [PROVISIONER_API_CONTRACT, CATALOG_API_CONTRACT];
  const contractWorkers = new Set(contracts.map((contract) => contract.worker));
  if (contractWorkers.size !== contracts.length) {
    errors.push("API contract workers must be unique.");
  }

  for (const contract of contracts) {
    if (!workerIds.has(contract.worker)) {
      errors.push(`Contract declared for unknown worker '${contract.worker}'.`);
      continue;
    }
    const workerTopology = TWO_WORKER_TOPOLOGY.workers.find((worker) => worker.id === contract.worker);
    if (!workerTopology) continue;

    for (const endpoint of contract.endpoints) {
      if (!endpointInScope(endpoint.path, workerTopology.route_scope)) {
        errors.push(`Endpoint ${endpoint.method} ${endpoint.path} is outside route scope for ${contract.worker}.`);
      }
    }
  }

  const catalogMutating = CATALOG_API_CONTRACT.endpoints.some((endpoint) => endpoint.method !== "GET");
  if (catalogMutating) {
    errors.push("Catalog API contract must remain read-only.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
