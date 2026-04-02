# Manual Insights Lab - Final Runbook And Findings
> **Document role:** Runbook
> **Canonical parent:** vzw/internal-catalog/docs/README.md


**Track:** `manual-insights-lab_20260311`  
**Date:** 2026-03-11  
**Goal:** Build a manual, reproducible path from a live Kubernetes deployment to a working Postman Insights service graph, with enough evidence to adapt the sequence into the provisioning pipeline.

---

## Final Outcome

The service graph pipeline **does work**, but it required more than the obvious onboarding APIs.

### Final confirmed working state

At the end of the investigation:

- The 5 LAB services were deployed and continuously generating traffic.
- All 5 services were onboarded into API Catalog / Insights.
- The DaemonSet agents were capturing traffic successfully.
- Repro/payload mode was enabled on the live DaemonSet.
- The services were propagating W3C `traceparent`.
- Service graph edges were visible for **3 of the 5** LAB services.

### Current graph status

| Service | Edges In | Edges Out | Total Requests |
|---------|----------|-----------|----------------|
| api-gateway | 0 | 0 | 8445 |
| order-svc | 2 | 2 | 5406 |
| user-svc | 0 | 0 | 6763 |
| inventory-svc | 2 | 2 | 5406 |
| notification-svc | 2 | 2 | 5406 |

### Important conclusion

The final unlock was **not** `identity_id`, and **not** `api_spec_ids`.

Even with working edges:

| Service | identity_id | api_spec_ids |
|---------|-------------|--------------|
| order-svc | `idt_0000000000000000000000` | `[]` |
| inventory-svc | `idt_0000000000000000000000` | `[]` |
| notification-svc | `idt_0000000000000000000000` | `[]` |

So those fields were red herrings for this Postman-authenticated daemonset path.

---

## LAB Asset Registry

### Services

| Service | Bifrost `svc_*` ID | Numeric ID | Workspace ID | Workspace Name |
|---------|--------------------|------------|--------------|----------------|
| api-gateway | `svc_3Gt765eiVdMzBG9kZyIBx0` | `25901` | `aa1c93e5-2196-4ba7-993c-5db478899aa8` | `[LAB] api-gateway` |
| order-svc | `svc_2zgdcQGdNicz6mvij3UMjJ` | `26051` | `100c7eaf-e3ed-4a1a-a211-542f7a5a0081` | `[LAB] order-svc` |
| user-svc | `svc_6ZNUNYjRkRbtuNxrROWDVY` | `26101` | `6c9cbe80-c2c3-49aa-95c7-8cf11ea2fb75` | `[LAB] user-svc` |
| inventory-svc | `svc_4A2qm2ggsARQtVMNxqPeau` | `25951` | `ff00396a-5144-4236-9d5a-26997194777e` | `[LAB] inventory-svc` |
| notification-svc | `svc_46r7XDAcGWlOy1aVZe6qx0` | `26001` | `2d662c7e-ab8e-4de7-a6a7-2ce79a2a7f87` | `[LAB] notification-svc` |

### System environments

| Name | UUID |
|------|------|
| Production | `8bfa188b-8747-4dc8-a8ef-0f2c67677e43` |
| Staging | `c3d6722d-f0c7-4bac-8916-9caedff3a8a0` |

### GitHub repos used during onboarding

| Service | Repo |
|---------|------|
| api-gateway | `postman-cs/se-catalog-demo` |
| order-svc | `postman-cs/lab-order-svc` |
| user-svc | `postman-cs/lab-user-svc` |
| inventory-svc | `postman-cs/lab-inventory-svc` |
| notification-svc | `postman-cs/lab-notification-svc` |

### Application bindings created via agent API

| Service | `application_id` |
|---------|------------------|
| api-gateway | `9b379190-9c79-4cff-9583-329059697b78` |
| order-svc | `a0288ace-95e7-4f67-b77a-ef365429bfce` |
| user-svc | `436519f0-c554-46b3-949a-ae549708f53c` |
| inventory-svc | `2d6d14b6-0eb5-4aca-85a5-fece55785fe9` |
| notification-svc | `c62bd253-55f3-409a-983c-cd3814105bdd` |

