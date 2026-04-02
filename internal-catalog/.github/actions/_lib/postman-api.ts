import * as core from '@actions/core';
import { retry } from './retry';

export class PostmanApiClient {
    private apiKey: string;
    private baseUrl = 'https://api.getpostman.com';
    private bifrostUrl = 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy';

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    private static isRecord(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === 'object';
    }

    private static getRecord(value: unknown): Record<string, unknown> {
        return PostmanApiClient.isRecord(value) ? value : {};
    }

    private static getArray(value: unknown): unknown[] {
        return Array.isArray(value) ? value : [];
    }

    private static getString(value: unknown): string {
        return typeof value === 'string' ? value : '';
    }

    private static getNestedRecord(value: unknown, key: string): Record<string, unknown> {
        return PostmanApiClient.getRecord(PostmanApiClient.getRecord(value)[key]);
    }

    private static getNestedArray(value: unknown, key: string): unknown[] {
        return PostmanApiClient.getArray(PostmanApiClient.getRecord(value)[key]);
    }

    private static getNestedString(value: unknown, key: string): string {
        return PostmanApiClient.getString(PostmanApiClient.getRecord(value)[key]);
    }

    private async fetch(path: string, options: RequestInit = {}): Promise<unknown> {
        const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
        const response = await fetch(url, {
            ...options,
            headers: {
                'X-Api-Key': this.apiKey,
                'Content-Type': 'application/json',
                ...options.headers,
            },
        });

        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Postman API request failed: ${response.status} ${response.statusText} - ${body}`);
        }

        try {
            return await response.json();
        } catch {
            return null; // Empty body
        }
    }

    public async getMe(): Promise<any> {
        return this.fetch('/me', { method: 'GET' });
    }

    public async getTeams(): Promise<Array<{ id: number; name: string; handle: string }>> {
        const data = await this.fetch('/teams', { method: 'GET' });
        const teams = PostmanApiClient.getNestedArray(data, 'data');
        return teams
            .filter((t: any) => t?.id && t?.name)
            .map((t: any) => ({ id: Number(t.id), name: String(t.name), handle: String(t.handle || '') }));
    }

    public async getAutoDerivedTeamId(): Promise<string | undefined> {
        try {
            const data = await this.getMe();
            const user = PostmanApiClient.getNestedRecord(data, 'user');
            if (user.teamId !== undefined && user.teamId !== null) {
                return String(user.teamId);
            }
        } catch {
            // Best-effort discovery only.
        }
        return undefined;
    }

    public async getAutoDerivedTeamName(): Promise<string | undefined> {
        try {
            const data = await this.getMe();
            const teamName = PostmanApiClient.getNestedRecord(data, 'user').teamName;
            if (teamName !== undefined && teamName !== null && String(teamName).trim()) {
                return String(teamName);
            }
        } catch {
            // Best-effort discovery only.
        }
        return undefined;
    }

    public async listWorkspaces(): Promise<Array<{ id: string; name: string; type: string }>> {
        const data = await this.fetch('/workspaces');
        const workspaces = PostmanApiClient.getNestedArray(data, 'workspaces');
        return workspaces
            .map((workspace) => PostmanApiClient.getRecord(workspace))
            .filter((workspace) => workspace.id && workspace.name)
            .map((workspace) => ({
                id: String(workspace.id),
                name: String(workspace.name),
                type: String(workspace.type ?? 'team'),
            }));
    }

    public async findWorkspacesByName(name: string): Promise<Array<{ id: string; name: string }>> {
        const workspaces = await this.listWorkspaces();
        return workspaces
            .filter((w) => w.name === name)
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((w) => ({ id: w.id, name: w.name }));
    }

    public async findWorkspaceByName(name: string): Promise<{ id: string } | null> {
        const [match] = await this.findWorkspacesByName(name);
        return match ? { id: match.id } : null;
    }

    private async bifrostRequest(
        method: 'GET' | 'POST',
        path: string,
        teamId: string,
        accessToken: string,
        body?: unknown,
    ): Promise<Response> {
        if (!accessToken || !accessToken.trim()) {
            throw new Error(`Bifrost request to ${path} failed: access token is empty. Ensure POSTMAN_ACCESS_TOKEN is set and non-empty.`);
        }
        const payload: Record<string, unknown> = {
            service: 'workspaces',
            method,
            path,
        };
        if (body !== undefined) {
            payload.body = body;
        }
        const response = await fetch(this.bifrostUrl, {
            method: 'POST',
            headers: {
                'x-access-token': accessToken,
                'x-entity-team-id': teamId,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        if (!response.ok && (response.status === 401 || response.status === 403)) {
            const tokenPrefix = accessToken.substring(0, 8);
            core.warning(`Bifrost ${response.status} for ${method} ${path} — x-entity-team-id=${teamId}, token=${tokenPrefix}…`);
        }
        return response;
    }

    private async proxyRequest<T = any>(
        service: string,
        method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        path: string,
        accessToken: string,
        teamId?: string,
        body?: unknown,
    ): Promise<T> {
        const headers: Record<string, string> = {
            'x-access-token': accessToken,
            'Content-Type': 'application/json',
        };
        if (teamId) {
            headers['x-entity-team-id'] = teamId;
        }

        const payload: Record<string, unknown> = { service, method, path };
        if (body !== undefined) payload.body = body;

        const response = await fetch(this.bifrostUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });
        const responseText = await response.text();
        if (!response.ok) {
            throw new Error(`Postman proxy request failed: ${response.status} ${response.statusText} - ${responseText}`);
        }

        if (!responseText.trim()) {
            return null as T;
        }

        try {
            return JSON.parse(responseText) as T;
        } catch {
            return responseText as T;
        }
    }

    private normalizeGitHubRepoUrl(url: string | null | undefined): string {
        const raw = String(url || '').trim();
        if (!raw) return '';

        const sshMatch = raw.match(/^git@github\.com:(.+)$/i);
        if (sshMatch?.[1]) {
            return this.normalizeGitHubRepoUrl(`https://github.com/${sshMatch[1]}`);
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

    private extractGitHubRepoUrl(value: unknown): string | null {
        if (!value) return null;
        if (typeof value === 'string') {
            const normalized = this.normalizeGitHubRepoUrl(value);
            return normalized.includes('github.com/') ? normalized : null;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                const repoUrl = this.extractGitHubRepoUrl(item);
                if (repoUrl) return repoUrl;
            }
            return null;
        }
        if (typeof value === 'object') {
            const record = value as Record<string, unknown>;
            const preferredKeys = ['repo', 'repository', 'repoUrl', 'repo_url', 'remoteUrl', 'remote_url', 'origin'];
            for (const key of preferredKeys) {
                const repoUrl = this.extractGitHubRepoUrl(record[key]);
                if (repoUrl) return repoUrl;
            }
            for (const nested of Object.values(record)) {
                const repoUrl = this.extractGitHubRepoUrl(nested);
                if (repoUrl) return repoUrl;
            }
        }
        return null;
    }

