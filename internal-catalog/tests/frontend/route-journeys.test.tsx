import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { renderRoute } from "./helpers/render";
import { mockFetch, restoreFetch, jsonResponse } from "./helpers/mock-fetch";

const EMPTY_DEPLOYMENTS = { deployments: [], recoverable_failures: [] };
const EMPTY_CONFIG = {
  runtime: {
    lambda: { available: true, unavailableReason: "" },
    ecs_service: { available: false, unavailableReason: "ECS runtime unavailable", activeServices: 0, remainingServices: 0 },
    k8s_workspace: { available: false, unavailableReason: "Kubernetes workspace mode unavailable", activeServices: 0 },
    k8s_discovery: { available: false, unavailableReason: "Kubernetes discovery mode unavailable", activeServices: 0, sharedInfraActive: false },
  },
  aws_region: "eu-central-1",
  github_org: "postman-cs",
  github_org_url: "https://github.com/postman-cs",
};
const EMPTY_REGISTRY = { teams: [] };
const EMPTY_USERS = { users: [] };
const EMPTY_SYSTEM_ENVS = { system_envs: [] };
const EMPTY_ORG_MEMBERS = { members: [] };
const EMPTY_CATALOG: unknown[] = [];

function setupDefaultMocks(): void {
  mockFetch({
    "/api/deployments": () => jsonResponse(EMPTY_DEPLOYMENTS),
    "/api/config": () => jsonResponse(EMPTY_CONFIG),
    "/api/teams/registry": () => jsonResponse(EMPTY_REGISTRY),
    "/api/users": () => jsonResponse(EMPTY_USERS),
    "/api/system-envs": () => jsonResponse(EMPTY_SYSTEM_ENVS),
    "/api/github/org-members": () => jsonResponse(EMPTY_ORG_MEMBERS),
    "/api/catalog": () => jsonResponse(EMPTY_CATALOG),
  });
}

function setupGraphCapableMocks(): void {
  mockFetch({
    "/api/deployments": () => jsonResponse(EMPTY_DEPLOYMENTS),
    "/api/config": () => jsonResponse({
      runtime: {
        lambda: { available: true, unavailableReason: "" },
        ecs_service: { available: false, unavailableReason: "ECS runtime unavailable", activeServices: 0, remainingServices: 0 },
        k8s_workspace: { available: true, unavailableReason: "", activeServices: 0 },
        k8s_discovery: { available: false, unavailableReason: "Kubernetes discovery mode unavailable", activeServices: 0, sharedInfraActive: false },
      },
      aws_region: "eu-central-1",
      github_org: "postman-cs",
      github_org_url: "https://github.com/postman-cs",
    }),
    "/api/teams/registry": () => jsonResponse(EMPTY_REGISTRY),
    "/api/users": () => jsonResponse(EMPTY_USERS),
    "/api/system-envs": () => jsonResponse(EMPTY_SYSTEM_ENVS),
    "/api/github/org-members": () => jsonResponse(EMPTY_ORG_MEMBERS),
    "/api/catalog": () => jsonResponse(EMPTY_CATALOG),
  });
}

