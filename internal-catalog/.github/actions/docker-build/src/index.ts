import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { GitHubApiClient } from '../../_lib/github-api';
import { setStepOutput, logStepInfo } from '../../_lib/step-output';

export async function run() {
    try {
        const projectName = core.getInput('project_name', { required: true });
        const runtimeMode = core.getInput('runtime_mode', { required: true });
        const awsAccessKeyId = core.getInput('aws_access_key_id');
        const awsSecretAccessKey = core.getInput('aws_secret_access_key');
        const awsRegion = core.getInput('aws_region') || 'eu-central-1';
        const githubAppToken = core.getInput('github_app_token');
        const ghFallbackToken = core.getInput('gh_fallback_token');
        const ghAuthMode = core.getInput('gh_auth_mode') || 'github_token_first';
        const persistRepoVariablesRaw = core.getInput('persist_repo_variables');
        const persistRepoVariables = !persistRepoVariablesRaw
            || ['true', '1', 'yes', 'on'].includes(persistRepoVariablesRaw.trim().toLowerCase());

        if (awsAccessKeyId && awsSecretAccessKey) {
            process.env.AWS_ACCESS_KEY_ID = awsAccessKeyId;
            process.env.AWS_SECRET_ACCESS_KEY = awsSecretAccessKey;
        } else {
            core.info('AWS static keys not provided; assuming OIDC or ambient credentials are configured.');
        }
        process.env.AWS_REGION = awsRegion;

        const sanitizeName = (name: string) => {
            return name
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-+|-+$/g, '');
        };

        const projectSlug = sanitizeName(projectName);
        if (!projectSlug) throw new Error(`Could not derive safe project slug from ${projectName}`);

        // Logic matched from provision-workflow-templates.ts lines 830-951
        let serviceName = '';
        let taskFamily = '';
        let targetGroupName = '';
        let runtimeBaseUrl = '';

        if (runtimeMode === 'ecs_service') {
            serviceName = `${projectSlug}-svc`;
            taskFamily = `${projectSlug}-task`;
            targetGroupName = projectSlug.substring(0, 29) + '-tg'; // ALB TG limit is 32, adding -tg (3)

            const albDns = String(process.env.ECS_ALB_DNS_NAME || '').trim();
            if (!albDns) throw new Error("ECS_ALB_DNS_NAME variable is missing");
            runtimeBaseUrl = `http://${albDns}/svc/${projectSlug}`;
        } else if (runtimeMode === 'k8s_workspace' || runtimeMode === 'k8s_discovery') {
            const baseDomain = String(process.env.K8S_INGRESS_BASE_DOMAIN || '').trim();
            if (!baseDomain) throw new Error("K8S_INGRESS_BASE_DOMAIN variable is missing");

            serviceName = projectSlug;
            runtimeBaseUrl = `http://${baseDomain}/svc/${projectSlug}`;
        } else {
            throw new Error(`Unsupported runtime mode for docker-build: ${runtimeMode}`);
        }

        setStepOutput('project_slug', projectSlug);
        setStepOutput('service_name', serviceName);
        setStepOutput('task_family', taskFamily);
        setStepOutput('target_group_name', targetGroupName);
        setStepOutput('runtime_base_url', runtimeBaseUrl);

        // Docker Build & Push
        const ecrRepo = process.env.ECS_ECR_REPOSITORY || 'vzw-partner-demo';
        let accountId = '';
        await exec.exec('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], {
            listeners: { stdout: (data) => { accountId += data.toString().trim(); } }
        });

        const registry = `${accountId}.dkr.ecr.${awsRegion}.amazonaws.com`;
        const githubSha = process.env.GITHUB_SHA || 'latest';
        const imageTag = `${projectSlug}-${githubSha.substring(0, 12)}`;
        const imageUri = `${registry}/${ecrRepo}:${imageTag}`;
        const cacheRef = `${registry}/${ecrRepo}:${projectSlug}-buildcache`;

        await core.group('Log into ECR', async () => {
            let password = '';
            await exec.exec('aws', ['ecr', 'get-login-password', '--region', awsRegion], {
                listeners: { stdout: (data) => { password += data.toString(); } },
                silent: true
            });
            await exec.exec('docker', ['login', '--username', 'AWS', '--password-stdin', registry], {
                input: Buffer.from(password)
            });
        });

        await core.group('Build and Push Image', async () => {
            // Ensure buildx builder exists
            await exec.exec('docker', ['buildx', 'create', '--name', 'catalog-builder', '--driver', 'docker-container', '--use'], { ignoreReturnCode: true });

            await exec.exec('docker', ['buildx', 'build',
                '--platform', 'linux/arm64',
                '--provenance=false',
                '--sbom=false',
                '--cache-from', `type=registry,ref=${cacheRef}`,
                '--cache-to', `type=registry,ref=${cacheRef},mode=max`,
                '--tag', imageUri,
                '--push', '.'
            ]);
        });

        setStepOutput('image_uri', imageUri);
        logStepInfo('Docker Build', `Built and pushed: ${imageUri}`);

        if (persistRepoVariables && githubAppToken && process.env.GITHUB_REPOSITORY) {
            const github = new GitHubApiClient(githubAppToken, process.env.GITHUB_REPOSITORY, {
                fallbackToken: ghFallbackToken,
                authMode: ghAuthMode as any,
            });
            await Promise.all([
                github.setRepositoryVariable('RUNTIME_BASE_URL', runtimeBaseUrl),
                github.setRepositoryVariable('DOCKER_IMAGE_URI', imageUri),
                github.setRepositoryVariable('PROJECT_SLUG', projectSlug),
                github.setRepositoryVariable('SERVICE_NAME', serviceName),
                ...(taskFamily ? [github.setRepositoryVariable('TASK_FAMILY', taskFamily)] : []),
                ...(targetGroupName ? [github.setRepositoryVariable('TARGET_GROUP_NAME', targetGroupName)] : []),
            ]);
        }

    } catch (error) {
        if (error instanceof Error) core.setFailed(error.message);
        else core.setFailed(String(error));
    }
}

run();
