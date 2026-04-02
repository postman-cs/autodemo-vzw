import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import registry from "../../../specs/registry.json";
import { CatalogTeamFilter } from "../components/CatalogTeamFilter";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Modal } from "../components/Modal";
import { OverflowMenuIcon } from "../components/OverflowMenuIcon";
import { SelectionCountBadge } from "../components/SelectionCountBadge";
import { Skeleton } from "../components/Skeleton";
import { HeaderDangerXIcon } from "../components/HeaderDangerXIcon";
import { TeardownStepTracker } from "../components/TeardownStepTracker";
import { PageLayout } from "../components/PageLayout";
import { useMenuKeyboard } from "../hooks/useMenuKeyboard";
import {
  matchesCatalogTeam,
  normalizeCatalogTeamSlug,
} from "../lib/catalog-team-filter";
import {
  recoveryReasonClass,
  recoveryReasonLabel,
  toRecoveryQueueEntries,
  transitionRecoveryItemState,
  type RecoveryItemRunState,
} from "../lib/recovery-queue";
import {
  phaseToIndex,
  type TeardownProgress,
} from "../lib/teardown-progress";
import {
  toCount,
  type BatchFailure,
  type BatchSummary,
  type BatchRunState,
  type TeamRegistryEntry,
  type RegistryEntry,
  type DeploymentsResponse,
  type TeamsRegistryResponse,
} from "../lib/types";
import {
  type TeardownEvent,
  readBatchTeardownStream,
} from "../lib/sse-stream";

interface RecoverableFailure {
  spec_id: string;
  status: "failed";
  reason: string;
  project_name: string;
  postman_team_slug?: string;
  error_message?: string;
  failed_at_step?: string;
  deployed_at?: string;
}

interface BatchTeardownRequestItem {
  spec_id: string;
  project_name: string;
}

const REGISTRY = registry as RegistryEntry[];

