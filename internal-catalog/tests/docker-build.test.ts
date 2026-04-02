import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import fs from 'fs';
import { setStepOutput } from '../.github/actions/_lib/step-output';
import { GitHubApiClient } from '../.github/actions/_lib/github-api';
import { TEST_AWS_REGION, TEST_GITHUB_ORG } from "./helpers/constants";

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
    exec: vi.fn(),
    getExecOutput: vi.fn().mockResolvedValue({ stdout: '123456789012' })
}));
vi.mock('@actions/io', () => ({
    cp: vi.fn()
}));
vi.mock('fs', () => ({
    default: {
        existsSync: vi.fn().mockReturnValue(true)
    }
}));
vi.mock('../.github/actions/_lib/step-output', () => ({
    setStepOutput: vi.fn(),
    logStepInfo: vi.fn()
}));
vi.mock('../.github/actions/_lib/github-api', () => ({
    GitHubApiClient: vi.fn()
}));

describe('docker-build action', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (core.group as any).mockImplementation(async (_name: string, fn: any) => {
            await fn();
        });
        process.env.GITHUB_REPOSITORY = `${TEST_GITHUB_ORG}/vzw-partner-demo-infra`;
        process.env.GITHUB_SHA = 'abcdef1234567890abcdef1234567890abcdef12';
        process.env.AWS_REGION = TEST_AWS_REGION;
        process.env.ECS_ALB_DNS_NAME = 'alb.amazonaws.com';
        process.env.K8S_INGRESS_BASE_DOMAIN = 'k8s.amazonaws.com';

        const mockInputs: Record<string, string> = {
            'project_name': 'My Super Project',
            'runtime_mode': 'ecs_service',
            'aws_access_key_id': 'key',
            'aws_secret_access_key': 'secret',
            'aws_region': TEST_AWS_REGION
        };
        vi.mocked(core.getInput).mockImplementation((name) => mockInputs[name] || '');
    });

    afterEach(() => {
        vi.resetModules();
    });

    it('should configure AWS credentials, authorize ECR, and build docker image', async () => {
        vi.mocked(core.getInput).mockImplementation((name) => {
            if (name === 'project_name') return 'test-auth-and-build';
            if (name === 'runtime_mode') return 'ecs_service';
            if (name === 'aws_access_key_id') return 'access';
            if (name === 'aws_secret_access_key') return 'secret';
            return '';
        });

        // Trigger action run
        const mod = await import('../.github/actions/docker-build/src/index');
        await mod.run();

        expect(process.env.AWS_ACCESS_KEY_ID).toBe('access');
        expect(process.env.AWS_SECRET_ACCESS_KEY).toBe('secret');

        expect(exec.exec).toHaveBeenCalledWith('aws', ['ecr', 'get-login-password', '--region', TEST_AWS_REGION], expect.any(Object));

        expect(setStepOutput).toHaveBeenCalledWith('service_name', 'test-auth-and-build-svc');
        // Because of caching mechanics, it executes docker buildx build...
        expect(exec.exec).toHaveBeenCalledWith('docker', expect.arrayContaining(['buildx', 'build', '--push', '--platform', 'linux/arm64']));
    });

    it('uses path-based runtime URL for kubernetes runtimes', async () => {
        vi.mocked(core.getInput).mockImplementation((name) => {
            if (name === 'project_name') return 'af-customer-documents';
            if (name === 'runtime_mode') return 'k8s_workspace';
            if (name === 'aws_access_key_id') return 'access';
            if (name === 'aws_secret_access_key') return 'secret';
            return '';
        });

        const mod = await import('../.github/actions/docker-build/src/index');
        await mod.run();

        expect(setStepOutput).toHaveBeenCalledWith(
            'runtime_base_url',
            'http://k8s.amazonaws.com/svc/af-customer-documents'
        );
    });

    it('skips repo variable persistence when direct workflow outputs are used', async () => {
        const mockSetVar = vi.fn().mockResolvedValue(undefined);
        vi.mocked(GitHubApiClient).mockImplementation(() => ({
            setRepositoryVariable: mockSetVar,
        } as any));
        vi.mocked(core.getInput).mockImplementation((name) => {
            const inputs: Record<string, string> = {
                'project_name': 'test-auth-and-build',
                'runtime_mode': 'ecs_service',
                'aws_access_key_id': 'access',
                'aws_secret_access_key': 'secret',
                'github_app_token': 'ghtoken',
                'persist_repo_variables': 'false',
            };
            return inputs[name] || '';
        });

        const mod = await import('../.github/actions/docker-build/src/index');
        await mod.run();

        expect(mockSetVar).not.toHaveBeenCalled();
    });
});
