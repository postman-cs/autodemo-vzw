import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import registry from "../../../specs/registry.json";
import { CatalogTeamFilter } from "../components/CatalogTeamFilter";
import { domainColor, domainBackground } from "../lib/domain-colors";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DomainPill } from "../components/DomainPill";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Modal } from "../components/Modal";
import { OverflowMenuIcon } from "../components/OverflowMenuIcon";
import { PageLayout } from "../components/PageLayout";
import { ResourceModal } from "../components/ResourceModal";
import { Skeleton } from "../components/Skeleton";
import { SelectionCountBadge } from "../components/SelectionCountBadge";
import { useMenuKeyboard } from "../hooks/useMenuKeyboard";
import {
  matchesCatalogTeam,
  normalizeCatalogTeamSlug,
  resolveCatalogTeamLabel,
} from "../lib/catalog-team-filter";
import {
  phaseToIndex,
  type TeardownProgress,
} from "../lib/teardown-progress";
import { HeaderDangerXIcon } from "../components/HeaderDangerXIcon";
import { TeardownStepTracker } from "../components/TeardownStepTracker";
import {
  toCount,
  type BatchFailure,
  type BatchSummary,
  type ResourceInventory,
  type Deployment,
  type ConfigData,
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
import {
  environmentMappingSummary,
  environmentStatusLabel,
  isChaosEnabled,
  parseEnvironmentDeployments,
} from "../lib/deployment-metadata";

type ItemRunState = "idle" | "running" | "success" | "error";

interface BatchTeardownRequestItem {
  spec_id: string;
  project_name: string;
}

interface ChaosToggleResponse {
  failed_urls?: Array<{ url: string; error: string }>;
}

const REGISTRY = registry as RegistryEntry[];
const GITHUB_ICON_URL = new URL("../../github-logo.png", import.meta.url).href;

interface DeployedEntry {
  id: string;
  title: string;
  domain: string;
  endpoints: number | string;
  deployment: Deployment;
}

function resolveProjectName(deployment: Deployment): string {
  return (deployment.github_repo_name || deployment.spec_id || "").trim();
}

async function callChaosToggle(specId: string, enabled: boolean, environment?: string): Promise<void> {
  const body: { enabled: boolean; environment?: string } = { enabled };
  if (environment) body.environment = environment;
  const response = await fetch(`/api/catalog/${encodeURIComponent(specId)}/chaos`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(typeof err.error === "string" ? err.error : `Chaos toggle failed (${response.status})`);
  }

  const data = await response.json().catch(() => ({})) as ChaosToggleResponse;
  if (data.failed_urls && data.failed_urls.length > 0) {
    const messages = data.failed_urls.map((f: { url: string; error: string }) => `${new URL(f.url).host}: ${f.error}`).join("; ");
    throw new Error(`Toggle partially failed: ${messages}`);
  }
}

async function loadOptionalJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}


