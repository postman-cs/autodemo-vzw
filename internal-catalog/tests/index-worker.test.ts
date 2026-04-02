import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../src/index";
import { _clearDeploymentsCacheForTests, invalidateInfraCache } from "../src/lib/airtable";
import { invalidateResolvedDeploymentsCache } from "../src/lib/deployment-state";
import { TEST_AWS_REGION, TEST_ECR_REPOSITORY, TEST_GITHUB_ORG, TEST_K8S_NAMESPACE, TEST_POSTMAN_TEAM_ID, TEST_WORKER_URL, TEST_AWS_ACCOUNT_ID, TEST_MOCK_AIRTABLE_API_KEY, TEST_MOCK_AIRTABLE_BASE_ID, TEST_MOCK_KUBECONFIG_B64, TEST_MOCK_K8S_INGRESS_BASE_DOMAIN, TEST_MOCK_SYSTEM_ENV_ID } from "./helpers/constants";
import { makeTeamRegistryKV, TEST_TEAM_SLUG } from "./helpers/team-registry";

beforeEach(() => {
  _clearDeploymentsCacheForTests();
  invalidateInfraCache();
  invalidateResolvedDeploymentsCache();
});

function makeAssetsBinding(): { fetch: (request: Request) => Promise<Response> } {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(
          "<!doctype html><html><body><div id=\"root\"></div></body></html>",
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      if (url.pathname === "/assets/app.js") {
        return new Response("console.log('ok');", {
          status: 200,
          headers: { "Content-Type": "application/javascript" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  };
}

function makeEnv() {
  return {
    ASSETS: makeAssetsBinding(),
    PORTAL_CONFIG: {
      get: async () => null,
    } as unknown as KVNamespace,
  } as any;
}

function makeWorkerLogsBinding() {
  const store = new Map<string, { value: string; metadata?: unknown }>();
  return {
    store,
    binding: {
      async put(key: string, value: string, options?: { metadata?: unknown }) {
        store.set(key, { value, metadata: options?.metadata });
      },
      async get(key: string, type?: "text" | "json") {
        const entry = store.get(key);
        if (!entry) return null;
        if (type === "json") {
          return JSON.parse(entry.value);
        }
        return entry.value;
      },
      async list(options?: { prefix?: string; limit?: number }) {
        const prefix = options?.prefix || "";
        const limit = options?.limit ?? store.size;
        return {
          keys: Array.from(store.entries())
            .filter(([key]) => key.startsWith(prefix))
            .sort(([left], [right]) => left.localeCompare(right))
            .slice(0, limit)
            .map(([name, entry]) => ({ name, metadata: entry.metadata })),
          list_complete: true,
          cursor: "",
        };
      },
    } as unknown as KVNamespace,
  };
}

function makeExecutionContext() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    } as ExecutionContext,
    async drain() {
      await Promise.allSettled(pending);
    },
  };
}

function makeCtx(): ExecutionContext {
  return makeExecutionContext().ctx;
}

function makeAirtableEnv() {
  return {
    ...makeEnv(),
    AIRTABLE_API_KEY: TEST_MOCK_AIRTABLE_API_KEY,
    AIRTABLE_BASE_ID: TEST_MOCK_AIRTABLE_BASE_ID,
    POSTMAN_API_KEY: "pmak-test",
    AWS_REGION: TEST_AWS_REGION,
    AWS_LAMBDA_ROLE_ARN: `arn:aws:iam::${TEST_AWS_ACCOUNT_ID}:role/vzw-partner-demo-lambda-execution-role`,
  } as any;
}

function makeCfAccessEnv(overrides: Record<string, unknown> = {}) {
  return {
    ...makeEnv(),
    AUTH_ENABLED: "true",
    CF_ACCESS_TEAM_DOMAIN: "testteam",
    CF_ACCESS_AUD: "test-aud-tag",
    ...overrides,
  } as any;
}

function makeMutableTeamRegistryKV() {
  const store = new Map<string, string>();
  store.set("team-index", JSON.stringify([]));

  return {
    async get(key: string, type?: "text" | "json") {
      const value = store.get(key);
      if (value == null) return null;
      if (type === "json") return JSON.parse(value);
      return value;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(options?: { prefix?: string; limit?: number }) {
      const prefix = options?.prefix || "";
      const limit = options?.limit ?? store.size;
      return {
        keys: Array.from(store.keys())
          .filter((name) => name.startsWith(prefix))
          .slice(0, limit)
          .map((name) => ({ name })),
        list_complete: true,
        cursor: "",
      };
    },
  } as unknown as KVNamespace;
}

describe("index worker SPA routing", () => {
  it("serves the SPA shell for direct /provision navigation", async () => {
    const request = new Request(`${TEST_WORKER_URL}/provision`, {
      headers: { Accept: "text/html" },
    });
    const response = await worker.fetch(request, makeEnv(), makeCtx());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("<div id=\"root\"></div>");
  });

  it("returns asset 404 for unknown static file paths", async () => {
    const request = new Request(`${TEST_WORKER_URL}/assets/missing.js`);
    const response = await worker.fetch(request, makeEnv(), makeCtx());

    expect(response.status).toBe(404);
  });

  it("keeps API routes as JSON responses", async () => {
    const request = new Request(`${TEST_WORKER_URL}/api/health`);
    const response = await worker.fetch(request, makeEnv(), makeCtx());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = await response.json() as Record<string, unknown>;
    expect(body.worker).toBe("vzw-internal-catalog");
  });

  it("adds an x-request-id response header and writes request lifecycle logs", async () => {
    const workerLogs = makeWorkerLogsBinding();
    const execution = makeExecutionContext();
    const response = await worker.fetch(
      new Request(`${TEST_WORKER_URL}/api/health`),
      {
        ...makeEnv(),
        WORKER_LOGS: workerLogs.binding,
      } as any,
      execution.ctx,
    );

    await execution.drain();

    expect(response.status).toBe(200);
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
    const logEntries = Array.from(workerLogs.store.values()).map(({ value }) => JSON.parse(value) as Record<string, unknown>);
    expect(logEntries.map((entry) => entry.event)).toContain("request.received");
    expect(logEntries.map((entry) => entry.event)).toContain("request.completed");
    expect(logEntries.every((entry) => entry.request_id === requestId)).toBe(true);
  });

  it("returns request-scoped worker logs from /api/worker-logs", async () => {
    const workerLogs = makeWorkerLogsBinding();
    const execution = makeExecutionContext();
    const seedRequestId = "req-test-123";
    await workerLogs.binding.put(
      `worker-log:${seedRequestId}:2026-03-08T00:00:00.000Z:test`,
      JSON.stringify({
        request_id: seedRequestId,
        route: "/api/health",
        method: "GET",
        event: "request.completed",
        level: "info",
        timestamp: "2026-03-08T00:00:00.000Z",
      }),
    );

    const response = await worker.fetch(
      new Request(`${TEST_WORKER_URL}/api/worker-logs?request_id=${seedRequestId}`),
      {
        ...makeEnv(),
        WORKER_LOGS: workerLogs.binding,
      } as any,
      execution.ctx,
    );

    await execution.drain();

    expect(response.status).toBe(200);
    const body = await response.json() as { request_id: string; logs: Array<Record<string, unknown>> };
    expect(body.request_id).toBe(seedRequestId);
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.event).toBe("request.completed");
  });

  it("validates GitHub webhook signatures on /api/github/webhook", async () => {
    const payload = JSON.stringify({ action: "completed", workflow_run: { id: 42 } });
    const request = new Request(`${TEST_WORKER_URL}/api/github/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "workflow_run",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": "sha256=bad",
      },
      body: payload,
    });

    const response = await worker.fetch(request, {
      ...makeEnv(),
      GITHUB_WEBHOOK_SECRET: "secret123",
    } as any, makeCtx());
    expect(response.status).toBe(401);
  });

  it("validates POST /api/teardown/batch request body", async () => {
    const request = new Request(`${TEST_WORKER_URL}/api/teardown/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [] }),
    });
    const response = await worker.fetch(request, makeEnv(), makeCtx());

    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, unknown>;
    expect(String(body.error || "")).toContain("items or project_names");
  });

  it("includes lambda, ecs_service, and k8s runtime status in GET /api/config", async () => {
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
      const request = new Request(`${TEST_WORKER_URL}/api/config?team_slug=${TEST_TEAM_SLUG}`);
      const response = await worker.fetch(request, {
        ...makeEnv(),
        KUBECONFIG_B64: TEST_MOCK_KUBECONFIG_B64,
        K8S_INGRESS_BASE_DOMAIN: TEST_MOCK_K8S_INGRESS_BASE_DOMAIN,
        POSTMAN_ACCESS_TOKEN: "access-token",
        POSTMAN_TEAM_ID: TEST_POSTMAN_TEAM_ID,
        POSTMAN_INSIGHTS_CLUSTER_NAME: "cluster-1",
        TEAM_REGISTRY: makeTeamRegistryKV(),
      } as any, makeCtx());

      expect(response.status).toBe(200);
      const body = await response.json() as {
        runtime: {
          lambda: { mode: string; available: boolean };
          ecs_service: { mode: string };
          k8s_workspace: { mode: string; available: boolean; namespace: string };
          k8s_discovery: { mode: string; available: boolean; namespace: string; unavailableReason: string };
        };
      };

      expect(body.runtime.lambda.mode).toBe("lambda");
      expect(body.runtime.lambda.available).toBe(true);
      expect(body.runtime.ecs_service.mode).toBe("ecs_service");

      expect(body.runtime.k8s_workspace.mode).toBe("k8s_workspace");
      expect(body.runtime.k8s_workspace.available).toBe(true);
      expect(body.runtime.k8s_workspace.namespace).toBe(TEST_K8S_NAMESPACE);

      expect(body.runtime.k8s_discovery.mode).toBe("k8s_discovery");
      expect(body.runtime.k8s_discovery.available).toBe(false);
      expect(body.runtime.k8s_discovery.unavailableReason).toContain("Airtable is not configured");
      expect(body.runtime.k8s_discovery.namespace).toBe(TEST_K8S_NAMESPACE);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("hydrates missing local k8s runtime config from the worker secret bundle", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const target = request.headers.get("X-Amz-Target") || "";

      if (target === "secretsmanager.GetSecretValue") {
        return new Response(JSON.stringify({
          SecretString: JSON.stringify({
            KUBECONFIG_B64: TEST_MOCK_KUBECONFIG_B64,
            K8S_INGRESS_BASE_DOMAIN: TEST_MOCK_K8S_INGRESS_BASE_DOMAIN,
            POSTMAN_INSIGHTS_CLUSTER_NAME: "cluster-from-sm",
          }),
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    });

    try {
      const request = new Request("http://localhost:5173/api/config");
      const response = await worker.fetch(request, makeCfAccessEnv({
        LOCAL_DEV_AUTH_MODE: "bypass",
        AWS_ACCESS_KEY_ID: "akid",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_REGION: TEST_AWS_REGION,
      }), makeCtx());

      expect(response.status).toBe(200);
      const body = await response.json() as {
        runtime: {
          k8s_workspace: { unavailableReason: string };
          k8s_discovery: { unavailableReason: string };
        };
      };

      expect(body.runtime.k8s_workspace.unavailableReason).not.toContain("KUBECONFIG_B64");
      expect(body.runtime.k8s_workspace.unavailableReason).toContain("system environment");
      expect(body.runtime.k8s_discovery.unavailableReason).toContain("Airtable is not configured");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("bootstraps the local team registry when env teams exist but KV is empty", async () => {
    const registry = makeMutableTeamRegistryKV();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const target = request.headers.get("X-Amz-Target") || "";

      if (target === "secretsmanager.CreateSecret") {
        return new Response(JSON.stringify({ ARN: "arn:test" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (target === "secretsmanager.ListSecrets") {
        return new Response(JSON.stringify({
          SecretList: [
            { Name: "/postman/tenants/field-services-v12-demo/api-key" },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (target === "secretsmanager.BatchGetSecretValue") {
        return new Response(JSON.stringify({
          SecretValues: [
            { Name: "/postman/tenants/field-services-v12-demo/api-key", SecretString: "pmak-test" },
            { Name: "/postman/tenants/field-services-v12-demo/access-token", SecretString: "token-test" },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    });

    try {
      const request = new Request("http://localhost:5173/api/teams/registry");
      const response = await worker.fetch(request, makeCfAccessEnv({
        LOCAL_DEV_AUTH_MODE: "bypass",
        TEAM_REGISTRY: registry,
        TENANT_SECRETS_SYNC_ENABLED: "true",
        TENANT_SECRETS_AWS_ACCESS_KEY_ID: "tenant-akid",
        TENANT_SECRETS_AWS_SECRET_ACCESS_KEY: "tenant-secret",
        TENANT_SECRETS_AWS_REGION: TEST_AWS_REGION,
        POSTMAN_TEAM__FIELD_SERVICES_V12_DEMO__API_KEY: "pmak-test",
        POSTMAN_TEAM__FIELD_SERVICES_V12_DEMO__ACCESS_TOKEN: "token-test",
        POSTMAN_TEAM__FIELD_SERVICES_V12_DEMO__TEAM_ID: TEST_POSTMAN_TEAM_ID,
        POSTMAN_TEAM__FIELD_SERVICES_V12_DEMO__TEAM_NAME: "Field Services v12 Demo",
      }), makeCtx());

      expect(response.status).toBe(200);
      const body = await response.json() as { teams: Array<{ slug: string; team_id: string }> };
      expect(body.teams).toHaveLength(1);
      expect(body.teams[0]?.slug).toBe("field-services-v12-demo");
      expect(body.teams[0]?.team_id).toBe(TEST_POSTMAN_TEAM_ID);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("derives runtime metadata when cached team health is missing", async () => {
    const registry = makeMutableTeamRegistryKV();
    await registry.put("team-index", JSON.stringify(["field-services-v12-demo"]));
    await registry.put("team:field-services-v12-demo", JSON.stringify({
      slug: "field-services-v12-demo",
      team_id: TEST_POSTMAN_TEAM_ID,
      team_name: "Field Services v12 Demo",
      api_key: "pmak-test",
      access_token: "token-test",
      org_mode: false,
    }));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);

      if (url.toString() === "https://api.getpostman.com/me") {
        return new Response(JSON.stringify({
          user: {
            teamId: TEST_POSTMAN_TEAM_ID,
            teamName: "Field Services v12 Demo",
            teamDomain: "field-services-v12-demo",
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.toString() === "https://api.getpostman.com/teams") {
        return new Response(JSON.stringify({
          data: [
            { id: 13347347, name: "Field Services v12 Demo", handle: "field-services-v12-demo", memberCount: 25 },
            { id: 13347348, name: "Field Services Platform", handle: "field-services-platform", memberCount: 12 },
            { id: 13347349, name: "Field Services Support", handle: "field-services-support", memberCount: 9 },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.toString() === "https://iapub.postman.co/api/sessions/current") {
        return new Response(JSON.stringify({
          session: {
            status: "active",
            identity: { team: Number(TEST_POSTMAN_TEAM_ID), domain: "field-services-v12-demo" },
            data: { user: { teamName: "Field Services v12 Demo" } },
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    });

    try {
      const request = new Request("http://localhost:5173/api/teams/registry");
      const response = await worker.fetch(request, makeCfAccessEnv({
        LOCAL_DEV_AUTH_MODE: "bypass",
        TEAM_REGISTRY: registry,
      }), makeCtx());

      expect(response.status).toBe(200);
      const body = await response.json() as {
        teams: Array<{
          slug: string;
          workspace_team_count?: number;
          detected_org_mode?: boolean;
          workspace_teams?: Array<{ handle: string }>;
        }>;
      };

      const targetTeam = body.teams.find((team) => team.slug === "field-services-v12-demo");
      expect(targetTeam?.workspace_team_count).toBe(3);
      expect(targetTeam?.detected_org_mode).toBe(true);
      expect(targetTeam?.workspace_teams?.map((team) => team.handle)).toEqual([
        "field-services-v12-demo",
        "field-services-platform",
        "field-services-support",
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("omits x-entity-team-id when validating a non-org access token during team updates", async () => {
    const registry = makeMutableTeamRegistryKV();
    await registry.put("team-index", JSON.stringify(["field-services-v12-demo"]));
    await registry.put("team:field-services-v12-demo", JSON.stringify({
      slug: "field-services-v12-demo",
      team_id: TEST_POSTMAN_TEAM_ID,
      team_name: "Field Services v12 Demo",
      api_key: "pmak-existing",
      access_token: "token-existing",
      org_mode: false,
    }));

    const bifrostHeaders: Array<Record<string, string>> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (url.toString() === "https://iapub.postman.co/api/sessions/current") {
        return new Response(JSON.stringify({
          session: {
            status: "active",
            identity: { team: Number(TEST_POSTMAN_TEAM_ID), domain: "field-services-v12-demo" },
            data: { user: { teamName: "Field Services v12 Demo" } },
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.toString() === "https://bifrost-premium-https-v4.gw.postman.com/ws/proxy") {
        const capturedHeaders: Record<string, string> = {};
        request.headers.forEach((value, key) => {
          capturedHeaders[key] = value;
        });
        bifrostHeaders.push(capturedHeaders);
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    });

    try {
      const request = new Request("http://localhost:5173/api/teams/registry/field-services-v12-demo", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: "token-new" }),
      });
      const response = await worker.fetch(request, makeCfAccessEnv({
        LOCAL_DEV_AUTH_MODE: "bypass",
        TEAM_REGISTRY: registry,
      }), makeCtx());

      expect(response.status).not.toBe(422);
      expect(bifrostHeaders).toHaveLength(1);
      expect(bifrostHeaders[0]?.["x-access-token"]).toBe("token-new");
      expect(bifrostHeaders[0]?.["x-entity-team-id"]).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("includes x-entity-team-id when org-mode recheck falls back from iapub to Bifrost", async () => {
    const registry = makeMutableTeamRegistryKV();
    await registry.put("team-index", JSON.stringify(["field-services-v12-demo"]));
    await registry.put("team:field-services-v12-demo", JSON.stringify({
      slug: "field-services-v12-demo",
      team_id: TEST_POSTMAN_TEAM_ID,
      team_name: "Field Services v12 Demo",
      api_key: "pmak-existing",
      access_token: "token-existing",
      org_mode: true,
    }));
    await registry.put(`team-health:field-services-v12-demo`, JSON.stringify({
      status: "healthy",
      blocked: false,
      runtime_metadata: {
        identity: { team_id: TEST_POSTMAN_TEAM_ID, team_name: "Field Services v12 Demo", slug: "field-services-v12-demo" },
        workspace_teams: [
          { id: Number(TEST_POSTMAN_TEAM_ID), name: "Field Services v12 Demo", handle: "field-services-v12-demo", memberCount: 14 },
          { id: 2, name: "Other", handle: "other", memberCount: 3 },
        ],
        workspace_team_count: 2,
        detected_org_mode: true,
        resolved_at: "2026-03-16T00:00:00.000Z",
      },
    }));

    const bifrostHeaders: Array<Record<string, string>> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (url.toString() === "https://api.getpostman.com/me") {
        return new Response(JSON.stringify({
          user: { teamId: TEST_POSTMAN_TEAM_ID, teamName: "Field Services v12 Demo", teamDomain: "field-services-v12-demo" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.toString() === "https://iapub.postman.co/api/sessions/current") {
        throw new TypeError("fetch failed");
      }

      if (url.toString() === "https://bifrost-premium-https-v4.gw.postman.com/ws/proxy") {
        const capturedHeaders: Record<string, string> = {};
        request.headers.forEach((value, key) => {
          capturedHeaders[key] = value;
        });
        bifrostHeaders.push(capturedHeaders);
        return new Response(JSON.stringify({ data: [{ teamId: Number(TEST_POSTMAN_TEAM_ID) }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    });

    try {
      const request = new Request("http://localhost:5173/api/teams/registry/field-services-v12-demo/health/recheck", {
        method: "POST",
      });
      const response = await worker.fetch(request, makeCfAccessEnv({
        LOCAL_DEV_AUTH_MODE: "bypass",
        TEAM_REGISTRY: registry,
      }), makeCtx());

      expect(response.status).toBe(200);
      expect(bifrostHeaders.length).toBeGreaterThan(0);
      expect(bifrostHeaders.some((headers) => headers["x-entity-team-id"] === TEST_POSTMAN_TEAM_ID)).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("includes x-entity-team-id when PATCH discovery uses cached org-mode over stale stored false", async () => {
    const registry = makeMutableTeamRegistryKV();
    await registry.put("team-index", JSON.stringify(["field-services-v12-demo"]));
    await registry.put("team:field-services-v12-demo", JSON.stringify({
      slug: "field-services-v12-demo",
      team_id: TEST_POSTMAN_TEAM_ID,
      team_name: "Field Services v12 Demo",
      api_key: "pmak-existing",
      access_token: "token-existing",
      org_mode: false,
    }));
    await registry.put(`team-health:field-services-v12-demo`, JSON.stringify({
      status: "healthy",
      blocked: false,
      runtime_metadata: {
        identity: { team_id: TEST_POSTMAN_TEAM_ID, team_name: "Field Services v12 Demo", slug: "field-services-v12-demo" },
        workspace_teams: [
          { id: Number(TEST_POSTMAN_TEAM_ID), name: "Field Services v12 Demo", handle: "field-services-v12-demo", memberCount: 14 },
          { id: 2, name: "Other", handle: "other", memberCount: 3 },
        ],
        workspace_team_count: 2,
        detected_org_mode: true,
        resolved_at: "2026-03-16T00:00:00.000Z",
      },
    }));

    const bifrostHeaders: Array<Record<string, string>> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (url.toString() === "https://iapub.postman.co/api/sessions/current") {
        throw new TypeError("fetch failed");
      }

      if (url.toString() === "https://bifrost-premium-https-v4.gw.postman.com/ws/proxy") {
        const capturedHeaders: Record<string, string> = {};
        request.headers.forEach((value, key) => {
          capturedHeaders[key] = value;
        });
        bifrostHeaders.push(capturedHeaders);
        return new Response(JSON.stringify({ data: [{ teamId: Number(TEST_POSTMAN_TEAM_ID) }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    });

    try {
      const request = new Request("http://localhost:5173/api/teams/registry/field-services-v12-demo", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: "token-new" }),
      });
      const response = await worker.fetch(request, makeCfAccessEnv({
        LOCAL_DEV_AUTH_MODE: "bypass",
        TEAM_REGISTRY: registry,
      }), makeCtx());

      expect(response.status).not.toBe(422);
      expect(bifrostHeaders.length).toBeGreaterThan(0);
      expect(bifrostHeaders.some((headers) => headers["x-entity-team-id"] === TEST_POSTMAN_TEAM_ID)).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns graph preflight plan from POST /api/provision/plan for supported runtimes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      const url = new URL(req.url);
      if (url.hostname === "api.airtable.com" && url.pathname.endsWith("/Deployments")) {
        return new Response(JSON.stringify({
          records: [
            {
              id: "rec_dep",
              fields: {
                spec_id: "vzw-incident-intake-gateway-api",
                status: "active",
                runtime_mode: "k8s_workspace",
                environment_deployments: JSON.stringify([
                  { environment: "prod", runtime_url: "https://vzw-incident-intake-gateway-api.prod.internal", status: "active" },
                ]),
              },
            },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    try {
      const request = new Request(`${TEST_WORKER_URL}/api/provision/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spec_source: "vzw-geospatial-hazard-intel-api",
          runtime: "k8s_workspace",
          environments: ["prod"],
          deployment_mode: "graph",
        }),
      });

      const response = await worker.fetch(request, makeAirtableEnv(), makeCtx());
      expect(response.status).toBe(200);
      const body = await response.json() as {
        plan: {
          deployment_mode: string;
          root_spec_id: string;
          hard_closure_spec_ids: string[];
          soft_neighbor_spec_ids: string[];
          summary: { reuse_count: number; attach_count: number; provision_count: number; blocked_count: number };
        };
      };
      expect(body.plan.deployment_mode).toBe("graph");
      expect(body.plan.root_spec_id).toBe("vzw-geospatial-hazard-intel-api");
      expect(body.plan.hard_closure_spec_ids).toEqual(["vzw-incident-intake-gateway-api", "vzw-geospatial-hazard-intel-api"]);
      expect(body.plan.soft_neighbor_spec_ids).toEqual(["vzw-api-consumer-analytics-api", "vzw-identity-federation-api"]);
      expect(body.plan.summary.reuse_count).toBe(1);
      expect(body.plan.summary.attach_count).toBe(0);
      expect(body.plan.summary.provision_count).toBe(1);
      expect(body.plan.summary.blocked_count).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("reconciles successful provisioning drift before building a graph plan", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);

      if (url.hostname === "api.airtable.com" && url.pathname.endsWith("/Deployments")) {
        return new Response(JSON.stringify({
          records: [
            {
              id: "rec_drifted",
              fields: {
                spec_id: "vzw-incident-intake-gateway-api",
                status: "provisioning",
                runtime_mode: "k8s_workspace",
                github_repo_name: "vzw-incident-intake-gateway-api",
                environments_json: JSON.stringify(["stage"]),
                failed_at_step: "provisioning",
                error_message: "Failed to create repo: Repository creation failed.",
              },
            },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.hostname === "api.airtable.com" && url.pathname.includes("/Deployments/rec_drifted") && req.method === "PATCH") {
        const body = await req.json() as { fields: Record<string, unknown> };
        expect(body.fields.status).toBe("active");
        expect(body.fields.environments_json).toBe(JSON.stringify(["prod", "stage"]));
        return new Response(JSON.stringify({ id: "rec_drifted", fields: body.fields }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.hostname === "api.github.com"
        && url.pathname.toLowerCase() === `/repos/${TEST_GITHUB_ORG.toLowerCase()}/vzw-incident-intake-gateway-api/actions/runs`
        && url.searchParams.get("per_page") === "10") {
        return new Response(JSON.stringify({
          workflow_runs: [
            {
              id: 22815860705,
              name: "Provision API Lifecycle",
              path: ".github/workflows/provision.yml",
              status: "completed",
              conclusion: "success",
              html_url: `https://github.com/${TEST_GITHUB_ORG}/vzw-incident-intake-gateway-api/actions/runs/22815860705`,
              updated_at: "2026-03-08T06:48:06Z",
              event: "workflow_dispatch",
              head_branch: "main",
              created_at: "2026-03-08T06:45:52Z",
            },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.hostname === "api.github.com"
        && url.pathname.toLowerCase() === `/repos/${TEST_GITHUB_ORG.toLowerCase()}/vzw-incident-intake-gateway-api/actions/variables`) {
        return new Response(JSON.stringify({
          variables: [
            { name: "RUNTIME_MODE", value: "k8s_workspace" },
            { name: "RUNTIME_BASE_URL", value: "https://runtime.example/svc/vzw-incident-intake-gateway-api/" },
            {
              name: "ENVIRONMENT_DEPLOYMENTS_JSON",
              value: JSON.stringify([
                {
                  environment: "prod",
                  runtime_url: "https://runtime.example/svc/vzw-incident-intake-gateway-api",
                  status: "active",
                },
              ]),
            },
            { name: "POSTMAN_WORKSPACE_ID", value: "ws-123" },
            { name: "POSTMAN_SPEC_UID", value: "spec-123" },
            { name: "POSTMAN_BASELINE_COLLECTION_UID", value: "baseline-123" },
            { name: "POSTMAN_SMOKE_COLLECTION_UID", value: "smoke-123" },
            { name: "POSTMAN_CONTRACT_COLLECTION_UID", value: "contract-123" },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    });

    try {
      const request = new Request(`${TEST_WORKER_URL}/api/provision/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spec_source: "vzw-geospatial-hazard-intel-api",
          runtime: "k8s_workspace",
          environments: ["prod"],
          deployment_mode: "graph",
        }),
      });

      const response = await worker.fetch(request, {
        ...makeAirtableEnv(),
        GH_TOKEN: "gh-test-token",
      } as any, makeCtx());

      expect(response.status).toBe(200);
      const body = await response.json() as {
        plan: { summary: { reuse_count: number; attach_count: number; blocked_count: number } };
      };
      expect(body.plan.summary.reuse_count).toBe(1);
      expect(body.plan.summary.attach_count).toBe(0);
      expect(body.plan.summary.blocked_count).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects graph preflight plan for unsupported runtimes", async () => {
    const request = new Request(`${TEST_WORKER_URL}/api/provision/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        spec_source: "vzw-geospatial-hazard-intel-api",
        runtime: "lambda",
        environments: ["prod"],
        deployment_mode: "graph",
      }),
    });

    const response = await worker.fetch(request, makeEnv(), makeCtx());
    expect(response.status).toBe(400);
    const body = await response.json() as { error?: string; code?: string };
    expect(body.code).toBe("graph_mode_runtime_not_supported");
    expect(body.error || "").toContain("Graph deployment mode is not supported");
  });

  it("falls back to root HTML when ASSETS binding is unavailable", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      const url = new URL(req.url);
      if (url.pathname === "/") {
        return new Response(
          "<!doctype html><html><body><div id=\"root\"></div></body></html>",
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      return new Response("Not found", { status: 404 });
    });

    try {
      const request = new Request(`${TEST_WORKER_URL}/provision`, {
        headers: { Accept: "text/html" },
      });
      const response = await worker.fetch(request, {
        PORTAL_CONFIG: {
          get: async () => null,
        } as unknown as KVNamespace,
      } as any, makeCtx());

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/html");
      const body = await response.text();
      expect(body).toContain("<div id=\"root\"></div>");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns worker info JSON when root fetch fails without ASSETS binding", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));

    try {
      const request = new Request(`${TEST_WORKER_URL}/provision`, {
        headers: { Accept: "text/html" },
      });
      const response = await worker.fetch(request, {
        PORTAL_CONFIG: {
          get: async () => null,
        } as unknown as KVNamespace,
      } as any, makeCtx());

      expect(response.status).toBe(503);
      expect(response.headers.get("Content-Type")).toContain("application/json");
      const body = await response.json() as { worker?: string };
      expect(body.worker).toBe("vzw-partner-demo");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns worker info JSON when ASSETS direct fetch throws", async () => {
    const request = new Request(`${TEST_WORKER_URL}/provision`, {
      headers: { Accept: "text/html" },
    });

    const response = await worker.fetch(request, {
      ASSETS: {
        fetch: async () => {
          throw new Error("fetch failed");
        },
      },
      PORTAL_CONFIG: {
        get: async () => null,
      } as unknown as KVNamespace,
    } as any, makeCtx());

    expect(response.status).toBe(503);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = await response.json() as { worker?: string };
    expect(body.worker).toBe("vzw-partner-demo");
  });

  it("returns worker info JSON when ASSETS SPA fallback fetch throws", async () => {
    const request = new Request(`${TEST_WORKER_URL}/provision`, {
      headers: { Accept: "text/html" },
    });

    const response = await worker.fetch(request, {
      ASSETS: {
        fetch: async (assetRequest: Request) => {
          const path = new URL(assetRequest.url).pathname;
          if (path === "/") {
            throw new Error("fetch failed");
          }
          return new Response("Not found", { status: 404 });
        },
      },
      PORTAL_CONFIG: {
        get: async () => null,
      } as unknown as KVNamespace,
    } as any, makeCtx());

    expect(response.status).toBe(503);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = await response.json() as { worker?: string };
    expect(body.worker).toBe("vzw-partner-demo");
  });

  it("returns all non-failed inventories from GET /api/resources", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      const url = new URL(req.url);
      if (url.hostname === "api.airtable.com" && url.pathname.endsWith("/Deployments")) {
        return new Response(JSON.stringify({
          records: [
            {
              id: "rec_active",
              fields: {
                spec_id: "vzw-incident-intake-gateway-api",
                status: "active",
                aws_region: TEST_AWS_REGION,
                aws_invoke_url: "https://abc123.execute-api.eu-west-2.amazonaws.com/",
                lambda_function_name: "vzw-incident-intake-gateway-api-dev",
              },
            },
            {
              id: "rec_failed",
              fields: {
                spec_id: "af-cards-rewards",
                status: "failed",
              },
            },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    try {
      const request = new Request(`${TEST_WORKER_URL}/api/resources`);
      const response = await worker.fetch(request, makeAirtableEnv(), makeCtx());

      expect(response.status).toBe(200);
      const body = await response.json() as { total: number; resources: Array<{ service: string; source: string }> };
      expect(body.total).toBe(1);
      expect(body.resources).toHaveLength(1);
      expect(body.resources[0].service).toBe("vzw-incident-intake-gateway-api");
      expect(body.resources[0].source).toBe("derived");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns recoverable failures alongside deployments from GET /api/deployments", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      const url = new URL(req.url);
      if (url.hostname === "api.airtable.com" && url.pathname.endsWith("/Deployments")) {
        return new Response(JSON.stringify({
          records: [
            {
              id: "rec_active",
              fields: {
                spec_id: "vzw-network-operations-api",
                status: "active",
                postman_team_slug: "field-services-v12-demo",
              },
            },
            {
              id: "rec_conflict",
              fields: {
                spec_id: "vzw-incident-intake-gateway-api",
                status: "failed",
                github_repo_name: "vzw-incident-intake-gateway-api",
                postman_team_slug: "field-services-v12-demo",
                error_message: `GitHub repo ${TEST_GITHUB_ORG}/vzw-incident-intake-gateway-api already exists. Deprovision it first.`,
                deployed_at: "2026-03-02T05:20:00.000Z",
              },
            },
            {
              id: "rec_tombstone",
              fields: {
                spec_id: "af-risk-rules",
                status: "failed",
                github_repo_name: "af-risk-rules",
                error_message: "Deprovisioned",
                deployed_at: "2026-03-02T04:20:00.000Z",
              },
            },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    try {
      const request = new Request(`${TEST_WORKER_URL}/api/deployments`);
      const response = await worker.fetch(request, makeAirtableEnv(), makeCtx());

      expect(response.status).toBe(200);
      const body = await response.json() as {
        deployments: Array<{ spec_id: string; postman_team_slug?: string }>;
        recoverable_failures: Array<{
          spec_id: string;
          reason: string;
          project_name: string;
          error_message: string;
          postman_team_slug?: string;
        }>;
      };

      expect(body.deployments).toHaveLength(3);
      expect(body.deployments[0].postman_team_slug).toBe("field-services-v12-demo");
      expect(body.recoverable_failures).toHaveLength(1);
      expect(body.recoverable_failures[0].spec_id).toBe("vzw-incident-intake-gateway-api");
      expect(body.recoverable_failures[0].reason).toBe("github_repo_conflict");
      expect(body.recoverable_failures[0].project_name).toBe("vzw-incident-intake-gateway-api");
      expect(body.recoverable_failures[0].error_message).toContain("already exists");
      expect(body.recoverable_failures[0].postman_team_slug).toBe("field-services-v12-demo");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("requires bearer token for GET /api/backstage/catalog.yaml", async () => {
    const request = new Request(`${TEST_WORKER_URL}/api/backstage/catalog.yaml`);
    const response = await worker.fetch(request, {
      ...makeAirtableEnv(),
      CATALOG_BACKSTAGE_FEED_TOKEN: "feed-token",
    } as any, makeCtx());

    expect(response.status).toBe(401);
    const body = await response.json() as { error?: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("returns Backstage YAML feed for authorized requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      const url = new URL(req.url);

      if (url.hostname === "api.airtable.com" && url.pathname.endsWith("/Deployments")) {
        return new Response(JSON.stringify({
          records: [
            {
              id: "rec_active",
              fields: {
                spec_id: "vzw-network-operations-api",
                status: "active",
                runtime_mode: "lambda",
                aws_region: TEST_AWS_REGION,
                github_repo_url: `https://github.com/${TEST_GITHUB_ORG}/vzw-network-operations-api`,
                postman_workspace_url: "https://go.postman.co/workspace/ws-123",
                workspace_id: "ws-123",
                postman_spec_uid: "spec-123",
                aws_invoke_url: "https://abc123.execute-api.eu-west-2.amazonaws.com",
              },
            },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.hostname === "api.getpostman.com" && url.pathname.endsWith("/specs/spec-123")) {
        return new Response(JSON.stringify({
          spec: {
            files: [
              {
                path: "index.yaml",
                content: "openapi: 3.0.3\ninfo:\n  title: Demo\n  version: 1.0.0\npaths: {}\n",
              },
            ],
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    });

    try {
      const request = new Request(`${TEST_WORKER_URL}/api/backstage/catalog.yaml`, {
        headers: {
          Authorization: "Bearer feed-token",
        },
      });
      const response = await worker.fetch(request, {
        ...makeAirtableEnv(),
        CATALOG_BACKSTAGE_FEED_TOKEN: "feed-token",
      } as any, makeCtx());

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/yaml");
      const text = await response.text();
      expect(text).toContain("kind: Component");
      expect(text).toContain("kind: API");
      expect(text).toContain("catalog-admin.postman.com/postman-action-label: Open in Postman");
      expect(text).toContain("spec:\n  type: openapi");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns a single inventory payload from GET /api/resources/:service", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      const url = new URL(req.url);
      if (url.hostname === "api.airtable.com" && url.pathname.endsWith("/Deployments")) {
        return new Response(JSON.stringify({
          records: [
            {
              id: "rec_one",
              fields: {
                spec_id: "vzw-network-operations-api",
                status: "active",
                runtime_mode: "ecs_service",
                resource_inventory_json: JSON.stringify({
                  runtime_mode: "ecs_service",
                  generated_at: "2026-02-27T18:00:00Z",
                  resources: [
                    {
                      provider: "aws",
                      kind: "runtime_route",
                      name: "Shared runtime route",
                      url: `${TEST_WORKER_URL}/services/vzw-network-operations-api`,
                    },
                  ],
                }),
              },
            },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    try {
      const request = new Request(`${TEST_WORKER_URL}/api/resources/vzw-network-operations-api`);
      const response = await worker.fetch(request, makeAirtableEnv(), makeCtx());

      expect(response.status).toBe(200);
      const body = await response.json() as { resource: { service: string; source: string; resources: Array<{ kind: string }> } };
      expect(body.resource.service).toBe("vzw-network-operations-api");
      expect(body.resource.source).toBe("airtable");
      expect(body.resource.resources[0].kind).toBe("runtime_route");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rebuilds service inventory when persisted Airtable data is missing environment-scoped metadata", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      const url = new URL(req.url);
      if (url.hostname === "api.airtable.com" && url.pathname.endsWith("/Deployments")) {
        return new Response(JSON.stringify({
          records: [
            {
              id: "rec_one",
              fields: {
                spec_id: "vzw-network-operations-api",
                status: "active",
                runtime_mode: "ecs_service",
                aws_region: TEST_AWS_REGION,
                ecs_cluster_name: "demo-ecs-cluster",
                ecs_service_name: "vzw-network-operations-api-svc-prod",
                ecs_task_definition: "vzw-network-operations-api-task-prod",
                environment_deployments: JSON.stringify([
                  { environment: "prod", runtime_url: "https://runtime.example/svc/vzw-network-operations-api-prod", status: "active" },
                  { environment: "stage", runtime_url: "https://runtime.example/svc/vzw-network-operations-api-stage", status: "active" },
                ]),
                resource_inventory_json: JSON.stringify({
                  runtime_mode: "ecs_service",
                  generated_at: "2026-02-27T18:00:00Z",
                  resources: [
                    {
                      provider: "aws",
                      kind: "runtime_route",
                      name: "Shared runtime route",
                      url: "https://runtime.example/svc/vzw-network-operations-api-prod",
                    },
                  ],
                }),
              },
            },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    try {
      const request = new Request(`${TEST_WORKER_URL}/api/resources/vzw-network-operations-api`);
      const response = await worker.fetch(request, makeAirtableEnv(), makeCtx());

      expect(response.status).toBe(200);
      const body = await response.json() as {
        resource: {
          source: string;
          resources: Array<{ kind: string; name: string; metadata?: Record<string, string> }>;
        };
      };
      expect(body.resource.source).toBe("derived");
      expect(body.resource.resources.filter((resource) => resource.kind === "ecs_service").map((resource) => resource.name))
        .toEqual(["vzw-network-operations-api-svc-prod", "vzw-network-operations-api-svc-stage"]);
      expect(body.resource.resources.filter((resource) => resource.kind === "ecs_service").map((resource) => resource.metadata?.environment))
        .toEqual(["prod", "stage"]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns shared infra inventory from GET /api/infra/resources", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      const url = new URL(req.url);
      if (url.hostname === "api.airtable.com" && url.pathname.endsWith("/Infrastructure")) {
        return new Response(JSON.stringify({
          records: [
            {
              id: "rec_infra",
              fields: {
                component: "ecs_shared",
                status: "active",
                cluster_name: "vzw-partner-demo-cluster",
                vpc_id: "vpc-1234abcd",
                subnet_ids: "subnet-a,subnet-b",
                security_group_ids: "sg-base",
                execution_role_arn: "arn:aws:iam::123456789012:role/vzw-partner-demo-ecs-execution-role",
                task_role_arn: "arn:aws:iam::123456789012:role/vzw-partner-demo-ecs-task-role",
                alb_arn: "arn:aws:elasticloadbalancing:eu-west-2:123456789012:loadbalancer/app/vzw-partner-demo-alb/abc",
                alb_listener_arn: "arn:aws:elasticloadbalancing:eu-west-2:123456789012:listener/app/vzw-partner-demo-alb/abc/def",
                alb_dns_name: "vzw-partner-demo-alb-123.eu-west-2.elb.amazonaws.com",
                ecr_repository: TEST_ECR_REPOSITORY,
                alb_sg_id: "sg-alb",
                ecs_sg_id: "sg-ecs",
                aws_region: TEST_AWS_REGION,
              },
            },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    try {
      const request = new Request(`${TEST_WORKER_URL}/api/infra/resources`);
      const response = await worker.fetch(request, makeAirtableEnv(), makeCtx());

      expect(response.status).toBe(200);
      const body = await response.json() as {
        resource: { service: string; resources: Array<{ kind: string; arn?: string }> };
      };
      expect(body.resource.service).toBe("ecs_shared");
      expect(body.resource.resources.some((resource) => resource.kind === "load_balancer")).toBe(true);
      expect(body.resource.resources.some((resource) => (resource.arn || "").includes(":listener/"))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("routes POST /api/infra/setup and returns no-op SSE when infra is already active", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      const url = new URL(req.url);
      if (url.hostname === "api.airtable.com" && url.pathname.endsWith("/Infrastructure")) {
        return new Response(JSON.stringify({
          records: [{ id: "rec_infra", fields: { component: "ecs_shared", status: "active" } }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    try {
      const request = new Request(`${TEST_WORKER_URL}/api/infra/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const response = await worker.fetch(request, {
        ...makeAirtableEnv(),
        GH_TOKEN: "gh-token",
      } as any, makeCtx());

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");
      const text = await response.text();
      expect(text).toContain("\"phase\":\"infra_setup\"");
      expect(text).toContain("\"no_op\":true");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("index worker CF Access auth", () => {
  it("returns 401 for protected API routes without CF Access JWT", async () => {
    const request = new Request(`${TEST_WORKER_URL}/api/config`);
    const response = await worker.fetch(request, makeCfAccessEnv(), makeCtx());

    expect(response.status).toBe(401);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("allows protected API routes from localhost when local auth bypass mode is enabled", async () => {
    const request = new Request("http://localhost:5173/api/config");
    const response = await worker.fetch(request, makeCfAccessEnv({ LOCAL_DEV_AUTH_MODE: "bypass" }), makeCtx());

    expect(response.status).toBe(200);
    const body = await response.json() as { runtime: Record<string, unknown> };
    expect(body.runtime).toBeTruthy();
  });

  it("keeps localhost requests protected in strict mode", async () => {
    const request = new Request("http://localhost:5173/api/config");
    const response = await worker.fetch(request, makeCfAccessEnv({ LOCAL_DEV_AUTH_MODE: "strict" }), makeCtx());

    expect(response.status).toBe(401);
  });

  it("does not bypass auth for non-local hosts even in bypass mode", async () => {
    const request = new Request(`${TEST_WORKER_URL}/api/config`);
    const response = await worker.fetch(request, makeCfAccessEnv({ LOCAL_DEV_AUTH_MODE: "bypass" }), makeCtx());

    expect(response.status).toBe(401);
  });

  it("allows unauthenticated health checks when auth is enabled", async () => {
    const request = new Request(`${TEST_WORKER_URL}/api/health`);
    const response = await worker.fetch(request, makeCfAccessEnv(), makeCtx());

    expect(response.status).toBe(200);
    const body = await response.json() as { worker: string };
    expect(body.worker).toBe("vzw-internal-catalog");
  });

  it("redirects /auth/logout to CF Access logout endpoint", async () => {
    const request = new Request(`${TEST_WORKER_URL}/auth/logout`);
    const response = await worker.fetch(request, makeCfAccessEnv(), makeCtx());

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://testteam.cloudflareaccess.com/cdn-cgi/access/logout"
    );
  });

  it("returns 403 for unauthenticated non-API routes (defense-in-depth)", async () => {
    const request = new Request(`${TEST_WORKER_URL}/provision`);
    const response = await worker.fetch(request, makeCfAccessEnv(), makeCtx());

    expect(response.status).toBe(403);
  });

  it("allows service-token access to Backstage feed when auth is enabled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      const url = new URL(req.url);

      if (url.hostname === "api.airtable.com" && url.pathname.endsWith("/Deployments")) {
        return new Response(JSON.stringify({ records: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    try {
      const request = new Request(`${TEST_WORKER_URL}/api/backstage/catalog.yaml?scope=active`, {
        headers: { Authorization: "Bearer feed-token" },
      });
      const response = await worker.fetch(request, makeCfAccessEnv({
        AIRTABLE_API_KEY: "pat-test",
        AIRTABLE_BASE_ID: "app-test",
        POSTMAN_API_KEY: "pmak-test",
        CATALOG_BACKSTAGE_FEED_TOKEN: "feed-token",
      }), makeCtx());

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("[]");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("requires access_token for team-registry writes", async () => {
    const request = new Request(`${TEST_WORKER_URL}/api/teams/registry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "field-services-v12-demo",
        team_id: TEST_POSTMAN_TEAM_ID,
        team_name: "Field Services v12 Demo",
        api_key: "pmak-test",
      }),
    });

    const response = await worker.fetch(request, {
      ...makeAirtableEnv(),
      TEAM_REGISTRY: {
        get: async () => null,
        put: async () => undefined,
        delete: async () => undefined,
      } as unknown as KVNamespace,
    } as any, makeCtx());

    expect(response.status).toBe(400);
    const body = await response.json() as { error?: string };
    expect(body.error).toContain("access_token is required");
  });
});
