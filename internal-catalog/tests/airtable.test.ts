import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeployment,
  listDeployments,
  supportsGraphMembershipsTable,
  updateDeployment,
  upsertGraphMembership,
  _clearDeploymentsCacheForTests,
} from "../src/lib/airtable";

function makeEnv(baseId: string) {
  return {
    AIRTABLE_API_KEY: "pat-test",
    AIRTABLE_BASE_ID: baseId,
  };
}

function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

describe("airtable rate limit resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _clearDeploymentsCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retries on 429 using Retry-After header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(429, { error: { type: "RATE_LIMITED" } }, { "Retry-After": "1" }))
      .mockResolvedValueOnce(jsonResponse(200, { records: [] }));

    const resultPromise = listDeployments(makeEnv("app-rate-limit-retry-after") as any);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const records = await resultPromise;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(records).toEqual([]);
  });

  it("falls back to exponential backoff when Retry-After is absent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(429, { error: { type: "RATE_LIMITED" } }))
      .mockResolvedValueOnce(jsonResponse(200, { records: [] }));

    const resultPromise = listDeployments(makeEnv("app-rate-limit-fallback") as any);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const records = await resultPromise;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(records).toEqual([]);
  });

  it("spaces concurrent requests for the same base", async () => {
    const callTimes: number[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      callTimes.push(Date.now());
      return jsonResponse(200, { records: [] });
    });

    const env = makeEnv("app-rate-limit-spacing");
    const firstPromise = listDeployments(env as any);
    const secondPromise = listDeployments(env as any);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(callTimes).toHaveLength(2);
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(200);
  });

  it("returns a 429 error after max retries are exhausted", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return jsonResponse(429, { error: { type: "RATE_LIMITED" } });
    });

    const resultPromise = listDeployments(makeEnv("app-rate-limit-exhausted") as any);
    const expectation = expect(resultPromise).rejects.toThrow("Airtable list failed: 429");

    await vi.runAllTimersAsync();
    await expectation;
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });
});

describe("airtable unknown field stripping", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _clearDeploymentsCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function unknownFieldResponse(fieldName: string) {
    return new Response(JSON.stringify({
      error: {
        type: "UNKNOWN_FIELD_NAME",
        message: `Unknown field name: "${fieldName}"`,
      },
    }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("updateDeployment strips five unknown fields and still retries the cleaned payload", async () => {
    const unknownFields = [
      "deployment_mode",
      "deployment_group_id",
      "deployment_root_spec_id",
      "graph_node_meta_json",
      "system_env_map",
    ];
    const patchPayloads: Array<Record<string, unknown>> = [];
    let patchAttempt = 0;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body || "{}")) as { fields?: Record<string, unknown> };
        patchPayloads.push({ ...(body.fields || {}) });
        if (patchAttempt < unknownFields.length) {
          return unknownFieldResponse(unknownFields[patchAttempt++]);
        }
        return jsonResponse(200, { id: "rec-demo", fields: body.fields || {} });
      }
      return new Response("Unexpected request", { status: 500 });
    });

    const updatePromise = updateDeployment(makeEnv("app-unknown-update") as any, "rec-demo", {
      deployment_mode: "graph",
      deployment_group_id: "group-123",
      deployment_root_spec_id: "af-root",
      graph_node_meta_json: '{"layer_index":0}',
      system_env_map: '{"prod":"env_prod"}',
      status: "active",
    });

    await vi.runAllTimersAsync();
    await expect(updatePromise).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(6);
    expect(patchPayloads.at(-1)).toEqual({ status: "active" });
  });

  it("createDeployment strips five unknown fields and still retries the cleaned payload", async () => {
    const unknownFields = [
      "deployment_mode",
      "deployment_group_id",
      "deployment_root_spec_id",
      "graph_node_meta_json",
      "system_env_map",
    ];
    const createPayloads: Array<Record<string, unknown>> = [];
    let createAttempt = 0;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      if (req.method === "GET") {
        return jsonResponse(200, { records: [] });
      }
      if (req.method === "POST") {
        const body = JSON.parse(await req.text()) as { fields?: Record<string, unknown> };
        createPayloads.push({ ...(body.fields || {}) });
        if (createAttempt < unknownFields.length) {
          return unknownFieldResponse(unknownFields[createAttempt++]);
        }
        return jsonResponse(200, { id: "rec-demo", fields: body.fields || {} });
      }
      return new Response("Unexpected request", { status: 500 });
    });

    const createPromise = createDeployment(makeEnv("app-unknown-create") as any, {
      spec_id: "af-demo",
      status: "provisioning",
      deployment_mode: "graph",
      deployment_group_id: "group-123",
      deployment_root_spec_id: "af-root",
      graph_node_meta_json: '{"layer_index":0}',
      system_env_map: '{"prod":"env_prod"}',
      github_repo_name: "af-demo",
    });

    await vi.runAllTimersAsync();
    await expect(createPromise).resolves.toMatchObject({ id: "rec-demo", spec_id: "af-demo" });

    expect(fetchSpy).toHaveBeenCalledTimes(7);
    expect(createPayloads.at(-1)).toEqual({
      spec_id: "af-demo",
      status: "provisioning",
      github_repo_name: "af-demo",
    });
  });
});

