# API Catalog Demo Infra

Single Cloudflare Worker serving the catalog admin portal and provisioning APIs.

## Links

- Live demo portal: `https://se.pm-catalog.dev/`
- Postman team workspace: `https://field-services-v12-demo.postman.co`
- Full internal docs index: [`docs/README.md`](./docs/README.md)

## Service

- Worker name: `vzw-partner-demo`
- Entry: `src/index.ts`
- Worker config: `wrangler.toml`

## Intro

This repository is the demo control plane for showing **Postman v12**, **API Catalog**, **Insights**, and provisioning automation in one end-to-end flow.

What this repo powers:

- Cloudflare Worker + React admin UI for selecting and provisioning services
- OpenAPI registry organized by industry/domain
- Postman asset generation and synchronization
- Runtime deployment on Lambda, ECS, and Kubernetes for live demo traffic

How to use this for demos:

1. Choose a spec from the catalog UI.
2. Provision to a runtime (`lambda`, `ecs_service`, `k8s_workspace`, `k8s_discovery`).
3. Walk through generated Postman assets (workspace, collections, environments, mocks).
4. Use ECS/Kubernetes for Insights demos so traffic and dependencies are observable.
5. Teardown after the demo.

This module is optimized for repeatable demo storytelling: **spec -> provisioned service -> Postman assets -> observed runtime behavior**.

## Deployment

Push to `main` auto-deploys the worker via `.github/workflows/deploy.yml` using:

```bash
wrangler deploy --config wrangler.toml
```

Manual deploy:

```bash
just deploy
# or
env -i HOME="$HOME" PATH="$PATH" npx wrangler deploy --config wrangler.toml
```

## Architecture Overview

- `src/` -- Worker API surface, orchestration, provisioning and teardown logic
- `frontend/` -- admin portal UI and demo operator workflows
- `specs/` -- OpenAPI catalog, generated registry, dependency graph data
- `.github/actions/` -- provisioning and bootstrap action building blocks

## Deep References

- Runtime and infrastructure details: [`docs/runtime-and-infrastructure.md`](./docs/runtime-and-infrastructure.md)
- Provisioning workflow and topology internals: [`docs/provisioning-architecture.md`](./docs/provisioning-architecture.md)
- API, auth, and operations runbook details: [`docs/operations-reference.md`](./docs/operations-reference.md)

Operational pointers:

- Recovery Queue workflow: [`docs/operations-reference.md#recovery-queue-workflow`](./docs/operations-reference.md#recovery-queue-workflow)
- Multi-environment teardown behavior: [`docs/operations-reference.md#multi-environment-teardown-behavior`](./docs/operations-reference.md#multi-environment-teardown-behavior)
- Backfill script usage: [`docs/operations-reference.md#backfill-script`](./docs/operations-reference.md#backfill-script)
- Team credential sync architecture: [`docs/operations-reference.md#team-credential-sync-architecture`](./docs/operations-reference.md#team-credential-sync-architecture)

## Adding a New Industry

Specs are organized by industry in `specs/<industry>/` subdirectories. To add a new industry:

1. **Create the industry folder and add spec files:**

```bash
mkdir specs/<industry>
# Add OpenAPI 3.x YAML spec files into specs/<industry>/
```

Each spec must include these `info` fields:
- `title` -- API display name
- `description` -- non-empty description
- `version` -- semver string
- `x-acme-catalog-id` -- must match the filename without `.yaml` (e.g., `av-ev-charging-stations` for `av-ev-charging-stations.yaml`)
- `x-acme-domain` -- domain grouping within the industry (e.g., `ev-services`, `telematics`)

2. **Register the industry in the UI:**

Add an entry to `frontend/src/lib/industries.ts`:

```typescript
{ id: "<industry>", label: "Display Name", description: "Short description" },
```

Add domain colors for any new domains to `frontend/src/lib/domain-colors.ts`.

3. **Regenerate registry and dependencies:**

```bash
node scripts/generate-registry.mjs
node scripts/bootstrap-graph.mjs
node scripts/validate-dependencies.mjs
```

`generate-registry.mjs` scans all industry subdirectories and rebuilds `specs/registry.json`.
`bootstrap-graph.mjs` adds dependency entries for new services without modifying existing ones.

4. **Validate and build:**

```bash
npm run validate:specs   # regression tests for spec structure and registry integrity
npm test                 # full test suite
npm run build            # frontend build
```

## Local Development

```bash
npm install
npm run dev
```

`npm run dev` is the primary local workflow. It runs the app through Vite with the Cloudflare worker runtime on the same local origin so the UI, `/api/*` routes, and style updates stay in one loop.

Important local-dev behavior:

- The `dev` script sets `LOCAL_DEV_AUTH_MODE=bypass`, which allows loopback browser requests to reach protected worker APIs locally without a CF Access JWT.
- `LOCAL_DEV_AUTH_MODE=strict` keeps localhost requests protected and is the fallback behavior outside the unified dev script.
- The local worker still performs real actions. Provisioning, teardown, GitHub, AWS, Airtable, Postman, and Bifrost calls all use your configured local credentials.
- Local bootstrap credentials still come from the repo `.env` / Secrets Manager flow. There is no separate `.dev.vars` source of truth.
- `/specs/*` is served directly from the repo `specs/` directory during local dev and is still copied into `public/specs` during `npm run build`.

Fallback and debug workflows remain available:

```bash
npm run dev:frontend   # Vite-only fallback/debug path
npm run dev:worker     # Wrangler-only fallback/debug path
```

## Tests

```bash
npm test
```
