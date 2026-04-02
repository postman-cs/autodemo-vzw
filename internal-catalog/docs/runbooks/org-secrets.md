# Org Secrets Migration Runbook
> **Document role:** Runbook
> **Canonical parent:** vzw/internal-catalog/docs/README.md

Use `scripts/migrate-org-actions-secrets.ts` only for shared infrastructure secrets. Do not use it for `POSTMAN_API_KEY` or `POSTMAN_ACCESS_TOKEN`; those are dynamically resolved at runtime from AWS Secrets Manager using the `resolve-credentials` action based on the `POSTMAN_TEAM_SLUG` variable.

## Dry Run

```bash
GH_ADMIN_TOKEN=... npx tsx scripts/migrate-org-actions-secrets.ts --dry-run
```

## Apply

```bash
GH_ADMIN_TOKEN=... \
KUBECONFIG_B64=... \
FERN_TOKEN=... \
GH_TOKEN=... \
AWS_ACCESS_KEY_ID=... \
AWS_SECRET_ACCESS_KEY=... \
AWS_LAMBDA_ROLE_ARN=... \
npx tsx scripts/migrate-org-actions-secrets.ts
```

## Rollback

```bash
GH_ADMIN_TOKEN=... npx tsx scripts/migrate-org-actions-secrets.ts --rollback
```

Rollback sets `ORG_SECRETS_ENABLED=false` on selected repositories. Postman credentials remain repo-scoped regardless.
