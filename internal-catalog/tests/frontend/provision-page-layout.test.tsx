import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { renderRoute, waitForElement } from "./helpers/render";
import { clearThemeState } from "./helpers/theme-mock";
import { jsonResponse, mockFetch, restoreFetch } from "./helpers/mock-fetch";

const EMPTY_DEPLOYMENTS = { deployments: [], recoverable_failures: [] };
const EMPTY_CONFIG = { runtime: null, aws_region: "eu-central-1", github_org: "postman-cs", github_org_url: "https://github.com/postman-cs" };
const EMPTY_REGISTRY = { teams: [] };
const EMPTY_USERS = { users: [] };
const EMPTY_SYSTEM_ENVS = { system_environments: [] };
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

describe("provision page layout context", () => {
  beforeEach(() => {
    setupDefaultMocks();
    clearThemeState();
  });

  afterEach(() => {
    restoreFetch();
    clearThemeState();
  });

  it("mounts the provision route with ProvisionLayout outlet context", async () => {
    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/provision");
    });

    const { container, unmount } = result!;
    await waitForElement("[data-provision-shell]", container);

    expect(container.querySelector(".main-header-strip")).not.toBeNull();
    expect(container.querySelector("[data-provision-shell]")).not.toBeNull();

    unmount();
  });
});
