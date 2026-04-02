import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { renderRoute } from "./helpers/render";
import { mockFetch, restoreFetch, jsonResponse } from "./helpers/mock-fetch";

describe("async status harness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    restoreFetch();
    vi.useRealTimers();
  });

  it("SettingsPage shows skeleton rows while loading, then resolves to empty state", async () => {
    let resolveRegistry: (r: Response) => void;
    const registryPromise = new Promise<Response>((resolve) => {
      resolveRegistry = resolve;
    });

    mockFetch({
      "/api/teams/registry": () => registryPromise,
    });

    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/settings");
    });

    const { container, unmount } = result!;

    const skeletons = container.querySelectorAll(".skeleton");
    expect(skeletons.length).toBeGreaterThan(0);

    await act(async () => {
      resolveRegistry!(jsonResponse({ teams: [] }));
      await registryPromise;
    });

    const emptyMsg = container.querySelector(".settings-state-msg");
    expect(emptyMsg).not.toBeNull();
    expect(emptyMsg!.textContent).toContain("No teams registered");

    unmount();
  });

  it("SettingsPage renders team rows after data resolves", async () => {
    const teams = [
      {
        slug: "acme",
        team_name: "Acme Corp",
        team_id: "99999",
        health_status: "healthy",
        org_mode: false,
      },
    ];

    mockFetch({
      "/api/teams/registry": () => jsonResponse({ teams }),
    });

    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/settings");
    });

    const { container, unmount } = result!;

    const rows = container.querySelectorAll(".settings-row");
    expect(rows.length).toBeGreaterThan(0);

    const text = container.textContent || "";
    expect(text).toContain("Acme Corp");
    expect(text).toContain("acme");

    unmount();
  });

  it("CatalogPage shows loading skeleton then empty state when no deployments", async () => {
    mockFetch({
      "/api/deployments": () => jsonResponse({ deployments: [], recoverable_failures: [] }),
      "/api/config": () => jsonResponse({ runtime: null, aws_region: "eu-central-1", github_org: "postman-cs" }),
      "/api/teams/registry": () => jsonResponse({ teams: [] }),
    });

    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/");
    });

    const { container, unmount } = result!;

    const text = container.textContent || "";
    expect(text).toContain("Deployed Services");

    unmount();
  });

  it("CatalogPage renders active deployments even when they are not in the spec registry", async () => {
    mockFetch({
      "/api/deployments": () => jsonResponse({
        deployments: [
          {
            spec_id: "uw7-ecs-0316041211",
            status: "active",
            runtime_mode: "ecs_service",
            github_repo_name: "uw7-ecs-0316041211",
            github_repo_url: "https://github.com/postman-cs/uw7-ecs-0316041211",
            postman_team_slug: "postman",
          },
        ],
        recoverable_failures: [],
      }),
      "/api/config": () => jsonResponse({ runtime: null, aws_region: "eu-central-1", github_org: "postman-cs" }),
      "/api/teams/registry": () => jsonResponse({
        teams: [{ slug: "postman", team_name: "Postman", team_id: "6029" }],
      }),
    });

    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/");
    });

    const { container, unmount } = result!;

    const text = container.textContent || "";
    expect(text).toContain("uw7-ecs-0316041211");
    expect(text).toContain("ecs_service");
    expect(text).not.toContain("No services deployed yet");

    unmount();
  });

  it("CatalogPage excludes non-active deployments (deprovisioned, failed) from Deployed Services", async () => {
    mockFetch({
      "/api/deployments": () => jsonResponse({
        deployments: [
          {
            spec_id: "active-svc",
            status: "active",
            runtime_mode: "lambda",
            github_repo_name: "active-svc",
            postman_team_slug: "postman",
          },
          {
            spec_id: "deprovisioned-svc",
            status: "deprovisioned",
            runtime_mode: "lambda",
            github_repo_name: "deprovisioned-svc",
            postman_team_slug: "postman",
          },
          {
            spec_id: "failed-svc",
            status: "failed",
            runtime_mode: "lambda",
            github_repo_name: "failed-svc",
            postman_team_slug: "postman",
          },
        ],
        recoverable_failures: [],
      }),
      "/api/config": () => jsonResponse({ runtime: null, aws_region: "eu-central-1", github_org: "postman-cs" }),
      "/api/teams/registry": () => jsonResponse({
        teams: [{ slug: "postman", team_name: "Postman", team_id: "6029" }],
      }),
    });

    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/");
    });

    const { container, unmount: unmount2 } = result!;

    const text = container.textContent || "";
    expect(text).toContain("active-svc");
    expect(text).not.toContain("deprovisioned-svc");
    expect(text).not.toContain("failed-svc");

    unmount2();
  });
});