export function CatalogPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [recoverableCount, setRecoverableCount] = useState(0);
  const [teams, setTeams] = useState<TeamRegistryEntry[]>([]);
  const [teamRegistryLoaded, setTeamRegistryLoaded] = useState(false);
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");
  const [teardownError, setTeardownError] = useState("");
  const [openMenuSpecId, setOpenMenuSpecId] = useState<string | null>(null);
  const [openBulkMenu, setOpenBulkMenu] = useState<"deployed" | null>(null);
  const [selectedSpecIds, setSelectedSpecIds] = useState<Set<string>>(new Set());
  const [itemRunState, setItemRunState] = useState<Record<string, ItemRunState>>({});
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  // Keys are `${specId}:${environment}` or `${specId}:all` for global toggles.
  const [itemProgress, setItemProgress] = useState<Record<string, TeardownProgress>>({});
  const [chaosRunning, setChaosRunning] = useState<Set<string>>(new Set());

  const [batchRun, setBatchRun] = useState<BatchRunState>({
    running: false,
    total: 0,
    completed: 0,
    success: 0,
    failed: 0,
    queued: 0,
    inFlight: 0,
  });
  const [batchSummary, setBatchSummary] = useState<BatchSummary | null>(null);
  const [resourceModalSpecId, setResourceModalSpecId] = useState<string | null>(null);
  const [resourceModalLoading, setResourceModalLoading] = useState(false);
  const [resourceModalError, setResourceModalError] = useState("");
  const [resourceModalData, setResourceModalData] = useState<ResourceInventory | null>(null);

  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    description: string;
    onConfirm: () => void;
  } | null>(null);

  const [credPrompt, setCredPrompt] = useState<{ teamSlug: string; failedSpecIds: string[] } | null>(null);
  const [credApiKey, setCredApiKey] = useState("");
  const [credValidating, setCredValidating] = useState(false);
  const [credError, setCredError] = useState("");
  const [credSuccess, setCredSuccess] = useState(false);
  const credPromptShownRef = useRef(false);

  const closeModalButtonRef = useRef<HTMLButtonElement | null>(null);
  const selectAllDeployedRef = useRef<HTMLInputElement | null>(null);
  const bulkMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const serviceMenuTriggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const rawSelectedTeamSlug = searchParams.get("team") || "";
  const selectedTeamSlug = useMemo(
    () => (teamRegistryLoaded ? normalizeCatalogTeamSlug(rawSelectedTeamSlug, teams) : ""),
    [rawSelectedTeamSlug, teamRegistryLoaded, teams],
  );

  const loadPageData = useCallback(async () => {
    try {
      setFetchError("");
      const [depData, cfgData, teamsData] = await Promise.all([
        fetch("/api/deployments").then((r) => r.json() as Promise<DeploymentsResponse>),
        fetch("/api/config").then((r) => r.json() as Promise<ConfigData>),
        loadOptionalJson("/api/teams/registry"),
      ]);
      setDeployments(depData.deployments || []);
      setRecoverableCount((depData.recoverable_failures || []).length);
      const teamsRegistry = teamsData as TeamsRegistryResponse | null;
      setTeams(Array.isArray(teamsRegistry?.teams) ? teamsRegistry.teams as TeamRegistryEntry[] : []);
      setConfig(cfgData);
    } catch (err) {
      console.error(err);
      setFetchError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setTeamRegistryLoaded(true);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = "Services | Verizon Service Deployment Portal";
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
    setOpenMenuSpecId(null);
    setOpenBulkMenu(null);
    const next = new URLSearchParams(searchParams);
    if (nextTeamSlug) next.set("team", nextTeamSlug);
    else next.delete("team");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const closeResourceModal = useCallback(() => {
    setResourceModalSpecId(null);
    setResourceModalLoading(false);
    setResourceModalError("");
    setResourceModalData(null);
  }, []);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-service-menu]") || target?.closest("[data-bulk-menu]")) return;
      setOpenMenuSpecId(null);
      setOpenBulkMenu(null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (resourceModalSpecId) {
        closeResourceModal();
        return;
      }
      setOpenMenuSpecId(null);
      setOpenBulkMenu(null);
    };

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [resourceModalSpecId, closeResourceModal]);

  useEffect(() => {
    if (!resourceModalSpecId) return;
    closeModalButtonRef.current?.focus();
  }, [resourceModalSpecId]);

  useMenuKeyboard(openMenuSpecId !== null || openBulkMenu !== null);

  const prevOpenMenuSpecId = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevOpenMenuSpecId.current;
    prevOpenMenuSpecId.current = openMenuSpecId;

    if (openMenuSpecId) {
      requestAnimationFrame(() => {
        const trigger = serviceMenuTriggerRefs.current.get(openMenuSpecId);
        const menu = trigger?.parentElement?.querySelector<HTMLElement>('[role="menu"]');
        const first = menu?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)');
        first?.focus();
      });
    } else if (prev) {
      const trigger = serviceMenuTriggerRefs.current.get(prev);
      trigger?.focus();
    }
  }, [openMenuSpecId]);

  const prevOpenBulkMenu = useRef<"deployed" | null>(null);
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

  const registryById = useMemo(
    () => new Map(REGISTRY.map((entry) => [entry.id, entry])),
    [],
  );

  const deployedEntries = useMemo(() => {
    const deployedSpecs = new Map<string, Deployment>(
      deployments
        .filter((d) => d.status === "active")
        .filter((d) => matchesCatalogTeam(selectedTeamSlug, d.postman_team_slug))
        .filter((d) => Boolean((d.spec_id || "").trim()))
        .map((d) => [d.spec_id, d]),
    );

    return Array.from(deployedSpecs.entries()).map(([id, deployment]): DeployedEntry => {
      const registryEntry = registryById.get(id);
      return {
        id,
        title: registryEntry?.title || resolveProjectName(deployment) || id,
        domain: registryEntry?.domain || "custom",
        endpoints: registryEntry?.endpoints ?? "-",
        deployment,
      };
    });
  }, [deployments, registryById, selectedTeamSlug]);

  const deploymentBySpecId = useMemo(() => {
    return new Map(deployedEntries.map((entry) => [entry.id, entry.deployment]));
  }, [deployedEntries]);

  const resourceModalTitle = useMemo(() => {
    if (!resourceModalSpecId) return "";
    const entry = deployedEntries.find((item) => item.id === resourceModalSpecId);
    return entry?.title || resourceModalSpecId;
  }, [deployedEntries, resourceModalSpecId]);

  useEffect(() => {
    setSelectedSpecIds((prev) => {
      const allowed = new Set(deployedEntries.map((entry) => entry.id));
      const next = new Set<string>();
      for (const id of prev) {
        if (allowed.has(id)) next.add(id);
      }
      if (next.size === prev.size) return prev;
      return next;
    });
  }, [deployedEntries]);

  useEffect(() => {
    if (!selectAllDeployedRef.current) return;
    const someSelected = selectedSpecIds.size > 0 && selectedSpecIds.size < deployedEntries.length;
    selectAllDeployedRef.current.indeterminate = someSelected;
  }, [selectedSpecIds.size, deployedEntries.length]);

  const openResourceModal = async (specId: string) => {
    setResourceModalSpecId(specId);
    setResourceModalLoading(true);
    setResourceModalError("");
    setResourceModalData(null);

    try {
      const response = await fetch(`/api/resources/${encodeURIComponent(specId)}`);
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        const message = typeof body.error === "string" ? body.error : `Resource lookup failed (${response.status})`;
        throw new Error(message);
      }
      const resource = (body as { resource?: ResourceInventory }).resource;
      if (!resource) {
        throw new Error("No resource inventory available for this service");
      }
      setResourceModalData(resource);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load resources";
      setResourceModalError(message);
    } finally {
      setResourceModalLoading(false);
    }
  };

  const runBatchTeardown = async (specIds: string[], overrideCreds?: { api_key: string }) => {
    if (!specIds.length || batchRun.running) return;
    credPromptShownRef.current = false;
    const unknownTeamSpecIds: string[] = [];

    setTeardownError("");
    setBatchSummary(null);
    setOpenMenuSpecId(null);
    setOpenBulkMenu(null);
    setItemProgress((prev) => {
      const next = { ...prev };
      for (const id of specIds) {
        delete next[id];
      }
      return next;
    });
    setItemErrors((prev) => {
      const next = { ...prev };
      for (const id of specIds) {
        delete next[id];
      }
      return next;
    });

    const titleBySpecId = new Map<string, string>();
    for (const id of specIds) {
      const entry = deployedEntries.find((e) => e.id === id);
      titleBySpecId.set(id, entry?.title || id);
    }

    const failureBySpecId = new Map<string, BatchFailure>();
    const recordFailure = (specId: string, message: string) => {
      const title = titleBySpecId.get(specId) || specId;
      failureBySpecId.set(specId, { specId, title, message });
      setItemRunState((prev) => ({ ...prev, [specId]: "error" }));
      setItemErrors((prev) => ({ ...prev, [specId]: message }));
    };

    const items: BatchTeardownRequestItem[] = [];
    const specIdByProject = new Map<string, string>();
    for (const specId of specIds) {
      const deployment = deploymentBySpecId.get(specId);
      if (!deployment) {
        recordFailure(specId, "Deployment record not found");
        continue;
      }
      const projectName = resolveProjectName(deployment);
      if (!projectName) {
        recordFailure(specId, "Missing project name for teardown.");
        continue;
      }
      const item: BatchTeardownRequestItem & { override_api_key?: string } = { spec_id: specId, project_name: projectName };
      if (overrideCreds?.api_key) item.override_api_key = overrideCreds.api_key;
      items.push(item);
      specIdByProject.set(projectName, specId);
    }

    setItemRunState((prev) => {
      const next = { ...prev };
      for (const id of specIds) {
        next[id] = failureBySpecId.has(id) ? "error" : "running";
      }
      return next;
    });

    setBatchRun({
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
            setBatchRun({
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
            setItemProgress((prev) => ({
              ...prev,
              [specId]: { stepIndex: phaseToIndex(event.phase || ""), message: event.message! },
            }));
          }

          if (event.status === "error") {
            setItemProgress((prev) => { const next = { ...prev }; delete next[specId]; return next; });
            const msg = event.message || "Teardown failed";
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
            setItemProgress((prev) => { const next = { ...prev }; delete next[specId]; return next; });
            setItemRunState((prev) => ({ ...prev, [specId]: "success" }));
          }
        });

        for (const result of completeData.results) {
          const projectName = (result.project_name || "").trim();
          const specId = (result.spec_id || "").trim() || (projectName ? specIdByProject.get(projectName) : undefined);
          if (!specId) continue;

          if (result.success) {
            failureBySpecId.delete(specId);
            setItemRunState((prev) => ({ ...prev, [specId]: "success" }));
          } else {
            recordFailure(specId, result.error || "Teardown failed");
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Batch teardown failed";
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
    setBatchRun({
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
    setBatchSummary(summary);

    if (failures.length > 0) {
      if (unknownTeamSpecIds.length > 0) {
        setCredPrompt((prev) => prev ? { ...prev, failedSpecIds: [...unknownTeamSpecIds] } : prev);
      }
      setTeardownError("Some teardowns failed. Review the summary and retry failed services.");
      setSelectedSpecIds(new Set(failures.map((failure) => failure.specId)));
      return;
    }

    setSelectedSpecIds(new Set());
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
      const data = await resp.json() as { valid: boolean };
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
        void runBatchTeardown(retryIds, { api_key: key });
      }
    } catch {
      setCredError("Failed to validate key. Check your connection and try again.");
      setCredValidating(false);
    }
  };

  const handleSingleTeardown = (specId: string) => {
    if (batchRun.running) return;
    setOpenMenuSpecId(null);
    setOpenBulkMenu(null);

    const deployment = deploymentBySpecId.get(specId);
    if (!deployment) {
      setTeardownError("Deployment record not found.");
      return;
    }

    const projectName = resolveProjectName(deployment);
    if (!projectName) {
      setTeardownError("Missing project name for teardown.");
      return;
    }

    setConfirmAction({
      title: `Tear down ${projectName}?`,
      description: "This removes GitHub, Postman, and AWS (Lambda/API Gateway) resources.",
      onConfirm: () => {
        setConfirmAction(null);
        void runBatchTeardown([specId]);
      },
    });
  };

  const handleBatchTeardown = () => {
    if (batchRun.running || selectedSpecIds.size === 0) return;

    const count = selectedSpecIds.size;
    setConfirmAction({
      title: `Tear down ${count} selected service${count === 1 ? "" : "s"}?`,
      description: "This removes GitHub, Postman, and AWS (Lambda/API Gateway) resources.",
      onConfirm: () => {
        setConfirmAction(null);
        void runBatchTeardown(Array.from(selectedSpecIds));
      },
    });
  };

  const handleChaosToggle = useCallback(async (specId: string, enabled: boolean, environment?: string) => {
    setOpenMenuSpecId(null);
    const key = `${specId}:${environment ?? "all"}`;
    setChaosRunning((prev) => new Set(prev).add(key));
    setItemErrors((prev) => { const next = { ...prev }; delete next[specId]; return next; });
    try {
      await callChaosToggle(specId, enabled, environment);
      await loadPageData();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Chaos toggle failed";
      setItemErrors((prev) => ({ ...prev, [specId]: message }));
    } finally {
      setChaosRunning((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [loadPageData]);

  const deployedSelectionDisabled = batchRun.running;
  const allSelected = deployedEntries.length > 0 && selectedSpecIds.size === deployedEntries.length;
  const deployedHasBulkContext = selectedSpecIds.size > 0 || batchRun.running;

  const toggleAllDeployedSelection = () => {
    if (deployedSelectionDisabled) return;
    setOpenBulkMenu(null);
    if (allSelected) {
      setSelectedSpecIds(new Set());
      return;
    }
    setSelectedSpecIds(new Set(deployedEntries.map((entry) => entry.id)));
  };

  return (
    <PageLayout
      title="Deployed Services"
      subtitle={
        <span aria-live="polite">
          {loading
            ? <Skeleton variant="text" width="180px" />
            : deployedEntries.length === 0
              ? "No services deployed yet. Go to Provision to deploy your first service."
              : `${deployedEntries.length} service${deployedEntries.length !== 1 ? "s" : ""} deployed`}
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
      <div className="meta-bar">
        <div className="meta-item">
          <span className="meta-label">AWS Region</span>
          <span className="meta-value">{config?.aws_region || "eu-central-1"}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">GitHub Org</span>
          <a
            className="meta-value meta-link"
            href={config?.github_org_url || "https://github.com/postman-cs"}
            target="_blank"
            rel="noopener noreferrer"
          >
            {config?.github_org || "postman-cs"}
          </a>
        </div>
        <div className="meta-item">
          <span className="meta-label">Total Specs</span>
          <span className="meta-value">{REGISTRY.length}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Deployed</span>
          <span className="meta-value">{deployedEntries.length}</span>
        </div>
      </div>

      <ErrorBanner message={fetchError} onDismiss={() => setFetchError("")} onRetry={() => void loadPageData()} />
      <ErrorBanner message={teardownError} onDismiss={() => setTeardownError("")} />

      {recoverableCount > 0 && (
        <div className="recovery-alert">
          <span>{recoverableCount} service{recoverableCount !== 1 ? "s" : ""} need recovery.</span>
          <Link to="/recovery" className="recovery-alert-link">View Recovery Queue</Link>
        </div>
      )}

      {batchSummary && (
        <div
          className={`card teardown-summary batch-summary-card animate-fade-in-up ${batchSummary.failed > 0 ? "batch-summary-card--error" : "batch-summary-card--success"}`}
        >
          <p className="teardown-summary-title">
            Batch teardown complete: {batchSummary.success}/{batchSummary.total} succeeded
          </p>
          {batchSummary.failures.map((failure) => (
            <p key={failure.specId} className="teardown-summary-failure">
              <strong>{failure.title}:</strong> {failure.message}
            </p>
          ))}
        </div>
      )}

      {!loading && deployedEntries.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No deployed services yet"
            description="Head to the Provision tab to deploy your first API service."
          />
        </div>
      ) : (
        <>
          <div className="card services-table-wrap animate-fade-in-up">
            <table className="services-table">
              <caption className="sr-only">Deployed services</caption>
              <thead>
                <tr>
                  <th className="services-col-select">
                    <div className="services-header-select">
                      <label className="service-card-checkbox" aria-label="Select all deployed services">
                        <input
                          ref={selectAllDeployedRef}
                          type="checkbox"
                          checked={allSelected}
                          onChange={toggleAllDeployedSelection}
                          disabled={deployedSelectionDisabled}
                        />
                      </label>
                    </div>
                  </th>
                  <th>Service</th>
                  <th>Domain</th>
                  <th>Endpoints</th>
                  <th>AWS Region</th>
                  <th>Status</th>
                  <th>Links</th>
                  <th>Resources</th>
                  <th className="services-col-actions">
                    <div className="services-header-actions">
                      {!deployedHasBulkContext && (
                        <span className="services-header-actions-label">Actions</span>
                      )}
                      <div className="services-header-actions-controls">
                        {selectedSpecIds.size > 0 && (
                          <div className="services-bulk-menu-wrap" data-bulk-menu="true">
                            <button
                              type="button"
                              ref={bulkMenuTriggerRef}
                              className="services-menu-trigger services-header-menu-trigger"
                              aria-haspopup="menu"
                              aria-expanded={openBulkMenu === "deployed"}
                              aria-label="Bulk teardown actions"
                              onClick={() => {
                                if (deployedSelectionDisabled) return;
                                setOpenMenuSpecId(null);
                                setOpenBulkMenu((prev) => (prev === "deployed" ? null : "deployed"));
                              }}
                              disabled={deployedSelectionDisabled}
                            >
                              <OverflowMenuIcon />
                            </button>
                            {openBulkMenu === "deployed" && (
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
                                    void handleBatchTeardown();
                                  }}
                                  disabled={deployedSelectionDisabled || selectedSpecIds.size === 0}
                                >
                                  Teardown selected
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="services-bulk-menu-item"
                                  onClick={() => {
                                    if (deployedSelectionDisabled) return;
                                    setOpenBulkMenu(null);
                                    setSelectedSpecIds(new Set());
                                  }}
                                  disabled={deployedSelectionDisabled || selectedSpecIds.size === 0}
                                >
                                  Clear selection
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                        {allSelected && (
                          <button
                            type="button"
                            className="services-header-danger-x"
                            aria-label="Teardown all selected services"
                            title="Teardown selected"
                            onClick={() => {
                              setOpenBulkMenu(null);
                              void handleBatchTeardown();
                            }}
                            disabled={deployedSelectionDisabled}
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
                {loading ? (
                  <Skeleton variant="table-row" count={6} columns={9} />
                ) : deployedEntries.map(({ id, title, domain, endpoints, deployment }) => {
                  const envDeployments = parseEnvironmentDeployments(deployment);
                  const teamLabel = resolveCatalogTeamLabel(deployment.postman_team_slug, teams);
                  const runState = itemRunState[id] || "idle";
                  const statusClass =
                    runState === "running"
                      ? "status-teardown-running"
                      : runState === "success"
                        ? "status-teardown-success"
                        : runState === "error"
                          ? "status-teardown-error"
                          : `status-${deployment.status}`;
                  const statusLabel =
                    runState === "running"
                      ? "tearing down"
                      : runState === "success"
                        ? "removed"
                        : runState === "error"
                          ? "teardown failed"
                          : deployment.status;
                  const menuOpen = openMenuSpecId === id;
                  const checked = selectedSpecIds.has(id);
                  const disabled = batchRun.running || runState === "running";

                  return (
                    <tr key={id} className="services-row">
                      <td className="services-select-cell">
                        <label className="service-card-checkbox" aria-label={`Select ${title}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              if (deployedSelectionDisabled) return;
                              setOpenBulkMenu(null);
                              setSelectedSpecIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(id)) next.delete(id);
                                else next.add(id);
                                return next;
                              });
                            }}
                            disabled={deployedSelectionDisabled}
                          />
                        </label>
                      </td>
                      <td>
                        <div className="services-service-cell">
                          <strong className="services-name-primary">{title}</strong>
                          <div className="services-name-meta">
                            {teamLabel && (
                              <DomainPill value={teamLabel} tone="team" />
                            )}
                            {deployment.runtime_mode && (
                              <span className="runtime-badge">{deployment.runtime_mode}</span>
                            )}
                          </div>
                          <span className="mono">{deployment.github_repo_name || id}</span>
                        </div>
                      </td>
                      <td>
                        <DomainPill
                          value={domain}
                          style={{ "--domain-bg": domainBackground(domain), "--domain-fg": domainColor(domain) } as CSSProperties}
                        />
                      </td>
                      <td>{endpoints}</td>
                      <td>{deployment.aws_region || "-"}</td>
                      <td>
                        <div className="services-status-cell">
                          {runState === "running" && itemProgress[id] ? (
                            <TeardownStepTracker progress={itemProgress[id]} />
                          ) : envDeployments.length > 0 ? (
                            <div className="services-env-list">
                              {envDeployments.map((env) => {
                                const envStatus = environmentStatusLabel(env);
                                const envStatusClass = runState !== "idle"
                                  ? statusClass
                                  : `status-${envStatus}`;
                                const dotClass = envStatus === "active"
                                  ? "service-status-dot service-status-dot--active"
                                  : envStatus === "failed"
                                    ? "service-status-dot service-status-dot--failed"
                                    : "service-status-dot service-status-dot--pending";
                                return (
                                  <span
                                    key={env.environment}
                                    className={`status-badge status-badge--small ${envStatusClass}`}
                                    title={environmentMappingSummary(env) || env.environment}
                                  >
                                    <span className={dotClass} aria-hidden="true" />
                                    {env.environment}
                                    {envStatus !== "active" && envStatus !== "unknown" && (
                                      <span className="services-env-badge-status"> {envStatus}</span>
                                    )}
                                  </span>
                                );
                              })}
                            </div>
                          ) : (
                            <span className={`status-badge ${statusClass}`}>
                              <span
                                className={`service-status-dot ${
                                  statusLabel === "active"
                                    ? "service-status-dot--active"
                                    : statusLabel === "failed" || statusLabel === "teardown failed"
                                      ? "service-status-dot--failed"
                                      : "service-status-dot--pending"
                                }`}
                                aria-hidden="true"
                              />
                              {statusLabel}
                            </span>
                          )}
                          {itemErrors[id] && <p className="service-card-error">{itemErrors[id]}</p>}
                        </div>
                      </td>
                      <td>
                        <div className="service-links">
                          {deployment.github_repo_url && (
                            <a
                              href={deployment.github_repo_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="service-link-icon service-link-icon-github"
                              aria-label={`Open GitHub repo for ${title}`}
                              title="GitHub"
                            >
                              <img src={GITHUB_ICON_URL} alt="" aria-hidden="true" className="service-link-icon-image" />
                              <span className="sr-only">GitHub</span>
                            </a>
                          )}
                          {deployment.postman_workspace_url && (
                            <a
                              href={deployment.postman_workspace_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="service-link-icon service-link-icon-postman"
                              aria-label={`Open Postman workspace for ${title}`}
                              title="Postman"
                            >
                              <span className="service-link-icon-badge service-link-icon-badge-postman" aria-hidden="true">P</span>
                              <span className="sr-only">Postman</span>
                            </a>
                          )}
                          {deployment.fern_docs_url && (
                            <a
                              href={deployment.fern_docs_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="service-link-icon service-link-icon-fern"
                              aria-label={`Open Fern API docs for ${title}`}
                              title="API Docs (Fern)"
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <polyline points="14 2 14 8 20 8" />
                                <line x1="16" y1="13" x2="8" y2="13" />
                                <line x1="16" y1="17" x2="8" y2="17" />
                                <polyline points="10 9 9 9 8 9" />
                              </svg>
                              <span className="sr-only">API Docs</span>
                            </a>
                          )}
                          {deployment.mock_url && (
                            <a
                              href={deployment.mock_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="service-link-icon service-link-icon-mock"
                              aria-label={`Open Postman mock server for ${title}`}
                              title="Mock Server"
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <polyline points="16 18 22 12 16 6" />
                                <polyline points="8 6 2 12 8 18" />
                              </svg>
                              <span className="sr-only">Mock Server</span>
                            </a>
                          )}
                          {!deployment.github_repo_url && !deployment.postman_workspace_url && !deployment.fern_docs_url && !deployment.mock_url && <span>-</span>}
                        </div>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-secondary service-resource-btn"
                          onClick={() => { void openResourceModal(id); }}
                          disabled={disabled}
                        >
                          Resources
                        </button>
                      </td>
                      <td>
                        <div className="service-card-actions" data-service-menu="true">
                          <button
                            type="button"
                            ref={(el) => {
                              if (el) serviceMenuTriggerRefs.current.set(id, el);
                              else serviceMenuTriggerRefs.current.delete(id);
                            }}
                            className="services-menu-trigger service-card-menu-trigger"
                            aria-label={`Actions for ${title}`}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            onClick={() => {
                              if (disabled) return;
                              setOpenBulkMenu(null);
                              setOpenMenuSpecId((prev) => (prev === id ? null : id));
                            }}
                            disabled={disabled}
                          >
                            <OverflowMenuIcon />
                          </button>
                          {menuOpen && (
                            <div
                              className="service-card-menu"
                              role="menu"
                              onBlur={(e) => {
                                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                                  setOpenMenuSpecId(null);
                                }
                              }}
                            >
                              {/* Chaos toggle — per-env when multiple envs exist, single item otherwise */}
                              {(() => {
                                if (envDeployments.length > 1) {
                                  return envDeployments.map((envDeploy) => {
                                    const envSlug = envDeploy.environment;
                                    const chaosOn = isChaosEnabled(deployment, envSlug);
                                    const running = chaosRunning.has(`${id}:${envSlug}`);
                                    return (
                                      <button
                                        key={envSlug}
                                        type="button"
                                        role="menuitem"
                                        className="service-card-menu-item"
                                        onClick={() => { void handleChaosToggle(id, !chaosOn, envSlug); }}
                                        disabled={disabled || running}
                                      >
                                        {running
                                          ? `Updating ${envSlug}…`
                                          : chaosOn
                                            ? `Disable chaos (${envSlug})`
                                            : `Enable chaos (${envSlug})`}
                                      </button>
                                    );
                                  });
                                }
                                // Single env or no structured env deployments
                                const envSlug = envDeployments[0]?.environment;
                                const chaosOn = isChaosEnabled(deployment, envSlug);
                                const running = chaosRunning.has(`${id}:${envSlug ?? "all"}`);
                                return (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="service-card-menu-item"
                                    onClick={() => { void handleChaosToggle(id, !chaosOn, envSlug); }}
                                    disabled={disabled || running}
                                  >
                                    {running ? "Updating…" : chaosOn ? "Disable chaos" : "Enable chaos"}
                                  </button>
                                );
                              })()}
                              <hr className="service-card-menu-divider" />
                              <button
                                type="button"
                                role="menuitem"
                                className="service-card-menu-item service-card-menu-item-danger"
                                onClick={() => { void handleSingleTeardown(id); }}
                                disabled={disabled}
                              >
                                Teardown service
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {deployedHasBulkContext && (
            <div className="services-bulk-context-row services-bulk-bar">
              {selectedSpecIds.size > 0 && (
                <SelectionCountBadge count={selectedSpecIds.size} />
              )}
              {batchRun.running && (
                <span className="services-bulk-context-chip services-bulk-context-chip-running" role="status" aria-live="polite">
                  Running teardown: {batchRun.completed}/{batchRun.total}
                </span>
              )}
            </div>
          )}
        </>
      )}

      <ResourceModal
        open={!!resourceModalSpecId}
        onClose={closeResourceModal}
        title="Resources"
        subtitle={resourceModalTitle}
        loading={resourceModalLoading}
        error={resourceModalError}
        data={resourceModalData}
        showEnvironmentColumn={true}
        closeButtonRef={closeModalButtonRef}
      />

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
                <label htmlFor="catalog-cred-api-key" className="form-label">
                  API Key for {credPrompt?.teamSlug || "team"}
                </label>
                <input
                  id="catalog-cred-api-key"
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
