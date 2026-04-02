/**
 * Shared test constants -- single source of truth for deployment-specific values.
 * Import these instead of hardcoding org, domain, region, etc. in test files.
 */

export const TEST_GITHUB_ORG = "postman-cs";
export const TEST_REPO_NAME = "vzw-partner-demo";
export const TEST_WORKER_NAME = "vzw-partner-demo";
export const TEST_WORKER_DOMAIN = "se.pm-catalog.dev";
export const TEST_WORKER_URL = `https://${TEST_WORKER_DOMAIN}`;
export const TEST_AWS_REGION = "eu-central-1";
export const TEST_AWS_ACCOUNT_ID = "780401591112";
export const TEST_POSTMAN_TEAM_ID = "13347347";

export const TEST_ACTION_REPO = `${TEST_GITHUB_ORG}/${TEST_REPO_NAME}`;
export const TEST_ADMIN_REPO = TEST_REPO_NAME;
export const TEST_K8S_NAMESPACE = "vzw-partner-demo";
export const TEST_K8S_CLUSTER_NAME = "vzw-partner-demo";
export const TEST_ECR_REPOSITORY = "vzw-partner-demo";
export const TEST_GITHUB_ORG_URL = `https://github.com/${TEST_GITHUB_ORG}`;
export const TEST_MOCK_SYSTEM_ENV_ID = "4ed1a682-0394-4d71-b1a8-d24ef1af5c5b";
export const TEST_MOCK_AIRTABLE_API_KEY = "pat-test";
export const TEST_MOCK_AIRTABLE_BASE_ID = "app-test";
export const TEST_MOCK_KUBECONFIG_B64 = "dGVzdA==";
export const TEST_MOCK_K8S_INGRESS_BASE_DOMAIN = "apps.demo.internal";
export const TEST_MOCK_AWS_ACCOUNT_ID = "123456789012";
export const TEST_MOCK_REGION = "eu-west-2";
