import { useState, useEffect, useCallback, useRef, Fragment, type ChangeEvent, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RegisterTeamModal } from "../components/RegisterTeamModal";
import { ErrorBanner } from "../components/ErrorBanner";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { useToast } from "../hooks/useToast";
import { Modal } from "../components/Modal";
import { PageLayout } from "../components/PageLayout";
import { runtimeLabel, type TeamRegistryEntry, type HealthStatus, type RuntimeMode } from "../lib/types";
import { shouldTriggerRecheck } from "../lib/credential-verify";

interface EditState {
  slug: string;
  team_name: string;
  access_token: string;
  api_key: string;
}

interface RepoFlagService {
  id: string;
  title: string;
  repo_name: string;
  repo_path: string;
  spec_path: string;
  runtime?: RuntimeMode;
  repo_flag?: string;
  visibility?: string;
}

interface RepoFlagResponse {
  repo_flag: string;
  available_repo_flags: string[];
  services: RepoFlagService[];
  derived_specs: Array<{ id: string; title: string; spec_path: string; repo_path: string }>;
  postman_actions: {
    bootstrap: { type: string; repo: string; path: string; label: string };
    repo_sync: { type: string; repo: string; path: string; label: string };
    onboarding: { type: string; repo: string; path: string; label: string };
    insights: { type: string; repo: string; path: string; label: string };
  };
  airtable: {
    configured: boolean;
    base_id: string;
  };
}

const REPO_FLAG_STORAGE_KEY = "vzw-partner-demo-repo-flag";

function readStoredRepoFlag(): string {
  try {
    return window.localStorage?.getItem(REPO_FLAG_STORAGE_KEY) || "vzw-partner-demo";
  } catch {
    return "vzw-partner-demo";
  }
}

function persistRepoFlag(repoFlag: string): void {
  try {
    window.localStorage?.setItem(REPO_FLAG_STORAGE_KEY, repoFlag);
  } catch {
    // Ignore storage writes when localStorage is unavailable.
  }
}

