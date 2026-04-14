import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as fs from 'fs';
import * as path from 'path';
import { PostmanApiClient, stripVolatileFields } from '../../_lib/postman-api';
import { convertAndSplitCollection, type PostmanCollectionV2 } from '../../_lib/postman-v3-simple';
import { GitHubApiClient } from '../../_lib/github-api';
import { setStepOutput, logStepInfo } from '../../_lib/step-output';
import { PROVISION_STEP_NAMES as STEPS } from '../../_lib/provision-steps';
import { associateSystemEnvironmentBatch } from '../../_lib/postman-bifrost';
import { stringify as stringifyYaml } from 'yaml';

function parseBooleanInput(value: string, defaultValue: boolean): boolean {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return defaultValue;
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return defaultValue;
}

function buildResourcesManifest(workspaceId: string, collectionMap: Record<string, string>): string {
    const manifest: Record<string, unknown> = {
        workspace: { id: workspaceId }
    };
    if (Object.keys(collectionMap).length > 0) {
        manifest.cloudResources = {
            collections: collectionMap
        };
    }
    manifest.localResources = {
        specs: ['../index.yaml']
    };
    return stringifyYaml(manifest);
}

export function buildFernDocsUrl(): string {
    return 'https://vzw-demo.docs.buildwithfern.com';
}

