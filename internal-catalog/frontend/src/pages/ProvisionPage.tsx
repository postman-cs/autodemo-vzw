import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { useMenuKeyboardNav } from "../hooks/useMenuKeyboardNav";
import registry from "../../../specs/registry.json";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ExecutionTakeover, shouldShowExecutionTakeover } from "../components/ExecutionTakeover";
import { ErrorBanner } from "../components/ErrorBanner";
import { IndustrySelector } from "../components/IndustrySelector";
import { ProvisionShell } from "../components/ProvisionShell";
import { ProvisionLaunchPanel } from "../components/ProvisionLaunchPanel";
import type { ProvisionLayoutContext } from "../components/ProvisionLayout";
import { ProvisionStageTracker } from "../components/ProvisionStageTracker";
import { GraphReviewSummary } from "../components/GraphReviewSummary";
import { RegisterTeamModal } from "../components/RegisterTeamModal";
import { ResourceModal } from "../components/ResourceModal";
import { Skeleton } from "../components/Skeleton";
import { SpecSelector, type RegistryEntry } from "../components/SpecSelector";
import { DependencyGraphVisualizer } from "../components/DependencyGraphVisualizer";
import type { StepRailItem } from "../components/StepRail";
import { StepRailMetadata, StepRailMetaItem } from "../components/StepRail";
import { Tooltip } from "../components/Tooltip";

const WarningIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--warning-text, #f59e0b)" }} aria-hidden="true">
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
    <path d="M12 9v4"/><path d="M12 17h.01"/>
  </svg>
);

const ErrorIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--error-text, #ef4444)" }} aria-hidden="true">
    <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
  </svg>
);
import {
  runtimeLabel,
  type DeploymentMode,
  type RuntimeMode,
  type BatchFailure,
  type BatchSummary,
  type ResourceInventory,
  type Deployment,
  type ConfigData,
  type BatchRunState,
  type ProvisionPlan,
  type ProvisionPlanResponse,
  type TeamRegistryEntry,
  type DeploymentsResponse,
  type TeamsRegistryResponse,
} from "../lib/types";
import { readTeardownStream, readBatchTeardownStream } from "../lib/sse-stream";
import {
  buildBlockedGraphNodeDetails,
  collectBlockedGraphTeardownTargets,
} from "../lib/blocked-graph";
import {
  applySelectionToggle,
  applyVisibleSelection,
  buildInitialGraphBoardNodes,
  coerceDeploymentMode,
  ensureSingleRootSelection,
  summarizeGraphSubmit,
  supportsGraphDeploymentMode,
  type GraphBoardNodeState,
} from "../lib/provision-graph-ui";
import {
  mapSseItemToRunUnit,
  mapGraphNodeToRunUnit,
  type RunUnit,
} from "../lib/provision-progress";
import {
  buildLaunchRequestBody,
  deriveSelectedEnvList,
} from "../lib/provision-launch";
import { shouldTriggerRecheck, mergeHealthIntoTeams } from "../lib/credential-verify";

interface ProgressEvent {
  phase: string;
  status: string;
  message: string;
  data?: Record<string, unknown>;
}

interface TeamUser {
  id: number;
  name: string;
  username: string;
  email: string;
}

interface OrgMember {
  id: number;
  login: string;
  name: string;
  email: string;
}

type ProvisionItemStatus = "queued" | "running" | "success" | "error";

interface ProvisionItemState {
  spec: RegistryEntry;
  status: ProvisionItemStatus;
  phase: string;
  message: string;
  events: ProgressEvent[];
  runUrl?: string;
  result?: Record<string, unknown>;
  error?: string;
}

interface ProvisionPlanState {
  loading: boolean;
  plan: ProvisionPlan | null;
  warnings: string[];
  error: string;
}

type AuxiliaryDataState = "loading" | "ready" | "empty" | "unavailable";

interface GraphRunState {
  deploymentGroupId?: string;
  deploymentRootSpecId?: string;
  summary?: Record<string, unknown>;
  error?: string;
}

interface RecoveryState {
  status: "running" | "success" | "error";
  message: string;
}

const MAX_PARALLEL = 5;
const STAGGER_DELAY_MS = 2000;

const ADMIN_STORAGE_KEY = "catalog-admin-selected-admins";
const REPO_ADMINS_STORAGE_KEY = "catalog-admin-selected-repo-admins";
const RUNTIME_MODE_STORAGE_KEY = "catalog-admin-selected-runtime-mode";
const DEPLOYMENT_MODE_STORAGE_KEY = "catalog-admin-selected-deployment-mode";

const PHASE_LABELS: Record<string, string> = {
  prepare: "Preparing",
  github: "GitHub repo",
  spec: "Uploading spec",
  postman: "Postman bootstrap",
  "postman-env": "Creating environments",
  aws: "AWS deploy",
  sync: "Syncing artifacts",
  complete: "Complete",
  error: "Error",
};

const INITIAL_BATCH_RUN: BatchRunState = {
  running: false,
  total: 0,
  queued: 0,
  inFlight: 0,
  completed: 0,
  success: 0,
  failed: 0,
};

interface TeamUsersResponse {
  users?: TeamUser[];
}

interface OrgMembersResponse {
  members?: OrgMember[];
}

interface SystemEnvironmentsResponse {
  system_environments?: Array<{ id: string; name: string; slug: string }>;
}

interface OrgTeamsResponse {
  teams?: Array<{ id: number; name: string; handle: string }>;
}

interface ErrorResponse {
  error?: string;
}

interface ResourceInventoryResponse {
  resource?: ResourceInventory;
  error?: string;
}

interface ProvisionPlanErrorResponse {
  error?: string;
}

interface GraphCreateResponse {
  instance_id: string;
}

const specs = registry as RegistryEntry[];

type ProvisionStepId = "configure" | "target" | "plan" | "review";

function renderLogLines(lines: string[]) {
  const seen = new Map<string, number>();

  return lines.map((line) => {
    const occurrence = (seen.get(line) ?? 0) + 1;
    seen.set(line, occurrence);

    return <div key={`${line}-${occurrence}`}>{line}</div>;
  });
}