describe("route-level journeys", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setupDefaultMocks();
  });

  afterEach(() => {
    restoreFetch();
    vi.useRealTimers();
  });

  describe("provisioning journey", () => {
    it("renders provision page with staged flow controls", async () => {
      let result: ReturnType<typeof renderRoute>;

      await act(async () => {
        result = renderRoute("/provision");
      });

      const { container, unmount } = result!;
      
      expect(container.textContent).toContain("Provision");

      const modeInputs = container.querySelectorAll('input[name="deployment_mode"]');
      expect(modeInputs.length).toBeGreaterThanOrEqual(2);

      const runtimeInputs = container.querySelectorAll('input[name="runtime_mode"]');
      expect(runtimeInputs.length).toBeGreaterThanOrEqual(2);
      
      unmount();
    });

    it("shows graph mode as primary deployment option", async () => {
      let result: ReturnType<typeof renderRoute>;

      setupGraphCapableMocks();

      await act(async () => {
        result = renderRoute("/provision");
      });

      const { container, unmount } = result!;
      
      const graphModeInput = container.querySelector('input[value="graph"]');
      expect(graphModeInput).not.toBeNull();
      expect((graphModeInput as HTMLInputElement)?.disabled).toBe(false);
      
      unmount();
    });

    it("renders spec selector in provision context", async () => {
      let result: ReturnType<typeof renderRoute>;

      await act(async () => {
        result = renderRoute("/provision");
      });

      const { container, unmount } = result!;
      
      expect(container.textContent?.toLowerCase()).toContain("select");
      
      unmount();
    });
  });

  describe("monitoring/recovery split", () => {
    it("renders catalog page with services table", async () => {
      let result: ReturnType<typeof renderRoute>;

      await act(async () => {
        result = renderRoute("/");
      });

      const { container, unmount } = result!;
      
      expect(container.textContent).toContain("Services");
      
      unmount();
    });

    it("renders recovery page as separate route", async () => {
      let result: ReturnType<typeof renderRoute>;

      await act(async () => {
        result = renderRoute("/recovery");
      });

      const { container, unmount } = result!;
      
      expect(container.textContent).toContain("Recovery");
      expect(container.textContent).toContain("Queue");
      
      unmount();
    });

    it("shows navigation links for both monitoring and recovery", async () => {
      let result: ReturnType<typeof renderRoute>;

      await act(async () => {
        result = renderRoute("/");
      });

      const { container, unmount } = result!;
      
      const nav = container.querySelector("nav.header-nav");
      expect(nav).not.toBeNull();
      
      const links = Array.from(nav!.querySelectorAll("a")).map((el) => el.textContent?.trim());
      expect(links).toContain("Services");
      expect(links).toContain("Recovery");
      
      unmount();
    });

    it("recovery page shows empty state when no failures", async () => {
      let result: ReturnType<typeof renderRoute>;

      await act(async () => {
        result = renderRoute("/recovery");
      });

      const { container, unmount } = result!;
      
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      
      expect(container.textContent).toContain("No recoverable failures");
      
      unmount();
    });
  });

  describe("credentials/settings journey", () => {
    it("renders settings page with team registry", async () => {
      let result: ReturnType<typeof renderRoute>;

      await act(async () => {
        result = renderRoute("/settings");
      });

      const { container, unmount } = result!;
      
      expect(container.textContent).toContain("Settings");
      expect(container.textContent?.toLowerCase()).toContain("team");
      
      unmount();
    });

    it("shows add team button in settings", async () => {
      let result: ReturnType<typeof renderRoute>;

      await act(async () => {
        result = renderRoute("/settings");
      });

      const { container, unmount } = result!;
      
      const hasAddTeam = container.textContent?.toLowerCase().includes('add team') ||
                        container.textContent?.toLowerCase().includes('register team');
      expect(hasAddTeam).toBe(true);
      
      unmount();
    });
  });

  describe("docs/discovery journey", () => {
    it("renders docs page at /docs route", async () => {
      let result: ReturnType<typeof renderRoute>;

      await act(async () => {
        result = renderRoute("/docs");
      });

      const { container, unmount } = result!;
      
      expect(container.textContent).toContain("Documentation");
      
      unmount();
    });

    it("shows docs link in main navigation", async () => {
      let result: ReturnType<typeof renderRoute>;

      await act(async () => {
        result = renderRoute("/");
      });

      const { container, unmount } = result!;
      
      const nav = container.querySelector("nav.header-nav");
      const links = Array.from(nav!.querySelectorAll("a")).map((el) => el.textContent?.trim());
      expect(links).toContain("Docs");
      
      unmount();
    });

    it("marks docs link active at /docs", async () => {
      let result: ReturnType<typeof renderRoute>;

      await act(async () => {
        result = renderRoute("/docs");
      });

      const { container, unmount } = result!;
      
      const nav = container.querySelector("nav.header-nav");
      const activeLinks = Array.from(nav!.querySelectorAll("a.active")).map((el) => el.textContent?.trim());
      expect(activeLinks).toContain("Docs");
      
      unmount();
    });
  });

  describe("error states and boundaries", () => {
    it("renders 404 page for unknown routes", async () => {
      let result: ReturnType<typeof renderRoute>;

      await act(async () => {
        result = renderRoute("/unknown-route");
      });

      const { container, unmount } = result!;
      
      expect(container.textContent?.toLowerCase()).toContain("not found");
      
      unmount();
    });

    it("maintains shell layout on error pages", async () => {
      let result: ReturnType<typeof renderRoute>;

      await act(async () => {
        result = renderRoute("/nonexistent");
      });

      const { container, unmount } = result!;
      
      const header = container.querySelector("header.header");
      expect(header).not.toBeNull();

      const nav = container.querySelector("nav.header-nav");
      expect(nav).not.toBeNull();

      unmount();
    });
  });

  describe("deep linking support", () => {
    it("settings page renders with team filter from query param", async () => {
      let result: ReturnType<typeof renderRoute>;

      await act(async () => {
        result = renderRoute("/settings?team=test-team");
      });

      const { container, unmount } = result!;
      
      expect(container.textContent).toContain("Settings");
      
      unmount();
    });

    it("catalog page renders with team filter from query param", async () => {
      let result: ReturnType<typeof renderRoute>;

      await act(async () => {
        result = renderRoute("/?team=test-team");
      });

      const { container, unmount } = result!;
      
      expect(container.textContent).toContain("Services");
      
      unmount();
    });
  });
});

describe("priority journey coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setupDefaultMocks();
  });

  afterEach(() => {
    restoreFetch();
    vi.useRealTimers();
  });

  it("covers all first-class routes without errors", async () => {
    const routes = ["/", "/provision", "/recovery", "/settings", "/docs"];
    
    for (const route of routes) {
      let result: ReturnType<typeof renderRoute>;
      
      await act(async () => {
        result = renderRoute(route);
      });

      const { container, unmount } = result!;
      
      const errorFallback = container.textContent?.toLowerCase().includes("something went wrong");
      expect(errorFallback).toBe(false);
      
      const header = container.querySelector("header.header");
      expect(header).not.toBeNull();

      unmount();
    }
  });

  it("all routes have consistent shell structure", async () => {
    const routes = ["/", "/provision", "/recovery", "/settings", "/docs"];
    
    for (const route of routes) {
      let result: ReturnType<typeof renderRoute>;
      
      await act(async () => {
        result = renderRoute(route);
      });

      const { container, unmount } = result!;
      
      const brand = container.querySelector(".header-brand");
      const nav = container.querySelector("nav.header-nav");
      
      expect(brand).not.toBeNull();
      expect(nav).not.toBeNull();
      
      unmount();
    }
  });
});
