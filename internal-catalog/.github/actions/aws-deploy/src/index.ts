import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as fs from 'fs';
import * as path from 'path';
import { PostmanApiClient } from '../../_lib/postman-api';
import { GitHubApiClient } from '../../_lib/github-api';
import { setStepOutput, logStepInfo } from '../../_lib/step-output';
import { PROVISION_STEP_NAMES as STEPS } from '../../_lib/provision-steps';
import { associateSystemEnvironmentBatch } from '../../_lib/postman-bifrost';

function parseBooleanInput(value: string, defaultValue: boolean): boolean {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return defaultValue;
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return defaultValue;
}

const DEFAULT_K8S_APP_CPU_REQUEST = '50m';
const DEFAULT_K8S_APP_CPU_LIMIT = '200m';
const DEFAULT_K8S_APP_MEMORY_REQUEST = '64Mi';
const DEFAULT_K8S_APP_MEMORY_LIMIT = '128Mi';
const DEFAULT_OTEL_PROPAGATORS = 'tracecontext,baggage,b3,b3multi';

export async function run() {
    try {
        const projectName = core.getInput('project_name');
        const runtimeMode = core.getInput('runtime_mode');
        const chaosEnabled = parseBooleanInput(core.getInput('chaos_enabled'), true);
        const chaosConfig = core.getInput('chaos_config') || '';
        const githubWorkspaceSync = parseBooleanInput(core.getInput('github_workspace_sync'), true);
        const environmentSyncEnabled = parseBooleanInput(core.getInput('environment_sync_enabled'), true);
        const postmanApiKey = core.getInput('postman_api_key');
        const postmanAccessToken = core.getInput('postman_access_token');
        const githubAppToken = core.getInput('github_app_token');
        const ghFallbackToken = core.getInput('gh_fallback_token');
        const ghAuthMode = core.getInput('gh_auth_mode') || 'github_token_first';
        const persistPredeployEnvRepoVariables = parseBooleanInput(core.getInput('persist_predeploy_env_repo_variables'), true);
        const postmanTeamId = core.getInput('postman_team_id');
        const awsRegion = core.getInput('aws_region') || 'eu-central-1';
        const requestedStep = core.getInput('step');

        let baselineUid = core.getInput('baseline_uid');
        let workspaceId = core.getInput('workspace_id');
        let imageUri = core.getInput('image_uri');
        let runtimeBaseUrlInput = core.getInput('runtime_base_url');
        let serviceNameInput = core.getInput('service_name');
        let taskFamilyInput = core.getInput('task_family');
        let targetGroupNameInput = core.getInput('target_group_name');
        let projectSlugInput = core.getInput('project_slug');
        const hostPortInput = core.getInput('host_port');
        const depTargetsJson = core.getInput('dependency_targets_json') || '[]';
        const rawEnvironmentInputs = JSON.parse(core.getInput('environments') || '["prod"]');
        const environmentInputs = Array.isArray(rawEnvironmentInputs)
            ? rawEnvironmentInputs.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
            : ['prod'];
        const systemEnvMap = JSON.parse(core.getInput('system_env_map') || '{}');

        const postman = new PostmanApiClient(postmanApiKey);
        const githubApi = new GitHubApiClient(githubAppToken, process.env.GITHUB_REPOSITORY || '', {
            fallbackToken: ghFallbackToken,
            authMode: ghAuthMode as any,
        });
        const canReadRepoVariables = Boolean(githubAppToken && process.env.GITHUB_REPOSITORY);
        let repoVariables: Record<string, string> | null = null;
        const needsRepoVariablePreload = runtimeMode === 'ecs_service'
            ? (!baselineUid || !workspaceId || !imageUri || !runtimeBaseUrlInput || !serviceNameInput || !taskFamilyInput || !targetGroupNameInput)
            : runtimeMode === 'k8s_workspace'
                ? (!workspaceId || !imageUri || !runtimeBaseUrlInput || !serviceNameInput)
                : runtimeMode === 'k8s_discovery'
                    ? (!imageUri || !runtimeBaseUrlInput || !serviceNameInput)
                    : false;
        if (canReadRepoVariables && needsRepoVariablePreload) {
            try {
                repoVariables = await githubApi.listRepositoryVariables();
            } catch {
                repoVariables = null;
            }
        }

        const shouldRun = (stepName: string) => !requestedStep || requestedStep === 'all' || requestedStep === stepName;
        const shouldRunAny = (stepNames: readonly string[]) =>
            !requestedStep || requestedStep === 'all' || stepNames.includes(requestedStep);
        const lambdaSteps = [
            STEPS.CREATE_IAM_EXECUTION_ROLE,
            STEPS.PACKAGE_LAMBDA,
            STEPS.DEPLOY_LAMBDA_FUNCTIONS,
            STEPS.HEALTH_CHECK
        ] as const;
        const ecsSteps = [
            STEPS.CREATE_POSTMAN_ENVIRONMENTS_ECS_PREDEPLOY,
            STEPS.CONNECT_WORKSPACE_VIA_BIFROST_PREDEPLOY,
            STEPS.ASSOCIATE_WORKSPACE_ENVIRONMENT_WITH_SYSTEM_ENV_PREDEPLOY,
            STEPS.BUILD_AND_DEPLOY_ECS_SERVICE_ARM64,
            STEPS.VERIFY_INSIGHTS_SIDECAR_ON_ECS_SERVICE,
            STEPS.PERSIST_ECS_ARNS_AS_REPO_VARIABLES,
            STEPS.HEALTH_CHECK_ECS_SERVICE
        ] as const;
        const k8sSteps = [
            STEPS.CONFIGURE_KUBECONFIG,
            STEPS.VALIDATE_DISCOVERY_SHARED_INFRASTRUCTURE,
            STEPS.DEPLOY_KUBERNETES_WORKLOAD,
            STEPS.REFRESH_K8S_CONFIG_MAP,
            STEPS.CONNECT_WORKSPACE_VIA_BIFROST_PREDEPLOY,
            STEPS.INJECT_INSIGHTS_SIDECAR,
            STEPS.APPLY_DISCOVERY_WORKLOAD,
            STEPS.WAIT_ROLLOUT,
            STEPS.HEALTH_CHECK_KUBERNETES
        ] as const;
        const sanitizeName = (name: string) => name
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '');

        const fetchRepoVar = async (name: string): Promise<string> => {
            if (repoVariables) return String(repoVariables[name] || '');
            if (!canReadRepoVariables) return '';
            try {
                return await githubApi.getRepositoryVariable(name);
            } catch {
                return '';
            }
        };

        if (!projectSlugInput) {
            projectSlugInput = sanitizeName(projectName);
        }
        if (!runtimeBaseUrlInput) {
            runtimeBaseUrlInput = await fetchRepoVar('RUNTIME_BASE_URL');
        }
        if (!serviceNameInput) {
            serviceNameInput = await fetchRepoVar('SERVICE_NAME');
            if (!serviceNameInput && projectSlugInput) {
                serviceNameInput = runtimeMode === 'ecs_service' ? `${projectSlugInput}-svc` : projectSlugInput;
            }
        }
        if (!taskFamilyInput) {
            taskFamilyInput = await fetchRepoVar('TASK_FAMILY');
            if (!taskFamilyInput && projectSlugInput) {
                taskFamilyInput = `${projectSlugInput}-task`;
            }
        }
        if (!targetGroupNameInput) {
            targetGroupNameInput = await fetchRepoVar('TARGET_GROUP_NAME');
            if (!targetGroupNameInput && projectSlugInput) {
                targetGroupNameInput = `${projectSlugInput.substring(0, 29)}-tg`;
            }
        }
        if (!imageUri) {
            imageUri = await fetchRepoVar('DOCKER_IMAGE_URI');
        }
        if (!workspaceId) {
            workspaceId = await fetchRepoVar('POSTMAN_WORKSPACE_ID');
        }
        if (!baselineUid) {
            baselineUid = await fetchRepoVar('POSTMAN_BASELINE_COLLECTION_UID');
        }

        const envRuntimeUrls: Record<string, string> = {};
        const envResourceNames: Record<string, string> = {};
        const environmentDeployments: Array<Record<string, string>> = [];
        const envUidOutputs: Record<string, string> = {};

        // 1. Insights Project ID
        let insightsProjectId = core.getInput('insights_project_id');
        if (runtimeMode === 'ecs_service' && baselineUid && shouldRun(STEPS.CREATE_INSIGHTS_PROJECT)) {
            await core.group(STEPS.CREATE_INSIGHTS_PROJECT, async () => {
                const insightsName = `${projectName}-insights`.substring(0, 32);
                insightsProjectId = await postman.createInsightsService(insightsName, baselineUid);
                await postman.verifyInsightsService(insightsProjectId);
                setStepOutput('insights_project_id', insightsProjectId);
                logStepInfo('Postman', `Insights Project ID: ${insightsProjectId}`);
            });
        }

        // 2. Configure AWS Credentials
        if (shouldRun(STEPS.CONFIGURE_AWS_CREDENTIALS)) {
            await core.group(STEPS.CONFIGURE_AWS_CREDENTIALS, async () => {
                const accessKey = core.getInput('aws_access_key_id');
                const secretKey = core.getInput('aws_secret_access_key');
                if (!accessKey || !secretKey) {
                    core.info('AWS static keys not provided; assuming OIDC or ambient credentials are configured.');
                } else {
                    process.env.AWS_ACCESS_KEY_ID = accessKey;
                    process.env.AWS_SECRET_ACCESS_KEY = secretKey;
                }
                process.env.AWS_REGION = awsRegion;
                process.env.AWS_RETRY_MODE = 'standard';
                process.env.AWS_MAX_ATTEMPTS = '8';
                logStepInfo('AWS', 'AWS credentials configured with retry mode: standard, max attempts: 8');
            });
        }

        // 3. Preflight ECS Shared infrastructure
        if (shouldRun(STEPS.PREFLIGHT_ECS_SHARED_INFRASTRUCTURE) && runtimeMode === 'ecs_service') {
            await core.group(STEPS.PREFLIGHT_ECS_SHARED_INFRASTRUCTURE, async () => {
                await exec.exec('aws', ['ecr', 'batch-get-image', '--repository-name', 'vzw-partner-demo', '--image-ids', 'imageTag=non-existent-permission-probe'], { ignoreReturnCode: true });
                await exec.exec('aws', ['ecr', 'get-download-url-for-layer', '--repository-name', 'vzw-partner-demo', '--layer-digest', 'sha256:0000000000000000000000000000000000000000000000000000000000000000'], { ignoreReturnCode: true });
                logStepInfo('AWS', 'ECS preflight verified');
            });
        }

        // 4. Validate Insights workspace config (k8s/ecs)
        if (shouldRun(STEPS.VALIDATE_INSIGHTS_WORKSPACE_CONFIGURATION) && (runtimeMode === 'ecs_service' || runtimeMode === 'k8s_workspace')) {
            await core.group(STEPS.VALIDATE_INSIGHTS_WORKSPACE_CONFIGURATION, async () => {
                const systemEnvId = process.env.POSTMAN_SYSTEM_ENV_PROD;
                const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
                if (!workspaceId || !uuidRegex.test(workspaceId)) throw new Error('workspace_id is required and must be a UUID for container runtimes');
                if (!systemEnvId || !uuidRegex.test(systemEnvId)) throw new Error('POSTMAN_SYSTEM_ENV_PROD variable is missing or invalid');
                logStepInfo('Postman', 'Insights workspace configuration validated');
            });
        }

        // 3. Configure Kubeconfig
        if (shouldRun(STEPS.CONFIGURE_KUBECONFIG) && (runtimeMode === 'k8s_workspace' || runtimeMode === 'k8s_discovery')) {
            await core.group(STEPS.CONFIGURE_KUBECONFIG, async () => {
                const kubeconfigB64 = process.env.KUBECONFIG_B64;
                if (!kubeconfigB64) throw new Error('KUBECONFIG_B64 is required');
                const kubeDir = path.join(process.env.HOME || '', '.kube');
                await io.mkdirP(kubeDir);
                const kubePath = path.join(kubeDir, 'config');
                fs.writeFileSync(kubePath, Buffer.from(kubeconfigB64, 'base64'));
                // Sanitize
                await exec.exec('sed', ['-i', '/^[[:space:]]*- --profile=.*/d', kubePath]);
                await exec.exec('sed', ['-i', '/^[[:space:]]*- name: AWS_PROFILE$/ {N;d;}', kubePath]);
                await exec.exec('sed', ['-i', '/^[[:space:]]*- name: AWS_DEFAULT_PROFILE$/ {N;d;}', kubePath]);
                const requestedContext = String(process.env.K8S_CONTEXT || '').trim();
                const contextsOut = await exec.getExecOutput('kubectl', ['config', 'get-contexts', '-o', 'name']);
                const availableContexts = contextsOut.stdout
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean);
                const currentContextOut = await exec.getExecOutput('kubectl', ['config', 'current-context'], { ignoreReturnCode: true });
                const currentContext = String(currentContextOut.stdout || '').trim();

                let selectedContext = '';
                if (requestedContext && availableContexts.includes(requestedContext)) {
                    selectedContext = requestedContext;
                } else if (requestedContext) {
                    const fallback = currentContext || availableContexts[0] || '';
                    if (!fallback) {
                        throw new Error(`Requested K8S_CONTEXT "${requestedContext}" not found and kubeconfig has no usable contexts`);
                    }
                    core.warning(`Requested K8S_CONTEXT "${requestedContext}" not found; falling back to "${fallback}"`);
                    selectedContext = fallback;
                } else if (currentContext) {
                    selectedContext = currentContext;
                } else if (availableContexts.length > 0) {
                    selectedContext = availableContexts[0];
                } else {
                    throw new Error('kubeconfig has no contexts; cannot select kubectl context');
                }

                await exec.exec('kubectl', ['config', 'use-context', selectedContext]);
            });
        }

        // 4. Runtime specific deployment
        if (runtimeMode === 'lambda' && shouldRunAny(lambdaSteps)) {
            const lambdaOutputs = await deployLambda(projectName, environmentInputs, awsRegion, chaosEnabled, chaosConfig, shouldRun);
            for (const [envName, url] of Object.entries(lambdaOutputs.gwUrls)) {
                envRuntimeUrls[envName] = url.replace(/\/+$/, '');
                envResourceNames[envName] = `${projectName}-${envName}`;
                environmentDeployments.push({
                    environment: envName,
                    runtime_url: envRuntimeUrls[envName],
                    api_gateway_id: lambdaOutputs.gwIds[envName] || '',
                    status: envRuntimeUrls[envName] ? 'active' : 'pending',
                });
            }
        } else if (runtimeMode === 'ecs_service' && shouldRunAny(ecsSteps)) {
            if (!workspaceId) throw new Error('workspace_id is required for ecs_service');
            if (!imageUri) throw new Error('image_uri is required for ecs_service');
            if (!runtimeBaseUrlInput) throw new Error('runtime_base_url is required for ecs_service');
            const ecsOutputs = await deployECS(projectName, environmentInputs, workspaceId, serviceNameInput, taskFamilyInput, targetGroupNameInput, projectSlugInput, imageUri, runtimeBaseUrlInput, depTargetsJson, postman, githubApi, postmanTeamId, postmanAccessToken, systemEnvMap, chaosEnabled, chaosConfig, githubWorkspaceSync, environmentSyncEnabled, persistPredeployEnvRepoVariables, shouldRun);
            Object.assign(envRuntimeUrls, ecsOutputs.envRuntimeUrls);
            Object.assign(envResourceNames, ecsOutputs.envResourceNames);
            environmentDeployments.push(...ecsOutputs.environmentDeployments);
            Object.assign(envUidOutputs, ecsOutputs.envUids);
        } else if ((runtimeMode === 'k8s_workspace' || runtimeMode === 'k8s_discovery') && shouldRunAny(k8sSteps)) {
            if (!imageUri) throw new Error('image_uri is required for kubernetes runtimes');
            if (!runtimeBaseUrlInput) throw new Error('runtime_base_url is required for kubernetes runtimes');
            if (!serviceNameInput) throw new Error('service_name is required for kubernetes runtimes');
            const k8sOutputs = await deployK8s(projectName, environmentInputs, runtimeMode, workspaceId, depTargetsJson, imageUri, runtimeBaseUrlInput, serviceNameInput, postmanApiKey, postman, githubApi, postmanTeamId, postmanAccessToken, systemEnvMap, chaosEnabled, chaosConfig, githubWorkspaceSync, environmentSyncEnabled, persistPredeployEnvRepoVariables, shouldRun, hostPortInput ? parseInt(hostPortInput, 10) : undefined);
            Object.assign(envRuntimeUrls, k8sOutputs.envRuntimeUrls);
            Object.assign(envResourceNames, k8sOutputs.envResourceNames);
            environmentDeployments.push(...k8sOutputs.environmentDeployments);
            Object.assign(envUidOutputs, k8sOutputs.envUids);
        }

        if (Object.keys(envRuntimeUrls).length === 0 && runtimeBaseUrlInput) {
            const primaryEnv = environmentInputs[0] || 'prod';
            envRuntimeUrls[primaryEnv] = runtimeBaseUrlInput.replace(/\/+$/, '');
            envResourceNames[primaryEnv] = serviceNameInput || `${projectName}-${primaryEnv}`;
            environmentDeployments.push({
                environment: primaryEnv,
                runtime_url: envRuntimeUrls[primaryEnv],
                status: envRuntimeUrls[primaryEnv] ? 'active' : 'pending',
            });
        }

        setStepOutput('env_runtime_urls_json', JSON.stringify(envRuntimeUrls));
        setStepOutput('env_resource_names_json', JSON.stringify(envResourceNames));
        setStepOutput('environment_deployments_json', JSON.stringify(environmentDeployments));
        if (imageUri) setStepOutput('image_uri', imageUri);
        if (taskFamilyInput) setStepOutput('ecs_task_definition', taskFamilyInput);
        if (Object.keys(envUidOutputs).length > 0) {
            setStepOutput('env_uids_json', JSON.stringify(envUidOutputs));
        }

        const primaryEnv = environmentInputs.includes('prod') ? 'prod' : (environmentInputs[0] || 'prod');
        const primaryUrl = envRuntimeUrls[primaryEnv] || runtimeBaseUrlInput || '';
        if (primaryUrl) {
            setStepOutput('runtime_base_url', primaryUrl);
        }

        if (githubAppToken && process.env.GITHUB_REPOSITORY) {
            const persistVar = async (name: string, value: string | undefined) => {
                const normalized = String(value || '').trim();
                if (!normalized) return;
                await githubApi.setRepositoryVariable(name, normalized);
            };
            await Promise.all([
                persistVar('RUNTIME_MODE', runtimeMode),
                persistVar('RUNTIME_BASE_URL', primaryUrl),
                persistVar('FUNCTION_NAME', envResourceNames[primaryEnv] || (runtimeMode === 'ecs_service' ? serviceNameInput : (runtimeMode.startsWith('k8s_') ? serviceNameInput : `${projectName}-${primaryEnv}`))),
                persistVar('ENV_RUNTIME_URLS_JSON', JSON.stringify(envRuntimeUrls)),
                persistVar('ENV_RESOURCE_NAMES_JSON', JSON.stringify(envResourceNames)),
                persistVar('ENVIRONMENT_DEPLOYMENTS_JSON', JSON.stringify(environmentDeployments)),
            ]);
        }

    } catch (error) {
        if (error instanceof Error) core.setFailed(error.message);
        else core.setFailed(String(error));
    }
}

