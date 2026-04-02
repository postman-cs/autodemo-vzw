# Operations Reference

> **Document role:** Operations
> **Canonical parent:** vzw/internal-catalog/docs/README.md

## API Routes

- `GET /api/health`
- `GET /api/config`
- `GET /api/deployments`
- `POST /api/deployments`
- `GET /api/deployments/:spec_id`
- `PATCH /api/deployments/:spec_id`
- `PATCH /api/deployments/:spec_id/dependencies`
- `POST /api/provision`
- `POST /api/provision/plan`
- `POST /api/provision/graph`
- `GET /api/provision/graph/:id`
- `GET /api/teams`
- `GET /api/teams/registry` (GET/POST/PUT/DELETE)
- `GET /api/teams/registry/:slug/health`
- `POST /api/teams/registry/reconcile`
- `GET /api/users`
- `POST /api/teardown`
- `POST /api/teardown/batch`
- `GET /api/status`
- `GET /api/infra/resources`
- `POST /api/infra/setup`
- `POST /api/infra/teardown`
- `POST /api/infra/k8s-discovery/setup`
- `POST /api/infra/k8s-discovery/teardown`
- `GET /api/resources`
- `GET /api/resources/:service`
- `GET /api/worker-logs?request_id=...`
- `GET /api/backstage/catalog.yaml` (machine-authenticated feed)
- `GET /api/system-envs`
- `POST /api/system-envs/refresh`
- `GET /api/github/org-members`
- `POST /api/github/webhook`
- `GET /api/catalog`
- `GET /api/catalog/:service_id`
- `PATCH /api/catalog/:service_id/chaos`

## Worker Request Logs

The worker now emits request-scoped logs to the `WORKER_LOGS` KV namespace with a 24 hour TTL.

- Every response includes `x-request-id`.
- `POST /api/provision` propagates that request id into pipeline log persistence.
- `GET /api/worker-logs?request_id=<id>` returns the log entries for that request.

Current binding in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "WORKER_LOGS"
id = "76a440e57b7d4f12a01c239dac1fcf61"
```

Typical debugging flow:

1. Capture the `x-request-id` header from a failing worker response.
2. Call `GET /api/worker-logs?request_id=<id>`.
3. Review `request.received`, `provision.log`, `request.completed`, and `request.failed` events for that request.

`GET /api/deployments` response includes:

- `deployments`: existing Airtable deployment rows
- `recoverable_failures`: recoverable failed rows (for Recovery Queue), deduped to latest per service and excluding deprovisioned tombstones

## Worker Auth (GitHub OAuth)

The portal can be gated in-worker with GitHub OAuth + org membership checks.

Required worker secrets/vars:

- `AUTH_ENABLED=true`
- `GITHUB_CLIENT_ID` (preferred)
- `GITHUB_CLIENT_SECRET` (preferred)
- `AUTH_SESSION_SECRET` (32+ chars)
- `AUTH_ALLOWED_GITHUB_ORGS=postman-eng,postman-fde,postman-cs`

Optional:

- `AUTH_SESSION_TTL_SECONDS` (default `3600`)
- `AUTH_COOKIE_NAME` (default `catalog_admin_session`)
- `AUTH_GITHUB_REDIRECT_URI` (defaults to `{origin}/auth/callback`)

Auth endpoints:

- `GET /auth/login`
- `GET /auth/callback`
- `GET /auth/logout`
- `GET /auth/error`

Callback behavior:

- Successful login sets the session cookie and redirects to `next`.
- Callback failures redirect to `/auth/error` with a code (`oauth_denied`, `invalid_state`, `not_authorized`, `org_access_required`, `upstream_error`) so users see a UI page instead of raw JSON.
- Org-related failures include per-org diagnostics in `org_statuses` (org, HTTP status, membership state) so `/auth/error` can show exactly which checks failed.
- Org authorization is treated as "member of any allowed org". A `403` for one org does not block login if another allowed org membership is `active` or `pending`.

Compatibility note: `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` are still accepted as legacy fallback names.

Auth deployment checklist:

1. Create/confirm OAuth app callback URL is `https://se.pm-catalog.dev/auth/callback`.
2. Set `AUTH_ENABLED`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `AUTH_SESSION_SECRET`, and `AUTH_ALLOWED_GITHUB_ORGS`.
3. Deploy worker and hit `/auth/login`.
4. Verify successful login redirects back to `/` or requested `next` path.
5. Verify non-org users are redirected to `/auth/error` and cannot access `/` or protected `/api/*`.