export async function run() {
    try {
        const projectName = core.getInput('project_name');
        const runtimeMode = core.getInput('runtime_mode');
        const deploymentMode = core.getInput('deployment_mode') || 'single';
        const githubWorkspaceSync = parseBooleanInput(core.getInput('github_workspace_sync'), true);
        const environmentSyncEnabled = parseBooleanInput(core.getInput('environment_sync_enabled'), true);
        const k8sDiscoveryWorkspaceLink = core.getInput('k8s_discovery_workspace_link') === 'true';
        const environments = JSON.parse(core.getInput('environments') || '["prod"]');
        const postmanTeamId = core.getInput('postman_team_id');
        let workspaceTeamId = core.getInput('workspace_team_id');
        const workspaceId = core.getInput('workspace_id');

        if (workspaceTeamId === undefined || workspaceTeamId.trim() === '') {
            workspaceTeamId = postmanTeamId;
        }
        const baselineUid = core.getInput('baseline_uid');
        const smokeUid = core.getInput('smoke_uid');
        const contractUid = core.getInput('contract_uid');
        const imageUri = core.getInput('image_uri');
        const runtimeBaseUrl = core.getInput('runtime_base_url');
        const systemEnvMap = JSON.parse(core.getInput('system_env_map') || '{}');
        const insightsProjectId = core.getInput('insights_project_id');

        const ecsServiceName = core.getInput('ecs_service_name');
        const ecsTargetGroupArn = core.getInput('ecs_target_group_arn');
        const ecsListenerRuleArn = core.getInput('ecs_listener_rule_arn');
        const ecsTaskDefinition = core.getInput('ecs_task_definition');

        const k8sNamespace = core.getInput('k8s_namespace');
        const k8sDeploymentName = core.getInput('k8s_deployment_name');
        const k8sServiceName = core.getInput('k8s_service_name');
        const k8sIngressName = core.getInput('k8s_ingress_name');

        const devGwUrl = core.getInput('dev_gw_url');
        const prodGwUrl = core.getInput('prod_gw_url');
        const devApiId = core.getInput('dev_api_id');
        const prodApiId = core.getInput('prod_api_id');
        const gwUrlsJson = JSON.parse(core.getInput('gw_urls_json') || '{}');
        const gwIdsJson = JSON.parse(core.getInput('gw_ids_json') || '{}');
        const envRuntimeUrlsJson = JSON.parse(core.getInput('env_runtime_urls_json') || '{}');
        const envResourceNamesJson = JSON.parse(core.getInput('env_resource_names_json') || '{}');
        const environmentDeploymentsJson = JSON.parse(core.getInput('environment_deployments_json') || '[]');

        const postmanApiKey = core.getInput('postman_api_key');
        const postmanAccessToken = core.getInput('postman_access_token');
        const githubAppToken = core.getInput('github_app_token');
        const pushToken = core.getInput('push_token');
        const ghFallbackToken = core.getInput('gh_fallback_token');
        const ghAuthMode = core.getInput('gh_auth_mode') || 'github_token_first';
        const fernToken = core.getInput('fern_token');
        const ciWorkflowBase64 = core.getInput('ci_workflow_base64');
        const committerName = core.getInput('committer_name') || 'Postman CSE';
        const committerEmail = core.getInput('committer_email') || 'help@postman.com';
        const requestedStep = core.getInput('step');
        const bifrostEnvAssociationEnabled = parseBooleanInput(process.env.BIFROST_ENV_ASSOCIATION_ENABLED || '', true);
        const insightsClusterName = core.getInput('insights_cluster_name') || process.env.POSTMAN_INSIGHTS_CLUSTER_NAME || 'vzw-partner-demo';

        const postman = new PostmanApiClient(postmanApiKey);
        const github = new GitHubApiClient(githubAppToken, process.env.GITHUB_REPOSITORY || '', {
            fallbackToken: ghFallbackToken,
            authMode: ghAuthMode as any,
        });
        const canReadRepoVariables = Boolean(githubAppToken && process.env.GITHUB_REPOSITORY);
        const envUids: Record<string, string> = JSON.parse(core.getInput('env_uids') || '{}');
        const skipWorkspaceSteps = runtimeMode === 'k8s_discovery' && !k8sDiscoveryWorkspaceLink;
        const needsRuntimeBaseUrlFallback = !String(runtimeBaseUrl || '').trim()
            && !Object.keys(envRuntimeUrlsJson || {}).length
            && runtimeMode !== 'lambda';
        const needsRepoEnvFallback = Boolean(workspaceId) && !skipWorkspaceSteps && Object.keys(envUids).length === 0;
        const needsRuntimeResourceFallback = runtimeMode === 'ecs_service'
            ? (!ecsServiceName || !ecsTaskDefinition)
            : (runtimeMode === 'k8s_workspace' || runtimeMode === 'k8s_discovery')
                ? (!k8sNamespace || !k8sDeploymentName || !k8sServiceName || !k8sIngressName)
                : false;
        let repoVariables: Record<string, string> | null = null;
        if (canReadRepoVariables && (needsRuntimeBaseUrlFallback || needsRepoEnvFallback || needsRuntimeResourceFallback)) {
            try {
                repoVariables = await github.listRepositoryVariables();
            } catch {
                repoVariables = null;
            }
        }
        const repoVar = async (name: string): Promise<string> => {
            if (repoVariables) return String(repoVariables[name] || '');
            if (!canReadRepoVariables) return '';
            try {
                return await github.getRepositoryVariable(name);
            } catch {
                return '';
            }
        };
        const parseJsonMap = (raw: string): Record<string, string> => {
            try {
                const parsed = JSON.parse(raw || '{}');
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
                const out: Record<string, string> = {};
                for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
                    const k = String(key || '').trim();
                    const v = String(value || '').trim();
                    if (!k || !v) continue;
                    out[k] = v;
                }
                return out;
            } catch {
                return {};
            }
        };
        const deployedEnvNames = Object.keys(envRuntimeUrlsJson || {});
        const preferredPrimaryEnv = systemEnvMap.prod ? 'prod' : (Object.keys(systemEnvMap)[0] || 'prod');
        const effectivePrimaryEnv = deployedEnvNames.includes(preferredPrimaryEnv)
            ? preferredPrimaryEnv
            : (deployedEnvNames[0] || preferredPrimaryEnv);
        const deployedPrimaryRuntimeUrl = String(envRuntimeUrlsJson[effectivePrimaryEnv] || '').trim();
        const fallbackRuntimeBaseUrl = String(runtimeBaseUrl || '').trim() || await repoVar('RUNTIME_BASE_URL');
        const effectiveRuntimeBaseUrl = deployedPrimaryRuntimeUrl || fallbackRuntimeBaseUrl;

        const shouldRun = (stepName: string) => !requestedStep || requestedStep === 'all' || requestedStep === stepName;
        const shouldRunAny = (stepNames: readonly string[]) =>
            !requestedStep || requestedStep === 'all' || stepNames.includes(requestedStep);

        // 1. Postman Environments
        if (!skipWorkspaceSteps && workspaceId && shouldRun(STEPS.CREATE_POSTMAN_ENVIRONMENTS)) {
            await core.group(STEPS.CREATE_POSTMAN_ENVIRONMENTS, async () => {
                if (environments.some((envName: string) => !envUids[envName])) {
                    const existingEnvUidMap = parseJsonMap(await repoVar('POSTMAN_ENV_UIDS_JSON'));
                    for (const [envName, envUid] of Object.entries(existingEnvUidMap)) {
                        if (!envUids[envName] && envUid) envUids[envName] = envUid;
                    }
                }
                const primaryEnv = systemEnvMap.prod ? 'prod' : (Object.keys(systemEnvMap)[0] || 'prod');

                for (const envName of environments) {
                    // Skip primary env for ECS if already created in pre-deploy
                    if (runtimeMode === 'ecs_service' && envName === primaryEnv) {
                        const existingUid = envUids[envName] || await repoVar('POSTMAN_ENVIRONMENT_UID');
                        if (existingUid) {
                            envUids[envName] = existingUid;
                            core.info(`Primary environment ${envName} already exists: ${existingUid}`);
                            continue;
                        }
                    }

                    let baseUrl = runtimeBaseUrl;
                    if (runtimeMode === 'lambda') {
                        baseUrl = gwUrlsJson[envName] || (envName === 'prod' ? prodGwUrl : devGwUrl);
                    } else {
                        baseUrl = envRuntimeUrlsJson[envName] || runtimeBaseUrl;
                    }

                    const values = [
                        { key: 'baseUrl', value: baseUrl || '', type: 'default' },
                        { key: 'CI', value: 'false', type: 'default' },
                        { key: 'RESPONSE_TIME_THRESHOLD', value: '2000', type: 'default' },
                        { key: 'AWS_ACCESS_KEY_ID', value: '', type: 'secret' },
                        { key: 'AWS_SECRET_ACCESS_KEY', value: '', type: 'secret' },
                        { key: 'AWS_REGION', value: 'eu-central-1', type: 'default' },
                        { key: 'AWS_SECRET_NAME', value: `api-credentials-${envName}`, type: 'default' }
                    ];

                    const existingUid = envUids[envName];
                    if (existingUid) {
                        await postman.updateEnvironment(existingUid, `${projectName} - ${envName}`, values);
                        core.info(`Environment ${envName} already exists, updated: ${existingUid}`);
                    } else {
                        const envUid = await postman.createEnvironment(workspaceId, `${projectName} - ${envName}`, values);
                        envUids[envName] = envUid;
                        core.info(`Environment ${envName}: ${envUid}`);
                    }
                }
                setStepOutput('env_uids', JSON.stringify(envUids));
            });
        }

        // 1.1 Associate Environments with System Environments
        if (!skipWorkspaceSteps && workspaceId && shouldRunAny([STEPS.CREATE_POSTMAN_ENVIRONMENTS]) && Object.keys(systemEnvMap).length > 0) {
            await core.group("Associate Environments with System Environments", async () => {
                if (!environmentSyncEnabled) {
                    core.warning('Environment sync disabled by workflow input (environment_sync_enabled=false)');
                    return;
                }
                if (!bifrostEnvAssociationEnabled) {
                    core.warning('Bifrost environment association disabled (set BIFROST_ENV_ASSOCIATION_ENABLED=true to re-enable)');
                    return;
                }
                const associations = [];
                for (const [envName, envUid] of Object.entries(envUids)) {
                    const systemEnvId = systemEnvMap[envName];
                    if (systemEnvId) {
                        associations.push({ envUid, systemEnvId });
                    }
                }

                if (associations.length > 0) {
                    if (!postmanAccessToken || !postmanTeamId) {
                        throw new Error('postman_access_token and postman_team_id are required for direct Bifrost environment association');
                    }
                    if (workspaceTeamId !== postmanTeamId) {
                        core.warning('Cross-squad System Environment associations are currently blocked by a known Bifrost proxy limitation. Skipping association.');
                    } else {
                        await associateSystemEnvironmentBatch(workspaceId, associations, postmanAccessToken, postmanTeamId);
                        logStepInfo('Postman', `Associated ${associations.length} environments with system environments`);
                    }
                }
            });
        }

        // ... remaining logic ...
        const runFinalize = async () => {
            // 2. Mock Server + 3. Smoke Monitor (independent, run in parallel)
            const mockPromise = (!skipWorkspaceSteps && workspaceId && baselineUid && shouldRun(STEPS.CREATE_MOCK_SERVER))
                ? core.group(STEPS.CREATE_MOCK_SERVER, async () => {
                    const envUid = envUids['dev'] || envUids['prod'] || '';
                    if (envUid) {
                        const mock = await postman.createMock(workspaceId, `${projectName} Mock`, baselineUid, envUid);
                        setStepOutput('mock_url', mock.url);
                        logStepInfo('Postman', `Mock Server: ${mock.url}`);
                    }
                })
                : Promise.resolve();

            const monitorPromise = (!skipWorkspaceSteps && workspaceId && smokeUid && shouldRun(STEPS.CREATE_SMOKE_MONITOR))
                ? core.group(STEPS.CREATE_SMOKE_MONITOR, async () => {
                    const envUid = envUids['prod'] || envUids['dev'] || '';
                    if (envUid) {
                        try {
                            const monitorUid = await postman.createMonitor(workspaceId, `${projectName} - Smoke Monitor`, smokeUid, envUid);
                            setStepOutput('monitor_uid', monitorUid);
                            logStepInfo('Postman', `Smoke Monitor: ${monitorUid}`);
                        } catch (e) {
                            core.warning(`Failed to create monitor: ${e}`);
                        }
                    }
                })
                : Promise.resolve();

            await Promise.all([mockPromise, monitorPromise]);

            // 4. Store Repo Variables
            if (shouldRun(STEPS.STORE_AWS_OUTPUTS_AS_REPO_VARIABLES)) {
                await core.group(STEPS.STORE_AWS_OUTPUTS_AS_REPO_VARIABLES, async () => {
                    const setVarTasks: (() => Promise<void>)[] = [];
                    const setVar = async (name: string, value: string | undefined, optional = false) => {
                        if (!value) {
                            if (optional) core.warning(`Optional variable ${name} is empty`);
                            else throw new Error(`Variable ${name} is required but empty`);
                            return;
                        }
                        setVarTasks.push(async () => { await github.setRepositoryVariable(name, value); });
                    };

                    await setVar('RUNTIME_MODE', runtimeMode);
                    if (insightsProjectId) await setVar('POSTMAN_INSIGHTS_PROJECT_ID', insightsProjectId, true);
                    await setVar('ENV_RUNTIME_URLS_JSON', JSON.stringify(envRuntimeUrlsJson), true);
                    await setVar('ENV_RESOURCE_NAMES_JSON', JSON.stringify(envResourceNamesJson), true);
                    if (runtimeMode === 'ecs_service') {
                        const effectiveServiceName = ecsServiceName || await repoVar('ECS_SERVICE_NAME') || `${projectName}-svc`;
                        await setVar('FUNCTION_NAME', effectiveServiceName);
                        await setVar('DEV_GW_URL', effectiveRuntimeBaseUrl);
                        await setVar('PROD_GW_URL', effectiveRuntimeBaseUrl);
                        await setVar('RUNTIME_BASE_URL', effectiveRuntimeBaseUrl);
                        await setVar('POSTMAN_INSIGHTS_ONBOARDING_MODE', 'workspace');
                        await setVar('POSTMAN_INSIGHTS_WORKSPACE_ID', workspaceId!);
                        await setVar('ECS_CLUSTER_NAME', process.env.ECS_CLUSTER_NAME!);
                        await setVar('ECS_SERVICE_NAME', effectiveServiceName);
                        await setVar('ECS_TASK_DEFINITION', ecsTaskDefinition || await repoVar('ECS_TASK_DEFINITION') || effectiveServiceName);
                        await setVar('ECS_TARGET_GROUP_ARN', ecsTargetGroupArn, true);
                        await setVar('ECS_LISTENER_RULE_ARN', ecsListenerRuleArn, true);
                        if (imageUri) await setVar('ECS_IMAGE_URI', imageUri, true);
                    } else if (runtimeMode === 'k8s_workspace') {
                        const effectiveK8sName = k8sDeploymentName || await repoVar('K8S_DEPLOYMENT_NAME') || projectName;
                        await setVar('FUNCTION_NAME', effectiveK8sName);
                        await setVar('DEV_GW_URL', effectiveRuntimeBaseUrl);
                        await setVar('PROD_GW_URL', effectiveRuntimeBaseUrl);
                        await setVar('RUNTIME_BASE_URL', effectiveRuntimeBaseUrl);
                        await setVar('POSTMAN_INSIGHTS_ONBOARDING_MODE', 'workspace');
                        await setVar('POSTMAN_INSIGHTS_WORKSPACE_ID', workspaceId!);
                        await setVar('K8S_NAMESPACE', k8sNamespace || await repoVar('K8S_NAMESPACE') || 'vzw-partner-demo');
                        await setVar('K8S_DEPLOYMENT_NAME', effectiveK8sName);
                        await setVar('K8S_SERVICE_NAME', k8sServiceName || await repoVar('K8S_SERVICE_NAME') || effectiveK8sName);
                        await setVar('K8S_INGRESS_NAME', k8sIngressName || await repoVar('K8S_INGRESS_NAME') || `${effectiveK8sName}-ingress`);
                    } else if (runtimeMode === 'k8s_discovery') {
                        const effectiveK8sName = k8sDeploymentName || await repoVar('K8S_DEPLOYMENT_NAME') || projectName;
                        await setVar('FUNCTION_NAME', effectiveK8sName);
                        await setVar('DEV_GW_URL', effectiveRuntimeBaseUrl);
                        await setVar('PROD_GW_URL', effectiveRuntimeBaseUrl);
                        await setVar('RUNTIME_BASE_URL', effectiveRuntimeBaseUrl);
                        await setVar('POSTMAN_INSIGHTS_ONBOARDING_MODE', 'discovery');
                        await setVar('POSTMAN_INSIGHTS_CLUSTER_NAME', insightsClusterName);
                        await setVar('K8S_NAMESPACE', k8sNamespace || await repoVar('K8S_NAMESPACE') || 'vzw-partner-demo');
                        await setVar('K8S_DEPLOYMENT_NAME', effectiveK8sName);
                        await setVar('K8S_SERVICE_NAME', k8sServiceName || await repoVar('K8S_SERVICE_NAME') || effectiveK8sName);
                        await setVar('K8S_INGRESS_NAME', k8sIngressName || await repoVar('K8S_INGRESS_NAME') || `${effectiveK8sName}-ingress`);
                    } else {
                        const primaryEnv = systemEnvMap.prod ? 'prod' : (Object.keys(systemEnvMap)[0] || 'prod');
                        const prodUrl = gwUrlsJson[primaryEnv] || prodGwUrl || devGwUrl;
                        const devUrl = gwUrlsJson['dev'] || devGwUrl || prodUrl;
                        await setVar('FUNCTION_NAME', `${projectName}-${primaryEnv}`);
                        await setVar('DEV_GW_URL', devUrl);
                        await setVar('PROD_GW_URL', prodUrl);
                        await setVar('RUNTIME_BASE_URL', prodUrl);
                        await setVar('DEV_API_ID', gwIdsJson['dev'] || devApiId || prodApiId, true);
                        await setVar('PROD_API_ID', gwIdsJson[primaryEnv] || prodApiId || devApiId, true);
                    }

                    if (!skipWorkspaceSteps && workspaceId) {
                        const envUid = envUids[effectivePrimaryEnv] || Object.values(envUids)[0];
                        if (envUid) await setVar('POSTMAN_ENVIRONMENT_UID', envUid);
                        if (Object.keys(envUids).length > 0) {
                            await setVar('POSTMAN_ENV_UIDS_JSON', JSON.stringify(envUids));
                        }
                    }

                    const branchMap = Object.fromEntries(environments.map((envName: string) => [envName, `env/${envName}`]));
                    const effectiveRuntimeUrls = Object.keys(envRuntimeUrlsJson).length > 0
                        ? envRuntimeUrlsJson
                        : Object.fromEntries(environments.map((envName: string) => {
                            const lambdaUrl = gwUrlsJson[envName] || (envName === 'prod' ? prodGwUrl : devGwUrl) || runtimeBaseUrl || '';
                            return [envName, String(lambdaUrl || '').replace(/\/+$/, '')];
                        }));
                    const normalizedEnvironmentDeployments = Array.isArray(environmentDeploymentsJson) && environmentDeploymentsJson.length > 0
                        ? environmentDeploymentsJson
                        : environments.map((envName: string) => ({
                            environment: envName,
                            runtime_url: String(effectiveRuntimeUrls[envName] || '').replace(/\/+$/, ''),
                            api_gateway_id: String(gwIdsJson[envName] || '').trim(),
                            postman_env_uid: String(envUids[envName] || '').trim(),
                            system_env_id: String(systemEnvMap[envName] || '').trim(),
                            status: effectiveRuntimeUrls[envName] ? 'active' : 'pending',
                            deployed_at: new Date().toISOString(),
                            branch: branchMap[envName] || `env/${envName}`,
                        }));
                    await setVar('ENVIRONMENT_DEPLOYMENTS_JSON', JSON.stringify(normalizedEnvironmentDeployments), true);
                    await setVar('ENV_BRANCH_MAP_JSON', JSON.stringify(branchMap), true);

                    const CONCURRENCY = 4;
                    const queue = [...setVarTasks];
                    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
                        while (queue.length > 0) {
                            const task = queue.shift()!;
                            await task();
                        }
                    }));
                });
            }

            // 5. Export Artifacts
            if (!skipWorkspaceSteps && workspaceId && shouldRun(STEPS.EXPORT_POSTMAN_ARTIFACTS_TO_REPO)) {
                await core.group(STEPS.EXPORT_POSTMAN_ARTIFACTS_TO_REPO, async () => {
                    await io.mkdirP('postman/collections');
                    await io.mkdirP('postman/environments');
                    await io.mkdirP('postman/mocks');
                    await io.mkdirP('.postman');

                    const writeArtifact = (filePath: string, data: unknown) =>
                        fs.writeFileSync(filePath, JSON.stringify(stripVolatileFields(data), null, 2));
                    const exportedCollections: Record<string, string> = {};
                    const collectionExports = [
                        { prefix: '[Baseline]', uid: baselineUid },
                        { prefix: '[Smoke]', uid: smokeUid },
                        { prefix: '[Contract]', uid: contractUid }
                    ].filter((entry): entry is { prefix: string; uid: string } => Boolean(entry.uid));

                    await Promise.all(collectionExports.map(async (entry) => {
                        const collectionDir = `postman/collections/${entry.prefix} ${projectName}`;
                        const collection = stripVolatileFields(await postman.getCollection(entry.uid)) as PostmanCollectionV2;
                        await convertAndSplitCollection(collection, collectionDir);
                        exportedCollections[`../${collectionDir}`] = entry.uid;
                    }));

                    const tasks: (() => Promise<void>)[] = [];
                    for (const [envName, envUid] of Object.entries(envUids)) {
                        tasks.push(async () => writeArtifact(`postman/environments/${envName}.postman_environment.json`, await postman.getEnvironment(envUid)));
                    }
                    const limit = 5;
                    const queue = [...tasks];
                    await Promise.all(Array.from({ length: limit }, async () => {
                        while (queue.length > 0) {
                            await queue.shift()!();
                        }
                    }));

                    fs.writeFileSync('.postman/config.json', JSON.stringify({
                        schemaVersion: "1", workspace: { id: workspaceId },
                        collectionPaths: ["postman/collections/"], environmentPaths: ["postman/environments/"], mockPaths: ["postman/mocks/"]
                    }, null, 2));
                    fs.writeFileSync('.postman/resources.yaml', buildResourcesManifest(workspaceId, exportedCollections));
                    core.info('Artifacts exported');
                });
            }

            // 6. Bifrost
            // k8s_workspace/ecs_service already link Bifrost in aws-deploy predeploy; skip redundant call
            const alreadyLinkedInPredeploy = runtimeMode === 'k8s_workspace' || runtimeMode === 'ecs_service';
            if (!skipWorkspaceSteps && workspaceId && githubWorkspaceSync && !alreadyLinkedInPredeploy && shouldRun(STEPS.CONNECT_WORKSPACE_VIA_BIFROST)) {
                await core.group(STEPS.CONNECT_WORKSPACE_VIA_BIFROST, async () => {
                    const repoUrl = `https://github.com/${process.env.GITHUB_REPOSITORY}`;
                    const effectiveTeamId = workspaceTeamId || postmanTeamId;
                    const orgTeamId = postmanTeamId !== effectiveTeamId ? postmanTeamId : undefined;
                    core.info(`Using teamId=${effectiveTeamId}${orgTeamId ? ` (org fallback=${orgTeamId})` : ''}, workspace=${workspaceId}`);
                    try {
                        await postman.proxyBifrost(workspaceId, repoUrl, effectiveTeamId, postmanAccessToken, orgTeamId);
                        core.info('Bifrost connected');
                    } catch (e) {
                        throw new Error(`Bifrost connection failed: ${e}`);
                    }
                });
            }

            // 6b. Insights Discovery Onboarding (direct Bifrost, no worker dependency)
            if (!skipWorkspaceSteps && workspaceId && runtimeMode === 'k8s_discovery' && shouldRun(STEPS.ONBOARD_INSIGHTS_DISCOVERY)) {
                await core.group(STEPS.ONBOARD_INSIGHTS_DISCOVERY, async () => {
                    const BIFROST_URL = 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy';
                    const bifrostHeaders = {
                        'x-access-token': postmanAccessToken,
                        'x-entity-team-id': workspaceTeamId,
                        'Content-Type': 'application/json',
                    };
                    const gitOwner = (process.env.GITHUB_REPOSITORY || '').split('/')[0] || 'postman-cs';
                    const ghToken = String(pushToken || ghFallbackToken || githubAppToken || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();

                    // Acknowledge workspace onboarding FIRST.
                    // This must run even if individual environment onboarding steps fail or if the service isn't discovered yet,
                    // because without it the Insights agent resolves zero identity and
                    // never builds API models or graph edges.
                    try {
                        const wsAckRes = await fetch(BIFROST_URL, {
                            method: 'POST',
                            headers: bifrostHeaders, // uses workspaceTeamId
                            body: JSON.stringify({
                                service: 'akita',
                                method: 'POST',
                                path: `/v2/workspaces/${workspaceId}/onboarding/acknowledge`,
                                body: {},
                            }),
                        });
                        if (wsAckRes.ok) {
                            core.info(`Workspace onboarding acknowledged for ${workspaceId}`);
                        } else {
                            core.warning(`Workspace acknowledge failed: ${wsAckRes.status} ${await wsAckRes.text().catch(() => '')}`);
                        }
                    } catch (e) {
                        core.warning(`Workspace acknowledge error: ${e}`);
                    }

                    const listRes = await fetch(BIFROST_URL, {
                        method: 'POST',
                        headers: bifrostHeaders, // uses workspaceTeamId
                        body: JSON.stringify({
                            service: 'api-catalog',
                            method: 'GET',
                            path: '/api/v1/onboarding/discovered-services?status=discovered',
                            body: {},
                        }),
                    });
                    if (!listRes.ok) {
                        throw new Error(`Failed to list discovered services: ${listRes.status} ${await listRes.text().catch(() => '')}`);
                    }
                    const listData = (await listRes.json()) as { items?: Array<{ id: number; name: string }> };
                    const discovered: Array<{ id: number; name: string; systemEnvironmentId?: string }> = listData.items || [];

                    const fullName = insightsClusterName ? `${insightsClusterName}/${projectName}` : projectName;
                    const match = discovered.find((s) => s.name === fullName)
                        || discovered.find((s) => s.name.endsWith(`/${projectName}`));

                    if (!match) {
                        core.warning(`Service "${fullName}" not found in ${discovered.length} discovered services. This is normal if the service just started and hasn't received traffic yet. Skipping remaining automatic Insights onboarding.`);
                        return;
                    }
                    core.info(`Matched discovered service: ${match.name} (id: ${match.id})`);

                    // Resolve svc_* provider ID from Akita for acknowledgment
                    const akitaRes = await fetch(BIFROST_URL, {
                        method: 'POST',
                        headers: bifrostHeaders, // uses workspaceTeamId
                        body: JSON.stringify({
                            service: 'akita',
                            method: 'GET',
                            path: '/v2/api-catalog/services?status=discovered&populate_endpoints=false&populate_discovery_metadata=true',
                            body: {},
                        }),
                    });
                    if (!akitaRes.ok) {
                        throw new Error(`Failed to resolve Akita provider service ID: ${akitaRes.status} ${await akitaRes.text().catch(() => '')}`);
                    }
                    const akitaData = (await akitaRes.json()) as { services?: Array<{ id: string; name: string }> };
                    const akitaMatch = (akitaData.services || []).find((s) => s.name === fullName)
                        || (akitaData.services || []).find((s) => s.name.endsWith(`/${projectName}`));
                    const providerServiceId = akitaMatch?.id || '';
                    if (!providerServiceId) {
                        throw new Error(`Could not resolve Akita provider service ID for ${fullName}`);
                    }

                    const defaultSystemEnvId = Object.values(systemEnvMap as Record<string, string>)
                        .map((value) => String(value || '').trim())
                        .find(Boolean) || '';

                    for (const envSlug of environments) {
                        const envUid = envUids[envSlug] || '';
                        if (!envUid) {
                            throw new Error(`No environment UID for ${envSlug}, cannot complete Insights onboard`);
                        }
                        const sysEnvId = (systemEnvMap as Record<string, string>)[envSlug]
                            || defaultSystemEnvId
                            || match.systemEnvironmentId
                            || '';
                        try {
                            const prepareRes = await fetch(BIFROST_URL, {
                                method: 'POST',
                                headers: bifrostHeaders,
                                body: JSON.stringify({
                                    service: 'api-catalog',
                                    method: 'POST',
                                    path: '/api/v1/onboarding/prepare-collection',
                                    body: { service_id: String(match.id), workspace_id: workspaceId },
                                }),
                            });
                            if (!prepareRes.ok) {
                                throw new Error(`prepare-collection failed for ${envSlug}: ${prepareRes.status} ${await prepareRes.text().catch(() => '')}`);
                            }
                            core.info(`Collection prepared for ${envSlug}`);

                            const gitRes = await fetch(BIFROST_URL, {
                                method: 'POST',
                                headers: bifrostHeaders,
                                body: JSON.stringify({
                                    service: 'api-catalog',
                                    method: 'POST',
                                    path: '/api/v1/onboarding/git',
                                    body: {
                                        via_integrations: false,
                                        git_service_name: 'github',
                                        workspace_id: workspaceId,
                                        git_repository_url: `https://github.com/${gitOwner}/${projectName}`,
                                        git_api_key: ghToken,
                                        service_id: match.id,
                                        environment_id: envUid,
                                    },
                                }),
                            });
                            if (gitRes.ok) {
                                core.info(`Insights onboard for ${envSlug}: ${match.name} linked`);
                            } else {
                                const errBody = await gitRes.text().catch(() => '');
                                throw new Error(`Insights git onboard for ${envSlug} failed: ${gitRes.status} ${errBody}`);
                            }

                            // Acknowledge onboarding with Akita backend (service-level)
                            if (providerServiceId && sysEnvId) {
                                const ackRes = await fetch(BIFROST_URL, {
                                    method: 'POST',
                                    headers: bifrostHeaders,
                                    body: JSON.stringify({
                                        service: 'akita',
                                        method: 'POST',
                                        path: '/v2/api-catalog/services/onboard',
                                        body: {
                                            services: [{
                                                service_id: providerServiceId,
                                                workspace_id: workspaceId,
                                                system_env: sysEnvId,
                                            }],
                                        },
                                    }),
                                });
                                if (ackRes.ok) {
                                    core.info(`Insights acknowledged for ${envSlug}: ${providerServiceId}`);
                                } else {
                                    throw new Error(`Insights acknowledge for ${envSlug} failed: ${ackRes.status} ${await ackRes.text().catch(() => '')}`);
                                }
                            }

                        } catch (e) {
                            throw new Error(`Insights onboard for ${envSlug} error: ${e}`);
                        }
                    }

                    // Application binding (direct to observability API, not Bifrost)
                    for (const envSlug of environments) {
                        const sysEnvId = (systemEnvMap as Record<string, string>)[envSlug] || '';
                        if (!sysEnvId) continue;
                        try {
                            const appRes = await fetch(
                                `https://api.observability.postman.com/v2/agent/api-catalog/workspaces/${workspaceId}/applications`,
                                {
                                    method: 'POST',
                                    headers: {
                                        'x-api-key': postmanApiKey,
                                        'x-postman-env': 'production',
                                        'Content-Type': 'application/json',
                                    },
                                    body: JSON.stringify({ system_env: sysEnvId }),
                                },
                            );
                            if (appRes.ok) {
                                const appData = (await appRes.json()) as { application_id?: string };
                                logStepInfo('Insights', `Application binding created: ${appData.application_id || 'unknown'} for env ${envSlug}`);
                            } else {
                                throw new Error(`Application binding for ${envSlug} failed: ${appRes.status} ${await appRes.text()}`);
                            }
                        } catch (e) {
                            throw new Error(`Application binding error for ${envSlug}: ${e}`);
                        }
                    }

                    // Safety net: ensure verification token is in K8s secret (for clusters deployed before token handling)
                    try {
                        const DS_NAMESPACE = 'postman-insights-namespace';
                        const SECRET_NAME = 'postman-agent-secrets';

                        // Check if secret has verification token
                        const secretCheck = await exec.getExecOutput('kubectl', [
                            'get', 'secret', SECRET_NAME, '-n', DS_NAMESPACE,
                            '-o', 'jsonpath={.data.postman-verification-token}'
                        ], { silent: true, ignoreReturnCode: true });

                        if (secretCheck.exitCode !== 0 || !secretCheck.stdout.trim()) {
                            core.info('Verification token missing from K8s secret; retrieving and patching...');

                            // Retrieve token via Bifrost (use first environment's workspace ID)
                            const wsIdForToken = workspaceId;
                            const tokenRes = await fetch(BIFROST_URL, {
                                method: 'POST',
                                headers: bifrostHeaders,
                                body: JSON.stringify({
                                    service: 'akita',
                                    method: 'GET',
                                    path: `/v2/workspaces/${wsIdForToken}/team-verification-token`,
                                    body: {},
                                }),
                            });

                            if (tokenRes.ok) {
                                const tokenData = (await tokenRes.json()) as { team_verification_token?: string };
                                const verifyToken = tokenData.team_verification_token;
                                if (verifyToken) {
                                    // Patch secret to add verification token
                                    await exec.exec('kubectl', [
                                        'patch', 'secret', SECRET_NAME, '-n', DS_NAMESPACE,
                                        '--type', 'merge',
                                        '-p', JSON.stringify({
                                            stringData: { 'postman-verification-token': verifyToken }
                                        })
                                    ]);
                                    core.info('Patched K8s secret with verification token');

                                    // Check if DaemonSet has the env var; if not, patch it too
                                    const dsEnvCheck = await exec.getExecOutput('kubectl', [
                                        'get', 'daemonset', 'postman-insights-agent', '-n', DS_NAMESPACE,
                                        '-o', 'jsonpath={.spec.template.spec.containers[0].env[*].name}'
                                    ], { silent: true, ignoreReturnCode: true });

                                    if (!dsEnvCheck.stdout.includes('POSTMAN_INSIGHTS_VERIFICATION_TOKEN')) {
                                        core.info('Adding POSTMAN_INSIGHTS_VERIFICATION_TOKEN to DaemonSet...');
                                        await exec.exec('kubectl', [
                                            'patch', 'daemonset', 'postman-insights-agent', '-n', DS_NAMESPACE,
                                            '--type', 'json',
                                            '-p', JSON.stringify([{
                                                op: 'add',
                                                path: '/spec/template/spec/containers/0/env/-',
                                                value: {
                                                    name: 'POSTMAN_INSIGHTS_VERIFICATION_TOKEN',
                                                    valueFrom: {
                                                        secretKeyRef: {
                                                            name: SECRET_NAME,
                                                            key: 'postman-verification-token'
                                                        }
                                                    }
                                                }
                                            }])
                                        ]);
                                        core.info('Patched DaemonSet; rolling out restart...');
                                        await exec.exec('kubectl', [
                                            'rollout', 'restart', 'daemonset',
                                            'postman-insights-agent', '-n', DS_NAMESPACE
                                        ]);
                                    }
                                } else {
                                    core.warning('Team verification token not found in Bifrost response');
                                }
                            } else {
                                core.warning(`Failed to retrieve verification token: ${tokenRes.status}`);
                            }
                        } else {
                            core.debug('Verification token already present in K8s secret');
                        }
                    } catch (e) {
                        core.warning(`Verification token safety-net error: ${e}`);
                    }
                });
            }

            // 7. Fern Docs — set deep link URL deterministically without publishing.
            // Publishing is centralized from the main repo's fern/ directory only.
            // Per-repo fern generate is DISABLED to prevent overwriting the unified site.
            if (shouldRun(STEPS.GENERATE_FERN_DOCS)) {
                await core.group(STEPS.GENERATE_FERN_DOCS, async () => {
                    const docsUrl = buildFernDocsUrl();
                    setStepOutput('fern_docs_url', docsUrl);
                    logStepInfo('Fern', `Docs URL (shared site placeholder, no per-repo publish): ${docsUrl}`);
                    await github.setRepositoryVariable('FERN_DOCS_URL', docsUrl);
                });
            }
            // 7.5 Trigger Unified Fern Publish
            if (shouldRun(STEPS.GENERATE_FERN_DOCS) && deploymentMode === 'single') {
                await core.group('Trigger Unified Fern Publish', async () => {
                    try {
                        const repo = process.env.GITHUB_REPOSITORY || '';
                        const mainRepo = 'postman-cs/vzw-partner-demo';
                        const payload = {
                            event_type: 'provision_success',
                            client_payload: {
                                service_id: projectName,
                                repo: repo,
                                runtime_mode: runtimeMode,
                                success_timestamp: new Date().toISOString()
                            }
                        };
                        const token = pushToken || ghFallbackToken || githubAppToken || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
                        const res = await fetch(`https://api.github.com/repos/${mainRepo}/dispatches`, {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${token}`,
                                'Accept': 'application/vnd.github.v3+json',
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify(payload)
                        });
                        if (!res.ok) {
                            throw new Error(`HTTP ${res.status} ${await res.text()}`);
                        }
                        core.info(`Triggered unified-fern-publish.yml for ${projectName}`);
                    } catch (e) {
                        core.warning(`Failed to trigger unified-fern-publish.yml: ${e}`);
                    }
                });
            }


            // 8. Commit & Push
            if (shouldRun(STEPS.COMMIT_ARTIFACTS_AND_REPLACE_PROVISION_WITH_CI_WORKFLOW)) {
                await core.group(STEPS.COMMIT_ARTIFACTS_AND_REPLACE_PROVISION_WITH_CI_WORKFLOW, async () => {
                    await exec.exec('git', ['config', 'user.name', committerName]);
                    await exec.exec('git', ['config', 'user.email', committerEmail]);
                    if (fs.existsSync('postman') || fs.existsSync('.postman')) {
                        await exec.exec('git', ['add', 'postman/', '.postman/']);
                        await exec.exec('git', ['commit', '-m', 'chore: add Postman artifacts (collections, environments, spec)'], { ignoreReturnCode: true });
                    }
                    let ciContent = '';
                    if (ciWorkflowBase64) {
                        ciContent = Buffer.from(ciWorkflowBase64, 'base64').toString('utf8');
                    } else {
                        const checkedOutTemplate = path.join('.actions', '.github', 'workflows', 'ci-template.yml');
                        if (fs.existsSync(checkedOutTemplate)) {
                            ciContent = fs.readFileSync(checkedOutTemplate, 'utf8');
                        }
                    }
                    if (!ciContent.trim()) {
                        throw new Error('Could not load CI workflow template content');
                    }
                    await io.mkdirP('.github/workflows');
                    fs.writeFileSync('.github/workflows/ci.yml', ciContent);
                    await exec.exec('git', ['rm', '.github/workflows/provision.yml'], { ignoreReturnCode: true });
                    await exec.exec('git', ['add', '.github/workflows/ci.yml']);
                    const hasStagedChanges = (await exec.getExecOutput('git', ['diff', '--cached', '--quiet'], { ignoreReturnCode: true })).exitCode !== 0;
                    if (hasStagedChanges) {
                        await exec.exec('git', ['commit', '-m', 'feat: replace provision workflow with CI/CD pipeline']);
                    } else {
                        core.info('No staged changes for CI workflow commit; skipping (idempotent rerun).');
                    }
                    // Replace checkout-injected auth header so explicit remote credentials are honored.
                    const repo = process.env.GITHUB_REPOSITORY || '';
                    await exec.exec('git', ['config', '--unset-all', 'http.https://github.com/.extraheader'], { ignoreReturnCode: true });
                    const normalizedPushToken = String(pushToken || '').trim();
                    const normalizedFallbackToken = String(ghFallbackToken || '').trim();
                    const normalizedAppToken = String(githubAppToken || '').trim();

                    // ci.yml writes target .github/workflows and often require broader token permissions.
                    // Prefer explicit workflow-push token first, then fallback PAT, then the app/github token.
                    const pushTokens = [normalizedPushToken, normalizedFallbackToken, normalizedAppToken]
                        .filter(Boolean)
                        .filter((token, idx, arr) => arr.indexOf(token) === idx);
                    if (pushTokens.length === 0) {
                        throw new Error('No push token configured for finalize commit');
                    }

                    let pushed = false;
                    let lastError = '';
                    for (const token of pushTokens) {
                        await exec.exec('git', ['remote', 'set-url', 'origin', `https://x-access-token:${token}@github.com/${repo}.git`]);
                        const result = await exec.getExecOutput('git', ['push', 'origin', 'main'], { ignoreReturnCode: true });
                        if (result.exitCode === 0) {
                            pushed = true;
                            break;
                        }
                        lastError = (result.stderr || result.stdout || '').trim();
                        core.warning(`git push failed with current token; trying next credential source`);
                    }

                    if (!pushed) {
                        if (lastError.includes('without `workflows` permission') || lastError.includes('403')) {
                            core.error(`Cannot push ci.yml: none of the ${pushTokens.length} credential(s) could update workflow files. Ensure GH_TOKEN (or the app token used for pushes) has repository Workflows: write permission.\nUnderlying error: ${lastError}`);
                        }
                        throw new Error(`Failed to push finalize commit: ${lastError}`);
                    }
                });
            }
        };

        await runFinalize();

        // Summary
        await core.group(STEPS.SUMMARY, async () => {
            core.info('Provisioning finalize complete');
        });

    } catch (error) {
        if (error instanceof Error) core.setFailed(error.message);
        else core.setFailed(String(error));
    }
}

if (!process.env.VITEST) {
    void run();
}
