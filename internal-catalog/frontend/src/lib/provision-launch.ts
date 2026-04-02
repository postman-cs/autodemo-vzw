import type { DeploymentMode, RuntimeMode } from "./types";

export interface LaunchTargetSpec {
  id: string;
  repo_name: string;
  domain: string;
}

export interface LaunchRequestBody {
  project_name: string;
  domain: string;
  requester_email: string;
  environments: string[];
  spec_source: string;
  runtime: RuntimeMode;
  deployment_mode: DeploymentMode;
  github_workspace_sync: boolean;
  environment_sync_enabled: boolean;
  chaos_enabled: boolean;
  chaos_config?: string;
  connect_git: boolean;
  workspace_admin_ids: string[] | undefined;
  repo_admin_usernames: string[] | undefined;
  k8s_discovery_workspace_link: boolean | undefined;
  postman_team_slug?: string;
  workspace_team_id?: number;
  workspace_team_name?: string;
}

export interface BuildLaunchRequestOptions {
  spec: LaunchTargetSpec;
  runtimeMode: RuntimeMode;
  deploymentMode: DeploymentMode;
  selectedEnvSlugs: Iterable<string>;
  connectPostman: boolean;
  environmentSyncEnabled: boolean;
  chaosEnabled: boolean;
  chaosConfig: string;
  selectedAdminIds: Set<number>;
  selectedRepoAdminUsernames: Set<string>;
  k8sDiscoveryWorkspaceLink: boolean;
  teamSlug?: string;
  workspaceTeamId?: number | null;
  workspaceTeamName?: string | null;
  requesterEmail?: string;
}

export interface WorkspaceSyncControlOptions {
  batchRunning: boolean;
  runtimeMode: RuntimeMode;
  k8sDiscoveryWorkspaceLink: boolean;
}

export function deriveSelectedEnvList(selectedEnvSlugs: Iterable<string>): string[] {
  const environments = Array.from(selectedEnvSlugs).sort();
  return environments.length > 0 ? environments : ["prod"];
}

export function resolveWorkspaceSyncEnabled(
  runtimeMode: RuntimeMode,
  k8sDiscoveryWorkspaceLink: boolean,
  connectPostman: boolean,
): boolean {
  return runtimeMode === "k8s_discovery" && !k8sDiscoveryWorkspaceLink ? false : connectPostman;
}

export function isWorkspaceSyncControlDisabled({
  batchRunning,
  runtimeMode,
  k8sDiscoveryWorkspaceLink,
}: WorkspaceSyncControlOptions): boolean {
  return batchRunning || (runtimeMode === "k8s_discovery" && !k8sDiscoveryWorkspaceLink);
}

export function buildLaunchRequestBody({
  spec,
  runtimeMode,
  deploymentMode,
  selectedEnvSlugs,
  connectPostman,
  environmentSyncEnabled,
  chaosEnabled,
  chaosConfig,
  selectedAdminIds,
  selectedRepoAdminUsernames,
  k8sDiscoveryWorkspaceLink,
  teamSlug,
  workspaceTeamId,
  workspaceTeamName,
  requesterEmail = "admin@postman.com",
}: BuildLaunchRequestOptions): LaunchRequestBody {
  const workspaceSyncEnabled = resolveWorkspaceSyncEnabled(runtimeMode, k8sDiscoveryWorkspaceLink, connectPostman);

  return {
    project_name: spec.repo_name,
    domain: spec.domain,
    requester_email: requesterEmail,
    environments: deriveSelectedEnvList(selectedEnvSlugs),
    spec_source: spec.id,
    runtime: runtimeMode,
    deployment_mode: deploymentMode,
    github_workspace_sync: workspaceSyncEnabled,
    environment_sync_enabled: environmentSyncEnabled,
    chaos_enabled: chaosEnabled,
    ...(chaosConfig ? { chaos_config: chaosConfig } : {}),
    connect_git: workspaceSyncEnabled,
    workspace_admin_ids: selectedAdminIds.size > 0 ? Array.from(selectedAdminIds).map(String) : undefined,
    repo_admin_usernames: selectedRepoAdminUsernames.size > 0 ? Array.from(selectedRepoAdminUsernames) : undefined,
    k8s_discovery_workspace_link: runtimeMode === "k8s_discovery" ? k8sDiscoveryWorkspaceLink : undefined,
    postman_team_slug: teamSlug,
    workspace_team_id: (workspaceTeamId != null && workspaceTeamId > 0) ? workspaceTeamId : undefined,
    workspace_team_name: (workspaceTeamId != null && workspaceTeamId > 0 && workspaceTeamName) ? workspaceTeamName : undefined,
    };
    }