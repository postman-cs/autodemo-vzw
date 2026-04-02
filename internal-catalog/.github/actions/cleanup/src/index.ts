import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { PostmanApiClient } from '../../_lib/postman-api';

export async function run() {
    try {
        const projectName = core.getInput('project_name', { required: true });
        const runtimeMode = core.getInput('runtime_mode', { required: true });
        const environments = JSON.parse(core.getInput('environments', { required: true }));
        const workspaceId = core.getInput('workspace_id');
        const postmanApiKey = core.getInput('postman_api_key', { required: true });
        const awsAccessKeyId = core.getInput('aws_access_key_id');
        const awsSecretAccessKey = core.getInput('aws_secret_access_key');
        const githubAppToken = core.getInput('github_app_token');
        const awsRegion = core.getInput('aws_region', { required: true });

        if (awsAccessKeyId && awsSecretAccessKey) {
            process.env.AWS_ACCESS_KEY_ID = awsAccessKeyId;
            process.env.AWS_SECRET_ACCESS_KEY = awsSecretAccessKey;
        } else {
            core.info('AWS static keys not provided; cleanup will rely on OIDC or ambient credentials.');
        }
        process.env.AWS_REGION = awsRegion;

        const ecsServiceName = core.getInput('ecs_service_name');
        const ecsTargetGroupArn = core.getInput('ecs_target_group_arn');
        const ecsListenerRuleArn = core.getInput('ecs_listener_rule_arn');

        const postman = new PostmanApiClient(postmanApiKey);

        // 1. Postman Workspace
        if (workspaceId) {
            await core.group('Delete Postman Workspace', async () => {
                try {
                    await postman.deleteWorkspace(workspaceId);
                    core.info(`Workspace deleted: ${workspaceId}`);
                } catch (e) {
                    core.warning(`Failed to delete workspace: ${e}`);
                }
            });
        }

        // 2. AWS Resources
        if (runtimeMode === 'lambda') {
            await core.group('Delete Lambda Resources', async () => {
                const limit = 3;
                const queue = [...environments];
                await Promise.all(Array.from({ length: limit }, async () => {
                    while (queue.length > 0) {
                        const envName = queue.shift()!;
                        const funcName = `${projectName}-${envName}`;

                        // Delete API Gateway
                        try {
                            const out = (await exec.getExecOutput('aws', ['apigatewayv2', 'get-apis', '--output', 'json'], { silent: true })).stdout;
                            const apis = JSON.parse(out);
                            const apiId = apis.Items?.find((a: any) => a.Name === funcName)?.ApiId;
                            if (apiId) {
                                await exec.exec('aws', ['apigatewayv2', 'delete-api', '--api-id', apiId]);
                                core.info(`Deleted API Gateway: ${apiId}`);
                            }
                        } catch (e) { core.warning(`Failed to cleanup API Gateway for ${funcName}: ${e}`); }

                        // Delete Lambda
                        try {
                            await exec.exec('aws', ['lambda', 'delete-function', '--function-name', funcName]);
                            core.info(`Deleted Lambda: ${funcName}`);
                        } catch (e) { core.warning(`Failed to delete Lambda ${funcName}: ${e}`); }
                    }
                }));

                // IAM Role (if created using standard naming)
                const roleName = `vzw-partner-demo-user-${projectName}-lambda-role`; // matching provision-workflow-templates usage
                try {
                    await exec.exec('aws', ['iam', 'detach-role-policy', '--role-name', roleName, '--policy-arn', 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'], { ignoreReturnCode: true });
                    await exec.exec('aws', ['iam', 'delete-role', '--role-name', roleName]);
                    core.info(`Deleted IAM role: ${roleName}`);
                } catch (e) { core.info(`IAM role cleanup skipped or failed: ${e}`); }
            });
        } else if (runtimeMode === 'ecs_service') {
            await core.group('Delete ECS Resources', async () => {
                const cluster = process.env.ECS_CLUSTER_NAME;
                if (!cluster || !ecsServiceName) {
                    core.warning('Missing ECS_CLUSTER_NAME or ecs_service_name, skipping ECS cleanup');
                    return;
                }

                try {
                    await exec.exec('aws', ['ecs', 'delete-service', '--cluster', cluster, '--service', ecsServiceName, '--force']);
                    core.info(`Deleted ECS service: ${ecsServiceName}, waiting for INACTIVE...`);

                    for (let i = 0; i < 60; i++) {
                        const out = (await exec.getExecOutput('aws', ['ecs', 'describe-services', '--cluster', cluster, '--services', ecsServiceName], { silent: true, ignoreReturnCode: true })).stdout;
                        const status = JSON.parse(out).services?.[0]?.status;
                        if (!status || status === 'INACTIVE') break;
                        await new Promise(r => setTimeout(r, 10000));
                    }
                } catch (e) { core.warning(`Failed to delete ECS service: ${e}`); }

                if (ecsListenerRuleArn) {
                    try { await exec.exec('aws', ['elbv2', 'delete-rule', '--rule-arn', ecsListenerRuleArn]); } catch (e) { core.warning(`Failed to delete listener rule: ${e}`); }
                }
                if (ecsTargetGroupArn) {
                    try { await exec.exec('aws', ['elbv2', 'delete-target-group', '--target-group-arn', ecsTargetGroupArn]); } catch (e) { core.warning(`Failed to delete target group: ${e}`); }
                }
            });
        }

    } catch (error) {
        if (error instanceof Error) core.setFailed(error.message);
        else core.setFailed(String(error));
    }
}

if (!process.env.VITEST) {
    void run();
}
