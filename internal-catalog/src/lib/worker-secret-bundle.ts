/**
 * WorkerSecretBundle — secrets fetched from AWS Secrets Manager at cold start.
 * Only AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION remain as CF secrets
 * (bootstrap credentials). Everything else lives in SM at /vzw-partner-demo/worker-env.
 */
export interface WorkerSecretBundle {
  POSTMAN_API_KEY?: string;
  POSTMAN_ACCESS_TOKEN?: string;
  POSTMAN_TEAM_ID?: string;
  POSTMAN_TEAM_NAME?: string;
  GH_TOKEN?: string;
  GH_TOKEN_SECONDARY?: string;
  AWS_LAMBDA_ROLE_ARN?: string;
  AIRTABLE_API_KEY?: string;
  AIRTABLE_BASE_ID?: string;
  CF_ZONE_ID?: string;
  CF_EMAIL?: string;
  CF_API_KEY?: string;
  CF_WORKER_SUBDOMAIN?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  CLOUDFLARE_EMAIL?: string;
  CLOUDFLARE_API_KEY?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  TENANT_SECRETS_SYNC_ENABLED?: string;
  TENANT_SECRETS_AWS_ACCESS_KEY_ID?: string;
  TENANT_SECRETS_AWS_SECRET_ACCESS_KEY?: string;
  TENANT_SECRETS_AWS_REGION?: string;
  TENANT_SECRETS_PREFIX?: string;
  CATALOG_BACKSTAGE_FEED_TOKEN?: string;
  BACKSTAGE_OWNER_ENTITY?: string;
  GITHUB_APP_AUTH_ENABLED?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY_PEM?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  FERN_TOKEN?: string;
  KUBECONFIG_B64?: string;
  K8S_NAMESPACE?: string;
  K8S_CONTEXT?: string;
  K8S_INGRESS_BASE_DOMAIN?: string;
  POSTMAN_INSIGHTS_CLUSTER_NAME?: string;
  ORG_SECRETS_ENABLED?: string;
  ORG_VARS_ENABLED?: string;
  PAT_FALLBACK_ENABLED?: string;
  OIDC_AWS_ENABLED?: string;
  WORKFLOW_CALLBACKS_ENABLED?: string;
  [key: string]: string | undefined;
}

export interface SmBootstrapCredentials {
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_REGION: string;
}

export const SM_SECRET_PATH = "/vzw-partner-demo/worker-env";
