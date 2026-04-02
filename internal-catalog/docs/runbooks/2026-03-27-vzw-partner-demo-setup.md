# VZW Partner Demo Setup Runbook (2026-03-27)
> **Document role:** Runbook (historical)
> **Canonical parent:** vzw/internal-catalog/docs/README.md

Complete record of infrastructure changes made during the 2026-03-27 setup session for the Verizon partner workspace demo.

---

## 1. Workspace Cleanup

Removed `[HTTP]` prefix from all 30 Postman workspace names via the Postman API (`PUT /workspaces/:id`). The prefix was auto-added by the provisioning bootstrap action and is not needed for the demo.

---

## 2. Kubernetes Service Graph Setup

### Problem
Service graph was not appearing in the API Catalog for the 29 K8s services.

### Root Cause
The vzw-partner-demo namespace had its own DaemonSet (separate from the se-catalog-demo one in `postman-insights-namespace`), but it was deployed with only `kube run --discovery-mode` -- missing `--repro-mode`, which is required for HTTP header capture and traceparent extraction.

### Two DaemonSets on the Cluster

| Namespace | Cluster Name | API Key | Secret Name | Purpose |
|-----------|-------------|---------|-------------|---------|
| `postman-insights-namespace` | `se-catalog-v2` | `PMAK-69b19038...` | `postman-agent-secrets` | Older se-catalog-demo + insights-lab |
| `vzw-partner-demo` | `vzw-partner-demo` | `PMAK-69c5c82b...` | `vzw-postman-agent-secrets` | This project's 29 services |

### Fix Applied

1. **Patched DaemonSet args** in `vzw-partner-demo` namespace:
   ```
   kube run --discovery-mode --debug --repro-mode --include-namespaces vzw-partner-demo
   ```

2. **Converted 29 deployments from sidecar to hostNetwork mode**:
   - Removed `postman-insights-agent` sidecar container from each deployment
   - Added `hostNetwork: true` and `dnsPolicy: ClusterFirstWithHostNet`
   - Assigned unique hostPorts (5001-5029, alphabetical by service name)

3. **Onboarded all 29 DaemonSet-discovered `svc_*` IDs**:
   - Service-level onboard: `POST /v2/api-catalog/services/onboard` (links svc_* to workspace + system_env)
   - Workspace acknowledge: `POST /v2/workspaces/{id}/onboarding/acknowledge` (via Bifrost with service `akita`)
   - Application bindings: `POST /v2/agent/api-catalog/workspaces/{id}/applications` (via observability API)
   - Repro mode enabled: `PATCH /v2/services/{id}/settings/admin` with `activate_repro_mode: true`

4. **Verified working state**:
   - `agent_status_summary: OK`
   - `sends_witness_payloads: True`
   - `agent_connection_state: CONNECTED`
   - `repro/agent-status: ALL ON`
   - Witnesses uploading successfully (12-32 per batch)

### Discovery Service ID Mapping

