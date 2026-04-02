import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostmanApiClient } from '../.github/actions/_lib/postman-api';
import { GitHubApiClient } from '../.github/actions/_lib/github-api';
import { PROVISION_STEP_NAMES } from '../src/lib/provision-steps';
import { TEST_GITHUB_ORG } from './helpers/constants';

vi.mock('@actions/core', () => ({
    getInput: vi.fn(),
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    notice: vi.fn(),
    group: vi.fn(async (_name: string, fn: () => unknown | Promise<unknown>) => await fn()),
    startGroup: vi.fn(),
    endGroup: vi.fn(),
}));
vi.mock('@actions/exec', () => ({
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockResolvedValue({ stdout: '{}', stderr: '', exitCode: 0 }),
}));
vi.mock('@actions/io');

describe('postman-bootstrap action unit tests', () => {
    let postman: PostmanApiClient;
    let github: GitHubApiClient;

    beforeEach(() => {
        postman = new PostmanApiClient('fake-key');
        github = new GitHubApiClient('fake-token', 'owner/repo');

        // Setup global fetch mock
        global.fetch = vi.fn();
        vi.stubGlobal('setTimeout', (cb: Function) => cb());
    });

    it('should create workspace correctly', async () => {
        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ workspace: { id: 'ws-123', visibility: 'team' } }),
            text: async () => '{}'
        } as any);

        // verify fetch
        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ workspace: { id: 'ws-123', visibility: 'team' } }),
            text: async () => '{}'
        } as any);

        const result = await postman.createWorkspace('Test WS', 'desc');
        expect(result.id).toBe('ws-123');
    });

    it('auto-derives the Postman team id from /me', async () => {
        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ user: { teamId: 132109 } }),
            text: async () => '{}'
        } as any);

        await expect(postman.getAutoDerivedTeamId()).resolves.toBe('132109');
    });

    it('creates a team workspace via public API even when access token context is present', async () => {
        vi.mocked(global.fetch)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ workspace: { id: 'ws-public-123' } }),
                text: async () => '{}'
            } as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ workspace: { id: 'ws-public-123', visibility: 'team' } }),
                text: async () => '{}'
            } as any);

        const result = await postman.createWorkspace('Test WS', 'desc', {
            accessToken: 'session-token',
            teamId: '13347347',
            teamName: 'Field Services v12 Demo',
        });

        expect(result.id).toBe('ws-public-123');
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(vi.mocked(global.fetch).mock.calls[0]?.[0]).toBe('https://api.getpostman.com/workspaces');
        expect(JSON.parse(String(vi.mocked(global.fetch).mock.calls[0]?.[1]?.body || '{}'))).toEqual({
            workspace: {
                name: 'Test WS',
                type: 'team',
                description: 'desc',
                teamId: 13347347,
            }
        });
    });

    it('throws a hard error when team-scoped creation fails due to Org Mode restrictions', async () => {
        // First call: team type fails with org mode error
        vi.mocked(global.fetch).mockResolvedValue({
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            text: async () => JSON.stringify({
                error: { name: 'invalidParamError', message: 'Only personal workspaces (internal) can be created outside team' }
            })
        } as any);

        await expect(postman.createWorkspace('Org Mode WS', 'desc', 999))
            .rejects.toThrow(/Org Mode workspace creation failed for team ID 999.*Only personal workspaces/);

        // Verify: only one call was made, and it included the teamId
        const calls = vi.mocked(global.fetch).mock.calls;
        expect(calls.length).toBe(3);
        expect(JSON.parse(calls[0][1]?.body as string)).toEqual(
            expect.objectContaining({ workspace: expect.objectContaining({ type: 'team', teamId: 999 }) })
        );
    });

    it('should upload spec correctly', async () => {
        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: 'spec-123' }),
            text: async () => '{}'
        } as any);

        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: 'spec-123' }),
            text: async () => '{}'
        } as any);

        const result = await postman.uploadSpec('ws-123', 'Project', 'content');
        expect(result).toBe('spec-123');
    });

    it('should handle collection generation polling', async () => {
        // Mock generation trigger response
        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ task_url: '/task/123' }),
            text: async () => '{}'
        } as any);

        // Mock poll response (still pending)
        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ status: 'running' }),
            text: async () => '{}'
        } as any);

        // Mock poll response (completed)
        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ status: 'completed', collection: { uid: 'col-123' } }),
            text: async () => '{}'
        } as any);

        const result = await postman.generateCollection('spec-123', 'Project', '[Smoke]');
        expect(result).toBe('col-123');
        expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('should retry on failure during workspace creation', async () => {
        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            text: async () => 'Internal Server Error'
        } as any);

        // Success on second try
        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ workspace: { id: 'ws-retry', visibility: 'team' } }),
            text: async () => '{}'
        } as any);

        // Verify
        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ workspace: { id: 'ws-retry', visibility: 'team' } }),
            text: async () => '{}'
        } as any);

        const result = await postman.createWorkspace('Test Retry', 'desc');
        expect(result.id).toBe('ws-retry');
        expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('should retry on 423 Locked during collection generation', async () => {
        vi.useFakeTimers();

        // First call: 423 Locked
        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: false,
            status: 423,
            statusText: 'Locked',
            text: async () => '{"detail":"Collection generation is already in progress for the spec.","type":"actionLockedError","status":423}'
        } as any);

        // Second call: success with direct UID
        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ collection: { uid: 'col-after-lock' } }),
            text: async () => '{}'
        } as any);

        const genPromise = postman.generateCollection('spec-123', 'Project', '[Smoke]');

        // Advance past the 423 backoff delay (5000ms initial)
        await vi.advanceTimersByTimeAsync(5000);

        const result = await genPromise;
        expect(result).toBe('col-after-lock');
        expect(global.fetch).toHaveBeenCalledTimes(2);

        vi.useRealTimers();
    });

    it('should exhaust 423 retries and throw', async () => {
        // beforeEach stubs setTimeout to execute immediately, so all
        // backoff delays resolve synchronously — no fake timers needed.
        vi.mocked(global.fetch).mockResolvedValue({
            ok: false,
            status: 423,
            statusText: 'Locked',
            text: async () => '{"detail":"Collection generation is already in progress for the spec.","type":"actionLockedError","status":423}'
        } as any);

        await expect(
            postman.generateCollection('spec-123', 'Project', '[Smoke]')
        ).rejects.toThrow('423');
    });

    it('regression: collection generation must not use Promise.allSettled (prevents 423 Locked)', async () => {
        const fs = await import('fs');
        const source = fs.readFileSync(
            '.github/actions/postman-bootstrap/src/index.ts',
            'utf-8'
        );
        // Extract the section around GENERATE_COLLECTIONS_FROM_SPEC
        const genSection = source.slice(
            source.indexOf('GENERATE_COLLECTIONS_FROM_SPEC'),
            source.indexOf('INJECT_TEST_SCRIPTS_AND_REQUEST_0')
        );
        expect(genSection).not.toContain('Promise.allSettled');
        expect(genSection).not.toContain('Promise.all(');
    });

    it('step names match PROVISION_STEP_NAMES', () => {
        const stepKeys = Object.keys(PROVISION_STEP_NAMES);
        expect(stepKeys).toContain('INSTALL_POSTMAN_CLI');
        expect(stepKeys).toContain('CREATE_POSTMAN_WORKSPACE');
        expect(stepKeys).toContain('UPLOAD_SPEC_TO_SPEC_HUB');
        expect(stepKeys).toContain('LINT_SPEC_VIA_POSTMAN_CLI');
        expect(stepKeys).toContain('GENERATE_COLLECTIONS_FROM_SPEC');
        expect(stepKeys).toContain('INJECT_TEST_SCRIPTS_AND_REQUEST_0');
        expect(stepKeys).toContain('TAG_COLLECTIONS');
    });
});