    public async getWorkspaceGitRepoUrl(workspaceId: string, teamId: string, accessToken: string): Promise<string | null> {
        const response = await this.bifrostRequest('GET', `/workspaces/${workspaceId}/filesystem`, teamId, accessToken);
        const body = await response.text();
        if (response.status === 404) {
            return null;
        }
        if (!response.ok) {
            throw new Error(`Bifrost workspace lookup failed: ${response.status} - ${body}`);
        }
        if (!body.trim()) {
            return null;
        }
        try {
            return this.extractGitHubRepoUrl(JSON.parse(body));
        } catch {
            return this.extractGitHubRepoUrl(body);
        }
    }

    public async createWorkspace(
        name: string,
        about: string,
        options?: number | {
            accessToken?: string;
            targetTeamId?: number;
            teamId?: string;
            teamName?: string;
        },
    ): Promise<{ id: string }> {
        const normalizedOptions = typeof options === 'number'
            ? { targetTeamId: options }
            : (options || {});
        const targetTeamId = normalizedOptions.targetTeamId
            || (normalizedOptions.teamId ? parseInt(normalizedOptions.teamId, 10) : undefined);

        return retry(async () => {
            const workspaceObj: any = { name, type: 'team', description: about };
            if (targetTeamId && !Number.isNaN(targetTeamId)) {
                workspaceObj.teamId = targetTeamId;
            }
            const teamPayload = { workspace: workspaceObj };

            core.info(`Creating workspace via Public API (team ${targetTeamId || 'default'})`);

            let createResp: unknown;
            try {
                createResp = await this.fetch('/workspaces', {
                    method: 'POST',
                    body: JSON.stringify(teamPayload)
                });
            } catch (err) {
                if (err instanceof Error && err.message.includes('Only personal workspaces')) {
                    throw new Error(
                        `Org Mode workspace creation failed for team ID ${targetTeamId || 'unknown'}. ` +
                        `Postman restriction: ${err.message}. ` +
                        `Verify team membership and workspace creation permissions.`
                    );
                } else {
                    throw err;
                }
            }

            const createdWorkspace = PostmanApiClient.getNestedRecord(createResp, 'workspace');
            if (!createdWorkspace.id) {
                throw new Error('Workspace create did not return an id');
            }

            const workspaceId = String(createdWorkspace.id);
            const getResp = await this.fetch(`/workspaces/${workspaceId}`);
            const visibility = PostmanApiClient.getString(
                PostmanApiClient.getNestedRecord(getResp, 'workspace').visibility,
            ) || 'unknown';

            if (visibility !== 'team') {
                core.info(`Workspace visibility is '${visibility}', attempting to enforce team visibility`);
                await this.fetch(`/workspaces/${workspaceId}`, {
                    method: 'PUT',
                    body: JSON.stringify(teamPayload)
                });

                const verifyResp = await this.fetch(`/workspaces/${workspaceId}`);
                const verifiedVisibility = PostmanApiClient.getString(
                    PostmanApiClient.getNestedRecord(verifyResp, 'workspace').visibility,
                );
                if (verifiedVisibility !== 'team') {
                    throw new Error(`Workspace visibility must be team; got '${verifiedVisibility}'`);
                }
                core.info(`Workspace visibility verified: team`);
            } else {
                core.info(`Workspace visibility verified: team`);
            }
            core.info(`Workspace created: ${workspaceId}`);
            return { id: workspaceId };
        });
    }

