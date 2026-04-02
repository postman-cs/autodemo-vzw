import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { PostmanApiClient } from '../../_lib/postman-api';
import { GitHubApiClient } from '../../_lib/github-api';
import { setStepOutput, logStepInfo } from '../../_lib/step-output';
import { PROVISION_STEP_NAMES as STEPS } from '../../_lib/provision-steps';
import { retry } from '../../_lib/retry';
import * as io from '@actions/io';
import { resolveCanonicalWorkspaceSelection, storePostmanRepoVariables } from './workspace-selection';

export async function run() {
    try {
        const projectName = core.getInput('project_name');
        const domain = core.getInput('domain');
        const domainCode = core.getInput('domain_code');
        const requesterEmail = core.getInput('requester_email');
        const specUrl = core.getInput('spec_url');
        const environments = JSON.parse(core.getInput('environments') || '["prod"]');
        const systemEnvMap = JSON.parse(core.getInput('system_env_map') || '{}');
        const postmanApiKey = core.getInput('postman_api_key');
        const postmanAccessToken = core.getInput('postman_access_token');
        let postmanTeamId = (core.getInput('postman_team_id') || core.getInput('team_id') || '').trim();
        const workspaceTeamIdInput = core.getInput('workspace_team_id');
        let workspaceTeamId = workspaceTeamIdInput ? parseInt(workspaceTeamIdInput, 10) : undefined;
        let workspaceTeamName = core.getInput('workspace_team_name').trim();
        const githubAppToken = core.getInput('github_app_token');
        const ghFallbackToken = core.getInput('gh_fallback_token');
        const ghAuthMode = core.getInput('gh_auth_mode') || 'github_token_first';
        const governanceMapping = core.getInput('governance_mapping', { required: false }) || '{}';
        const requestedStep = core.getInput('step');
        const shouldRun = (stepName: string) => !requestedStep || requestedStep === 'all' || requestedStep === stepName;
        const needsWorkspaceCreationContext = shouldRun(STEPS.CREATE_POSTMAN_WORKSPACE);

        const repository = process.env.GITHUB_REPOSITORY;
        if (!repository) throw new Error("GITHUB_REPOSITORY is not set");
        if (requestedStep === 'noop') {
            core.info('No-op step requested; skipping postman-bootstrap execution.');
            return;
        }

        const postman = new PostmanApiClient(postmanApiKey);
        if (!postmanTeamId || (needsWorkspaceCreationContext && !workspaceTeamName)) {
            try {
                const me = await postman.getMe();
                const meTeamId = me?.user?.teamId !== undefined && me?.user?.teamId !== null
                    ? String(me.user.teamId)
                    : '';
                const meTeamName = me?.user?.teamName ? String(me.user.teamName).trim() : '';
                if (!postmanTeamId && meTeamId) {
                    postmanTeamId = meTeamId;
                    core.info(`Auto-derived postman_team_id=${postmanTeamId} from /me`);
                }
                if (!workspaceTeamName && meTeamName) {
                    workspaceTeamName = meTeamName;
                    core.info(`Auto-derived workspace_team_name=${workspaceTeamName} from /me`);
                }
            } catch {
                // Best-effort discovery only.
            }
        }
        if (workspaceTeamId === undefined && postmanTeamId) {
            // Before falling back to postman_team_id, check if this is an org-mode
            // account with sub-teams. The Postman API rejects workspace creation at
            // the org level — a specific sub-team ID is required.
            try {
                const teamsResp = await postman.getTeams();
                const teams = Array.isArray(teamsResp) ? teamsResp : [];
                if (teams.length > 1) {
                    throw new Error("This is an Org-mode account, which requires a specific workspace sub-team ID to create workspaces. No workspace_team_id was provided.");
                } else {
                    const parsedTeamId = parseInt(postmanTeamId, 10);
                    if (!Number.isNaN(parsedTeamId)) {
                        workspaceTeamId = parsedTeamId;
                        core.info(`Using workspace_team_id=${workspaceTeamId} derived from postman_team_id`);
                    }
                }
            } catch (err: any) {
                if (err.message && err.message.includes("requires a specific workspace sub-team ID")) {
                    throw err;
                }
                // If teams fetch fails, fall back to postman_team_id as before.
                const parsedTeamId = parseInt(postmanTeamId, 10);
                if (!Number.isNaN(parsedTeamId)) {
                    workspaceTeamId = parsedTeamId;
                    core.info(`Using workspace_team_id=${workspaceTeamId} derived from postman_team_id (teams fetch failed)`);
                }
            }
        }
        const github = new GitHubApiClient(githubAppToken, repository, {
            fallbackToken: ghFallbackToken,
            authMode: ghAuthMode as any,
        });

        const workspaceName = `[${domainCode}] ${projectName}`;
        const aboutText = `Auto-provisioned by API Catalog Demo for ${projectName}`;

        // Step: Install Postman CLI
        if (shouldRun(STEPS.INSTALL_POSTMAN_CLI)) {
            await core.group(STEPS.INSTALL_POSTMAN_CLI, async () => {
                const hasPostman = !!(await io.which('postman', true).catch(() => null));
                if (!hasPostman) {
                    await exec.exec('sh', ['-c', 'curl -o- "https://dl-cli.pstmn.io/install/unix.sh" | sh']);
                }
                await exec.exec('postman', ['login', '--with-api-key', postmanApiKey]);
            });
        }

        // Step: Create Postman Workspace
        let workspaceId = core.getInput('workspace_id');
        let specId = core.getInput('spec_uid');
        let baselineUid = core.getInput('baseline_uid') || '';
        let smokeUid = core.getInput('smoke_uid') || '';
        let contractUid = core.getInput('contract_uid') || '';
        let isExistingWorkspace = false;
        const repoUrl = `https://github.com/${repository}`;

        try {
            const existingVars = await github.listRepositoryVariables();
            if (existingVars['POSTMAN_WORKSPACE_ID']) {
                workspaceId = existingVars['POSTMAN_WORKSPACE_ID'];
                isExistingWorkspace = true;
            }
            if (existingVars['POSTMAN_SPEC_UID']) specId = existingVars['POSTMAN_SPEC_UID'];
            if (existingVars['POSTMAN_BASELINE_COLLECTION_UID']) baselineUid = existingVars['POSTMAN_BASELINE_COLLECTION_UID'];
            if (existingVars['POSTMAN_SMOKE_COLLECTION_UID']) smokeUid = existingVars['POSTMAN_SMOKE_COLLECTION_UID'];
            if (existingVars['POSTMAN_CONTRACT_COLLECTION_UID']) contractUid = existingVars['POSTMAN_CONTRACT_COLLECTION_UID'];
        } catch { }

        const workspaceSelection = await resolveCanonicalWorkspaceSelection({
            postman,
            workspaceName,
            repoWorkspaceId: workspaceId,
            repoUrl,
            teamId: postmanTeamId,
            accessToken: postmanAccessToken,
            warn: (message) => core.warning(message),
        });

        if (workspaceSelection.type === 'manual_review') {
            throw new Error(`${workspaceSelection.reason}. Manual review required before provisioning can continue.`);
        }

        if (workspaceSelection.type === 'existing') {
            workspaceId = workspaceSelection.workspaceId;
            isExistingWorkspace = true;
            if (workspaceSelection.warning) {
                core.warning(workspaceSelection.warning);
            }
        }

        if (shouldRun(STEPS.CREATE_POSTMAN_WORKSPACE)) {
            await core.group(STEPS.CREATE_POSTMAN_WORKSPACE, async () => {
                if (isExistingWorkspace) {
                    setStepOutput('workspace_id', workspaceId);
                    setStepOutput('workspace_url', `https://go.postman.co/workspace/${workspaceId}`);
                    logStepInfo('Postman', `Reused existing workspace: ${workspaceId}`);
                } else {
                    const ws = await postman.createWorkspace(workspaceName, aboutText, {
                        accessToken: postmanAccessToken,
                        targetTeamId: workspaceTeamId,
                        teamId: postmanTeamId,
                        teamName: workspaceTeamName,
                    });
                    workspaceId = ws.id;
                    setStepOutput('workspace_id', workspaceId);
                    setStepOutput('workspace_url', `https://go.postman.co/workspace/${workspaceId}`);
                    logStepInfo('Postman', `Workspace created: ${workspaceId}`);
                }
            });
        }

        if (!isExistingWorkspace) {
            await Promise.all([
                shouldRun(STEPS.ASSIGN_WORKSPACE_TO_GOVERNANCE_GROUP)
                    ? core.group(STEPS.ASSIGN_WORKSPACE_TO_GOVERNANCE_GROUP, async () => {
                        try {
                            await postman.assignWorkspaceToGovernanceGroup(workspaceId, domain, governanceMapping, postmanAccessToken, postmanTeamId || undefined);
                        } catch (error) {
                            core.warning(`Governance group assignment failed for domain '${domain}': ${error}`);
                        }
                    })
                    : Promise.resolve(),
                shouldRun(STEPS.INVITE_REQUESTER_TO_WORKSPACE)
                    ? core.group(STEPS.INVITE_REQUESTER_TO_WORKSPACE, async () => {
                        try {
                            await postman.inviteRequesterToWorkspace(workspaceId, requesterEmail);
                        } catch (error) {
                            core.warning(`Failed to invite requester: ${error}`);
                        }
                    })
                    : Promise.resolve(),
                shouldRun(STEPS.ADD_TEAM_ADMINS_TO_WORKSPACE)
                    ? core.group(STEPS.ADD_TEAM_ADMINS_TO_WORKSPACE, async () => {
                        try {
                            const adminIds = process.env.WORKSPACE_ADMIN_USER_IDS || '';
                            await postman.addAdminsToWorkspace(workspaceId, adminIds);
                        } catch (error) {
                            core.warning(`Failed to add team admins: ${error}`);
                        }
                    })
                    : Promise.resolve(),
            ]);
        }

        // Step: Upload Spec to Spec Hub
        if (shouldRun(STEPS.UPLOAD_SPEC_TO_SPEC_HUB)) {
            await core.group(STEPS.UPLOAD_SPEC_TO_SPEC_HUB, async () => {
                const specContent = await retry(async () => {
                    const specRes = await fetch(specUrl, {
                        headers: { 'User-Agent': 'postman-bootstrap-action' },
                    });
                    if (!specRes.ok) throw new Error(`Failed to fetch spec from URL: ${specRes.status}`);
                    return specRes.text();
                }, 3, 3000);

                if (isExistingWorkspace && specId) {
                    await postman.updateSpec(specId, specContent);
                    setStepOutput('spec_uid', specId);
                    logStepInfo('Postman', `Updated existing Spec: ${specId}`);
                } else {
                    specId = await postman.uploadSpec(workspaceId, projectName, specContent);
                    setStepOutput('spec_uid', specId);
                }
            });
        }

        // Step: Lint Spec via Postman CLI
        if (shouldRun(STEPS.LINT_SPEC_VIA_POSTMAN_CLI)) {
            await core.group(STEPS.LINT_SPEC_VIA_POSTMAN_CLI, async () => {
                const LINT_MAX_ATTEMPTS = 4;
                const LINT_RETRY_DELAY_MS = 5000;
                const LINT_INITIAL_DELAY_MS = 3000;

                await new Promise(r => setTimeout(r, LINT_INITIAL_DELAY_MS));

                for (let lintAttempt = 1; lintAttempt <= LINT_MAX_ATTEMPTS; lintAttempt++) {
                    let lintOutput = '';
                    let lintError = '';
                    try {
                        await exec.exec('postman', ['spec', 'lint', specId, '--workspace-id', workspaceId, '--report-events', '-o', 'json'], {
                            listeners: {
                                stdout: (data: Buffer) => { lintOutput += data.toString(); },
                                stderr: (data: Buffer) => { lintError += data.toString(); }
                            },
                            ignoreReturnCode: true
                        });
                    } catch (e: any) {
                        core.warning(`Postman CLI exec error: ${e.message}`);
                    }

                    let results: any;
                    try {
                        results = JSON.parse(lintOutput);
                    } catch {
                        if (lintAttempt < LINT_MAX_ATTEMPTS) {
                            core.warning(`Lint output not valid JSON (attempt ${lintAttempt}/${LINT_MAX_ATTEMPTS}), retrying in ${LINT_RETRY_DELAY_MS / 1000}s...`);
                            await new Promise(r => setTimeout(r, LINT_RETRY_DELAY_MS));
                            continue;
                        }
                        throw new Error(`Spec lint output is not valid JSON. output: ${lintOutput}, err: ${lintError}`);
                    }

                    const errors = results.violations?.filter((v: any) => v.severity === 'ERROR') || [];
                    const warnings = results.violations?.filter((v: any) => v.severity === 'WARNING') || [];

                    const isTransientParsing = errors.some(
                        (e: any) => typeof e.issue === 'string' && e.issue.includes('Document parsing failed')
                    );
                    if (isTransientParsing && lintAttempt < LINT_MAX_ATTEMPTS) {
                        core.warning(`Transient spec parse error (attempt ${lintAttempt}/${LINT_MAX_ATTEMPTS}), retrying in ${LINT_RETRY_DELAY_MS / 1000}s...`);
                        await new Promise(r => setTimeout(r, LINT_RETRY_DELAY_MS));
                        continue;
                    }

                    setStepOutput('lint_errors', errors.length.toString());
                    setStepOutput('lint_warnings', warnings.length.toString());
                    setStepOutput('lint_total', (results.violations?.length || 0).toString());
                    const violationsB64 = Buffer.from(JSON.stringify(results.violations || [])).toString('base64');
                    setStepOutput('lint_violations', violationsB64);

                    logStepInfo('Postman', `Lint results: ${errors.length} errors, ${warnings.length} warnings`);

                    if (errors.length > 0) {
                        errors.forEach((e: any) => core.error(`  ${e.path}: ${e.issue}`));
                        throw new Error(`Spec lint found ${errors.length} errors`);
                    }
                    if (warnings.length > 0) {
                        warnings.forEach((w: any) => core.warning(`  ${w.path}: ${w.issue}`));
                    }

                    if (githubAppToken && process.env.GITHUB_REPOSITORY) {
                        await github.setRepositoryVariable('LINT_WARNINGS', warnings.length.toString());
                        await github.setRepositoryVariable('LINT_ERRORS', errors.length.toString());
                    }
                    break;
                }
            });
        }

        // Step: Generate Collections from Spec
        // Collections are generated sequentially to avoid 423 Locked errors —
        // the Postman API only allows one generation per spec at a time.
        if (shouldRun(STEPS.GENERATE_COLLECTIONS_FROM_SPEC)) {
            await core.group(STEPS.GENERATE_COLLECTIONS_FROM_SPEC, async () => {
                if (isExistingWorkspace && baselineUid && smokeUid && contractUid) {
                    setStepOutput('baseline_uid', baselineUid);
                    setStepOutput('smoke_uid', smokeUid);
                    setStepOutput('contract_uid', contractUid);
                    logStepInfo('Postman', `Reused existing collections: Baseline=${baselineUid} Smoke=${smokeUid} Contract=${contractUid}`);
                } else {
                    baselineUid = await postman.generateCollection(specId, projectName, '[Baseline]');
                    setStepOutput('baseline_uid', baselineUid);
                    logStepInfo('Postman', `Generated Baseline: ${baselineUid}`);

                    smokeUid = await postman.generateCollection(specId, projectName, '[Smoke]');
                    setStepOutput('smoke_uid', smokeUid);
                    logStepInfo('Postman', `Generated Smoke: ${smokeUid}`);

                    contractUid = await postman.generateCollection(specId, projectName, '[Contract]');
                    setStepOutput('contract_uid', contractUid);
                    logStepInfo('Postman', `Generated Contract: ${contractUid}`);

                    logStepInfo('Postman', `All collections generated: Baseline=${baselineUid} Smoke=${smokeUid} Contract=${contractUid}`);
                }
            });
        }

        // Step: Inject Test Scripts & Request 0
        if (shouldRun(STEPS.INJECT_TEST_SCRIPTS_AND_REQUEST_0) && !isExistingWorkspace) {
            await core.group(STEPS.INJECT_TEST_SCRIPTS_AND_REQUEST_0, async () => {
                await Promise.all([
                    postman.injectTests(smokeUid, 'smoke'),
                    postman.injectTests(contractUid, 'contract')
                ]);
            });
        }

        // Step: Tag Collections
        if (shouldRun(STEPS.TAG_COLLECTIONS) && !isExistingWorkspace) {
            await core.group(STEPS.TAG_COLLECTIONS, async () => {
                await Promise.all([
                    postman.tagCollection(baselineUid, ['generated-docs']),
                    postman.tagCollection(smokeUid, ['generated-smoke']),
                    postman.tagCollection(contractUid, ['generated-contract'])
                ]);
            });
        }

        // Step: Store Postman UIDs as Repo Variables
        if (shouldRun(STEPS.STORE_POSTMAN_UIDS_AS_REPO_VARIABLES)) {
            await core.group(STEPS.STORE_POSTMAN_UIDS_AS_REPO_VARIABLES, async () => {
                await storePostmanRepoVariables({
                    github,
                    workspaceId,
                    specId,
                    baselineUid,
                    smokeUid,
                    contractUid,
                    environments,
                    systemEnvMap,
                });
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