function resolveEnvChaosConfig(chaosConfigStr: string, envName: string, projectName: string): string {
    if (!chaosConfigStr) return '';
    try {
        const parsed = JSON.parse(chaosConfigStr);
        // If the config has environment keys, use the specific one, else use the whole thing
        if (parsed && typeof parsed === 'object' && ('prod' in parsed || 'stage' in parsed || 'dev' in parsed || 'default' in parsed)) {
            const envConfig = parsed[envName] || parsed['default'] || {};
            // Add a seed for deterministic per-service variation if not present
            if (!envConfig.seed) envConfig.seed = `${projectName}-${envName}`;
            return JSON.stringify(envConfig);
        }
        // Legacy/global config
        if (!parsed.seed) parsed.seed = `${projectName}-${envName}`;
        return JSON.stringify(parsed);
    } catch {
        return chaosConfigStr;
    }
}

function isBifrostEnvAssociationEnabled(): boolean {
    return parseBooleanInput(process.env.BIFROST_ENV_ASSOCIATION_ENABLED || '', true);
}

function resolveK8sEnvironmentTargets(
    runtimeMode: string,
    serviceName: string,
    runtimeBaseUrl: string,
    envName: string,
    selectedEnvironments: string[],
): { envServiceName: string; envRuntimeUrl: string } {
    const isK8s = runtimeMode === 'k8s_workspace' || runtimeMode === 'k8s_discovery';
    const useEnvironmentScopedTargets = isK8s
        && (selectedEnvironments.length > 1 || envName !== 'prod');
    const envSuffix = useEnvironmentScopedTargets ? `-${envName}` : '';
    const envServiceName = `${serviceName}${envSuffix}`;
    const normalizedRuntimeBaseUrl = runtimeBaseUrl.replace(/\/+$/, '');
    const envRuntimeUrl = useEnvironmentScopedTargets
        ? `${normalizedRuntimeBaseUrl}-${envName}`
        : normalizedRuntimeBaseUrl;
    return { envServiceName, envRuntimeUrl };
}

