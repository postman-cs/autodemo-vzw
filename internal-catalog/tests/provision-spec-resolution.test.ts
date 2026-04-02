import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import type { PortalConfig } from "../src/lib/config";
import { resolveSpec } from "../src/lib/provision";
import { server, setupFetchMock, teardownFetchMock } from "./helpers/fetch-mock";
import { TEST_WORKER_URL } from "./helpers/constants";

const BASE_CONFIG: PortalConfig = {
  slug: "test",
  customer_name: "Test Corp",
  platform: { name: "Test Platform", subtitle: "Dev Platform", jira_prefix: "TEST", iam_role_prefix: "test" },
  branding: { primary: "#000000", primary_hover: "#111111", logo: "logo.png", favicon: "favicon.png", hero_image: "hero.png" },
  contact: { email_domain: "example.com", email_from: "platform@example.com", email_signature: "Platform Team", support_label: "Support" },
  domains: [{ value: "wealth", label: "Wealth", code: "WEAL", governance_group: "Wealth-APIs", default: true }],
  aws_accounts: [{ id: "111111111111", label: "1111****1111 - Dev", product_code: "WEAL-001", service_name: "Wealth Service" }],
  templates: [{ title: "Template", description: "Template", version: "v1" }],
  form_defaults: { project_name: "test-api", application_id: "APP-TEST", form_title: "Test", form_subtitle: "Test" },
  specs: [{ value: "platform-management-api", label: "Platform Management API", url: "https://example.com/default.yaml" }],
  sidebar: { navigation: [], tools: [], support: [] },
  backend: {
    github_org: "postman-cs",
    user_agent: "portal-demo-worker",
    boilerplate_url: "https://example.com/boilerplate",
    git_committer_name: "Platform Bot",
    git_committer_email: "platform@example.com",
    fallback_team_id: 1,
    fallback_team_name: "Team",
  },
};

function req(overrides: Record<string, unknown>) {
  return {
    project_name: "test-api",
    domain: "wealth",
    requester_email: "dev@example.com",
    ...overrides,
  } as any;
}

