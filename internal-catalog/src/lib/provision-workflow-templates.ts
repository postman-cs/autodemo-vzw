import { PROVISION_STEP_NAMES as STEPS } from "./provision-steps";

export interface ProvisionWorkflowTemplateParams {
  committerEmail: string;
  committerName: string;
  fallbackTeamId: string;
  governanceMapping: string;
}

export const CI_WORKFLOW_TEMPLATE = `name: CI/CD Pipeline
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: "0 */6 * * *"
jobs:
  lint:
    runs-on: ubuntu-latest
    if: \${{ vars.POSTMAN_SPEC_UID != '' && vars.POSTMAN_WORKSPACE_ID != '' }}
    steps:
      - uses: actions/checkout@v6.0.2
      - name: ${STEPS.INSTALL_POSTMAN_CLI}
        run: curl -o- "https://dl-cli.pstmn.io/install/unix.sh" | sh
      - name: Login to Postman CLI
        run: postman login --with-api-key \${{ secrets.POSTMAN_API_KEY }}
      - name: Run Spec Lint
        run: |
          SPEC_UID="\${{ vars.POSTMAN_SPEC_UID }}"
          if [ -z "\${SPEC_UID}" ]; then
            echo "::error::POSTMAN_SPEC_UID repo variable is not set"
            exit 1
          fi
          LINT_OUTPUT=\$(postman spec lint "\${SPEC_UID}" --workspace-id "\${{ vars.POSTMAN_WORKSPACE_ID }}" --report-events -o json 2>&1) || true
          echo "\$LINT_OUTPUT" | jq '.' > /dev/null 2>&1 || { echo "::error::Spec lint output is not valid JSON"; exit 1; }
          ERRORS=\$(echo "\$LINT_OUTPUT" | jq '[.violations[] | select(.severity=="ERROR")] | length')
          WARNINGS=\$(echo "\$LINT_OUTPUT" | jq '[.violations[] | select(.severity=="WARNING")] | length')
          echo "Lint results: \${ERRORS} errors, \${WARNINGS} warnings"
          if [ "\${ERRORS}" -gt 0 ]; then
            echo "::error::Spec lint found \${ERRORS} errors"
            echo "\$LINT_OUTPUT" | jq -r '.violations[] | select(.severity=="ERROR") | "  \(.path): \(.issue)"'
            exit 1
          fi
          if [ "\${WARNINGS}" -gt 0 ]; then
            echo "::warning::Spec lint found \${WARNINGS} governance warnings"
          fi
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        test_type: [Smoke, Contract]
        include:
          - test_type: Smoke
            collection_uid: \${{ vars.POSTMAN_SMOKE_COLLECTION_UID }}
          - test_type: Contract
            collection_uid: \${{ vars.POSTMAN_CONTRACT_COLLECTION_UID }}
    steps:
      - uses: actions/checkout@v6.0.2
      - name: ${STEPS.INSTALL_POSTMAN_CLI}
        run: curl -o- "https://dl-cli.pstmn.io/install/unix.sh" | sh
      - name: Login to Postman CLI
        run: postman login --with-api-key \${{ secrets.POSTMAN_API_KEY }}
      - name: Run \${{ matrix.test_type }} Tests
        run: postman collection run \${{ matrix.collection_uid }} -e \${{ vars.POSTMAN_ENVIRONMENT_UID }} --env-var baseUrl=\${{ vars.RUNTIME_BASE_URL || vars.DEV_GW_URL }} --report-events --env-var "\${{ vars.CI_ENVIRONMENT || 'Production' }}"
  docs:
    runs-on: ubuntu-latest
    if: \${{ github.event_name == 'push' && vars.POSTMAN_SPEC_UID != '' && vars.POSTMAN_WORKSPACE_ID != '' }}
    steps:
      - uses: actions/checkout@v6.0.2
      - name: Fern Docs Status
        run: |
          echo "Per-repo Fern publish is DISABLED to prevent overwriting the unified docs site."
          echo "The unified site at vzw-demo.docs.buildwithfern.com is published centrally."
          echo "Deep link: \${{ vars.FERN_DOCS_URL }}"
`;