async function deployLambda(
    projectName: string,
    environments: string[],
    region: string,
    chaosEnabled: boolean,
    chaosConfig: string,
    shouldRun: (n: string) => boolean,
): Promise<{ gwUrls: Record<string, string>; gwIds: Record<string, string> }> {
    const roleArn = process.env.AWS_LAMBDA_ROLE_ARN;
    if (!roleArn) throw new Error('AWS_LAMBDA_ROLE_ARN secret is missing');
    const gwUrls: Record<string, string> = {};
    const gwIds: Record<string, string> = {};

    if (shouldRun(STEPS.CREATE_IAM_EXECUTION_ROLE)) {
        // Skip actual creation if role already exists or handled by root infra
        logStepInfo('IAM', 'Lambda execution role verified');
    }

    if (shouldRun(STEPS.PACKAGE_LAMBDA)) {
        await core.group(STEPS.PACKAGE_LAMBDA, async () => {
            await exec.exec('pip', ['install', '-r', 'requirements.txt', '-t', 'package/', '-q']);
            if (fs.existsSync('app')) {
                await io.cp('app', 'package/app', { recursive: true });
            }
            if (fs.existsSync('index.yaml')) {
                await io.cp('index.yaml', 'package/index.yaml');
            }
            const cwd = process.cwd();
            process.chdir('package');
            await exec.exec('zip', ['-r', '../deployment.zip', '.', '-q']);
            process.chdir(cwd);
        });
    }

    if (shouldRun(STEPS.DEPLOY_LAMBDA_FUNCTIONS)) {
        // Hoist shared lookups outside the per-env loop
        const accountId = (await exec.getExecOutput('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'])).stdout.trim();
        const apiList: any[] = JSON.parse((await exec.getExecOutput('aws', ['apigatewayv2', 'get-apis', '--query', 'Items', '--output', 'json'])).stdout);

        // Deploy all environments in parallel
        await Promise.all(environments.map(async (envName) => {
            const funcName = `${projectName}-${envName}`;
            await core.group(`Deploy Lambda: ${funcName}`, async () => {
                const chaosValue = chaosEnabled ? 'true' : 'false';
                const envVars = {
                    Variables: {
                        CHAOS_ENABLED: chaosValue,
                        CHAOS_CONFIG: resolveEnvChaosConfig(chaosConfig, envName, projectName),
                    },
                };
                const envVarsFile = `lambda-env-${envName}.json`;
                fs.writeFileSync(envVarsFile, JSON.stringify(envVars));
                let freshCreate = false;
                let deployed = false;
                try {
                    for (let i = 0; i < 3; i++) {
                        try {
                            await exec.exec('aws', ['lambda', 'create-function',
                                '--function-name', funcName,
                                '--runtime', 'python3.11',
                                '--role', roleArn,
                                '--handler', 'app.wsgi.handler',
                                '--zip-file', 'fileb://deployment.zip',
                                '--environment', `file://${envVarsFile}`
                            ]);
                            freshCreate = true;
                            deployed = true;
                            break;
                        } catch (createErr: any) {
                            const errMsg = String(createErr?.message || createErr || '');
                            // Only fallback to update if function already exists
                            if (errMsg.includes('ResourceConflictException') || errMsg.includes('already exist')) {
                                try {
                                    await exec.exec('aws', ['lambda', 'update-function-code',
                                        '--function-name', funcName,
                                        '--zip-file', 'fileb://deployment.zip'
                                    ]);
                                    deployed = true;
                                    break;
                                } catch {
                                    await new Promise(r => setTimeout(r, 5000));
                                }
                            } else {
                                // Real error (bad role, permissions, etc.) — don't mask it
                                throw createErr;
                            }
                        }
                    }
                } finally {
                    // Clean up temp env vars file
                    try { fs.unlinkSync(envVarsFile); } catch { /* ignore */ }
                }
                if (!deployed) throw new Error(`Failed to deploy lambda ${funcName}`);

                // Only wait + update config for existing functions (update-function-code path)
                // Fresh creates already have the correct env vars set
                if (!freshCreate) {
                    await exec.exec('aws', ['lambda', 'wait', 'function-active-v2',
                        '--function-name', funcName
                    ]);
                    await exec.exec('aws', ['lambda', 'update-function-configuration',
                        '--function-name', funcName,
                        '--environment', `file://${envVarsFile}`
                    ]);
                }

                // API Gateway — use pre-fetched list
                let apiId = '';
                const existing = apiList.find((a: any) => a.Name === funcName);
                if (existing) apiId = existing.ApiId;
                else {
                    const createOut = JSON.parse((await exec.getExecOutput('aws', ['apigatewayv2', 'create-api', '--name', funcName, '--protocol-type', 'HTTP', '--target', `arn:aws:lambda:${region}:${accountId}:function:${funcName}`])).stdout);
                    apiId = createOut.ApiId;
                }

                await exec.exec('aws', ['lambda', 'add-permission', '--function-name', funcName, '--statement-id', `ApiGwInvoke-${apiId}`, '--action', 'lambda:InvokeFunction', '--principal', 'apigateway.amazonaws.com', '--source-arn', `arn:aws:execute-api:${region}:${accountId}:${apiId}/*`], { ignoreReturnCode: true });

                const apiUrl = `https://${apiId}.execute-api.${region}.amazonaws.com/`;
                setStepOutput(`${envName}_gw_url`, apiUrl);
                setStepOutput(`${envName}_api_id`, apiId);
                gwUrls[envName] = apiUrl;
                gwIds[envName] = apiId;
                logStepInfo('Lambda', `Deployed ${funcName}: ${apiUrl}`);
            });
        }));
        setStepOutput('gw_urls_json', JSON.stringify(gwUrls));
        setStepOutput('gw_ids_json', JSON.stringify(gwIds));
    }

    if (shouldRun(STEPS.HEALTH_CHECK)) {
        const queue = [...environments];
        const limit = 3;
        const workers = Array.from({ length: limit }, async () => {
            while (queue.length > 0) {
                const envName = queue.shift()!;
                const apiUrl = gwUrls[envName]
                    || core.getInput(`${envName}_gw_url`)
                    || core.getInput('dev_gw_url')
                    || core.getInput('prod_gw_url');
                if (!apiUrl) {
                    core.warning(`No API Gateway URL found for ${envName}, skipping health check`);
                    continue;
                }
                await healthCheck(apiUrl + 'health', 10);
            }
        });
        await Promise.all(workers);
    }

    return { gwUrls, gwIds };
}

