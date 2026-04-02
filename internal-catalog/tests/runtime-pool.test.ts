import { describe, it, expect } from "vitest";
import { allocateTenantRoute, releaseTenantRoute } from "../src/lib/runtime-pool";
import { TEST_WORKER_URL } from "./helpers/constants";

function createMockEnv(overrides?: Record<string, unknown>) {
  const store = new Map<string, string>();
  const env = {
    PORTAL_CONFIG: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
    },
    RUNTIME_POOL_BASE_URL: TEST_WORKER_URL,
    ...overrides,
  } as any;

  return { env, store };
}

describe("runtime-pool allocation", () => {
  it("uses configured ecs_base_url as final route URL when provided", async () => {
    const { env } = createMockEnv();
    const config = {
      slug: "td",
      backend: {
        runtime_defaults: {
          ecs_base_url: "http://td-api-alb-1465925779.us-east-1.elb.amazonaws.com",
        },
      },
    } as any;

    const allocation = await allocateTenantRoute("td-api", config, env);
    expect(allocation.base_url).toBe("http://td-api-alb-1465925779.us-east-1.elb.amazonaws.com");
    expect(allocation.route_url).toBe("http://td-api-alb-1465925779.us-east-1.elb.amazonaws.com");
  });

  it("replaces placeholders in configured ecs_base_url", async () => {
    const { env } = createMockEnv();
    const config = {
      slug: "td",
      backend: {
        runtime_defaults: {
          ecs_base_url: "https://runtime.example.com/services/{project}",
        },
      },
    } as any;

    const allocation = await allocateTenantRoute("td-api", config, env);
    expect(allocation.route_url).toBe("https://runtime.example.com/services/td-api");
  });

  it("uses shared /services/<project> route when no config override is set", async () => {
    const { env } = createMockEnv();
    const config = {
      slug: "td",
      backend: {
        runtime_defaults: {
          ecs_base_url: "",
        },
      },
    } as any;

    const allocation = await allocateTenantRoute("td-api", config, env);
    expect(allocation.route_url).toBe(`${TEST_WORKER_URL}/services/td-api`);
  });

  it("releases stored assignment key", async () => {
    const { env, store } = createMockEnv();
    const config = {
      slug: "td",
      backend: {
        runtime_defaults: {
          ecs_base_url: "",
        },
      },
    } as any;

    const allocation = await allocateTenantRoute("td-api", config, env);
    expect(store.has(allocation.assignment_key)).toBe(true);

    await releaseTenantRoute("td-api", "td", env);
    expect(store.has(allocation.assignment_key)).toBe(false);
  });
});
