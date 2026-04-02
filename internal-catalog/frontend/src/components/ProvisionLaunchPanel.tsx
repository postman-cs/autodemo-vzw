import type { TeamRegistryEntry } from "../lib/types";
import { useId, useState, useEffect, type RefObject } from "react";
import { ChaosConfigInput } from "./ChaosConfigInput";
import { DropdownMenu } from "./DropdownMenu";
import { SelectDropdown } from "./SelectDropdown";
import { runtimeLabel, type BatchRunState, type DeploymentMode, type RuntimeMode } from "../lib/types";
import { isWorkspaceSyncControlDisabled } from "../lib/provision-launch";

interface SelectedSpecSummary {
  id: string;
  title: string;
}

interface SystemEnvironment {
  id: string;
  name: string;
  slug: string;
}

interface TeamUserLike {
  id: number;
  name: string;
  email: string;
}

interface OrgMemberLike {
  id: number;
  login: string;
  name: string;
  email: string;
}

type LaunchPanelDataState = "loading" | "ready" | "empty" | "unavailable";

interface ProvisionLaunchPanelProps {
  deploymentMode: DeploymentMode;
  runtimeMode: RuntimeMode;
  batchRun: BatchRunState;
  selectedSpecs: SelectedSpecSummary[];
  graphRootTitle: string | null;
  teams: TeamRegistryEntry[];
  selectedTeamSlug: string;
  onSelectedTeamSlugChange: (slug: string) => void;
  isVerifyingCredentials?: boolean;
  orgTeams?: { id: number; name: string; handle: string }[];
  orgTeamsState?: LaunchPanelDataState;
  selectedWorkspaceTeamId?: number | null;
  onSelectedWorkspaceTeamIdChange?: (id: number | null) => void;
  onRegisterTeamClick?: () => void;
  systemEnvs: SystemEnvironment[];
  systemEnvState: LaunchPanelDataState;
  selectedEnvSlugs: Set<string>;
  onToggleEnvironment: (slug: string) => void;
  isRefreshingEnvironments: boolean;
  onRefreshEnvironments: () => void;
  connectPostman: boolean;
  workspaceSyncDisabledReason?: string | null;
  onConnectPostmanChange: (checked: boolean) => void;
  chaosEnabled: boolean;
  onChaosEnabledChange: (checked: boolean) => void;
  chaosConfig: string;
  onChaosConfigChange: (value: string) => void;
  environmentSyncEnabled: boolean;
  onEnvironmentSyncEnabledChange: (checked: boolean) => void;
  k8sDiscoveryWorkspaceLink: boolean;
  onK8sDiscoveryWorkspaceLinkChange: (checked: boolean) => void;
  workspaceAdmins: {
    users: TeamUserLike[];
    state: LaunchPanelDataState;
    selectedIds: Set<number>;
    dropdownOpen: boolean;
    search: string;
    triggerRef: RefObject<HTMLButtonElement | null>;
    dropdownRef: RefObject<HTMLDivElement | null>;
    menuRef: RefObject<HTMLDivElement | null>;
    searchRef: RefObject<HTMLInputElement | null>;
    onToggleOpen: () => void;
    onSearchChange: (value: string) => void;
    onToggleUser: (userId: number) => void;
  };
  repoAdmins: {
    members: OrgMemberLike[];
    state: LaunchPanelDataState;
    selectedUsernames: Set<string>;
    dropdownOpen: boolean;
    search: string;
    triggerRef: RefObject<HTMLButtonElement | null>;
    dropdownRef: RefObject<HTMLDivElement | null>;
    menuRef: RefObject<HTMLDivElement | null>;
    searchRef: RefObject<HTMLInputElement | null>;
    onToggleOpen: () => void;
    onSearchChange: (value: string) => void;
    onToggleMember: (login: string) => void;
  };
  canClearSelection: boolean;
  canStartProvision: boolean;
  canResetBoard: boolean;
  launchBlockedReason?: string | null;
  onClearSelection: () => void;
  onStartProvision: () => void;
  onResetBoard: () => void;
}

