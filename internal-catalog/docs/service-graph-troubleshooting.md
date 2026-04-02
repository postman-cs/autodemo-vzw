# Service Graph Troubleshooting: Isolated Services
> **Document role:** Research
> **Canonical parent:** vzw/internal-catalog/docs/README.md


## Summary

Root cause analysis for why the API Catalog service graph shows isolated services with no edges/connections, even after endpoint discovery is working. Based on investigation of the Insights #blueprint collection, API Catalog #Blueprint collection, [Observability] Postman Insights #Service collection, and Postman's internal dogfooding telemetry data.

The service graph requires **three conditions** to be met simultaneously. Missing any one results in isolated nodes.

## How the Service Graph Actually Works

The service graph is **not** built from onboarding metadata, learn-session identity, or `api_spec_ids`. It is built from **W3C trace context (`traceparent`) extracted from captured witness HTTP headers**.

The pipeline (confirmed from `postman-eng/observability-superstar-service` source):

```
Agent captures packets (--repro-mode required for payload-bearing witnesses)
    → Uploads witnesses (async_reports) with full HTTP headers
    → witness_kafka_producer extracts traceparent header → populates TraceID/ParentSpanID
    → witness_assembler groups traces by TraceID
    → Discovers service-to-service edges when same TraceID spans multiple services
    → Inserts into service_edges table
    → GET /v2/api-catalog/workspaces/{id}/service-graph reads from service_edges
```

### Critical: `traceparent` is Required

The backend code (`services/async_witnesses/rest_handlers/witness_kafka_producer.go`) scans each witness for:

```
traceparent: 00-<trace_id>-<parent_span_id>-<flags>
```

Without `traceparent`, the witness message has empty `TraceID`. The edge builder (`services/witness_assembler/pkg/assembler/trace_edge_discovery.go`) skips witnesses with empty trace IDs:

```go
if msg.TraceID == "" {
    continue
}
```

### Critical: `--repro-mode` is Required on the DaemonSet

Without `--repro-mode`, the agent reports `sends_witness_payloads: false` and does not include full HTTP headers in witnesses. The backend then cannot extract `traceparent`, even if the application sends it.

Verify with:
```bash
GET /v2/services/{service_id}/repro/agent-status   # expect "ALL ON"
GET /v2/services/{service_id}/agent-status?limit=5  # expect sends_witness_payloads: true
```

### Red Herring: `identity_id` and `api_spec_ids`

`identity_id = idt_0000000000000000000000` is **normal** for Postman API-key authenticated agents. The backend deliberately injects zero identity for Postman users (`services/async_witnesses/middleware/auth/auth.go`). Graph edges appeared in the lab while learn sessions still showed zero identity and empty `api_spec_ids`.

## The Four Requirements for Graph Edges

### 1. DaemonSet Must Run with `--repro-mode`

Without this flag, agents capture traffic metadata but do NOT include HTTP headers in witnesses. The backend cannot extract `traceparent` without headers.

```yaml
args:
  - kube
  - run
  - --discovery-mode
  - --debug
  - --repro-mode
```

**Server-side `activate_repro_mode=true` is NOT sufficient.** The agent settings API does not propagate this flag to the live DaemonSet process. The flag must be set at container startup.

**Diagnostic:**
```bash
# Check via Bifrost akita
GET /v2/services/{service_id}/repro/agent-status
# Must return: {"status": "ALL ON"}

GET /v2/services/{service_id}/agent-status?limit=5
# Must show: sends_witness_payloads: true, agent_capture_status: OK
```

### 2. Services Must Propagate W3C `traceparent`

Applications must:
1. Read inbound `traceparent` header
2. Create a root `traceparent` if absent (`00-<32hex>-<16hex>-01`)
3. Forward `traceparent` on every outbound HTTP call

Without this, witnesses have no `TraceID` and the edge builder produces nothing.

For generated Flask apps, implement in `src/lib/spec-to-flask.ts` (overrides boilerplate).

### 3. Multiple Services Must Be Onboarded in the Same `system_env`

The service graph is scoped to a **system environment** (`system_env`). The query is:

```
GET /v2/api-catalog/workspaces/:workspaceId/service-graph?system_env=<SYSTEM_ENV_UUID>
```

