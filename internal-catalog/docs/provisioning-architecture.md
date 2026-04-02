# Provisioning Architecture

> **Document role:** Reference
> **Canonical parent:** vzw/internal-catalog/docs/README.md

## Provisioning Workflow Architecture

The generated `provision.yml` runs as 4 parallel jobs:

```
postman_bootstrap --|
                    |--> aws_deploy --> finalize
docker_build -------|
```

| Job | Runner | Purpose |
|-----|--------|---------|
| `postman_bootstrap` | `ubuntu-24.04-arm` | Workspace, spec upload, lint, 3x collection generation (parallel), test injection, tagging |
| `docker_build` | `ubuntu-24.04-arm` | Container preflight + Docker ARM64 build + ECR push (skipped for lambda mode) |
| `aws_deploy` | `ubuntu-24.04-arm` | ECS deploy + sidecar verification, OR Lambda deploy, OR k8s manifest apply + rollout + health check |
| `finalize` | `ubuntu-24.04-arm` | Environments, mock server, repo variables, artifact export, Bifrost, commit |

Concurrency: `provision-${{ inputs.project_name }}` prevents two provisions for the same project from running simultaneously.

## Current Provisioning Behavior

- Workflow dispatch supports multiple environments (e.g., `environments=["prod", "stage"]`). Defaults to all discovered system environments if omitted.
- `postman_bootstrap` can derive the effective Postman team ID from the `/me` API when `postman_team_id` is not provided explicitly. Existing explicit team ID inputs still override the derived value.
- `postman_team_slug` is resolved during provisioning and canonicalized to the effective Postman team identity before secrets, workflow inputs, and repo variables are written. If a request supplies both `postman_team_slug` and `postman_team_id`, they must agree with the team-registry resolution.
- Repo secrets are resolved at provision time and injected directly into the repository.
- For multi-environment requests, runtime deployment fans out per selected environment and creates isolated environment-scoped resources (Lambda/API Gateway, ECS service/TG/rule, or k8s deployment/service/ingress).
- For multi-environment requests, provisioning creates one repository branch per environment using `env/<slug>` naming. Branch creation is idempotent and safe for retries.
- Finalize persists `ENVIRONMENT_DEPLOYMENTS_JSON` and `ENV_RESOURCE_NAMES_JSON` repo variables plus Airtable `environment_deployments` with per-environment runtime URL, `postman_env_uid`, `system_env_id`, status, deployment timestamp, and branch.
- Finalize exports Baseline, Smoke, and Contract collections to `postman/collections/[Label] <project>/` as Collection v3 multi-file YAML, then writes matching `.postman/resources.yaml` `cloudResources.collections` entries for those local directories.
- `system_env_map` input (JSON string) provides slug-to-UUID mapping for Bifrost associations.
- ECS runtime uses system environment IDs for environment creation and Insights association across all environments.
- k8s_workspace also supports multi-environment association via Bifrost.
- k8s_discovery requires `POSTMAN_INSIGHTS_CLUSTER_NAME` for auto-discovery registration.
- `k8s_discovery_workspace_link` (default `false`) controls whether discovery mode creates/links a Postman workspace:
  - `false`: skips workspace bootstrap/linking/finalize artifact export.
  - `true`: runs the full workspace bootstrap and linking flow.
- Insights prerequisites are fail-fast and ordered before sidecar startup:
  1. create Postman environments for all requested slugs
  2. link workspace to repo via Bifrost filesystem
  3. associate environment UIDs to system environment IDs directly via Bifrost using the provisioned repo's resolved `POSTMAN_ACCESS_TOKEN` and canonical `postman_team_id`
  4. deploy/verify ECS sidecar or k8s pod
- Postman credentials are NOT repo-injected. Instead, `POSTMAN_API_KEY` and `POSTMAN_ACCESS_TOKEN` are dynamically resolved at runtime from AWS Secrets Manager using the `resolve-credentials` GitHub composite action.
- ECS sidecar task definition adds `NET_RAW` capability for packet capture.
- For k8s modes, the workflow decodes `KUBECONFIG_B64`, generates Deployment/Service/Ingress manifests, and applies them to the `vzw-partner-demo` namespace.

## Flask Route Generation

For registry-based specs, `src/lib/spec-to-flask.ts` parses the OpenAPI spec and generates `app/routes.py`, `app/__init__.py`, and `app/models.py` with matching Flask routes for every endpoint. This **overrides** the fallback templates in `src/lib/boilerplate.ts`. Changes to Flask routing must be made in `spec-to-flask.ts`.

The generated `__init__.py` reads `API_BASE_PATH` from the environment (set in the ECS task definition) and applies it as `url_prefix` on both Flask blueprints (`ops_bp` for health, `api_bp` for API routes). This is required because the ALB forwards the full original path (e.g., `/svc/af-cards-3ds/health`) to containers.

## ECS Service Lifecycle

The provisioning workflow handles all ECS service states:

| State | Action |
|-------|--------|
| `ACTIVE` | `update-service --force-new-deployment` |
| `DRAINING` | `delete-service --force`, poll until INACTIVE (10s interval, 10min timeout), then `create-service` |
| `INACTIVE` / `MISSING` | `create-service` |

ALB target groups use `deregistration_delay.timeout_seconds=30` (reduced from default 300s) to minimize the DRAINING window.

## Service Graph / Topology Provisioning

The worker natively supports "Topology Provisioning" via dependency graphs. Instead of provisioning one service at a time and manually satisfying prerequisites, you can request an entire subgraph.

- **`deployment_mode: "graph"`**: Resolves the full `dependsOn` closure for the requested `spec_source` via Kahn's algorithm, builds a topological execution plan, and Provisions/Reuses nodes layer-by-layer (up to 5 concurrent jobs per layer).
- Graph metadata (`deployment_group_id`, `deployment_root_spec_id`, `graph_node_meta_json`) is attached to all Airtable deployment records.
- To validate the graph or bulk-remediate missing prerequisites, run the planner-backed remediation script:

```bash
# Validates active deployments against specs/dependencies.json without provisioning
node scripts/remediate-k8s-topology.mjs --dry-run --environment prod

# Actively remediates missing k8s_workspace dependencies by triggering graph provisions
node scripts/remediate-k8s-topology.mjs --environment prod
```

## Traffic Generation

Use `scripts/blast-traffic.sh` to generate realistic API traffic across deployed k8s services for Insights endpoint modeling and dependency graph construction.
By default, this script spins up a temporary pod *inside* the K8s cluster so the generated traffic has a pod IP (ClusterIP routing) preserving the origin identity required for building sidecar dependency edges.

```bash
./scripts/blast-traffic.sh              # default: 3 rounds (internal pod)
./scripts/blast-traffic.sh --external   # test via NLB ingress (appears as external traffic to Insights)
./scripts/blast-traffic.sh --rounds 10  # custom rounds
```

## Provisioning Spec Source

- Provisioning is registry-only.
- The UI selects entries from `specs/registry.json` and sends `spec_source`; the worker derives canonical `/specs/<filename>` server-side.
- Inline `spec_content`, `custom-upload`, `custom-url`, and preloaded-spec fallback are not supported.
- `spec_url` is temporarily accepted for legacy callers:
  - If it maps to a known registry filename, the worker normalizes to canonical registry URL.
  - Non-registry URLs follow a legacy compatibility path and should be migrated to `spec_source`.