### Postman environment UIDs associated to Production

| Service | Environment UID |
|---------|------------------|
| api-gateway | `53017284-3cd4a795-27d9-475a-bf72-6f1fb5cfc452` |
| order-svc | `53017284-b248ae34-5867-47b4-88ba-3c33781a08bc` |
| user-svc | `53017284-a884160f-865b-4e27-9a83-294f1b220156` |
| inventory-svc | `53017284-c04ec6bf-394c-4a3e-ac75-05b63e549014` |
| notification-svc | `53017284-e36ec626-bd09-49aa-90ee-e19f31d387f9` |

---

## Final Working Recipe

This is the shortest accurate version of what had to happen to make graph edges start appearing.

### 1. Deploy real services that call each other

The 5 Go services were intentionally built to create real HTTP dependencies:

- `api-gateway` -> `order-svc`
- `api-gateway` -> `user-svc`
- `order-svc` -> `inventory-svc`
- `order-svc` -> `user-svc`
- `user-svc` -> `notification-svc`
- `inventory-svc` -> `notification-svc`

Each service also emits synthetic background traffic every 8-15 seconds.

### 2. Keep `hostNetwork: true` for the LAB pods in this cluster

This cluster/agent combination only captured traffic reliably for the LAB pods when the workloads used:

```yaml
hostNetwork: true
dnsPolicy: ClusterFirstWithHostNet
```

Removing `hostNetwork: true` produced:

```json
{
  "agent_status_summary": "CAPTURE_EMPTY",
  "agent_capture_status": "CAPTURE_EMPTY",
  "http_requests": 0,
  "http_responses": 0,
  "tcp_packets": 0
}
```

Restoring it returned capture to:

```json
{
  "agent_capture_status": "OK",
  "http_requests": 2,
  "http_responses": 2,
  "tcp_packets": 111
}
```

### 3. Onboard each service fully into API Catalog / Insights

#### 3.1 Git onboarding

```text
POST /api/v1/onboarding/git
```

Required because `services/onboard` fails if the workspace is not linked to a filesystem.

#### 3.2 Service-level onboarding

```text
POST /v2/api-catalog/services/onboard
```

This maps `svc_*` -> workspace -> system environment.

#### 3.3 Workspace acknowledge

```text
POST /v2/workspaces/{workspace_id}/onboarding/acknowledge
```

This activates the Insights project for the workspace.

#### 3.4 Agent-side application binding

```text
POST https://api.observability.postman.com/v2/agent/api-catalog/workspaces/{workspace_id}/applications
Body: {"system_env":"<uuid>"}
```

This is not available via normal Bifrost pathing and was found in the internal `Insights #blueprint` collection.

#### 3.5 Create Postman environments and associate them to the system environment

Create a Postman environment in each workspace:

```text
POST https://api.getpostman.com/environments?workspace={workspace_id}
```

Then associate them:

```text
PUT /api/system-envs/associations
{
  "systemEnvironmentId": "...",
  "workspaceEntries": [
    {
      "workspaceId": "...",
      "postmanEnvironmentIds": ["..."]
    }
  ]
}
```

This step was missing in the early attempts and is required for a correct workspace -> system-env link.

### 4. Propagate `traceparent` between services

This turned out to be essential.

The backend code in `observability-superstar-service/services/async_witnesses/rest_handlers/witness_kafka_producer.go` extracts:

```text
traceparent: 00-<trace_id>-<parent_span_id>-<flags>
```

and uses it to populate `TraceID` / `ParentSpanID` on witness-derived events.

The graph edge builder in:

`services/witness_assembler/pkg/assembler/trace_edge_discovery.go`

only inserts edges when:

1. witnesses have a non-empty `TraceID`
2. multiple services appear in the same trace

Originally our LAB services did **not** propagate any tracing headers. We fixed this by adding:

`lab-services/internal/traceutil/trace.go`

and wiring all 5 services to:

- create a root `traceparent` when a request arrives without one
- attach `traceparent` to all outbound HTTP calls
- seed background traffic with a root trace context

### 5. Run the DaemonSet in repro mode

This was the final unlock.

We discovered:

- `GET /v2/services/{service_id}/repro/agent-status` initially returned `ALL OFF`
- `GET /v2/services/{service_id}/agent-status` showed:

```json
{
  "agent_capture_status": "OK",
  "sends_witness_payloads": false
}
```

Even after:

```text
PATCH /v2/services/{service_id}/settings/admin
{
  "activate_repro_mode": true
}
```

the live daemonset still kept `sends_witness_payloads=false`.

The reason is that the daemonset was launched with:

```text
kube run --discovery-mode --debug
```

and that mode did not pick up payload mode from backend settings alone.

The binary help inside the live agent pod showed the decisive runtime flags:

```text
postman-insights-agent kube run --help
...
  --repro-mode
  --include-namespaces
```

We patched the live daemonset to run:

```text
kube run --discovery-mode --debug --repro-mode --include-namespaces insights-lab
```

After rollout:

```json
GET /v2/services/{service_id}/repro/agent-status
{
  "status": "ALL ON"
}
```

and:

```json
GET /v2/services/{service_id}/agent-status?limit=5
{
  "agent_capture_status": "OK",
  "sends_witness_payloads": true
}
```

That was the first confirmed state where:

- traffic capture was working
- payload-bearing witnesses were enabled
- `traceparent` propagation existed in the apps

and **graph edges started to appear**.

---

## What Turned Out To Matter

### Confirmed prerequisites for graph edges

1. Real inter-service traffic
2. `hostNetwork: true` for these LAB pods in this cluster
3. Complete workspace/service/system-env onboarding
4. Application binding via agent API
5. Postman environment -> system-env association
6. `traceparent` propagation across service-to-service calls
7. DaemonSet launched with `--repro-mode`
8. DaemonSet scoped to `--include-namespaces insights-lab` to reduce cross-namespace contamination

### Things that looked important but were not the true blocker

1. `identity_id = idt_0000000000000000000000`
2. `api_spec_ids = []`
3. `activate_repro_mode=true` in backend settings, by itself

Those fields/settings remained misleading on their own. The actual edge path depended on trace-bearing payload capture.

---

## Final Runtime Evidence

### Repro / payload mode

```json
GET /v2/services/{service_id}/repro/agent-status
{
  "status": "ALL ON"
}
```

Verified for:

- `svc_3Gt765eiVdMzBG9kZyIBx0`
- `svc_2zgdcQGdNicz6mvij3UMjJ`
- `svc_6ZNUNYjRkRbtuNxrROWDVY`
- `svc_4A2qm2ggsARQtVMNxqPeau`
- `svc_46r7XDAcGWlOy1aVZe6qx0`

### Agent metadata

```json
GET /v2/services/{service_id}/agent-status?limit=5
{
  "agent_capture_status": "OK",
  "sends_witness_payloads": true
}
```

### Learn sessions still show zero identity / zero spec IDs

Even after graph edges appeared:

```json
{
  "identity_id": "idt_0000000000000000000000",
  "api_spec_ids": []
}
```

for services like `order-svc`, `inventory-svc`, and `notification-svc`.

This proves those fields are **not** a reliable success/failure indicator for the graph path in this Postman-authenticated daemonset setup.

---

## Final Graph Results

### Service graph counts

| Service | Incoming | Outgoing | Total Requests |
|---------|----------|----------|----------------|
| `[LAB] api-gateway` | 0 | 0 | 8445 |
| `[LAB] order-svc` | 2 | 2 | 5406 |
| `[LAB] user-svc` | 0 | 0 | 6763 |
| `[LAB] inventory-svc` | 2 | 2 | 5406 |
| `[LAB] notification-svc` | 2 | 2 | 5406 |

