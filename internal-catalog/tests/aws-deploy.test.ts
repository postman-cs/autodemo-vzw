import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import { PROVISION_STEP_NAMES } from '../src/lib/provision-steps';
import { GitHubApiClient } from '../.github/actions/_lib/github-api';
import { TEST_GITHUB_ORG } from "./helpers/constants";

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
    getExecOutput: vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' })
}));
vi.mock('@actions/io');
vi.mock('fs', () => ({
    default: {
        existsSync: vi.fn(),
        writeFileSync: vi.fn(),
        readFileSync: vi.fn(),
        promises: {}
    },
    writeFileSync: vi.fn(),
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    promises: {},
    constants: {}
}));
vi.mock('../.github/actions/_lib/postman-api', () => ({
    PostmanApiClient: vi.fn(function () {
        return {
        createInsightsService: vi.fn().mockResolvedValue('project-id'),
        verifyInsightsService: vi.fn(),
        createEnvironment: vi.fn().mockResolvedValue('env-uid'),
        proxyBifrost: vi.fn()
        };
    })
}));
vi.mock('../.github/actions/_lib/github-api', () => ({
    GitHubApiClient: vi.fn(function () {
        return {
            listRepositoryVariables: vi.fn().mockResolvedValue({}),
            getRepositoryVariable: vi.fn().mockResolvedValue(''),
            setRepositoryVariable: vi.fn().mockResolvedValue(undefined),
        };
    })
}));
vi.mock('../.github/actions/_lib/step-output', () => ({
    setStepOutput: vi.fn(),
    logStepInfo: vi.fn()
}));