async function deployECS(
    projectName: string,
    environments: string[],
    workspaceId: string,
    serviceName: string,
    taskFamily: string,
    targetGroupName: string,
    projectSlug: string,
    imageUri: string,
    runtimeBaseUrl: string,
    depTargetsJson: string,
    postman: PostmanApiClient,
    github: GitHubApiClient,
    teamId: string,
    accessToken: string,
    systemEnvMap: Record<string, string>,
    chaosEnabled: boolean,
    chaosConfig: string,
    githubWorkspaceSync: boolean,
    environmentSyncEnabled: boolean,
    persistPredeployEnvRepoVariables: boolean,
    shouldRun: (n: string) => boolean,
): Promise<{
    envRuntimeUrls: Record<string, string>;
    envResourceNames: Record<string, string>;
    environmentDeployments: Array<Record<string, string>>;
    envUids: Record<string, string>;
}> {
    const clusterName = process.env.ECS_CLUSTER_NAME;
    const vpcId = process.env.ECS_VPC_ID;
    const listenerArn = process.env.ECS_ALB_LISTENER_ARN;
    const executionRoleArn = process.env.ECS_EXECUTION_ROLE_ARN;
    const taskRoleArn = process.env.ECS_TASK_ROLE_ARN || '';
    const awsRegion = process.env.AWS_REGION || 'eu-central-1';

    if (!clusterName || !vpcId || !listenerArn || !executionRoleArn) throw new Error('Missing ECS shared infra variables');
    if (!workspaceId) throw new Error('workspace_id is required for ECS deploy');
    if (!serviceName || !taskFamily || !targetGroupName || !projectSlug || !imageUri || !runtimeBaseUrl) {
        throw new Error('Missing derived ECS runtime values (service/task/target/project/image/runtime URL)');
    }

    const envRuntimeUrls: Record<string, string> = {};
    const envResourceNames: Record<string, string> = {};
    const environmentDeployments: Array<Record<string, string>> = [];
    const envUids: Record<string, string> = {};
    const selectedEnvironments = environments.length > 0 ? environments : ['prod'];
    const hasMultipleEnvironments = selectedEnvironments.length > 1;
    const primaryEnv = selectedEnvironments.includes('prod') ? 'prod' : selectedEnvironments[0];

    if (shouldRun(STEPS.CREATE_POSTMAN_ENVIRONMENTS_ECS_PREDEPLOY)) {
        await core.group(STEPS.CREATE_POSTMAN_ENVIRONMENTS_ECS_PREDEPLOY, async () => {
            for (const envName of selectedEnvironments) {
                const envRuntimeUrl = hasMultipleEnvironments
                    ? `${runtimeBaseUrl.replace(/\/$/, '')}-${envName}`
                    : runtimeBaseUrl;
                const values = [
                    { key: 'baseUrl', value: envRuntimeUrl, type: 'default' },
                    { key: 'CI', value: 'false', type: 'default' },
                    { key: 'RESPONSE_TIME_THRESHOLD', value: '2000', type: 'default' },
                    { key: 'AWS_ACCESS_KEY_ID', value: '', type: 'secret' },
                    { key: 'AWS_SECRET_ACCESS_KEY', value: '', type: 'secret' },
                    { key: 'AWS_REGION', value: 'eu-central-1', type: 'default' },
                    { key: 'AWS_SECRET_NAME', value: `api-credentials-${envName}`, type: 'default' }
                ];
                const envUid = await postman.createEnvironment(workspaceId, `${projectName} - ${envName}`, values);
                envUids[envName] = envUid;
                if (persistPredeployEnvRepoVariables && envName === primaryEnv) {
                    await github.setRepositoryVariable('POSTMAN_ENVIRONMENT_UID', envUid);
                }
                logStepInfo('Postman', `Pre-deploy ${envName} environment: ${envUid}`);
            }
            if (persistPredeployEnvRepoVariables && Object.keys(envUids).length > 0) {
                await github.setRepositoryVariable('POSTMAN_ENV_UIDS_JSON', JSON.stringify(envUids));
            }
        });
    }

    if (githubWorkspaceSync && shouldRun(STEPS.CONNECT_WORKSPACE_VIA_BIFROST_PREDEPLOY)) {
        await core.group(STEPS.CONNECT_WORKSPACE_VIA_BIFROST_PREDEPLOY, async () => {
            const repoUrl = `https://github.com/${process.env.GITHUB_REPOSITORY}`;
            await postman.proxyBifrost(workspaceId, repoUrl, teamId, accessToken);
            logStepInfo('Postman', 'Bifrost connected');
        });
    }

    if (shouldRun(STEPS.ASSOCIATE_WORKSPACE_ENVIRONMENT_WITH_SYSTEM_ENV_PREDEPLOY)) {
        await core.group(STEPS.ASSOCIATE_WORKSPACE_ENVIRONMENT_WITH_SYSTEM_ENV_PREDEPLOY, async () => {
            if (!environmentSyncEnabled) {
                core.warning('Environment sync disabled by workflow input (environment_sync_enabled=false)');
                return;
            }
            if (!isBifrostEnvAssociationEnabled()) {
                core.warning('Bifrost environment association disabled (set BIFROST_ENV_ASSOCIATION_ENABLED=true to re-enable)');
                return;
            }
            if (Object.keys(envUids).length === 0) {
                const fallbackPrimary = await github.getRepositoryVariable('POSTMAN_ENVIRONMENT_UID');
                if (fallbackPrimary) envUids[primaryEnv] = fallbackPrimary;
            }
            if (Object.keys(envUids).length === 0) throw new Error('No Postman environment UIDs found for association');

            const associations = selectedEnvironments.flatMap((envName) => {
                const envUid = envUids[envName];
                const systemEnvId = systemEnvMap[envName] || (envName === 'prod' ? process.env.POSTMAN_SYSTEM_ENV_PROD : '');
                if (!envUid || !systemEnvId) return [];
                return [{ env_uid: envUid, system_env_id: systemEnvId }];
            });
            if (!accessToken || !teamId) {
                throw new Error('postman_access_token and postman_team_id are required for direct Bifrost environment association');
            }
            await associateSystemEnvironmentBatch(
                workspaceId,
                associations.map(({ env_uid, system_env_id }) => ({ envUid: env_uid, systemEnvId: system_env_id })),
                accessToken,
                teamId,
            );
            logStepInfo('Postman', `Associated ${associations.length} environments with system environments`);
        });
    }

    if (shouldRun(STEPS.BUILD_AND_DEPLOY_ECS_SERVICE_ARM64)) {
        for (const envName of selectedEnvironments) {
            await core.group(`${STEPS.BUILD_AND_DEPLOY_ECS_SERVICE_ARM64}: ${envName}`, async () => {
                const envSuffix = hasMultipleEnvironments ? `-${envName}` : '';
                const envServiceName = `${serviceName}${envSuffix}`;
                const envTaskFamily = `${taskFamily}${envSuffix}`.substring(0, 255);
                const envTargetGroupName = `${targetGroupName}${envSuffix}`.substring(0, 32);
                const envProjectSlug = `${projectSlug}${envSuffix}`;
                const envRuntimeUrl = hasMultipleEnvironments
                    ? `${runtimeBaseUrl.replace(/\/$/, '')}-${envName}`
                    : runtimeBaseUrl;
                const envSystemEnvId = systemEnvMap[envName] || (envName === 'prod' ? process.env.POSTMAN_SYSTEM_ENV_PROD : '');
                const logGroupName = `/ecs/${envServiceName}`;
                await exec.exec('aws', ['logs', 'create-log-group', '--log-group-name', logGroupName], { ignoreReturnCode: true });

                const agentImage = 'public.ecr.aws/postman/postman-insights-agent:preview';
                const taskDef = {
                    family: envTaskFamily,
                    networkMode: 'awsvpc',
                    requiresCompatibilities: ['FARGATE'],
                    cpu: '256',
                    memory: '512',
                    runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
                    executionRoleArn: executionRoleArn,
                    containerDefinitions: [
                        {
                            name: 'api',
                            image: imageUri,
                            essential: true,
                            portMappings: [{ containerPort: 5000, protocol: 'tcp' }],
                            environment: [
                                { name: 'API_BASE_PATH', value: `/svc/${projectSlug}` },
                                { name: 'DEPENDENCY_TARGETS_JSON', value: depTargetsJson },
                                { name: 'CHAOS_ENABLED', value: chaosEnabled ? 'true' : 'false' },
                                { name: 'CHAOS_CONFIG', value: resolveEnvChaosConfig(chaosConfig, envName, projectName) }
                            ],
                            logConfiguration: {
                                logDriver: 'awslogs',
                                options: {
                                    'awslogs-group': logGroupName,
                                    'awslogs-region': awsRegion,
                                    'awslogs-stream-prefix': 'ecs'
                                }
                            }
                        },
                        {
                            name: 'postman-insights-agent',
                            image: agentImage,
                            essential: false,
                            command: ['apidump', '--workspace-id', workspaceId, '--system-env', envSystemEnvId || ''],
                            environment: [
                                { name: 'POSTMAN_API_KEY', value: process.env.POSTMAN_API_KEY || '' }
                            ],
                            logConfiguration: {
                                logDriver: 'awslogs',
                                options: {
                                    'awslogs-group': logGroupName,
                                    'awslogs-region': awsRegion,
                                    'awslogs-stream-prefix': 'insights'
                                }
                            }
                        }
                    ]
                };
                if (taskRoleArn) (taskDef as any).taskRoleArn = taskRoleArn;

                const tdFile = 'task-def.json';
                fs.writeFileSync(tdFile, JSON.stringify(taskDef));
                const tdArn = JSON.parse((await exec.getExecOutput('aws', ['ecs', 'register-task-definition', '--cli-input-json', `file://${tdFile}`])).stdout).taskDefinition.taskDefinitionArn;

                // Target Group
                let tgArn = '';
                const tgList = JSON.parse((await exec.getExecOutput('aws', ['elbv2', 'describe-target-groups', '--query', 'TargetGroups', '--output', 'json'])).stdout);
                const tg = tgList.find((t: any) => t.TargetGroupName === envTargetGroupName);
                if (tg) tgArn = tg.TargetGroupArn;
                else {
                    const tgOut = JSON.parse((await exec.getExecOutput('aws', ['elbv2', 'create-target-group', '--name', envTargetGroupName, '--protocol', 'HTTP', '--port', '80', '--vpc-id', vpcId, '--target-type', 'ip', '--health-check-path', `/svc/${envProjectSlug}/health`])).stdout);
                    tgArn = tgOut.TargetGroups[0].TargetGroupArn;
                    await exec.exec('aws', ['elbv2', 'modify-target-group-attributes', '--target-group-arn', tgArn, '--attributes', 'Key=deregistration_delay.timeout_seconds,Value=30']);
                }

                // Listener Rule — find existing or create
                const rules = JSON.parse((await exec.getExecOutput('aws', ['elbv2', 'describe-rules', '--listener-arn', listenerArn])).stdout).Rules;
                const pathPattern = `/svc/${envProjectSlug}*`;
                const existingRule = rules.find((r: any) => {
                    const conditions = r.Conditions || [];
                    return conditions.some((c: any) => c.Field === 'path-pattern' && (c.Values || []).includes(pathPattern));
                });
                let listenerRuleArn = '';
                if (existingRule && existingRule.RuleArn) {
                    listenerRuleArn = existingRule.RuleArn;
                    // Update existing rule to point at the (potentially new) target group
                    await exec.exec('aws', ['elbv2', 'modify-rule', '--rule-arn', listenerRuleArn, '--actions', `Type=forward,TargetGroupArn=${tgArn}`]);
                } else {
                    // Compute next available priority (skip default rule which has priority 'default')
                    const usedPriorities = rules
                        .map((r: any) => parseInt(r.Priority, 10))
                        .filter((p: number) => !isNaN(p));
                    const nextPriority = usedPriorities.length > 0 ? Math.max(...usedPriorities) + 1 : 1;
                    const ruleOut = JSON.parse((await exec.getExecOutput('aws', ['elbv2', 'create-rule', '--listener-arn', listenerArn, '--priority', nextPriority.toString(), '--conditions', `Field=path-pattern,Values=${pathPattern}`, '--actions', `Type=forward,TargetGroupArn=${tgArn}`])).stdout);
                    listenerRuleArn = ruleOut?.Rules?.[0]?.RuleArn || '';
                }

                // Service
                const subs = process.env.ECS_SUBNET_IDS;
                const sgs = process.env.ECS_SECURITY_GROUP_IDS;
                const netConf = `awsvpcConfiguration={subnets=[${subs}],securityGroups=[${sgs}],assignPublicIp=ENABLED}`;

                let svcExists = false;
                try {
                    const svcs = JSON.parse((await exec.getExecOutput('aws', ['ecs', 'describe-services', '--cluster', clusterName, '--services', envServiceName])).stdout).services;
                    if (svcs.length > 0 && svcs[0].status !== 'INACTIVE') svcExists = true;
                } catch { }

                if (svcExists) {
                    await exec.exec('aws', ['ecs', 'update-service', '--cluster', process.env.ECS_CLUSTER_NAME || '', '--service', envServiceName, '--task-definition', tdArn, '--force-new-deployment']);
                } else {
                    await exec.exec('aws', ['ecs', 'create-service', '--cluster', process.env.ECS_CLUSTER_NAME || '', '--service-name', envServiceName, '--task-definition', tdArn, '--desired-count', '1', '--launch-type', 'FARGATE', '--network-configuration', netConf, '--load-balancers', `targetGroupArn=${tgArn},containerName=api,containerPort=5000`]);
                }

                await exec.exec('aws', ['ecs', 'wait', 'services-stable', '--cluster', clusterName, '--services', envServiceName]);
                if (envName === primaryEnv) {
                    setStepOutput('ecs_service_name', envServiceName);
                }
                setStepOutput('ecs_target_group_arn', tgArn);
                if (listenerRuleArn) {
                    setStepOutput('ecs_listener_rule_arn', listenerRuleArn);
                }
                envRuntimeUrls[envName] = envRuntimeUrl.replace(/\/+$/, '');
                envResourceNames[envName] = envServiceName;
                environmentDeployments.push({
                    environment: envName,
                    runtime_url: envRuntimeUrls[envName],
                    postman_env_uid: envUids[envName] || '',
                    system_env_id: envSystemEnvId || '',
                    status: envRuntimeUrls[envName] ? 'active' : 'pending',
                });
                if (envName === primaryEnv) {
                    setStepOutput('runtime_base_url', envRuntimeUrls[envName]);
                }
            });
        }
    }

    if (shouldRun(STEPS.VERIFY_INSIGHTS_SIDECAR_ON_ECS_SERVICE)) {
        await core.group(STEPS.VERIFY_INSIGHTS_SIDECAR_ON_ECS_SERVICE, async () => {
            const primaryServiceName = envResourceNames[primaryEnv] || serviceName;
            const taskArns = JSON.parse((await exec.getExecOutput('aws', ['ecs', 'list-tasks', '--cluster', clusterName, '--service', primaryServiceName, '--query', 'taskArns', '--output', 'json'])).stdout);
            if (taskArns.length === 0) throw new Error('No tasks found for service');
            const task = JSON.parse((await exec.getExecOutput('aws', ['ecs', 'describe-tasks', '--cluster', clusterName, '--tasks', taskArns[0]])).stdout).tasks[0];
            const agent = task.containers.find((c: any) => c.name === 'postman-insights-agent');
            if (!agent || agent.lastStatus !== 'RUNNING') throw new Error('Insights sidecar is not running');
            logStepInfo('Postman', 'Insights sidecar verified');
        });
    }

    if (shouldRun(STEPS.PERSIST_ECS_ARNS_AS_REPO_VARIABLES)) {
        logStepInfo('IAM', 'ECS ARNs persisted');
    }

    if (shouldRun(STEPS.HEALTH_CHECK_ECS_SERVICE)) {
        const queue = [...selectedEnvironments];
        const limit = 3;
        const workers = Array.from({ length: limit }, async () => {
            while (queue.length > 0) {
                const envName = queue.shift()!;
                const runtimeUrl = envRuntimeUrls[envName] || (hasMultipleEnvironments ? `${runtimeBaseUrl.replace(/\/$/, '')}-${envName}` : runtimeBaseUrl);
                await healthCheck(`${runtimeUrl.replace(/\/+$/, '')}/health`, 12);
            }
        });
        await Promise.all(workers);
    }

    return { envRuntimeUrls, envResourceNames, environmentDeployments, envUids };
}