describe('GitHubApiClient fallback token behavior', () => {
    beforeEach(() => {
        global.fetch = vi.fn();
    });

    it('retries variable writes with fallback token after primary 403', async () => {
        const client = new GitHubApiClient('primary-token', 'owner/repo', 'fallback-token');
        vi.mocked(global.fetch)
            .mockResolvedValueOnce({
                ok: false,
                status: 403,
                clone: () => ({ text: async () => 'forbidden' }),
                text: async () => 'forbidden',
                headers: new Headers(),
            } as any)
            .mockResolvedValueOnce({
                ok: true,
                status: 201,
                clone: () => ({ text: async () => '' }),
                text: async () => '',
                headers: new Headers(),
            } as any);

        await client.setRepositoryVariable('LINT_WARNINGS', '63');

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(vi.mocked(global.fetch).mock.calls[0]?.[1]?.headers).toMatchObject({
            Authorization: 'Bearer primary-token',
        });
        expect(vi.mocked(global.fetch).mock.calls[1]?.[1]?.headers).toMatchObject({
            Authorization: 'Bearer fallback-token',
        });
    });

    it('retries variable reads with fallback token after primary 403', async () => {
        const client = new GitHubApiClient('primary-token', 'owner/repo', 'fallback-token');
        vi.mocked(global.fetch)
            .mockResolvedValueOnce({
                ok: false,
                status: 403,
                clone: () => ({ text: async () => 'forbidden' }),
                text: async () => 'forbidden',
                headers: new Headers(),
            } as any)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                clone: () => ({ text: async () => '' }),
                text: async () => '',
                json: async () => ({ value: 'ok' }),
                headers: new Headers(),
            } as any);

        await expect(client.getRepositoryVariable('X')).resolves.toBe('ok');
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('supports fallback_pat_first auth mode', async () => {
        const client = new GitHubApiClient('primary-token', 'owner/repo', {
            fallbackToken: 'fallback-token',
            authMode: 'fallback_pat_first',
        });

        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: true,
            status: 201,
            clone: () => ({ text: async () => '' }),
            text: async () => '',
            headers: new Headers(),
        } as any);

        await client.setRepositoryVariable('LINT_WARNINGS', '1');

        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(vi.mocked(global.fetch).mock.calls[0]?.[1]?.headers).toMatchObject({
            Authorization: 'Bearer fallback-token',
        });
    });

    it('tracks fallback telemetry counters', async () => {
        const client = new GitHubApiClient('primary-token', 'owner/repo', 'fallback-token');
        vi.mocked(global.fetch)
            .mockResolvedValueOnce({
                ok: false,
                status: 403,
                clone: () => ({ text: async () => 'forbidden' }),
                text: async () => 'forbidden',
                headers: new Headers(),
            } as any)
            .mockResolvedValueOnce({
                ok: true,
                status: 201,
                clone: () => ({ text: async () => '' }),
                text: async () => '',
                headers: new Headers(),
            } as any);

        await client.setRepositoryVariable('X', '1');
        expect(client.getTelemetry().fallbackUses.variables).toBe(1);
    });

    it('lists repository variables once and serves cached reads locally', async () => {
        const client = new GitHubApiClient('primary-token', 'owner/repo');
        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: true,
            status: 200,
            clone: () => ({ text: async () => '' }),
            text: async () => '',
            json: async () => ({
                total_count: 2,
                variables: [
                    { name: 'RUNTIME_BASE_URL', value: 'https://cached.example.com' },
                    { name: 'POSTMAN_ENVIRONMENT_UID', value: 'env-uid-123' },
                ],
            }),
            headers: new Headers(),
        } as any);

        await expect(client.listRepositoryVariables()).resolves.toEqual({
            RUNTIME_BASE_URL: 'https://cached.example.com',
            POSTMAN_ENVIRONMENT_UID: 'env-uid-123',
        });
        await expect(client.getRepositoryVariable('RUNTIME_BASE_URL')).resolves.toBe('https://cached.example.com');
        await expect(client.getRepositoryVariable('MISSING_VAR')).resolves.toBe('');

        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('retries 429 responses using retry-after before succeeding', async () => {
        vi.useFakeTimers();
        const client = new GitHubApiClient('primary-token', 'owner/repo');

        vi.mocked(global.fetch)
            .mockResolvedValueOnce({
                ok: false,
                status: 429,
                clone: () => ({ text: async () => 'rate limited' }),
                text: async () => 'rate limited',
                headers: new Headers({ 'retry-after': '1' }),
            } as any)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                clone: () => ({ text: async () => '' }),
                text: async () => '',
                json: async () => ({ value: 'ok' }),
                headers: new Headers(),
            } as any);

        const promise = client.getRepositoryVariable('RUNTIME_BASE_URL');
        await vi.advanceTimersByTimeAsync(1500);

        await expect(promise).resolves.toBe('ok');
        expect(global.fetch).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });

    it('retries 403 rate-limit responses using x-ratelimit-reset before succeeding', async () => {
        vi.useFakeTimers();
        const client = new GitHubApiClient('primary-token', 'owner/repo');
        const resetSeconds = String(Math.floor(Date.now() / 1000) + 1);

        vi.mocked(global.fetch)
            .mockResolvedValueOnce({
                ok: false,
                status: 403,
                clone: () => ({ text: async () => 'API rate limit exceeded' }),
                text: async () => 'API rate limit exceeded',
                headers: new Headers({ 'x-ratelimit-reset': resetSeconds, 'x-ratelimit-remaining': '0' }),
            } as any)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                clone: () => ({ text: async () => '' }),
                text: async () => '',
                json: async () => ({ value: 'ok' }),
                headers: new Headers(),
            } as any);

        const promise = client.getRepositoryVariable('RUNTIME_BASE_URL');
        await vi.advanceTimersByTimeAsync(2500);

        await expect(promise).resolves.toBe('ok');
        expect(global.fetch).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });
});

