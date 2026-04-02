type WorkspaceCandidate = {
    id: string;
    linkedRepoUrl?: string | null;
};

type ChooseCanonicalWorkspaceArgs = {
    repoWorkspaceId?: string;
    repoUrl: string;
    matchingWorkspaces: WorkspaceCandidate[];
};

type WorkspaceLookupClient = {
    findWorkspacesByName(name: string): Promise<Array<{ id: string; name: string }>>;
    getWorkspaceGitRepoUrl(workspaceId: string, teamId: string, accessToken: string): Promise<string | null>;
};

type RepoVariableClient = {
    setRepositoryVariable(name: string, value: string): Promise<unknown>;
};

export type CanonicalWorkspaceSelection =
    | { type: 'existing'; workspaceId: string; source: 'linked_match' | 'repo_var' | 'name_match'; warning?: string }
    | { type: 'create' }
    | { type: 'manual_review'; reason: string };

function normalizeGitHubRepoUrl(url: string | null | undefined): string {
    const raw = String(url || '').trim();
    if (!raw) return '';

    const sshMatch = raw.match(/^git@github\.com:(.+)$/i);
    if (sshMatch?.[1]) {
        return normalizeGitHubRepoUrl(`https://github.com/${sshMatch[1]}`);
    }

    try {
        const parsed = new URL(raw);
        if (!/github\.com$/i.test(parsed.hostname)) return raw.toLowerCase();
        const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/').filter(Boolean);
        if (parts.length < 2) return raw.toLowerCase();
        return `https://github.com/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
    } catch {
        return raw.replace(/\.git$/i, '').replace(/\/+$/g, '').toLowerCase();
    }
}

export function chooseCanonicalWorkspace(args: ChooseCanonicalWorkspaceArgs): CanonicalWorkspaceSelection {
    const repoWorkspaceId = String(args.repoWorkspaceId || '').trim();
    const normalizedRepoUrl = normalizeGitHubRepoUrl(args.repoUrl);
    const matchingWorkspaces = [...args.matchingWorkspaces].sort((a, b) => a.id.localeCompare(b.id));

    const linkedMatches = matchingWorkspaces.filter((workspace) =>
        normalizeGitHubRepoUrl(workspace.linkedRepoUrl) === normalizedRepoUrl,
    );

    if (linkedMatches.length === 1) {
        const linked = linkedMatches[0];
        return {
            type: 'existing',
            workspaceId: linked.id,
            source: 'linked_match',
            warning: repoWorkspaceId && repoWorkspaceId !== linked.id
                ? `Replacing repo workspace ${repoWorkspaceId} with canonical GitHub-linked workspace ${linked.id}`
                : undefined,
        };
    }

    if (linkedMatches.length > 1) {
        if (repoWorkspaceId && linkedMatches.some((workspace) => workspace.id === repoWorkspaceId)) {
            return {
                type: 'existing',
                workspaceId: repoWorkspaceId,
                source: 'linked_match',
                warning: `Multiple GitHub-linked workspaces matched ${normalizedRepoUrl}; keeping existing linked repo workspace ${repoWorkspaceId} until manual cleanup.`,
            };
        }
        return {
            type: 'manual_review',
            reason: `Multiple GitHub-linked workspaces matched ${normalizedRepoUrl}: ${linkedMatches.map((workspace) => workspace.id).join(', ')}`,
        };
    }

    if (repoWorkspaceId) {
        return {
            type: 'existing',
            workspaceId: repoWorkspaceId,
            source: 'repo_var',
        };
    }

    if (matchingWorkspaces.length > 0) {
        return {
            type: 'existing',
            workspaceId: matchingWorkspaces[0].id,
            source: 'name_match',
        };
    }

    return { type: 'create' };
}

export async function resolveCanonicalWorkspaceSelection(args: {
    postman: WorkspaceLookupClient;
    workspaceName: string;
    repoWorkspaceId?: string;
    repoUrl: string;
    teamId: string;
    accessToken: string;
    warn?: (message: string) => void;
}): Promise<CanonicalWorkspaceSelection> {
    let matchingWorkspaces: Array<{ id: string; name: string; linkedRepoUrl?: string | null }> = [];

    try {
        matchingWorkspaces = await args.postman.findWorkspacesByName(args.workspaceName);
    } catch (error) {
        if (!args.repoWorkspaceId) throw error;
        args.warn?.(`Workspace duplicate check failed; falling back to repo workspace ${args.repoWorkspaceId}: ${error}`);
    }

    if (matchingWorkspaces.length > 1) {
        matchingWorkspaces = await Promise.all(matchingWorkspaces.map(async (workspace) => ({
            ...workspace,
            linkedRepoUrl: await args.postman.getWorkspaceGitRepoUrl(workspace.id, args.teamId, args.accessToken),
        })));
    }

    return chooseCanonicalWorkspace({
        repoWorkspaceId: args.repoWorkspaceId,
        repoUrl: args.repoUrl,
        matchingWorkspaces,
    });
}

export async function storePostmanRepoVariables(args: {
    github: RepoVariableClient;
    workspaceId: string;
    specId: string;
    baselineUid: string;
    smokeUid: string;
    contractUid: string;
    environments: string[];
    systemEnvMap: Record<string, string>;
}): Promise<void> {
    const tasks = [
        () => args.github.setRepositoryVariable('POSTMAN_WORKSPACE_ID', args.workspaceId),
        () => args.github.setRepositoryVariable('POSTMAN_SPEC_UID', args.specId),
        () => args.github.setRepositoryVariable('POSTMAN_BASELINE_COLLECTION_UID', args.baselineUid),
        () => args.github.setRepositoryVariable('POSTMAN_SMOKE_COLLECTION_UID', args.smokeUid),
        () => args.github.setRepositoryVariable('POSTMAN_CONTRACT_COLLECTION_UID', args.contractUid),
    ];

    for (const envName of args.environments) {
        const sysEnvId = args.systemEnvMap[envName];
        if (sysEnvId) {
            const sanitizedEnvName = envName.toUpperCase().replace(/-/g, '_');
            tasks.push(() => args.github.setRepositoryVariable(`POSTMAN_SYSTEM_ENV_${sanitizedEnvName}`, sysEnvId));
        }
    }

    for (const task of tasks) {
        await task();
    }
}
