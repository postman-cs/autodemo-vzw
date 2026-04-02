import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchSystemEnvironments,
  buildFallbackSystemEnvironments,
  resolveSystemEnvironments,
  buildSystemEnvMap,
  associateSystemEnvironmentBatch,
  disassociateWorkspaceFromSystemEnvironments,
  deriveSlug,
  dedupeAssociations,
} from "../src/lib/system-envs";

// Mock global fetch
const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("deriveSlug", () => {
  it("maps Production to prod", () => {
    expect(deriveSlug("Production")).toBe("prod");
  });
  it("maps Staging to stage", () => {
    expect(deriveSlug("Staging")).toBe("stage");
  });
  it("maps Stage to stage", () => {
    expect(deriveSlug("Stage")).toBe("stage");
  });
  it("maps Development to dev", () => {
    expect(deriveSlug("Development")).toBe("dev");
  });
  it("maps QA to qa", () => {
    expect(deriveSlug("QA")).toBe("qa");
  });
  it("maps Test to qa", () => {
    expect(deriveSlug("Test")).toBe("qa");
  });
  it("normalizes unknown names to kebab-case", () => {
    expect(deriveSlug("My Custom Env")).toBe("my-custom-env");
  });
  it("handles leading/trailing whitespace", () => {
    expect(deriveSlug("  Production  ")).toBe("prod");
  });
});

describe("fetchSystemEnvironments", () => {
  it("returns parsed system environments from Bifrost", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { id: "uuid-prod", name: "Production" },
            { id: "uuid-stage", name: "Staging" },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await fetchSystemEnvironments("11430732", "access-token");
    expect(result).toEqual([
      { id: "uuid-prod", name: "Production", slug: "prod" },
      { id: "uuid-stage", name: "Staging", slug: "stage" },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses existing slug field if provided", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ id: "uuid-prod", name: "Production", slug: "production" }],
        }),
        { status: 200 },
      ),
    );

    const result = await fetchSystemEnvironments("11430732", "tok");
    expect(result[0].slug).toBe("production");
  });

  it("deduplicates by slug", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { id: "uuid-1", name: "Production" },
            { id: "uuid-2", name: "production" },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await fetchSystemEnvironments("11430732", "tok");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("uuid-1");
  });

  it("throws on non-200 response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("error", { status: 500 }));
    await expect(fetchSystemEnvironments("team", "tok")).rejects.toThrow("HTTP 500");
  });

  it("throws when data is empty", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    await expect(fetchSystemEnvironments("team", "tok")).rejects.toThrow(
      "no system environments",
    );
  });
});

describe("buildFallbackSystemEnvironments", () => {
  it("parses POSTMAN_SYSTEM_ENVS_JSON", () => {
    const env = {
      POSTMAN_SYSTEM_ENVS_JSON: JSON.stringify([
        { id: "uuid-prod", name: "Production" },
        { id: "uuid-stage", name: "Stage" },
      ]),
    };
    const result = buildFallbackSystemEnvironments(env);
    expect(result).toEqual([
      { id: "uuid-prod", name: "Production", slug: "prod" },
      { id: "uuid-stage", name: "Stage", slug: "stage" },
    ]);
  });

  it("falls back to POSTMAN_SYSTEM_ENV_PROD", () => {
    const env = { POSTMAN_SYSTEM_ENV_PROD: "uuid-prod" };
    const result = buildFallbackSystemEnvironments(env);
    expect(result).toEqual([
      { id: "uuid-prod", name: "Production", slug: "prod" },
    ]);
  });

  it("returns empty when no env vars set", () => {
    expect(buildFallbackSystemEnvironments({})).toEqual([]);
  });

  it("falls back to POSTMAN_SYSTEM_ENV_PROD on invalid JSON", () => {
    const env = {
      POSTMAN_SYSTEM_ENVS_JSON: "not json",
      POSTMAN_SYSTEM_ENV_PROD: "uuid-prod",
    };
    const result = buildFallbackSystemEnvironments(env);
    expect(result).toEqual([
      { id: "uuid-prod", name: "Production", slug: "prod" },
    ]);
  });
});