## Backstage Feed

`GET /api/backstage/catalog.yaml` emits a Backstage entity feed for active deployments.

- Authentication: `Authorization: Bearer <CATALOG_BACKSTAGE_FEED_TOKEN>`
- Content type: `text/yaml`
- Data source: Airtable active deployments + Postman Spec Hub (`postman_spec_uid`)
- Behavior: fetch failures for individual specs fall back to a placeholder OpenAPI definition so the full feed still renders.

Required worker secret for feed access:

- `CATALOG_BACKSTAGE_FEED_TOKEN`

Optional:

- `BACKSTAGE_OWNER_ENTITY` (default `group:default/postman-fde`)

## Recovery Queue Workflow

When provisioning fails after partial resource creation (for example GitHub repo conflict), operators should recover through Deployed Services:

1. Open **Deployed Services** and review **Recovery Queue**.
2. Run **teardown recovery** for affected services (single or batch).
3. Retry provisioning from **Provision** once recovery succeeds.

Recovery Queue is sourced from `recoverable_failures` and is designed to persist beyond transient batch-error popups.

## Multi-Environment Teardown Behavior

- Teardown disassociates all known Postman environment UID -> system environment mappings for the service before workspace deletion.
- For multi-environment ECS/k8s deployments, teardown consumes `ENV_RESOURCE_NAMES_JSON` and `ENVIRONMENT_DEPLOYMENTS_JSON` when present and deletes resources per environment instance.
- If those variables are missing, teardown falls back to Airtable `environment_deployments` and runtime prefix discovery to avoid stale resources.
- Teardown keeps shared discovery infrastructure intact for `k8s_discovery`; only per-service workload resources are removed.

## Rollout and Fallback Guidance

- Rollout increment: start with one multi-environment ECS service (`["stage","prod"]`), verify both env branches and both runtime URLs, then expand to k8s modes.
- Rollback path: fall back to single-environment provisioning by selecting one environment until issue triage is complete.
- If teardown cannot resolve env resource names from repo variables, verify `ENV_RESOURCE_NAMES_JSON` and `ENVIRONMENT_DEPLOYMENTS_JSON` and re-run teardown; Airtable fallback should still recover most cases.

## Backfill Script

Backfill missing `postman_spec_uid` values from GitHub repo variables (`POSTMAN_SPEC_UID`) into Airtable Deployments:

```bash
# dry-run
npm run backfill:postman-spec-uids

# apply updates
npm run backfill:postman-spec-uids -- --apply
```

## Team Credential Sync Architecture

Team credentials are synchronized across two runtime stores, with an optional local 1Password mirror for operators:

```
AWS Secrets Manager (authority)
         |
         |---> Cloudflare KV (runtime cache)

Local developer machine
         |
         |---> 1Password Vault (operator mirror via git hook)
```

### Source of Truth Hierarchy

1. **AWS Secrets Manager** is the authority. All credential changes flow through SM first.
2. **Cloudflare KV** (`TEAM_REGISTRY` namespace) is the worker's runtime cache.
3. **1Password** is an optional local mirror driven by the git pre-commit hook.

### Local 1Password Mirror

- `scripts/install-hooks.sh` installs the repo hooks and wires `scripts/sync-1password.sh` into `pre-commit`.
- `scripts/sync-1password.sh` reads `POSTMAN_TEAM__<SLUG>__API_KEY` and `POSTMAN_TEAM__<SLUG>__ACCESS_TOKEN` entries from `.env` and creates or updates one 1Password item per team.
- The default vault id is `m6hrbahxfdgv56kkxrntu3aqya`.
- Override locally with `ONEPASSWORD_VAULT_ID` or `ONEPASSWORD_VAULT` when needed.
- Items are titled `Team: {slug}` and tagged with `managed-by:vzw-partner-demo` plus `team-slug:{slug}`.

### Setup and Verification

```bash
bash scripts/install-hooks.sh
bash scripts/sync-1password.sh
```

Expected behavior:

- If `op` is unavailable or signed out, the script skips sync without blocking other repo workflows.
- If `.env` has no `POSTMAN_TEAM__...` entries, the script reports that there is nothing to sync.
- If matching entries exist, the script upserts one item per team into the configured vault.
