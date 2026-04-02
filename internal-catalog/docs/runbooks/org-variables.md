# Org Variables Migration Runbook
> **Document role:** Runbook
> **Canonical parent:** vzw/internal-catalog/docs/README.md

Use `scripts/migrate-org-actions-vars.ts` to upsert shared infra variables and selected repo bindings.

## Dry Run

```bash
GH_ADMIN_TOKEN=... npx tsx scripts/migrate-org-actions-vars.ts --dry-run
```

## Apply

```bash
GH_ADMIN_TOKEN=... \
ECS_CLUSTER_NAME=... \
ECS_VPC_ID=... \
ECS_SUBNET_IDS=... \
ECS_SECURITY_GROUP_IDS=... \
ECS_EXECUTION_ROLE_ARN=... \
ECS_TASK_ROLE_ARN=... \
ECS_ALB_LISTENER_ARN=... \
ECS_ALB_DNS_NAME=... \
ECS_ECR_REPOSITORY=... \
ECS_MAX_SERVICES=... \
K8S_NAMESPACE=... \
K8S_INGRESS_BASE_DOMAIN=... \
K8S_CONTEXT=... \
POSTMAN_INSIGHTS_CLUSTER_NAME=... \
npx tsx scripts/migrate-org-actions-vars.ts
```

## Rollback

```bash
GH_ADMIN_TOKEN=... npx tsx scripts/migrate-org-actions-vars.ts --rollback
```

Rollback sets `ORG_VARS_ENABLED=false` on selected repositories.