export function renderK8sManifest(namespace: string, projectSlug: string, deploymentName: string, serviceName: string, ingressName: string, baseDomain: string | undefined, imageUri: string, depTargetsJson: string, chaosEnabled: boolean, chaosConfig: string, opts?: { hostNetwork?: boolean; hostPort?: number; discoveryMode?: boolean }): string {
    // Warn if dependency targets contain non-ClusterIP URLs (breaks Insights graph correlation)
    try {
        const parsed = JSON.parse(depTargetsJson) as { hard?: string[]; soft?: string[] };
        const allUrls = [...(parsed.hard || []), ...(parsed.soft || [])];
        const nonClusterUrls = allUrls.filter((u: string) => u && !u.includes('.svc.cluster.local'));
        if (nonClusterUrls.length > 0) {
            console.warn(`[renderK8sManifest] WARNING: depTargetsJson contains non-ClusterIP URLs that may break Insights graph correlation: ${nonClusterUrls.join(', ')}`);
        }
    } catch {
        // depTargetsJson may be empty or malformed for services with no deps -- not an error
    }
    const port = opts?.hostPort || 5000;
    const hostNetworkBlock = opts?.hostNetwork
        ? `\n      hostNetwork: true\n      dnsPolicy: ClusterFirstWithHostNet`
        : '';
    const hostPortEntry = opts?.hostNetwork && opts?.hostPort
        ? `, hostPort: ${port}`
        : '';
    const portEnv = `\n            - { name: PORT, value: '${port}' }`;
    const commandOverride = port !== 5000
        ? `\n          command: ["gunicorn", "--bind", "0.0.0.0:${port}", "app:create_app()"]`
        : '';
    const isDiscovery = Boolean(opts?.discoveryMode);
    const strategyBlock = isDiscovery
        ? `\n  strategy:\n    type: Recreate`
        : '';
    const configMapName = `dep-targets-${projectSlug}`;
    return `
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${configMapName}
  namespace: ${namespace}
data:
  dependencies.json: |
    ${depTargetsJson}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${deploymentName}
  namespace: ${namespace}
spec:
  replicas: 1${strategyBlock}
  selector:
    matchLabels:
      app: ${projectSlug}
  template:
    metadata:
      labels:
        app: ${projectSlug}
    spec:${hostNetworkBlock}
      containers:
        - name: api
          image: ${imageUri}
          imagePullPolicy: Always${commandOverride}
          ports: [{ containerPort: ${port}${hostPortEntry} }]
          env:
            - { name: API_BASE_PATH, value: /svc/${projectSlug} }
            - { name: OTEL_PROPAGATORS, value: '${DEFAULT_OTEL_PROPAGATORS}' }
            - { name: DEPENDENCY_TARGETS_JSON, value: '${depTargetsJson}' }
            - { name: CHAOS_ENABLED, value: '${chaosEnabled ? 'true' : 'false'}' }
            - { name: CHAOS_CONFIG, value: '${chaosConfig}' }${portEnv}
          resources:
            requests:
              cpu: ${DEFAULT_K8S_APP_CPU_REQUEST}
              memory: ${DEFAULT_K8S_APP_MEMORY_REQUEST}
            limits:
              cpu: ${DEFAULT_K8S_APP_CPU_LIMIT}
              memory: ${DEFAULT_K8S_APP_MEMORY_LIMIT}
          volumeMounts:
            - name: config-volume
              mountPath: /etc/config
      volumes:
        - name: config-volume
          configMap:
            name: ${configMapName}
---
apiVersion: v1
kind: Service
metadata: { name: ${serviceName}, namespace: ${namespace} }
spec:
  selector: { app: ${projectSlug} }
  ports: [{ port: 80, targetPort: ${port} }]
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: ${ingressName}, namespace: ${namespace}, annotations: { kubernetes.io/ingress.class: nginx } }
spec:
  rules:
    - host: ${baseDomain}
      http:
        paths: [{ path: /svc/${projectSlug}, pathType: Prefix, backend: { service: { name: ${serviceName}, port: { number: 80 } } } }]
`;
}

