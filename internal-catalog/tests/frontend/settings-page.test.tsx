import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { SettingsPage } from "../../frontend/src/pages/SettingsPage";
import type { TeamRegistryEntry } from "../../frontend/src/lib/types";
import { installDialogMocks, restoreDialogMocks } from "./helpers/dialog-mock";

const addToastMock = vi.fn();

vi.mock("../../frontend/src/hooks/useToast", () => ({
  useToast: () => ({
    addToast: addToastMock,
    dismissToast: vi.fn(),
    toasts: [],
  }),
}));

const mockOrgModeTeam: TeamRegistryEntry = {
  slug: "acme-corp",
  team_id: "12345",
  team_name: "Acme Corporation",
  system_env_id: "env-123",
  org_mode: true,
  has_api_key: true,
  has_access_token: true,
  health_status: "healthy",
  health_code: "ok",
  health_message: "All credentials valid",
  health_checked_at: "2026-03-14T10:00:00Z",
  provisioning_blocked: false,
};

const mockNonOrgTeam: TeamRegistryEntry = {
  slug: "solo-dev",
  team_id: "54321",
  team_name: "Solo Developer",
  system_env_id: "env-456",
  org_mode: false,
  has_api_key: true,
  has_access_token: true,
  health_status: "healthy",
  health_code: "ok",
  health_message: "All credentials valid",
  health_checked_at: "2026-03-14T10:00:00Z",
  provisioning_blocked: false,
};

const mockOrgModeTeamWithDerivedFields: TeamRegistryEntry & {
  detected_org_mode: boolean;
  workspace_team_count: number;
} = {
  ...mockOrgModeTeam,
  detected_org_mode: true,
  workspace_team_count: 3,
};

const mockNonOrgTeamWithDerivedFields: TeamRegistryEntry & {
  detected_org_mode: boolean;
  workspace_team_count: number;
} = {
  ...mockNonOrgTeam,
  detected_org_mode: false,
  workspace_team_count: 1,
};

const mockRepoFlagResponse = {
  repo_flag: "vzw-partner-demo",
  available_repo_flags: ["vzw-partner-demo"],
  services: [
    {
      id: "vzw-network-operations-api",
      title: "VZW Network Operations API",
      repo_name: "vzw-network-operations-api",
      repo_path: "services/vzw-network-operations-api",
      spec_path: "services/vzw-network-operations-api/openapi/openapi.yaml",
      runtime: "lambda",
      visibility: "internal",
    },
  ],
  derived_specs: [
    {
      id: "vzw-network-operations-api",
      title: "VZW Network Operations API",
      repo_path: "services/vzw-network-operations-api",
      spec_path: "services/vzw-network-operations-api/openapi/openapi.yaml",
    },
  ],
  postman_actions: {
    bootstrap: { type: "github_action", repo: "postman-cs/vzw-partner-demo", path: ".github/actions/postman-bootstrap", label: "Bootstrap API Resources" },
    repo_sync: { type: "github_action", repo: "postman-cs/vzw-partner-demo", path: ".github/actions/postman-repo-sync", label: "Sync Repo to Postman" },
    onboarding: { type: "github_action", repo: "postman-cs/vzw-partner-demo", path: ".github/actions/postman-api-onboarding", label: "Onboard to API Catalog" },
    insights: { type: "github_action", repo: "postman-cs/vzw-partner-demo", path: ".github/actions/postman-insights-onboarding", label: "Onboard to Insights" },
  },
  airtable: {
    configured: true,
    base_id: "appEG4LvnnYklVrDY",
  },
};

function getTeamTable(): HTMLTableElement | null {
  const tables = document.querySelectorAll(".settings-table");
  return (tables[tables.length - 1] as HTMLTableElement | undefined) ?? null;
}

