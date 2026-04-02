import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { toggleServiceChaos } from "../src/lib/chaos";
import * as airtable from "../src/lib/airtable";
import * as github from "../src/lib/github";
import { server, setupFetchMock, teardownFetchMock } from "./helpers/fetch-mock";

const mockEnv = {
  AIRTABLE_API_KEY: "airtable-key",
  AIRTABLE_BASE_ID: "base-test",
  GH_TOKEN: "test-gh",
} as any;

describe("toggleServiceChaos", () => {
  beforeEach(() => {
    setupFetchMock();
  });

  afterEach(() => {
    teardownFetchMock({
      onFinally: () => {
        vi.restoreAllMocks();
      },
    });
  });

  afterAll(() => server.close());

  it("updates state only for URLs that successfully patched", async () => {
    vi.spyOn(airtable, "getDeployment").mockResolvedValue({
      id: "rec1",
      spec_id: "test-service",
      chaos_enabled_map: '{"prod": false, "stage": false}',
      environment_deployments: JSON.stringify([
        { environment: "prod", runtime_url: "https://prod.internal" },
        { environment: "stage", runtime_url: "https://stage.internal" },
      ]),
    } as any);

    const updateSpy = vi.spyOn(airtable, "updateDeployment").mockResolvedValue({} as any);
    vi.spyOn(github, "createRepoVariable").mockResolvedValue(undefined);

    server.use(
      http.patch("https://prod.internal/chaos", () =>
        HttpResponse.json({}, { status: 200 }), { once: true }),
      http.patch("https://stage.internal/chaos", () =>
        new HttpResponse("Internal Server Error", { status: 500 }), { once: true }),
    );

    const result = await toggleServiceChaos("test-service", true, mockEnv);

    expect(result.updated_urls).toEqual(["https://prod.internal"]);
    expect(result.failed_urls).toHaveLength(1);
    expect(result.failed_urls[0].url).toBe("https://stage.internal");

    expect(updateSpy).toHaveBeenCalledWith(
      expect.anything(),
      "rec1",
      expect.objectContaining({
        chaos_enabled: true,
        chaos_enabled_map: JSON.stringify({ prod: true, stage: false }),
      })
    );
  });

  it("does not update aggregate flag or map if all patches fail", async () => {
    vi.spyOn(airtable, "getDeployment").mockResolvedValue({
      id: "rec1",
      spec_id: "test-service",
      chaos_enabled: false,
      chaos_enabled_map: '{"prod": false}',
      environment_deployments: JSON.stringify([
        { environment: "prod", runtime_url: "https://prod.internal" },
      ]),
    } as any);

    const updateSpy = vi.spyOn(airtable, "updateDeployment").mockResolvedValue({} as any);
    vi.spyOn(github, "createRepoVariable").mockResolvedValue(undefined);

    server.use(
      http.patch("https://prod.internal/chaos", () =>
        new HttpResponse("Gateway Timeout", { status: 503 }), { once: true }),
    );

    const result = await toggleServiceChaos("test-service", true, mockEnv, "prod");

    expect(result.failed_urls).toHaveLength(1);
    expect(result.updated_urls).toHaveLength(0);

    expect(updateSpy).toHaveBeenCalledWith(
      expect.anything(),
      "rec1",
      expect.objectContaining({
        chaos_enabled: false,
        chaos_enabled_map: JSON.stringify({ prod: false }),
      })
    );
  });
});