export function SettingsPage() {
  const { addToast } = useToast();
  const [teams, setTeams] = useState<TeamRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [registerOpen, setRegisterOpen] = useState(false);
  const [editTeam, setEditTeam] = useState<EditState | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [deleteSlug, setDeleteSlug] = useState<string | null>(null);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const [recheckingSlug, setRecheckingSlug] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [repoFlag, setRepoFlag] = useState(readStoredRepoFlag);
  const [repoFlagState, setRepoFlagState] = useState<RepoFlagResponse | null>(null);
  const [repoFlagLoading, setRepoFlagLoading] = useState(true);
  const recheckTriggeredRef = useRef(false);

  const loadRepoFlagState = useCallback(async (targetFlag: string) => {
    try {
      setRepoFlagLoading(true);
      const resp = await fetch(`/api/repo-flags?repo_flag=${encodeURIComponent(targetFlag)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as RepoFlagResponse;
      setRepoFlagState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRepoFlagLoading(false);
    }
  }, []);

  const loadTeams = useCallback(async () => {
    try {
      setLoading(true);
      const resp = await fetch("/api/teams/registry");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as { teams?: TeamRegistryEntry[] };
      setTeams(Array.isArray(data.teams) ? data.teams as TeamRegistryEntry[] : []);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  useEffect(() => {
    void loadRepoFlagState(repoFlag);
  }, [loadRepoFlagState, repoFlag]);

  useEffect(() => {
    if (loading || teams.length === 0 || recheckTriggeredRef.current) return;
    const toCheck = teams.filter(shouldTriggerRecheck);
    if (toCheck.length === 0) return;

    recheckTriggeredRef.current = true;
    Promise.all(
      toCheck.map((t) =>
        fetch(`/api/teams/registry/${encodeURIComponent(t.slug)}/health/recheck`, { method: "POST" }),
      ),
    ).finally(() => void loadTeams());
  }, [loading, teams, loadTeams]);

  const handleRegisterSuccess = useCallback((slug: string) => {
    setRegisterOpen(false);
    void loadTeams();
    void slug;
  }, [loadTeams]);

  const openEditModal = (team: TeamRegistryEntry) => {
    setEditTeam({
      slug: team.slug,
      team_name: team.team_name,
      access_token: "",
      api_key: "",
    });
    setEditError("");
  };

  const handleEditSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editTeam) return;
    setEditSaving(true);
    setEditError("");

    try {
      const payload: Record<string, unknown> = {};
      if (editTeam.team_name.trim()) payload.team_name = editTeam.team_name.trim();
      if (editTeam.access_token.trim()) payload.access_token = editTeam.access_token.trim();
      if (editTeam.api_key.trim()) payload.api_key = editTeam.api_key.trim();

      const resp = await fetch(`/api/teams/registry/${encodeURIComponent(editTeam.slug)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error((errData as { error?: string }).error || `HTTP ${resp.status}`);
      }

      setEditTeam(null);
      void loadTeams();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditSaving(false);
    }
  };

  const requestDelete = async (slug: string) => {
    try {
      const resp = await fetch("/api/deployments");
      if (resp.ok) {
        const data = await resp.json() as { deployments?: Array<{ postman_team_slug?: string; status?: string }>; recoverable_failures?: Array<{ postman_team_slug?: string }> };
        const active = (data.deployments || []).filter((d) => d.status === "active" && d.postman_team_slug === slug);
        const recoverable = (data.recoverable_failures || []).filter((f) => f.postman_team_slug === slug);
        const total = active.length + recoverable.length;
        if (total > 0) {
          addToast(
            `Cannot remove "${slug}" — ${active.length} deployed service${active.length !== 1 ? "s" : ""} and ${recoverable.length} recovery item${recoverable.length !== 1 ? "s" : ""} still reference this team. Tear down all services first.`,
            { type: "warning", duration: 8000 },
          );
          return;
        }
      }
    } catch {
      // If we can't check, allow the delete attempt — the backend will reject if needed
    }
    setDeleteSlug(slug);
  };

  const handleDelete = async () => {
    if (!deleteSlug) return;
    try {
      const resp = await fetch(`/api/teams/registry/${encodeURIComponent(deleteSlug)}`, {
        method: "DELETE",
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setDeleteSlug(null);
      void loadTeams();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleteSlug(null);
    }
  };

  const handleRecheck = async (slug: string) => {
    setRecheckingSlug(slug);
    try {
      const resp = await fetch(`/api/teams/registry/${encodeURIComponent(slug)}/health/recheck`, {
        method: "POST",
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      void loadTeams();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRecheckingSlug(null);
    }
  };

  const handleReconcile = async () => {
    setReconciling(true);
    try {
      const resp = await fetch("/api/teams/registry/reconcile", { method: "POST" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      void loadTeams();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReconciling(false);
    }
  };

  const healthCounts = teams.reduce<Record<string, number>>((acc, t) => {
    const status = t.health_status || "unchecked";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const repoFlagServices = repoFlagState?.services || [];
  const flaggedRepoCount = new Set(repoFlagServices.map((service) => service.repo_path)).size;

  return (
    <PageLayout
      title="Team Credentials"
      headerActions={
        <button type="button" className="btn btn-primary" onClick={() => setRegisterOpen(true)}>
          + Register Team
        </button>
      }
      showBreadcrumbs={false}
    >

      {repoFlagLoading ? <Skeleton variant="rect" height="80px" /> : repoFlagState ? (
        <div className="settings-summary-bar">
          <span>Repo flag: <span className="mono settings-mono">{repoFlagState.repo_flag}</span></span>
          <span>{repoFlagState.services.length} specs available</span>
          <span>{repoFlagState.airtable.configured ? `Airtable: ${repoFlagState.airtable.base_id}` : "Airtable not configured"}</span>
        </div>
      ) : null}

      <div className="card settings-card">
        <div className="settings-card-desc">
          <p>Spec inventory for provisioning. These are not deployed services. To launch them, use the <Link className="settings-inline-link" to="/provision">Provision</Link> page.</p>
        </div>
        {repoFlagLoading ? <Skeleton variant="rect" height="120px" /> : repoFlagState ? (
          <div className="settings-table-wrap animate-fade-in-up">
            <table className="settings-table">
              <thead>
                <tr>
                  <th className="settings-th">Service</th>
                  <th className="settings-th">Spec Path</th>
                  <th className="settings-th settings-th--right">Runtime Target</th>
                </tr>
              </thead>
              <tbody>
                {repoFlagState.services.map((service: RepoFlagService) => (
                  <tr key={service.id} className="settings-row">
                    <td className="settings-td">{service.title}</td>
                    <td className="settings-td"><span className="mono settings-mono">{service.spec_path}</span></td>
                    <td className="settings-td settings-td--right">{service.runtime || "lambda"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}

      {!loading && teams.length > 0 && (
        <div className="settings-summary-bar">
          <span>{teams.length} team{teams.length !== 1 ? "s" : ""}</span>
          {(healthCounts.healthy ?? 0) > 0 && <span className="settings-summary-healthy">{healthCounts.healthy} healthy</span>}
          {(healthCounts.invalid ?? 0) > 0 && <span className="settings-summary-invalid">{healthCounts.invalid} action required</span>}
          {(healthCounts.warning ?? 0) > 0 && <span className="settings-summary-warning">{healthCounts.warning} warning</span>}
          {(healthCounts.unchecked ?? 0) > 0 && <span>{healthCounts.unchecked} unchecked</span>}
          {(healthCounts.stale ?? 0) > 0 && <span>{healthCounts.stale} stale</span>}
          <button
            type="button"
            className="btn btn-secondary btn-small settings-sync-btn"
            onClick={() => void handleReconcile()}
            disabled={reconciling}
          >
            {reconciling ? "Syncing..." : "Sync Credentials"}
          </button>
        </div>
      )}

      <div className="card settings-card">
        <div className="settings-card-desc">
          <p>
            Manage Postman API keys and access tokens for each provisioning team. Teams with missing or invalid credentials are removed automatically.
          </p>
        </div>

        {loading ? (
          <div className="settings-table-wrap">
            <table className="settings-table">
              <thead><tr>
                <th className="settings-th"><Skeleton variant="text" width="60px" /></th>
                <th className="settings-th"><Skeleton variant="text" width="80px" /></th>
                <th className="settings-th"><Skeleton variant="text" width="60px" /></th>
                <th className="settings-th settings-th--center"><Skeleton variant="text" width="50px" /></th>
                <th className="settings-th settings-th--center"><Skeleton variant="text" width="50px" /></th>
                <th className="settings-th settings-th--right"><Skeleton variant="text" width="70px" /></th>
              </tr></thead>
              <tbody>
                {[0, 1, 2].map(i => (
                  <tr key={i} className="settings-row">
                    <td className="settings-td"><Skeleton variant="text" width="100px" /></td>
                    <td className="settings-td"><Skeleton variant="text" width="120px" /></td>
                    <td className="settings-td"><Skeleton variant="text" width="80px" /></td>
                    <td className="settings-td settings-td--center"><Skeleton variant="rect" width="80px" height="24px" /></td>
                    <td className="settings-td settings-td--center"><Skeleton variant="text" width="30px" /></td>
                    <td className="settings-td settings-td--right"><Skeleton variant="rect" width="110px" height="28px" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : teams.length === 0 ? (
          <div className="settings-state-msg">
            <EmptyState
              title="No teams registered"
              description="Register a team to manage Postman API credentials for provisioning."
              action={{ label: "+ Register Team", onClick: () => setRegisterOpen(true) }}
            />
          </div>
        ) : (
          <div className="settings-table-wrap animate-fade-in-up">
            <table className="settings-table">
              <thead>
                <tr>
                  <th className="settings-th">Slug</th>
                  <th className="settings-th">Team Name</th>
                  <th className="settings-th">Team ID</th>
                  <th className="settings-th settings-th--center">Health</th>
                  <th className="settings-th settings-th--center">Team Mode</th>
                  <th className="settings-th settings-th--right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {teams.map((team) => {
                  const isExpanded = expandedSlug === team.slug;
                  const showExpandable = team.health_status === "invalid" || team.health_status === "warning";
                  return (
                    <Fragment key={team.slug}>
                      <tr className={isExpanded ? "settings-row--expanded" : "settings-row"}>
                        <td className="settings-td"><span className="mono settings-mono">{team.slug}</span></td>
                        <td className="settings-td">{team.team_name}</td>
                        <td className="settings-td"><span className="mono settings-mono">{team.team_id}</span></td>
                        <td className="settings-td settings-td--center">
                          <HealthPill
                            status={team.health_status}
                            expandable={showExpandable}
                            expanded={isExpanded}
                            onClick={showExpandable ? () => setExpandedSlug(isExpanded ? null : team.slug) : undefined}
                          />
                        </td>
                        <td className="settings-td settings-td--center">
                          <TeamModeCell team={team} />
                        </td>
                        <td className="settings-td settings-td--right">
                          <button type="button" className="btn btn-secondary btn-small settings-edit-btn" onClick={() => openEditModal(team)}>
                            Edit
                          </button>
                          <button type="button" className="btn btn-danger btn-small" onClick={() => void requestDelete(team.slug)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="settings-row">
                          <td colSpan={6} className="settings-detail-td settings-detail-td--expanded">
                            <HealthDetailRow
                              team={team}
                              rechecking={recheckingSlug === team.slug}
                              onRecheck={() => void handleRecheck(team.slug)}
                              onEdit={() => openEditModal(team)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {registerOpen && (
        <RegisterTeamModal
          onClose={() => setRegisterOpen(false)}
          onSuccess={handleRegisterSuccess}
        />
      )}

      {editTeam && (
        <Modal
          open={true}
          onClose={editSaving ? () => {} : () => setEditTeam(null)}
          className="settings-edit-modal-panel"
        >
          <Modal.Header title={`Edit Team: ${editTeam.slug}`} />
          <Modal.Body>
            {editError && <ErrorBanner message={editError} onDismiss={() => setEditError("")} />}
            <form onSubmit={handleEditSubmit} id="edit-team-form">
              <div className="settings-form-field">
                <label className="settings-form-label" htmlFor="edit-team-name">Team Name</label>
                <input
                  id="edit-team-name"
                  type="text"
                  className="form-input"
                  value={editTeam.team_name}
                  onChange={(e) => setEditTeam({ ...editTeam, team_name: e.target.value })}
                  disabled={editSaving}
                />
              </div>
              <div className="settings-form-field">
                <label className="settings-form-label" htmlFor="edit-access-token">Access Token</label>
                <input
                  id="edit-access-token"
                  type="password"
                  className="form-input"
                  placeholder="Leave blank to keep current"
                  value={editTeam.access_token}
                  onChange={(e) => setEditTeam({ ...editTeam, access_token: e.target.value })}
                  disabled={editSaving}
                />
                <p className="settings-field-hint">
                  New tokens are validated against Bifrost before saving.
                </p>
              </div>
              <div className="settings-form-field">
                <label className="settings-form-label" htmlFor="edit-api-key">API Key</label>
                <input
                  id="edit-api-key"
                  type="password"
                  className="form-input"
                  placeholder="Leave blank to keep current"
                  value={editTeam.api_key}
                  onChange={(e) => setEditTeam({ ...editTeam, api_key: e.target.value })}
                  disabled={editSaving}
                />
              </div>
            </form>
          </Modal.Body>
          <Modal.Footer>
            <button type="button" className="btn btn-secondary" onClick={() => setEditTeam(null)} disabled={editSaving}>Cancel</button>
            <button type="submit" form="edit-team-form" className="btn btn-primary" disabled={editSaving}>
              {editSaving ? "Saving..." : "Save Changes"}
            </button>
          </Modal.Footer>
        </Modal>
      )}

      <ConfirmDialog
        open={!!deleteSlug}
        title="Delete Team"
        description={`Are you sure you want to delete the team "${deleteSlug}"? This will remove all stored credentials from both KV and AWS Secrets Manager.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteSlug(null)}
      />
    </PageLayout>
  );
}

const HEALTH_PILL_CLASSES: Record<HealthStatus, string> = {
  healthy: "health-pill--healthy",
  warning: "health-pill--warning",
  invalid: "health-pill--invalid",
  stale: "health-pill--stale",
  unchecked: "health-pill--unchecked",
};

const HEALTH_PILL_LABELS: Record<HealthStatus, string> = {
  healthy: "Healthy",
  warning: "Warning",
  invalid: "Action Required",
  stale: "Stale",
  unchecked: "Pending",
};

function HealthPill({ status, expandable, expanded, onClick }: {
  status?: HealthStatus;
  expandable?: boolean;
  expanded?: boolean;
  onClick?: () => void;
}) {
  const s = status || "unchecked";
  const modifierClass = HEALTH_PILL_CLASSES[s];
  const label = HEALTH_PILL_LABELS[s];
  const pillClass = `health-pill ${modifierClass} ${expandable ? "health-pill--clickable" : "health-pill--static"}`;
  if (expandable) {
    return (
      <button type="button" className={pillClass} onClick={onClick}>
        <span className="health-pill-dot" aria-hidden="true" />
        {label}
        <span className="health-pill-arrow">{expanded ? "\u25B2" : "\u25BC"}</span>
      </button>
    );
  }
  return (
    <span className={pillClass}>
      <span className="health-pill-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function TeamModeCell({ team }: { team: TeamRegistryEntry }) {
  if (team.detected_org_mode !== undefined) {
    const modeLabel = team.detected_org_mode ? "Org" : "Single team";
    const teamCount = typeof team.workspace_team_count === "number" && team.workspace_team_count > 0
      ? team.workspace_team_count
      : undefined;
    const countLabel = team.detected_org_mode && teamCount
      ? `${teamCount} team${teamCount === 1 ? "" : "s"}`
      : null;

    return (
      <span className="team-mode-cell">
        <span className="team-mode-label">{modeLabel}</span>
        {countLabel ? <span className="team-mode-separator" aria-hidden="true"> {"·"} </span> : null}
        {countLabel ? <span className="team-mode-count">{countLabel}</span> : null}
      </span>
    );
  }

  return <span>{team.org_mode ? "Yes" : "No"}</span>;
}

function HealthDetailRow({ team, rechecking, onRecheck, onEdit }: {
  team: TeamRegistryEntry;
  rechecking: boolean;
  onRecheck: () => void;
  onEdit: () => void;
}) {
  const checkedAt = team.health_checked_at
    ? new Date(team.health_checked_at).toLocaleString()
    : "never";

  const borderClass = team.health_status === "invalid" ? "health-detail--invalid" : "health-detail--warning";

  return (
    <div
      className={`health-detail ${borderClass}`}
    >
      <p className="health-detail-message">
        {team.health_message || "No details available."}
      </p>
      <div className="health-detail-actions">
        <span className="health-detail-checked">Last checked: {checkedAt}</span>
        <button
          type="button"
          className="btn btn-secondary btn-small health-detail-btn"
          onClick={onRecheck}
          disabled={rechecking}
        >
          {rechecking ? "Rechecking..." : "Recheck Now"}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-small health-detail-btn"
          onClick={onEdit}
        >
          Edit Credentials
        </button>
      </div>
    </div>
  );
}