describe("SettingsPage", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockFetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ teams: [] }), { status: 200 }))
    );
    addToastMock.mockReset();
    vi.spyOn(global, "fetch").mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : String(input);

      if (url.includes("/api/repo-flags")) {
        return Promise.resolve(new Response(JSON.stringify(mockRepoFlagResponse), { status: 200 }));
      }

      const fallbackFetch = mockFetch as unknown as typeof fetch;
      return fallbackFetch(input, init);
    }) as typeof fetch);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  describe("derived org mode rendering", () => {
    it("renders repo flag inventory as metadata without a live-status column", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("/api/repo-flags")) {
          return Promise.resolve(new Response(JSON.stringify(mockRepoFlagResponse), { status: 200 }));
        }

        if (url.includes("/api/teams/registry")) {
          return Promise.resolve(new Response(JSON.stringify({ teams: [] }), { status: 200 }));
        }

        return Promise.resolve(new Response(JSON.stringify({ error: `No mock for ${url}` }), { status: 404 }));
      });

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const text = container.textContent || "";
      expect(text).toContain("Repo flag");
      expect(text).toContain("specs available");
      expect(text).toContain("Spec inventory for provisioning");
      expect(text).not.toContain("running");

      const headers = Array.from(container.querySelectorAll(".settings-th")).map((header) => header.textContent);
      expect(headers).toContain("Runtime Target");
      expect(headers).not.toContain("Status");
    });

    it("renders detected org mode when team has detected_org_mode=true", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              teams: [mockOrgModeTeamWithDerivedFields],
            }),
            { status: 200 }
          )
        )
      );

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const table = getTeamTable();
      expect(table?.textContent).toContain("Org");
      expect(table?.textContent).toContain("acme-corp");
      expect(table?.textContent).toContain("Acme Corporation");
    });

    it("renders Single team when team has detected_org_mode=false", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              teams: [mockNonOrgTeamWithDerivedFields],
            }),
            { status: 200 }
          )
        )
      );

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const table = getTeamTable();
      expect(table?.textContent).toContain("Single team");
      expect(table?.textContent).toContain("solo-dev");
    });

    it("renders workspace team count for org mode teams", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              teams: [mockOrgModeTeamWithDerivedFields],
            }),
            { status: 200 }
          )
        )
      );

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const table = getTeamTable();
      expect(table?.textContent).toContain("3 teams");
    });

    it("omits redundant team counts for non-org mode teams", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              teams: [mockNonOrgTeamWithDerivedFields],
            }),
            { status: 200 }
          )
        )
      );

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const modeCell = document.querySelector(".team-mode-cell");
      expect(modeCell?.textContent).toBe("Single team");
    });

    it("does not render a zero-team suffix for single-team rows", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              teams: [
                {
                  ...mockNonOrgTeamWithDerivedFields,
                  workspace_team_count: 0,
                },
              ],
            }),
            { status: 200 }
          )
        )
      );

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const modeCell = document.querySelector(".team-mode-cell");
      expect(modeCell?.textContent).toBe("Single team");
    });

    it("renders org team counts with a readable separator", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              teams: [mockOrgModeTeamWithDerivedFields],
            }),
            { status: 200 }
          )
        )
      );

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const modeCell = document.querySelector(".team-mode-cell");
      expect(modeCell?.textContent).toBe("Org · 3 teams");
    });

    it("uses legacy org_mode field when detected_org_mode is not present", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              teams: [mockOrgModeTeam],
            }),
            { status: 200 }
          )
        )
      );

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const table = getTeamTable();
      expect(table?.textContent).toContain("Yes");
    });
  });

  describe("settings table columns", () => {
    it("renders expected column headers", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              teams: [mockOrgModeTeam],
            }),
            { status: 200 }
          )
        )
      );

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const headers = document.querySelectorAll(".settings-th");
      const headerTexts = Array.from(headers).map((h) => h.textContent);

      expect(headerTexts).toContain("Slug");
      expect(headerTexts).toContain("Team Name");
      expect(headerTexts).toContain("Team ID");
      expect(headerTexts).toContain("Health");
      expect(headerTexts).toContain("Team Mode");
    });

    it("renders team data in correct columns", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              teams: [mockOrgModeTeamWithDerivedFields],
            }),
            { status: 200 }
          )
        )
      );

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const rows = getTeamTable()?.querySelectorAll(".settings-row") || [];
      const firstRow = rows[0];

      expect(firstRow?.textContent).toContain("acme-corp");
      expect(firstRow?.textContent).toContain("Acme Corporation");
      expect(firstRow?.textContent).toContain("12345");
    });
  });

  describe("loading and error states", () => {
    it("shows skeleton loader while fetching teams", async () => {
      mockFetch.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve(
                  new Response(JSON.stringify({ teams: [] }), { status: 200 })
                ),
              100
            )
          )
      );

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      const skeletons = document.querySelectorAll(".skeleton");
      expect(skeletons.length).toBeGreaterThan(0);
    });

    it("shows error banner when fetch fails", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ error: "Server error" }), { status: 500 }))
      );

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const errorBanner = document.querySelector('[role="alert"]');
      expect(errorBanner?.textContent).toContain("HTTP 500");
    });

    it("shows empty state when no teams registered", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ teams: [] }), { status: 200 }))
      );

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const emptyState = document.querySelector(".status-card--empty");
      expect(emptyState?.textContent).toContain("No teams registered");
    });
  });

  describe("health status display", () => {
    it("renders health pill with correct status", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              teams: [
                {
                  ...mockOrgModeTeamWithDerivedFields,
                  health_status: "invalid",
                  health_message: "Invalid credentials",
                },
              ],
            }),
            { status: 200 }
          )
        )
      );

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const healthPill = document.querySelector(".health-pill");
      expect(healthPill?.textContent).toContain("Action Required");
    });

    it("shows health details when row is expanded", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              teams: [
                {
                  ...mockOrgModeTeamWithDerivedFields,
                  health_status: "warning",
                  health_message: "Token expires soon",
                },
              ],
            }),
            { status: 200 }
          )
        )
      );

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const expandablePill = document.querySelector(".health-pill--clickable");
      expect(expandablePill).toBeTruthy();
    });
  });

  describe("edit team modal", () => {
    beforeEach(() => {
      installDialogMocks();
    });

    afterEach(() => {
      restoreDialogMocks();
    });

    it("opens edit modal when Edit button is clicked", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              teams: [mockOrgModeTeam],
            }),
            { status: 200 }
          )
        )
      );

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const editButton = document.querySelector(".settings-edit-btn") as HTMLButtonElement;
      expect(editButton).toBeTruthy();

      await act(async () => {
        editButton.click();
      });

      const dialog = document.querySelector("dialog");
      expect(dialog).toBeTruthy();
      expect(dialog?.hasAttribute("open")).toBe(true);

      const header = document.querySelector(".modal-header-modern");
      expect(header?.textContent).toContain("Edit Team: acme-corp");
    });

    it("renders edit form with team data pre-populated", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              teams: [mockOrgModeTeam],
            }),
            { status: 200 }
          )
        )
      );

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const editButton = document.querySelector(".settings-edit-btn") as HTMLButtonElement;
      await act(async () => {
        editButton.click();
      });

      const teamNameInput = document.querySelector("#edit-team-name") as HTMLInputElement;
      expect(teamNameInput).toBeTruthy();
      expect(teamNameInput.value).toBe("Acme Corporation");

      const accessTokenInput = document.querySelector("#edit-access-token") as HTMLInputElement;
      expect(accessTokenInput).toBeTruthy();
      expect(accessTokenInput.placeholder).toBe("Leave blank to keep current");

      const apiKeyInput = document.querySelector("#edit-api-key") as HTMLInputElement;
      expect(apiKeyInput).toBeTruthy();
      expect(apiKeyInput.placeholder).toBe("Leave blank to keep current");
    });

    it("submits edit form with updated values", async () => {
      const patchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      mockFetch.mockImplementation((url: string, init?: RequestInit) => {
        if (typeof url === "string" && url.includes("/api/teams/registry/acme-corp") && init?.method === "PATCH") {
          return patchMock();
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              teams: [mockOrgModeTeam],
            }),
            { status: 200 }
          )
        );
      });

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const editButton = document.querySelector(".settings-edit-btn") as HTMLButtonElement;
      await act(async () => {
        editButton.click();
      });

      const teamNameInput = document.querySelector("#edit-team-name") as HTMLInputElement;
      await act(async () => {
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        valueSetter?.call(teamNameInput, "Updated Team Name");
        teamNameInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
        teamNameInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      await act(async () => {
        await Promise.resolve();
      });

      const saveButton = document.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(saveButton?.textContent).toContain("Save Changes");

      await act(async () => {
        const form = document.querySelector("#edit-team-form") as HTMLFormElement;
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });

      expect(patchMock).toHaveBeenCalledTimes(1);
      const [, patchInit] = mockFetch.mock.calls.find(
        ([url, init]) => typeof url === "string" && url.includes("/api/teams/registry/acme-corp") && (init as RequestInit | undefined)?.method === "PATCH"
      ) ?? [];
      expect(patchInit).toBeTruthy();
      expect((patchInit as RequestInit).method).toBe("PATCH");
      expect(JSON.parse(String((patchInit as RequestInit).body))).toMatchObject({
        team_name: "Updated Team Name",
      });
    });

    it("closes modal when Cancel button is clicked", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              teams: [mockOrgModeTeam],
            }),
            { status: 200 }
          )
        )
      );

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const editButton = document.querySelector(".settings-edit-btn") as HTMLButtonElement;
      await act(async () => {
        editButton.click();
      });

      let dialog = document.querySelector("dialog");
      expect(dialog?.hasAttribute("open")).toBe(true);

      const cancelButtons = document.querySelectorAll(".modal-footer-modern button");
      const cancelButton = Array.from(cancelButtons).find(
        (btn) => btn.textContent === "Cancel"
      ) as HTMLButtonElement;
      expect(cancelButton).toBeTruthy();

      await act(async () => {
        cancelButton.click();
      });

      dialog = document.querySelector("dialog");
      expect(dialog?.hasAttribute("open")).toBe(false);
    });

    it("displays error banner when edit fails", async () => {
      mockFetch.mockImplementation((url: string, init?: RequestInit) => {
        if (typeof url === "string" && url.includes("/api/teams/registry/acme-corp") && init?.method === "PATCH") {
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: "Invalid access token" }),
              { status: 400 }
            )
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              teams: [mockOrgModeTeam],
            }),
            { status: 200 }
          )
        );
      });

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const editButton = document.querySelector(".settings-edit-btn") as HTMLButtonElement;
      await act(async () => {
        editButton.click();
      });

      const accessTokenInput = document.querySelector("#edit-access-token") as HTMLInputElement;
      await act(async () => {
        accessTokenInput.value = "invalid-token";
        accessTokenInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      await act(async () => {
        const form = document.querySelector("#edit-team-form") as HTMLFormElement;
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const errorBanner = document.querySelector('[role="alert"]');
      expect(errorBanner?.textContent).toContain("Invalid access token");
    });

    it("disables form inputs while saving", async () => {
      mockFetch.mockImplementation((url: string, init?: RequestInit) => {
        if (typeof url === "string" && url.includes("/api/teams/registry/acme-corp") && init?.method === "PATCH") {
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
            }, 100);
          });
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              teams: [mockOrgModeTeam],
            }),
            { status: 200 }
          )
        );
      });

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const editButton = document.querySelector(".settings-edit-btn") as HTMLButtonElement;
      await act(async () => {
        editButton.click();
      });

      const submitPromise = act(async () => {
        const form = document.querySelector("#edit-team-form") as HTMLFormElement;
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const teamNameInput = document.querySelector("#edit-team-name") as HTMLInputElement;
      expect(teamNameInput.disabled).toBe(true);

      const saveButton = document.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(saveButton.disabled).toBe(true);
      expect(saveButton.textContent).toBe("Saving...");

      await submitPromise;
    });

    it("uses Modal compound component with Header, Body, and Footer", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              teams: [mockOrgModeTeam],
            }),
            { status: 200 }
          )
        )
      );

      await act(async () => {
        root.render(
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        );
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const editButton = document.querySelector(".settings-edit-btn") as HTMLButtonElement;
      await act(async () => {
        editButton.click();
      });

      expect(document.querySelector(".modal-header-modern")).toBeTruthy();
      expect(document.querySelector(".modal-body-modern")).toBeTruthy();
      expect(document.querySelector(".modal-footer-modern")).toBeTruthy();

      const header = document.querySelector(".modal-header-modern");
      expect(header?.textContent).toContain("Edit Team: acme-corp");

      const closeButton = document.querySelector(".modal-close");
      expect(closeButton).toBeTruthy();
    });
  });
});