| Service | Discovery svc_* ID |
|---------|-------------------|
| vzw-campus-device-registry-api | svc_6G82rL5jU7itVAzPKpqoAF |
| vzw-campus-digital-twin-api | svc_4fiuh9Ui2Jul7t7ke86fD0 |
| vzw-campus-identity-proxy-api | svc_3LAPJA8CQZ909Y8MnADbJJ |
| vzw-campus-service-assurance-api | svc_1dKLSkcQ2YjFyclvi3scYi |
| vzw-city-dispatch-api | svc_0puFA9kZEXonKnum9watSc |
| vzw-crew-mobilization-api | svc_7bqlHxVDogTT93BfqKBmBJ |
| vzw-demand-response-api | svc_7kRNvIHTIYRpJ2UPvDsrEA |
| vzw-dispatch-workflow-engine-api | svc_2rUWTZGQnkkSv17jkYZtFE |
| vzw-edge-monitor-api | svc_0AZHcoLiBf8d3fSLJ51OcM |
| vzw-edge-policy-enforcement-api | svc_28taCUpOV0Il4ZSigzNunA |
| vzw-fleet-state-cache-api | svc_2a7cnZhZRfSBqh1eAJGIMl |
| vzw-geospatial-hazard-intel-api | svc_1rlEh2sA6jVMILgBaUViUB |
| vzw-grid-asset-registry-api | svc_4STuufxQhi92Ez63WrK6Ti |
| vzw-grid-topology-sync-api | svc_4AiycyQZF8okuTcxkJTDP8 |
| vzw-incident-intake-gateway-api | svc_1wM9zyBAp4JDVEvRMUOtVM |
| vzw-load-forecasting-api | svc_7clMAFO4sKdqzLu63obNC5 |
| vzw-location-routing-api | svc_0VqEiAPKJJvIAqEJSAKDts |
| vzw-meter-connectivity-api | svc_5g9MSTYdOs1WZcbnWU0nnQ |
| vzw-network-operations-api | svc_3CmIt486rKpdQlLIFuADaL |
| vzw-outage-correlation-api | svc_4EdW4c41UikUAuoz46edFa |
| vzw-qos-admission-control-api | svc_45d0TnADplTQxkFR9msjtf |
| vzw-radio-observability-stream-api | svc_01IyFp9EzrDcHB29He0CCA |
| vzw-ran-optimization-api | svc_1vbIVQQTUtf20XDB5tc24C |
| vzw-regulatory-reporting-api | svc_4UmKhs3dgBfudoAt8hNzfL |
| vzw-restoration-priority-engine-api | svc_5lFrvPvtdAepxalWMVX5rt |
| vzw-slice-orchestrator-api | svc_0b84sCbk98LX4q9NoMclNE |
| vzw-spectrum-allocation-api | svc_1uMfa0qszPoccOBxE1iyXo |
| vzw-substation-edge-gateway-api | svc_4yoUCJeVBxZhUeofjbdsU0 |
| vzw-telemetry-ingest-api | svc_3kWNvEQFFo6OgQ69rdISRa |

### Key Lesson: Sidecar vs DaemonSet Onboarding

Sidecar (workspace mode via `apidump --workspace-id ... --system-env ...`) and DaemonSet (discovery mode via `kube run --discovery-mode`) create **different `svc_*` IDs** for the same services. If you switch from sidecar to DaemonSet, the new discovery `svc_*` IDs need full onboarding (service onboard, workspace acknowledge, app binding, repro mode enable). The old sidecar `svc_*` IDs will show as OFFLINE.

---

## 3. CI/CD Pipeline Fix

### Problem
CI/CD activity not appearing in API Catalog. All CI runs failing at "Login to Postman CLI" step.

### Root Causes

**Bug 1: Missing repo variables.** The `postman_bootstrap` job in the provision workflow has a conditional that skips it for `k8s_workspace` runtime (line 191 of `provision-workflow-templates.ts`):
```yaml
if: ${{ !cancelled() && (inputs.runtime_mode != 'k8s_discovery' || inputs.k8s_discovery_workspace_link == 'true') }}
```
When bootstrap is skipped, the Postman-specific repo variables (`POSTMAN_WORKSPACE_ID`, `POSTMAN_SMOKE_COLLECTION_UID`, `POSTMAN_CONTRACT_COLLECTION_UID`, `POSTMAN_ENVIRONMENT_UID`) are never set because they're created by the bootstrap action's `storePostmanRepoVariables()`, not by the finalize action.

**Bug 2: Wrong secret reference.** The `CI_WORKFLOW_TEMPLATE` in `provision-workflow-templates.ts` used `${{ env.POSTMAN_API_KEY }}` but no step mapped the secret to the environment. Should be `${{ secrets.POSTMAN_API_KEY }}`.

### Fix Applied