async function loadOptionalJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function RecoveryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [recoverableFailures, setRecoverableFailures] = useState<RecoverableFailure[]>([]);
  const [teams, setTeams] = useState<TeamRegistryEntry[]>([]);
  const [teamRegistryLoaded, setTeamRegistryLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");
  const [recoveryError, setRecoveryError] = useState("");
  const [openBulkMenu, setOpenBulkMenu] = useState<"recovery" | null>(null);
  const [selectedRecoverySpecIds, setSelectedRecoverySpecIds] = useState<Set<string>>(new Set());
  const [recoveryItemRunState, setRecoveryItemRunState] = useState<Record<string, RecoveryItemRunState>>({});
  const [recoveryItemErrors, setRecoveryItemErrors] = useState<Record<string, string>>({});
  const [recoveryItemProgress, setRecoveryItemProgress] = useState<Record<string, TeardownProgress>>({});
  const [recoveryBatchRun, setRecoveryBatchRun] = useState<BatchRunState>({
    running: false,
    total: 0,
    completed: 0,
    success: 0,
    failed: 0,
    queued: 0,
    inFlight: 0,
  });
  const [recoveryBatchSummary, setRecoveryBatchSummary] = useState<BatchSummary | null>(null);

  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    description: string;
    onConfirm: () => void;
  } | null>(null);

  const [credPrompt, setCredPrompt] = useState<{
    teamSlug: string;
    failedSpecIds: string[];
  } | null>(null);
  const [credApiKey, setCredApiKey] = useState("");
  const [credValidating, setCredValidating] = useState(false);
  const [credError, setCredError] = useState("");
  const [credSuccess, setCredSuccess] = useState(false);
  const credPromptShownRef = useRef(false);

  const selectAllRecoveryRef = useRef<HTMLInputElement | null>(null);
  const bulkMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const rawSelectedTeamSlug = searchParams.get("team") || "";
  const selectedTeamSlug = useMemo(
    () => (teamRegistryLoaded ? normalizeCatalogTeamSlug(rawSelectedTeamSlug, teams) : ""),
    [rawSelectedTeamSlug, teamRegistryLoaded, teams],
  );

  const loadPageData = useCallback(async () => {
    try {
      setFetchError("");
      const [depData, teamsData] = await Promise.all([
        fetch("/api/deployments").then((r) => r.json() as Promise<DeploymentsResponse>),
        loadOptionalJson("/api/teams/registry"),
      ]);
      setRecoverableFailures((depData.recoverable_failures || []) as RecoverableFailure[]);
      const teamsRegistry = teamsData as TeamsRegistryResponse | null;
      setTeams(Array.isArray(teamsRegistry?.teams) ? teamsRegistry.teams as TeamRegistryEntry[] : []);
    } catch (err) {
      console.error(err);
      setFetchError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setTeamRegistryLoaded(true);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = "Recovery Queue | API Catalog Admin";
  }, []);

  useEffect(() => {
    void loadPageData();
  }, [loadPageData]);

  useEffect(() => {
    if (!teamRegistryLoaded) return;
    if ((rawSelectedTeamSlug || "") === selectedTeamSlug) return;
    const next = new URLSearchParams(searchParams);
    if (selectedTeamSlug) next.set("team", selectedTeamSlug);
    else next.delete("team");
    setSearchParams(next, { replace: true });
  }, [rawSelectedTeamSlug, searchParams, selectedTeamSlug, setSearchParams, teamRegistryLoaded]);

  const handleSelectedTeamSlugChange = useCallback((nextTeamSlug: string) => {
    setOpenBulkMenu(null);
    const next = new URLSearchParams(searchParams);
    if (nextTeamSlug) next.set("team", nextTeamSlug);
    else next.delete("team");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-bulk-menu]")) return;
      setOpenBulkMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenBulkMenu(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useMenuKeyboard(openBulkMenu !== null);

  const prevOpenBulkMenu = useRef<"recovery" | null>(null);
  useEffect(() => {
    const prev = prevOpenBulkMenu.current;
    prevOpenBulkMenu.current = openBulkMenu;

    if (openBulkMenu) {
      requestAnimationFrame(() => {
        const trigger = bulkMenuTriggerRef.current;
        const menu = trigger?.parentElement?.querySelector<HTMLElement>('[role="menu"]');
        const first = menu?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)');
        first?.focus();
      });
    } else if (prev) {
      bulkMenuTriggerRef.current?.focus();
    }
  }, [openBulkMenu]);

  const recoverableEntries = useMemo(
    () => toRecoveryQueueEntries(recoverableFailures, REGISTRY)
      .filter((entry) => matchesCatalogTeam(selectedTeamSlug, entry.postman_team_slug)),
    [recoverableFailures, selectedTeamSlug],
  );

  const recoverableBySpecId = useMemo(() => {
    return new Map(recoverableEntries.map((entry) => [entry.spec_id, entry]));
  }, [recoverableEntries]);

  useEffect(() => {
    setSelectedRecoverySpecIds((prev) => {
      const allowed = new Set(recoverableEntries.map((entry) => entry.spec_id));
      const next = new Set<string>();
      for (const id of prev) {
        if (allowed.has(id)) next.add(id);
      }
      if (next.size === prev.size) return prev;
      return next;
    });
  }, [recoverableEntries]);

  useEffect(() => {
    if (!selectAllRecoveryRef.current) return;
    const someSelected = selectedRecoverySpecIds.size > 0 && selectedRecoverySpecIds.size < recoverableEntries.length;
    selectAllRecoveryRef.current.indeterminate = someSelected;
  }, [selectedRecoverySpecIds.size, recoverableEntries.length]);

  const recoverySelectionDisabled = recoveryBatchRun.running;
  const allRecoverySelected = recoverableEntries.length > 0 && selectedRecoverySpecIds.size === recoverableEntries.length;
  const recoveryHasBulkContext = selectedRecoverySpecIds.size > 0 || recoveryBatchRun.running;

  const toggleAllRecoverySelection = () => {
    if (recoverySelectionDisabled) return;
    setOpenBulkMenu(null);
    if (allRecoverySelected) {
      setSelectedRecoverySpecIds(new Set());
      return;
    }
    setSelectedRecoverySpecIds(new Set(recoverableEntries.map((entry) => entry.spec_id)));
  };

  const runBatchRecovery = async (specIds: string[], overrideCreds?: { api_key: string }) => {
    if (!specIds.length || recoveryBatchRun.running) return;
    credPromptShownRef.current = false;
    const unknownTeamSpecIds: string[] = [];

    setRecoveryError("");
    setRecoveryBatchSummary(null);
    setOpenBulkMenu(null);
    setRecoveryItemProgress((prev) => {
      const next = { ...prev };
      for (const id of specIds) {
        delete next[id];
      }
      return next;
    });
    setRecoveryItemErrors((prev) => {
      const next = { ...prev };
      for (const id of specIds) {
        delete next[id];
      }
      return next;
    });

    const titleBySpecId = new Map<string, string>();
    for (const id of specIds) {
      titleBySpecId.set(id, recoverableBySpecId.get(id)?.title || id);
    }

    const failureBySpecId = new Map<string, BatchFailure>();
    const recordFailure = (specId: string, message: string) => {
      const title = titleBySpecId.get(specId) || specId;
      failureBySpecId.set(specId, { specId, title, message });
      setRecoveryItemRunState((prev) => ({
        ...prev,
        [specId]: transitionRecoveryItemState(prev[specId] || "idle", "fail"),
      }));
      setRecoveryItemErrors((prev) => ({ ...prev, [specId]: message }));
    };

    const items: BatchTeardownRequestItem[] = [];
    const specIdByProject = new Map<string, string>();
    for (const specId of specIds) {
      const failure = recoverableBySpecId.get(specId);
      if (!failure) {
        recordFailure(specId, "Recoverable failure record not found");
        continue;
      }
      const projectName = (failure.project_name || "").trim();
      if (!projectName) {
        recordFailure(specId, "Missing project name for teardown recovery.");
        continue;
      }
      const item: BatchTeardownRequestItem & { override_api_key?: string } = {
        spec_id: specId,
        project_name: projectName,
      };
      if (overrideCreds?.api_key) {
        item.override_api_key = overrideCreds.api_key;
      }
      items.push(item);
      specIdByProject.set(projectName, specId);
    }

    setRecoveryItemRunState((prev) => {
      const next = { ...prev };
      for (const id of specIds) {
        next[id] = failureBySpecId.has(id)
          ? transitionRecoveryItemState(next[id] || "idle", "fail")
          : transitionRecoveryItemState(next[id] || "idle", "start");
      }
      return next;
    });

    setRecoveryBatchRun({
      running: true,
      total: specIds.length,
      completed: failureBySpecId.size,
      success: 0,
      failed: failureBySpecId.size,
      queued: 0,
      inFlight: 0,
    });

    if (items.length > 0) {
      try {
        const response = await fetch("/api/teardown/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items }),
        });

        const completeData = await readBatchTeardownStream(response, (event: TeardownEvent) => {
          if (event.project === "__batch__" && event.phase === "progress") {
            const data = event.data || {};
            setRecoveryBatchRun({
              running: true,
              total: specIds.length,
              completed: failureBySpecId.size + toCount(data.completed),
              success: toCount(data.success),
              failed: failureBySpecId.size + toCount(data.failed),
              queued: 0,
              inFlight: 0,
            });
            return;
          }

          if (!event.project || event.project === "__batch__") return;
          const specId = event.spec_id || specIdByProject.get(event.project);
          if (!specId) return;

          if (event.status === "running" && event.message) {
            setRecoveryItemProgress((prev) => ({
              ...prev,
              [specId]: { stepIndex: phaseToIndex(event.phase || ""), message: event.message! },
            }));
          }

          if (event.status === "error") {
            setRecoveryItemProgress((prev) => { const next = { ...prev }; delete next[specId]; return next; });
            const msg = event.message || "Teardown recovery failed";
            recordFailure(specId, msg);

            const unknownMatch = /Unknown team slug '([^']+)'/.exec(msg);
            if (unknownMatch && !credPromptShownRef.current) {
              credPromptShownRef.current = true;
              unknownTeamSpecIds.push(specId);
              setCredPrompt({ teamSlug: unknownMatch[1], failedSpecIds: [] });
              setCredApiKey("");
              setCredError("");
              setCredSuccess(false);
            } else if (unknownMatch) {
              unknownTeamSpecIds.push(specId);
            }
            return;
          }
          if (event.phase === "complete" && event.status === "complete") {
            setRecoveryItemProgress((prev) => { const next = { ...prev }; delete next[specId]; return next; });
            setRecoveryItemRunState((prev) => ({
              ...prev,
              [specId]: transitionRecoveryItemState(prev[specId] || "idle", "succeed"),
            }));
          }
        });

        for (const result of completeData.results) {
          const projectName = (result.project_name || "").trim();
          const specId = (result.spec_id || "").trim() || (projectName ? specIdByProject.get(projectName) : undefined);
          if (!specId) continue;

          if (result.success) {
            failureBySpecId.delete(specId);
            setRecoveryItemRunState((prev) => ({
              ...prev,
              [specId]: transitionRecoveryItemState(prev[specId] || "idle", "succeed"),
            }));
          } else {
            recordFailure(specId, result.error || "Teardown recovery failed");
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Teardown recovery failed";
        for (const item of items) {
          if (!failureBySpecId.has(item.spec_id)) {
            recordFailure(item.spec_id, message);
          }
        }
      }
    }

    await loadPageData();
    const failures = Array.from(failureBySpecId.values());
    const successCount = Math.max(0, specIds.length - failures.length);
    setRecoveryBatchRun({
      running: false,
      total: specIds.length,
      completed: specIds.length,
      success: successCount,
      failed: failures.length,
      queued: 0,
      inFlight: 0,
    });

    const summary: BatchSummary = {
      total: specIds.length,
      success: successCount,
      failed: failures.length,
      failures,
    };
    setRecoveryBatchSummary(summary);

    if (failures.length > 0) {
      if (unknownTeamSpecIds.length > 0) {
        setCredPrompt((prev) => prev ? { ...prev, failedSpecIds: [...unknownTeamSpecIds] } : prev);
      }
      setRecoveryError("Some recovery teardowns failed. Review the summary and retry failed services.");
      setSelectedRecoverySpecIds(new Set(failures.map((failure) => failure.specId)));
      return;
    }

    setSelectedRecoverySpecIds(new Set());
  };

  const handleSingleRecovery = (specId: string) => {
    if (recoveryBatchRun.running) return;
    setOpenBulkMenu(null);
    const failure = recoverableBySpecId.get(specId);
    if (!failure) {
      setRecoveryError("Recoverable failure record not found.");
      return;
    }
    const projectName = (failure.project_name || "").trim();
    if (!projectName) {
      setRecoveryError("Missing project name for teardown recovery.");
      return;
    }
    setConfirmAction({
      title: `Run teardown recovery for ${projectName}?`,
      description: "This removes GitHub, Postman, and AWS artifacts tied to this service name.",
      onConfirm: () => {
        setConfirmAction(null);
        void runBatchRecovery([specId]);
      },
    });
  };

  const handleBatchRecovery = () => {
    if (recoveryBatchRun.running || selectedRecoverySpecIds.size === 0) return;
    const count = selectedRecoverySpecIds.size;
    setConfirmAction({
      title: `Run teardown recovery for ${count} selected service${count === 1 ? "" : "s"}?`,
      description: "This removes GitHub, Postman, and AWS artifacts for each selected service name.",
      onConfirm: () => {
        setConfirmAction(null);
        void runBatchRecovery(Array.from(selectedRecoverySpecIds));
      },
    });
  };

  const handleCredRetry = async () => {
    if (!credPrompt || !credApiKey.trim()) return;
    setCredValidating(true);
    setCredError("");

    try {
      const resp = await fetch("/api/validate-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: credApiKey.trim() }),
      });
      const data = await resp.json() as { valid: boolean; slug?: string; team_name?: string };
      if (!data.valid) {
        setCredError("Invalid API key. Please check and try again.");
        setCredValidating(false);
        return;
      }

      setCredValidating(false);
      setCredSuccess(true);

      const retryIds = [...credPrompt.failedSpecIds];
      const key = credApiKey.trim();

      await new Promise((r) => setTimeout(r, 1200));
      setCredPrompt(null);
      setCredApiKey("");
      setCredSuccess(false);

      if (retryIds.length > 0) {
        void runBatchRecovery(retryIds, { api_key: key });
      }
    } catch {
      setCredError("Failed to validate key. Check your connection and try again.");
      setCredValidating(false);
    }
  };

  return (
    <PageLayout
      title="Recovery Queue"
      subtitle={
        <span>
          {loading
            ? <Skeleton variant="text" width="180px" />
            : recoverableEntries.length === 0
              ? "No recoverable provisioning failures detected."
              : `${recoverableEntries.length} service${recoverableEntries.length !== 1 ? "s" : ""} need recovery`}
        </span>
      }
      headerActions={
        <CatalogTeamFilter
          teams={teams}
          selectedTeamSlug={selectedTeamSlug}
          onChange={handleSelectedTeamSlugChange}
        />
      }
      showBreadcrumbs={false}
    >

      <ErrorBanner message={fetchError} onDismiss={() => setFetchError("")} onRetry={() => void loadPageData()} />
      <ErrorBanner message={recoveryError} onDismiss={() => setRecoveryError("")} />

      {recoveryBatchSummary && (
        <div
          className={`card teardown-summary batch-summary-card animate-fade-in-up ${recoveryBatchSummary.failed > 0 ? "batch-summary-card--error" : "batch-summary-card--success"}`}
        >
          <p className="teardown-summary-title">
            Recovery complete: {recoveryBatchSummary.success}/{recoveryBatchSummary.total} succeeded
          </p>
          {recoveryBatchSummary.failures.map((failure) => (
            <p key={failure.specId} className="teardown-summary-failure">
              <strong>{failure.title}:</strong> {failure.message}
            </p>
          ))}
        </div>
      )}

      {loading && (
        <div className="card services-table-wrap animate-fade-in-up">
          <table className="services-table">
            <caption className="sr-only">Loading recovery queue</caption>
            <thead>
              <tr>
                <th className="services-col-select" />
                <th>Service</th>
                <th>Reason</th>
                <th>Last Error</th>
                <th>Status</th>
                <th className="services-col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              <Skeleton variant="table-row" count={4} columns={6} />
            </tbody>
          </table>
        </div>
      )}

      {!loading && recoverableEntries.length === 0 && (
        <EmptyState
          title="No recoverable failures"
          description="No recoverable provisioning failures detected."
        />
      )}

      {!loading && recoverableEntries.length > 0 && (
        <div className="animate-fade-in-up">
          <div className="card services-table-wrap">
            <table className="services-table">
              <caption className="sr-only">Recovery queue</caption>
              <thead>
                <tr>
                  <th className="services-col-select">
                    <div className="services-header-select">
                      <label className="service-card-checkbox" aria-label="Select all recovery services">
                        <input
                          ref={selectAllRecoveryRef}
                          type="checkbox"
                          checked={allRecoverySelected}
                          onChange={toggleAllRecoverySelection}
                          disabled={recoverySelectionDisabled}
                        />
                      </label>
                    </div>
                  </th>
                  <th>Service</th>
                  <th>Reason</th>
                  <th>Last Error</th>
                  <th>Status</th>
                  <th className="services-col-actions">
                    <div className="services-header-actions">
                      {!recoveryHasBulkContext && (
                        <span className="services-header-actions-label">Actions</span>
                      )}
                      <div className="services-header-actions-controls">
                        {selectedRecoverySpecIds.size > 0 && (
                          <div className="services-bulk-menu-wrap" data-bulk-menu="true">
                            <button
                              type="button"
                              ref={bulkMenuTriggerRef}
                              className="services-menu-trigger services-header-menu-trigger"
                              aria-haspopup="menu"
                              aria-expanded={openBulkMenu === "recovery"}
                              aria-label="Bulk recovery actions"
                              onClick={() => {
                                if (recoverySelectionDisabled) return;
                                setOpenBulkMenu((prev) => (prev === "recovery" ? null : "recovery"));
                              }}
                              disabled={recoverySelectionDisabled}
                            >
                              <OverflowMenuIcon />
                            </button>
                            {openBulkMenu === "recovery" && (
                              <div
                                className="services-bulk-menu"
                                role="menu"
                                onBlur={(e) => {
                                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                                    setOpenBulkMenu(null);
                                  }
                                }}
                              >
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="services-bulk-menu-item services-bulk-menu-item-danger"
                                  onClick={() => {
                                    setOpenBulkMenu(null);
                                    void handleBatchRecovery();
                                  }}
                                  disabled={recoverySelectionDisabled || selectedRecoverySpecIds.size === 0}
                                >
                                  Recover selected
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="services-bulk-menu-item"
                                  onClick={() => {
                                    if (recoverySelectionDisabled) return;
                                    setOpenBulkMenu(null);
                                    setSelectedRecoverySpecIds(new Set());
                                  }}
                                  disabled={recoverySelectionDisabled || selectedRecoverySpecIds.size === 0}
                                >
                                  Clear selection
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                        {allRecoverySelected && (
                          <button
                            type="button"
                            className="services-header-danger-x"
                            aria-label="Recover all selected services"
                            title="Recover selected"
                            onClick={() => {
                              setOpenBulkMenu(null);
                              void handleBatchRecovery();
                            }}
                            disabled={recoverySelectionDisabled}
                          >
                            <HeaderDangerXIcon />
                          </button>
                        )}
                      </div>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {recoverableEntries.map((failure) => {
                  const runState = recoveryItemRunState[failure.spec_id] || "idle";
                  const statusClass =
                    runState === "running"
                      ? "status-teardown-running"
                      : runState === "success"
                        ? "status-teardown-success"
                        : runState === "error"
                          ? "status-teardown-error"
                          : "status-failed";
                  const statusLabel =
                    runState === "running"
                      ? "recovering"
                      : runState === "success"
                        ? "resolved"
                        : runState === "error"
                          ? "failed"
                          : "pending";
                  const checked = selectedRecoverySpecIds.has(failure.spec_id);
                  const disabled = recoveryBatchRun.running || runState === "running";

                  return (
                    <tr key={failure.spec_id} className="services-row">
                      <td className="services-select-cell">
                        <label className="service-card-checkbox" aria-label={`Select ${failure.title}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              if (recoverySelectionDisabled) return;
                              setOpenBulkMenu(null);
                              setSelectedRecoverySpecIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(failure.spec_id)) next.delete(failure.spec_id);
                                else next.add(failure.spec_id);
                                return next;
                              });
                            }}
                            disabled={recoverySelectionDisabled}
                          />
                        </label>
                      </td>
                      <td>
                        <div className="services-service-cell">
                          <strong>{failure.title}</strong>
                          <span className="mono">{failure.project_name || failure.spec_id}</span>
                        </div>
                      </td>
                      <td>
                        <span className={`recovery-reason-pill ${recoveryReasonClass(failure.reason)}`}>
                          {recoveryReasonLabel(failure.reason)}
                        </span>
                      </td>
                      <td>
                        <div className="services-service-cell">
                          <span>{failure.error_message || "Unknown failure"}</span>
                          {failure.failed_at_step && <span className="mono">Step: {failure.failed_at_step}</span>}
                        </div>
                      </td>
                      <td>
                        <div className="services-status-cell">
                          {runState === "running" && recoveryItemProgress[failure.spec_id] ? (
                            <TeardownStepTracker progress={recoveryItemProgress[failure.spec_id]} />
                          ) : (
                            <span className={`status-badge ${statusClass}`}>{statusLabel}</span>
                          )}
                          {recoveryItemErrors[failure.spec_id] && (
                            <div className="service-card-error">
                              {recoveryItemErrors[failure.spec_id]}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="services-actions-cell">
                        <button
                          type="button"
                          className="btn btn-secondary service-resource-btn recovery-danger-btn"
                          onClick={() => { void handleSingleRecovery(failure.spec_id); }}
                          disabled={disabled}
                        >
                          {runState === "running" ? "Recovering..." : "Recover"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {recoveryHasBulkContext && (
            <div className="services-bulk-context-row">
              {selectedRecoverySpecIds.size > 0 && (
                <SelectionCountBadge count={selectedRecoverySpecIds.size} />
              )}
              {recoveryBatchRun.running && (
                <span className="services-bulk-context-chip services-bulk-context-chip-running" role="status" aria-live="polite">
                  Running recovery: {recoveryBatchRun.completed}/{recoveryBatchRun.total}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction?.title ?? ""}
        description={confirmAction?.description ?? ""}
        confirmLabel="Continue"
        variant="danger"
        onConfirm={() => confirmAction?.onConfirm()}
        onCancel={() => setConfirmAction(null)}
      />

      <Modal open={credPrompt !== null} onClose={() => { if (!credValidating && !credSuccess) { setCredPrompt(null); setCredApiKey(""); setCredError(""); } }}>
        {credSuccess ? (
          <Modal.Body>
            <div className="cred-success-container">
              <div className="cred-success-circle">
                <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <p className="cred-success-label">Key verified</p>
            </div>
          </Modal.Body>
        ) : (
          <>
            <Modal.Header
              title="Team credentials required"
              subtitle={`Team '${credPrompt?.teamSlug || ""}' is not registered. Provide an API key to continue teardown.`}
            />
            <Modal.Body>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
                <label htmlFor="cred-api-key" className="form-label">
                  API Key for {credPrompt?.teamSlug || "team"}
                </label>
                <input
                  id="cred-api-key"
                  type="password"
                  className="form-input"
                  placeholder="PMAK-..."
                  value={credApiKey}
                  onChange={(e) => { setCredApiKey(e.target.value); setCredError(""); }}
                  autoFocus
                  disabled={credValidating}
                />
                {credError && <p className="form-error">{credError}</p>}
                <p className="modal-hint">
                  {credPrompt?.failedSpecIds.length ?? 0} service{(credPrompt?.failedSpecIds.length ?? 0) !== 1 ? "s" : ""} will
                  be retried with this key.
                </p>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => { setCredPrompt(null); setCredApiKey(""); setCredError(""); }}
                disabled={credValidating}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => { void handleCredRetry(); }}
                disabled={!credApiKey.trim() || credValidating}
              >
                {credValidating ? "Validating..." : "Retry with credentials"}
              </button>
            </Modal.Footer>
          </>
        )}
      </Modal>
    </PageLayout>
  );
}