describe("resolveSystemEnvironments", () => {
  it("returns Bifrost result on success", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ id: "uuid-prod", name: "Production" }],
        }),
        { status: 200 },
      ),
    );

    const result = await resolveSystemEnvironments("team", "tok", {
      POSTMAN_SYSTEM_ENV_PROD: "fallback-id",
    });
    expect(result[0].id).toBe("uuid-prod");
  });

  it("falls back on Bifrost failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network error"));

    const result = await resolveSystemEnvironments("team", "tok", {
      POSTMAN_SYSTEM_ENV_PROD: "fallback-id",
    });
    expect(result).toEqual([
      { id: "fallback-id", name: "Production", slug: "prod" },
    ]);
  });

  it("prefers a fresh Bifrost result over cached system environments", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ id: "uuid-fresh-prod", name: "Production" }],
        }),
        { status: 200 },
      ),
    );

    const kv = {
      get: vi.fn().mockResolvedValue([{ id: "uuid-stale-prod", name: "Production", slug: "prod" }]),
      put: vi.fn().mockResolvedValue(undefined),
    };

    const result = await resolveSystemEnvironments("team", "tok", {
      WORKER_LOGS: kv,
      POSTMAN_SYSTEM_ENV_PROD: "fallback-id",
    });

    expect(result).toEqual([
      { id: "uuid-fresh-prod", name: "Production", slug: "prod" },
    ]);
    expect(kv.get).toHaveBeenCalledOnce();
    expect(kv.put).toHaveBeenCalledOnce();
  });

  it("falls back to cached system environments when Bifrost is unavailable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network error"));

    const kv = {
      get: vi.fn().mockResolvedValue([{ id: "uuid-cached-prod", name: "Production", slug: "prod" }]),
      put: vi.fn().mockResolvedValue(undefined),
    };

    const result = await resolveSystemEnvironments("team", "tok", {
      WORKER_LOGS: kv,
      POSTMAN_SYSTEM_ENV_PROD: "fallback-id",
    });

    expect(result).toEqual([
      { id: "uuid-cached-prod", name: "Production", slug: "prod" },
    ]);
    expect(kv.get).toHaveBeenCalledOnce();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("does not fall back on Bifrost auth failures", async () => {
    const authError = new Error("Bifrost system-envs request failed: HTTP 403") as Error & { responseText?: string };
    authError.responseText = '{"error":{"name":"authenticationError","message":"User is not authenticated"}}';
    fetchMock.mockRejectedValueOnce(authError);

    await expect(resolveSystemEnvironments("team", "tok", {
      POSTMAN_SYSTEM_ENV_PROD: "fallback-id",
    })).rejects.toThrow("HTTP 403");
  });
});

describe("buildSystemEnvMap", () => {
  it("builds slug-to-id map", () => {
    const envs = [
      { id: "uuid-prod", name: "Production", slug: "prod" },
      { id: "uuid-stage", name: "Stage", slug: "stage" },
    ];
    expect(buildSystemEnvMap(envs)).toEqual({
      prod: "uuid-prod",
      stage: "uuid-stage",
    });
  });
});

describe("dedupeAssociations", () => {
  it("removes duplicate entries", () => {
    const result = dedupeAssociations([
      { environmentUid: "env-1", systemEnvironmentId: "sys-1" },
      { environmentUid: "env-1", systemEnvironmentId: "sys-1" },
      { environmentUid: "env-2", systemEnvironmentId: "sys-2" },
    ]);
    expect(result).toEqual([
      { environmentUid: "env-1", systemEnvironmentId: "sys-1" },
      { environmentUid: "env-2", systemEnvironmentId: "sys-2" },
    ]);
  });
});