export const REFRESH_DEPENDENCIES_WORKFLOW_TEMPLATE = `name: Refresh Dependencies
on:
  workflow_dispatch:
    inputs:
      project_name: { required: true, type: string }
      runtime_mode: { required: true, type: string }
      environments: { required: true, type: string, default: '["prod"]' }
      dependency_targets_json: { required: true, type: string }

permissions:
  contents: read
  id-token: write

jobs:
  refresh:
    runs-on: ubuntu-24.04-arm
    steps:
      - uses: actions/checkout@v6.0.2
      - uses: actions/checkout@v6.0.2
        with:
          repository: postman-cs/vzw-partner-demo
          ref: \${{ vars.PROVISION_ACTIONS_REF || 'main' }}
          token: \${{ secrets.GH_TOKEN }}
          persist-credentials: false
          path: .actions
      - name: Resolve Credentials
        uses: ./.actions/internal-catalog/.github/actions/resolve-credentials
        with:
          provider: \${{ vars.SECRET_PROVIDER || 'aws-secrets-manager' }}
          postman_team_slug: \${{ inputs.postman_team_slug || vars.POSTMAN_TEAM_SLUG }}
          aws_role_arn: \${{ vars.AWS_OIDC_ROLE_ARN || vars.AWS_ROLE_ARN }}
          aws_region: \${{ vars.AWS_REGION || 'eu-central-1' }}
        env: { AWS_ACCESS_KEY_ID: "\${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_ACCESS_KEY_ID || '' }}", AWS_SECRET_ACCESS_KEY: "\${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_SECRET_ACCESS_KEY || '' }}" }
      - name: Configure AWS credentials (OIDC)
        if: \${{ vars.OIDC_AWS_ENABLED == 'true' }}
        uses: aws-actions/configure-aws-credentials@v6.0.0
        with:
          role-to-assume: \${{ vars.AWS_OIDC_ROLE_ARN }}
          aws-region: \${{ vars.AWS_REGION || 'eu-central-1' }}
      - name: Configure AWS credentials (legacy static keys)
        if: \${{ vars.OIDC_AWS_ENABLED != 'true' }}
        run: |
          aws configure set aws_access_key_id "\${{ secrets.AWS_ACCESS_KEY_ID }}"
          aws configure set aws_secret_access_key "\${{ secrets.AWS_SECRET_ACCESS_KEY }}"
          aws configure set region "\${{ vars.AWS_REGION || 'eu-central-1' }}"
      - uses: ./.actions/internal-catalog/.github/actions/aws-deploy
        with:
          project_name: \${{ inputs.project_name }}
          runtime_mode: \${{ inputs.runtime_mode }}
          environments: \${{ inputs.environments }}
          dependency_targets_json: \${{ inputs.dependency_targets_json }}
          step: REFRESH_K8S_CONFIG_MAP
          aws_access_key_id: \${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_ACCESS_KEY_ID || '' }}
          aws_secret_access_key: \${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_SECRET_ACCESS_KEY || '' }}
          aws_region: \${{ vars.AWS_REGION || 'eu-central-1' }}
        env:
          KUBECONFIG_B64: \${{ secrets.KUBECONFIG_B64 }}
          K8S_NAMESPACE: \${{ vars.K8S_NAMESPACE }}
          K8S_CONTEXT: \${{ vars.K8S_CONTEXT }}
`;