export function ProvisionPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedIndustry, setSelectedIndustry] = useState("financial");
  const [selectedSpecIds, setSelectedSpecIds] = useState<Set<string>>(new Set());
  const [connectPostman, setConnectPostman] = useState(true);
  const [chaosEnabled, setChaosEnabled] = useState(false);
  const [chaosConfig, setChaosConfig] = useState("");
  const [environmentSyncEnabled, setEnvironmentSyncEnabled] = useState(true);
  const [k8sDiscoveryWorkspaceLink, setK8sDiscoveryWorkspaceLink] = useState(false);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("lambda");
  const [deploymentMode, setDeploymentMode] = useState<DeploymentMode>("single");
  const [activeBoardMode, setActiveBoardMode] = useState<DeploymentMode>("single");
  const [runtimeConfig, setRuntimeConfig] = useState<ConfigData["runtime"] | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [deployedSpecIds, setDeployedSpecIds] = useState<Set<string>>(new Set());
  const [batchRun, setBatchRun] = useState<BatchRunState>(INITIAL_BATCH_RUN);
  const [itemStates, setItemStates] = useState<Record<string, ProvisionItemState>>({});
  const [graphBoardNodes, setGraphBoardNodes] = useState<GraphBoardNodeState[]>([]);
  const [graphRunState, setGraphRunState] = useState<GraphRunState | null>(null);
  const [planState, setPlanState] = useState<ProvisionPlanState>({
    loading: false,
    plan: null,
    warnings: [],
    error: "",
  });
  const [planRefreshNonce, setPlanRefreshNonce] = useState(0);
  const [batchSummary, setBatchSummary] = useState<BatchSummary | null>(null);
  const [recoveryStates, setRecoveryStates] = useState<Record<string, RecoveryState>>({});
  const [error, setError] = useState("");
  const [teamUsers, setTeamUsers] = useState<TeamUser[]>([]);
  const [teams, setTeams] = useState<TeamRegistryEntry[]>([]);
  const [selectedTeamSlug, setSelectedTeamSlug] = useState("");
  const [teamUsersState, setTeamUsersState] = useState<AuxiliaryDataState>("loading");
  const [orgTeams, setOrgTeams] = useState<{ id: number; name: string; handle: string }[]>([]);
  const [orgTeamsState, setOrgTeamsState] = useState<AuxiliaryDataState>("loading");
  const [selectedWorkspaceTeamId, setSelectedWorkspaceTeamId] = useState<number | null>(null);
  const [selectedAdminIds, setSelectedAdminIds] = useState<Set<number>>(new Set());
  const [adminDropdownOpen, setAdminDropdownOpen] = useState(false);
  const [adminSearch, setAdminSearch] = useState("");
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  const [orgMembersState, setOrgMembersState] = useState<AuxiliaryDataState>("loading");
  const [selectedRepoAdminUsernames, setSelectedRepoAdminUsernames] = useState<Set<string>>(new Set());
  const [repoAdminDropdownOpen, setRepoAdminDropdownOpen] = useState(false);
  const [repoAdminSearch, setRepoAdminSearch] = useState("");
  const [infraSetupRunning, setInfraSetupRunning] = useState(false);
  const [infraTeardownRunning, setInfraTeardownRunning] = useState(false);
  const [infraLog, setInfraLog] = useState<string[]>([]);
  const [infraError, setInfraError] = useState("");
  const [infraRunUrl, setInfraRunUrl] = useState("");
  const [infraResourceModalOpen, setInfraResourceModalOpen] = useState(false);
  const [registerTeamModalOpen, setRegisterTeamModalOpen] = useState(false);
  const [infraResourceModalLoading, setInfraResourceModalLoading] = useState(false);
  const [infraResourceModalError, setInfraResourceModalError] = useState("");
  const [infraResourceModalData, setInfraResourceModalData] = useState<ResourceInventory | null>(null);
  const [systemEnvs, setSystemEnvs] = useState<Array<{ id: string; name: string; slug: string }>>([]);
  const [systemEnvState, setSystemEnvState] = useState<AuxiliaryDataState>("loading");
  const [selectedEnvSlugs, setSelectedEnvSlugs] = useState<Set<string>>(new Set());
  const [isRefreshingEnvironments, setIsRefreshingEnvironments] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    description: string;
    onConfirm: () => void;
  } | null>(null);

  const adminTriggerRef = useRef<HTMLButtonElement>(null);
  const repoAdminTriggerRef = useRef<HTMLButtonElement>(null);
  const adminMenuRef = useMenuKeyboardNav(adminDropdownOpen, () => setAdminDropdownOpen(false), adminTriggerRef);
  const repoAdminMenuRef = useMenuKeyboardNav(repoAdminDropdownOpen, () => setRepoAdminDropdownOpen(false), repoAdminTriggerRef);

  const adminDropdownRef = useRef<HTMLDivElement>(null);
  const repoAdminDropdownRef = useRef<HTMLDivElement>(null);
  const adminSearchRef = useRef<HTMLInputElement>(null);
  const repoAdminSearchRef = useRef<HTMLInputElement>(null);
  const infraResourceCloseButtonRef = useRef<HTMLButtonElement | null>(null);

  const ecsRuntime = runtimeConfig?.ecs_service;
  const k8sWorkspaceRuntime = runtimeConfig?.k8s_workspace;
  const k8sDiscoveryRuntime = runtimeConfig?.k8s_discovery;
  const ecsUnavailableReason = ecsRuntime?.available ? "" : (ecsRuntime?.unavailableReason || "ECS runtime unavailable");
  const k8sWorkspaceUnavailableReason = k8sWorkspaceRuntime?.available
    ? ""
    : (k8sWorkspaceRuntime?.unavailableReason || "Kubernetes workspace mode unavailable");
  const k8sDiscoveryUnavailableReason = k8sDiscoveryRuntime?.available
    ? ""
    : (k8sDiscoveryRuntime?.unavailableReason || "Kubernetes discovery mode unavailable");
  const graphModeAvailable = Boolean(k8sWorkspaceRuntime?.available || k8sDiscoveryRuntime?.available);
  const ecsRemaining = ecsRuntime?.remainingServices ?? 0;
  const ecsHasActiveServices = (ecsRuntime?.activeServices ?? 0) > 0;
  const k8sDiscoverySharedInfraActive = k8sDiscoveryRuntime?.sharedInfraActive === true;
  const k8sDiscoveryActiveServices = k8sDiscoveryRuntime?.activeServices ?? 0;
  const k8sDiscoveryHasActiveServices = k8sDiscoveryActiveServices > 0;
  const infraMode = runtimeMode === "k8s_discovery" ? "k8s_discovery" : "ecs_service";
  const infraSetupEndpoint = infraMode === "k8s_discovery" ? "/api/infra/k8s-discovery/setup" : "/api/infra/setup";
  const infraTeardownEndpoint = infraMode === "k8s_discovery"
    ? "/api/infra/k8s-discovery/teardown"
    : "/api/infra/teardown";
  const infraResourcesEndpoint = infraMode === "k8s_discovery"
    ? "/api/infra/resources?component=k8s_discovery_shared"
    : "/api/infra/resources";
  const graphModeSupported = supportsGraphDeploymentMode(runtimeMode);

  const pushInfraLog = useCallback((message: string) => {
    if (!message) return;
    setInfraLog((prev) => [...prev.slice(-7), message]);
  }, []);

  const refreshRuntimeConfig = useCallback(async () => {
    try {
      const params = selectedTeamSlug ? `?team_slug=${encodeURIComponent(selectedTeamSlug)}` : "";
      const configResp = await fetch(`/api/config${params}`);
      const configData = await configResp.json() as ConfigData;
      setRuntimeConfig(configData.runtime || null);
    } catch {
      // ignore
    }
  }, [selectedTeamSlug]);

  const closeInfraResourceModal = useCallback(() => {
    setInfraResourceModalOpen(false);
    setInfraResourceModalLoading(false);
    setInfraResourceModalError("");
    setInfraResourceModalData(null);
  }, []);

  const selectedSpecs = useMemo(
    () => specs.filter((spec) => selectedSpecIds.has(spec.id)),
    [selectedSpecIds]
  );
  const graphRootSpec = selectedSpecs[0] || null;
  const singleModePreviewEligible = deploymentMode === "single" && selectedSpecs.length === 1;
  const graphPreviewEligible = deploymentMode === "graph" && selectedSpecs.length === 1 && graphModeSupported;
  const selectedEnvList = useMemo(
    () => deriveSelectedEnvList(selectedEnvSlugs),
    [selectedEnvSlugs],
  );

  const orderedItemStates = useMemo(() => {
    return Object.values(itemStates).sort((a, b) =>
      specs.findIndex((spec) => spec.id === a.spec.id) - specs.findIndex((spec) => spec.id === b.spec.id)
    );
  }, [itemStates]);
  const graphBoardCounts = useMemo(() => {
    return graphBoardNodes.reduce((acc, node) => {
      if (
        node.status === "completed"
        || node.status === "reused"
        || node.status === "attached"
        || node.status === "skipped"
      ) acc.completed += 1;
      if (node.status === "reused") acc.reused += 1;
      if (node.status === "attached") acc.attached += 1;
      if (node.status === "completed") acc.provisioned += 1;
      if (node.status === "failed") {
        acc.failed += 1;
        acc.completed += 1;
      }
      if (node.status === "running") acc.running += 1;
      return acc;
    }, { completed: 0, reused: 0, attached: 0, provisioned: 0, failed: 0, running: 0 });
  }, [graphBoardNodes]);
  const blockedGraphNodes = useMemo(
    () => deploymentMode === "graph"
      ? buildBlockedGraphNodeDetails(planState.plan, deployments, specs)
      : [],
    [deploymentMode, deployments, planState.plan],
  );
  const blockedGraphTargets = useMemo(
    () => collectBlockedGraphTeardownTargets(blockedGraphNodes),
    [blockedGraphNodes],
  );
  const blockedGraphRunning = useMemo(
    () => blockedGraphTargets.some((target) => recoveryStates[target.spec_id]?.status === "running"),
    [blockedGraphTargets, recoveryStates],
  );
  const currentActiveTeam = useMemo(
    () => teams.find((t) => t.slug === (selectedTeamSlug || teams[0]?.slug)),
    [selectedTeamSlug, teams],
  );

  useEffect(() => {
    document.title = "Provision | API Catalog Admin";
  }, []);

  const loadAbortRef = useRef<AbortController | null>(null);
  const recheckAbortRef = useRef<AbortController | null>(null);
  const [verifyingTeamSlug, setVerifyingTeamSlug] = useState<string | null>(null);

  useEffect(() => {
    if (!shouldTriggerRecheck(currentActiveTeam)) return;

    recheckAbortRef.current?.abort();
    const controller = new AbortController();
    recheckAbortRef.current = controller;

    setVerifyingTeamSlug(selectedTeamSlug);

    fetch(`/api/teams/registry/${encodeURIComponent(selectedTeamSlug)}/health/recheck`, {
      method: "POST",
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() as Promise<{ health: { status?: string; message?: string; checked_at?: string; blocked?: boolean } }> : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        setVerifyingTeamSlug((prev) => {
          if (prev !== selectedTeamSlug) return prev;
          setTeams((prevTeams) => mergeHealthIntoTeams(prevTeams, selectedTeamSlug, data.health));
          return null;
        });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setVerifyingTeamSlug(null);
      });

    return () => { controller.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- teams intentionally excluded to prevent infinite loop
  }, [currentActiveTeam, selectedTeamSlug]);

  const loadPageData = useCallback(async () => {
    // Cancel any in-flight load (e.g. when user switches team mid-fetch)
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const { signal } = controller;

    try {
      setFetchError("");
      setTeamUsersState("loading");
      setOrgMembersState("loading");
      setSystemEnvState("loading");

      const loadOptionalJson = async (url: string) => {
        try {
          const response = await fetch(url, { signal });
          if (!response.ok) return { ok: false as const, data: null };
          return { ok: true as const, data: await response.json() as Record<string, unknown> };
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") throw err;
          return { ok: false as const, data: null };
        }
      };

      const teamParams = selectedTeamSlug ? `?team_slug=${encodeURIComponent(selectedTeamSlug)}` : "";
      const [deploymentsData, configData, usersResult, sysEnvResult, orgMembersResult, registryResult] = await Promise.all([
        fetch("/api/deployments", { signal }).then((r) => r.json() as Promise<DeploymentsResponse>),
        fetch(`/api/config${teamParams}`, { signal }).then((r) => r.json() as Promise<ConfigData>).catch(() => ({} as ConfigData)),
        loadOptionalJson(`/api/users${teamParams}`),
        loadOptionalJson(`/api/system-envs${teamParams}`),
        loadOptionalJson("/api/github/org-members"),
        loadOptionalJson("/api/teams/registry"),
      ]);
      const registryData = registryResult.data as TeamsRegistryResponse | null;
      const registeredTeams = Array.isArray(registryData?.teams)
        ? registryData.teams as TeamRegistryEntry[]
        : [];
      setTeams(registeredTeams);
      if (!selectedTeamSlug && registeredTeams.length > 0) {
        setSelectedTeamSlug(registeredTeams[0].slug);
      }

      const deploymentList = Array.isArray(deploymentsData.deployments)
        ? deploymentsData.deployments as Deployment[]
        : [];
      setDeployments(deploymentList);
      const ids = new Set<string>(
        deploymentList
          .filter((d: Deployment) => d.status !== "failed")
          .map((d: Deployment) => d.spec_id)
      );
      setDeployedSpecIds(ids);
      const rt = configData.runtime || null;
      setRuntimeConfig(rt);

      // Restore persisted runtime mode
      try {
        const savedMode = localStorage.getItem(RUNTIME_MODE_STORAGE_KEY) as RuntimeMode | null;
        if (savedMode) {
          const isAvailable = (mode: RuntimeMode): boolean => {
            if (mode === "lambda") return true;
            if (mode === "ecs_service") return rt?.ecs_service?.available ?? false;
            if (mode === "k8s_workspace") return rt?.k8s_workspace?.available ?? false;
            if (mode === "k8s_discovery") return rt?.k8s_discovery?.available ?? false;
            return false;
          };
          if (isAvailable(savedMode)) setRuntimeMode(savedMode);
          else setRuntimeMode("lambda");
        }
      } catch { /* ignore storage errors */ }
      try {
        const savedDeploymentMode = localStorage.getItem(DEPLOYMENT_MODE_STORAGE_KEY) as DeploymentMode | null;
        if (savedDeploymentMode === "graph" || savedDeploymentMode === "single") {
          setDeploymentMode(coerceDeploymentMode(
            (localStorage.getItem(RUNTIME_MODE_STORAGE_KEY) as RuntimeMode | null) || "lambda",
            savedDeploymentMode,
          ));
        }
      } catch { /* ignore storage errors */ }

      const usersData = usersResult.data as TeamUsersResponse | null;
      const users = Array.isArray(usersData?.users) ? usersData.users as TeamUser[] : [];
      setTeamUsers(users);
      setTeamUsersState(!usersResult.ok ? "unavailable" : users.length > 0 ? "ready" : "empty");
      if (users.length > 0) {
        try {
          const stored = localStorage.getItem(ADMIN_STORAGE_KEY);
          if (stored) {
            const storedIds = JSON.parse(stored) as number[];
            const validIds = new Set(users.map((u) => u.id));
            const filtered = storedIds.filter((id) => validIds.has(id));
            if (filtered.length > 0) setSelectedAdminIds(new Set(filtered));
            else setSelectedAdminIds(new Set());
          }
        } catch { /* ignore parse errors */ }
      } else {
        setSelectedAdminIds(new Set());
      }

      const membersData = orgMembersResult.data as OrgMembersResponse | null;
      const members = Array.isArray(membersData?.members) ? membersData.members as OrgMember[] : [];
      setOrgMembers(members);
      setOrgMembersState(!orgMembersResult.ok ? "unavailable" : members.length > 0 ? "ready" : "empty");
      if (members.length > 0) {
        try {
          const stored = localStorage.getItem(REPO_ADMINS_STORAGE_KEY);
          if (stored) {
            const storedLogins = JSON.parse(stored) as string[];
            const validLogins = new Set(members.map((m) => m.login));
            const filtered = storedLogins.filter((login) => validLogins.has(login));
            if (filtered.length > 0) setSelectedRepoAdminUsernames(new Set(filtered));
            else setSelectedRepoAdminUsernames(new Set());
          }
        } catch { /* ignore parse errors */ }
      } else {
        setSelectedRepoAdminUsernames(new Set());
      }

      const systemEnvsData = sysEnvResult.data as SystemEnvironmentsResponse | null;
      const envs = Array.isArray(systemEnvsData?.system_environments)
        ? systemEnvsData.system_environments as Array<{ id: string; name: string; slug: string }>
        : [];
      setSystemEnvs(envs);
      setSystemEnvState(!sysEnvResult.ok ? "unavailable" : envs.length > 0 ? "ready" : "empty");
      setSelectedEnvSlugs(new Set(envs.map((e: { slug: string }) => e.slug)));

      // Always fetch sub-teams to auto-detect org-mode accounts
      const activeTeam = registeredTeams.find((t) => t.slug === (selectedTeamSlug || registeredTeams[0]?.slug));
      setOrgTeamsState("loading");
      const orgTeamsResult = await loadOptionalJson(`/api/teams${teamParams}`);
      const orgTeamsData = orgTeamsResult.data as OrgTeamsResponse | null;
      const orgTeamsList = Array.isArray(orgTeamsData?.teams) ? orgTeamsData.teams as { id: number; name: string; handle: string }[] : [];
      setOrgTeams(orgTeamsList);
      // Show sub-team dropdown when multiple teams exist (org-mode auto-detection)
      const isOrgMode = orgTeamsList.length > 1;
      setOrgTeamsState(!orgTeamsResult.ok ? "unavailable" : isOrgMode ? "ready" : "empty");

      if (isOrgMode) {
        const registeredTeamId = activeTeam ? parseInt(activeTeam.team_id, 10) : 13347347; // Default to org ID if fallback
        if (orgTeamsList.find((t) => t.id === registeredTeamId)) {
          setSelectedWorkspaceTeamId(registeredTeamId);
        } else if (registeredTeamId === 13347347 && orgTeamsList.find((t) => t.id === 132109)) {
          // If it's the known org ID (from fallback or explicit selection) and the demo squad exists, prioritize it
          setSelectedWorkspaceTeamId(132109);
        } else if (orgTeamsList.length > 0) {
          setSelectedWorkspaceTeamId(orgTeamsList[0].id);
        } else {
          setSelectedWorkspaceTeamId(null);
        }
      } else {
        setSelectedWorkspaceTeamId(null);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error(err);
      setFetchError(err instanceof Error ? err.message : "Failed to load data");
    }
  }, [selectedTeamSlug]);

  useEffect(() => {
    void loadPageData();
  }, [loadPageData]);

  const refreshSystemEnvironments = useCallback(async () => {
    if (isRefreshingEnvironments || batchRun.running) return;
    setIsRefreshingEnvironments(true);
    setSystemEnvState("loading");
    try {
      const params = selectedTeamSlug ? `?team_slug=${encodeURIComponent(selectedTeamSlug)}` : "";
      const response = await fetch(`/api/system-envs/refresh${params}`, { method: "POST" });
      if (!response.ok) throw new Error("Failed to refresh system environments");
      const data = await response.json() as SystemEnvironmentsResponse;
      const envs = Array.isArray(data.system_environments)
        ? data.system_environments as Array<{ id: string; name: string; slug: string }>
        : [];
      setSystemEnvs(envs);
      setSystemEnvState(envs.length > 0 ? "ready" : "empty");
      setSelectedEnvSlugs((prev) => {
        const next = new Set<string>();
        for (const e of envs) {
          if (prev.has(e.slug)) next.add(e.slug);
        }
        if (next.size === 0) {
          for (const e of envs) next.add(e.slug);
        }
        return next;
      });
    } catch (err) {
      console.error(err);
      setSystemEnvState("unavailable");
    } finally {
      setIsRefreshingEnvironments(false);
    }
  }, [isRefreshingEnvironments, batchRun.running, selectedTeamSlug]);

  const startInfraSetup = useCallback(async () => {
    if (infraSetupRunning || infraTeardownRunning || batchRun.running) return;

    setInfraSetupRunning(true);
    setInfraError("");
    setInfraRunUrl("");
    setInfraLog([]);

    try {
      const response = await fetch(infraSetupEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ team_slug: selectedTeamSlug || undefined }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as ErrorResponse;
        const message = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
        throw new Error(message);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("No response stream");

      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6)) as ProgressEvent;
          pushInfraLog(event.message);
          const runUrl = event.data?.run_url;
          if (typeof runUrl === "string" && runUrl) {
            setInfraRunUrl(runUrl);
          }
          if (event.status === "error") {
            throw new Error(event.message || "Infrastructure setup failed");
          }
        }
      }

      await refreshRuntimeConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Infrastructure setup failed";
      setInfraError(message);
      pushInfraLog(message);
    } finally {
      setInfraSetupRunning(false);
    }
  }, [
    batchRun.running,
    infraSetupEndpoint,
    infraSetupRunning,
    infraTeardownRunning,
    pushInfraLog,
    refreshRuntimeConfig,
    selectedTeamSlug,
  ]);

  const startInfraTeardown = useCallback(async () => {
    if (infraSetupRunning || infraTeardownRunning || batchRun.running) return;

    setInfraTeardownRunning(true);
    setInfraError("");
    setInfraRunUrl("");
    setInfraLog([]);

    try {
      const response = await fetch(infraTeardownEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ team_slug: selectedTeamSlug || undefined }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as ErrorResponse;
        const message = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
        throw new Error(message);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("No response stream");

      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6)) as ProgressEvent;
          pushInfraLog(event.message);
          const runUrl = event.data?.run_url;
          if (typeof runUrl === "string" && runUrl) {
            setInfraRunUrl(runUrl);
          }
          if (event.status === "error") {
            throw new Error(event.message || "Infrastructure teardown failed");
          }
        }
      }

      await refreshRuntimeConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Infrastructure teardown failed";
      setInfraError(message);
      pushInfraLog(message);
    } finally {
      setInfraTeardownRunning(false);
    }
  }, [
    batchRun.running,
    infraSetupRunning,
    infraTeardownEndpoint,
    infraTeardownRunning,
    pushInfraLog,
    refreshRuntimeConfig,
    selectedTeamSlug,
  ]);

  const openInfraResourceModal = useCallback(async () => {
    setInfraResourceModalOpen(true);
    setInfraResourceModalLoading(true);
    setInfraResourceModalError("");
    setInfraResourceModalData(null);

    try {
      const response = await fetch(infraResourcesEndpoint);
      const body = await response.json().catch(() => ({})) as ResourceInventoryResponse;
      if (!response.ok) {
        const message = typeof body.error === "string" ? body.error : `Resource lookup failed (${response.status})`;
        throw new Error(message);
      }
      const resource = body.resource;
      if (!resource) {
        throw new Error("No infrastructure resources are currently recorded");
      }
      setInfraResourceModalData(resource);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load resources";
      setInfraResourceModalError(message);
    } finally {
      setInfraResourceModalLoading(false);
    }
  }, [infraResourcesEndpoint]);

  const toggleAdminUser = useCallback((userId: number) => {
    setSelectedAdminIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }, []);

  const toggleRepoAdmin = useCallback((login: string) => {
    setSelectedRepoAdminUsernames((prev) => {
      const next = new Set(prev);
      if (next.has(login)) next.delete(login);
      else next.add(login);
      return next;
    });
  }, []);

  // Persist workspace admin selections
  useEffect(() => {
    if (teamUsers.length === 0) return;
    try {
      localStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(Array.from(selectedAdminIds)));
    } catch { /* ignore storage errors */ }
  }, [selectedAdminIds, teamUsers]);

  // Persist repo admin selections
  useEffect(() => {
    if (orgMembers.length === 0) return;
    try {
      localStorage.setItem(REPO_ADMINS_STORAGE_KEY, JSON.stringify(Array.from(selectedRepoAdminUsernames)));
    } catch { /* ignore storage errors */ }
  }, [selectedRepoAdminUsernames, orgMembers]);

  // Persist runtime mode selection
  useEffect(() => {
    try {
      localStorage.setItem(RUNTIME_MODE_STORAGE_KEY, runtimeMode);
    } catch { /* ignore storage errors */ }
  }, [runtimeMode]);

  useEffect(() => {
    try {
      localStorage.setItem(DEPLOYMENT_MODE_STORAGE_KEY, deploymentMode);
    } catch { /* ignore storage errors */ }
  }, [deploymentMode]);

  // Focus search input when workspace admin dropdown opens; clear on close
  useEffect(() => {
    if (adminDropdownOpen) {
      adminSearchRef.current?.focus();
    } else {
      setAdminSearch("");
    }
  }, [adminDropdownOpen]);

  // Focus search input when repo admin dropdown opens; clear on close
  useEffect(() => {
    if (repoAdminDropdownOpen) {
      repoAdminSearchRef.current?.focus();
    } else {
      setRepoAdminSearch("");
    }
  }, [repoAdminDropdownOpen]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (adminDropdownRef.current && !adminDropdownRef.current.contains(e.target as Node)) {
        setAdminDropdownOpen(false);
      }
      if (repoAdminDropdownRef.current && !repoAdminDropdownRef.current.contains(e.target as Node)) {
        setRepoAdminDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!infraResourceModalOpen) return;
      closeInfraResourceModal();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeInfraResourceModal, infraResourceModalOpen]);

  useEffect(() => {
    if (!infraResourceModalOpen) return;
    infraResourceCloseButtonRef.current?.focus();
  }, [infraResourceModalOpen]);

  useEffect(() => {
    setDeploymentMode((current) => coerceDeploymentMode(runtimeMode, current));
  }, [runtimeMode]);

  useEffect(() => {
    if (runtimeMode === "k8s_discovery" && !k8sDiscoveryWorkspaceLink && connectPostman) {
      setConnectPostman(false);
    }
  }, [connectPostman, k8sDiscoveryWorkspaceLink, runtimeMode]);

  // Auto-enable workspace linking when k8s_workspace is selected --
  // workspace mode always runs postman_bootstrap.
  useEffect(() => {
    if (runtimeMode === "k8s_workspace") {
      setConnectPostman(true);
    }
  }, [runtimeMode]);

  useEffect(() => {
    setSelectedSpecIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (!deployedSpecIds.has(id)) next.add(id);
      }
      return ensureSingleRootSelection(next, deploymentMode);
    });
  }, [deploymentMode, deployedSpecIds]);

  useEffect(() => {
    setSelectedSpecIds((prev) => ensureSingleRootSelection(prev, deploymentMode));
  }, [deploymentMode]);

  useEffect(() => {
    const previewEnabled = graphPreviewEligible || singleModePreviewEligible;
    void planRefreshNonce;
    if (!previewEnabled || !graphRootSpec) {
      setPlanState({ loading: false, plan: null, warnings: [], error: "" });
      return;
    }

    const controller = new AbortController();
    setPlanState((current) => ({
      loading: true,
      plan: current.plan?.root_spec_id === graphRootSpec.id ? current.plan : null,
      warnings: [],
      error: "",
    }));

    void (async () => {
      try {
        const response = await fetch("/api/provision/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            spec_source: graphRootSpec.id,
            runtime: runtimeMode,
            environments: selectedEnvList,
            deployment_mode: deploymentMode,
          }),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({})) as ProvisionPlanErrorResponse;
        if (!response.ok) {
          throw new Error(typeof payload.error === "string" ? payload.error : `Plan request failed (${response.status})`);
        }
        const planResponse = payload as ProvisionPlanResponse;
        setPlanState({
          loading: false,
          plan: planResponse.plan,
          warnings: Array.isArray(planResponse.warnings) ? planResponse.warnings.filter((warning): warning is string => typeof warning === "string") : [],
          error: "",
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        setPlanState({
          loading: false,
          plan: null,
          warnings: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return () => controller.abort();
  }, [deploymentMode, graphPreviewEligible, graphRootSpec, planRefreshNonce, runtimeMode, selectedEnvList, singleModePreviewEligible]);

  const handleIndustryChange = (industryId: string) => {
    if (industryId === selectedIndustry) return;
    setSelectedIndustry(industryId);
    setSelectedSpecIds(new Set());
  };

  const toggleSelect = (spec: RegistryEntry) => {
    if (batchRun.running || deployedSpecIds.has(spec.id)) return;

    setSelectedSpecIds((prev) => applySelectionToggle(prev, spec.id, deploymentMode));
  };

  const selectVisible = (visibleSpecs: RegistryEntry[]) => {
    if (batchRun.running) return;

    const visibleIds = visibleSpecs
      .filter((spec) => !deployedSpecIds.has(spec.id))
      .map((spec) => spec.id);
    setSelectedSpecIds((prev) => applyVisibleSelection(prev, visibleIds, deploymentMode));
  };

  const handleDeploymentModeChange = useCallback((nextMode: DeploymentMode) => {
    if (batchRun.running) return;
    if (nextMode === "graph") {
      const preferredGraphRuntime = (currentRuntime: RuntimeMode) => {
        if (currentRuntime === "k8s_discovery" && k8sDiscoveryRuntime?.available) return "k8s_discovery" as const;
        if (currentRuntime === "k8s_workspace" && k8sWorkspaceRuntime?.available) return "k8s_workspace" as const;
        if (k8sWorkspaceRuntime?.available) return "k8s_workspace" as const;
        if (k8sDiscoveryRuntime?.available) return "k8s_discovery" as const;
        return null;
      };

      const nextRuntime = preferredGraphRuntime(runtimeMode);
      if (!nextRuntime) {
        return;
      }

      setRuntimeMode(nextRuntime);
      setDeploymentMode("graph");
      return;
    }
    setDeploymentMode("single");
  }, [batchRun.running, k8sDiscoveryRuntime?.available, k8sWorkspaceRuntime?.available, runtimeMode]);

  const clearSelection = () => {
    if (batchRun.running) return;
    setSelectedSpecIds(new Set());
  };

  const updateItemState = useCallback((specId: string, updater: (current: ProvisionItemState) => ProvisionItemState) => {
    setItemStates((prev) => {
      const current = prev[specId];
      if (!current) return prev;
      return {
        ...prev,
        [specId]: updater(current),
      };
    });
  }, []);

  const executeRecovery = useCallback(async (specId: string, repoName: string) => {
    setRecoveryStates((prev) => ({
      ...prev,
      [specId]: {
        status: "running",
        message: "Running teardown recovery...",
      },
    }));

    try {
      const response = await fetch("/api/teardown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_name: repoName }),
      });
      await readTeardownStream(response);

      setRecoveryStates((prev) => ({
        ...prev,
        [specId]: {
          status: "success",
          message: "Recovery complete. Retry provisioning for this spec.",
        },
      }));
      updateItemState(specId, (current) => ({
        ...current,
        message: "Recovery complete. Retry provisioning for this spec.",
      }));
      await Promise.all([loadPageData(), refreshRuntimeConfig()]);
      setPlanRefreshNonce((current) => current + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Recovery failed";
      setRecoveryStates((prev) => ({
        ...prev,
        [specId]: {
          status: "error",
          message,
        },
      }));
    }
  }, [loadPageData, refreshRuntimeConfig, updateItemState]);

  const recoverFailedSpec = useCallback((specId: string) => {
    if (batchRun.running) return;
    const spec = specs.find((candidate) => candidate.id === specId);
    if (!spec) return;

    setConfirmAction({
      title: `Run teardown recovery for ${spec.repo_name}?`,
      description: "This removes discovered GitHub, Postman, and AWS artifacts for this service name.",
      onConfirm: () => {
        setConfirmAction(null);
        void executeRecovery(specId, spec.repo_name);
      },
    });
  }, [batchRun.running, executeRecovery]);

  const executeBlockedGraphRecovery = useCallback(async () => {
    if (batchRun.running || blockedGraphTargets.length === 0) return;

    setError("");
    setRecoveryStates((prev) => {
      const next = { ...prev };
      for (const target of blockedGraphTargets) {
        next[target.spec_id] = {
          status: "running",
          message: "Running teardown recovery...",
        };
      }
      return next;
    });

    const specIdByProject = new Map(blockedGraphTargets.map((target) => [target.project_name, target.spec_id]));

    try {
      const response = await fetch("/api/teardown/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: blockedGraphTargets }),
      });

      const completeData = await readBatchTeardownStream(response, (event) => {
        if (!event.project || event.project === "__batch__") return;
        const specId = event.spec_id || specIdByProject.get(event.project);
        if (!specId) return;

        if (event.status === "running") {
          setRecoveryStates((prev) => ({
            ...prev,
            [specId]: {
              status: "running",
              message: event.message || "Running teardown recovery...",
            },
          }));
        }

        if (event.status === "error") {
          setRecoveryStates((prev) => ({
            ...prev,
            [specId]: {
              status: "error",
              message: event.message || "Recovery failed",
            },
          }));
        }
      });

      const failures: string[] = [];
      for (const result of completeData.results) {
        const projectName = String(result.project_name || "").trim();
        const specId = String(result.spec_id || "").trim() || (projectName ? specIdByProject.get(projectName) : "");
        if (!specId) continue;

        if (result.success) {
          setRecoveryStates((prev) => ({
            ...prev,
            [specId]: {
              status: "success",
              message: "Recovery complete. Refreshing graph preview...",
            },
          }));
          continue;
        }

        failures.push(specId);
        setRecoveryStates((prev) => ({
          ...prev,
          [specId]: {
            status: "error",
            message: result.error || "Recovery failed",
          },
        }));
      }

      await Promise.all([loadPageData(), refreshRuntimeConfig()]);
      setPlanRefreshNonce((current) => current + 1);

      if (failures.length > 0) {
        setError("Some blocked service teardowns failed. Review the status and retry.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Blocked service teardown failed";
      setRecoveryStates((prev) => {
        const next = { ...prev };
        for (const target of blockedGraphTargets) {
          next[target.spec_id] = {
            status: "error",
            message,
          };
        }
        return next;
      });
      setError(message);
    }
  }, [batchRun.running, blockedGraphTargets, loadPageData, refreshRuntimeConfig]);

  const recoverBlockedGraphServices = useCallback(() => {
    if (batchRun.running || blockedGraphTargets.length === 0) return;

    const serviceCount = blockedGraphTargets.length;
    const nodeCount = blockedGraphNodes.length;
    setConfirmAction({
      title: `Run teardown for ${serviceCount} blocked service${serviceCount === 1 ? "" : "s"}?`,
      description: `${nodeCount} blocked node${nodeCount === 1 ? "" : "s"} will be resolved by tearing down ${serviceCount} service${serviceCount === 1 ? "" : "s"}. The graph preview will refresh afterward.`,
      onConfirm: () => {
        setConfirmAction(null);
        void executeBlockedGraphRecovery();
      },
    });
  }, [batchRun.running, blockedGraphNodes.length, blockedGraphTargets.length, executeBlockedGraphRecovery]);

  const runSingleProvision = async (spec: RegistryEntry): Promise<{ ok: boolean; message?: string }> => {
    updateItemState(spec.id, (current) => ({
      ...current,
      status: "running",
      phase: "prepare",
      message: "Preparing registry spec...",
    }));

    try {
      const response = await fetch("/api/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildLaunchRequestBody({
          spec,
          runtimeMode,
          deploymentMode: "single",
          selectedEnvSlugs,
          connectPostman,
          environmentSyncEnabled,
          chaosEnabled,
          chaosConfig,
          selectedAdminIds,
          selectedRepoAdminUsernames,
          k8sDiscoveryWorkspaceLink,
          teamSlug: selectedTeamSlug,
          workspaceTeamId: selectedWorkspaceTeamId,
          workspaceTeamName: orgTeams.find(t => t.id === selectedWorkspaceTeamId)?.name,
        })),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({})) as Record<string, unknown>;
        const message = typeof err.error === "string" ? err.error : `HTTP ${response.status}`;
        throw new Error(message);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error("No response stream");
      }

      let buffer = "";
      let completed = false;
      let streamError = "";
      let resultData: Record<string, unknown> | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;

          try {
            const event = JSON.parse(line.slice(6)) as ProgressEvent;
            const eventRunUrl = typeof event.data?.run_url === "string" ? event.data.run_url : undefined;
            updateItemState(spec.id, (current) => ({
              ...current,
              status: event.status === "error" ? "error" : current.status,
              phase: event.phase,
              message: event.message,
              events: [...current.events, event],
              runUrl: eventRunUrl || current.runUrl,
            }));

            if (event.status === "error") {
              streamError = event.message || "Provisioning failed";
            }

            if (event.phase === "complete" && event.status === "complete" && event.data) {
              completed = true;
              resultData = event.data;
            }
          } catch {
            // Skip malformed SSE events
          }
        }
      }

      if (streamError) {
        throw new Error(streamError);
      }

      if (!completed) {
        throw new Error("Provisioning did not complete");
      }

      updateItemState(spec.id, (current) => ({
        ...current,
        status: "success",
        phase: "complete",
        message: "Provisioning complete",
        result: resultData,
        error: "",
      }));

      setDeployedSpecIds((prev) => new Set([...prev, spec.id]));
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateItemState(spec.id, (current) => ({
        ...current,
        status: "error",
        phase: current.phase || "error",
        message,
        error: message,
      }));
      return { ok: false, message };
    }
  };

  const executeGraphProvision = async (rootSpec: RegistryEntry, plan: ProvisionPlan) => {
    const initialNodes = buildInitialGraphBoardNodes(plan);
    setError("");
    setBatchSummary(null);
    setRecoveryStates({});
    setItemStates({});
    setGraphRunState(null);
    setGraphBoardNodes(initialNodes);
    setActiveBoardMode("graph");
    setBatchRun({
      running: true,
      total: initialNodes.length,
      queued: initialNodes.length,
      inFlight: 0,
      completed: 0,
      success: 0,
      failed: 0,
    });

    try {
      const launchBody = buildLaunchRequestBody({
        spec: rootSpec,
        runtimeMode,
        deploymentMode: "graph",
        selectedEnvSlugs,
        connectPostman,
        environmentSyncEnabled,
        chaosEnabled,
        chaosConfig,
        selectedAdminIds,
        selectedRepoAdminUsernames,
        k8sDiscoveryWorkspaceLink,
        teamSlug: selectedTeamSlug,
        workspaceTeamId: selectedWorkspaceTeamId,
        workspaceTeamName: orgTeams.find(t => t.id === selectedWorkspaceTeamId)?.name,
      });

      const createResp = await fetch("/api/provision/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(launchBody),
      });

      if (!createResp.ok) {
        const err = await createResp.json().catch(() => ({})) as ErrorResponse;
        throw new Error(typeof err.error === "string" ? err.error : `HTTP ${createResp.status}`);
      }

      const { instance_id } = (await createResp.json()) as GraphCreateResponse;

      setGraphRunState({
        deploymentGroupId: instance_id,
        deploymentRootSpecId: rootSpec.id,
      });

      const POLL_INTERVAL = 5000;
      const MAX_POLL_DURATION = 45 * 60 * 1000;
      const startTime = Date.now();
      let terminated = false;

      while (!terminated && Date.now() - startTime < MAX_POLL_DURATION) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));

        let progress: Record<string, unknown>;
        try {
          const statusResp = await fetch(`/api/provision/graph/${instance_id}`);
          if (!statusResp.ok) continue;
          progress = (await statusResp.json()) as Record<string, unknown>;
        } catch {
          continue;
        }

        const wfStatus = String(progress.workflow_status || "running");
        const graphStatus = String(progress.status || "running");
        const completedNodes = (progress.completed_nodes || []) as string[];
        const failedNode = progress.failed_node as string | null;
        const failedMessage = progress.failed_message as string | null;
        const currentNode = progress.current_node as string | null;
        const runUrls = (progress.run_urls || {}) as Record<string, string>;

        setGraphRunState((current) => ({
          ...current,
          deploymentGroupId: instance_id,
          deploymentRootSpecId: rootSpec.id,
          error: failedMessage || current?.error,
        }));

        setGraphBoardNodes((current) => {
          const updated = [...current];
          for (const node of updated) {
            const nodeKey = `${node.spec_id}/${node.environment}`;
            if (runUrls[nodeKey]) {
              node.runUrl = runUrls[nodeKey];
            }
            if (completedNodes.includes(`${nodeKey}:reused`)) {
              node.status = "reused";
              node.message = "Reused existing deployment";
            } else if (completedNodes.includes(`${nodeKey}:attached`)) {
              node.status = "attached";
              node.message = "Attached existing deployment";
            } else if (completedNodes.includes(nodeKey)) {
              node.status = "completed";
              node.message = "Provisioned";
            } else if (nodeKey === failedNode) {
              node.status = "failed";
              node.message = failedMessage || "Failed";
            } else if (currentNode === nodeKey) {
              node.status = "running";
              node.message = "Provisioning";
            }
          }
          return updated;
        });

        const completedCount = new Set(
          completedNodes.map((entry) => entry.replace(/:(reused|attached)$/, "")),
        ).size;
        const failedCount = failedNode ? 1 : 0;
        setBatchRun((prev) => ({
          ...prev,
          completed: completedCount + failedCount,
          success: completedCount,
          failed: failedCount,
          inFlight: currentNode ? 1 : 0,
          queued: Math.max(0, prev.total - completedCount - failedCount - (currentNode ? 1 : 0)),
        }));

        if (graphStatus === "complete" || wfStatus === "complete") {
          terminated = true;
          setDeployedSpecIds((prev) => new Set([...prev, ...plan.hard_closure_spec_ids]));
          setSelectedSpecIds(new Set([rootSpec.id]));
        } else if (graphStatus === "error" || wfStatus === "errored" || wfStatus === "terminated") {
          terminated = true;
          throw new Error(failedMessage || "Graph provisioning failed");
        }
      }

      if (!terminated) {
        throw new Error("Graph provisioning timed out after 45 minutes");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Provisioning failed";
      setGraphRunState((current) => ({
        ...current,
        error: message,
      }));
      setError(message);
    } finally {
      setBatchRun((prev) => ({
        ...prev,
        running: false,
        total: initialNodes.length || prev.total,
      }));
    }
  };

  const startBatchProvision = async () => {
    if (!selectedSpecs.length || batchRun.running) return;

    if (currentActiveTeam) {
      try {
        const testResp = await fetch("/api/teams/registry");
        if (testResp.ok) {
           const data = await testResp.json() as { teams: TeamRegistryEntry[] };
           const refreshedTeam = data.teams.find(t => t.team_id === currentActiveTeam.team_id);
           if (refreshedTeam && refreshedTeam.provisioning_blocked) {
             setError(refreshedTeam.health_message || "Credential health check failed. Fix credentials in Settings before provisioning.");
             return;
           }
           if (refreshedTeam && (!refreshedTeam.has_api_key || !refreshedTeam.has_access_token)) {
             setError("Missing credentials. Please add an API Key and Access Token in the Team Registry before provisioning.");
             return;
           }
        }
      } catch (err) {
        // ignore pre-flight check failure, proceed to normal flow
      }
    }

    if (deploymentMode === "graph") {
      if (!graphModeSupported) {
        setError("Dependency graph deployment is available only for Kubernetes runtimes.");
        return;
      }
      if (selectedSpecs.length !== 1 || !graphRootSpec) {
        setError("Select exactly one root service for dependency graph deployment.");
        return;
      }
      if (!planState.plan) {
        setError(planState.error || "Wait for the dependency graph preview before provisioning.");
        return;
      }
      if (planState.plan.summary.blocked_count > 0) {
        setError("Resolve blocked graph nodes before provisioning this dependency graph.");
        return;
      }

      const summary = summarizeGraphSubmit(planState.plan);
      // Capture plan to avoid closure nullability issues
      const readyPlan = planState.plan;
      setConfirmAction({
        title: `Deploy ${graphRootSpec.title} with ${summary.additionalServices} dependenc${summary.additionalServices === 1 ? "y" : "ies"} on ${runtimeLabel(runtimeMode)}?`,
        description: `${summary.provisionCount} node${summary.provisionCount === 1 ? "" : "s"} will be provisioned, ${summary.attachCount} attached, and ${summary.reuseCount} reused across ${readyPlan.environments.length} environment${readyPlan.environments.length === 1 ? "" : "s"}.`,
        onConfirm: () => {
          setConfirmAction(null);
          void executeGraphProvision(graphRootSpec, readyPlan);
        },
      });
      return;
    }

    const count = selectedSpecs.length;
    if (runtimeMode === "ecs_service" && (!ecsRuntime?.available || count > ecsRemaining)) {
      const reason = !ecsRuntime?.available
        ? ecsUnavailableReason
        : `ECS has ${ecsRemaining} slot${ecsRemaining === 1 ? "" : "s"} remaining; reduce your selection.`;
      setError(reason);
      return;
    }
    if (runtimeMode === "k8s_workspace" && !k8sWorkspaceRuntime?.available) {
      setError(k8sWorkspaceUnavailableReason);
      return;
    }
    if (runtimeMode === "k8s_discovery" && !k8sDiscoveryRuntime?.available) {
      setError(k8sDiscoveryUnavailableReason);
      return;
    }
    const batchText = count > MAX_PARALLEL ? ` in batches of ${MAX_PARALLEL}` : "";
    setConfirmAction({
      title: `Provision ${count} selected service${count === 1 ? "" : "s"}${batchText} on ${runtimeLabel(runtimeMode)}?`,
      description: "This will create GitHub repos, Postman workspaces, and deploy to AWS.",
      onConfirm: () => {
        setConfirmAction(null);
        void executeBatchProvision();
      },
    });
  };

  const executeBatchProvision = async () => {
    setError("");
    setBatchSummary(null);
    setRecoveryStates({});
    setGraphBoardNodes([]);
    setGraphRunState(null);
    setActiveBoardMode("single");

    const initialStates: Record<string, ProvisionItemState> = {};
    for (const spec of selectedSpecs) {
      initialStates[spec.id] = {
        spec,
        status: "queued",
        phase: "queued",
        message: "Queued",
        events: [],
      };
    }
    setItemStates(initialStates);
    setBatchRun({
      running: true,
      total: selectedSpecs.length,
      queued: selectedSpecs.length,
      inFlight: 0,
      completed: 0,
      success: 0,
      failed: 0,
    });

    const failures: BatchFailure[] = [];
    const queue = [...selectedSpecs];
    let cursor = 0;

    const runWorker = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;

        if (index >= queue.length) return;

        const spec = queue[index];

        setBatchRun((prev) => ({
          ...prev,
          queued: Math.max(0, prev.queued - 1),
          inFlight: prev.inFlight + 1,
        }));

        const result = await runSingleProvision(spec);

        setBatchRun((prev) => ({
          ...prev,
          inFlight: Math.max(0, prev.inFlight - 1),
          completed: prev.completed + 1,
          success: prev.success + (result.ok ? 1 : 0),
          failed: prev.failed + (result.ok ? 0 : 1),
        }));

        if (!result.ok) {
          failures.push({
            specId: spec.id,
            title: spec.title,
            message: result.message || "Provisioning failed",
          });
        }
      }
    };

    const workerCount = Math.min(MAX_PARALLEL, queue.length);
    await Promise.all(
      Array.from({ length: workerCount }, (_, i) =>
        new Promise<void>((r) => setTimeout(r, i * STAGGER_DELAY_MS)).then(() => runWorker())
      )
    );

    setBatchRun((prev) => ({ ...prev, running: false, queued: 0, inFlight: 0 }));

    const summary: BatchSummary = {
      total: queue.length,
      success: queue.length - failures.length,
      failed: failures.length,
      failures,
    };
    setBatchSummary(summary);

    if (failures.length > 0) {
      setError("");
      setSelectedSpecIds(new Set(failures.map((failure) => failure.specId)));
    } else {
      setSelectedSpecIds(new Set());
    }
  };

  const resetBoard = () => {
    if (batchRun.running) return;
    setItemStates({});
    setGraphBoardNodes([]);
    setGraphRunState(null);
    setBatchSummary(null);
    setRecoveryStates({});
    setError("");
  };

  const infraResourceTitle = infraResourceModalData?.runtime_mode === "k8s_discovery"
    ? "Kubernetes Resources"
    : "AWS Resources";
  const infraResourceSubtitle = infraResourceModalData?.runtime_mode === "k8s_discovery"
    ? "Shared Kubernetes Discovery Infrastructure"
    : "Shared ECS Infrastructure";
  const renderedBoardMode = batchRun.running
    ? activeBoardMode
    : (graphBoardNodes.length > 0 ? "graph" : "single");
  const canResetBoard = renderedBoardMode === "graph"
    ? graphBoardNodes.length > 0
    : Object.keys(itemStates).length > 0;
  const normalizedRunUnits: RunUnit[] = useMemo(() => {
    if (renderedBoardMode === "graph") {
      return graphBoardNodes.map(mapGraphNodeToRunUnit);
    }
    return orderedItemStates.map((item) =>
      mapSseItemToRunUnit(
        {
          spec_id: item.spec.title, // Use title for display in single mode
          status: item.status,
          phase: item.phase,
          message: item.message,
          runUrl: item.runUrl,
          result: item.result,
          error: item.error,
        },
        PHASE_LABELS[item.phase] || item.phase
        )
    );
  }, [renderedBoardMode, graphBoardNodes, orderedItemStates]);
  const showExecutionTakeover = shouldShowExecutionTakeover({
    batchRunning: batchRun.running,
    renderedBoardMode,
    graphBoardNodeCount: graphBoardNodes.length,
    orderedItemCount: orderedItemStates.length,
  });
  const planReadyText = planState.loading
    ? "Calculating dependency graph..."
    : planState.error
      ? planState.error
      : planState.plan
        ? planState.warnings.length > 0
          ? "Plan ready with warnings"
          : "Dependency graph plan is ready"
        : "Select one root service to preview closure";
  const graphPrereqWarnings = planState.plan?.single_mode_guidance?.missing_hard_prerequisites ?? [];
  const workspaceSyncDisabledReason = runtimeMode === "k8s_discovery" && !k8sDiscoveryWorkspaceLink
    ? 'Enable "Create Postman Workspace" to turn on GitHub workspace sync for discovery mode.'
    : null;
  // Block launch when org-mode is detected (multiple sub-teams) or configured but no sub-team selected
  const orgModeRequiresSelection = (currentActiveTeam?.org_mode || orgTeams.length > 1) && selectedWorkspaceTeamId == null;
  const launchBlockedReason = batchRun.running
    ? "A provisioning run is already in progress."
    : selectedSpecs.length === 0
      ? "Select at least one service to enable provisioning."
      : orgModeRequiresSelection
        ? "This is an org-mode account. Select a workspace sub-team before launching."
        : deploymentMode === "graph" && selectedSpecs.length !== 1
          ? "Graph mode requires exactly one selected root service."
          : deploymentMode === "graph" && !graphRootSpec
            ? "Choose a valid root service before launching graph mode."
            : deploymentMode === "graph" && !planState.plan
              ? "Wait for the dependency graph plan to finish loading before launching."
              : deploymentMode === "graph" && planState.plan?.summary.blocked_count && planState.plan.summary.blocked_count > 0
                ? (graphPrereqWarnings.length > 0 ? `Missing dependency: ${graphPrereqWarnings[0].spec_id}` : "Resolve blocked dependency prerequisites before launching graph mode.")
                : deploymentMode === "single" && runtimeMode === "ecs_service" && !ecsRuntime?.available
                  ? ecsUnavailableReason
                  : deploymentMode === "single" && runtimeMode === "ecs_service" && selectedSpecs.length > ecsRemaining
                    ? `ECS only has capacity for ${ecsRemaining} more service${ecsRemaining === 1 ? "" : "s"}.`
                    : runtimeMode === "k8s_workspace" && !k8sWorkspaceRuntime?.available
                      ? k8sWorkspaceUnavailableReason
                      : runtimeMode === "k8s_discovery" && !k8sDiscoveryRuntime?.available
                        ? k8sDiscoveryUnavailableReason
                        : null;
  const launchActionDisabled =
    batchRun.running
    || selectedSpecs.length === 0
    || orgModeRequiresSelection
    || (deploymentMode === "graph" && (selectedSpecs.length !== 1 || !graphRootSpec || !planState.plan || planState.plan.summary.blocked_count > 0))
    || (deploymentMode === "single" && runtimeMode === "ecs_service" && (!ecsRuntime?.available || selectedSpecs.length > ecsRemaining))
    || (runtimeMode === "k8s_workspace" && !k8sWorkspaceRuntime?.available)
    || (runtimeMode === "k8s_discovery" && !k8sDiscoveryRuntime?.available);

  const handleStartProvision = () => {
    if (batchRun.running) return;
    if (launchBlockedReason) {
      setError(launchBlockedReason);
      return;
    }
    void startBatchProvision();
  };

  const toggleSystemEnvironment = useCallback((slug: string) => {
    setSelectedEnvSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) {
        if (next.size > 1) next.delete(slug);
      } else {
        next.add(slug);
      }
      return next;
    });
  }, []);

  const handleTeamRegistered = useCallback((slug: string) => {
    setRegisterTeamModalOpen(false);
    setSelectedTeamSlug(slug);
    void loadPageData();
  }, [loadPageData]);

  const provisionComplete = !batchRun.running && batchSummary !== null;
  const provisionRunning = batchRun.running;
  const specSelected = selectedSpecIds.size > 0;
  const showPlanStep = selectedSpecs.length === 1 && graphRootSpec !== null;
  const requestedStep = searchParams.get("step") || "";
  const provisionShellSteps = useMemo(() => {
    const isGraph = deploymentMode === "graph";
    
    // Abstract the verbose description here
    const configureSummary = (
      <StepRailMetadata>
        <StepRailMetaItem label="" value={isGraph ? "Graph" : "Independent"} />
        <StepRailMetaItem label="" value={runtimeLabel(runtimeMode).replace("Kubernetes", "K8s")} />
      </StepRailMetadata>
    );

    const targetSummary = specSelected ? (
      <StepRailMetadata>
        <StepRailMetaItem label="" value={`${selectedSpecs.length} spec${selectedSpecs.length === 1 ? "" : "s"}`} />
      </StepRailMetadata>
    ) : (
      "Choose the services to provision"
    );

    // Keep the plan summary text concise, shift blockers to the statusIcon
    const planSummary = planState.loading ? (
      "Preparing rollout guidance"
    ) : planState.plan ? (
      <StepRailMetadata>
        {isGraph ? (
          <>
            <StepRailMetaItem label="scope" value={planState.plan.summary.total_nodes} />
          </>
        ) : (
          <>
            <StepRailMetaItem label="provision" value={planState.plan.summary.provision_count} status="success" />
            <StepRailMetaItem label="reuse" value={planState.plan.summary.reuse_count} status="neutral" />
            <StepRailMetaItem label="attach" value={planState.plan.summary.attach_count} status="neutral" />
          </>
        )}
      </StepRailMetadata>
    ) : (
      "Preview rollout plan"
    );

    const reviewSummary = provisionRunning ? (
      "Provisioning is in progress"
    ) : (
      "Review launch settings"
    );

    const nextSteps: StepRailItem[] = [
      { id: "configure", label: "Configure", summary: configureSummary, status: "upcoming" },
      { id: "target", label: "Select Target", summary: targetSummary, status: "upcoming" },
    ];

    if (showPlanStep) {
      let planStatusIcons: ReactNode[] = [];
      if (planState.plan && isGraph && planState.plan.summary.blocked_count > 0) {
        planStatusIcons.push(
          <Tooltip content={`${planState.plan.summary.blocked_count} blocked dependencies`} position="top">
             <WarningIcon />
          </Tooltip>
        );
      }
      nextSteps.push({ id: "plan", label: "Plan", summary: planSummary, statusIcons: planStatusIcons.length > 0 ? planStatusIcons : undefined, status: "upcoming" });
    }

    let reviewStatusIcons: ReactNode[] = [];
    if (launchBlockedReason) {
      reviewStatusIcons.push(
        <Tooltip content={launchBlockedReason} position="top">
          <ErrorIcon />
        </Tooltip>
      );
    }
    nextSteps.push({ id: "review", label: "Review & Launch", summary: reviewSummary, statusIcons: reviewStatusIcons.length > 0 ? reviewStatusIcons : undefined, status: "upcoming" });

    return nextSteps;
  }, [
    deploymentMode,
    launchBlockedReason,
    planState.loading,
    planState.plan,
    provisionRunning,
    runtimeMode,
    selectedSpecs.length,
    showPlanStep,
    specSelected,
  ]);
  const availableStepIds = provisionShellSteps.map((step) => step.id) as ProvisionStepId[];
  const defaultStep = availableStepIds[0] ?? "configure";
  const activeStep = availableStepIds.includes(requestedStep as ProvisionStepId)
    ? requestedStep as ProvisionStepId
    : defaultStep;
  const activeStepIndex = provisionShellSteps.findIndex((step) => step.id === activeStep);
  const nextStep = activeStepIndex >= 0 ? provisionShellSteps[activeStepIndex + 1] : undefined;
  const planReady = Boolean(planState.plan && !planState.loading && !planState.error);
  const railSteps = provisionShellSteps.map((step, stepIndex) => {
    const isActive = step.id === activeStep;
    const isComplete = step.id === "configure"
      ? true
      : step.id === "target"
        ? specSelected && activeStepIndex > stepIndex
        : step.id === "plan"
          ? planReady && activeStepIndex > stepIndex
          : provisionRunning || provisionComplete;

    return {
      ...step,
      status: isActive ? "current" : (isComplete ? "complete" : "upcoming"),
    } satisfies StepRailItem;
  });
  const provisionStages = useMemo(() => railSteps.map((step) => ({
    key: step.id,
    label: step.label,
    status: (step.status === "complete"
      ? "completed"
      : step.status === "current"
        ? "current"
        : "upcoming") as "completed" | "current" | "upcoming" | "disabled",
  })), [railSteps]);

  const { setHeaderStrip } = useOutletContext<ProvisionLayoutContext>();
  const stagesKey = useMemo(() => JSON.stringify(provisionStages.map((s) => [s.key, s.status])), [provisionStages]);
  useLayoutEffect(() => {
    setHeaderStrip(<ProvisionStageTracker stages={provisionStages} />);
    return () => setHeaderStrip(null);
  }, [stagesKey, setHeaderStrip]);

  useEffect(() => {
    if ((!requestedStep && activeStep === defaultStep) || requestedStep === activeStep) return;

    const next = new URLSearchParams(searchParams);
    if (activeStep === defaultStep) next.delete("step");
    else next.set("step", activeStep);
    setSearchParams(next, { replace: true });
  }, [activeStep, defaultStep, requestedStep, searchParams, setSearchParams]);

  const handleStepChange = useCallback((nextStep: string) => {
    if (!availableStepIds.includes(nextStep as ProvisionStepId)) return;

    const next = new URLSearchParams(searchParams);
    if (nextStep === defaultStep) next.delete("step");
    else next.set("step", nextStep);
    setSearchParams(next, { replace: true });
  }, [availableStepIds, defaultStep, searchParams, setSearchParams]);

  return (
    <>
      {registerTeamModalOpen && (
        <RegisterTeamModal 
          onClose={() => setRegisterTeamModalOpen(false)} 
          onSuccess={handleTeamRegistered} 
        />
      )}

      <div className="page-header">
        <h1>Provision a Service</h1>
      </div>

      <ErrorBanner message={fetchError} onDismiss={() => setFetchError("")} onRetry={() => void loadPageData()} />
      <ErrorBanner message={error} onDismiss={() => setError("")} />

      {showExecutionTakeover ? (
        <ExecutionTakeover
          renderedBoardMode={renderedBoardMode}
          batchRun={batchRun}
          runUnits={normalizedRunUnits}
          totalCount={renderedBoardMode === "graph" ? graphBoardNodes.length : (batchRun.total || orderedItemStates.length)}
          canReset={canResetBoard}
          onReset={resetBoard}
          graphBoardCounts={renderedBoardMode === "graph" ? graphBoardCounts : undefined}
          graphDeploymentGroupId={renderedBoardMode === "graph" ? graphRunState?.deploymentGroupId : undefined}
          graphRootSpecId={renderedBoardMode === "graph" ? graphRunState?.deploymentRootSpecId : undefined}
          graphError={renderedBoardMode === "graph" ? graphRunState?.error : undefined}
        />
      ) : (
        <ProvisionShell
          steps={railSteps}
          activeStep={activeStep}
          onStepChange={handleStepChange}
          nextStepId={nextStep?.id}
          nextStepLabel={nextStep?.label}
        >
          {activeStep === "configure" && (
            <div className="provision-step-panel" data-step-panel="configure">
              <div className="provision-step-panel-header">
                <h2 className="provision-step-panel-title">Configure</h2>
                <p className="provision-step-panel-subtitle">Choose the deployment mode, runtime, and any shared infrastructure setup before selecting your target services.</p>
              </div>
              <section className="provision-section provision-section--configure">
                <div className="card provision-mode-card">
          <fieldset className="provision-mode-fieldset">
            <legend className="provision-mode-legend">Deployment Mode</legend>
            <div className="provision-mode-options">
              <label className={`provision-mode-option ${deploymentMode === "single" ? "provision-mode-option-active" : ""}`}>
                <input
                  type="radio"
                  name="deployment_mode"
                  value="single"
                  checked={deploymentMode === "single"}
                  onChange={() => handleDeploymentModeChange("single")}
                  disabled={batchRun.running}
                />
                <span>Independent services</span>
              </label>
              <label className={`provision-mode-option ${deploymentMode === "graph" ? "provision-mode-option-active" : ""}`}>
                <input
                  type="radio"
                  name="deployment_mode"
                  value="graph"
                  checked={deploymentMode === "graph"}
                  onChange={() => handleDeploymentModeChange("graph")}
                  disabled={batchRun.running || !graphModeAvailable}
                />
                <span>Dependency graph (from root)</span>
              </label>
            </div>
          </fieldset>
          <p className="provision-runtime-meta">
            {deploymentMode === "single" ? "Provision one or more services without bringing in their dependency closures." : "Provision a single root service along with all required upstream dependencies."}
          </p>
        </div>

        {batchSummary && (
          <div
            className={`card provision-summary batch-summary-card animate-fade-in-up ${batchSummary.failed > 0 ? "batch-summary-card--error" : "batch-summary-card--success"}`}
          >
            <p className="provision-summary-title">
              Batch complete: {batchSummary.success}/{batchSummary.total} succeeded
            </p>
            {batchSummary.failures.map((failure) => (
              <div key={failure.specId} className="provision-summary-failure-row">
                <p className="provision-summary-failure">
                  <strong>{failure.title}:</strong> {failure.message}
                </p>
                <div className="provision-summary-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={() => { void recoverFailedSpec(failure.specId); }}
                    disabled={batchRun.running || recoveryStates[failure.specId]?.status === "running"}
                  >
                    {recoveryStates[failure.specId]?.status === "running" ? "Recovering..." : "Run teardown recovery"}
                  </button>
                  {recoveryStates[failure.specId]?.message && (
                    <span
                      className={`provision-summary-recovery ${recoveryStates[failure.specId]?.status === "error"
                        ? "provision-summary-recovery-error"
                        : "provision-summary-recovery-success"
                        }`}
                    >
                      {recoveryStates[failure.specId]?.message}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="card provision-runtime-card">
          <fieldset className="provision-runtime-fieldset">
            <legend className="provision-runtime-legend">Runtime Mode</legend>
            <div className="provision-runtime-options">
              <label className={`provision-runtime-option ${runtimeMode === "lambda" ? "provision-runtime-option-active" : ""}`}>
                <input
                  type="radio"
                  name="runtime_mode"
                  value="lambda"
                  checked={runtimeMode === "lambda"}
                  onChange={() => setRuntimeMode("lambda")}
                  disabled={batchRun.running}
                />
                <span>AWS Lambda</span>
              </label>
              <label
                className={`provision-runtime-option ${runtimeMode === "ecs_service" ? "provision-runtime-option-active" : ""} ${ecsRuntime?.needsSetup ? "provision-runtime-option-needs-setup" : !ecsRuntime?.available ? "provision-runtime-option-disabled" : ""}`}
              >
                <input
                  type="radio"
                  name="runtime_mode"
                  value="ecs_service"
                  checked={runtimeMode === "ecs_service"}
                  onChange={() => setRuntimeMode("ecs_service")}
                  disabled={batchRun.running}
                />
                <span>ECS (ARM64 + Insights){ecsRuntime?.needsSetup && <span className="provision-runtime-badge-setup">Needs Setup</span>}</span>
              </label>
              <label
                className={`provision-runtime-option ${runtimeMode === "k8s_workspace" ? "provision-runtime-option-active" : ""} ${!k8sWorkspaceRuntime?.available ? "provision-runtime-option-disabled" : ""}`}
              >
                <input
                  type="radio"
                  name="runtime_mode"
                  value="k8s_workspace"
                  checked={runtimeMode === "k8s_workspace"}
                  onChange={() => setRuntimeMode("k8s_workspace")}
                  disabled={batchRun.running || !k8sWorkspaceRuntime?.available}
                />
                <span>Kubernetes (Workspace Mode)</span>
              </label>
              <label
                className={`provision-runtime-option ${runtimeMode === "k8s_discovery" ? "provision-runtime-option-active" : ""} ${k8sDiscoveryRuntime?.needsSetup ? "provision-runtime-option-needs-setup" : !k8sDiscoveryRuntime?.available ? "provision-runtime-option-disabled" : ""}`}
              >
                <input
                  type="radio"
                  name="runtime_mode"
                  value="k8s_discovery"
                  checked={runtimeMode === "k8s_discovery"}
                  onChange={() => setRuntimeMode("k8s_discovery")}
                  disabled={batchRun.running || !k8sDiscoveryRuntime?.available}
                />
                <span>Kubernetes (Discovery Mode){k8sDiscoveryRuntime?.needsSetup && <span className="provision-runtime-badge-setup">Needs Setup</span>}</span>
              </label>
            </div>
          </fieldset>
          <p className="provision-runtime-meta">
            Insights integration with ECS has known limitations. Kubernetes modes are recommended for new deployments.
          </p>
          {!k8sWorkspaceRuntime?.available && (
            <p className="provision-runtime-warning">Kubernetes (Workspace): {k8sWorkspaceUnavailableReason}</p>
          )}
          {!k8sDiscoveryRuntime?.available && (
            <p className="provision-runtime-warning">Kubernetes (Discovery): {k8sDiscoveryUnavailableReason}</p>
          )}
          {runtimeMode === "k8s_workspace" && (
            <p className="provision-runtime-meta">
              Workspace mode automatically creates and links a Postman workspace with system environment associations.
            </p>
          )}
          {runtimeMode === "ecs_service" && (
            <>
              <p className="provision-runtime-meta">
                {ecsRuntime
                  ? `ECS capacity: ${ecsRuntime.activeServices}/${ecsRuntime.maxServices} in use (${ecsRuntime.remainingServices} remaining).`
                  : "ECS capacity status unavailable."}
              </p>
              {!ecsRuntime?.available && (
                <p className="provision-runtime-warning">{ecsUnavailableReason}</p>
              )}
              <div className="infra-status-row">
                {!ecsRuntime?.available && !infraSetupRunning && (
                  <button
                    type="button"
                    className="btn btn-secondary infra-btn-setup"
                    onClick={() => { void startInfraSetup(); }}
                    disabled={batchRun.running || infraTeardownRunning}
                  >
                    Set up infrastructure
                  </button>
                )}
                {infraSetupRunning && (
                  <span className="infra-log">Setting up shared ECS infrastructure...</span>
                )}
                {ecsRuntime?.available && !infraTeardownRunning && (
                  <>
                    <span className="status-badge status-active infra-badge-ready">Infrastructure ready</span>
                    <button
                      type="button"
                      className="infra-btn-resources"
                      onClick={() => { void openInfraResourceModal(); }}
                      disabled={batchRun.running || infraSetupRunning}
                    >
                      Resources
                    </button>
                    <button
                      type="button"
                      className="infra-btn-teardown"
                      onClick={() => { void startInfraTeardown(); }}
                      disabled={batchRun.running || infraSetupRunning || ecsHasActiveServices}
                      title={ecsHasActiveServices ? "Remove ECS services before teardown" : "Tear down shared ECS infrastructure"}
                    >
                      Tear down
                    </button>
                    {ecsHasActiveServices && (
                      <span className="infra-log">(remove ECS services first)</span>
                    )}
                  </>
                )}
                {infraTeardownRunning && (
                  <span className="infra-log">Tearing down shared ECS infrastructure...</span>
                )}
              </div>
              {infraError && <p className="provision-runtime-warning">{infraError}</p>}
              {infraRunUrl && (
                <p className="infra-log">
                  Workflow: <a className="link" href={infraRunUrl} target="_blank" rel="noopener noreferrer">{infraRunUrl}</a>
                </p>
              )}
              {infraLog.length > 0 && (
                <div className="infra-log">
                  {renderLogLines(infraLog)}
                </div>
              )}
            </>
          )}
          {runtimeMode === "k8s_discovery" && (
            <>
              <p className="provision-runtime-meta">
                {k8sDiscoverySharedInfraActive
                  ? `Discovery shared infrastructure is active in namespace ${k8sDiscoveryRuntime?.namespace || "vzw-partner-demo"}.`
                  : "Discovery shared infrastructure is not active yet. Run setup before provisioning discovery-mode services."}
              </p>
              <div className="infra-status-row">
                {!k8sDiscoverySharedInfraActive && !infraSetupRunning && (
                  <button
                    type="button"
                    className="btn btn-secondary infra-btn-setup"
                    onClick={() => { void startInfraSetup(); }}
                    disabled={batchRun.running || infraTeardownRunning}
                  >
                    Set up infrastructure
                  </button>
                )}
                {infraSetupRunning && (
                  <span className="infra-log">Setting up shared Kubernetes discovery infrastructure...</span>
                )}
                {k8sDiscoverySharedInfraActive && !infraTeardownRunning && (
                  <>
                    <span className="status-badge status-active infra-badge-ready">Infrastructure ready</span>
                    <button
                      type="button"
                      className="infra-btn-resources"
                      onClick={() => { void openInfraResourceModal(); }}
                      disabled={batchRun.running || infraSetupRunning}
                    >
                      Resources
                    </button>
                    <button
                      type="button"
                      className="infra-btn-teardown"
                      onClick={() => { void startInfraTeardown(); }}
                      disabled={batchRun.running || infraSetupRunning || k8sDiscoveryHasActiveServices}
                      title={k8sDiscoveryHasActiveServices
                        ? "Remove Kubernetes discovery-mode services before teardown"
                        : "Tear down shared Kubernetes discovery infrastructure"}
                    >
                      Tear down
                    </button>
                    {k8sDiscoveryHasActiveServices && (
                      <span className="infra-log">
                        (remove {k8sDiscoveryActiveServices} discovery service{k8sDiscoveryActiveServices === 1 ? "" : "s"} first)
                      </span>
                    )}
                  </>
                )}
                {infraTeardownRunning && (
                  <span className="infra-log">Tearing down shared Kubernetes discovery infrastructure...</span>
                )}
              </div>
              {infraError && <p className="provision-runtime-warning">{infraError}</p>}
              {infraRunUrl && (
                <p className="infra-log">
                  Workflow: <a className="link" href={infraRunUrl} target="_blank" rel="noopener noreferrer">{infraRunUrl}</a>
                </p>
              )}
              {infraLog.length > 0 && (
                <div className="infra-log">
                  {renderLogLines(infraLog)}
                </div>
              )}
            </>
          )}
        </div>
              </section>
            </div>
          )}

          {activeStep === "target" && (
            <div className="provision-step-panel" data-step-panel="target">
              <div className="provision-step-panel-header">
                <h2 className="provision-step-panel-title">Select Target</h2>
                <p className="provision-step-panel-subtitle">Choose the industry and APIs that should be included in this provisioning run.</p>
              </div>
              <section className="provision-section provision-section--select-target">
                <IndustrySelector
          selectedIndustry={selectedIndustry}
          onSelect={handleIndustryChange}
          disabled={batchRun.running}
        />

                <SpecSelector
          industry={selectedIndustry}
          deployedSpecIds={deployedSpecIds}
          selectedIds={selectedSpecIds}
          onToggleSelect={toggleSelect}
          onSelectVisible={selectVisible}
          onClearSelection={clearSelection}
          selectionMode={deploymentMode === "graph" ? "single" : "multi"}
          disabled={batchRun.running}
        />
              </section>
            </div>
          )}

          {activeStep === "plan" && showPlanStep && (
            <div className="provision-step-panel" data-step-panel="plan">
              <div className="provision-step-panel-header">
                <h2 className="provision-step-panel-title">Plan</h2>
                <p className="provision-step-panel-subtitle">See exactly what will be provisioned, reused, attached, or blocked before you move into the final launch review.</p>
              </div>
              <section className="provision-section provision-section--plan">
                <div className="card provision-preview-card">
          <h3>{deploymentMode === "graph" ? "Dependency Graph Rollout" : "Single-Service Rollout Guidance"}</h3>
          <p className="provision-preview-summary">{planReadyText}</p>
          {planState.loading && (
            <div className="provision-preview-loading">
              <Skeleton variant="rect" height="120px" />
            </div>
          )}
          {planState.error && <p className="provision-preview-error">{planState.error}</p>}
          {planState.warnings.length > 0 && (
            <div className="provision-preview-warning-list">
              {planState.warnings.map((warning) => (
                <p key={warning} className="provision-preview-warning-item">{warning}</p>
              ))}
            </div>
          )}
          {planState.plan && !planState.loading && !planState.error && (
            <>
              <div className="provision-preview-meta">
                <span>Root: <strong>{graphRootSpec.title}</strong></span>
                <span>Envs: <strong>{planState.plan.environments.join(", ")}</strong></span>
              </div>
              {deploymentMode === "graph" && (
                <GraphReviewSummary
                  provision={planState.plan.summary.provision_count}
                  reuse={planState.plan.summary.reuse_count}
                  attach={planState.plan.summary.attach_count}
                  blocked={planState.plan.summary.blocked_count}
                  total={planState.plan.summary.total_nodes}
                />
              )}
              {deploymentMode !== "graph" && (
                <>
                  <div className="provision-preview-guidance">
                    <p className="provision-preview-guidance-title">Only the selected service will be provisioned in single-service mode.</p>
                    <p className="provision-preview-guidance-copy">Dependencies are not added automatically. If this service needs upstream systems, switch to dependency graph mode or make sure those dependencies already exist.</p>
                  </div>
                  <div className="provision-preview-meta">
                    <span>Reuse: <strong>{planState.plan.summary.reuse_count}</strong></span>
                    <span>Attach: <strong>{planState.plan.summary.attach_count}</strong></span>
                    <span>Provision: <strong>{planState.plan.summary.provision_count}</strong></span>
                    <span>Blocked: <strong>{planState.plan.summary.blocked_count}</strong></span>
                  </div>
                </>
              )}
              {deploymentMode === "graph" && blockedGraphNodes.length > 0 && (
                <div className="graph-blocked-section">
                  <h4>
                    {blockedGraphNodes.length} blocked node{blockedGraphNodes.length === 1 ? "" : "s"} across {blockedGraphTargets.length} service
                    {blockedGraphTargets.length === 1 ? "" : "s"} must be resolved before this graph can run.
                  </h4>
                  <div className="provision-preview-prereqs">
                    {blockedGraphNodes.map((blockedNode) => (
                      <div key={blockedNode.key} className="provision-preview-prereq-row graph-blocked-node-row">
                        <span className="graph-blocked-node-title">{blockedNode.title}</span>
                        <span className="mono">{blockedNode.environment}</span>
                        <span className="graph-blocked-node-reason">{blockedNode.message}</span>
                      </div>
                    ))}
                  </div>
                  <div className="provision-preview-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={recoverBlockedGraphServices}
                      disabled={batchRun.running || blockedGraphRunning || blockedGraphTargets.length === 0}
                    >
                      {blockedGraphRunning
                        ? "Tearing down blocked services..."
                        : `Teardown to Unblock (${blockedGraphTargets.length} service${blockedGraphTargets.length === 1 ? "" : "s"})`}
                    </button>
                  </div>
                  {blockedGraphTargets
                    .filter((target) => recoveryStates[target.spec_id]?.message)
                    .map((target) => (
                      <p
                        key={target.project_name}
                        className={`provision-summary-recovery ${recoveryStates[target.spec_id]?.status === "error"
                          ? "provision-summary-recovery-error"
                          : recoveryStates[target.spec_id]?.status === "success"
                            ? "provision-summary-recovery-success"
                            : ""
                          }`}
                      >
                        {target.project_name}: {recoveryStates[target.spec_id]?.message}
                      </p>
                    ))}
                </div>
              )}
              {deploymentMode === "single" && graphPrereqWarnings.length > 0 && (
                <>
                  <div className="provision-preview-warning">
                    Missing hard dependencies for single mode were detected.
                    Enable dependency graph mode to deploy required upstream services.
                  </div>
                  <div className="provision-preview-prereqs">
                    {graphPrereqWarnings.map((warning) => (
                      <div key={`${warning.spec_id}:${warning.environment}:${warning.reason}`} className="provision-preview-prereq-row">
                        <span className="mono">{warning.spec_id}</span>
                        <span>{warning.environment}</span>
                        <span>{warning.reason}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {planState.plan.layers.length > 0 && deploymentMode === "graph" && (
                <DependencyGraphVisualizer plan={planState.plan} />
              )}
            </>
          )}
        </div>
              </section>
            </div>
          )}

          {activeStep === "review" && (
            <div className="provision-step-panel" data-step-panel="review">
              <div className="provision-step-panel-header">
                <h2 className="provision-step-panel-title">Review &amp; Launch</h2>
                <p className="provision-step-panel-subtitle">Confirm the final team, environment, access, and feature settings before provisioning.</p>
              </div>
              <section className="provision-section provision-section--review">
                <ProvisionLaunchPanel
            deploymentMode={deploymentMode}
            runtimeMode={runtimeMode}
            batchRun={batchRun}
            selectedSpecs={selectedSpecs}
            graphRootTitle={graphRootSpec?.title ?? null}
            teams={teams}
            selectedTeamSlug={selectedTeamSlug}
            onSelectedTeamSlugChange={setSelectedTeamSlug}
            isVerifyingCredentials={verifyingTeamSlug === selectedTeamSlug}
            orgTeams={orgTeams}
            orgTeamsState={orgTeamsState}
            selectedWorkspaceTeamId={selectedWorkspaceTeamId}
            onSelectedWorkspaceTeamIdChange={setSelectedWorkspaceTeamId}
            onRegisterTeamClick={() => setRegisterTeamModalOpen(true)}
            systemEnvs={systemEnvs}
            systemEnvState={systemEnvState}
            selectedEnvSlugs={selectedEnvSlugs}
          onToggleEnvironment={toggleSystemEnvironment}
          isRefreshingEnvironments={isRefreshingEnvironments}
          onRefreshEnvironments={refreshSystemEnvironments}
          connectPostman={connectPostman}
          workspaceSyncDisabledReason={workspaceSyncDisabledReason}
          onConnectPostmanChange={setConnectPostman}
          chaosEnabled={chaosEnabled}
          onChaosEnabledChange={setChaosEnabled}
          chaosConfig={chaosConfig}
          onChaosConfigChange={setChaosConfig}
          environmentSyncEnabled={environmentSyncEnabled}
          onEnvironmentSyncEnabledChange={setEnvironmentSyncEnabled}
          k8sDiscoveryWorkspaceLink={k8sDiscoveryWorkspaceLink}
          onK8sDiscoveryWorkspaceLinkChange={setK8sDiscoveryWorkspaceLink}
          workspaceAdmins={{
            users: teamUsers,
            state: teamUsersState,
            selectedIds: selectedAdminIds,
            dropdownOpen: adminDropdownOpen,
            search: adminSearch,
            triggerRef: adminTriggerRef,
            dropdownRef: adminDropdownRef,
            menuRef: adminMenuRef,
            searchRef: adminSearchRef,
            onToggleOpen: () => setAdminDropdownOpen((prev) => !prev),
            onSearchChange: setAdminSearch,
            onToggleUser: toggleAdminUser,
          }}
          repoAdmins={{
            members: orgMembers,
            state: orgMembersState,
            selectedUsernames: selectedRepoAdminUsernames,
            dropdownOpen: repoAdminDropdownOpen,
            search: repoAdminSearch,
            triggerRef: repoAdminTriggerRef,
            dropdownRef: repoAdminDropdownRef,
            menuRef: repoAdminMenuRef,
            searchRef: repoAdminSearchRef,
            onToggleOpen: () => setRepoAdminDropdownOpen((prev) => !prev),
            onSearchChange: setRepoAdminSearch,
            onToggleMember: toggleRepoAdmin,
          }}
          canClearSelection={!batchRun.running && selectedSpecs.length > 0}
          canStartProvision={!launchActionDisabled}
          canResetBoard={!batchRun.running && canResetBoard}
          launchBlockedReason={launchBlockedReason}
          onClearSelection={clearSelection}
          onStartProvision={handleStartProvision}
          onResetBoard={resetBoard}
        />
              </section>
            </div>
          )}
        </ProvisionShell>
      )}

      <ResourceModal
        open={infraResourceModalOpen}
        onClose={closeInfraResourceModal}
        title={infraResourceTitle}
        subtitle={infraResourceSubtitle}
        loading={infraResourceModalLoading}
        error={infraResourceModalError}
        data={infraResourceModalData}
        showEnvironmentColumn={false}
        emptyMessage="No resources are currently recorded for shared infrastructure."
        closeButtonRef={infraResourceCloseButtonRef}
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
    </>
  );
}