describe('aws-deploy action', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.AWS_REGION = 'us-east-1';
        process.env.POSTMAN_SYSTEM_ENV_PROD = '12345678-1234-1234-1234-123456789012';
        process.env.KUBECONFIG_B64 = 'dGVzdA==';

        // Setup core inputs
        const mockInputs: Record<string, string> = {
            'project_name': 'test-project',
            'runtime_mode': 'ecs_service',
            'postman_api_key': 'key',
            'postman_access_token': 'token',
            'github_app_token': 'ghtoken',
            'postman_team_id': 'team',
            'workspace_id': '12345678-1234-1234-1234-123456789012',
            'service_name': 'my-svc',
            'task_family': 'my-task',
            'target_group_name': 'my-tg',
            'project_slug': 'my-slug',
            'image_uri': 'mock-image-uri'
        };
        vi.mocked(core.getInput).mockImplementation((name) => mockInputs[name] || '');
    });

    afterEach(() => {
        delete process.env.GITHUB_REPOSITORY;
    });

    it('preloads repo variables once for initial defaults', async () => {
        process.env.GITHUB_REPOSITORY = `${TEST_GITHUB_ORG}/test-repo`;
        const mockListVariables = vi.fn().mockResolvedValue({
            RUNTIME_BASE_URL: 'https://cached.example.com',
            SERVICE_NAME: 'cached-svc',
            TASK_FAMILY: 'cached-task',
            TARGET_GROUP_NAME: 'cached-tg',
            DOCKER_IMAGE_URI: 'cached-image',
            POSTMAN_WORKSPACE_ID: '12345678-1234-1234-1234-123456789012',
            POSTMAN_BASELINE_COLLECTION_UID: 'baseline-uid',
        });
        const mockGetVariable = vi.fn().mockResolvedValue('');
        vi.mocked(GitHubApiClient).mockImplementation(function () {
            return {
            listRepositoryVariables: mockListVariables,
            getRepositoryVariable: mockGetVariable,
            setRepositoryVariable: vi.fn().mockResolvedValue(undefined),
            };
        } as any);

        vi.mocked(core.getInput).mockImplementation((name) => {
            const inputs: Record<string, string> = {
                'project_name': 'test-project',
                'runtime_mode': 'ecs_service',
                'postman_api_key': 'key',
                'postman_access_token': 'token',
                'github_app_token': 'ghtoken',
                'postman_team_id': 'team',
                'workspace_id': '',
                'service_name': '',
                'task_family': '',
                'target_group_name': '',
                'project_slug': 'my-slug',
                'image_uri': '',
                'runtime_base_url': '',
                'baseline_uid': '',
                'step': PROVISION_STEP_NAMES.CONFIGURE_AWS_CREDENTIALS,
                'environments': '["prod"]',
            };
            return inputs[name] || '';
        });

        const mod = await import('../.github/actions/aws-deploy/src/index');
        await mod.run();

        expect(mockListVariables).toHaveBeenCalledTimes(1);
        expect(mockGetVariable).not.toHaveBeenCalled();
    });

    it('skips repo variable preload when workflow outputs provide all required derived inputs', async () => {
        process.env.GITHUB_REPOSITORY = `${TEST_GITHUB_ORG}/test-repo`;
        const mockListVariables = vi.fn().mockResolvedValue({});
        vi.mocked(GitHubApiClient).mockImplementation(function () {
            return {
            listRepositoryVariables: mockListVariables,
            getRepositoryVariable: vi.fn().mockResolvedValue(''),
            setRepositoryVariable: vi.fn().mockResolvedValue(undefined),
            };
        } as any);

        vi.mocked(core.getInput).mockImplementation((name) => {
            const inputs: Record<string, string> = {
                'project_name': 'test-project',
                'runtime_mode': 'ecs_service',
                'postman_api_key': 'key',
                'postman_access_token': 'token',
                'github_app_token': 'ghtoken',
                'postman_team_id': 'team',
                'workspace_id': '12345678-1234-1234-1234-123456789012',
                'service_name': 'test-project-svc',
                'task_family': 'test-project-task',
                'target_group_name': 'test-project-tg',
                'project_slug': 'test-project',
                'image_uri': '123456789012.dkr.ecr.eu-west-2.amazonaws.com/vzw-partner-demo:test-project-sha',
                'runtime_base_url': 'https://runtime.example.com/svc/test-project',
                'baseline_uid': 'baseline-uid',
                'step': PROVISION_STEP_NAMES.CONFIGURE_AWS_CREDENTIALS,
                'environments': '["prod"]',
            };
            return inputs[name] || '';
        });

        const mod = await import('../.github/actions/aws-deploy/src/index');
        await mod.run();

        expect(mockListVariables).not.toHaveBeenCalled();
    });

    it('should configure AWS credentials', async () => {
        vi.mocked(core.getInput).mockImplementation((name) => {
            if (name === 'aws_access_key_id') return 'mock-access';
            if (name === 'aws_secret_access_key') return 'mock-secret';
            if (name === 'step') return 'Configure AWS Credentials';
            if (name === 'environments') return '["prod"]';
            if (name === 'runtime_mode') return 'ecs_service';
            return '';
        });

        const mod = await import('../.github/actions/aws-deploy/src/index');
        await mod.run();

        expect(process.env.AWS_ACCESS_KEY_ID).toBe('mock-access');
        expect(process.env.AWS_SECRET_ACCESS_KEY).toBe('mock-secret');
    });

    it('should configure AWS retry mode for throttling resilience', async () => {
        vi.mocked(core.getInput).mockImplementation((name) => {
            if (name === 'aws_access_key_id') return 'mock-access';
            if (name === 'aws_secret_access_key') return 'mock-secret';
            if (name === 'step') return 'Configure AWS Credentials';
            if (name === 'environments') return '["prod"]';
            if (name === 'runtime_mode') return 'lambda';
            return '';
        });

        const mod = await import('../.github/actions/aws-deploy/src/index');
        await mod.run();

        expect(process.env.AWS_RETRY_MODE).toBe('standard');
        expect(process.env.AWS_MAX_ATTEMPTS).toBe('8');
    });

    it('should route to lambda deploy path for lambda runtime', async () => {
        process.env.AWS_LAMBDA_ROLE_ARN = 'arn:aws:iam::123:role/lambda-role';

        vi.mocked(core.getInput).mockImplementation((name) => {
            if (name === 'runtime_mode') return 'lambda';
            if (name === 'step') return PROVISION_STEP_NAMES.PACKAGE_LAMBDA;
            if (name === 'environments') return '["prod"]';
            if (name === 'aws_access_key_id') return 'ak';
            if (name === 'aws_secret_access_key') return 'sk';
            return '';
        });

        const mod = await import('../.github/actions/aws-deploy/src/index');
        await mod.run();

        expect(exec.exec).toHaveBeenCalledWith(
            'pip',
            expect.arrayContaining(['install', '-r', 'requirements.txt'])
        );

        Reflect.deleteProperty(process.env, 'AWS_LAMBDA_ROLE_ARN');
    });

    it('should validate Insights workspace configuration for ECS', async () => {
        // ECS infra env vars required by deployECS() pre-validation
        process.env.ECS_CLUSTER_NAME = 'test-cluster';
        process.env.ECS_VPC_ID = 'vpc-123';
        process.env.ECS_ALB_LISTENER_ARN = 'arn:aws:elasticloadbalancing:eu-west-2:123:listener/abc';
        process.env.ECS_EXECUTION_ROLE_ARN = 'arn:aws:iam::123:role/exec';
        process.env.POSTMAN_SYSTEM_ENV_PROD = '12345678-1234-1234-abcd-123456789012';

        vi.mocked(core.getInput).mockImplementation((name) => {
            if (name === 'runtime_mode') return 'ecs_service';
            if (name === 'step') return PROVISION_STEP_NAMES.VALIDATE_INSIGHTS_WORKSPACE_CONFIGURATION;
            if (name === 'environments') return '["prod"]';
            if (name === 'workspace_id') return '12345678-1234-1234-abcd-123456789012';
            return '';
        });

        const mod = await import('../.github/actions/aws-deploy/src/index');
        await mod.run();

        // Should not have failed
        expect(core.setFailed).not.toHaveBeenCalled();

        delete process.env.ECS_CLUSTER_NAME;
        delete process.env.ECS_VPC_ID;
        delete process.env.ECS_ALB_LISTENER_ARN;
        delete process.env.ECS_EXECUTION_ROLE_ARN;
        delete process.env.POSTMAN_SYSTEM_ENV_PROD;
    });

    it('should fail validation when workspace_id is not a UUID', async () => {
        vi.mocked(core.getInput).mockImplementation((name) => {
            if (name === 'runtime_mode') return 'ecs_service';
            if (name === 'step') return PROVISION_STEP_NAMES.VALIDATE_INSIGHTS_WORKSPACE_CONFIGURATION;
            if (name === 'environments') return '["prod"]';
            if (name === 'workspace_id') return 'not-a-uuid';
            return '';
        });

        const mod = await import('../.github/actions/aws-deploy/src/index');
        await mod.run();

        expect(core.setFailed).toHaveBeenCalledWith(
            expect.stringContaining('workspace_id is required and must be a UUID')
        );
    });

    it('should use PROVISION_STEP_NAMES constants (not hardcoded strings)', () => {
        // Verify canonical step names we use in aws-deploy
        expect(PROVISION_STEP_NAMES.CREATE_INSIGHTS_PROJECT).toBe('Create Insights Project');
        expect(PROVISION_STEP_NAMES.CONFIGURE_AWS_CREDENTIALS).toBe('Configure AWS Credentials');
        expect(PROVISION_STEP_NAMES.PREFLIGHT_ECS_SHARED_INFRASTRUCTURE).toBe('Preflight ECS Shared Infrastructure');
        expect(PROVISION_STEP_NAMES.DEPLOY_LAMBDA_FUNCTIONS).toBe('Deploy Lambda Functions');
        expect(PROVISION_STEP_NAMES.HEALTH_CHECK).toBe('Health Check');
        expect(PROVISION_STEP_NAMES.DEPLOY_KUBERNETES_WORKLOAD).toBe('Deploy Kubernetes Workload');
        expect(PROVISION_STEP_NAMES.INJECT_INSIGHTS_SIDECAR).toBe('Inject Insights Sidecar');
    });

    it('regression: kubernetes runtimes keep the insights instrumentation path wired in', () => {
        const source = require('node:fs').readFileSync('.github/actions/aws-deploy/src/index.ts', 'utf-8');
        expect(source).toContain("if (shouldRun(STEPS.VALIDATE_DISCOVERY_SHARED_INFRASTRUCTURE) && runtimeMode === 'k8s_discovery')");
        expect(source).toContain("d.metadata.name === 'postman-insights-agent'");
        expect(source).toContain("if (shouldRun(STEPS.INJECT_INSIGHTS_SIDECAR) && runtimeMode === 'k8s_workspace')");
        expect(source).toContain("await exec.exec('postman-insights-agent', ['kube', 'inject'");
        expect(source).toContain("const DEFAULT_OTEL_PROPAGATORS = 'tracecontext,baggage,b3,b3multi'");
    });

    it('regression: k8s label slug must not derive from runtime URL basename', () => {
        const source = require('node:fs').readFileSync('.github/actions/aws-deploy/src/index.ts', 'utf-8');
        expect(source).not.toContain('path.basename(envRuntimeUrl)');
    });

    it('regression: k8s rollout/health iterate deployed env map first', () => {
        const source = require('node:fs').readFileSync('.github/actions/aws-deploy/src/index.ts', 'utf-8');
        expect(source).toContain('const rolloutEnvironments = Object.keys(envRuntimeUrls).length > 0');
        expect(source).toContain('const healthCheckEnvironments = Object.keys(envRuntimeUrls).length > 0');
    });

    it('regression: regenerate k8s manifest per environment (no stale k8s.yaml reuse)', () => {
        const source = require('node:fs').readFileSync('.github/actions/aws-deploy/src/index.ts', 'utf-8');
        expect(source).not.toContain("if (fs.existsSync('k8s.yaml'))");
        expect(source).toContain("fs.writeFileSync('k8s.yaml', manifests);");
    });

    it('uses stage-specific k8s resource names and runtime URLs for single-env k8s_workspace stage deploys', async () => {
        vi.mocked(core.getInput).mockImplementation((name) => {
            const inputs: Record<string, string> = {
                'project_name': 'af-cards-3ds',
                'runtime_mode': 'k8s_workspace',
                'postman_api_key': 'key',
                'postman_access_token': 'token',
                'github_app_token': 'ghtoken',
                'postman_team_id': 'team',
                'workspace_id': '12345678-1234-1234-1234-123456789012',
                'service_name': 'af-cards-3ds',
                'image_uri': 'mock-image-uri',
                'runtime_base_url': 'https://apps.demo.internal/svc/af-cards-3ds',
                'dependency_targets_json': '[]',
                'step': PROVISION_STEP_NAMES.DEPLOY_KUBERNETES_WORKLOAD,
                'environments': '["stage"]',
            };
            return inputs[name] || '';
        });

        const mod = await import('../.github/actions/aws-deploy/src/index');
        await mod.run();

        expect(fs.writeFileSync).toHaveBeenCalledWith(
            'k8s.yaml',
            expect.stringContaining('metadata: { name: af-cards-3ds-stage, namespace: vzw-partner-demo }'),
        );
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            'k8s.yaml',
            expect.stringContaining('API_BASE_PATH, value: /svc/af-cards-3ds-stage'),
        );
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            'k8s.yaml',
            expect.stringContaining("OTEL_PROPAGATORS, value: 'tracecontext,baggage,b3,b3multi'"),
        );
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            'k8s.yaml',
            expect.stringContaining('path: /svc/af-cards-3ds-stage'),
        );
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            'k8s.yaml',
            expect.stringContaining('resources:\n            requests:\n              cpu: 50m\n              memory: 64Mi\n            limits:\n              cpu: 200m\n              memory: 128Mi'),
        );
    });

    it('applies discovery manifests with recreate strategy and without dedicated-node scheduling constraints', async () => {
        vi.mocked(core.getInput).mockImplementation((name) => {
            const inputs: Record<string, string> = {
                'project_name': 'af-cards-3ds',
                'runtime_mode': 'k8s_discovery',
                'postman_api_key': 'key',
                'postman_access_token': 'token',
                'github_app_token': 'ghtoken',
                'postman_team_id': 'team',
                'workspace_id': '',
                'service_name': 'af-cards-3ds',
                'image_uri': 'mock-image-uri',
                'runtime_base_url': 'https://apps.demo.internal/svc/af-cards-3ds',
                'dependency_targets_json': '[]',
                'step': PROVISION_STEP_NAMES.APPLY_DISCOVERY_WORKLOAD,
                'environments': '["prod"]',
            };
            return inputs[name] || '';
        });

        const mod = await import('../.github/actions/aws-deploy/src/index');
        await mod.run();

        const renderedManifests = vi.mocked(fs.writeFileSync).mock.calls
            .filter(([file]) => file === 'k8s.yaml')
            .map(([, content]) => String(content))
            .join('\n---\n');

        expect(renderedManifests).toContain("OTEL_PROPAGATORS, value: 'tracecontext,baggage,b3,b3multi'");
        expect(renderedManifests).toContain('strategy:\n    type: Recreate');
        expect(renderedManifests).not.toContain('catalog.postman.com/dedicated-ip');
        expect(renderedManifests).not.toContain('podAntiAffinity:');
        expect(renderedManifests).not.toContain('topologySpreadConstraints:');
    });

    it('does not gate discovery apply on dedicated-node capacity checks', async () => {
        vi.mocked(core.getInput).mockImplementation((name) => {
            const inputs: Record<string, string> = {
                'project_name': 'af-cards-3ds',
                'runtime_mode': 'k8s_discovery',
                'postman_api_key': 'key',
                'postman_access_token': 'token',
                'github_app_token': 'ghtoken',
                'postman_team_id': 'team',
                'workspace_id': '',
                'service_name': 'af-cards-3ds',
                'image_uri': 'mock-image-uri',
                'runtime_base_url': 'https://apps.demo.internal/svc/af-cards-3ds',
                'dependency_targets_json': '[]',
                'step': PROVISION_STEP_NAMES.APPLY_DISCOVERY_WORKLOAD,
                'environments': '["prod","stage"]',
            };
            return inputs[name] || '';
        });

        const mod = await import('../.github/actions/aws-deploy/src/index');
        await mod.run();

        const kubectlJsonQueries = vi.mocked(exec.getExecOutput).mock.calls
            .filter(([cmd, args]) => cmd === 'kubectl' && Array.isArray(args))
            .map(([, args]) => String((args ?? []).join(' ')));

        expect(kubectlJsonQueries).not.toContain('get nodes -o json');
        expect(kubectlJsonQueries).not.toContain('get deployments -n vzw-partner-demo -l catalog.postman.com/dedicated-ip=true -o json');

        const renderedManifests = vi.mocked(fs.writeFileSync).mock.calls
            .filter(([file]) => file === 'k8s.yaml')
            .map(([, content]) => String(content))
            .join('\n---\n');

        expect(renderedManifests).toContain('name: af-cards-3ds');
        expect(renderedManifests).toContain("OTEL_PROPAGATORS, value: 'tracecontext,baggage,b3,b3multi'");
        expect(renderedManifests).toContain('name: af-cards-3ds-stage');
        expect(core.setFailed).not.toHaveBeenCalledWith(
            expect.stringContaining('Insufficient schedulable Kubernetes nodes for dedicated-IP discovery workloads'),
        );
    });

    it('falls back to current kube context when K8S_CONTEXT is invalid', async () => {
        process.env.K8S_CONTEXT = 'demo-context';
        vi.mocked(core.getInput).mockImplementation((name) => {
            if (name === 'runtime_mode') return 'k8s_workspace';
            if (name === 'step') return PROVISION_STEP_NAMES.CONFIGURE_KUBECONFIG;
            if (name === 'environments') return '["prod"]';
            return '';
        });

        vi.mocked(exec.getExecOutput).mockImplementation(async (cmd, args) => {
            if (cmd === 'kubectl' && String(args?.join(' ')) === 'config get-contexts -o name') {
                return { stdout: 'real-context\n', stderr: '' } as any;
            }
            if (cmd === 'kubectl' && String(args?.join(' ')) === 'config current-context') {
                return { stdout: 'real-context\n', stderr: '' } as any;
            }
            return { stdout: '[]', stderr: '' } as any;
        });

        const mod = await import('../.github/actions/aws-deploy/src/index');
        await mod.run();

        expect(core.warning).toHaveBeenCalledWith(
            expect.stringContaining('Requested K8S_CONTEXT "demo-context" not found; falling back to "real-context"')
        );
        expect(exec.exec).toHaveBeenCalledWith('kubectl', ['config', 'use-context', 'real-context']);

        delete process.env.K8S_CONTEXT;
    });
});