describe("associateSystemEnvironmentBatch", () => {
  it("GETs existing associations for each system env and PUTs merged workspace entries", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            systemEnvironmentId: "new-sys",
            workspaces: [
              {
                workspaceId: "other-ws",
                associations: [
                  {
                    systemEnvironmentId: "new-sys",
                    postmanEnvironmentId: "existing-other-env",
                    workspaceId: "other-ws",
                  },
                ],
              },
              {
                workspaceId: "ws-id",
                associations: [
                  {
                    systemEnvironmentId: "new-sys",
                    postmanEnvironmentId: "existing-env",
                    workspaceId: "ws-id",
                  },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await associateSystemEnvironmentBatch(
      "ws-id",
      [{ envUid: "new-env", systemEnvId: "new-sys" }],
      "access-token",
      "team-id",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const putCall = fetchMock.mock.calls[1];
    const putBody = JSON.parse(putCall[1].body);
    expect(putBody.query).toBeUndefined();
    expect(putBody.body).toEqual({
      systemEnvironmentId: "new-sys",
      workspaceEntries: [
        { workspaceId: "other-ws", postmanEnvironmentIds: ["existing-other-env"] },
        { workspaceId: "ws-id", postmanEnvironmentIds: ["existing-env", "new-env"] },
      ],
    });
  });

  it("retries with only the target workspace entries on PUT failure", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            systemEnvironmentId: "new-sys",
            workspaces: [
              {
                workspaceId: "stale-ws",
                associations: [
                  {
                    systemEnvironmentId: "new-sys",
                    postmanEnvironmentId: "stale-env",
                    workspaceId: "stale-ws",
                  },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    fetchMock.mockResolvedValueOnce(new Response("500 error", { status: 500 }));
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await associateSystemEnvironmentBatch(
      "ws-id",
      [{ envUid: "new-env", systemEnvId: "new-sys" }],
      "tok",
      "team",
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retryBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(retryBody.body).toEqual({
      systemEnvironmentId: "new-sys",
      workspaceEntries: [
        { workspaceId: "ws-id", postmanEnvironmentIds: ["new-env"] },
      ],
    });
  });
});

describe("disassociateWorkspaceFromSystemEnvironments", () => {
  it("removes specified env UIDs from associations", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { id: "sys-1", name: "Production" },
            { id: "sys-2", name: "Stage" },
          ],
        }),
        { status: 200 },
      ),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            systemEnvironmentId: "sys-1",
            workspaces: [
              {
                workspaceId: "ws-id",
                associations: [
                  { systemEnvironmentId: "sys-1", postmanEnvironmentId: "env-1", workspaceId: "ws-id" },
                ],
              },
              {
                workspaceId: "other-ws",
                associations: [
                  { systemEnvironmentId: "sys-1", postmanEnvironmentId: "env-other", workspaceId: "other-ws" },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await disassociateWorkspaceFromSystemEnvironments("ws-id", "tok", "team", ["env-1"]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const putBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(putBody.body).toEqual({
      systemEnvironmentId: "sys-1",
      workspaceEntries: [
        { workspaceId: "other-ws", postmanEnvironmentIds: ["env-other"] },
      ],
    });
  });

  it("removes all associations when no env_uids specified", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ id: "sys-1", name: "Production" }],
        }),
        { status: 200 },
      ),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            systemEnvironmentId: "sys-1",
            workspaces: [
              {
                workspaceId: "ws-id",
                associations: [
                  { systemEnvironmentId: "sys-1", postmanEnvironmentId: "env-1", workspaceId: "ws-id" },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await disassociateWorkspaceFromSystemEnvironments("ws-id", "tok", "team");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const putBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(putBody.body).toEqual({
      systemEnvironmentId: "sys-1",
      workspaceEntries: [],
    });
  });

  it("skips PUT when no existing associations", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "sys-1", name: "Production" }] }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            systemEnvironmentId: "sys-1",
            workspaces: [],
          },
        }),
        { status: 200 },
      ),
    );

    await disassociateWorkspaceFromSystemEnvironments("ws-id", "tok", "team");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
