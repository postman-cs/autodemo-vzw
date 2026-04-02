import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { PROVISION_STEP_NAMES } from '../src/lib/provision-steps';
import { GitHubApiClient } from '../.github/actions/_lib/github-api';
import { TEST_GITHUB_ORG, TEST_MOCK_SYSTEM_ENV_ID } from './helpers/constants';

vi.mock('@actions/core', () => ({
    getInput: vi.fn(),
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    notice: vi.fn(),
    group: async (_name: string, fn: () => unknown | Promise<unknown>) => await fn(),
    startGroup: vi.fn(),
    endGroup: vi.fn(),
}));
vi.mock('@actions/exec', () => ({
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' })
}));
vi.mock('@actions/io', () => ({
    mkdirP: vi.fn().mockResolvedValue(undefined),
    cp: vi.fn(),
    mv: vi.fn()
}));
vi.mock('fs', () => ({
    default: {
        existsSync: vi.fn().mockReturnValue(false),
        writeFileSync: vi.fn(),
        readFileSync: vi.fn(),
        promises: {}
    },
    existsSync: vi.fn().mockReturnValue(false),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    promises: {}
}));
vi.mock('../.github/actions/_lib/postman-api', () => ({
    stripVolatileFields: vi.fn((value: unknown) => value),
    PostmanApiClient: vi.fn().mockImplementation(function () {
        return {
            createEnvironment: vi.fn().mockResolvedValue('env-uid-123'),
            createMock: vi.fn().mockResolvedValue({ uid: 'mock-uid', url: 'https://mock.pstmn.io' }),
            createMonitor: vi.fn().mockResolvedValue('monitor-uid-123'),
            getCollection: vi.fn().mockResolvedValue({ info: { name: 'test' } }),
            getEnvironment: vi.fn().mockResolvedValue({ name: 'test' }),
            proxyBifrost: vi.fn().mockResolvedValue(undefined)
        };
    })
}));
vi.mock('../.github/actions/_lib/github-api', () => ({
    GitHubApiClient: vi.fn().mockImplementation(function () {
        return {
            listRepositoryVariables: vi.fn().mockResolvedValue({}),
            getRepositoryVariable: vi.fn().mockResolvedValue(''),
            setRepositoryVariable: vi.fn().mockResolvedValue(undefined)
        };
    })
}));
vi.mock('../.github/actions/_lib/postman-v3-simple', () => ({
    convertAndSplitCollection: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('../.github/actions/_lib/step-output', () => ({
    setStepOutput: vi.fn(),
    logStepInfo: vi.fn()
}));

describe('finalize action logic', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        process.env.GITHUB_REPOSITORY = `${TEST_GITHUB_ORG}/test-repo`;
    });

    afterEach(() => {
        vi.useRealTimers();
        delete process.env.GITHUB_REPOSITORY;
    });

    it('should derive correct base URL for Lambda prod', () => {
        const runtimeMode = 'lambda';
        const envName = 'prod';
        const prodGwUrl = 'https://prod.execute-api.com';
        const devGwUrl = 'https://dev.execute-api.com';
        const runtimeBaseUrl = '';

        let baseUrl = runtimeBaseUrl;
        if (!baseUrl) {
            baseUrl = envName === 'prod' ? prodGwUrl : devGwUrl;
        }
        expect(baseUrl).toBe(prodGwUrl);
    });

    it('should correctly select environment for monitor', () => {
        const envUids: Record<string, string> = { 'prod': 'prod-uid', 'dev': 'dev-uid' };
        const selectedEnv = envUids['prod'] || envUids['dev'] || '';
        expect(selectedEnv).toBe('prod-uid');
    });

    it('should handle missing dev env by falling back to prod', () => {
        const envUids: Record<string, string> = { 'prod': 'prod-uid' };
        const selectedEnv = envUids['dev'] || envUids['prod'] || '';
        expect(selectedEnv).toBe('prod-uid');
    });

    it('should use PROVISION_STEP_NAMES constants for all step names', () => {
        // Verify the key finalize steps exist in the canonical contract
        expect(PROVISION_STEP_NAMES.CREATE_POSTMAN_ENVIRONMENTS).toBe('Create Postman Environments');
        expect(PROVISION_STEP_NAMES.CREATE_MOCK_SERVER).toBe('Create Mock Server');
        expect(PROVISION_STEP_NAMES.CREATE_SMOKE_MONITOR).toBe('Create Smoke Monitor');
        expect(PROVISION_STEP_NAMES.STORE_AWS_OUTPUTS_AS_REPO_VARIABLES).toBe('Store AWS Outputs as Repo Variables');
        expect(PROVISION_STEP_NAMES.EXPORT_POSTMAN_ARTIFACTS_TO_REPO).toBe('Export Postman Artifacts to Repo');
        expect(PROVISION_STEP_NAMES.CONNECT_WORKSPACE_VIA_BIFROST).toBe('Connect Workspace via Bifrost');
        expect(PROVISION_STEP_NAMES.GENERATE_FERN_DOCS).toBe('Generate Fern Docs');
        expect(PROVISION_STEP_NAMES.COMMIT_ARTIFACTS_AND_REPLACE_PROVISION_WITH_CI_WORKFLOW).toBe('Commit Artifacts & Replace Provision with CI Workflow');
        expect(PROVISION_STEP_NAMES.SUMMARY).toBe('Summary');
    });

    it('should emit a shared Fern docs URL placeholder instead of a deep link', async () => {
        const { GitHubApiClient } = await import('../.github/actions/_lib/github-api');
        const mockSetVar = vi.fn().mockResolvedValue(undefined);
        vi.mocked(GitHubApiClient).mockImplementation(function () {
            return {
                listRepositoryVariables: vi.fn().mockResolvedValue({}),
                getRepositoryVariable: vi.fn().mockResolvedValue(''),
                setRepositoryVariable: mockSetVar
            } as any;
        });

        vi.mocked(core.getInput).mockImplementation((name) => {
            const inputs: Record<string, string> = {
                'project_name': 'test-api',
                'runtime_mode': 'lambda',
                'environments': '["prod"]',
                'workspace_id': '',
                'runtime_base_url': '',
                'prod_gw_url': 'https://prod.execute-api.com',
                'dev_gw_url': 'https://dev.execute-api.com',
                'postman_api_key': 'key',
                'postman_access_token': 'token',
                'github_app_token': 'ghtoken',
                'postman_team_id': 'team',
                'step': PROVISION_STEP_NAMES.GENERATE_FERN_DOCS
            };
            return inputs[name] || '';
        });

        const mod = await import('../.github/actions/finalize/src/index');
        await mod.run();
        await vi.advanceTimersByTimeAsync(0);

        expect(mockSetVar).toHaveBeenCalledWith('FERN_DOCS_URL', 'https://verizon-demo.docs.buildwithfern.com');
    });

    it('should create environments and store repo variables for lambda runtime', async () => {
        const { PostmanApiClient } = await import('../.github/actions/_lib/postman-api');
        const mockCreateEnv = vi.fn().mockResolvedValue('env-uid-prod');
        vi.mocked(PostmanApiClient).mockImplementation(function () {
            return {
                createEnvironment: mockCreateEnv,
                createMock: vi.fn().mockResolvedValue({ uid: 'mock-uid', url: 'https://mock.pstmn.io' }),
                createMonitor: vi.fn().mockResolvedValue('mon-uid'),
                getCollection: vi.fn().mockResolvedValue({}),
                getEnvironment: vi.fn().mockResolvedValue({}),
                proxyBifrost: vi.fn()
            } as any;
        });

        const { GitHubApiClient } = await import('../.github/actions/_lib/github-api');
        const mockSetVar = vi.fn().mockResolvedValue(undefined);
        vi.mocked(GitHubApiClient).mockImplementation(function () {
            return {
                setRepositoryVariable: mockSetVar
            } as any;
        });

        vi.mocked(core.getInput).mockImplementation((name) => {
            const inputs: Record<string, string> = {
                'project_name': 'test-api',
                'runtime_mode': 'lambda',
                'environments': '["prod"]',
                'workspace_id': 'ws-123',
                'baseline_uid': 'bl-uid',
                'smoke_uid': 'sm-uid',
                'contract_uid': 'ct-uid',
                'runtime_base_url': '',
                'prod_gw_url': 'https://prod.execute-api.com',
                'dev_gw_url': 'https://dev.execute-api.com',
                'postman_api_key': 'key',
                'postman_access_token': 'token',
                'github_app_token': 'ghtoken',
                'postman_team_id': 'team',
                'step': 'Create Postman Environments'
            };
            return inputs[name] || '';
        });

        const mod = await import('../.github/actions/finalize/src/index');
        await mod.run();
        await vi.advanceTimersByTimeAsync(0);

        expect(mockCreateEnv).toHaveBeenCalledWith(
            'ws-123',
            'test-api - prod',
            expect.arrayContaining([
                expect.objectContaining({ key: 'baseUrl', value: 'https://prod.execute-api.com' })
            ])
        );
    });

    it('exports collection directories and a resources manifest for Collection v3 artifacts', async () => {
        const { PostmanApiClient } = await import('../.github/actions/_lib/postman-api');
        vi.mocked(PostmanApiClient).mockImplementation(function () {
            return {
                createEnvironment: vi.fn(),
                createMock: vi.fn(),
                createMonitor: vi.fn(),
                getCollection: vi.fn().mockResolvedValue({ info: { name: 'demo' }, item: [{ name: 'List Orders', request: { method: 'GET', url: 'https://api.example.com/orders' } }] }),
                getEnvironment: vi.fn().mockResolvedValue({ name: 'prod', values: [] }),
                proxyBifrost: vi.fn()
            } as any;
        });

        vi.mocked(core.getInput).mockImplementation((name) => {
            const inputs: Record<string, string> = {
                'project_name': 'test-api',
                'runtime_mode': 'lambda',
                'workspace_id': 'ws-123',
                'baseline_uid': 'bl-uid',
                'smoke_uid': 'sm-uid',
                'contract_uid': 'ct-uid',
                'env_uids': '{"prod":"env-uid-prod"}',
                'postman_api_key': 'key',
                'postman_access_token': 'token',
                'github_app_token': 'ghtoken',
                'postman_team_id': 'team',
                'step': 'Export Postman Artifacts to Repo'
            };
            return inputs[name] || '';
        });

        const fsModule = await import('fs');
        const { convertAndSplitCollection } = await import('../.github/actions/_lib/postman-v3-simple');

        const mod = await import('../.github/actions/finalize/src/index');
        await mod.run();
        await vi.advanceTimersByTimeAsync(0);
        expect(core.setFailed).not.toHaveBeenCalled();

        expect(vi.mocked(convertAndSplitCollection)).toHaveBeenCalledTimes(3);
        expect(vi.mocked(convertAndSplitCollection)).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ info: expect.objectContaining({ name: 'demo' }) }),
            'postman/collections/[Baseline] test-api'
        );
        expect(vi.mocked(convertAndSplitCollection)).toHaveBeenNthCalledWith(
            2,
            expect.any(Object),
            'postman/collections/[Smoke] test-api'
        );
        expect(vi.mocked(convertAndSplitCollection)).toHaveBeenNthCalledWith(
            3,
            expect.any(Object),
            'postman/collections/[Contract] test-api'
        );

        const resourceWrite = vi.mocked(fsModule.writeFileSync).mock.calls.find(([filePath]) => filePath === '.postman/resources.yaml');
        expect(resourceWrite).toBeTruthy();
        expect(String(resourceWrite?.[1] || '')).toContain('cloudResources:');
        expect(String(resourceWrite?.[1] || '')).toContain('../postman/collections/[Baseline] test-api');
        expect(String(resourceWrite?.[1] || '')).toContain('../postman/collections/[Smoke] test-api');
        expect(String(resourceWrite?.[1] || '')).toContain('../postman/collections/[Contract] test-api');
    });

    it('serializes GitHub variable writes during finalize repo persistence', async () => {
        let active = 0;
        let maxActive = 0;
        const { GitHubApiClient } = await import('../.github/actions/_lib/github-api');
        vi.mocked(GitHubApiClient).mockImplementation(function () {
            return {
                listRepositoryVariables: vi.fn().mockResolvedValue({}),
                getRepositoryVariable: vi.fn().mockResolvedValue(''),
                setRepositoryVariable: vi.fn(async () => {
                    active += 1;
                    maxActive = Math.max(maxActive, active);
                    await Promise.resolve();
                    await Promise.resolve();
                    active -= 1;
                }),
            } as any;
        });

        vi.mocked(core.getInput).mockImplementation((name) => {
            const inputs: Record<string, string> = {
                'project_name': 'test-api',
                'runtime_mode': 'lambda',
                'environments': '["prod"]',
                'workspace_id': '',
                'runtime_base_url': '',
                'prod_gw_url': 'https://prod.execute-api.com',
                'dev_gw_url': 'https://dev.execute-api.com',
                'postman_api_key': 'key',
                'postman_access_token': 'token',
                'github_app_token': 'ghtoken',
                'postman_team_id': 'team',
                'step': PROVISION_STEP_NAMES.STORE_AWS_OUTPUTS_AS_REPO_VARIABLES,
            };
            return inputs[name] || '';
        });

        const mod = await import('../.github/actions/finalize/src/index');
        await mod.run();
        await vi.advanceTimersByTimeAsync(0);

        expect(maxActive).toBe(1);
    });

    it('preloads repo variables once for finalize fallback reads', async () => {
        const { PostmanApiClient } = await import('../.github/actions/_lib/postman-api');
        const mockCreateEnv = vi.fn().mockResolvedValue('env-uid-prod');
        vi.mocked(PostmanApiClient).mockImplementation(function () {
            return {
                createEnvironment: mockCreateEnv,
                createMock: vi.fn().mockResolvedValue({ uid: 'mock-uid', url: 'https://mock.pstmn.io' }),
                createMonitor: vi.fn().mockResolvedValue('mon-uid'),
                getCollection: vi.fn().mockResolvedValue({}),
                getEnvironment: vi.fn().mockResolvedValue({}),
                proxyBifrost: vi.fn(),
            } as any;
        });

        const mockListVariables = vi.fn().mockResolvedValue({
            RUNTIME_BASE_URL: 'https://cached.example.com',
            POSTMAN_ENV_UIDS_JSON: JSON.stringify({ prod: 'env-uid-prod' }),
            POSTMAN_ENVIRONMENT_UID: 'env-uid-prod',
        });
        const mockGetVariable = vi.fn().mockResolvedValue('');
        vi.mocked(GitHubApiClient).mockImplementation(function () {
            return {
                listRepositoryVariables: mockListVariables,
                getRepositoryVariable: mockGetVariable,
                setRepositoryVariable: vi.fn().mockResolvedValue(undefined),
            } as any;
        });

        vi.mocked(core.getInput).mockImplementation((name) => {
            const inputs: Record<string, string> = {
                'project_name': 'test-api',
                'runtime_mode': 'ecs_service',
                'environments': '["prod"]',
                'workspace_id': 'ws-123',
                'baseline_uid': 'bl-uid',
                'smoke_uid': 'sm-uid',
                'contract_uid': 'ct-uid',
                'runtime_base_url': '',
                'postman_api_key': 'key',
                'postman_access_token': 'token',
                'github_app_token': 'ghtoken',
                'postman_team_id': 'team',
                'step': PROVISION_STEP_NAMES.CREATE_POSTMAN_ENVIRONMENTS,
                'system_env_map': `{"prod":"${TEST_MOCK_SYSTEM_ENV_ID}"}`,
                'env_uids': '{}',
            };
            return inputs[name] || '';
        });

        const mod = await import('../.github/actions/finalize/src/index');
        await mod.run();
        await vi.advanceTimersByTimeAsync(0);

        expect(mockListVariables).toHaveBeenCalledTimes(1);
        expect(mockGetVariable).not.toHaveBeenCalled();
        expect(mockCreateEnv).not.toHaveBeenCalled();
    });

    it('skips repo variable preload when aws_deploy outputs provide finalize inputs directly', async () => {
        const { PostmanApiClient } = await import('../.github/actions/_lib/postman-api');
        const mockCreateEnv = vi.fn().mockResolvedValue('env-uid-prod');
        vi.mocked(PostmanApiClient).mockImplementation(function () {
            return {
                createEnvironment: mockCreateEnv,
                updateEnvironment: vi.fn().mockResolvedValue(undefined),
                createMock: vi.fn().mockResolvedValue({ uid: 'mock-uid', url: 'https://mock.pstmn.io' }),
                createMonitor: vi.fn().mockResolvedValue('mon-uid'),
                getCollection: vi.fn().mockResolvedValue({}),
                getEnvironment: vi.fn().mockResolvedValue({}),
                proxyBifrost: vi.fn(),
            } as any;
        });

        const mockListVariables = vi.fn().mockResolvedValue({});
        const mockGetVariable = vi.fn().mockResolvedValue('');
        vi.mocked(GitHubApiClient).mockImplementation(function () {
            return {
                listRepositoryVariables: mockListVariables,
                getRepositoryVariable: mockGetVariable,
                setRepositoryVariable: vi.fn().mockResolvedValue(undefined),
            } as any;
        });

        vi.mocked(core.getInput).mockImplementation((name) => {
            const inputs: Record<string, string> = {
                'project_name': 'test-api',
                'runtime_mode': 'ecs_service',
                'environments': '["prod"]',
                'workspace_id': 'ws-123',
                'baseline_uid': 'bl-uid',
                'smoke_uid': 'sm-uid',
                'contract_uid': 'ct-uid',
                'runtime_base_url': 'https://runtime.example.com/svc/test-api',
                'image_uri': '123456789012.dkr.ecr.eu-west-2.amazonaws.com/vzw-partner-demo:test-api-sha',
                'ecs_service_name': 'test-api-svc',
                'ecs_task_definition': 'test-api-task',
                'ecs_target_group_arn': 'arn:aws:elasticloadbalancing:eu-west-2:123456789012:targetgroup/test/abc',
                'ecs_listener_rule_arn': 'arn:aws:elasticloadbalancing:eu-west-2:123456789012:listener-rule/app/test/abc',
                'postman_api_key': 'key',
                'postman_access_token': 'token',
                'github_app_token': 'ghtoken',
                'postman_team_id': 'team',
                'step': PROVISION_STEP_NAMES.CREATE_POSTMAN_ENVIRONMENTS,
                'system_env_map': `{"prod":"${TEST_MOCK_SYSTEM_ENV_ID}"}`,
                'env_uids': '{"prod":"env-uid-prod"}',
            };
            return inputs[name] || '';
        });

        const mod = await import('../.github/actions/finalize/src/index');
        await mod.run();
        await vi.advanceTimersByTimeAsync(0);

        expect(mockListVariables).not.toHaveBeenCalled();
        expect(mockGetVariable).not.toHaveBeenCalled();
        expect(mockCreateEnv).not.toHaveBeenCalled();
    });

    it('should skip workspace-dependent steps when workspace_id is empty (k8s_discovery)', async () => {
        vi.mocked(core.getInput).mockImplementation((name) => {
            const inputs: Record<string, string> = {
                'project_name': 'test-discovery',
                'runtime_mode': 'k8s_discovery',
                'environments': '["prod"]',
                'workspace_id': '', // No workspace
                'postman_api_key': 'key',
                'postman_access_token': 'token',
                'github_app_token': 'ghtoken',
                'step': 'all'
            };
            return inputs[name] || '';
        });

        const { PostmanApiClient } = await import('../.github/actions/_lib/postman-api');
        const mockCreateEnv = vi.fn();
        vi.mocked(PostmanApiClient).mockImplementation(function () {
            return {
                createEnvironment: mockCreateEnv,
                createMock: vi.fn(),
                createMonitor: vi.fn(),
                getCollection: vi.fn(),
                getEnvironment: vi.fn(),
                proxyBifrost: vi.fn()
            } as any;
        });

        const mod = await import('../.github/actions/finalize/src/index');
        await mod.run();
        await vi.advanceTimersByTimeAsync(0);

        // Environment creation is gated on workspace_id
        expect(mockCreateEnv).not.toHaveBeenCalled();
    });

    it('regression: runtime/env primary selection prefers deployed env URLs over prod default', () => {
        const source = require('node:fs').readFileSync('.github/actions/finalize/src/index.ts', 'utf-8');
        expect(source).toContain('const deployedEnvNames = Object.keys(envRuntimeUrlsJson || {});');
        expect(source).toContain('const effectivePrimaryEnv = deployedEnvNames.includes(preferredPrimaryEnv)');
        expect(source).toContain('const deployedPrimaryRuntimeUrl = String(envRuntimeUrlsJson[effectivePrimaryEnv] || \'\').trim();');
        expect(source).toContain('const envUid = envUids[effectivePrimaryEnv] || Object.values(envUids)[0];');
    });

    it('regression: finalize prefers fallback token for workflow-file push and reports missing workflow-file scope', () => {
        const source = require('node:fs').readFileSync('.github/actions/finalize/src/index.ts', 'utf-8');
        expect(source).toContain("const normalizedPushToken = String(pushToken || '').trim();");
        expect(source).toContain("const normalizedFallbackToken = String(ghFallbackToken || '').trim();");
        expect(source).toContain('const pushTokens = [normalizedPushToken, normalizedFallbackToken, normalizedAppToken]');
        expect(source).toContain("http.https://github.com/.extraheader");
        expect(source).toContain('No push token configured for finalize commit');
        expect(source).toContain('could update workflow files');
        expect(source).toContain("without `workflows` permission");
    });
});