describe("graph memberships table support", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats a missing GraphMemberships table as optional", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        error: {
          type: "MODEL_NOT_FOUND",
          message: "Could not find table GraphMemberships",
        },
      }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      supportsGraphMembershipsTable(makeEnv("app-missing-graph-memberships") as any),
    ).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("upserts graph memberships by deployment group + spec + environment", async () => {
    const requests: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const url = req.url;
      const body = req.method === "GET"
        ? {}
        : (JSON.parse(await req.text()) as Record<string, unknown>);
      requests.push({ method: req.method, url, body });

      if (req.method === "GET" && url.includes("/GraphMemberships?maxRecords=1")) {
        return jsonResponse(200, { records: [] });
      }
      if (req.method === "GET" && url.includes("/GraphMemberships?filterByFormula=")) {
        const hasExisting = requests.some((entry) => entry.method === "POST" && entry.url.includes("/GraphMemberships"));
        return jsonResponse(200, {
          records: hasExisting
            ? [{
              id: "rec-membership",
              fields: {
                deployment_group_id: "grp-1",
                deployment_root_spec_id: "root",
                spec_id: "svc-a",
                environment: "prod",
                layer_index: 0,
                node_status: "reused",
                node_action: "reused",
                runtime_mode: "k8s_workspace",
              },
            }]
            : [],
        });
      }
      if (req.method === "POST" && url.endsWith("/GraphMemberships")) {
        return jsonResponse(200, {
          id: "rec-membership",
          fields: (body.fields as Record<string, unknown>) || {},
        });
      }
      if (req.method === "PATCH" && url.includes("/GraphMemberships/rec-membership")) {
        return jsonResponse(200, {
          id: "rec-membership",
          fields: (body.fields as Record<string, unknown>) || {},
        });
      }
      return new Response("Unexpected request", { status: 500 });
    });

    const env = makeEnv("app-graph-membership-upsert");
    await expect(upsertGraphMembership(env as any, {
      deployment_group_id: "grp-1",
      deployment_root_spec_id: "root",
      spec_id: "svc-a",
      environment: "prod",
      layer_index: 0,
      node_status: "reused",
      node_action: "reused",
      runtime_mode: "k8s_workspace",
    })).resolves.toMatchObject({ id: "rec-membership" });

    await expect(upsertGraphMembership(env as any, {
      deployment_group_id: "grp-1",
      deployment_root_spec_id: "root",
      spec_id: "svc-a",
      environment: "prod",
      layer_index: 0,
      node_status: "attached",
      node_action: "attached",
      runtime_mode: "k8s_workspace",
    })).resolves.toMatchObject({ id: "rec-membership" });

    expect(fetchSpy).toHaveBeenCalled();
    expect(requests.some((entry) => entry.method === "POST" && entry.url.endsWith("/GraphMemberships"))).toBe(true);
    expect(requests.some((entry) => entry.method === "PATCH" && entry.url.includes("/GraphMemberships/rec-membership"))).toBe(true);
  });
});