export function renderProvisionWorkflowTemplate(params: ProvisionWorkflowTemplateParams): string {
  const {
    committerEmail,
    committerName,
    fallbackTeamId,
    governanceMapping,
  } = params;

  const ciWorkflowBase64 = btoa(CI_WORKFLOW_TEMPLATE);
  const actionRepo = "postman-cs/vzw-partner-demo";

  return `name: Provision API Lifecycle

on:
  workflow_dispatch:
    inputs:
      project_name: { required: true, type: string }
      domain: { required: true, type: string }
      domain_code: { required: true, type: string }
      requester_email: { required: true, type: string }
      spec_url: { required: true, type: string }
      environments: { required: true, type: string, default: '["prod"]' }
      system_env_map: { required: true, type: string, default: "{}" }
      postman_team_id: { required: false, type: string, default: "${fallbackTeamId}" }
      postman_team_slug: { required: false, type: string, default: "" }
      workspace_team_id: { required: false, type: string, default: "" }
      workspace_team_name: { required: false, type: string, default: "" }
      runtime_mode: { required: false, type: string, default: "lambda" }
      deployment_mode: { required: false, type: string, default: "single" }
      chaos_enabled: { required: false, type: string, default: "true" }
      chaos_config: { required: false, type: string, default: "" }
      github_workspace_sync: { required: false, type: string, default: "true" }
      environment_sync_enabled: { required: false, type: string, default: "true" }
      k8s_discovery_workspace_link: { required: false, type: string, default: "false" }
      host_port: { required: false, type: string, default: "" }
      dependency_targets_json: { required: false, type: string, default: "[]" }

permissions:
  contents: write
  actions: read
  id-token: write

concurrency:
  group: provision-\${{ inputs.project_name }}
  cancel-in-progress: false

jobs:
  postman_bootstrap:
    if: \${{ !cancelled() && (inputs.runtime_mode != 'k8s_discovery' || inputs.k8s_discovery_workspace_link == 'true') }}
    runs-on: ubuntu-24.04-arm
    timeout-minutes: 15
    outputs:
      primary_env: \${{ steps.setup_env.outputs.primary_env }}
      workspace_id: \${{ steps.bootstrap.outputs['workspace-id'] }}
      baseline_uid: \${{ steps.bootstrap.outputs['baseline-collection-id'] }}
      smoke_uid: \${{ steps.bootstrap.outputs['smoke-collection-id'] }}
      contract_uid: \${{ steps.bootstrap.outputs['contract-collection-id'] }}
    steps:
      - name: Setup Primary Environment
        id: setup_env
        run: |
          PRIMARY=\$(echo '\${{ inputs.system_env_map }}' | jq -r 'if has("prod") then "prod" else keys[0] // "prod" end')
          echo "primary_env=\$PRIMARY" >> \$GITHUB_OUTPUT
      - uses: actions/checkout@v6.0.2
        with:
          repository: ${actionRepo}
          ref: \${{ vars.PROVISION_ACTIONS_REF || 'main' }}
          token: \${{ secrets.GH_TOKEN }}
          persist-credentials: false
          path: .actions
      - name: Resolve Credentials
        uses: ./.actions/internal-catalog/.github/actions/resolve-credentials
        with:
          provider: \${{ vars.SECRET_PROVIDER || 'aws-secrets-manager' }}
          postman_team_slug: \${{ inputs.postman_team_slug || vars.POSTMAN_TEAM_SLUG }}
          aws_role_arn: \${{ vars.AWS_OIDC_ROLE_ARN || vars.AWS_ROLE_ARN }}
          aws_region: \${{ vars.AWS_REGION || 'eu-central-1' }}
        env: { AWS_ACCESS_KEY_ID: "\${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_ACCESS_KEY_ID || '' }}", AWS_SECRET_ACCESS_KEY: "\${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_SECRET_ACCESS_KEY || '' }}" }
      - uses: postman-cs/postman-bootstrap-action@v0.11.0
        id: bootstrap
        with:
          project-name: \${{ inputs.project_name }}
          domain: \${{ inputs.domain }}
          domain-code: \${{ inputs.domain_code }}
          requester-email: \${{ inputs.requester_email }}
          spec-url: \${{ inputs.spec_url }}
          workspace-team-id: \${{ inputs.workspace_team_id }}
          runtime_mode: \${{ inputs.runtime_mode }}
          environments: \${{ inputs.environments }}
          system_env_map: \${{ inputs.system_env_map }}
          governance-mapping-json: '${governanceMapping}'
          postman-api-key: \${{ env.POSTMAN_API_KEY }}
          postman-access-token: \${{ env.POSTMAN_ACCESS_TOKEN }}
        env:
          WORKSPACE_ADMIN_USER_IDS: \${{ vars.WORKSPACE_ADMIN_USER_IDS }}

  docker_build:
    if: \${{ !cancelled() && contains('ecs_service,k8s_workspace,k8s_discovery', inputs.runtime_mode) }}
    runs-on: ubuntu-24.04-arm
    timeout-minutes: 20
    outputs:
      project_slug: \${{ steps.docker_build.outputs.project_slug }}
      service_name: \${{ steps.docker_build.outputs.service_name }}
      task_family: \${{ steps.docker_build.outputs.task_family }}
      target_group_name: \${{ steps.docker_build.outputs.target_group_name }}
      runtime_base_url: \${{ steps.docker_build.outputs.runtime_base_url }}
      image_uri: \${{ steps.docker_build.outputs.image_uri }}
    steps:
      - uses: actions/checkout@v6.0.2
        with:
          repository: ${actionRepo}
          ref: \${{ vars.PROVISION_ACTIONS_REF || 'main' }}
          token: \${{ secrets.GH_TOKEN }}
          persist-credentials: false
          path: .actions
      - name: Resolve Credentials
        uses: ./.actions/internal-catalog/.github/actions/resolve-credentials
        with:
          provider: \${{ vars.SECRET_PROVIDER || 'aws-secrets-manager' }}
          postman_team_slug: \${{ inputs.postman_team_slug || vars.POSTMAN_TEAM_SLUG }}
          aws_role_arn: \${{ vars.AWS_OIDC_ROLE_ARN || vars.AWS_ROLE_ARN }}
          aws_region: \${{ vars.AWS_REGION || 'eu-central-1' }}
        env: { AWS_ACCESS_KEY_ID: "\${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_ACCESS_KEY_ID || '' }}", AWS_SECRET_ACCESS_KEY: "\${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_SECRET_ACCESS_KEY || '' }}" }
      - name: Configure AWS credentials (OIDC)
        if: \${{ vars.OIDC_AWS_ENABLED == 'true' }}
        uses: aws-actions/configure-aws-credentials@v6.0.0
        with:
          role-to-assume: \${{ vars.AWS_OIDC_ROLE_ARN }}
          aws-region: \${{ vars.AWS_REGION || 'eu-central-1' }}
      - name: Configure AWS credentials (legacy static keys)
        if: \${{ vars.OIDC_AWS_ENABLED != 'true' }}
        run: |
          aws configure set aws_access_key_id "\${{ secrets.AWS_ACCESS_KEY_ID }}"
          aws configure set aws_secret_access_key "\${{ secrets.AWS_SECRET_ACCESS_KEY }}"
          aws configure set region "\${{ vars.AWS_REGION || 'eu-central-1' }}"
      - uses: ./.actions/internal-catalog/.github/actions/docker-build
        id: docker_build
        with:
          project_name: \${{ inputs.project_name }}
          runtime_mode: \${{ inputs.runtime_mode }}
          aws_access_key_id: \${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_ACCESS_KEY_ID || '' }}
          aws_secret_access_key: \${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_SECRET_ACCESS_KEY || '' }}
          aws_region: \${{ vars.AWS_REGION || 'eu-central-1' }}
          github_app_token: \${{ github.token }}
          gh_fallback_token: \${{ secrets.GH_TOKEN || '' }}
          gh_auth_mode: \${{ vars.GH_AUTH_MODE || 'github_token_first' }}
          persist_repo_variables: 'false'
        env:
          ECS_ALB_DNS_NAME: \${{ vars.ECS_ALB_DNS_NAME }}
          K8S_INGRESS_BASE_DOMAIN: \${{ vars.K8S_INGRESS_BASE_DOMAIN }}
          ECS_ECR_REPOSITORY: \${{ vars.ECS_ECR_REPOSITORY || 'vzw-partner-demo' }}

  aws_deploy:
    needs: [postman_bootstrap, docker_build]
    if: \${{ !cancelled() && (needs.postman_bootstrap.result == 'success' || needs.postman_bootstrap.result == 'skipped') && (needs.docker_build.result == 'success' || needs.docker_build.result == 'skipped') }}
    runs-on: ubuntu-24.04-arm
    timeout-minutes: 30
    outputs:
      runtime_base_url: \${{ steps.deploy.outputs.runtime_base_url }}
      image_uri: \${{ steps.deploy.outputs.image_uri }}
      ecs_service_name: \${{ steps.deploy.outputs.ecs_service_name }}
      ecs_target_group_arn: \${{ steps.deploy.outputs.ecs_target_group_arn }}
      ecs_listener_rule_arn: \${{ steps.deploy.outputs.ecs_listener_rule_arn }}
      ecs_task_definition: \${{ steps.deploy.outputs.ecs_task_definition }}
      k8s_namespace: \${{ steps.deploy.outputs.k8s_namespace }}
      k8s_deployment_name: \${{ steps.deploy.outputs.k8s_deployment_name }}
      k8s_service_name: \${{ steps.deploy.outputs.k8s_service_name }}
      k8s_ingress_name: \${{ steps.deploy.outputs.k8s_ingress_name }}
      env_uids_json: \${{ steps.deploy.outputs.env_uids_json }}
      dev_gw_url: \${{ steps.deploy.outputs.dev_gw_url }}
      prod_gw_url: \${{ steps.deploy.outputs.prod_gw_url }}
      dev_api_id: \${{ steps.deploy.outputs.dev_api_id }}
      prod_api_id: \${{ steps.deploy.outputs.prod_api_id }}
      gw_urls_json: \${{ steps.deploy.outputs.gw_urls_json }}
      gw_ids_json: \${{ steps.deploy.outputs.gw_ids_json }}
      env_runtime_urls_json: \${{ steps.deploy.outputs.env_runtime_urls_json }}
      env_resource_names_json: \${{ steps.deploy.outputs.env_resource_names_json }}
      environment_deployments_json: \${{ steps.deploy.outputs.environment_deployments_json }}
      insights_project_id: \${{ steps.deploy.outputs.insights_project_id }}
    steps:
      - uses: actions/checkout@v6.0.2
        with:
          repository: ${actionRepo}
          ref: \${{ vars.PROVISION_ACTIONS_REF || 'main' }}
          token: \${{ secrets.GH_TOKEN }}
          persist-credentials: false
          path: .actions
      - name: Resolve Credentials
        uses: ./.actions/internal-catalog/.github/actions/resolve-credentials
        with:
          provider: \${{ vars.SECRET_PROVIDER || 'aws-secrets-manager' }}
          postman_team_slug: \${{ inputs.postman_team_slug || vars.POSTMAN_TEAM_SLUG }}
          aws_role_arn: \${{ vars.AWS_OIDC_ROLE_ARN || vars.AWS_ROLE_ARN }}
          aws_region: \${{ vars.AWS_REGION || 'eu-central-1' }}
        env: { AWS_ACCESS_KEY_ID: "\${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_ACCESS_KEY_ID || '' }}", AWS_SECRET_ACCESS_KEY: "\${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_SECRET_ACCESS_KEY || '' }}" }
      - name: Configure AWS credentials (OIDC)
        if: \${{ vars.OIDC_AWS_ENABLED == 'true' }}
        uses: aws-actions/configure-aws-credentials@v6.0.0
        with:
          role-to-assume: \${{ vars.AWS_OIDC_ROLE_ARN }}
          aws-region: \${{ vars.AWS_REGION || 'eu-central-1' }}
      - name: Configure AWS credentials (legacy static keys)
        if: \${{ vars.OIDC_AWS_ENABLED != 'true' }}
        run: |
          aws configure set aws_access_key_id "\${{ secrets.AWS_ACCESS_KEY_ID }}"
          aws configure set aws_secret_access_key "\${{ secrets.AWS_SECRET_ACCESS_KEY }}"
          aws configure set region "\${{ vars.AWS_REGION || 'eu-central-1' }}"
      - name: Set up Python
        if: \${{ inputs.runtime_mode == 'lambda' }}
        uses: actions/setup-python@v6.2.0
        with:
          python-version: '3.12'
          cache: 'pip'
      - uses: ./.actions/internal-catalog/.github/actions/aws-deploy
        id: deploy
        with:
          project_name: \${{ inputs.project_name }}
          runtime_mode: \${{ inputs.runtime_mode }}
          chaos_enabled: \${{ inputs.chaos_enabled }}
          chaos_config: \${{ inputs.chaos_config }}
          github_workspace_sync: \${{ inputs.github_workspace_sync }}
          environment_sync_enabled: \${{ inputs.environment_sync_enabled }}
          environments: \${{ inputs.environments }}
          system_env_map: \${{ inputs.system_env_map }}
          workspace_id: \${{ needs.postman_bootstrap.outputs.workspace_id }}
          image_uri: \${{ needs.docker_build.outputs.image_uri }}
          runtime_base_url: \${{ needs.docker_build.outputs.runtime_base_url }}
          service_name: \${{ needs.docker_build.outputs.service_name }}
          task_family: \${{ needs.docker_build.outputs.task_family }}
          target_group_name: \${{ needs.docker_build.outputs.target_group_name }}
          project_slug: \${{ needs.docker_build.outputs.project_slug }}

          host_port: \${{ inputs.host_port }}
          dependency_targets_json: \${{ inputs.dependency_targets_json }}
          postman_api_key: \${{ env.POSTMAN_API_KEY }}
          postman_access_token: \${{ env.POSTMAN_ACCESS_TOKEN }}
          github_app_token: \${{ github.token }}
          gh_fallback_token: \${{ secrets.GH_TOKEN || '' }}
          gh_auth_mode: \${{ vars.GH_AUTH_MODE || 'github_token_first' }}
          persist_predeploy_env_repo_variables: 'false'
          postman_team_id: \${{ inputs.postman_team_id || '${fallbackTeamId}' }}
          aws_access_key_id: \${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_ACCESS_KEY_ID || '' }}
          aws_secret_access_key: \${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_SECRET_ACCESS_KEY || '' }}
          aws_region: \${{ vars.AWS_REGION || 'eu-central-1' }}
        env:
          AWS_LAMBDA_ROLE_ARN: \${{ secrets.AWS_LAMBDA_ROLE_ARN }}
          BIFROST_ENV_ASSOCIATION_ENABLED: \${{ vars.BIFROST_ENV_ASSOCIATION_ENABLED || 'true' }}
          POSTMAN_SYSTEM_ENV_PROD: \${{ vars.POSTMAN_SYSTEM_ENV_PROD }}
          KUBECONFIG_B64: \${{ secrets.KUBECONFIG_B64 }}
          K8S_NAMESPACE: \${{ vars.K8S_NAMESPACE }}
          K8S_CONTEXT: \${{ vars.K8S_CONTEXT }}
          K8S_INGRESS_BASE_DOMAIN: \${{ vars.K8S_INGRESS_BASE_DOMAIN }}
          POSTMAN_INSIGHTS_CLUSTER_NAME: \${{ vars.POSTMAN_INSIGHTS_CLUSTER_NAME }}
          ECS_CLUSTER_NAME: \${{ vars.ECS_CLUSTER_NAME }}
          ECS_VPC_ID: \${{ vars.ECS_VPC_ID }}
          ECS_SUBNET_IDS: \${{ vars.ECS_SUBNET_IDS }}
          ECS_SECURITY_GROUP_IDS: \${{ vars.ECS_SECURITY_GROUP_IDS }}
          ECS_EXECUTION_ROLE_ARN: \${{ vars.ECS_EXECUTION_ROLE_ARN }}
          ECS_TASK_ROLE_ARN: \${{ vars.ECS_TASK_ROLE_ARN }}
          ECS_ALB_LISTENER_ARN: \${{ vars.ECS_ALB_LISTENER_ARN }}
          ECS_ECR_REPOSITORY: \${{ vars.ECS_ECR_REPOSITORY || 'vzw-partner-demo' }}

  finalize:
    needs: [postman_bootstrap, aws_deploy]
    if: \${{ !cancelled() && (needs.postman_bootstrap.result == 'success' || needs.postman_bootstrap.result == 'skipped') && (needs.aws_deploy.result == 'success' || needs.aws_deploy.result == 'skipped') }}
    runs-on: ubuntu-latest-8-cores
    timeout-minutes: 8
    steps:
      - uses: actions/checkout@v6.0.2
        with:
          token: \${{ github.token }}
          persist-credentials: false
      - uses: actions/checkout@v6.0.2
        with:
          repository: ${actionRepo}
          ref: \${{ vars.PROVISION_ACTIONS_REF || 'main' }}
          token: \${{ secrets.GH_TOKEN }}
          persist-credentials: false
          path: .actions
      - name: Resolve Credentials
        uses: ./.actions/internal-catalog/.github/actions/resolve-credentials
        with:
          provider: \${{ vars.SECRET_PROVIDER || 'aws-secrets-manager' }}
          postman_team_slug: \${{ inputs.postman_team_slug || vars.POSTMAN_TEAM_SLUG }}
          aws_role_arn: \${{ vars.AWS_OIDC_ROLE_ARN || vars.AWS_ROLE_ARN }}
          aws_region: \${{ vars.AWS_REGION || 'eu-central-1' }}
        env: { AWS_ACCESS_KEY_ID: "\${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_ACCESS_KEY_ID || '' }}", AWS_SECRET_ACCESS_KEY: "\${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_SECRET_ACCESS_KEY || '' }}" }
      - uses: ./.actions/internal-catalog/.github/actions/finalize
        with:
          project_name: \${{ inputs.project_name }}
          runtime_mode: \${{ inputs.runtime_mode }}
          deployment_mode: \${{ inputs.deployment_mode }}
          github_workspace_sync: \${{ inputs.github_workspace_sync }}
          environment_sync_enabled: \${{ inputs.environment_sync_enabled }}
          k8s_discovery_workspace_link: \${{ inputs.k8s_discovery_workspace_link }}
          environments: \${{ inputs.environments }}
          system_env_map: \${{ inputs.system_env_map }}

          workspace_id: \${{ needs.postman_bootstrap.outputs.workspace_id }}
          workspace_team_id: \${{ inputs.workspace_team_id }}
          baseline_uid: \${{ needs.postman_bootstrap.outputs.baseline_uid }}
          smoke_uid: \${{ needs.postman_bootstrap.outputs.smoke_uid }}
          contract_uid: \${{ needs.postman_bootstrap.outputs.contract_uid }}
          image_uri: \${{ needs.aws_deploy.outputs.image_uri }}
          runtime_base_url: \${{ needs.aws_deploy.outputs.runtime_base_url }}
          insights_project_id: \${{ needs.aws_deploy.outputs.insights_project_id }}
          ecs_service_name: \${{ needs.aws_deploy.outputs.ecs_service_name }}
          ecs_target_group_arn: \${{ needs.aws_deploy.outputs.ecs_target_group_arn }}
          ecs_listener_rule_arn: \${{ needs.aws_deploy.outputs.ecs_listener_rule_arn }}
          ecs_task_definition: \${{ needs.aws_deploy.outputs.ecs_task_definition }}
          k8s_namespace: \${{ needs.aws_deploy.outputs.k8s_namespace }}
          k8s_deployment_name: \${{ needs.aws_deploy.outputs.k8s_deployment_name }}
          k8s_service_name: \${{ needs.aws_deploy.outputs.k8s_service_name }}
          k8s_ingress_name: \${{ needs.aws_deploy.outputs.k8s_ingress_name }}
          env_uids: \${{ needs.aws_deploy.outputs.env_uids_json }}
          dev_gw_url: \${{ needs.aws_deploy.outputs.dev_gw_url }}
          prod_gw_url: \${{ needs.aws_deploy.outputs.prod_gw_url }}
          dev_api_id: \${{ needs.aws_deploy.outputs.dev_api_id }}
          prod_api_id: \${{ needs.aws_deploy.outputs.prod_api_id }}
          gw_urls_json: \${{ needs.aws_deploy.outputs.gw_urls_json }}
          gw_ids_json: \${{ needs.aws_deploy.outputs.gw_ids_json }}
          env_runtime_urls_json: \${{ needs.aws_deploy.outputs.env_runtime_urls_json }}
          env_resource_names_json: \${{ needs.aws_deploy.outputs.env_resource_names_json }}
          environment_deployments_json: \${{ needs.aws_deploy.outputs.environment_deployments_json }}

          postman_team_id: \${{ inputs.postman_team_id || '${fallbackTeamId}' }}
          postman_api_key: \${{ env.POSTMAN_API_KEY }}
          postman_access_token: \${{ env.POSTMAN_ACCESS_TOKEN }}
          github_app_token: \${{ github.token }}
          push_token: \${{ secrets.GH_TOKEN }}
          ci_workflow_base64: ${ciWorkflowBase64}
          gh_fallback_token: \${{ secrets.GH_TOKEN || '' }}
          gh_auth_mode: \${{ vars.GH_AUTH_MODE || 'github_token_first' }}
          fern_token: \${{ secrets.FERN_TOKEN }}
          committer_name: "${committerName}"
          committer_email: "${committerEmail}"
        env:
          ECS_CLUSTER_NAME: \${{ vars.ECS_CLUSTER_NAME }}
          BIFROST_ENV_ASSOCIATION_ENABLED: \${{ vars.BIFROST_ENV_ASSOCIATION_ENABLED || 'true' }}
          POSTMAN_INSIGHTS_CLUSTER_NAME: \${{ vars.POSTMAN_INSIGHTS_CLUSTER_NAME }}

  cleanup:
    needs: [postman_bootstrap, docker_build, aws_deploy, finalize]
    if: \${{ failure() && vars.CLEANUP_ON_FAILURE == 'true' }}
    runs-on: ubuntu-latest-8-cores
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v6.0.2
        with:
          repository: ${actionRepo}
          ref: \${{ vars.PROVISION_ACTIONS_REF || 'main' }}
          token: \${{ secrets.GH_TOKEN }}
          persist-credentials: false
          path: .actions
      - name: Resolve Credentials
        uses: ./.actions/internal-catalog/.github/actions/resolve-credentials
        with:
          provider: \${{ vars.SECRET_PROVIDER || 'aws-secrets-manager' }}
          postman_team_slug: \${{ inputs.postman_team_slug || vars.POSTMAN_TEAM_SLUG }}
          aws_role_arn: \${{ vars.AWS_OIDC_ROLE_ARN || vars.AWS_ROLE_ARN }}
          aws_region: \${{ vars.AWS_REGION || 'eu-central-1' }}
        env: { AWS_ACCESS_KEY_ID: "\${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_ACCESS_KEY_ID || '' }}", AWS_SECRET_ACCESS_KEY: "\${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_SECRET_ACCESS_KEY || '' }}" }
      - name: Configure AWS credentials (OIDC)
        if: \${{ vars.OIDC_AWS_ENABLED == 'true' }}
        uses: aws-actions/configure-aws-credentials@v6.0.0
        with:
          role-to-assume: \${{ vars.AWS_OIDC_ROLE_ARN }}
          aws-region: \${{ vars.AWS_REGION || 'eu-central-1' }}
      - name: Configure AWS credentials (legacy static keys)
        if: \${{ vars.OIDC_AWS_ENABLED != 'true' }}
        run: |
          aws configure set aws_access_key_id "\${{ secrets.AWS_ACCESS_KEY_ID }}"
          aws configure set aws_secret_access_key "\${{ secrets.AWS_SECRET_ACCESS_KEY }}"
          aws configure set region "\${{ vars.AWS_REGION || 'eu-central-1' }}"
      - uses: ./.actions/internal-catalog/.github/actions/cleanup
        with:
          project_name: \${{ inputs.project_name }}
          runtime_mode: \${{ inputs.runtime_mode }}
          environments: \${{ inputs.environments }}

          postman_api_key: \${{ env.POSTMAN_API_KEY }}
          github_app_token: \${{ github.token }}
          aws_access_key_id: \${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_ACCESS_KEY_ID || '' }}
          aws_secret_access_key: \${{ vars.OIDC_AWS_ENABLED != 'true' && secrets.AWS_SECRET_ACCESS_KEY || '' }}
          aws_region: \${{ vars.AWS_REGION || 'eu-central-1' }}
        env:
          ECS_CLUSTER_NAME: \${{ vars.ECS_CLUSTER_NAME }}
`;
}