If services are onboarded with **different** `system_env` values (or no `system_env`), they won't appear in the same graph view. All services that should be connected must share the same system environment UUID.

**How to check:** Query the API Catalog for system environments:

```bash
# Get system environments for your team
curl -X GET 'https://<api-catalog-host>/api/system-envs?teamId=<TEAM_ID>' \
  -H 'content-type: application/json' \
  --user '<username>:<password>'
```

**How to fix:** When calling "Convert from discovered to managed" (`POST /v2/api-catalog/services/onboard`), ensure ALL services use the **same** `system_env` UUID:

```json
{
  "services": [
    {
      "service_id": "svc_AAAA",
      "workspace_id": "<WORKSPACE_UUID>",
      "system_env": "<SAME_SYSTEM_ENV_UUID>"
    },
    {
      "service_id": "svc_BBBB",
      "workspace_id": "<WORKSPACE_UUID>",
      "system_env": "<SAME_SYSTEM_ENV_UUID>"
    }
  ]
}
```

You can also associate Postman environments with system environments via the API Catalog:

```bash
curl -X PUT 'https://<api-catalog-host>/api/system-envs/associations' \
  -H 'content-type: application/json' \
  -d '{
    "systemEnvironmentId": "<SYSTEM_ENV_UUID>",
    "workspaceEntries": [
      {
        "postmanEnvironmentIds": ["<POSTMAN_ENV_UID>"],
        "workspaceId": "<WORKSPACE_UUID>"
      }
    ]
  }'
```

### 4. The Agent Must Capture Inter-Service Traffic (Not Just Intra-Service)

This is the most common failure point. The agent captures traffic on network interfaces, but if it can only see traffic **to** a service (inbound) and not traffic **between** services, no edges can be created.

**What Postman's internal dogfooding captures** (from the `Post client capture stats` telemetry):

```json
"top_by_host": {
  "ads.postman-stage.tech": { "http_requests": 3761667 },
  "uds.postman-stage.tech": { "tls_hello": 733 },
  "collector.newrelic.com": { "tls_hello": 5496 },
  "10.100.125.146:7589": { "http_requests": 162124 }
}
```

Notice: the agent sees traffic to **other services** (`ads.postman-stage.tech`, `uds.postman-stage.tech`) — these are the outbound calls that create graph edges. The backend resolves these hostnames/IPs to known Insights services and creates edges.

**What your agent likely captures:**

```json
"top_by_host": {
  "10.0.42.65:5001": { "http_requests": 500 }
}
```

