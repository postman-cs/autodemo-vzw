import { afterEach, beforeEach, describe, expect, it } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { CatalogTeamFilter } from "../../frontend/src/components/CatalogTeamFilter";
import { ProvisionLaunchPanel } from "../../frontend/src/components/ProvisionLaunchPanel";
import { SpecSelector } from "../../frontend/src/components/SpecSelector";
import type { TeamRegistryEntry } from "../../frontend/src/lib/types";

const teams: TeamRegistryEntry[] = [
  {
    slug: "field-services",
    team_id: "13347347",
    team_name: "Field Services v12 Demo",
    system_env_id: "env-1",
    org_mode: false,
    has_api_key: true,
    has_access_token: true,
    health_status: "healthy",
    health_code: "ok",
    health_message: "Ready",
    health_checked_at: "2026-03-15T00:00:00Z",
    provisioning_blocked: false,
  },
  {
    slug: "platform",
    team_id: "42",
    team_name: "Platform",
    system_env_id: "env-2",
    org_mode: false,
    has_api_key: true,
    has_access_token: true,
    health_status: "healthy",
    health_code: "ok",
    health_message: "Ready",
    health_checked_at: "2026-03-15T00:00:00Z",
    provisioning_blocked: false,
  },
];

describe("dropdown migration contract", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders CatalogTeamFilter as a custom dropdown trigger instead of a native select", () => {
    act(() => {
      root.render(
        <CatalogTeamFilter
          teams={teams}
          selectedTeamSlug="field-services"
          onChange={() => {}}
        />,
      );
    });

    expect(container.querySelector("select")).toBeNull();
    const trigger = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Field Services v12 Demo"),
    );
    expect(trigger).toBeTruthy();
  });

  it("renders SpecSelector domain filter as a custom dropdown trigger instead of a native select", () => {
    act(() => {
      root.render(
        <SpecSelector
          industry="banking"
          deployedSpecIds={new Set()}
          selectedIds={new Set()}
          onToggleSelect={() => {}}
          onSelectVisible={() => {}}
          onClearSelection={() => {}}
        />,
      );
    });

    expect(container.querySelector("select.spec-domain-filter")).toBeNull();
    const trigger = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("All domains"),
    );
    expect(trigger).toBeTruthy();
  });

  it("renders ProvisionLaunchPanel credential selectors as custom dropdown triggers instead of native selects", () => {
    act(() => {
      root.render(
        <ProvisionLaunchPanel
          deploymentMode="single"
          runtimeMode="lambda"
          batchRun={{ running: false, total: 0, completed: 0, success: 0, failed: 0, queued: 0, inFlight: 0 }}
          selectedSpecs={[{ id: "payments-api", title: "Payments API" }]}
          graphRootTitle={null}
          teams={teams}
          selectedTeamSlug="field-services"
          onSelectedTeamSlugChange={() => {}}
          isVerifyingCredentials={false}
          orgTeams={[{ id: 7, name: "Field Services v12 Demo", handle: "field-services" }]}
          orgTeamsState="ready"
          selectedWorkspaceTeamId={7}
          onSelectedWorkspaceTeamIdChange={() => {}}
          onRegisterTeamClick={() => {}}
          systemEnvs={[]}
          systemEnvState="empty"
          selectedEnvSlugs={new Set(["prod"])}
          onToggleEnvironment={() => {}}
          isRefreshingEnvironments={false}
          onRefreshEnvironments={() => {}}
          connectPostman={true}
          workspaceSyncDisabledReason={null}
          onConnectPostmanChange={() => {}}
          chaosEnabled={false}
          onChaosEnabledChange={() => {}}
          chaosConfig=""
          onChaosConfigChange={() => {}}
          environmentSyncEnabled={false}
          onEnvironmentSyncEnabledChange={() => {}}
          k8sDiscoveryWorkspaceLink={false}
          onK8sDiscoveryWorkspaceLinkChange={() => {}}
          workspaceAdmins={{
            users: [],
            state: "empty",
            selectedIds: new Set(),
            dropdownOpen: false,
            search: "",
            triggerRef: React.createRef<HTMLButtonElement>(),
            dropdownRef: React.createRef<HTMLDivElement>(),
            menuRef: React.createRef<HTMLDivElement>(),
            searchRef: React.createRef<HTMLInputElement>(),
            onToggleOpen: () => {},
            onSearchChange: () => {},
            onToggleUser: () => {},
          }}
          repoAdmins={{
            members: [],
            state: "empty",
            selectedUsernames: new Set(),
            dropdownOpen: false,
            search: "",
            triggerRef: React.createRef<HTMLButtonElement>(),
            dropdownRef: React.createRef<HTMLDivElement>(),
            menuRef: React.createRef<HTMLDivElement>(),
            searchRef: React.createRef<HTMLInputElement>(),
            onToggleOpen: () => {},
            onSearchChange: () => {},
            onToggleMember: () => {},
          }}
          canClearSelection={true}
          canStartProvision={true}
          canResetBoard={true}
          launchBlockedReason={null}
          onClearSelection={() => {}}
          onStartProvision={() => {}}
          onResetBoard={() => {}}
        />,
      );
    });

    const selects = Array.from(container.querySelectorAll("select"));
    expect(selects).toHaveLength(0);

    const credentialTrigger = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Field Services v12 Demo (field-services)"),
    );
    expect(credentialTrigger).toBeTruthy();

    const workspaceTeamTrigger = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Field Services v12 Demo (@field-services)"),
    );
    expect(workspaceTeamTrigger).toBeTruthy();
  });
});
