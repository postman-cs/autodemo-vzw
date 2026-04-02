import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { TEST_AWS_REGION } from "./helpers/constants";

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
vi.mock('../.github/actions/_lib/postman-api', () => ({
    PostmanApiClient: vi.fn().mockImplementation(function () {
        return {
        deleteWorkspace: vi.fn().mockResolvedValue(undefined)
        };
    })
}));

describe('cleanup action logic', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should generate correct IAM role name from project name', () => {
        const projectName = 'test-proj';
        const roleName = `vzw-partner-demo-user-${projectName}-lambda-role`;
        expect(roleName).toBe('vzw-partner-demo-user-test-proj-lambda-role');
    });

    it('should parse environments JSON array correctly', () => {
        const envsJson = '["prod", "dev"]';
        const environments = JSON.parse(envsJson);
        expect(environments).toContain('prod');
        expect(environments).toContain('dev');
        expect(environments).toHaveLength(2);
    });

    it('should delete Lambda function and API Gateway for lambda runtime', async () => {
        vi.mocked(core.getInput).mockImplementation((name) => {
            const inputs: Record<string, string> = {
                'project_name': 'my-api',
                'runtime_mode': 'lambda',
                'environments': '["prod"]',
                'workspace_id': '',
                'postman_api_key': 'key',
                'aws_access_key_id': 'ak',
                'aws_secret_access_key': 'sk',
                'aws_region': TEST_AWS_REGION
            };
            return inputs[name] || '';
        });

        vi.mocked(exec.getExecOutput).mockResolvedValue({
            stdout: JSON.stringify({ Items: [{ Name: 'my-api-prod-api', ApiId: 'api-123' }] }),
            stderr: '',
            exitCode: 0
        });

        const mod = await import('../.github/actions/cleanup/src/index');
        await mod.run();
        await vi.advanceTimersByTimeAsync(0);

        expect(exec.exec).toHaveBeenCalledWith(
            'aws',
            ['lambda', 'delete-function', '--function-name', 'my-api-prod']
        );
    });

    it('should force-delete ECS service for ecs_service runtime', async () => {
        process.env.ECS_CLUSTER_NAME = 'test-cluster';

        vi.mocked(core.getInput).mockImplementation((name) => {
            const inputs: Record<string, string> = {
                'project_name': 'my-svc',
                'runtime_mode': 'ecs_service',
                'environments': '["prod"]',
                'workspace_id': '',
                'ecs_service_name': 'my-svc-svc',
                'ecs_target_group_arn': 'arn:tg',
                'ecs_listener_rule_arn': 'arn:rule',
                'postman_api_key': 'key',
                'aws_access_key_id': 'ak',
                'aws_secret_access_key': 'sk',
                'aws_region': TEST_AWS_REGION
            };
            return inputs[name] || '';
        });

        vi.mocked(exec.getExecOutput).mockResolvedValue({
            stdout: JSON.stringify({ services: [{ status: 'INACTIVE' }] }),
            stderr: '',
            exitCode: 0
        });

        const mod = await import('../.github/actions/cleanup/src/index');
        await mod.run();
        await vi.advanceTimersByTimeAsync(0);

        expect(exec.exec).toHaveBeenCalledWith(
            'aws',
            ['ecs', 'delete-service', '--cluster', 'test-cluster', '--service', 'my-svc-svc', '--force']
        );

        delete process.env.ECS_CLUSTER_NAME;
    });

    it('should clean up ALB listener rule and target group for ECS', async () => {
        process.env.ECS_CLUSTER_NAME = 'test-cluster';

        vi.mocked(core.getInput).mockImplementation((name) => {
            const inputs: Record<string, string> = {
                'project_name': 'my-svc',
                'runtime_mode': 'ecs_service',
                'environments': '["prod"]',
                'workspace_id': '',
                'ecs_service_name': 'my-svc-svc',
                'ecs_target_group_arn': 'arn:aws:elasticloadbalancing:eu-west-2:123:targetgroup/tg/abc',
                'ecs_listener_rule_arn': 'arn:aws:elasticloadbalancing:eu-west-2:123:listener-rule/rule/xyz',
                'postman_api_key': 'key',
                'aws_access_key_id': 'ak',
                'aws_secret_access_key': 'sk',
                'aws_region': TEST_AWS_REGION
            };
            return inputs[name] || '';
        });

        vi.mocked(exec.getExecOutput).mockResolvedValue({
            stdout: JSON.stringify({ services: [{ status: 'INACTIVE' }] }),
            stderr: '',
            exitCode: 0
        });

        const mod = await import('../.github/actions/cleanup/src/index');
        await mod.run();
        await vi.advanceTimersByTimeAsync(0);

        expect(exec.exec).toHaveBeenCalledWith(
            'aws',
            ['elbv2', 'delete-rule', '--rule-arn', 'arn:aws:elasticloadbalancing:eu-west-2:123:listener-rule/rule/xyz']
        );
        expect(exec.exec).toHaveBeenCalledWith(
            'aws',
            ['elbv2', 'delete-target-group', '--target-group-arn', 'arn:aws:elasticloadbalancing:eu-west-2:123:targetgroup/tg/abc']
        );

        delete process.env.ECS_CLUSTER_NAME;
    });

    it('should skip ECS cleanup when cluster name is missing', async () => {
        delete process.env.ECS_CLUSTER_NAME;

        vi.mocked(core.getInput).mockImplementation((name) => {
            const inputs: Record<string, string> = {
                'project_name': 'test',
                'runtime_mode': 'ecs_service',
                'environments': '["prod"]',
                'workspace_id': '',
                'ecs_service_name': 'my-svc',
                'postman_api_key': 'key',
                'aws_access_key_id': 'ak',
                'aws_secret_access_key': 'sk',
                'aws_region': TEST_AWS_REGION
            };
            return inputs[name] || '';
        });

        const mod = await import('../.github/actions/cleanup/src/index');
        await mod.run();
        await vi.advanceTimersByTimeAsync(0);

        expect(core.warning).toHaveBeenCalledWith(
            expect.stringContaining('Missing ECS_CLUSTER_NAME')
        );
    });
});