If the agent only sees traffic to **one** IP (the service it's monitoring), there are no outbound calls to other known services, so no edges are created.

**Root cause:** On EKS with VPC CNI, each pod has its own network namespace. The DaemonSet agent runs on the host network and can only see traffic on `lo` (loopback). It cannot see pod-to-pod traffic that traverses the VPC CNI overlay.

**Fix options:**

1. **hostNetwork on service pods** — Service pods share the host network namespace, so the agent can see all traffic on `eth0` and `lo`. See `docs/insights-onboarding.md` for full configuration.

   Important: `hostNetwork` only fixes visibility. If multiple discovery services land on the same node, they still share one source IP and the backend cannot reliably attribute outbound calls. For DaemonSet discovery mode, each graph-participating service needs a **dedicated node/IP**, enforced with anti-affinity/topology spread.

2. **Sidecar injection** — Each service pod gets its own agent sidecar that captures from within the pod's network namespace:
   ```bash
   postman kube inject \
     --workspace-id <WORKSPACE_UUID> \
     --system-env <SYSTEM_ENVIRONMENT_UUID> \
     -f deployment.yaml | kubectl apply -f -
   ```

3. **Service mesh / proxy** — If services communicate through a mesh (Istio, Linkerd), the agent may need to capture on the proxy's interface.

### 5. Complete Onboarding Sequence (All Steps Required)

Beyond service-level onboarding, the full sequence is:

1. Git onboarding (`POST /api/v1/onboarding/git`)
2. Service-level onboard (`POST /v2/api-catalog/services/onboard`)
3. Workspace acknowledge (`POST /v2/workspaces/{id}/onboarding/acknowledge`)
4. Application binding (`POST https://api.observability.postman.com/v2/agent/api-catalog/workspaces/{id}/applications` with `{"system_env":"<UUID>"}`)
5. Create Postman environment in workspace
6. Associate environment to system environment (`PUT /api/system-envs/associations`)

Missing any step can silently break the graph pipeline without obvious errors.

### 6. Services Must Actually Communicate With Each Other

The graph only shows **observed** dependencies. If Service A never calls Service B during the capture window, no edge will appear between them.

**How to verify traffic is being captured:**

```bash
# Check learn sessions for a service
curl -X GET 'https://api.observability.postman.com/v2/agent/services/<SERVICE_ID>/learn' \
  -H 'x-api-key: <PMAK_API_KEY>' \
  -H 'x-postman-env: <PM_ENV>'
```

**How to verify witness uploads:**

The agent uploads witnesses to:
```
POST /v2/agent/services/:serviceID/learn/:learnSessionID/async_reports
```

Each witness contains `origin_addr` and `destination_addr`. If all witnesses have the **same** `destination_addr` and varying `origin_addr` values, the agent is only seeing inbound traffic to one service — no inter-service edges can be built.

**How to generate test traffic:**

Send requests between your services to create observable inter-service calls:
```bash
# From within the cluster, call Service A which should call Service B
curl http://service-a:5001/endpoint-that-calls-service-b
```

## Diagnostic Checklist

| Check | Command | Expected |
|-------|---------|----------|
| DaemonSet has `--repro-mode` | `kubectl get ds postman-insights-agent -n postman-insights-namespace -o jsonpath='{.spec.template.spec.containers[0].args}'` | Contains `--repro-mode` |
| Agent payload mode active | `GET /v2/services/:id/repro/agent-status` (Bifrost akita) | `{"status": "ALL ON"}` |
| Agent capture healthy | `GET /v2/services/:id/agent-status?limit=5` (Bifrost akita) | `agent_capture_status: "OK"`, `sends_witness_payloads: true` |
| Services share same `system_env` | `GET /v2/api-catalog/workspaces/:id/service-graph?system_env=<UUID>` | Multiple services in response |
| System env associations exist | `GET /api/system-envs?teamId=<ID>` (Bifrost api-catalog) | Workspace listed under target system env |
| Agent sees multiple destination hosts | Check agent logs or `top_by_host` in telemetry | Multiple service hostnames/IPs |
| Learn sessions are active | `GET /v2/agent/services/:id/learn` | Active sessions with recent timestamps |
| Workspace onboarding acknowledged | `GET /v2/workspaces/:id/onboarding/acknowledge` (Bifrost akita) | `acknowledged_at` present |
| Application binding exists | `GET /v2/workspaces/:id/services` (Bifrost akita) | Service listed with `service_id` |
| Graph edges populated | `GET /v3/services/:id/service-graph-edges` (Bifrost akita) | Non-empty `incoming`/`outgoing` |

## Common Scenarios

### Scenario: Endpoints discovered but graph shows isolated nodes

**Diagnosis:** Endpoints are discovered from the API spec or witness HTTP paths. But graph edges require the agent to observe **cross-service** traffic (Service A calling Service B). If the agent only captures inbound traffic to each service independently, it knows the endpoints but not the callers.

**Fix:** Enable `hostNetwork: true` on service pods or use sidecar injection so the agent can see outbound calls. For discovery-mode DaemonSets, each service needs a dedicated node/IP (anti-affinity) for visibility, but dependency targets must use **ClusterIP DNS** (`http://<svc>.se-catalog-demo.svc.cluster.local/svc/<svc>`) so the `Host` header is resolvable by the Akita backend for graph edge attribution.

### Scenario: Graph shows edges in dogfooding but not in your cluster

**Diagnosis:** Postman's internal dogfooding runs with `hostNetwork: true` on service pods. Their agent captures on both `eth0` and `lo`, seeing traffic to `ads.postman-stage.tech`, `uds.postman-stage.tech`, etc. Your cluster likely uses VPC CNI with isolated pod networks.

**Fix:** Match the dogfooding configuration — set `hostNetwork: true` and `dnsPolicy: ClusterFirstWithHostNet` on service pods, then enforce one discovery service per node so the source IP remains unique.

### Scenario: Only one service appears in the graph

**Diagnosis:** Check that all services were onboarded with the **same** `system_env` UUID. The service graph query filters by `system_env` — services in different system environments won't appear together.

**Fix:** Re-onboard services with a consistent `system_env` value.

### Scenario: Graph edges appear intermittently

**Diagnosis:** The agent captures traffic in time-windowed learn sessions. If inter-service traffic is infrequent, edges may only appear during active capture windows.

**Fix:** Ensure continuous traffic between services. Consider running a synthetic traffic generator or load test to maintain observable inter-service communication.

## Source References

- **Insights #blueprint** — [Get service graph](https://go.postman.co/request/23904069-035466c9-5d85-4c7e-8da0-b49e18886ac3), [Service graph edges](https://go.postman.co/request/23904069-11ff409e-b229-4969-8253-ccdf3ddbe0bf), [Post client capture stats](https://go.postman.co/request/23904069-cc8c035c-cd77-4100-b27c-62f64cedb5a6), [Upload async report](https://go.postman.co/request/23904069-3841e9c4-6a9c-4b47-8bbe-a3eebdca4258)
- **API Catalog #Blueprint** — [Get System Envs](https://go.postman.co/request/10926004-7ca12ab4-798b-4ab1-ac52-0b70a426c1bc), [Upsert postman env association](https://go.postman.co/request/10926004-c9a51d06-d916-4381-b778-e06a8a539978), [Convert from discovered to managed](https://go.postman.co/request/23904069-a04ab635-bfa6-4d2f-912d-f76b277ebf0f)
- **[Observability] Postman Insights #Service** — [Get Model](https://go.postman.co/request/28245052-75b49624-561c-4666-b57d-6a98101362a4), [Get API Spec](https://go.postman.co/request/28245052-05e18f4a-dd6d-4863-a803-d0417986a729)
- **Service Graph Example** — [Service Graph Example](https://go.postman.co/request/23904069-80ac2541-d0c1-4753-88de-429f0978c11e) (via Bifrost → akita)


---

## Post-Rollout Analysis: Stale Graph After Topology Fix (2026-03-10)

### Symptoms
- Scaled EKS nodegroup from 2→7, patched all 7 discovery deployments with dedicated-IP scheduling
- Each service confirmed running on unique node/IP (192.168.x.x addresses)
- Rewrote `DEPENDENCY_TARGETS_JSON` to dedicated node-IP + hostPort topology
- DaemonSet still producing fresh witnesses, `last_seen_at` updating
- `af-cards-3ds` shows `endpoints_count: 102` (endpoint discovery working)
- **Service graph still returns**: `incoming: [], outgoing: [], total_requests: 18362` (stale)

### Root Cause: Model Rebuild Gap + Host Header Resolution

The service graph endpoint (`/v3/services/:service-id/service-graph-edges`) reads from a **pre-computed model**, not from raw witnesses in real-time. The pipeline is:

```
Witnesses → Async Processing → API Spec/Model Built → Graph Edges Extracted
                                      ↑
                              MODEL IS STALE (frozen at 18362 requests)
```

The `total_requests: 18362` is the count from the **old topology** (before the 7-node scale-up). New witnesses from the new topology haven't been processed into a fresh model yet.

### Two Blockers (in order of probability)

#### 1. Host Header Contains Raw IPs Instead of Resolvable Service Names

The dependency caller (`src/lib/boilerplate.ts` DEPENDENCY_CALLER) and cascading calls (`src/lib/spec-to-flask.ts` `_simulate_latency`) make HTTP requests to targets from `DEPENDENCY_TARGETS_JSON`.

When targets are raw IPs like `http://192.168.37.167:5001/svc/af-cards-tokenization`, the captured witness `Host` header is `192.168.37.167:5001`. The Akita backend resolves graph edges using the **Host header** — if it can't map this to a known service, no edge is created.

**Evidence from Postman's dogfooding** (from `Post client capture stats` telemetry):
```json
"top_by_host": {
  "ads.postman-stage.tech": { "http_requests": 3761667 },
  "uds.postman-stage.tech": { "tls_hello": 733 }
}
```
Their services use **DNS hostnames**, not raw IPs.

**Fix (applied)**: Reverted `DEPENDENCY_TARGETS_JSON` from raw node IPs to ClusterIP DNS in `provision.ts` and `aws-deploy`. The provisioning pipeline now generates stable ClusterIP DNS URLs for `k8s_discovery` (same format as `k8s_workspace`), eliminating the need for post-rollout IP reconciliation.

```
http://192.168.37.167:5001/svc/af-cards-tokenization
→ http://af-cards-tokenization.se-catalog-demo.svc.cluster.local/svc/af-cards-tokenization
```

The `Host` header in witnesses is now `af-cards-tokenization.se-catalog-demo.svc.cluster.local`, which the Akita backend can resolve to a known service for graph edge attribution. Dedicated-IP scheduling (anti-affinity) is kept for DaemonSet traffic visibility.

#### 3. Learn Session Scope Mismatch

Each learn session has an `x-akita-deployment` tag. If the DaemonSet created new sessions after the topology change, but the graph query reads from the old model (built from old sessions), new inter-service witnesses won't be reflected.

Verify learn sessions:
```bash
curl -X GET '{{agent-host}}/v2/agent/services/:service_id/learn' \
  -H 'x-postman-env: {{pm-env}}' \
  -H 'x-api-key: {{pm-api-key}}'
```

Check that:
- Sessions have recent `creation_time` values (post-topology-change)
- The `x-akita-deployment` tag matches what the graph query expects
- `api_spec_ids` array is non-empty (model has been built from this session)

### Fix Sequence

1. **Switch DEPENDENCY_TARGETS_JSON to ClusterIP DNS** — `./scripts/patch-dep-targets-clusterip.sh`
2. **Wait 15-30 minutes** for new witnesses with DNS Host headers to accumulate
3. **Trigger model rebuild** for all 7 services via support endpoint
4. **Query graph edges** — `GET /v3/services/:service-id/service-graph-edges`
5. **If still empty**: Check learn sessions for `api_spec_ids` — if empty, the model rebuild didn't process the new witnesses

### Dependency Graph (from specs/dependencies.json)

```
af-cards-3ds ──consumesApis──→ af-cards-statements
af-cards-3ds ──consumesApis──→ af-cards-tokenization
af-cards-activation ──dependsOn──→ af-cards-3ds
af-cards-activation ──consumesApis──→ af-cards-statements
af-cards-authorization ──dependsOn──→ af-cards-3ds, af-cards-activation
af-cards-authorization ──consumesApis──→ af-cards-rewards, af-cards-statements, af-cards-tokenization
af-cards-disputes ──dependsOn──→ af-cards-activation, af-cards-authorization
af-cards-disputes ──consumesApis──→ af-cards-rewards, af-cards-statements, af-cards-tokenization, af-cards-virtual
af-cards-fraud-detection ──dependsOn──→ af-cards-disputes
af-cards-fraud-detection ──consumesApis──→ af-cards-tokenization
af-cards-tokenization ──dependsOn──→ af-cards-fraud-detection
af-cards-tokenization ──consumesApis──→ af-cards-disputes
af-core-account-closure ──dependsOn──→ af-cards-3ds
af-core-account-closure ──consumesApis──→ af-core-transactions, af-core-withdrawals, af-core-dormant-accounts
```

Note: `af-cards-tokenization ↔ af-cards-fraud-detection` is a **circular dependency** — both depend on each other. This is valid for the dependency caller (both will call each other) but may cause issues with topological ordering in the provision graph.

### Service Graph API: Correct Request Format

The service graph endpoints **do not work** when called directly against `api.observability.postman.com` (404) or via Bifrost with `service: "api-catalog"` ("invalid path"). Use **Bifrost with `service: "akita"`**:

```bash
# Full workspace graph
curl -X POST 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy' \
  -H 'content-type: application/json' \
  -H 'x-access-token: <ACCESS_TOKEN>' \
  -H 'x-entity-team-id: <TEAM_ID>' \
  -d '{
    "service": "akita",
    "method": "GET",
    "path": "/v2/api-catalog/workspaces/<WORKSPACE_UUID>/service-graph?system_env=<SYSTEM_ENV_UUID>",
    "body": {}
  }'
```

**Common responses:**
- `{"akita_code":"NOT_FOUND","message":"no insights project found for workspace X with system_env Y"}` — Workspace has no Insights project. Services must be onboarded (converted from discovered to managed) to create the project. Use a workspace from a prior k8s_workspace/ECS provision, or re-provision with `k8s_discovery_workspace_link=true`.
- `{"services":[...],"edges":[...]}` — Success.

### Key API References

| Endpoint | Purpose | Collection |
|----------|---------|------------|
| `GET /v3/services/:id/service-graph-edges` | Query graph edges for a service | [Service graph edges](https://go.postman.co/request/23904069-11ff409e-b229-4969-8253-ccdf3ddbe0bf) |
| `GET /v2/api-catalog/workspaces/:id/service-graph?system_env=X` | Query full workspace graph (via Bifrost akita) | [Get service graph](https://go.postman.co/request/23904069-035466c9-5d85-4c7e-8da0-b49e18886ac3) |
| `POST /v2/support/services/:id/rebuild-models-and-timelines` | Force model rebuild | [Rebuild Models and Timelines](https://go.postman.co/request/23904069-fd3c2335-5bcb-4780-a796-192cca79f112) |
| `GET /v2/agent/services/:id/learn` | List learn sessions | [Get Learn Sessions](https://go.postman.co/request/23904069-dd282234-4a29-4f10-9824-d0d6bae223fb) |
| `POST /v2/agent/services/:id/learn/:session/async_reports` | Upload witnesses | [Upload async report](https://go.postman.co/request/23904069-3841e9c4-6a9c-4b47-8bbe-a3eebdca4258) |
| `GET /v2/support/services/:id` | Get service details (support) | [Get Service](https://go.postman.co/request/28245052-2047e72c-7fe2-4601-8279-00c56823f45a) |
| `GET /v2/support/models/:id` | Get model details | [Get Model](https://go.postman.co/request/28245052-75b49624-561c-4666-b57d-6a98101362a4) |

---

## Zero-Identity Services: Expected Behavior, Not a Bug (Updated 2026-03-11)

### Symptoms
- All services report `identity_id: idt_0000000000000000000000` (zero identity) in learn sessions
- `api_spec_ids: []` on every learn session

### Updated Understanding

Zero identity is **normal and expected** for Postman API-key authenticated agents. The backend deliberately injects `akid.IdentityID{}` for Postman users in `services/async_witnesses/middleware/auth/auth.go`. Graph edges were confirmed working while learn sessions still showed zero identity and empty `api_spec_ids`.

The workspace acknowledge step (`POST /v2/workspaces/{id}/onboarding/acknowledge`) is still required for the Insights project to activate, but it does **not** resolve the zero identity -- that's by design.

**Where it was supposed to happen:** The finalize action's `ONBOARD_INSIGHTS_DISCOVERY` step (`.github/actions/finalize/src/index.ts`). The workspace acknowledge was nested inside a per-environment `try/catch` loop. If `prepare-collection` or `onboard-git` threw for any environment, the outer catch swallowed the error and the workspace acknowledge was never reached. Since `core.warning` does not fail the step, the finalize action completed "successfully" without the critical acknowledge.

**What is NOT the cause:**
- Verification token -- already set correctly
- DaemonSet namespace -- correct (`postman-insights-namespace`)
- DNS resolution -- `dnsPolicy: ClusterFirstWithHostNet` is set, ClusterIP Services exist
- RBAC -- agent ServiceAccount has correct permissions

### Fix

**Immediate (manual):**
```bash
# Acknowledge each workspace via Bifrost
curl -sS 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy' \
  -H 'x-access-token: <ACCESS_TOKEN>' \
  -H 'x-entity-team-id: <TEAM_ID>' \
  -H 'Content-Type: application/json' \
  -d '{"service":"akita","method":"POST","path":"/v2/workspaces/<WORKSPACE_UUID>/onboarding/acknowledge","body":{}}'

# Restart DaemonSet to force re-authentication with proper identity
kubectl rollout restart daemonset/postman-insights-agent -n postman-insights-namespace
```

**Permanent (applied):**
1. Finalize action: workspace acknowledge moved out of the per-environment try/catch loop so it always runs
2. provision.ts: server-side safety net calls `acknowledgeWorkspace()` after successful workflow completion for `k8s_discovery` with workspace linkage

### Verification

After the fix, within 15-30 minutes:
- Learn sessions should show non-zero `identity_id` (e.g., `idt_abc123...`)
- `api_spec_ids` should start populating
- `total_requests` in service graph metrics should increase from the stale count
- Graph edges should appear when queried via `GET /v2/api-catalog/workspaces/:id/service-graph?system_env=<UUID>`