describe("resolveSpec", () => {
  beforeEach(() => {
    setupFetchMock();
  });

  afterEach(() => {
    teardownFetchMock();
  });

  afterAll(() => server.close());

  it("derives canonical URL from spec_source and fetches from assets first", async () => {
    const result = await resolveSpec(
      req({ spec_source: "vzw-network-operations-api" }),
      BASE_CONFIG,
      {
        requestOrigin: "https://example.com",
        env: {
          ASSETS: {
            fetch: async (request: Request) => {
              const url = new URL(request.url);
              if (url.pathname === "/specs/repos/vzw-network-operations-api/openapi.yaml") {
                return new Response("openapi: 3.0.3\npaths: {}\n", { status: 200 });
              }
              return new Response("Not found", { status: 404 });
            },
          },
        },
      },
    );

    expect(result.source).toBe("vzw-network-operations-api");
    expect(result.specUrl).toBe("https://example.com/specs/repos/vzw-network-operations-api/openapi.yaml");
    expect(result.content).toContain("paths: {}");
  });

  it("falls back to network fetch when assets lookup misses", async () => {
    server.use(
      http.get("https://example.com/specs/repos/vzw-network-operations-api/openapi.yaml", () =>
        new HttpResponse("openapi: 3.0.3\npaths: {}\n", { status: 200 }), { once: true }),
    );

    const result = await resolveSpec(
      req({ spec_source: "vzw-network-operations-api" }),
      BASE_CONFIG,
      {
        requestOrigin: "https://example.com",
        env: {
          ASSETS: {
            fetch: async () => new Response("Not found", { status: 404 }),
          },
        },
      },
    );
    expect(result.source).toBe("vzw-network-operations-api");
    expect(result.specUrl).toBe("https://example.com/specs/repos/vzw-network-operations-api/openapi.yaml");
    expect(result.content).toContain("paths: {}");
  });

  it("rejects unknown spec_source", async () => {
    await expect(
      resolveSpec(
        req({ spec_source: "catalog-api" }),
        BASE_CONFIG,
        { requestOrigin: "https://example.com" },
      ),
    ).rejects.toThrow("Unknown spec_source");
  });

  it("rejects inline spec content", async () => {
    await expect(
      resolveSpec(
        req({ spec_source: "vzw-network-operations-api", spec_content: "openapi: 3.0.3\npaths: {}\n" }),
        BASE_CONFIG,
        { requestOrigin: "https://example.com" },
      ),
    ).rejects.toThrow("Inline spec_content is no longer supported");
  });

  it("rejects legacy custom sources", async () => {
    await expect(
      resolveSpec(
        req({ spec_source: "custom-upload", spec_url: "https://example.com/specs/catalog.yaml" }),
        BASE_CONFIG,
        { requestOrigin: "https://example.com" },
      ),
    ).rejects.toThrow("Custom spec sources are no longer supported");
  });

  it("supports legacy spec_url-only requests when URL maps to registry", async () => {
    server.use(
      http.get("https://example.com/specs/repos/vzw-network-operations-api/openapi.yaml", () =>
        new HttpResponse("openapi: 3.0.3\npaths: {}\n", { status: 200 }), { once: true }),
    );

    const result = await resolveSpec(
      req({ spec_url: "https://example.com/specs/repos/vzw-network-operations-api/openapi.yaml" }),
      BASE_CONFIG,
      { requestOrigin: "https://example.com" },
    );
    expect(result.source).toBe("vzw-network-operations-api");
    expect(result.specUrl).toBe("https://example.com/specs/repos/vzw-network-operations-api/openapi.yaml");
    expect(result.content).toContain("paths: {}");
  });

  it("supports legacy non-registry spec_url requests for compatibility", async () => {
    server.use(
      http.get("https://example.com/legacy-spec.yaml", () =>
        new HttpResponse("openapi: 3.0.3\npaths: {}\n", { status: 200 }), { once: true }),
    );

    const result = await resolveSpec(
      req({ spec_url: "https://example.com/legacy-spec.yaml" }),
      BASE_CONFIG,
      { requestOrigin: "https://example.com" },
    );
    expect(result.source).toBe("legacy_spec_url");
    expect(result.specUrl).toBe("https://example.com/legacy-spec.yaml");
    expect(result.content).toContain("paths: {}");
  });

  it("requires spec_source or legacy spec_url", async () => {
    await expect(
      resolveSpec(
        req({}),
        BASE_CONFIG,
        { requestOrigin: "https://example.com" },
      ),
    ).rejects.toThrow("spec_source is required");
  });

  it("returns detailed errors when registry fetch fails", async () => {
    server.use(
      http.get("https://example.com/specs/repos/vzw-network-operations-api/openapi.yaml", () =>
        new HttpResponse("boom", { status: 404 }), { once: true }),
    );

    await expect(
      resolveSpec(
        req({ spec_source: "vzw-network-operations-api" }),
        BASE_CONFIG,
        {
          requestOrigin: "https://example.com",
          env: {
            ASSETS: {
              fetch: async () => new Response("Not found", { status: 404 }),
            },
          },
        },
      ),
    ).rejects.toThrow("Failed to load registry spec vzw-network-operations-api");
  });

  it("rejects non-spec responses from URL source", async () => {
    server.use(
      http.get("https://example.com/legacy-nonspec.yaml", () =>
        new HttpResponse("just plain text", { status: 200 }), { once: true }),
    );

    await expect(
      resolveSpec(
        req({ spec_url: "https://example.com/legacy-nonspec.yaml" }),
        BASE_CONFIG,
        { requestOrigin: "https://example.com" },
      ),
    ).rejects.toThrow("does not look like an OpenAPI spec");
  });

  it("uses public spec_url origin when requestOrigin is localhost", async () => {
    server.use(
      http.get(`${TEST_WORKER_URL}/specs/repos/vzw-network-operations-api/openapi.yaml`, () =>
        new HttpResponse("openapi: 3.0.3\npaths: {}\n", { status: 200 }), { once: true }),
    );

    const result = await resolveSpec(
      req({
        spec_source: "vzw-network-operations-api",
        spec_url: `${TEST_WORKER_URL}/specs/repos/vzw-network-operations-api/openapi.yaml`,
      }),
      BASE_CONFIG,
      { requestOrigin: "http://localhost:8787" },
    );

    expect(result.source).toBe("vzw-network-operations-api");
    expect(result.specUrl).toBe(
      `${TEST_WORKER_URL}/specs/repos/vzw-network-operations-api/openapi.yaml`,
    );
    expect(result.specUrl).not.toContain("localhost");
    expect(result.content).toContain("paths: {}");
  });

  it("uses public spec_url origin when requestOrigin is 127.0.0.1", async () => {
    server.use(
      http.get(`${TEST_WORKER_URL}/specs/repos/vzw-network-operations-api/openapi.yaml`, () =>
        new HttpResponse("openapi: 3.0.3\npaths: {}\n", { status: 200 }), { once: true }),
    );

    const result = await resolveSpec(
      req({
        spec_source: "vzw-network-operations-api",
        spec_url: `${TEST_WORKER_URL}/specs/repos/vzw-network-operations-api/openapi.yaml`,
      }),
      BASE_CONFIG,
      { requestOrigin: "http://127.0.0.1:8787" },
    );

    expect(result.specUrl).toBe(
      `${TEST_WORKER_URL}/specs/repos/vzw-network-operations-api/openapi.yaml`,
    );
    expect(result.specUrl).not.toContain("127.0.0.1");
  });

  it("throws when both requestOrigin and spec_url are localhost", async () => {
    await expect(
      resolveSpec(
        req({
          spec_source: "vzw-network-operations-api",
          spec_url: "http://localhost:8787/specs/repos/vzw-network-operations-api/openapi.yaml",
        }),
        BASE_CONFIG,
        { requestOrigin: "http://localhost:8787" },
      ),
    ).rejects.toThrow("Unable to determine request origin");
  });

  it("uses WORKER_ORIGIN when requestOrigin and spec_url are localhost in local dev", async () => {
    server.use(
      http.get(`${TEST_WORKER_URL}/specs/repos/vzw-network-operations-api/openapi.yaml`, () =>
        new HttpResponse("openapi: 3.0.3\npaths: {}\n", { status: 200 }), { once: true }),
    );

    const result = await resolveSpec(
      req({
        spec_source: "vzw-network-operations-api",
        spec_url: "http://localhost:5173/specs/repos/vzw-network-operations-api/openapi.yaml",
      }),
      BASE_CONFIG,
      {
        requestOrigin: "http://localhost:5173",
        env: {
          ASSETS: {
            fetch: async () => new Response("Not found", { status: 404 }),
          },
          WORKER_ORIGIN: TEST_WORKER_URL,
        } as any,
      },
    );

    expect(result.specUrl).toBe(`${TEST_WORKER_URL}/specs/repos/vzw-network-operations-api/openapi.yaml`);
    expect(result.content).toContain("paths: {}");
  });
});