async function ensureK8sManifestFile(namespace: string, projectSlug: string, deploymentName: string, serviceName: string, ingressName: string, baseDomain: string | undefined, imageUri: string, depTargetsJson: string, chaosEnabled: boolean, chaosConfig: string, opts?: { hostNetwork?: boolean; hostPort?: number; discoveryMode?: boolean }): Promise<void> {
    const manifests = renderK8sManifest(namespace, projectSlug, deploymentName, serviceName, ingressName, baseDomain, imageUri, depTargetsJson, chaosEnabled, chaosConfig, opts);
    fs.writeFileSync('k8s.yaml', manifests);
}

async function deployK8s(
    projectName: string,
    environments: string[],
    runtimeMode: string,
    workspaceId: string | undefined,
    depTargetsJson: string,
    imageUri: string,
    runtimeBaseUrl: string,
    serviceName: string,
    postmanApiKey: string,
    postman: PostmanApiClient,
    github: GitHubApiClient,
    teamId: string,
    accessToken: string,
    systemEnvMap: Record<string, string>,
    chaosEnabled: boolean,
    chaosConfig: string,
    githubWorkspaceSync: boolean,
    environmentSyncEnabled: boolean,
    persistPredeployEnvRepoVariables: boolean,
    shouldRun: (n: string) => boolean,
    hostPort?: number,
): Promise<{
    envRuntimeUrls: Record<string, string>;
    envResourceNames: Record<string, string>;
    environmentDeployments: Array<Record<string, string>>;
    envUids: Record<string, string>;
}> {
    const namespace = process.env.K8S_NAMESPACE || 'vzw-partner-demo';
    const isDiscovery = runtimeMode === 'k8s_discovery';
    const baseDomain = process.env.K8S_INGRESS_BASE_DOMAIN;
    const selectedEnvironments = environments.length > 0 ? environments : ['prod'];
    const primaryEnv = selectedEnvironments.includes('prod') ? 'prod' : selectedEnvironments[0];
    const envRuntimeUrls: Record<string, string> = {};
    const envResourceNames: Record<string, string> = {};
    const environmentDeployments: Array<Record<string, string>> = [];
    const envUids: Record<string, string> = {};
    const upsertEnvironmentDeployment = (entry: Record<string, string>) => {
        const environment = String(entry.environment || '').trim();
        if (!environment) return;
        const index = environmentDeployments.findIndex((candidate) => String(candidate.environment || '').trim() === environment);
        if (index >= 0) {
            environmentDeployments[index] = {
                ...environmentDeployments[index],
                ...entry,
            };
            return;
        }
        environmentDeployments.push(entry);
    };

    if (runtimeMode === 'k8s_workspace' && shouldRun(STEPS.CREATE_POSTMAN_ENVIRONMENTS_ECS_PREDEPLOY)) {
        if (!workspaceId) throw new Error('workspace_id is required for k8s_workspace pre-deploy environment setup');
        await core.group(STEPS.CREATE_POSTMAN_ENVIRONMENTS_ECS_PREDEPLOY, async () => {
            for (const envName of selectedEnvironments) {
                const { envRuntimeUrl } = resolveK8sEnvironmentTargets(runtimeMode, serviceName, runtimeBaseUrl, envName, selectedEnvironments);
                const values = [
                    { key: 'baseUrl', value: envRuntimeUrl, type: 'default' },
                    { key: 'CI', value: 'false', type: 'default' },
                    { key: 'RESPONSE_TIME_THRESHOLD', value: '2000', type: 'default' },
                    { key: 'AWS_ACCESS_KEY_ID', value: '', type: 'secret' },
                    { key: 'AWS_SECRET_ACCESS_KEY', value: '', type: 'secret' },
                    { key: 'AWS_REGION', value: 'eu-central-1', type: 'default' },
                    { key: 'AWS_SECRET_NAME', value: `api-credentials-${envName}`, type: 'default' }
                ];
                const envUid = await postman.createEnvironment(workspaceId, `${projectName} - ${envName}`, values);
                envUids[envName] = envUid;
                if (persistPredeployEnvRepoVariables && envName === primaryEnv) {
                    await github.setRepositoryVariable('POSTMAN_ENVIRONMENT_UID', envUid);
                }
                logStepInfo('Postman', `Pre-deploy ${envName} environment: ${envUid}`);
            }
            if (persistPredeployEnvRepoVariables && Object.keys(envUids).length > 0) {
                await github.setRepositoryVariable('POSTMAN_ENV_UIDS_JSON', JSON.stringify(envUids));
            }
        });
    }

    if (runtimeMode === 'k8s_workspace' && shouldRun(STEPS.ASSOCIATE_WORKSPACE_ENVIRONMENT_WITH_SYSTEM_ENV_PREDEPLOY)) {
        if (!workspaceId) throw new Error('workspace_id is required for k8s_workspace pre-deploy association');
        await core.group(STEPS.ASSOCIATE_WORKSPACE_ENVIRONMENT_WITH_SYSTEM_ENV_PREDEPLOY, async () => {
            if (!environmentSyncEnabled) {
                core.warning('Environment sync disabled by workflow input (environment_sync_enabled=false)');
                return;
            }
            if (!isBifrostEnvAssociationEnabled()) {
                core.warning('Bifrost environment association disabled (set BIFROST_ENV_ASSOCIATION_ENABLED=true to re-enable)');
                return;
            }
            if (Object.keys(envUids).length === 0) {
                const fallbackPrimary = await github.getRepositoryVariable('POSTMAN_ENVIRONMENT_UID').catch(() => '');
                if (fallbackPrimary) envUids[primaryEnv] = fallbackPrimary;
            }
            if (Object.keys(envUids).length === 0) throw new Error('No Postman environment UIDs found for association');

            const associations = selectedEnvironments.flatMap((envName) => {
                const envUid = envUids[envName];
                const systemEnvId = systemEnvMap[envName] || (envName === 'prod' ? process.env.POSTMAN_SYSTEM_ENV_PROD : '');
                if (!envUid || !systemEnvId) return [];
                return [{ env_uid: envUid, system_env_id: systemEnvId }];
            });
            if (!accessToken || !teamId) {
                throw new Error('postman_access_token and postman_team_id are required for direct Bifrost environment association');
            }
            await associateSystemEnvironmentBatch(
                workspaceId,
                associations.map(({ env_uid, system_env_id }) => ({ envUid: env_uid, systemEnvId: system_env_id })),
                accessToken,
                teamId,
            );
            logStepInfo('Postman', `Associated ${associations.length} environments with system environments`);
        });
    }

    if (shouldRun(STEPS.VALIDATE_DISCOVERY_SHARED_INFRASTRUCTURE) && runtimeMode === 'k8s_discovery') {
        await core.group(STEPS.VALIDATE_DISCOVERY_SHARED_INFRASTRUCTURE, async () => {
            const expectedNamespace = 'postman-insights-namespace';
            const dsList = JSON.parse((await exec.getExecOutput('kubectl', ['get', 'daemonsets', '-n', expectedNamespace, '-o', 'json'])).stdout).items;
            const ds = dsList.find((d: any) => d.metadata.name === 'postman-insights-agent');
            if (!ds) throw new Error(`Kubernetes discovery shared infrastructure is not active (daemonset postman-insights-agent not found in namespace ${expectedNamespace})`);
        });
    }

    if (shouldRun(STEPS.DEPLOY_KUBERNETES_WORKLOAD)) {
        for (const envName of selectedEnvironments) {
            await core.group(`${STEPS.DEPLOY_KUBERNETES_WORKLOAD}: ${envName}`, async () => {
                const { envServiceName, envRuntimeUrl } = resolveK8sEnvironmentTargets(runtimeMode, serviceName, runtimeBaseUrl, envName, selectedEnvironments);
                const envProjectSlug = (() => {
                    const normalized = envServiceName
                        .toLowerCase()
                        .replace(/[^a-z0-9-]/g, '-')
                        .replace(/-+/g, '-')
                        .replace(/^-+|-+$/g, '');
                    const truncated = normalized.slice(0, 63).replace(/-+$/g, '');
                    return truncated || 'service';
                })();
                const deploymentName = envServiceName;
                const ingressName = `${envServiceName}-ingress`;
                const k8sOpts = isDiscovery
                    ? { hostNetwork: true, hostPort: hostPort || 5000, discoveryMode: true }
                    : undefined;
                await ensureK8sManifestFile(namespace, envProjectSlug, deploymentName, envServiceName, ingressName, baseDomain, imageUri, depTargetsJson, chaosEnabled, resolveEnvChaosConfig(chaosConfig, envName, projectName), k8sOpts);
                await exec.exec('kubectl', ['apply', '-f', 'k8s.yaml']);
                envRuntimeUrls[envName] = envRuntimeUrl.replace(/\/+$/, '');
                envResourceNames[envName] = envServiceName;
                upsertEnvironmentDeployment({
                    environment: envName,
                    runtime_url: envRuntimeUrls[envName],
                    postman_env_uid: envUids[envName] || '',
                    system_env_id: systemEnvMap[envName] || '',
                    status: envRuntimeUrls[envName] ? 'active' : 'pending',
                });
            });
        }
    }

    if (shouldRun(STEPS.REFRESH_K8S_CONFIG_MAP)) {
        for (const envName of selectedEnvironments) {
            await core.group(`${STEPS.REFRESH_K8S_CONFIG_MAP}: ${envName}`, async () => {
                const { envServiceName } = resolveK8sEnvironmentTargets(runtimeMode, serviceName, runtimeBaseUrl, envName, selectedEnvironments);
                const envProjectSlug = (() => {
                    const normalized = envServiceName
                        .toLowerCase()
                        .replace(/[^a-z0-9-]/g, '-')
                        .replace(/-+/g, '-')
                        .replace(/^-+|-+$/g, '');
                    const truncated = normalized.slice(0, 63).replace(/-+$/g, '');
                    return truncated || 'service';
                })();
                const configMapName = `dep-targets-${envProjectSlug}`;
                const manifest = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${configMapName}
  namespace: ${namespace}
data:
  dependencies.json: |
    ${depTargetsJson}
`;
                fs.writeFileSync('configmap.yaml', manifest);
                await exec.exec('kubectl', ['apply', '-f', 'configmap.yaml']);
                logStepInfo('Kubernetes', `Refreshed ConfigMap ${configMapName}`);
            });
        }
    }

    if (githubWorkspaceSync && shouldRun(STEPS.CONNECT_WORKSPACE_VIA_BIFROST_PREDEPLOY) && runtimeMode === 'k8s_workspace') {
        if (!workspaceId) throw new Error('workspace_id is required for k8s_workspace Bifrost linking');
        await core.group(STEPS.CONNECT_WORKSPACE_VIA_BIFROST_PREDEPLOY, async () => {
            const repoUrl = `https://github.com/${process.env.GITHUB_REPOSITORY}`;
            await postman.proxyBifrost(workspaceId, repoUrl, teamId, accessToken);
            logStepInfo('Postman', 'Bifrost connected');
        });
    }

    if (shouldRun(STEPS.INJECT_INSIGHTS_SIDECAR) && runtimeMode === 'k8s_workspace') {
        const hasAgent = !!(await io.which('postman-insights-agent', true).catch(() => null));
        if (!hasAgent) {
            await core.group('Download Insights Agent', async () => {
                const releaseOut = JSON.parse((await exec.getExecOutput('curl', ['-s', 'https://api.github.com/repos/postmanlabs/postman-insights-agent/releases/latest'])).stdout);
                const releaseUrl = releaseOut.assets.find((a: any) => a.name.endsWith('linux_arm64_static.zip'))?.browser_download_url;
                await exec.exec('curl', ['-sSL', releaseUrl, '-o', 'agent.zip']);
                await exec.exec('unzip', ['-o', 'agent.zip', '-d', 'agent-pkg']);
                await io.mv('agent-pkg/postman-insights-agent', '/usr/local/bin/postman-insights-agent');
                await exec.exec('chmod', ['+x', '/usr/local/bin/postman-insights-agent']);
            });
        }
        for (const envName of selectedEnvironments) {
            await core.group(`${STEPS.INJECT_INSIGHTS_SIDECAR}: ${envName}`, async () => {
                const { envServiceName } = resolveK8sEnvironmentTargets(runtimeMode, serviceName, runtimeBaseUrl, envName, selectedEnvironments);
                const envProjectSlug = (() => {
                    const normalized = envServiceName
                        .toLowerCase()
                        .replace(/[^a-z0-9-]/g, '-')
                        .replace(/-+/g, '-')
                        .replace(/^-+|-+$/g, '');
                    const truncated = normalized.slice(0, 63).replace(/-+$/g, '');
                    return truncated || 'service';
                })();
                const deploymentName = envServiceName;
                const ingressName = `${envServiceName}-ingress`;
                await ensureK8sManifestFile(namespace, envProjectSlug, deploymentName, envServiceName, ingressName, baseDomain, imageUri, depTargetsJson, chaosEnabled, resolveEnvChaosConfig(chaosConfig, envName, projectName));
                process.env.POSTMAN_INSIGHTS_API_KEY = postmanApiKey;
                const systemEnvId = systemEnvMap[envName] || (envName === 'prod' ? process.env.POSTMAN_SYSTEM_ENV_PROD : '');
                await exec.exec('rm', ['-f', 'k8s-injected.yaml']);
                await exec.exec('postman-insights-agent', ['kube', 'inject', '-f', 'k8s.yaml', '--workspace-id', workspaceId!, '--system-env', systemEnvId || '', '-o', 'k8s-injected.yaml']);
                await exec.exec('kubectl', ['apply', '-f', 'k8s-injected.yaml']);
            });
        }
    }

    if (shouldRun(STEPS.APPLY_DISCOVERY_WORKLOAD) && runtimeMode === 'k8s_discovery') {
        for (const envName of selectedEnvironments) {
            await core.group(`${STEPS.APPLY_DISCOVERY_WORKLOAD}: ${envName}`, async () => {
                const { envServiceName, envRuntimeUrl } = resolveK8sEnvironmentTargets(runtimeMode, serviceName, runtimeBaseUrl, envName, selectedEnvironments);
                const envProjectSlug = (() => {
                    const normalized = envServiceName
                        .toLowerCase()
                        .replace(/[^a-z0-9-]/g, '-')
                        .replace(/-+/g, '-')
                        .replace(/^-+|-+$/g, '');
                    const truncated = normalized.slice(0, 63).replace(/-+$/g, '');
                    return truncated || 'service';
                })();
                const deploymentName = envServiceName;
                const ingressName = `${envServiceName}-ingress`;
                await ensureK8sManifestFile(namespace, envProjectSlug, deploymentName, envServiceName, ingressName, baseDomain, imageUri, depTargetsJson, chaosEnabled, resolveEnvChaosConfig(chaosConfig, envName, projectName), {
                    hostNetwork: true,
                    hostPort: hostPort || 5000,
                    discoveryMode: true,
                });
                await exec.exec('kubectl', ['apply', '-f', 'k8s.yaml']);
                envRuntimeUrls[envName] = envRuntimeUrl.replace(/\/+$/, '');
                envResourceNames[envName] = envServiceName;
                upsertEnvironmentDeployment({
                    environment: envName,
                    runtime_url: envRuntimeUrls[envName],
                    postman_env_uid: envUids[envName] || '',
                    system_env_id: systemEnvMap[envName] || '',
                    status: 'pending',
                });
            });
        }
    }

    if (shouldRun(STEPS.WAIT_ROLLOUT)) {
        const rolloutEnvironments = Object.keys(envRuntimeUrls).length > 0
            ? Object.keys(envRuntimeUrls)
            : selectedEnvironments;
        const rolledOutEnvironments = new Set<string>();
        for (const envName of rolloutEnvironments) {
            await core.group(`${STEPS.WAIT_ROLLOUT}: ${envName}`, async () => {
                const { envServiceName } = resolveK8sEnvironmentTargets(runtimeMode, serviceName, runtimeBaseUrl, envName, selectedEnvironments);
                const exists = await exec.exec('kubectl', ['get', 'deployment', envServiceName, '-n', namespace], {
                    ignoreReturnCode: true,
                    silent: true,
                });
                if (exists !== 0) {
                    core.warning(`Skipping rollout for ${envServiceName}: deployment not found in namespace ${namespace}`);
                    delete envRuntimeUrls[envName];
                    delete envResourceNames[envName];
                    return;
                }
                await exec.exec('kubectl', ['rollout', 'status', `deployment/${envServiceName}`, '-n', namespace, '--timeout=300s']);
                rolledOutEnvironments.add(envName);
            });
        }
        // Capture all candidate envs BEFORE any deletion so we can prune consistently
        const failedEnvs = new Set<string>();
        for (const envName of rolloutEnvironments) {
            if (!rolledOutEnvironments.has(envName)) {
                failedEnvs.add(envName);
            }
        }
        if (failedEnvs.size > 0) {
            for (const envName of failedEnvs) {
                delete envRuntimeUrls[envName];
                delete envResourceNames[envName];
            }
            // Remove stale entries from environmentDeployments for environments that failed rollout
            for (let i = environmentDeployments.length - 1; i >= 0; i--) {
                const entry = environmentDeployments[i];
                if (failedEnvs.has(String(entry.environment || '').trim())) {
                    environmentDeployments.splice(i, 1);
                }
            }
        }
        if (runtimeMode === 'k8s_discovery' && rolledOutEnvironments.size > 0) {
            for (const envName of rolledOutEnvironments) {
                const { envServiceName, envRuntimeUrl } = resolveK8sEnvironmentTargets(runtimeMode, serviceName, runtimeBaseUrl, envName, selectedEnvironments);
                upsertEnvironmentDeployment({
                    environment: envName,
                    runtime_url: envRuntimeUrl.replace(/\/+$/, ''),
                    postman_env_uid: envUids[envName] || '',
                    system_env_id: systemEnvMap[envName] || '',
                    status: 'active',
                });
            }
        }
    }

    if (shouldRun(STEPS.HEALTH_CHECK_KUBERNETES)) {
        const healthCheckEnvironments = Object.keys(envRuntimeUrls).length > 0
            ? Object.keys(envRuntimeUrls)
            : selectedEnvironments;
        const queue = [...healthCheckEnvironments];
        const limit = 3;
        const workers = Array.from({ length: limit }, async () => {
            while (queue.length > 0) {
                const envName = queue.shift()!;
                const { envRuntimeUrl } = resolveK8sEnvironmentTargets(runtimeMode, serviceName, runtimeBaseUrl, envName, selectedEnvironments);
                const runtimeUrl = envRuntimeUrls[envName] || envRuntimeUrl;
                await healthCheck(`${runtimeUrl.replace(/\/+$/, '')}/health`, 10);
            }
        });
        await Promise.all(workers);
    }

    setStepOutput('k8s_namespace', namespace);
    const primaryResourceName = envResourceNames[primaryEnv] || serviceName;
    setStepOutput('k8s_deployment_name', primaryResourceName);
    setStepOutput('k8s_service_name', primaryResourceName);
    setStepOutput('k8s_ingress_name', `${primaryResourceName}-ingress`);
    setStepOutput('runtime_base_url', envRuntimeUrls[primaryEnv] || runtimeBaseUrl);
    return { envRuntimeUrls, envResourceNames, environmentDeployments, envUids };
}

async function healthCheck(url: string, retries: number) {
    core.info(`Checking health: ${url}`);
    for (let i = 0; i < retries; i++) {
        try {
            const resp = await fetch(url);
            if (resp.ok) { core.info('Service is healthy'); return; }
        } catch { }
        core.info(`Waiting (${i + 1}/${retries})...`);
        await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error(`Health check failed for ${url}`);
}

if (!process.env.VITEST) {
    void run();
}
