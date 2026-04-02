import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderRoute } from "./helpers/render";
import { mockFetch, restoreFetch, jsonResponse } from "./helpers/mock-fetch";
import { clearThemeState, mockMatchMedia } from "./helpers/theme-mock";

const EMPTY_DEPLOYMENTS = { deployments: [], recoverable_failures: [] };
const EMPTY_CONFIG = { runtime: null, aws_region: "eu-central-1", github_org: "postman-cs", github_org_url: "https://github.com/postman-cs" };
const EMPTY_REGISTRY = { teams: [] };
const EMPTY_USERS = { users: [] };
const EMPTY_SYSTEM_ENVS = { system_envs: [] };
const EMPTY_ORG_MEMBERS = { members: [] };

function setupDefaultMocks(): void {
  mockFetch({
    "/api/deployments": () => jsonResponse(EMPTY_DEPLOYMENTS),
    "/api/config": () => jsonResponse(EMPTY_CONFIG),
    "/api/teams/registry": () => jsonResponse(EMPTY_REGISTRY),
    "/api/users": () => jsonResponse(EMPTY_USERS),
    "/api/system-envs": () => jsonResponse(EMPTY_SYSTEM_ENVS),
    "/api/github/org-members": () => jsonResponse(EMPTY_ORG_MEMBERS),
  });
}

describe("shell navigation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setupDefaultMocks();
    clearThemeState();
  });

  afterEach(() => {
    restoreFetch();
    clearThemeState();
    vi.useRealTimers();
  });

  it("toggles to light mode from a system-dark starting state", async () => {
    mockMatchMedia(true);

    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/");
    });

    const { container, unmount } = result!;
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    const toggle = container.querySelector<HTMLButtonElement>(".theme-toggle");
    expect(toggle).not.toBeNull();

    await act(async () => {
      toggle!.click();
    });

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    const tokensCss = readFileSync(path.resolve(process.cwd(), "frontend/src/styles/tokens.css"), "utf8");
    expect(tokensCss).toContain('html[data-theme="light"]');

    const formsCss = readFileSync(path.resolve(process.cwd(), "frontend/src/styles/forms.css"), "utf8");
    expect(formsCss).toContain(".select-dropdown-trigger {");
    expect(formsCss).toContain(".select-dropdown-trigger-caret {");

    unmount();
  });

  it("renders operations nav links in Services, Provision, Recovery order at root path", async () => {
    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/");
    });

    const { container, unmount } = result!;
    const nav = container.querySelector("nav.header-nav");
    expect(nav).not.toBeNull();

    const operationLinks = Array.from(nav!.children)
      .filter((el) => !el.classList.contains("nav-separator"))
      .slice(0, 3)
      .map((el) => el.textContent?.trim());

    expect(operationLinks).toEqual(["Services", "Provision", "Recovery"]);

    unmount();
  });

  it("renders nav links for Services, Provision, Settings at root path", async () => {
    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/");
    });

    const { container, unmount } = result!;
    const nav = container.querySelector("nav.header-nav");
    expect(nav).not.toBeNull();

    const links = Array.from(nav!.querySelectorAll("a, [href]")).map((el) => el.textContent?.trim());
    expect(links).toContain("Services");
    expect(links).toContain("Provision");
    expect(links).toContain("Settings");

    unmount();
  });

  it("renders a nav separator element between groups", async () => {
    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/");
    });

    const { container, unmount } = result!;
    const nav = container.querySelector("nav.header-nav");
    const separator = nav!.querySelector(".nav-separator");
    expect(separator).not.toBeNull();

    unmount();
  });

  it("marks Services link active at root path", async () => {
    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/");
    });

    const { container, unmount } = result!;
    const nav = container.querySelector("nav.header-nav");
    const activeLinks = Array.from(nav!.querySelectorAll("a.active")).map((el) => el.textContent?.trim());
    expect(activeLinks).toContain("Services");

    unmount();
  });

  it("marks Provision link active at /provision", async () => {
    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/provision");
    });

    const { container, unmount } = result!;
    const nav = container.querySelector("nav.header-nav");
    const activeLinks = Array.from(nav!.querySelectorAll("a.active")).map((el) => el.textContent?.trim());
    expect(activeLinks).toContain("Provision");

    unmount();
  });

  it("marks Settings link active at /settings", async () => {
    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/settings");
    });

    const { container, unmount } = result!;
    const nav = container.querySelector("nav.header-nav");
    const activeLinks = Array.from(nav!.querySelectorAll("a.active")).map((el) => el.textContent?.trim());
    expect(activeLinks).toContain("Settings");

    unmount();
  });

  it("marks Recovery link active at /recovery", async () => {
    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/recovery");
    });

    const { container, unmount } = result!;
    const nav = container.querySelector("nav.header-nav");
    const activeLinks = Array.from(nav!.querySelectorAll("a.active")).map((el) => el.textContent?.trim());
    expect(activeLinks).toContain("Recovery");

    unmount();
  });

  it("marks Docs link active at /docs", async () => {
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

  it("renders RecoveryPage placeholder at /recovery", async () => {
    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/recovery");
    });

    const { container, unmount } = result!;
    const text = container.textContent || "";
    expect(text).toContain("Recovery Queue");

    unmount();
  });

  it("renders DocsPage placeholder at /docs", async () => {
    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/docs");
    });

    const { container, unmount } = result!;
    const text = container.textContent || "";
    expect(text).toContain("Documentation");

    unmount();
  });

  it("renders NotFoundPage at an unknown path", async () => {
    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/nonexistent");
    });

    const { container, unmount } = result!;
    const text = container.textContent || "";
    expect(text).toContain("Page not found");

    unmount();
  });

  it("renders the app shell header brand at all routes", async () => {
    for (const path of ["/", "/provision", "/settings", "/recovery", "/docs"]) {
      let result: ReturnType<typeof renderRoute>;

      await act(async () => {
        result = renderRoute(path);
      });

      const { container, unmount } = result!;
      const brand = container.querySelector(".header-brand");
      expect(brand, `header-brand missing at ${path}`).not.toBeNull();

      unmount();
    }
  });
});