### Full edge payloads observed

#### `order-svc`

- incoming from `inventory-svc`
- incoming from `notification-svc`
- outgoing to `inventory-svc`
- outgoing to `notification-svc`

#### `inventory-svc`

- incoming from `order-svc`
- incoming from `notification-svc`
- outgoing to `order-svc`
- outgoing to `notification-svc`

#### `notification-svc`

- incoming from `inventory-svc`
- incoming from `order-svc`
- outgoing to `inventory-svc`
- outgoing to `order-svc`

### Interpretation

The graph is now clearly non-empty, so the graph pipeline is working.

However, the exact edge shape is still not perfect relative to the intended business topology:

- `api-gateway` and `user-svc` still showed zero edges at the captured time
- some edge host-port fields looked odd / repetitive in the raw API payloads

This suggests:

1. the pipeline is now fundamentally alive
2. more soak time and/or better trace propagation coverage may improve completeness
3. there may still be some trace stitching quirks in the backend

---

## Useful Endpoints

### Control-plane / onboarding

| Endpoint | Meaning |
|----------|---------|
| `POST /api/v1/onboarding/git` | Link workspace to repo |
| `POST /v2/api-catalog/services/onboard` | Convert discovered -> managed |
| `POST /v2/workspaces/{workspace}/onboarding/acknowledge` | Acknowledge workspace onboarding |
| `POST /v2/agent/api-catalog/workspaces/{workspace}/applications` | Create application binding |
| `PUT /api/system-envs/associations` | Associate Postman envs to system env |

### Diagnostics

| Endpoint | Meaning |
|----------|---------|
| `GET /v2/services/{service}/agent-status?limit=5` | Capture health, payload mode, packet counts |
| `GET /v2/services/{service}/repro/agent-status` | Whether live agents are `ALL OFF` / `ALL ON` |
| `GET /v2/api-catalog/workspaces/{workspace}/endpoints?system_env=...` | Endpoint host/path traffic |
| `GET /v2/api-catalog/workspaces/{workspace}/service-graph?system_env=...` | Workspace graph view |
| `GET /v3/services/{service}/service-graph-edges` | Direct edge list |
| `GET /v3/services/{service}/endpoints` | v3 endpoint list with request counts |
| `GET /v2/agent/services/{service}/learn` | Learn session metadata |
| `GET /v2/services/{service}/settings` | Service settings state (`activate_repro_mode`, traffic window, etc.) |

---

## How To Adapt This To The Provisioning Pipeline

This is the most important section for turning the manual LAB into automation.

### A. Onboarding pipeline changes

The current pipeline should explicitly perform all of the following, in order:

1. Create workspace
2. Git onboarding
3. Service-level onboarding
4. Workspace acknowledge
5. Agent application binding
6. Create Postman environment in workspace
7. Associate Postman environment to target system environment

#### Repo locations to update

These are the most relevant places in this repo:

- `src/lib/insights-onboarding.ts`
- `.github/actions/finalize/src/index.ts`

#### Additions needed

1. **Application binding helper**

Add a helper for:

```text
POST https://api.observability.postman.com/v2/agent/api-catalog/workspaces/{workspace_id}/applications
```

2. **System environment association helper**

After workspace/environment creation, call:

```text
PUT /api/system-envs/associations
```

3. **Verification gates**

Do not declare onboarding complete unless:

```text
GET /v2/workspaces/{workspace}/onboarding/acknowledge
```

shows an `acknowledged_at` timestamp, and:

```text
GET /api/system-envs?teamId=...
```

shows the workspace under the correct system environment.

### B. Generated service runtime changes

The services must propagate W3C trace context.

For this repo specifically:

- registry-based generated Flask apps are controlled by `src/lib/spec-to-flask.ts`
- fallback templates live in `src/lib/boilerplate.ts`

Because registry-based provisioning overrides boilerplate routing, **the important changes belong in `src/lib/spec-to-flask.ts`**.

#### Required behavior

Generated services should:

1. Read inbound `traceparent`
2. Create a new root `traceparent` if one is absent
3. Forward `traceparent` on every outbound HTTP call

Without that, `witness_assembler` cannot derive `TraceID` and will never write `service_edges`.

### C. DaemonSet / shared infra changes

For k8s discovery mode, the shared agent deployment needs to support graph-friendly capture.

#### Required agent flags

The key working args were:

```text
kube run --discovery-mode --debug --repro-mode --include-namespaces insights-lab
```

#### Why these matter

- `--repro-mode` turned payload-bearing witnesses on
- `--include-namespaces insights-lab` reduced cross-namespace contamination

#### Practical adaptation

For automation, either:

1. deploy a dedicated daemonset per target namespace with `--include-namespaces <namespace>`

or

2. run discovery in a dedicated cluster / namespace-isolated environment

If a single shared daemonset is left to observe the whole cluster, graph debugging becomes much harder because unrelated service traffic contaminates the endpoint model.

### D. Keep `hostNetwork: true` unless capture behavior changes

In this cluster, removing `hostNetwork: true` caused the live agents to drop into `CAPTURE_EMPTY`.

If the future pipeline targets the same cluster/agent build, keep:

```yaml
hostNetwork: true
dnsPolicy: ClusterFirstWithHostNet
```

and validate capture with:

```text
GET /v2/services/{service}/agent-status?limit=5
```

before assuming the graph issue is elsewhere.

### E. Post-deploy validation checklist for CI

After provisioning / deploying:

1. `GET /v2/services/{service}/agent-status?limit=5`
   - expect `agent_capture_status = "OK"`

2. `GET /v2/services/{service}/repro/agent-status`
   - expect `status = "ALL ON"`

3. `GET /v3/services/{service}/endpoints`
   - expect request counts on expected internal hosts

4. `GET /v3/services/{service}/service-graph-edges`
   - expect non-empty edges after soak

5. `GET /api/system-envs?teamId=...`
   - expect workspace association under the target system environment

### F. Soak time expectations

Observed behavior suggests:

- capture and endpoint metrics appear quickly
- edge generation lags slightly behind payload-mode activation

So CI should:

1. wait for capture to become `OK`
2. wait for repro mode to become `ALL ON`
3. generate traffic
4. poll edges for a bounded soak window

---

## What Changed In The LAB Code

### Added

- `lab-services/internal/traceutil/trace.go`

### Updated

- `lab-services/api-gateway/main.go`
- `lab-services/order-svc/main.go`
- `lab-services/user-svc/main.go`
- `lab-services/inventory-svc/main.go`
- `lab-services/notification-svc/main.go`
- `lab-services/k8s/manifests.yaml`

### Runtime changes

- enabled `imagePullPolicy: Always`
- restored `hostNetwork: true`
- daemonset patched to:
  - `--repro-mode`
  - `--include-namespaces insights-lab`

---

## Final Takeaways

1. The graph API is driven by `service_edges`, not learn-session identity/spec metadata.
2. `traceparent` propagation is required for meaningful service-to-service edges.
3. DaemonSet discovery mode needed `--repro-mode` before the backend would start producing edges.
4. Server-side `activate_repro_mode=true` was not sufficient on its own for the live daemonset.
5. Postman environment -> system environment association is mandatory and easy to miss.
6. `hostNetwork: true` was required in this specific cluster state for reliable capture.
7. The successful automation recipe is now known and can be ported into the pipeline.

---

## Final Success State (2026-03-11 ~08:20 UTC)

After the final traffic-generation adjustments, **all 5 LAB services appeared in the graph**.

### Final graph summary

| Service | Incoming | Outgoing | Total Requests |
|---------|----------|----------|----------------|
| `[LAB] api-gateway` | 11 | 14 | 12786 |
| `[LAB] order-svc` | 12 | 12 | 12786 |
| `[LAB] user-svc` | 5 | 10 | 12786 |
| `[LAB] inventory-svc` | 11 | 3 | 12786 |
| `[LAB] notification-svc` | 2 | 2 | 12786 |

