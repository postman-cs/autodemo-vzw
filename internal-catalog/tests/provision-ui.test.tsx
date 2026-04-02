import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { CatalogTeamFilter } from "../frontend/src/components/CatalogTeamFilter";
import { ChaosConfigModal } from "../frontend/src/components/ChaosConfigModal";
import { ProvisionLayout } from "../frontend/src/components/ProvisionLayout";
import { ProvisionLaunchPanel } from "../frontend/src/components/ProvisionLaunchPanel";
import { ProvisionPage } from "../frontend/src/pages/ProvisionPage";
import { SpecSelector } from "../frontend/src/components/SpecSelector";
import {
  buildLaunchRequestBody,
  deriveSelectedEnvList,
  isWorkspaceSyncControlDisabled,
} from "../frontend/src/lib/provision-launch";

describe("provision ui", () => {
  const spec = {
    id: "payments-api",
    title: "Payments API",
    description: "",
    industry: "financial",
    domain: "payments",
    filename: "payments.yaml",
    repo_name: "af-payments-api",
    endpoints: 12,
  };

  it("renders single-selection graph mode controls in the spec selector", () => {
    const html = renderToStaticMarkup(
      <SpecSelector
        industry="telecom"
        deployedSpecIds={new Set()}
        selectedIds={new Set(["vzw-network-operations-api"])}
        onToggleSelect={() => {}}
        onSelectVisible={() => {}}
        onClearSelection={() => {}}
        selectionMode="single"
      />,
    );

    expect(html).toContain("Root service");
    expect(html).toContain("Select visible");
    expect(html).toContain("disabled");
    expect(html).not.toContain('type="checkbox"');
  });

  it("renders multi-selection controls outside graph mode", () => {
    const html = renderToStaticMarkup(
      <SpecSelector
        industry="telecom"
        deployedSpecIds={new Set()}
        selectedIds={new Set(["vzw-network-operations-api"])}
        onToggleSelect={() => {}}
        onSelectVisible={() => {}}
        onClearSelection={() => {}}
        selectionMode="multi"
      />,
    );

    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('name="graph-root-spec"');
    expect(html).toContain("1 selected");
  });

  it("renders the catalog team filter with catalog-specific classes", () => {
    const html = renderToStaticMarkup(
      <CatalogTeamFilter
        teams={[
          { slug: "field-services-v12-demo", team_id: "13347347", team_name: "Field Services v12 Demo" },
          { slug: "vzw-partner-demo", team_id: "999", team_name: "SE Catalog Demo" },
        ]}
        selectedTeamSlug=""
        onChange={() => {}}
      />,
    );

    expect(html).toContain("Postman Team");
    expect(html).toContain("catalog-header-filter");
    expect(html).toContain("catalog-header-filter-select");
    expect(html).not.toContain("provision-setting");
    expect(html).not.toContain("provision-checkbox-label");
  });

  it("keeps deployment mode controls interactive even when lambda is the active runtime", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/provision"]}>
        <Routes>
          <Route path="/provision" element={<ProvisionLayout />}>
            <Route index element={<ProvisionPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(html).toContain('name="deployment_mode"');
    expect(html).toContain('value="single"');
    expect(html).toContain('value="graph"');
    expect(html).toMatch(/<input[^>]*name="deployment_mode"[^>]*value="graph"(?![^>]*disabled)/);
  });

  it("defaults selected environments to prod and sorts explicit selections", () => {
    expect(deriveSelectedEnvList(new Set())).toEqual(["prod"]);
    expect(deriveSelectedEnvList(new Set(["stage", "prod"]))).toEqual(["prod", "stage"]);
  });

  it("matches the current workspace sync disable rule", () => {
    expect(isWorkspaceSyncControlDisabled({
      batchRunning: false,
      runtimeMode: "lambda",
      k8sDiscoveryWorkspaceLink: false,
    })).toBe(false);

    expect(isWorkspaceSyncControlDisabled({
      batchRunning: false,
      runtimeMode: "k8s_discovery",
      k8sDiscoveryWorkspaceLink: false,
    })).toBe(true);

    expect(isWorkspaceSyncControlDisabled({
      batchRunning: false,
      runtimeMode: "k8s_discovery",
      k8sDiscoveryWorkspaceLink: true,
    })).toBe(false);

    expect(isWorkspaceSyncControlDisabled({
      batchRunning: true,
      runtimeMode: "k8s_workspace",
      k8sDiscoveryWorkspaceLink: true,
    })).toBe(true);
  });

  it("builds the launch payload with workspace team selection for org mode", () => {
    const body = buildLaunchRequestBody({
      spec,
      runtimeMode: "k8s_workspace",
      deploymentMode: "single",
      selectedEnvSlugs: new Set(["prod"]),
      connectPostman: true,
      environmentSyncEnabled: false,
      chaosEnabled: false,
      chaosConfig: "",
      selectedAdminIds: new Set(),
      selectedRepoAdminUsernames: new Set(),
      k8sDiscoveryWorkspaceLink: false,
      teamSlug: "vzw-partner-demo",
      workspaceTeamId: 999,
      workspaceTeamName: "Engineering",
    });

    expect(body).toEqual({
      project_name: "af-payments-api",
      domain: "payments",
      requester_email: "admin@postman.com",
      environments: ["prod"],
      spec_source: "payments-api",
      runtime: "k8s_workspace",
      deployment_mode: "single",
      github_workspace_sync: true,
      environment_sync_enabled: false,
      chaos_enabled: false,
      connect_git: true,
      workspace_admin_ids: undefined,
      repo_admin_usernames: undefined,
      k8s_discovery_workspace_link: undefined,
      postman_team_slug: "vzw-partner-demo",
      workspace_team_id: 999,
      workspace_team_name: "Engineering",
    });
  });

  it("drops workspace_team_id when null (non-org-mode account)", () => {
    const body = buildLaunchRequestBody({
      spec,
      runtimeMode: "lambda",
      deploymentMode: "single",
      selectedEnvSlugs: new Set(["prod"]),
      connectPostman: true,
      environmentSyncEnabled: false,
      chaosEnabled: false,
      chaosConfig: "",
      selectedAdminIds: new Set(),
      selectedRepoAdminUsernames: new Set(),
      k8sDiscoveryWorkspaceLink: false,
      teamSlug: "vzw-partner-demo",
      workspaceTeamId: null,
      workspaceTeamName: null,
    });

    expect(body.workspace_team_id).toBeUndefined();
    expect(body.workspace_team_name).toBeUndefined();
  });

  it("drops workspace_team_id when zero (invalid coercion guard)", () => {
    const body = buildLaunchRequestBody({
      spec,
      runtimeMode: "lambda",
      deploymentMode: "single",
      selectedEnvSlugs: new Set(["prod"]),
      connectPostman: true,
      environmentSyncEnabled: false,
      chaosEnabled: false,
      chaosConfig: "",
      selectedAdminIds: new Set(),
      selectedRepoAdminUsernames: new Set(),
      k8sDiscoveryWorkspaceLink: false,
      teamSlug: "vzw-partner-demo",
      workspaceTeamId: 0,
      workspaceTeamName: "Stale Name",
    });

    expect(body.workspace_team_id).toBeUndefined();
    expect(body.workspace_team_name).toBeUndefined();
  });

  it("renders org-mode sub-team dropdown and blocks launch without selection", () => {
    const orgTeams = [
      { id: 132109, name: "Field Services v12 Demo", handle: "field-services-v12-demo" },
      { id: 132118, name: "Customer Education v12", handle: "customer-education-v12" },
    ];

    const html = renderToStaticMarkup(
      <ProvisionLaunchPanel
        deploymentMode="single"
        runtimeMode="lambda"
        batchRun={{ running: false, total: 0, completed: 0, success: 0, failed: 0, queued: 0, inFlight: 0 }}
        selectedSpecs={[{ id: "payments-api", title: "Payments API" }]}
        graphRootTitle={null}
        teams={[{ slug: "field-services-v12-demo", team_id: "13347347", team_name: "Field Services v12 Demo" }]}
        selectedTeamSlug="field-services-v12-demo"
        onSelectedTeamSlugChange={() => {}}
        orgTeams={orgTeams}
        orgTeamsState="ready"
        selectedWorkspaceTeamId={132109}
        onSelectedWorkspaceTeamIdChange={() => {}}
        systemEnvs={[]}
        systemEnvState="empty"
        selectedEnvSlugs={new Set(["prod"])}
        onToggleEnvironment={() => {}}
        connectPostman={true}
        workspaceSyncDisabledReason={null}
        onConnectPostmanChange={() => {}}
        chaosEnabled={false}
        onChaosEnabledChange={() => {}}
        chaosConfig=""
        onChaosConfigChange={() => {}}
        environmentSyncEnabled={true}
        onEnvironmentSyncEnabledChange={() => {}}
        k8sDiscoveryWorkspaceLink={false}
        onK8sDiscoveryWorkspaceLinkChange={() => {}}
        workspaceAdmins={{ users: [], state: "empty", selectedIds: new Set(), dropdownOpen: false, search: "", triggerRef: React.createRef<HTMLButtonElement>(), dropdownRef: React.createRef<HTMLDivElement>(), menuRef: React.createRef<HTMLDivElement>(), searchRef: React.createRef<HTMLInputElement>(), onToggleOpen: () => {}, onSearchChange: () => {}, onToggleUser: () => {} }}
        repoAdmins={{ members: [], state: "empty", selectedUsernames: new Set(), dropdownOpen: false, search: "", triggerRef: React.createRef<HTMLButtonElement>(), dropdownRef: React.createRef<HTMLDivElement>(), menuRef: React.createRef<HTMLDivElement>(), searchRef: React.createRef<HTMLInputElement>(), onToggleOpen: () => {}, onSearchChange: () => {}, onToggleMember: () => {} }}
        canClearSelection={true}
        canStartProvision={true}
        canResetBoard={false}
        launchBlockedReason={null}
        onClearSelection={() => {}}
        onStartProvision={() => {}}
        onResetBoard={() => {}}
        isRefreshingEnvironments={false}
        onRefreshEnvironments={() => {}}
      />,
    );

    expect(html).toContain("Workspace sub-team");
    expect(html).toContain("Select the specific squad that will own this workspace.");
    expect(html).toContain("Field Services v12 Demo (@field-services-v12-demo)");
    
  });

  it("shows unavailable message when org teams cannot be loaded", () => {
    const html = renderToStaticMarkup(
      <ProvisionLaunchPanel
        deploymentMode="single"
        runtimeMode="lambda"
        batchRun={{ running: false, total: 0, completed: 0, success: 0, failed: 0, queued: 0, inFlight: 0 }}
        selectedSpecs={[{ id: "payments-api", title: "Payments API" }]}
        graphRootTitle={null}
        teams={[{ slug: "field-services-v12-demo", team_id: "13347347", team_name: "Field Services v12 Demo" }]}
        selectedTeamSlug="field-services-v12-demo"
        onSelectedTeamSlugChange={() => {}}
        orgTeams={[]}
        orgTeamsState="unavailable"
        selectedWorkspaceTeamId={null}
        onSelectedWorkspaceTeamIdChange={() => {}}
        systemEnvs={[]}
        systemEnvState="empty"
        selectedEnvSlugs={new Set(["prod"])}
        onToggleEnvironment={() => {}}
        connectPostman={true}
        workspaceSyncDisabledReason={null}
        onConnectPostmanChange={() => {}}
        chaosEnabled={false}
        onChaosEnabledChange={() => {}}
        chaosConfig=""
        onChaosConfigChange={() => {}}
        environmentSyncEnabled={true}
        onEnvironmentSyncEnabledChange={() => {}}
        k8sDiscoveryWorkspaceLink={false}
        onK8sDiscoveryWorkspaceLinkChange={() => {}}
        workspaceAdmins={{ users: [], state: "empty", selectedIds: new Set(), dropdownOpen: false, search: "", triggerRef: React.createRef<HTMLButtonElement>(), dropdownRef: React.createRef<HTMLDivElement>(), menuRef: React.createRef<HTMLDivElement>(), searchRef: React.createRef<HTMLInputElement>(), onToggleOpen: () => {}, onSearchChange: () => {}, onToggleUser: () => {} }}
        repoAdmins={{ members: [], state: "empty", selectedUsernames: new Set(), dropdownOpen: false, search: "", triggerRef: React.createRef<HTMLButtonElement>(), dropdownRef: React.createRef<HTMLDivElement>(), menuRef: React.createRef<HTMLDivElement>(), searchRef: React.createRef<HTMLInputElement>(), onToggleOpen: () => {}, onSearchChange: () => {}, onToggleMember: () => {} }}
        canClearSelection={true}
        canStartProvision={false}
        canResetBoard={false}
        launchBlockedReason="This is an org-mode account. Select a workspace sub-team before launching."
        onClearSelection={() => {}}
        onStartProvision={() => {}}
        onResetBoard={() => {}}
        isRefreshingEnvironments={false}
        onRefreshEnvironments={() => {}}
      />,
    );

    expect(html).toContain("Cannot list sub-teams");
    expect(html).toContain("org-mode account");
  });

  it("builds the current discovery-mode launch payload with workspace sync forced off until linking is enabled", () => {
    const body = buildLaunchRequestBody({
      spec,
      runtimeMode: "k8s_discovery",
      deploymentMode: "single",
      selectedEnvSlugs: new Set(["stage", "prod"]),
      connectPostman: true,
      environmentSyncEnabled: true,
      chaosEnabled: true,
      chaosConfig: "",
      selectedAdminIds: new Set([101, 202]),
      selectedRepoAdminUsernames: new Set(["octocat"]),
      k8sDiscoveryWorkspaceLink: false,
      teamSlug: "field-services-v12-demo",
    });

    expect(body).toEqual({
      project_name: "af-payments-api",
      domain: "payments",
      requester_email: "admin@postman.com",
      environments: ["prod", "stage"],
      spec_source: "payments-api",
      runtime: "k8s_discovery",
      deployment_mode: "single",
      github_workspace_sync: false,
      environment_sync_enabled: true,
      chaos_enabled: true,
      connect_git: false,
      workspace_admin_ids: ["101", "202"],
      repo_admin_usernames: ["octocat"],
      k8s_discovery_workspace_link: false,
      postman_team_slug: "field-services-v12-demo",
    });
  });

  it("builds the current graph launch payload with chaos config and linked workspace settings preserved", () => {
    const body = buildLaunchRequestBody({
      spec,
      runtimeMode: "k8s_workspace",
      deploymentMode: "graph",
      selectedEnvSlugs: new Set(["prod"]),
      connectPostman: true,
      environmentSyncEnabled: false,
      chaosEnabled: true,
      chaosConfig: '{"prod":{"fault_type":"latency","fault_rate":0.2}}',
      selectedAdminIds: new Set(),
      selectedRepoAdminUsernames: new Set(),
      k8sDiscoveryWorkspaceLink: true,
      teamSlug: "vzw-partner-demo",
    });

    expect(body).toEqual({
      project_name: "af-payments-api",
      domain: "payments",
      requester_email: "admin@postman.com",
      environments: ["prod"],
      spec_source: "payments-api",
      runtime: "k8s_workspace",
      deployment_mode: "graph",
      github_workspace_sync: true,
      environment_sync_enabled: false,
      chaos_enabled: true,
      chaos_config: '{"prod":{"fault_type":"latency","fault_rate":0.2}}',
      connect_git: true,
      workspace_admin_ids: undefined,
      repo_admin_usernames: undefined,
      k8s_discovery_workspace_link: undefined,
      postman_team_slug: "vzw-partner-demo",
    });
  });

  it("renders launch panel warnings, blocked-state guidance, and accessible admin controls", () => {
    const html = renderToStaticMarkup(
      <ProvisionLaunchPanel
        deploymentMode="graph"
        runtimeMode="k8s_discovery"
        batchRun={{ running: false, total: 0, completed: 0, success: 0, failed: 0, queued: 0, inFlight: 0 }}
        selectedSpecs={[{ id: "payments-api", title: "Payments API" }]}
        graphRootTitle="Payments API"
        teams={[{ slug: "field-services-v12-demo", team_id: "13347347", team_name: "Field Services v12 Demo" }]}
        selectedTeamSlug="field-services-v12-demo"
        onSelectedTeamSlugChange={() => {}}
        systemEnvs={[{ id: "prod", name: "Production", slug: "prod" }]}
        systemEnvState="unavailable"
        isRefreshingEnvironments={false}
        selectedEnvSlugs={new Set(["prod"])}
        onToggleEnvironment={() => {}}
        onRefreshEnvironments={() => {}}
        connectPostman={false}
        workspaceSyncDisabledReason={'Enable "Create Postman Workspace" to turn on GitHub workspace sync for discovery mode.'}
        onConnectPostmanChange={() => {}}
        chaosEnabled={true}
        onChaosEnabledChange={() => {}}
        chaosConfig='{"prod":{"fault_type":"latency","fault_rate":0.2}}'
        onChaosConfigChange={() => {}}
        environmentSyncEnabled={true}
        onEnvironmentSyncEnabledChange={() => {}}
        k8sDiscoveryWorkspaceLink={false}
        onK8sDiscoveryWorkspaceLinkChange={() => {}}
        workspaceAdmins={{
          users: [{ id: 1, name: "Alice Example", email: "alice@example.com" }],
          state: "ready",
          selectedIds: new Set([1]),
          dropdownOpen: true,
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
          members: [{ id: 2, login: "octocat", name: "The Octocat", email: "octo@example.com" }],
          state: "ready",
          selectedUsernames: new Set(["octocat"]),
          dropdownOpen: true,
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
        canStartProvision={false}
        canResetBoard={true}
        launchBlockedReason="Resolve blocked dependency prerequisites before launching graph mode."
        onClearSelection={() => {}}
        onStartProvision={() => {}}
        onResetBoard={() => {}}
      />,
    );

    expect(html).toContain("Enable &quot;Create Postman Workspace&quot; to turn on GitHub workspace sync for discovery mode.");
    expect(html).toContain("System environment data is unavailable, so environment sync will use the fallback prod selection for now.");
    expect(html).toContain("Resolve blocked dependency prerequisites before launching graph mode.");
    expect(html).toContain("Field Services v12 Demo (field-services-v12-demo)");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('title="Resolve blocked dependency prerequisites before launching graph mode."');
    expect(html).toContain('aria-label="Choose workspace admins"');
    expect(html).toContain('aria-label="Remove Alice Example from workspace admins"');
    expect(html).toContain('aria-label="Choose repository admins"');
    expect(html).toContain('aria-label="Remove The Octocat from repository admins"');
  });

  it("renders launch panel loading and empty-state feedback for supporting data", () => {
    const html = renderToStaticMarkup(
      <ProvisionLaunchPanel
        deploymentMode="single"
        runtimeMode="lambda"
        batchRun={{ running: false, total: 0, completed: 0, success: 0, failed: 0, queued: 0, inFlight: 0 }}
        selectedSpecs={[{ id: "payments-api", title: "Payments API" }]}
        graphRootTitle={null}
        teams={[]}
        selectedTeamSlug=""
        onSelectedTeamSlugChange={() => {}}
        systemEnvs={[]}
        systemEnvState="loading"
        isRefreshingEnvironments={false}
        selectedEnvSlugs={new Set(["prod"])}
        onToggleEnvironment={() => {}}
        onRefreshEnvironments={() => {}}
        connectPostman={true}
        workspaceSyncDisabledReason={null}
        onConnectPostmanChange={() => {}}
        chaosEnabled={false}
        onChaosEnabledChange={() => {}}
        chaosConfig=""
        onChaosConfigChange={() => {}}
        environmentSyncEnabled={true}
        onEnvironmentSyncEnabledChange={() => {}}
        k8sDiscoveryWorkspaceLink={true}
        onK8sDiscoveryWorkspaceLinkChange={() => {}}
        workspaceAdmins={{
          users: [],
          state: "loading",
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
        canResetBoard={false}
        launchBlockedReason={null}
        onClearSelection={() => {}}
        onStartProvision={() => {}}
        onResetBoard={() => {}}
      />,
    );

    expect(html).toContain("Loading system environments…");
    expect(html).toContain("Loading workspace admins…");
    expect(html).toContain("No repository admin candidates were returned for this org.");
  });

  it("renders the chaos modal with dialog semantics and production guidance", () => {
    const html = renderToStaticMarkup(
      <ChaosConfigModal
        initialConfig='{"prod":{"error_rate":0,"status_code":503,"latency_rate":0.01,"latency_ms":2000,"timeout_rate":0}}'
        onSave={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Configure fault injection profiles");
    expect(html).toContain("Adjust fault injection settings per environment tier.");
    expect(html).toContain("Production defaults are intentionally conservative. Validate fault rates before saving a production profile.");
    expect(html).toContain('role="tablist"');
  });
});