export function ProvisionLaunchPanel({
  deploymentMode,
  runtimeMode,
  batchRun,
  selectedSpecs,
  graphRootTitle,
  teams,
  selectedTeamSlug,
  onSelectedTeamSlugChange,
  isVerifyingCredentials,
  orgTeams,
  orgTeamsState,
  selectedWorkspaceTeamId,
  onSelectedWorkspaceTeamIdChange,
  onRegisterTeamClick,
  systemEnvs,
  systemEnvState,
  selectedEnvSlugs,
  onToggleEnvironment,
  isRefreshingEnvironments,
  onRefreshEnvironments,
  connectPostman,
  workspaceSyncDisabledReason,
  onConnectPostmanChange,
  chaosEnabled,
  onChaosEnabledChange,
  chaosConfig,
  onChaosConfigChange,
  environmentSyncEnabled,
  onEnvironmentSyncEnabledChange,
  k8sDiscoveryWorkspaceLink,
  onK8sDiscoveryWorkspaceLinkChange,
  workspaceAdmins,
  repoAdmins,
  canClearSelection,
  canStartProvision,
  canResetBoard,
  launchBlockedReason,
  onClearSelection,
  onStartProvision,
  onResetBoard,
}: ProvisionLaunchPanelProps) {
  const [deployOpen, setDeployOpen] = useState(true);
  const [accessOpen, setAccessOpen] = useState(false);
  const [featuresOpen, setFeaturesOpen] = useState(false);

  const activeModeLabel = deploymentMode === "graph" ? "Graph" : "Batch";
  const runtimeText = runtimeLabel(runtimeMode);
  const selectionSummary = deploymentMode === "graph"
    ? (graphRootTitle ? `Root service: ${graphRootTitle}` : "1 selected root")
    : `${selectedSpecs.length} service${selectedSpecs.length === 1 ? "" : "s"} selected`;
  const modeHelperText = deploymentMode === "graph"
    ? "These launch settings apply to the root service and all included dependencies."
    : "These launch settings apply to each selected service in this run.";
  const showAccessSection = true;
  const selectedEnvironmentCount = selectedEnvSlugs.size;

  const deployComplete = selectedTeamSlug !== "" && selectedEnvSlugs.size > 0;
  const deployBadge = !selectedTeamSlug ? null : selectedEnvSlugs.size > 0 ? `${selectedEnvSlugs.size} env${selectedEnvSlugs.size === 1 ? "" : "s"}` : "Select environments";
  const accessBadge = workspaceAdmins.selectedIds.size + repoAdmins.selectedUsernames.size > 0
    ? `${workspaceAdmins.selectedIds.size + repoAdmins.selectedUsernames.size} admin${(workspaceAdmins.selectedIds.size + repoAdmins.selectedUsernames.size) === 1 ? "" : "s"}`
    : null;
  const featuresBadge = [connectPostman && "Workspace sync", environmentSyncEnabled && "Env sync", chaosEnabled && "Chaos"].filter(Boolean).join(", ") || null;

  useEffect(() => {
    const team = teams.find(t => t.slug === selectedTeamSlug);
    if (team?.health_status === "healthy") {
      setAccessOpen(true);
    }
  }, [teams, selectedTeamSlug]);

  useEffect(() => {
    if (workspaceAdmins.selectedIds.size > 0 || repoAdmins.selectedUsernames.size > 0) {
      setFeaturesOpen(true);
    }
  }, [workspaceAdmins.selectedIds.size, repoAdmins.selectedUsernames.size]);
  const workspaceAdminPanelId = useId();
  const repoAdminPanelId = useId();
  const teamSelectorLabelId = useId();
  const workspaceTeamSelectorLabelId = useId();
  const environmentSyncNote = systemEnvState === "unavailable"
    ? "System environment data is unavailable, so environment sync will use the fallback prod selection for now."
    : systemEnvState === "empty"
      ? "No system environments are configured yet, so environment sync currently maps only the fallback prod selection."
      : null;
  const filteredWorkspaceUsers = workspaceAdmins.users.filter((user) => {
    if (!workspaceAdmins.search) return true;
    const query = workspaceAdmins.search.toLowerCase();
    return user.name.toLowerCase().includes(query) || user.email.toLowerCase().includes(query);
  });
  const filteredRepoMembers = repoAdmins.members.filter((member) => {
    if (!repoAdmins.search) return true;
    const query = repoAdmins.search.toLowerCase();
    return member.name.toLowerCase().includes(query)
      || member.email.toLowerCase().includes(query)
      || member.login.toLowerCase().includes(query);
  });
  const teamOptions = teams.map((team) => ({
    value: team.slug,
    label: `${team.team_name} (${team.slug})`,
  }));
  const workspaceTeamOptions = (orgTeams ?? []).map((team) => ({
    value: team.id,
    label: `${team.name} (@${team.handle})`,
  }));

  return (
    <div className="provision-confirm">
      <div className="card provision-config-card">
        <div className="provision-config-header">
          <div className="provision-config-title-row">
            <div>
              <h3>Launch configuration</h3>
              <p className="provision-config-subtitle">Review deployment scope, access, and optional launch features before provisioning.</p>
            </div>
            <div className="provision-config-pills">
              <span className="provision-config-pill">{activeModeLabel}</span>
              <span className="provision-config-pill">{runtimeText}</span>
              <span className="provision-config-pill provision-config-pill-emphasis">{selectionSummary}</span>
            </div>
          </div>

          <p className="provision-config-mode-note">{modeHelperText}</p>

          {batchRun.running && (
            <p className="provision-config-status">
              Provision in progress · {batchRun.completed}/{batchRun.total} completed · {batchRun.inFlight} running
            </p>
          )}

          <div className="provision-batch-meta">
            {selectedSpecs.slice(0, 4).map((spec) => <span key={spec.id} className="provision-selected-chip">{spec.title}</span>)}
            {selectedSpecs.length > 4 && <span className="provision-selected-chip">+{selectedSpecs.length - 4} more</span>}
          </div>
        </div>

        <div className="launch-panel-sections">
          <section className="provision-config-section">
            <button type="button" className="provision-disclosure-header" onClick={() => setDeployOpen(prev => !prev)} aria-expanded={deployOpen}>
              <div className="provision-disclosure-header-left">
                <h4 className="provision-config-section-title">Deployment configuration</h4>
                <p className="provision-config-section-desc">Choose environments and runtime-specific launch settings.</p>
              </div>
              <div className="provision-disclosure-header-right">
                {deployBadge && <span className={`provision-disclosure-badge${deployComplete ? " provision-disclosure-badge--complete" : ""}`}>{deployBadge}</span>}
                <span className={`provision-disclosure-chevron${deployOpen ? " provision-disclosure-chevron--open" : ""}`}>▾</span>
              </div>
            </button>
            <div className={`provision-disclosure-body${deployOpen ? " provision-disclosure-body--open" : ""}`}>
              <div className="provision-disclosure-body-inner">
                {teams.length > 0 && (
                  <div className="provision-setting launch-panel-setting-mb">
                    <div className="launch-panel-credential-header">
                      <span id={teamSelectorLabelId} className="provision-checkbox-label">Postman credential</span>
                      <button type="button" className="btn btn-secondary btn-small launch-panel-register-btn" onClick={() => onRegisterTeamClick && onRegisterTeamClick()} disabled={batchRun.running}>
                        + Register Team
                      </button>
                    </div>
                    <SelectDropdown
                      id="team-selector"
                      value={selectedTeamSlug}
                      options={teamOptions}
                      onChange={onSelectedTeamSlugChange}
                      disabled={batchRun.running}
                      labelId={teamSelectorLabelId}
                      placeholder="Select Postman credential"
                      triggerClassName="form-input select-dropdown-trigger launch-panel-select-mt"
                    />
                    <TeamHealthIndicator team={teams.find(t => t.slug === selectedTeamSlug)} isVerifying={isVerifyingCredentials} />
                  </div>
                )}

                {orgTeamsState === "loading" && (
                  <p className="provision-state-note launch-panel-setting-mb">Loading workspace teams…</p>
                )}

                {orgTeamsState === "unavailable" && (
                  <p className="provision-state-alert provision-state-alert-warning launch-panel-setting-mb">Cannot list sub-teams. The API key may lack permissions or the Postman API is unavailable.</p>
                )}

                {orgTeamsState === "empty" && orgTeams && orgTeams.length === 0 && (
                  <p className="provision-state-note launch-panel-setting-mb">No workspace teams found.</p>
                )}

                {orgTeams && orgTeams.length > 0 && (
                  <div className="provision-setting launch-panel-setting-mb">
                    <span id={workspaceTeamSelectorLabelId} className="provision-checkbox-label">Workspace sub-team</span>
                    <p className="launch-panel-subteam-desc">Select the specific squad that will own this workspace.</p>
                    <SelectDropdown
                      id="workspace-team-selector"
                      value={selectedWorkspaceTeamId ?? orgTeams[0]?.id ?? null}
                      options={workspaceTeamOptions}
                      onChange={(nextId) => onSelectedWorkspaceTeamIdChange && onSelectedWorkspaceTeamIdChange(nextId)}
                      disabled={batchRun.running}
                      labelId={workspaceTeamSelectorLabelId}
                      triggerClassName="form-input select-dropdown-trigger launch-panel-select-mt"
                    />
                  </div>
                )}

                {systemEnvState === "loading" && (
                  <p className="provision-state-note">Loading system environments…</p>
                )}

                {systemEnvState === "unavailable" && (
                  <p className="provision-state-alert provision-state-alert-warning">System environments are currently unavailable. Launches will use the default prod fallback until environment data returns.</p>
                )}

                {systemEnvState === "empty" && (
                  <p className="provision-state-note">No system environments are configured yet. Launches will use the default prod fallback.</p>
                )}

                {systemEnvState === "ready" && systemEnvs.length > 0 && (
                  <div className="provision-env-selector">
                    <div className="provision-env-header">
                      <div className="launch-panel-env-label-row">
                        <span className="provision-checkbox-label">System environments</span>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm launch-panel-refresh-btn"
                          onClick={onRefreshEnvironments}
                          disabled={isRefreshingEnvironments || batchRun.running}
                          aria-label="Refresh system environments"
                        >
                          {isRefreshingEnvironments ? "Refreshing..." : "⟳ Refresh"}
                        </button>
                      </div>
                      <span className="provision-env-rule">Keep at least one selected.</span>
                    </div>
                    <div className="provision-env-grid">
                      {systemEnvs.map((systemEnv) => (
                        <button
                          key={systemEnv.id}
                          type="button"
                          className={`provision-env-card${selectedEnvSlugs.has(systemEnv.slug) ? " provision-env-card-selected" : ""}`}
                          aria-pressed={selectedEnvSlugs.has(systemEnv.slug)}
                          onClick={() => onToggleEnvironment(systemEnv.slug)}
                          disabled={batchRun.running || (selectedEnvSlugs.has(systemEnv.slug) && selectedEnvironmentCount === 1)}
                        >
                          <span className="provision-env-card-top">
                            <span className="provision-env-card-name">{systemEnv.name}</span>
                            {selectedEnvSlugs.has(systemEnv.slug) && (
                              <span className={`provision-env-card-badge${selectedEnvironmentCount === 1 ? " provision-env-card-badge-required" : ""}`}>
                                {selectedEnvironmentCount === 1 ? "Required" : "Selected"}
                              </span>
                            )}
                          </span>
                          <span className="provision-env-card-slug">{systemEnv.slug}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {runtimeMode === "k8s_discovery" && (
                  <div className="provision-setting">
                    <label className="provision-checkbox-row provision-setting-row">
                      <input type="checkbox" className="provision-checkbox" checked={k8sDiscoveryWorkspaceLink} onChange={(e) => onK8sDiscoveryWorkspaceLinkChange(e.target.checked)} disabled={batchRun.running} />
                      <span className="provision-setting-body">
                        <span className="provision-setting-title">Create Postman Workspace</span>
                        <span className="provision-setting-desc">Enable to create the Postman workspace flow for discovery-mode services.</span>
                      </span>
                    </label>
                  </div>
                )}
              </div>
            </div>
          </section>

          {showAccessSection && (
            <section className="provision-config-section">
              <button type="button" className="provision-disclosure-header" onClick={() => setAccessOpen(prev => !prev)} aria-expanded={accessOpen}>
                <div className="provision-disclosure-header-left">
                  <h4 className="provision-config-section-title">Access configuration</h4>
                  <p className="provision-config-section-desc">Assign workspace and repository admins for newly provisioned resources.</p>
                </div>
                <div className="provision-disclosure-header-right">
                  {accessBadge && <span className="provision-disclosure-badge provision-disclosure-badge--complete">{accessBadge}</span>}
                  <span className={`provision-disclosure-chevron${accessOpen ? " provision-disclosure-chevron--open" : ""}`}>▾</span>
                </div>
              </button>
              <div className={`provision-disclosure-body${accessOpen ? " provision-disclosure-body--open" : ""}`}>
                <div className="provision-disclosure-body-inner">
                  <div className="provision-admin-stack">
                    {workspaceAdmins.state === "loading" && (
                      <p className="provision-state-note">Loading workspace admins…</p>
                    )}

                    {workspaceAdmins.state === "unavailable" && (
                      <p className="provision-state-alert provision-state-alert-warning">Workspace admin candidates are unavailable right now.</p>
                    )}

                    {workspaceAdmins.state === "empty" && (
                      <p className="provision-state-note">No workspace admins were returned for this team.</p>
                    )}

                    {workspaceAdmins.users.length > 0 && (
                      <div className="provision-admin-block">
                        <h5 className="provision-admin-title">Workspace Admins</h5>
                        <DropdownMenu
                          open={workspaceAdmins.dropdownOpen}
                          onOpenChange={workspaceAdmins.onToggleOpen}
                          panelId={workspaceAdminPanelId}
                          ariaLabel="Workspace admin selector"
                          trigger={
                            <button
                              type="button"
                              className="form-input admin-dropdown-trigger"
                              disabled={batchRun.running}
                              aria-expanded={workspaceAdmins.dropdownOpen}
                              aria-controls={workspaceAdminPanelId}
                              aria-label="Choose workspace admins"
                            >
                              <span>{workspaceAdmins.selectedIds.size === 0 ? "Select users..." : `${workspaceAdmins.selectedIds.size} user${workspaceAdmins.selectedIds.size === 1 ? "" : "s"} selected`}</span>
                              <span className="admin-dropdown-caret">{workspaceAdmins.dropdownOpen ? "▲" : "▼"}</span>
                            </button>
                          }
                        >
                          <input
                            type="text"
                            className="admin-dropdown-search"
                            placeholder="Search users..."
                            aria-label="Search workspace admins"
                            value={workspaceAdmins.search}
                            onChange={(e) => workspaceAdmins.onSearchChange(e.target.value)}
                            onKeyDown={(e) => e.stopPropagation()}
                          />
                          {filteredWorkspaceUsers.length === 0 && (
                            <div className="admin-dropdown-empty">No users match the current search.</div>
                          )}
                          {filteredWorkspaceUsers.map((user) => (
                            <label key={user.id} className="admin-dropdown-item">
                              <input type="checkbox" className="admin-dropdown-checkbox" checked={workspaceAdmins.selectedIds.has(user.id)} onChange={() => workspaceAdmins.onToggleUser(user.id)} />
                              <span className="admin-dropdown-user-info">
                                <strong>{user.name}</strong>
                                <span className="admin-dropdown-user-email">{user.email}</span>
                              </span>
                            </label>
                          ))}
                        </DropdownMenu>
                        {workspaceAdmins.selectedIds.size > 0 && (
                          <div className="admin-dropdown-chips">
                            {workspaceAdmins.users.filter((user) => workspaceAdmins.selectedIds.has(user.id)).map((user) => (
                              <span key={user.id} className="provision-selected-chip">
                                {user.name}
                                <button type="button" className="admin-dropdown-chip-remove" onClick={() => workspaceAdmins.onToggleUser(user.id)} disabled={batchRun.running} aria-label={`Remove ${user.name} from workspace admins`}>
                                  ×<span className="sr-only"> Remove {user.name} from workspace admins</span>
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {repoAdmins.state === "loading" && (
                      <p className="provision-state-note">Loading repository admins…</p>
                    )}

                    {repoAdmins.state === "unavailable" && (
                      <p className="provision-state-alert provision-state-alert-warning">GitHub org members are unavailable right now.</p>
                    )}

                    {repoAdmins.state === "empty" && (
                      <div className="provision-admin-empty-row">
                        <span className="provision-admin-title">Repo Admins</span>
                        <p className="provision-state-note">No repository admin candidates were returned for this org.</p>
                      </div>
                    )}

                    {repoAdmins.members.length > 0 && (
                      <div className="provision-admin-block">
                        <h5 className="provision-admin-title">Repo Admins</h5>
                        <DropdownMenu
                          open={repoAdmins.dropdownOpen}
                          onOpenChange={repoAdmins.onToggleOpen}
                          panelId={repoAdminPanelId}
                          ariaLabel="Repository admin selector"
                          trigger={
                            <button
                              type="button"
                              className="form-input admin-dropdown-trigger"
                              disabled={batchRun.running}
                              aria-expanded={repoAdmins.dropdownOpen}
                              aria-controls={repoAdminPanelId}
                              aria-label="Choose repository admins"
                            >
                              <span>{repoAdmins.selectedUsernames.size === 0 ? "Select members..." : `${repoAdmins.selectedUsernames.size} member${repoAdmins.selectedUsernames.size === 1 ? "" : "s"} selected`}</span>
                              <span className="admin-dropdown-caret">{repoAdmins.dropdownOpen ? "▲" : "▼"}</span>
                            </button>
                          }
                        >
                          <input
                            type="text"
                            className="admin-dropdown-search"
                            placeholder="Search members..."
                            aria-label="Search repository admins"
                            value={repoAdmins.search}
                            onChange={(e) => repoAdmins.onSearchChange(e.target.value)}
                            onKeyDown={(e) => e.stopPropagation()}
                          />
                          {filteredRepoMembers.length === 0 && (
                            <div className="admin-dropdown-empty">No members match the current search.</div>
                          )}
                          {filteredRepoMembers.map((member) => (
                            <label key={member.id} className="admin-dropdown-item">
                              <input type="checkbox" className="admin-dropdown-checkbox" checked={repoAdmins.selectedUsernames.has(member.login)} onChange={() => repoAdmins.onToggleMember(member.login)} />
                              <span className="admin-dropdown-user-info">
                                <strong>{member.name || member.login}</strong>
                                <span className="admin-dropdown-user-email">{member.email || member.login}</span>
                              </span>
                            </label>
                          ))}
                        </DropdownMenu>
                        {repoAdmins.selectedUsernames.size > 0 && (
                          <div className="admin-dropdown-chips">
                            {repoAdmins.members.filter((member) => repoAdmins.selectedUsernames.has(member.login)).map((member) => (
                              <span key={member.login} className="provision-selected-chip">
                                {member.name || member.login}
                                <button type="button" className="admin-dropdown-chip-remove" onClick={() => repoAdmins.onToggleMember(member.login)} disabled={batchRun.running} aria-label={`Remove ${member.name || member.login} from repository admins`}>
                                  ×<span className="sr-only"> Remove {member.name || member.login} from repository admins</span>
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>
          )}

          <section className="provision-config-section provision-config-section-fullwidth">
            <button type="button" className="provision-disclosure-header" onClick={() => setFeaturesOpen(prev => !prev)} aria-expanded={featuresOpen}>
              <div className="provision-disclosure-header-left">
                <h4 className="provision-config-section-title">Optional features</h4>
                <p className="provision-config-section-desc">Enable workspace sync, environment association, and resilience testing options.</p>
              </div>
              <div className="provision-disclosure-header-right">
                {featuresBadge && <span className="provision-disclosure-badge provision-disclosure-badge--complete">{featuresBadge}</span>}
                <span className={`provision-disclosure-chevron${featuresOpen ? " provision-disclosure-chevron--open" : ""}`}>▾</span>
              </div>
            </button>
            <div className={`provision-disclosure-body${featuresOpen ? " provision-disclosure-body--open" : ""}`}>
              <div className="provision-disclosure-body-inner">
                <div className="provision-feature-grid">
                  <div className="provision-setting provision-feature-card">
                    <label className="provision-checkbox-row provision-setting-row">
                      <input
                        type="checkbox"
                        className="provision-checkbox"
                        checked={connectPostman}
                        onChange={(e) => onConnectPostmanChange(e.target.checked)}
                        disabled={isWorkspaceSyncControlDisabled({ batchRunning: batchRun.running, runtimeMode, k8sDiscoveryWorkspaceLink })}
                      />
                      <span className="provision-setting-body">
                        <span className="provision-setting-title">Connect Postman workspace to GitHub</span>
                        <span className="provision-setting-desc">Exports Postman artifacts to the repository and links the workspace to source control.</span>
                      </span>
                    </label>

                    {workspaceSyncDisabledReason && (
                      <p className="provision-inline-note provision-inline-note-warning">{workspaceSyncDisabledReason}</p>
                    )}
                  </div>

                  <div className="provision-setting provision-feature-card">
                    <label className="provision-checkbox-row provision-setting-row">
                      <input type="checkbox" className="provision-checkbox" checked={environmentSyncEnabled} onChange={(e) => onEnvironmentSyncEnabledChange(e.target.checked)} disabled={batchRun.running} />
                      <span className="provision-setting-body">
                        <span className="provision-setting-title">Sync selected system environments</span>
                        <span className="provision-setting-desc">Associates Postman environments with the system environments selected above.</span>
                      </span>
                    </label>

                    {environmentSyncNote && (
                      <p className="provision-inline-note provision-inline-note-warning">{environmentSyncNote}</p>
                    )}
                  </div>

                  <div className={`provision-setting provision-feature-card provision-feature-card-chaos${chaosEnabled ? " provision-feature-card-expanded" : ""}`}>
                    <label className="provision-checkbox-row provision-setting-row">
                      <input type="checkbox" className="provision-checkbox" checked={chaosEnabled} onChange={(e) => onChaosEnabledChange(e.target.checked)} disabled={batchRun.running} />
                      <span className="provision-setting-body">
                        <span className="provision-setting-title">Enable fault injection</span>
                        <span className="provision-setting-desc">Injects latency, errors, or timeouts using environment-tier profiles.</span>
                      </span>
                    </label>

                    <div className={"provision-collapsible" + (chaosEnabled ? " provision-collapsible--open" : "")}>
                      <div className="provision-collapsible-inner">
                        <div className="provision-setting-panel">
                          <ChaosConfigInput value={chaosConfig} onChange={onChaosConfigChange} disabled={batchRun.running} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className="provision-actions-bar">
          <button type="button" className="btn btn-secondary" onClick={onClearSelection} disabled={!canClearSelection}>Clear selected services</button>
          <button
            type="button"
            className={`btn btn-primary${batchRun.running ? " btn-loading" : ""}`}
            onClick={onStartProvision}
            disabled={batchRun.running}
            aria-disabled={!canStartProvision}
            title={!canStartProvision ? (launchBlockedReason || "Provisioning is currently unavailable.") : undefined}
          >
            {batchRun.running ? "Provisioning..." : deploymentMode === "graph" ? `Provision dependency graph${graphRootTitle ? ` (${graphRootTitle})` : ""}` : `Provision selected (${selectedSpecs.length})`}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onResetBoard} disabled={!canResetBoard}>Reset progress board</button>
        </div>

        <p className="provision-actions-note">
          {launchBlockedReason ?? "Execution progress will appear below after launch begins. Clearing selection changes the next launch set; resetting the board only clears local run history."}
        </p>
      </div>
    </div>
  );
}

function TeamHealthIndicator({ team, isVerifying }: { team?: TeamRegistryEntry; isVerifying?: boolean }) {
  if (!team) return null;
  const status = team.health_status || "unchecked";

  if (status === "healthy") {
    const ts = team.health_checked_at ? new Date(team.health_checked_at).toLocaleString() : "";
    return (
      <p className="team-health-msg team-health-msg--healthy">
        Credentials verified{ts ? ` (${ts})` : ""}
      </p>
    );
  }

  if (status === "invalid") {
    return (
      <div className="team-health-alert team-health-alert--invalid">
        <p className="team-health-alert-msg team-health-alert-msg--invalid">
          {team.health_message || "Credential health check failed."}
        </p>
        <a href="/settings" className="team-health-alert-link">
          Fix in Settings
        </a>
      </div>
    );
  }

  if (status === "warning") {
    return (
      <div className="team-health-alert team-health-alert--warning">
        <p className="team-health-alert-msg team-health-alert-msg--warning">
          {team.health_message || "Could not verify credentials."}
        </p>
      </div>
    );
  }

  if (isVerifying) {
    return (
      <p className="team-health-msg team-health-msg--verifying">
        Verifying credentials...
      </p>
    );
  }

  if (team.has_api_key === false || team.has_access_token === false) {
    return (
      <p className="team-health-msg team-health-msg--missing">
        Missing credentials — add API key and access token in <a href="/settings" className="team-health-msg-link">Settings</a>
      </p>
    );
  }

  return (
    <p className="team-health-msg team-health-msg--verifying">
      Verifying credentials...
    </p>
  );
}
