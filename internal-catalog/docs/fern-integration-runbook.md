# Fern Integration Runbook
> **Document role:** Runbook
> **Canonical parent:** vzw/internal-catalog/docs/README.md


This runbook covers the centralized Fern integration that starts after a provision succeeds. It is the operator reference for the data flow, concurrency model, failure policy, recovery steps, and regression harness.

## Ownership

- `internal-catalog` maintainers own canonical metadata derivation in `internal-catalog/src/lib/docs-manifest.ts` and the Worker endpoints in `internal-catalog/src/index.ts`.
- Main repo maintainers own unified docs artifact generation in `fern/scripts/generate-unified-docs-artifacts.mjs` and publishing in `.github/workflows/unified-fern-publish.yml`.
- Provisioned repo maintainers do not own shared-site publishing. Per-repo Fern config may exist for local preview, but it must not publish `verizon-demo.docs.buildwithfern.com`.
- On-call recovery for publish failures belongs to the main repo maintainers because the shared workflow and shared Fern token live in this repository.

## What changed

- Provision completion and shared docs publication are now separate concerns.
- Runtime consumers read canonical metadata from manifest-backed endpoints instead of hand-maintained Fern maps.
- The shared site is published only from this repository.
- Docs publication is eventually consistent. Infrastructure success is recorded even if the docs publish path is delayed or fails.

## Data flow

1. A service provision completes and finalize writes canonical deployment metadata into Airtable.
2. The central workflow in `.github/workflows/unified-fern-publish.yml` is triggered by `repository_dispatch` or manual `workflow_dispatch`.
3. The workflow runs `node fern/scripts/generate-unified-docs-artifacts.mjs`.
4. The generator loads the canonical manifest from `internal-catalog/src/lib/docs-manifest.ts`, using live Airtable-backed deployment data when available and the fixture only as a fallback.
5. Generated outputs overwrite `fern/docs.yml`, `fern/apis/*/generators.yml`, `fern/pages/landing.mdx`, and `fern/pages/services/*.mdx`.
6. The workflow publishes the unified site with `npx fern generate --docs` from `fern/`.
7. Runtime consumers read the same canonical contract through these Worker endpoints:
   - `GET /api/docs-manifest`
   - `GET /api/public/service-map`
   - `GET /api/partner/services/:service_id/live`

## Canonical contract

- `buildCanonicalManifest()` is the only source that derives Fern tab slugs, Fern deep links, Postman workspace links, and the route-to-service map.
- Canonical Fern URLs must use `https://verizon-demo.docs.buildwithfern.com/<tab-slug>/<api-slug>`.
- Canonical Postman URLs must use `https://verizon-partner-demo.postman.co/workspace/<workspace-id>`.
- `partner-catalog.ts` reuses the same manifest builder, so partner catalog data and Fern runtime routing stay aligned.

## Concurrency behavior

- Shared docs publication is serialized by `.github/workflows/unified-fern-publish.yml` with `concurrency.group: fern-publish`.
- `cancel-in-progress: false` is intentional. A second publish waits for the first publish to finish so concurrent provisions cannot clobber generated artifacts or publish partial state.
- Provision workflows remain independently concurrent by service. The shared docs workflow is the only serialized part of the path.
- Because publication is serialized, a successful provision may appear in Airtable and runtime APIs before it appears on the public Fern site.

## Failure policy

- Infrastructure success is authoritative for the provision pipeline.
- A failed unified docs publish must not mark the service deploy as failed.
- A docs publish failure means one of two things:
  - Runtime APIs already have the correct canonical metadata, but the public site is stale.
  - Canonical source data is wrong, and both runtime APIs and the public site will stay wrong until the source is fixed.
- Do not use `internal-catalog/scripts/backfill-fern-docs.mjs` for this flow. That script reflects the old per-repo publish model and can overwrite the shared site.

## Fast triage

1. Check whether the canonical metadata is already correct.
2. If metadata is correct, retry the shared publish workflow.
3. If metadata is wrong, fix the source data first, then rerun the shared publish workflow.

## Recovery procedure

### 1. Confirm the trigger path

- Inspect the latest `Unified Fern Publish` run in GitHub Actions.
- Expected trigger types are `provision_success`, `publish_fern`, or manual `workflow_dispatch`.
- If no run exists after a successful provision, inspect the finalize logs in the provisioned repo and verify the dispatch payload reached the main repo.

### 2. Validate canonical metadata

Run the regression harness:

```bash
cd internal-catalog
npm run test:fern-harness
```

Expected result:

- Workflow assertions pass for `.github/workflows/unified-fern-publish.yml`
- Manifest assertions pass for canonical Fern and Postman URLs
- Dynamic endpoint assertions pass for `/api/docs-manifest`, `/api/public/service-map`, and `/api/partner/services/:service_id/live`

### 3. Inspect live endpoints when the harness says source data is wrong

```bash
curl -H "CF-Access-Client-Id: 4b79c30fec111a0fc680932790bd9322.access" \
     -H "CF-Access-Client-Secret: 5af200456aa0657f66ea73762b1bac7a0f9d99bea0fdd70a5a40994e6e78245d" \
     https://vzw.pm-demo.dev/api/docs-manifest

curl https://vzw.pm-demo.dev/api/public/service-map

curl https://vzw.pm-demo.dev/api/partner/services/vzw-network-operations-api/live
```

What to check:

- Fern URLs use `/<tab-slug>/<api-slug>`, not `/docs/api-reference/<service>`
- Postman URLs use `postman.co/workspace/<workspace-id>`
- The service map contains the expected route key for the affected service

### 4. Retry publication when metadata is already correct

Use either GitHub Actions UI or `gh`:

```bash
gh workflow run unified-fern-publish.yml --repo postman-cs/vzw-partner-demo
```

Then watch the run:

```bash
gh run watch --repo postman-cs/vzw-partner-demo
```

### 5. Fix source data when metadata is wrong

- Confirm the deployment record in Airtable has the right `workspace_team_id`, `workspace_id`, `github_repo_name`, and active status.
- Confirm `internal-catalog/specs/registry.json` and `internal-catalog/specs/dependencies.json` still place the service in the correct graph.
- Rerun the harness after the source fix.
- Rerun `unified-fern-publish.yml` only after the harness passes.

## Regression harness

Primary command:

```bash
cd internal-catalog
npm run test:fern-harness
```

Intentional failure drill:

```bash
cd internal-catalog
npm run test:fern-harness -- --bad-url-fixture
```

The failure drill injects a stale Fern URL shape into the assertions and must fail with a canonical-format error. Use it when validating the harness itself or during on-call readiness review.

## Evidence checklist for incident closure

- The latest `Unified Fern Publish` run completed successfully.
- `npm run test:fern-harness` passed locally.
- `GET /api/docs-manifest` shows canonical Fern and Postman URLs for the affected service.
- `GET /api/public/service-map` resolves the affected route.
- `GET /api/partner/services/:service_id/live` returns the same canonical links seen in the manifest.

## Anti-patterns

- Do not publish the shared site from a provisioned repo.
- Do not treat a docs publish failure as an infrastructure rollback signal.
- Do not patch `fern/docs.yml` or `fern/apis/*/generators.yml` by hand after generation.
- Do not use stale `app.getpostman.com` or `/docs/api-reference/<service>` links as valid output.
