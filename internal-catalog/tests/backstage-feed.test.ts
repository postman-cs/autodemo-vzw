import { describe, it, expect, afterEach, vi } from "vitest";
import YAML from "yaml";
import { buildBackstageCatalogYaml, resetBackstageFeedCacheForTests } from "../src/lib/backstage-feed";
import { TEST_AWS_REGION, TEST_GITHUB_ORG, TEST_WORKER_URL } from "./helpers/constants";

describe("backstage feed generation", () => {
  afterEach(() => {
    resetBackstageFeedCacheForTests();
    vi.restoreAllMocks();
  });

  it("builds Component and API entities for active deployments only", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      const url = new URL(req.url);
      if (url.hostname === "api.getpostman.com" && url.pathname.includes("/specs/spec-001/files/")) {
        return new Response(JSON.stringify({
          content: "openapi: 3.0.3\ninfo:\n  title: Demo API\n  version: 1.0.0\npaths: {}\n",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    const yaml = await buildBackstageCatalogYaml({
      deployments: [
        {
          spec_id: "vzw-network-operations-api",
          status: "active",
          runtime_mode: "lambda",
          aws_region: TEST_AWS_REGION,
          workspace_id: "ws-123",
          postman_workspace_url: "https://go.postman.co/workspace/ws-123",
          postman_spec_uid: "spec-001",
          github_repo_url: `https://github.com/${TEST_GITHUB_ORG}/vzw-network-operations-api`,
          aws_invoke_url: "https://abc123.execute-api.eu-west-2.amazonaws.com",
        },
        {
          spec_id: "vzw-location-routing-api",
          status: "failed",
          postman_spec_uid: "spec-002",
        },
      ],
      env: {
        POSTMAN_API_KEY: "pmak-test",
      },
      requestOrigin: TEST_WORKER_URL,
      scope: "active",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const docs = YAML.parseAllDocuments(yaml).map((doc) => doc.toJSON() as Record<string, unknown>);
    expect(docs).toHaveLength(2);

    const component = docs.find((doc) => doc.kind === "Component");
    const api = docs.find((doc) => doc.kind === "API");
    expect(component).toBeTruthy();
    expect(api).toBeTruthy();

    const componentMetadata = component?.metadata as Record<string, unknown>;
    const componentAnnotations = (componentMetadata.annotations || {}) as Record<string, string>;
    expect(componentAnnotations["catalog-admin.postman.com/postman-action-label"]).toBe("Open in Postman");
    expect(componentAnnotations["github.com/project-slug"]).toBe(`${TEST_GITHUB_ORG}/vzw-network-operations-api`);

    const apiSpec = (api?.spec || {}) as Record<string, unknown>;
    expect(String(apiSpec.definition || "")).toContain("openapi: 3.0.3");
  });

  it("uses placeholder definition when postman_spec_uid is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const yaml = await buildBackstageCatalogYaml({
      deployments: [
        {
          spec_id: "vzw-network-operations-api",
          status: "active",
          runtime_mode: "lambda",
          aws_region: TEST_AWS_REGION,
          postman_workspace_url: "https://go.postman.co/workspace/ws-123",
        },
      ],
      env: {
        POSTMAN_API_KEY: "pmak-test",
      },
      scope: "active",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    const docs = YAML.parseAllDocuments(yaml).map((doc) => doc.toJSON() as Record<string, unknown>);
    const api = docs.find((doc) => doc.kind === "API");
    const apiSpec = (api?.spec || {}) as Record<string, unknown>;
    const metadata = (api?.metadata || {}) as Record<string, unknown>;
    const annotations = (metadata.annotations || {}) as Record<string, string>;

    expect(String(apiSpec.definition || "")).toContain("Placeholder definition");
    expect(annotations["catalog-admin.postman.com/spec-load-error"]).toContain("postman_spec_uid is missing");
  });

  it("emits full registry graph with development lifecycle when scope is all", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const yaml = await buildBackstageCatalogYaml({
      deployments: [],
      env: {
        POSTMAN_API_KEY: "pmak-test",
      },
      scope: "all",
    });

    expect(fetchSpy).not.toHaveBeenCalled();

    const docs = YAML.parseAllDocuments(yaml).map((doc) => doc.toJSON() as Record<string, unknown>);
    const registrySize = (await import("../specs/registry.json")).default.length;
    expect(docs.length).toBe(registrySize * 2);

    const component = docs.find((doc) => doc.kind === "Component" && (doc.metadata as any)?.name === "vzw-network-operations-api");
    expect(component).toBeTruthy();

    const componentSpec = (component?.spec || {}) as Record<string, unknown>;
    expect(componentSpec.lifecycle).toBe("development");
    expect(componentSpec.providesApis).toEqual(["api:default/vzw-network-operations-api-api"]);
    expect(Array.isArray(componentSpec.consumesApis)).toBe(true);
    expect((componentSpec.consumesApis as string[])).toContain("api:default/vzw-network-operations-api-api");

    const hasGraphEdges = docs.some((doc) => {
      if (doc.kind !== "Component") return false;
      const spec = (doc.spec || {}) as Record<string, unknown>;
      return Array.isArray(spec.dependsOn) && (spec.dependsOn as unknown[]).length > 0;
    });
    expect(hasGraphEdges).toBe(true);
  });

  it("switches CTA label to Run in Postman when run URL exists", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({
        content: "openapi: 3.0.3\ninfo:\n  title: Demo API\n  version: 1.0.0\npaths: {}\n",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const yaml = await buildBackstageCatalogYaml({
      deployments: [
        {
          spec_id: "vzw-network-operations-api",
          status: "active",
          postman_spec_uid: "spec-001",
          workspace_id: "ws-123",
          postman_workspace_url: "https://go.postman.co/workspace/ws-123",
          postman_run_url: "https://run.pstmn.io/button",
        },
      ],
      env: {
        POSTMAN_API_KEY: "pmak-test",
      },
      scope: "active",
    });

    const docs = YAML.parseAllDocuments(yaml).map((doc) => doc.toJSON() as Record<string, unknown>);
    const component = docs.find((doc) => doc.kind === "Component");
    const metadata = (component?.metadata || {}) as Record<string, unknown>;
    const annotations = (metadata.annotations || {}) as Record<string, string>;
    expect(annotations["catalog-admin.postman.com/postman-action-label"]).toBe("Run in Postman");
    expect(annotations["catalog-admin.postman.com/postman-action-url"]).toBe("https://run.pstmn.io/button");
  });

  it("does not emit github.com/project-slug for non-github repo URLs", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({
        content: "openapi: 3.0.3\ninfo:\n  title: Demo API\n  version: 1.0.0\npaths: {}\n",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const yaml = await buildBackstageCatalogYaml({
      deployments: [
        {
          spec_id: "vzw-network-operations-api",
          status: "active",
          postman_spec_uid: "spec-001",
          workspace_id: "ws-123",
          github_repo_url: "https://gitlab.com/postman-cs/vzw-network-operations-api",
        },
      ],
      env: {
        POSTMAN_API_KEY: "pmak-test",
      },
      scope: "active",
    });

    const docs = YAML.parseAllDocuments(yaml).map((doc) => doc.toJSON() as Record<string, unknown>);
    const component = docs.find((doc) => doc.kind === "Component");
    const metadata = (component?.metadata || {}) as Record<string, unknown>;
    const annotations = (metadata.annotations || {}) as Record<string, string>;
    expect(annotations["github.com/project-slug"]).toBeUndefined();
  });

  it("emits per-environment mapping annotations for multi-env deployments", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({
        content: "openapi: 3.0.3\ninfo:\n  title: Demo API\n  version: 1.0.0\npaths: {}\n",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const yaml = await buildBackstageCatalogYaml({
      deployments: [
        {
          spec_id: "vzw-network-operations-api",
          status: "active",
          runtime_mode: "ecs_service",
          postman_spec_uid: "spec-001",
          workspace_id: "ws-123",
          postman_workspace_url: "https://go.postman.co/workspace/ws-123",
          environment_deployments: JSON.stringify([
            {
              environment: "prod",
              runtime_url: "https://prod.example.test",
              api_gateway_id: "gw-prod-001",
              postman_env_uid: "env-prod",
              system_env_id: "sys-prod",
              status: "active",
              deployed_at: "2026-03-04T13:00:00Z",
              branch: "env/prod",
            },
            {
              environment: "stage",
              runtime_url: "https://stage.example.test",
              api_gateway_id: "gw-stage-001",
              postman_env_uid: "env-stage",
              system_env_id: "sys-stage",
              status: "active",
              deployed_at: "2026-03-04T13:05:00Z",
              branch: "env/stage",
            },
          ]),
          chaos_enabled_map: JSON.stringify({ prod: true, stage: false }),
        },
      ],
      env: {
        POSTMAN_API_KEY: "pmak-test",
      },
      scope: "active",
    });

    const docs = YAML.parseAllDocuments(yaml).map((doc) => doc.toJSON() as Record<string, unknown>);
    const component = docs.find((doc) => doc.kind === "Component");
    const metadata = (component?.metadata || {}) as Record<string, unknown>;
    const annotations = (metadata.annotations || {}) as Record<string, string>;
    const links = (metadata.links || []) as Array<{ url: string; title: string; type?: string }>;

    expect(annotations["catalog-admin.postman.com/environments"]).toBe("prod,stage");

    expect(annotations["catalog-admin.postman.com/runtime-url-prod"]).toBe("https://prod.example.test");
    expect(annotations["catalog-admin.postman.com/runtime-url-stage"]).toBe("https://stage.example.test");
    expect(annotations["catalog-admin.postman.com/postman-env-uid-prod"]).toBe("env-prod");
    expect(annotations["catalog-admin.postman.com/postman-env-uid-stage"]).toBe("env-stage");
    expect(annotations["catalog-admin.postman.com/system-env-id-prod"]).toBe("sys-prod");
    expect(annotations["catalog-admin.postman.com/system-env-id-stage"]).toBe("sys-stage");
    expect(annotations["catalog-admin.postman.com/environment-status-prod"]).toBe("active");
    expect(annotations["catalog-admin.postman.com/environment-status-stage"]).toBe("active");
    expect(annotations["catalog-admin.postman.com/deployed-at-prod"]).toBe("2026-03-04T13:00:00Z");
    expect(annotations["catalog-admin.postman.com/deployed-at-stage"]).toBe("2026-03-04T13:05:00Z");
    expect(annotations["catalog-admin.postman.com/environment-branch-prod"]).toBe("env/prod");
    expect(annotations["catalog-admin.postman.com/environment-branch-stage"]).toBe("env/stage");
    expect(annotations["catalog-admin.postman.com/api-gateway-id-prod"]).toBe("gw-prod-001");
    expect(annotations["catalog-admin.postman.com/api-gateway-id-stage"]).toBe("gw-stage-001");
    expect(annotations["catalog-admin.postman.com/chaos-enabled-prod"]).toBe("true");
    expect(annotations["catalog-admin.postman.com/chaos-enabled-stage"]).toBe("false");

    expect(annotations["catalog-admin.postman.com/environment-deployments-json"]).toContain("\"environment\":\"prod\"");
    expect(annotations["catalog-admin.postman.com/environment-deployments-json"]).toContain("\"environment\":\"stage\"");

    const runtimeLinks = links.filter((l) => l.type?.startsWith("runtime-"));
    expect(runtimeLinks).toHaveLength(2);
    expect(runtimeLinks.find((l) => l.type === "runtime-prod")?.url).toBe("https://prod.example.test");
    expect(runtimeLinks.find((l) => l.type === "runtime-stage")?.url).toBe("https://stage.example.test");

    const envLinks = links.filter((l) => l.type?.startsWith("postman-env-"));
    expect(envLinks).toHaveLength(2);
    expect(envLinks.find((l) => l.type === "postman-env-prod")?.title).toBe("Postman Env (prod)");
    expect(envLinks.find((l) => l.type === "postman-env-stage")?.title).toBe("Postman Env (stage)");
  });

  it("omits per-environment annotations when environment_deployments is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({
        content: "openapi: 3.0.3\ninfo:\n  title: Demo API\n  version: 1.0.0\npaths: {}\n",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const yaml = await buildBackstageCatalogYaml({
      deployments: [
        {
          spec_id: "vzw-network-operations-api",
          status: "active",
          postman_spec_uid: "spec-001",
          workspace_id: "ws-123",
        },
      ],
      env: { POSTMAN_API_KEY: "pmak-test" },
      scope: "active",
    });

    const docs = YAML.parseAllDocuments(yaml).map((doc) => doc.toJSON() as Record<string, unknown>);
    const component = docs.find((doc) => doc.kind === "Component");
    const metadata = (component?.metadata || {}) as Record<string, unknown>;
    const annotations = (metadata.annotations || {}) as Record<string, string>;

    expect(annotations["catalog-admin.postman.com/environments"]).toBeUndefined();
    expect(annotations["catalog-admin.postman.com/environment-deployments-json"]).toBeUndefined();
  });
});