    private static readonly BIFROST_GOVERNANCE_HEADERS: Record<string, string> = {
        'accept': '*/*',
        'accept-language': 'en-US',
        'content-type': 'application/json',
        'priority': 'u=1, i',
        'sec-ch-ua': '"Not A(Brand";v="8", "Chromium";v="132"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Postman/12.0.6 Electron/34.5.8 Safari/537.36',
        'x-app-version': '12.0.7',
    };

    private async governanceRequest(
        accessToken: string,
        payload: Record<string, unknown>,
        teamId?: string,
    ): Promise<Response> {
        const headers: Record<string, string> = {
            ...PostmanApiClient.BIFROST_GOVERNANCE_HEADERS,
            'x-access-token': accessToken,
        };
        if (teamId) {
            headers['x-entity-team-id'] = teamId;
        }
        return fetch(this.bifrostUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });
    }

    public async readGovernanceGroup(groupId: string, accessToken: string, teamId?: string): Promise<any> {
        const response = await this.governanceRequest(accessToken, {
            service: 'ruleset',
            method: 'patch',
            path: `/configure/workspace-groups/${groupId}`,
            body: {
                workspaces: { add: [], remove: [] },
                vulnerabilities: { add: [], remove: [] },
            },
        }, teamId);

        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Failed to read governance group ${groupId}: ${response.status} - ${body}`);
        }
        return response.json();
    }

    public async assignWorkspaceToGovernanceGroup(workspaceId: string, domain: string, mappingJson: string, accessToken: string, teamId?: string): Promise<void> {
        return retry(async () => {
            let mapping: Record<string, string>;
            try {
                mapping = JSON.parse(mappingJson);
            } catch (err) {
                core.warning(`Invalid governance mapping JSON: ${err}`);
                return;
            }

            const groupId = mapping[domain];
            if (!groupId) {
                core.info(`No governance group for domain: ${domain}`);
                return;
            }

            const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!uuidPattern.test(groupId)) {
                throw new Error(`Governance mapping for domain '${domain}' must be a group UUID, got: ${groupId}`);
            }

            const preflight = await this.governanceRequest(accessToken, {
                service: 'ruleset',
                method: 'patch',
                path: `/configure/workspace-groups/${groupId}`,
                body: {
                    workspaces: { add: [], remove: [] },
                    vulnerabilities: { add: [], remove: [] },
                },
            }, teamId);

            if (!preflight.ok) {
                const body = await preflight.text();
                throw new Error(`Governance group preflight failed for ${groupId}: ${preflight.status} - ${body}`);
            }

            const groupData = await preflight.json();
            const groupRecord = PostmanApiClient.getRecord(groupData);
            const groupName = PostmanApiClient.getString(groupRecord.name) || groupId;

            const existing = PostmanApiClient.getArray(groupRecord.workspaces) as Array<{ id: string }>;
            if (existing.some((w: { id: string }) => w.id === workspaceId)) {
                core.info(`Workspace ${workspaceId} already in governance group: ${groupName}`);
                return;
            }

            const response = await this.governanceRequest(accessToken, {
                service: 'ruleset',
                method: 'patch',
                path: `/configure/workspace-groups/${groupId}`,
                body: {
                    workspaces: { add: [workspaceId], remove: [] },
                    vulnerabilities: { add: [], remove: [] },
                },
            }, teamId);

            if (!response.ok) {
                const body = await response.text();
                throw new Error(`Failed to assign workspace to governance group ${groupName}: ${response.status} - ${body}`);
            }
            core.info(`Workspace ${workspaceId} assigned to governance group: ${groupName}`);
        });
    }

    public async removeWorkspaceFromGovernanceGroup(workspaceId: string, groupId: string, accessToken: string, teamId?: string): Promise<void> {
        const response = await this.governanceRequest(accessToken, {
            service: 'ruleset',
            method: 'patch',
            path: `/configure/workspace-groups/${groupId}`,
            body: {
                workspaces: { add: [], remove: [workspaceId] },
                vulnerabilities: { add: [], remove: [] },
            },
        }, teamId);

        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Failed to remove workspace from governance group ${groupId}: ${response.status} - ${body}`);
        }
        core.info(`Workspace ${workspaceId} removed from governance group: ${groupId}`);
    }

    public async inviteRequesterToWorkspace(workspaceId: string, email: string): Promise<void> {
        const usersResp = await this.fetch('/users');
        const user = PostmanApiClient.getNestedArray(usersResp, 'data')
            .map((entry) => PostmanApiClient.getRecord(entry))
            .find((entry) => entry.email === email);

        if (user && user.id) {
            await this.fetch(`/workspaces/${workspaceId}/roles`, {
                method: 'PATCH',
                body: JSON.stringify({
                    roles: [{ op: 'add', path: '/user', value: [{ id: user.id, role: 2 }] }] // 2 = Editor
                })
            });
            core.info(`Invited user: ${email} (userId: ${String(user.id)}) as Editor`);
        } else {
            core.info(`User not found in org: ${email}`);
        }
    }

    public async addAdminsToWorkspace(workspaceId: string, adminIds: string): Promise<void> {
        if (!adminIds) {
            core.info('No workspace admin user IDs configured, skipping');
            return;
        }

        const ids = adminIds.split(',').filter(id => id.trim());
        if (ids.length === 0) {
            return;
        }

        const value = ids.map(id => ({ id: parseInt(id.trim(), 10), role: 3 })); // 3 = Admin
        await this.fetch(`/workspaces/${workspaceId}/roles`, {
            method: 'PATCH',
            body: JSON.stringify({
                roles: [{ op: 'add', path: '/user', value }]
            })
        });
        core.info(`Added workspace admins: ${adminIds}`);
    }

    public async uploadSpec(workspaceId: string, projectName: string, specContent: string): Promise<string> {
        const payload = {
            name: projectName,
            type: "OPENAPI:3.0",
            files: [{ path: "index.yaml", content: specContent }]
        };

        const response = await this.fetch(`/specs?workspaceId=${workspaceId}`, {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        const responseRecord = PostmanApiClient.getRecord(response);
        if (!responseRecord.id) {
            throw new Error(`Spec upload did not return an ID`);
        }

        const specId = String(responseRecord.id);
        core.info(`Spec uploaded: ${specId}`);

        // Verify it's readable
        await retry(async () => {
            const verifyResp = await this.fetch(`/specs/${specId}?workspaceId=${workspaceId}`);
            if (PostmanApiClient.getString(PostmanApiClient.getRecord(verifyResp).id) !== specId) {
                throw new Error(`Spec preflight response did not contain expected id ${specId}`);
            }
        }, 3, 2000);

        core.info(`Spec preflight verified: ${specId}`);
        return specId;
    }

    public async updateSpec(specId: string, specContent: string): Promise<void> {
        await this.fetch(`/specs/${specId}/files/index.yaml`, {
            method: 'PATCH',
            body: JSON.stringify({ content: specContent })
        });
        core.info(`Spec updated: ${specId}`);
    }

    public async generateCollection(specId: string, projectName: string, prefix: string): Promise<string> {
        core.info(`Generating collection: ${prefix}...`);

        return retry(async () => {
            const payload = {
                name: `${prefix} ${projectName}`,
                options: { requestNameSource: 'Fallback' }
            };

            // 423-aware request: if the API reports a generation is already in
            // progress for this spec, wait with exponential backoff and retry.
            const MAX_LOCKED_RETRIES = 5;
            const LOCKED_INITIAL_DELAY_MS = 5000;
            let response: any;
            for (let lockedAttempt = 0; ; lockedAttempt++) {
                try {
                    response = await this.fetch(`/specs/${specId}/generations/collection`, {
                        method: 'POST',
                        body: JSON.stringify(payload)
                    });
                    break; // success — exit the 423 retry loop
                } catch (err: any) {
                    const is423 = err?.message?.includes('423');
                    if (is423 && lockedAttempt < MAX_LOCKED_RETRIES) {
                        const delay = LOCKED_INITIAL_DELAY_MS * Math.pow(2, lockedAttempt);
                        core.warning(`Collection generation locked for ${prefix} (attempt ${lockedAttempt + 1}/${MAX_LOCKED_RETRIES}), retrying in ${delay / 1000}s...`);
                        await new Promise(r => setTimeout(r, delay));
                    } else {
                        throw err; // not a 423 or retries exhausted
                    }
                }
            }

            const extractUid = (data: any) =>
                data?.details?.resources?.[0]?.id ||
                data?.collection?.id ||
                data?.collection?.uid ||
                data?.resource?.uid ||
                data?.resource?.id;

            const directUid = extractUid(response);
            if (directUid) return directUid;

            let taskUrl = response?.url || response?.task_url || response?.taskUrl || response?.links?.task;
            if (!taskUrl) {
                const taskId = response?.taskId || response?.task?.id || response?.id;
                if (taskId) {
                    taskUrl = `/specs/${specId}/tasks/${taskId}`;
                } else {
                    throw new Error(`Collection generation did not return a task URL or ID for ${prefix}`);
                }
            }

            // Poll task
            for (let i = 0; i < 45; i++) {
                await new Promise(r => setTimeout(r, 2000));
                try {
                    const taskResponse = await this.fetch(taskUrl);
                    const taskRecord = PostmanApiClient.getRecord(taskResponse);
                    const taskStatus = PostmanApiClient.getString(taskRecord.status)
                        || PostmanApiClient.getNestedString(taskRecord.task, 'status');
                    const status = taskStatus.toLowerCase();

                    if (status === 'completed') {
                        const colUid = extractUid(taskResponse);
                        if (colUid) return colUid;
                        throw new Error(`Task completed but no UID found for ${prefix}`);
                    } else if (status === 'failed') {
                        throw new Error(`Task failed for ${prefix}`);
                    }
                } catch (e) {
                    core.warning(`Task poll error for ${prefix}: ${e}`);
                }
            }

            throw new Error(`Collection generation timed out for ${prefix}`);
        }, 4, 2000);
    }

    public async tagCollection(collectionUid: string, tags: string[]): Promise<void> {
        const normalizeSlug = (raw: string): string => {
            return String(raw || '')
                .toLowerCase()
                .trim()
                .replace(/[^a-z0-9-]+/g, '-')
                .replace(/^-+|-+$/g, '');
        };
        const normalized = tags
            .map(normalizeSlug)
            .filter((slug) => /^[a-z][a-z0-9-]*[a-z0-9]$/.test(slug));
        if (normalized.length === 0) {
            throw new Error(`No valid tag slugs to apply for collection ${collectionUid}`);
        }
        await this.fetch(`/collections/${collectionUid}/tags`, {
            method: 'PUT',
            body: JSON.stringify({
                tags: normalized.map((slug) => ({ slug }))
            })
        });
        core.info(`Tagged collection ${collectionUid} with [${normalized.join(', ')}]`);
    }

    public async injectTests(collectionUid: string, type: 'smoke' | 'contract'): Promise<void> {
        // Implementation port of JQ_INJECT mapped to JS objects
        const getColResp = await this.fetch(`/collections/${collectionUid}`);
        const collection = PostmanApiClient.getNestedRecord(getColResp, 'collection') as Record<string, unknown> & { item?: any[] };
        if (!Object.keys(collection).length) throw new Error(`Failed to fetch collection ${collectionUid}`);

        const smokeTests = [
            "// [Smoke] Auto-generated test assertions",
            "",
            "pm.test('Status code is successful (2xx)', function () {",
            "    pm.response.to.be.success;",
            "});",
            "",
            "pm.test('Response time is acceptable', function () {",
            "    var threshold = parseInt(pm.environment.get('RESPONSE_TIME_THRESHOLD') || '2000', 10);",
            "    pm.expect(pm.response.responseTime).to.be.below(threshold);",
            "});",
            "",
            "pm.test('Response body is not empty', function () {",
            "    if (pm.response.code !== 204) {",
            "        var body = pm.response.text();",
            "        pm.expect(body.length).to.be.above(0);",
            "    }",
            "});"
        ];

        const contractTests = [
            "// [Contract] Auto-generated contract test assertions",
            "",
            "pm.test('Status code is successful (2xx)', function () {",
            "    pm.response.to.be.success;",
            "});",
            "",
            "pm.test('Response time is acceptable', function () {",
            "    var threshold = parseInt(pm.environment.get('RESPONSE_TIME_THRESHOLD') || '2000', 10);",
            "    pm.expect(pm.response.responseTime).to.be.below(threshold);",
            "});",
            "",
            "pm.test('Response body is not empty', function () {",
            "    if (pm.response.code !== 204) {",
            "        var body = pm.response.text();",
            "        pm.expect(body.length).to.be.above(0);",
            "    }",
            "});",
            "",
            "pm.test('Content-Type is application/json', function () {",
            "    if (pm.response.code !== 204) {",
            "        pm.response.to.have.header('Content-Type');",
            "        pm.expect(pm.response.headers.get('Content-Type')).to.include('application/json');",
            "    }",
            "});",
            "",
            "pm.test('Response is valid JSON', function () {",
            "    if (pm.response.code !== 204) {",
            "        pm.response.to.be.json;",
            "    }",
            "});",
            "",
            "// Validate required fields from response schema",
            "pm.test('Required fields are present', function () {",
            "    if (pm.response.code === 204) return;",
            "    var jsonData = pm.response.json();",
            "    pm.expect(jsonData).to.be.an('object');",
            "    var keys = Object.keys(jsonData);",
            "    if (keys.length === 1 && Array.isArray(jsonData[keys[0]])) {",
            "        pm.expect(jsonData[keys[0]]).to.be.an('array');",
            "    }",
            "});",
            "",
            "// Validate response field types (non-null required fields)",
            "pm.test('Field types are correct', function () {",
            "    if (pm.response.code === 204) return;",
            "    var jsonData = pm.response.json();",
            "    Object.keys(jsonData).forEach(function(key) {",
            "        pm.expect(jsonData[key]).to.not.be.undefined;",
            "    });",
            "});",
            "",
            "(function() {",
            "    var status = pm.response.code;",
            "    if (status === 204) return; ",
            "    try {",
            "        var body = pm.response.json();",
            "        pm.test('Response body matches expected structure', function () {",
            "            pm.expect(typeof body).to.equal('object');",
            "            if (status >= 400) {",
            "                pm.expect(body).to.have.property('error');",
            "                pm.expect(body).to.have.property('message');",
            "            }",
            "        });",
            "    } catch (e) {}",
            "})();"
        ];

        const scriptsToInject = type === 'smoke' ? smokeTests : contractTests;

        const request0Item = {
            "name": "00 - Resolve Secrets",
            "request": {
                "auth": {
                    "type": "awsv4",
                    "awsv4": [
                        { "key": "accessKey", "value": "{{AWS_ACCESS_KEY_ID}}" },
                        { "key": "secretKey", "value": "{{AWS_SECRET_ACCESS_KEY}}" },
                        { "key": "region", "value": "{{AWS_REGION}}" },
                        { "key": "service", "value": "secretsmanager" }
                    ]
                },
                "method": "POST",
                "header": [
                    { "key": "X-Amz-Target", "value": "secretsmanager.GetSecretValue" },
                    { "key": "Content-Type", "value": "application/x-amz-json-1.1" }
                ],
                "body": {
                    "mode": "raw",
                    "raw": "{\"SecretId\": \"{{AWS_SECRET_NAME}}\"}"
                },
                "url": {
                    "raw": "https://secretsmanager.{{AWS_REGION}}.amazonaws.com",
                    "protocol": "https",
                    "host": ["secretsmanager", "{{AWS_REGION}}", "amazonaws", "com"]
                }
            },
            "event": [
                {
                    "listen": "test",
                    "script": {
                        "exec": [
                            "if (pm.environment.get(\"CI\") === \"true\") { return; }",
                            "const body = pm.response.json();",
                            "if (body.SecretString) {",
                            "  const secrets = JSON.parse(body.SecretString);",
                            "  Object.entries(secrets).forEach(([k, v]) => pm.collectionVariables.set(k, v));",
                            "}"
                        ]
                    }
                }
            ]
        };

        const injectScripts = (itemNode: any) => {
            if (itemNode.name === '00 - Resolve Secrets') {
                return;
            }
            if (itemNode.request) {
                itemNode.event = (itemNode.event || []).filter((e: any) => e.listen !== 'test');
                itemNode.event.push({
                    listen: 'test',
                    script: { type: 'text/javascript', exec: scriptsToInject }
                });
            }
            if (itemNode.item && Array.isArray(itemNode.item)) {
                itemNode.item.forEach((child: any) => {
                    injectScripts(child);
                });
            }
        };

        if (collection.item && Array.isArray(collection.item)) {
            collection.item = collection.item.filter(
                (entry: any) => entry.name !== '00 - Resolve Secrets'
            );
            collection.item.forEach((child: any) => {
                injectScripts(child);
            });
        } else {
            collection.item = [];
        }

        // Prepend Request 0
        collection.item.unshift(request0Item);

        await this.fetch(`/collections/${collectionUid}`, {
            method: 'PUT',
            body: JSON.stringify({ collection })
        });

        core.info(`Injected ${type} tests into collection: ${collectionUid}`);
    }

    public async createInsightsService(name: string, collectionId: string): Promise<string> {
        const payload = {
            name,
            postman_meta_data: { collection_id: collectionId }
        };
        const response = await fetch('https://api.observability.postman.com/v1/services', {
            method: 'POST',
            headers: {
                'x-api-key': this.apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (response.status === 409) {
            core.info(`Insights service already exists for collection ${collectionId}, resolving existing...`);
            return this.resolveInsightsServiceId(collectionId);
        }

        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Insights service create failed: ${response.status} - ${body}`);
        }

        const data = await response.json();
        const dataRecord = PostmanApiClient.getRecord(data);
        return String(dataRecord.resource_id || dataRecord.id);
    }

    private async resolveInsightsServiceId(collectionId: string): Promise<string> {
        const response = await fetch('https://api.observability.postman.com/v1/services', {
            headers: { 'x-api-key': this.apiKey }
        });
        if (!response.ok) throw new Error(`Failed to list Insights services: ${response.status}`);
        const data = await response.json();
        // data is likely an array
        const service = Array.isArray(data) ? data.find((s: any) => s.postman_meta_data?.collection_id === collectionId) : null;
        if (!service?.id) throw new Error(`Could not resolve existing Insights service for collection ${collectionId}`);
        return service.id.toString();
    }

    public async verifyInsightsService(serviceId: string): Promise<void> {
        const response = await fetch(`https://api.observability.postman.com/v2/agent/services/${serviceId}`, {
            headers: { 'x-api-key': this.apiKey }
        });
        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Insights service verification failed for ${serviceId}: ${response.status} - ${body}`);
        }
    }

    public async createEnvironment(workspaceId: string, name: string, values: Array<{ key: string, value: string, type: string }>): Promise<string> {
        const payload = {
            environment: {
                name,
                values
            }
        };
        const response = await this.fetch(`/environments?workspace=${workspaceId}`, {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        const environment = PostmanApiClient.getNestedRecord(response, 'environment');
        if (!environment.uid) throw new Error('Environment create did not return a UID');
        return String(environment.uid);
    }

    public async updateEnvironment(uid: string, name: string, values: Array<{ key: string, value: string, type: string }>): Promise<void> {
        const payload = {
            environment: {
                name,
                values
            }
        };
        await this.fetch(`/environments/${uid}`, {
            method: 'PUT',
            body: JSON.stringify(payload)
        });
    }

    public async proxyBifrost(workspaceId: string, repoUrl: string, teamId: string, accessToken: string, orgTeamId?: string): Promise<void> {
        core.info(`Bifrost connect: workspace=${workspaceId}, teamId=${teamId}${orgTeamId && orgTeamId !== teamId ? `, orgTeamId=${orgTeamId}` : ''}`);
        const response = await this.bifrostRequest('POST', `/workspaces/${workspaceId}/filesystem`, teamId, accessToken, {
            path: '/',
            repo: repoUrl,
            versionControl: true
        });

        if (!response.ok) {
            const body = await response.text();
            if (response.status === 400 && body.includes('invalidParamError') && body.includes('already exists')) {
                const linkedRepoUrl = await this.getWorkspaceGitRepoUrl(workspaceId, teamId, accessToken);
                if (this.normalizeGitHubRepoUrl(linkedRepoUrl) === this.normalizeGitHubRepoUrl(repoUrl)) {
                    core.info(`Bifrost connection already exists for workspace ${workspaceId}, skipping.`);
                    return;
                }
                throw new Error(`Bifrost link already exists for ${repoUrl}, but workspace ${workspaceId} is not linked to that repo`);
            }
            if (response.status === 400 && body.includes('projectAlreadyConnected')) {
                const linkedRepoUrl = await this.getWorkspaceGitRepoUrl(workspaceId, teamId, accessToken);
                if (this.normalizeGitHubRepoUrl(linkedRepoUrl) === this.normalizeGitHubRepoUrl(repoUrl)) {
                    core.info(`Workspace ${workspaceId} is already connected to ${repoUrl}, skipping.`);
                    return;
                }
                throw new Error(`Workspace ${workspaceId} is already connected to a different repo`);
            }
            // On 403, retry with org-level team ID if it differs from the sub-team ID
            if (response.status === 403 && orgTeamId && orgTeamId !== teamId) {
                core.warning(`Bifrost 403 with sub-team ID ${teamId}, retrying with org-level team ID ${orgTeamId}…`);
                const retryResponse = await this.bifrostRequest('POST', `/workspaces/${workspaceId}/filesystem`, orgTeamId, accessToken, {
                    path: '/',
                    repo: repoUrl,
                    versionControl: true
                });
                if (retryResponse.ok) {
                    core.info(`Bifrost connect succeeded with org-level team ID ${orgTeamId}`);
                    return;
                }
                const retryBody = await retryResponse.text();
                if (retryResponse.status === 400 && (retryBody.includes('already exists') || retryBody.includes('projectAlreadyConnected'))) {
                    core.info(`Bifrost connection already exists (discovered on retry), skipping.`);
                    return;
                }
                throw new Error(`Bifrost proxy request failed (retry with org-level team ID): ${retryResponse.status} - ${retryBody}`);
            }
            throw new Error(`Bifrost proxy request failed: ${response.status} - ${body}. ` +
                `Troubleshooting: verify POSTMAN_ACCESS_TOKEN is current (tokens can expire), ` +
                `team ID ${teamId} has access to workspace ${workspaceId}, ` +
                `and the workspace was created under the correct team context.`);
        }
    }

    public async createMonitor(workspaceId: string, name: string, collectionUid: string, environmentUid: string): Promise<string> {
        const payload = {
            monitor: {
                name,
                collection: collectionUid,
                environment: environmentUid,
                schedule: {
                    cron: "*/5 * * * *",
                    timezone: "UTC"
                }
            }
        };
        const response = await this.fetch(`/monitors?workspace=${workspaceId}`, {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        const monitor = PostmanApiClient.getNestedRecord(response, 'monitor');
        if (!monitor.uid) throw new Error('Monitor create did not return a UID');
        return String(monitor.uid);
    }

    public async createMock(workspaceId: string, name: string, collectionUid: string, environmentUid: string): Promise<{ uid: string, url: string }> {
        const payload = {
            mock: {
                name,
                collection: collectionUid,
                environment: environmentUid,
                private: false
            }
        };
        const response = await this.fetch(`/mocks?workspace=${workspaceId}`, {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        const mock = PostmanApiClient.getNestedRecord(response, 'mock');
        if (!mock.uid) throw new Error('Mock create did not return a UID');
        return {
            uid: String(mock.uid),
            url: PostmanApiClient.getString(mock.mockUrl)
                || PostmanApiClient.getNestedString(mock.config, 'serverResponseId')
                || ''
        };
    }

    public async getCollection(uid: string): Promise<any> {
        const response = await this.fetch(`/collections/${uid}`);
        return PostmanApiClient.getNestedRecord(response, 'collection');
    }

    public async getEnvironment(uid: string): Promise<any> {
        const response = await this.fetch(`/environments/${uid}`);
        return PostmanApiClient.getNestedRecord(response, 'environment');
    }

    public async getMock(uid: string): Promise<any> {
        const response = await this.fetch(`/mocks/${uid}`);
        return PostmanApiClient.getNestedRecord(response, 'mock');
    }

    public async deleteWorkspace(id: string): Promise<void> {
        await this.fetch(`/workspaces/${id}`, {
            method: 'DELETE'
        });
    }

    public async getEnvironments(workspaceId: string): Promise<any[]> {
        const response = await this.fetch(`/environments?workspace=${workspaceId}`);
        return PostmanApiClient.getNestedArray(response, 'environments');
    }
}

const VOLATILE_KEYS = new Set([
    'createdAt',
    'updatedAt',
    'lastUpdatedBy'
]);

export function stripVolatileFields(obj: unknown): unknown {
    if (Array.isArray(obj)) {
        return obj.map(stripVolatileFields);
    }
    if (obj !== null && typeof obj === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
            if (VOLATILE_KEYS.has(key)) {
                continue;
            }
            if (key === 'id' && typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)) {
                continue;
            }
            if (key === 'uid' && typeof value === 'string' && /^\d+-[0-9a-f-]{36}$/.test(value)) {
                continue;
            }
            result[key] = stripVolatileFields(value);
        }
        return result;
    }
    return obj;
}