1. **Set 140 repo variables** (5 per repo x 28 repos) via GitHub API:
   - `POSTMAN_WORKSPACE_ID`
   - `POSTMAN_SMOKE_COLLECTION_UID`
   - `POSTMAN_CONTRACT_COLLECTION_UID`
   - `POSTMAN_ENVIRONMENT_UID`
   - `RUNTIME_BASE_URL`

   Variable data collected from Postman API (`GET /collections?workspace=...` and `GET /environments?workspace=...`). Full mapping saved in `.omc/scientist/github_repo_variables.json`.

2. **Fixed template** in `provision-workflow-templates.ts`: Changed both `env.POSTMAN_API_KEY` references to `secrets.POSTMAN_API_KEY` (lines 27 and 64).

3. **Pushed corrected `ci.yml`** to all 28 service repos with commit message "fix: use secrets.POSTMAN_API_KEY for CLI login".

### Result
CI runs now pass. Smoke tests running with `--report-events` flag, which sends CI/CD activity data to the API Catalog.

---

## 4. Service Graph Topology Fix

### Problem
Graph showed star/hub topology (every service connected to every other) instead of the expected 3-vertical DAG.

### Root Cause Analysis (5 parallel research agents)

1. **Background dependency caller** in `boilerplate.ts` called BOTH hard AND soft deps every 2-5 seconds with fresh traceparent. Soft deps like `vzw-api-consumer-analytics-api` (referenced by 15+ services) created hundreds of single-hop traces creating a star pattern.

2. **Edge backend uses TraceID correlation**, not IP. ServiceIDs are correctly assigned per-pod even with hostNetwork (confirmed from DaemonSet logs). The IP collision concern was less severe than initially feared.

3. **Edge retention window** means old soft-dep edges persist even after fixing the traffic pattern. Model rebuilds add new edges but don't flush old ones.

### Expected Topology (from `specs/dependencies.json`)

3 independent verticals with a shared platform layer:

- **Emergency Dispatch** (9 services, 6 hops max): city-dispatch at root
- **5G Campus** (10 services, 6 hops max): campus-service-assurance at root
- **Utility Grid** (10 services, 6 hops max): regulatory-reporting at root
- **Platform** (5 services): identity-federation, api-consumer-analytics, billing-rating, notification-orchestration, webhook-delivery (these should NOT appear as graph hubs)

### Fix Applied

**Template fix** (`boilerplate.ts`):
- Line 569: Interval `random.uniform(2.0, 5.0)` -> `random.uniform(15.0, 30.0)` (6x reduction)
- Line 574: `config.get("hard", []) + config.get("soft", [])` -> `config.get("hard", [])` (eliminates soft dep noise)
- Line 581: `int(time.time() / 30)` -> `int(time.time() / 120)` (wider round-robin window)

**Live K8s patch** (all 29 deployments):
- Stripped `"soft": [...]` to `"soft": []` in `DEPENDENCY_TARGETS_JSON` via `kubectl set env`
- This immediately stops background callers from hitting soft/platform services

### Status
Template and live deployments are patched. Old soft-dep edges will age out as the backend's time window advances (typically 1-24 hours). New traffic only creates hard-dep edges matching the expected DAG topology.

---

## 5. Research Artifacts

All research reports from the parallel agent investigations are in `.omc/scientist/reports/`:

| Report | Content |
|--------|---------|
| `2026-03-27_missing_postman_vars_analysis.md` | CI variable root cause analysis |
| `20260327_102051_service_graph_traffic_analysis.md` | Traffic shape analysis (background caller + soft deps) |
| `20260327_102105_hostnetwork_service_graph_investigation.md` | hostNetwork IP collision analysis |
| `20260327_102105_service_graph_root_cause.md` | Reference implementation comparison |
| `20260327_102212_service_graph_edge_discovery.md` | Backend edge builder code analysis |
| `dependency_graph_analysis.md` | Full dependency topology analysis |
| `20260327_postman_workspace_uids_report.md` | Workspace UID collection for CI variables |

Implementation plan: `.omc/plans/service-graph-topology-fix.md`
