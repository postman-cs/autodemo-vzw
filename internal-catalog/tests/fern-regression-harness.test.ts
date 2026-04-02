import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { buildCanonicalManifest } from "../src/lib/docs-manifest";
import { _clearDeploymentsCacheForTests } from "../src/lib/airtable";
import { invalidateResolvedDeploymentsCache } from "../src/lib/deployment-state";

const WORKFLOW_PATH = new URL("../../.github/workflows/unified-fern-publish.yml", import.meta.url);
const TEST_WORKER_URL = "https://example.com";
const DOCS_URL_PATTERN = /^https:\/\/verizon-demo\.docs\.buildwithfern\.com\/[a-z0-9-]+\/[a-z0-9-]+$/;
const POSTMAN_URL_PATTERN = /^https:\/\/verizon-partner-demo\.postman\.co\/workspace\/[A-Za-z0-9-]+$/;

afterEach(() => {
  vi.restoreAllMocks();
  _clearDeploymentsCacheForTests();
  invalidateResolvedDeploymentsCache();
});

function makeAssetsBinding(): { fetch: (request: Request) => Promise<Response> } {
  return {
    async fetch(_request: Request): Promise<Response> {
      return new Response("Not found", { status: 404 });
    },
  };
}

function makeEnv() {
  return {
    ASSETS: makeAssetsBinding(),
    AIRTABLE_API_KEY: "pat-test",
    AIRTABLE_BASE_ID: "app-test",
  } as any;
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil() {
      return undefined;
    },
    passThroughOnException() {},
    props: {},
    exports: {}
  } as unknown as ExecutionContext;
}

function mockAirtableDeployments(records: Array<Record<string, unknown>>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://api.airtable.com" && url.pathname.endsWith("/Deployments")) {
      return new Response(JSON.stringify({ records }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  });
}

function makeDeploymentRecord(specId: string, workspaceId: string, runtimeMode = "lambda") {
  return {
    id: `rec-${specId}`,
    fields: {
      spec_id: specId,
      status: "active",
      workspace_team_id: workspaceId,
      workspace_id: workspaceId,
      runtime_mode: runtimeMode,
      runtime_base_url: `https://${specId}.example.internal`,
    },
  };
}

function maybeInjectBadFernUrl(url: string): string {
  if (process.env.FERN_HARNESS_INJECT_BAD_URL === "1") {
    const leaf = url.split("/").pop() || "unknown-service";
    return `https://verizon-demo.docs.buildwithfern.com/docs/api-reference/${leaf}`;
  }

  return url;
}

describe("fern regression harness", () => {
  it("keeps the central unified workflow trigger and concurrency guardrails", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).toContain("repository_dispatch:");
    expect(workflow).toContain("types: [provision_success, publish_fern]");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("group: fern-publish");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("node fern/scripts/generate-unified-docs-artifacts.mjs");
  });

  it("derives canonical Fern and Postman URLs from the manifest builder", () => {
    const manifest = buildCanonicalManifest([
      {
        spec_id: "vzw-network-operations-api",
        status: "active",
        workspace_team_id: "ws-network-ops",
      },
    ]);

    const service = manifest.tabs
      .flatMap((tab: any) => tab.services)
      .find((entry: any) => entry.id === "vzw-network-operations-api");

    expect(service).toBeTruthy();
    expect(
      maybeInjectBadFernUrl(service!.fernDocsUrl),
      "fern_docs_url must use /<tab-slug>/<api-slug> format",
    ).toMatch(DOCS_URL_PATTERN);
    expect(
      service!.postmanWorkspaceUrl,
      "run_in_postman_url must use postman.co/workspace/<workspace-id> format",
    ).toMatch(POSTMAN_URL_PATTERN);
  });

  it("serves the manifest, service map, and partner detail from the same canonical contract", async () => {
    mockAirtableDeployments([
      makeDeploymentRecord("vzw-network-operations-api", "ws-network-ops", "lambda"),
      makeDeploymentRecord("vzw-location-routing-api", "ws-location-routing", "ecs_service"),
    ]);

    const env = makeEnv();
    const [manifestResponse, serviceMapResponse, partnerDetailResponse] = await Promise.all([
      worker.fetch(new Request(`${TEST_WORKER_URL}/api/docs-manifest`), env, makeCtx()),
      worker.fetch(new Request(`${TEST_WORKER_URL}/api/public/service-map`), env, makeCtx()),
      worker.fetch(new Request(`${TEST_WORKER_URL}/api/partner/services/vzw-network-operations-api/live`), env, makeCtx()),
    ]);

    expect(manifestResponse.status).toBe(200);
    expect(serviceMapResponse.status).toBe(200);
    expect(partnerDetailResponse.status).toBe(200);

    const manifest = await manifestResponse.json() as {
      tabs: Array<{ services: Array<{ id: string; fernDocsUrl: string; postmanWorkspaceUrl: string }> }>;
    };
    const serviceMap = await serviceMapResponse.json() as Record<string, string>;
    const partnerDetail = await partnerDetailResponse.json() as {
      service: { fern_docs_url?: string; run_in_postman_url?: string };
    };

    const service = manifest.tabs
      .flatMap((tab: any) => tab.services)
      .find((entry: any) => entry.id === "vzw-network-operations-api");
    const routeKey = service ? new URL(service.fernDocsUrl).pathname.replace(/^\//, "") : "";

    expect(service).toBeTruthy();
    expect(
      maybeInjectBadFernUrl(service!.fernDocsUrl),
      "docs manifest must expose canonical Fern URLs",
    ).toMatch(DOCS_URL_PATTERN);
    expect(
      service!.postmanWorkspaceUrl,
      "docs manifest must expose canonical Postman workspace URLs",
    ).toMatch(POSTMAN_URL_PATTERN);
    expect(routeKey).toBeTruthy();
    expect(serviceMap[routeKey]).toBe("vzw-network-operations-api");
    expect(
      maybeInjectBadFernUrl(String(partnerDetail.service.fern_docs_url || "")),
      "partner detail endpoint must expose canonical Fern URLs",
    ).toMatch(DOCS_URL_PATTERN);
    expect(
      String(partnerDetail.service.run_in_postman_url || ""),
      "partner detail endpoint must expose canonical Postman workspace URLs",
    ).toMatch(POSTMAN_URL_PATTERN);
  });
});