### Repro mode state

All 5 services returned:

```json
{
  "status": "ALL ON"
}
```

This came from:

```text
GET /v2/services/{service_id}/repro/agent-status
```

### What finally made `api-gateway` and `user-svc` appear

The final adjustment was not more onboarding. It was better **traffic shape**.

#### Before

- `api-gateway` synthetic loop called downstream services directly (`order-svc`, `user-svc`)
- `order-svc`, `user-svc`, and `inventory-svc` synthetic loops called internal functions directly

That created traffic, but not the best **traced inbound HTTP service chains** for graph generation.

#### After

We changed the synthetic loops so they generate traffic through real HTTP entrypoints:

1. `api-gateway` synthetic loop now calls its own HTTP API:
   - `POST /orders`
   - `POST /users`

2. `order-svc` synthetic loop now calls its own HTTP API:
   - `POST /orders`

3. `user-svc` synthetic loop now calls its own HTTP API:
   - `POST /users`

4. `inventory-svc` synthetic loop now calls its own HTTP API:
   - `POST /inventory/reserve`

5. `api-gateway` gained a new proxy route:
   - `POST /users` -> forwards to `user-svc POST /users`

#### Why this mattered

This created full traced chains like:

- `api-gateway -> order-svc -> inventory-svc -> notification-svc`
- `api-gateway -> user-svc -> notification-svc`
- `order-svc -> inventory-svc`
- `user-svc -> notification-svc`
- `inventory-svc -> notification-svc`

Those chains are much closer to what the backend edge builder expects than in-process function calls.

### Final interpretation

The winning combination was:

1. complete API Catalog / Insights onboarding
2. application binding
3. system env association
4. `hostNetwork: true`
5. daemonset `--repro-mode`
6. daemonset `--include-namespaces insights-lab`
7. W3C `traceparent` propagation
8. synthetic traffic that enters each service over **real HTTP routes**, not only in-process calls

---

## Provisioning Pipeline Adaptation (Final)

The provisioning pipeline should adopt the following as **required**, not optional.

### 1. Finalize/onboarding pipeline

Add these steps to the provisioning flow:

1. Git onboarding
2. service-level onboard
3. workspace acknowledge
4. application binding (`/v2/agent/api-catalog/workspaces/{id}/applications`)
5. create Postman environment
6. associate Postman environment to system environment

These belong primarily in:

- `src/lib/insights-onboarding.ts`
- `.github/actions/finalize/src/index.ts`

### 2. Generated runtime code

Generated services must propagate W3C trace context.

For this repo, the important implementation point is:

- `src/lib/spec-to-flask.ts`

because registry-based generated services override the fallback boilerplate.

Generated apps should:

1. read inbound `traceparent`
2. create a root `traceparent` if missing
3. forward `traceparent` on every outbound HTTP call

### 3. Shared k8s discovery infra

The shared DaemonSet needs to run with:

```text
kube run --discovery-mode --debug --repro-mode
```

and ideally with namespace scoping when debugging / validating one deployment:

```text
--include-namespaces <namespace>
```

Without `--repro-mode`, the agents remained `ALL OFF` and the graph did not populate.

### 4. Verification gates in automation

Provisioning should not be considered successful for graph generation until the following all pass:

1. `GET /v2/services/{service_id}/agent-status?limit=5`
   - `agent_capture_status == "OK"`

2. `GET /v2/services/{service_id}/repro/agent-status`
   - `status == "ALL ON"`

3. `GET /api/system-envs?teamId=...`
   - workspace is associated to the target system env

4. `GET /v3/services/{service_id}/service-graph-edges`
   - edges are non-empty after soak

### 5. Optional but recommended smoke traffic

For CI / automated validation, use an explicit traffic generator that hits the public/service HTTP entrypoints, not internal functions.

Good validation traffic:

- gateway route that creates downstream order flow
- gateway route that creates downstream user->notification flow

This produces graph edges much more reliably than background in-process business logic alone.