describe('PostmanApiClient tag slug normalization', () => {
    beforeEach(() => {
        global.fetch = vi.fn();
    });

    it('normalizes tag slugs to Postman API format', async () => {
        const client = new PostmanApiClient('fake-key');
        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({}),
            text: async () => '{}'
        } as any);

        await client.tagCollection('col-1', ['Generated Docs', 'generated_smoke']);

        const call = vi.mocked(global.fetch).mock.calls[0];
        expect(call?.[0]).toBe('https://api.getpostman.com/collections/col-1/tags');
        const body = JSON.parse(String(call?.[1]?.body || '{}'));
        expect(body).toEqual({
            tags: [{ slug: 'generated-docs' }, { slug: 'generated-smoke' }]
        });
    });
});

describe('postman-bootstrap GitHub variable write pacing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.GITHUB_REPOSITORY = `${TEST_GITHUB_ORG}/test-repo`;
    });

    it('serializes GitHub variable writes during repo variable persistence', async () => {
        let active = 0;
        let maxActive = 0;
        vi.spyOn(GitHubApiClient.prototype, 'setRepositoryVariable').mockImplementation(async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await Promise.resolve();
                await Promise.resolve();
                active -= 1;
        });

        const core = await import('@actions/core');
        vi.mocked(core.getInput).mockImplementation((name: string) => {
            const inputs: Record<string, string> = {
                project_name: 'test-api',
                postman_api_key: 'key',
                postman_access_token: 'token',
                github_app_token: 'ghtoken',
                postman_team_id: 'team',
                step: PROVISION_STEP_NAMES.STORE_POSTMAN_UIDS_AS_REPO_VARIABLES,
                workspace_id: 'ws-123',
                spec_uid: 'spec-123',
                baseline_uid: 'baseline-uid',
                smoke_uid: 'smoke-uid',
                contract_uid: 'contract-uid',
                environments: '["prod","stage"]',
                system_env_map: '{"prod":"sys-prod","stage":"sys-stage"}',
            };
            return inputs[name] || '';
        });
        (core.group as any).mockImplementation(async (_name: string, fn: any) => fn());
        (core.setFailed as any).mockImplementation(() => undefined);

        const { run } = await import('../.github/actions/postman-bootstrap/src/index');
        await run();

        expect(maxActive).toBe(1);
    });
});

describe('postman-bootstrap noop step behavior', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.GITHUB_REPOSITORY = `${TEST_GITHUB_ORG}/test-repo`;
        global.fetch = vi.fn();
    });

    it('exits before external API calls when step=noop', async () => {
        const core = await import('@actions/core');
        vi.mocked(core.getInput).mockImplementation((name: string) => {
            const inputs: Record<string, string> = {
                project_name: 'noop-project',
                domain: 'test',
                domain_code: 'test',
                requester_email: 'test@test.com',
                spec_url: 'https://example.com/spec.yaml',
                environments: '["prod"]',
                system_env_map: '{}',
                postman_api_key: 'test',
                postman_access_token: 'test',
                postman_team_id: '123',
                github_app_token: 'token',
                gh_fallback_token: '',
                gh_auth_mode: 'github_token_first',
                governance_mapping: '{}',
                step: 'noop',
            };
            return inputs[name] || '';
        });
        (core.info as any).mockImplementation(() => undefined);
        (core.setFailed as any).mockImplementation(() => undefined);

        const { run } = await import('../.github/actions/postman-bootstrap/src/index');
        await run();

        expect(global.fetch).not.toHaveBeenCalled();
        expect(core.setFailed).not.toHaveBeenCalled();
    });
});
