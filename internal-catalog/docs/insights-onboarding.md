# Insights Agent Onboarding & Service Graph
> **Document role:** Runbook
> **Canonical parent:** vzw/internal-catalog/docs/README.md


## Summary

Complete reference for connecting Kubernetes services to Postman Insights and the API Catalog Service Graph. Covers the full onboarding lifecycle: agent deployment, service discovery, workspace acknowledgment, verification token setup, and traffic capture configuration.

This document was created after debugging a multi-day integration failure where services were discovered and registered but the agent received `403 "onboarding not acknowledged"` errors, preventing traffic capture and service graph population.

## Architecture Overview

The Insights onboarding flow spans **three separate backends** that must all be in sync:

| Backend | Host | Auth | Purpose |
|---------|------|------|---------|
| **API Catalog** | `bifrost-premium-https-v4.gw.postman.com/ws/proxy` (service: `api-catalog`) | `x-access-token` | Manages workspace-level service integration, git linking |
| **Observability/Akita** | `api.observability.postman.com` (or via Bifrost service: `akita`) | `x-api-key` (PMAK) or `x-access-token` | Agent authentication, learn sessions, traffic upload, telemetry |
| **Bifrost Proxy** | `bifrost-premium-https-v4.gw.postman.com/ws/proxy` | `x-access-token` + `x-entity-team-id` | Routes to internal services (`api-catalog`, `akita`) |

The DaemonSet agent authenticates directly with the **Observability/Akita** backend using the PMAK API key. The onboarding/acknowledgment calls go through **Bifrost** to the API Catalog and Akita backends using the `x-access-token`.

## Complete Onboarding Flow

### Step 1: Deploy the Insights Agent (DaemonSet — Discovery Mode)

Create namespace and API key secret:

```bash
kubectl create namespace postman-insights-namespace

kubectl create secret generic postman-agent-secrets \
  --namespace postman-insights-namespace \
  --from-literal=postman-api-key=<YOUR_POSTMAN_API_KEY>
```

Apply the DaemonSet manifest with discovery mode enabled:

```yaml
containers:
- name: postman-insights-agent
  image: public.ecr.aws/postman/postman-insights-agent:latest
  args:
  - kube
  - run
  - --discovery-mode
  - --repro-mode
  env:
  - name: POSTMAN_INSIGHTS_CLUSTER_NAME
    value: "<YOUR_CLUSTER_NAME>"
  - name: POSTMAN_INSIGHTS_API_KEY
    valueFrom:
      secretKeyRef:
        name: postman-agent-secrets
        key: postman-api-key
  - name: POSTMAN_INSIGHTS_K8S_NODE
    valueFrom:
      fieldRef:
        fieldPath: spec.nodeName
  - name: POSTMAN_INSIGHTS_CRI_ENDPOINT
    value: /var/run/containerd/containerd.sock
```

Verify pods are running:

```bash
kubectl get pods -n postman-insights-namespace
kubectl logs -n postman-insights-namespace -l name=postman-insights-agent --tail=50
```

You should see log lines like:
```
Registered discovered service "cluster/namespace/workload" (ID: svc_XXXX, new: true)
Created new trace on Postman Cloud: akita://cluster/namespace/workload
```

### Step 2: Prepare Collection (API Catalog)

Creates the Insights collection in the target workspace.

```bash
curl -X POST 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy' \
  -H 'content-type: application/json' \
  -H 'x-access-token: <ACCESS_TOKEN>' \
  -H 'x-entity-team-id: <TEAM_ID>' \
  -d '{
    "service": "api-catalog",
    "method": "POST",
    "path": "/api/v1/onboarding/prepare-collection",
    "body": {
      "service_id": "<NUMERIC_DISCOVERED_SERVICE_ID>",
      "workspace_id": "<WORKSPACE_UUID>"
    }
  }'
```

> **Note:** `service_id` here is the **numeric** ID from the discovered services list, not the `svc_*` provider ID.

### Step 3: Link Git Repository (API Catalog)

Two approaches:

**Option A: Via Integrations** (requires stored Postman OAuth token for GitHub):

```bash
curl -X POST 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy' \
  -H 'content-type: application/json' \
  -H 'x-access-token: <ACCESS_TOKEN>' \
  -H 'x-entity-team-id: <TEAM_ID>' \
  -d '{
    "service": "api-catalog",
    "method": "POST",
    "path": "/api/v1/onboarding/git",
    "body": {
      "via_integrations": true,
      "git_service_name": "github",
      "workspace_id": "<WORKSPACE_UUID>",
      "git_token_id": "<POSTMAN_GITHUB_OAUTH_TOKEN_ID>",
      "git_owner": "<GITHUB_ORG>",
      "git_repository_id": "<REPO_NAME>",
      "git_repository_name": "<REPO_NAME>",
      "service_id": "<STRING_SERVICE_ID>",
      "environment_id": "<POSTMAN_ENVIRONMENT_UID>"
    }
  }'
```

**Option B: Direct PAT** (recommended for automation — no stored OAuth token needed):

```bash
curl -X POST 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy' \
  -H 'content-type: application/json' \
  -H 'x-access-token: <ACCESS_TOKEN>' \
  -H 'x-entity-team-id: <TEAM_ID>' \
  -d '{
    "service": "api-catalog",
    "method": "POST",
    "path": "/api/v1/onboarding/git",
    "body": {
      "via_integrations": false,
      "git_service_name": "github",
      "workspace_id": "<WORKSPACE_UUID>",
      "git_repository_url": "https://github.com/<ORG>/<REPO>",
      "git_api_key": "<GITHUB_PAT>",
      "service_id": <NUMERIC_SERVICE_ID>,
      "environment_id": "<POSTMAN_ENVIRONMENT_UID>"
    }
  }'
```

> **Critical difference:** With `via_integrations: false`, `service_id` must be a **number**. With `via_integrations: true`, it must be a **string**.

### Step 4: Convert Discovered → Managed (Akita Backend)

This tells the Akita/Observability backend that the service has been onboarded in the API Catalog.

```bash
curl -X POST 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy' \
  -H 'content-type: application/json' \
  -H 'x-access-token: <ACCESS_TOKEN>' \
  -H 'x-entity-team-id: <TEAM_ID>' \
  -d '{
    "service": "akita",
    "method": "POST",
    "path": "/v2/api-catalog/services/onboard",
    "body": {
      "services": [
        {
          "service_id": "svc_XXXXXXXXXXXXXXXXXXXX",
          "workspace_id": "<WORKSPACE_UUID>",
          "system_env": "<SYSTEM_ENVIRONMENT_UUID>"
        }
      ]
    }
  }'
```

> **Note:** `service_id` here is the `svc_*` provider ID from the Insights agent discovery, NOT the numeric catalog ID.

### Step 5: Acknowledge Workspace Onboarding (via Bifrost) -- CRITICAL

**This is the step that clears the `403 "onboarding not acknowledged"` error from the agent.** Without this, the agent cannot create learn sessions or upload traffic for services in the workspace.

The endpoint is NOT directly accessible at `api.observability.postman.com` (returns 404). It must be called through Bifrost with service `akita`:

```bash
curl -X POST 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy' \
  -H 'content-type: application/json' \
  -H 'x-access-token: <ACCESS_TOKEN>' \
  -H 'x-entity-team-id: <TEAM_ID>' \
  -d '{
    "service": "akita",
    "method": "POST",
    "path": "/v2/workspaces/<WORKSPACE_UUID>/onboarding/acknowledge",
    "body": {}
  }'
```

Verify acknowledgment:

```bash
curl -X POST 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy' \
  -H 'content-type: application/json' \
  -H 'x-access-token: <ACCESS_TOKEN>' \
  -H 'x-entity-team-id: <TEAM_ID>' \
  -d '{
    "service": "akita",
    "method": "GET",
    "path": "/v2/workspaces/<WORKSPACE_UUID>/onboarding/acknowledge",
    "body": {}
  }'
```

> **This must be done for EVERY workspace** that has Insights-linked services. The acknowledgment is workspace-scoped, not service-scoped.

### Step 6: Application Binding (Akita Backend via Agent API)

Creates the application binding for the workspace in the target system environment. Without this, traffic won't map correctly to the system environment. Note the different endpoint path (`/v2/agent/api-catalog/...`).

```bash
curl -X POST 'https://api.observability.postman.com/v2/agent/api-catalog/workspaces/<WORKSPACE_UUID>/applications' \
  -H 'content-type: application/json' \
  -H 'x-api-key: <PMAK_API_KEY>' \
  -d '{
    "system_env": "<SYSTEM_ENVIRONMENT_UUID>"
  }'
```

### Step 7: Create Postman Environment

Create a Postman environment inside the workspace. This gives the service a deployment context.

```bash
curl -X POST 'https://api.getpostman.com/environments' \
  -H 'X-Api-Key: <PMAK_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "environment": {
      "name": "Production",
      "values": []
    }
  }'
# Extract environment UUID from response
```

### Step 8: Associate Postman Environment to System Environment

Link the newly created Postman environment to the target system environment in the API Catalog.

```bash
curl -X PUT 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy' \
  -H 'content-type: application/json' \
  -H 'x-access-token: <ACCESS_TOKEN>' \
  -H 'x-entity-team-id: <TEAM_ID>' \
  -d '{
    "service": "api-catalog",
    "method": "PUT",
    "path": "/api/system-envs/associations",
    "body": {
      "systemEnvironmentId": "<SYSTEM_ENVIRONMENT_UUID>",
      "workspaceEntries": [
        {
          "workspaceId": "<WORKSPACE_UUID>",
          "postmanEnvironmentIds": ["<POSTMAN_ENVIRONMENT_UUID>"]
        }
      ]
    }
  }'
```

### Step 9: Restart the Agent

After all onboarding steps are complete, restart the DaemonSet to pick up the new state:

```bash
kubectl rollout restart daemonset/postman-insights-agent -n postman-insights-namespace
```

## Verification Token

The Insights agent uses a **team verification token** for DaemonSet telemetry. Without it, the agent logs `"Postman Insights verification token is empty"` and the cluster won't appear in the Insights UI agent management list.

### How to Get the Verification Token

The token is retrieved per-workspace from the Observability API:

```bash
curl -X GET 'https://api.observability.postman.com/v2/workspaces/<WORKSPACE_UUID>/team-verification-token' \
  -H 'x-access-token: <ACCESS_TOKEN>'
```

Response:

```json
{
  "team_id": "13347347",
  "team_verification_token": "<TOKEN_VALUE>",
  "kubernetes_cluster": [
    {
      "name": "se-catalog-demo",
      "last_telemetry_at": "2026-03-10T01:23:45Z",
      "active": true
    }
  ]
}
```

### How to Set the Verification Token

The token is set as an environment variable on the DaemonSet. Update the Kubernetes secret:

```bash
kubectl create secret generic postman-agent-secrets \
  --namespace postman-insights-namespace \
  --from-literal=postman-api-key=<PMAK_API_KEY> \
  --from-literal=postman-verification-token=<TEAM_VERIFICATION_TOKEN> \
  --dry-run=client -o yaml | kubectl apply -f -
```

Then reference it in the DaemonSet manifest:

```yaml
env:
- name: POSTMAN_INSIGHTS_API_KEY
  valueFrom:
    secretKeyRef:
      name: postman-agent-secrets
      key: postman-api-key
- name: POSTMAN_INSIGHTS_VERIFICATION_TOKEN
  valueFrom:
    secretKeyRef:
      name: postman-agent-secrets
      key: postman-verification-token
```

The agent sends this token in the `postman-insights-verification-token` HTTP header when calling the DaemonSet telemetry endpoint:

```
POST /v2/agent/daemonset/telemetry
Header: postman-insights-verification-token: <TOKEN_VALUE>
Body: { "kubernetes_cluster": "<CLUSTER_NAME>" }
```

Restart the DaemonSet after updating:

```bash
kubectl rollout restart daemonset/postman-insights-agent -n postman-insights-namespace
```

## W3C Traceparent Propagation

For the Service Graph to correctly attribute dependencies and create edges, the Akita backend relies heavily on **W3C trace context**. Captured witnesses must include full HTTP headers, and your application code must handle trace propagation.

Generated apps must:
1. **Read** inbound `traceparent` headers.
2. **Create** a new root `traceparent` if one is missing.
3. **Forward** the `traceparent` context on every outbound HTTP call.

Without this, the backend edge builder cannot derive the `TraceID` and will never write `service_edges`. This must be paired with `--repro-mode` on the DaemonSet so payload-bearing witnesses are enabled.

## Traffic Capture: Host Network Configuration

### The Problem

On EKS with VPC CNI, the DaemonSet agent runs on the **host network namespace** (`hostNetwork: true`) but service pods run in their **own network namespaces** with ENI-backed interfaces. The agent can only capture on `lo` (loopback) — it cannot see pod-to-pod traffic that traverses the VPC CNI overlay.

Agent logs show:
```
Running learn mode on interfaces lo
```

And ENI interface warnings:
```
ens5: No such device exists
eni*: No such device exists
```

### How Postman's Internal Dogfooding Works

Postman's own internal deployment captures traffic on **both `eth0` and `lo`** interfaces. From the internal telemetry data (Insights #blueprint collection, "Post client capture stats" request):

```json
"top_by_interface": {
  "eth0": {
    "http_requests": 2042781,
    "http_responses": 1972964,
    "tcp_packets": 28340020
  },
  "lo": {
    "http_requests": 2042782,
    "http_responses": 2040227,
    "tcp_packets": 24361701
  }
}
```

This works because their service pods run with `hostNetwork: true`, meaning the pod shares the host's network namespace. Traffic to the pod arrives on the host's `eth0` and is also visible on `lo` when services bind to `localhost`.

### Solution: Configure Service Pods with hostNetwork

To replicate the dogfooding setup, service pods must share the host's network namespace so the DaemonSet agent can capture their traffic.

**Service Deployment with hostNetwork:**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: af-cards-3ds
  namespace: se-catalog-demo
spec:
  replicas: 1
  selector:
    matchLabels:
      app: af-cards-3ds
  template:
    metadata:
      labels:
        app: af-cards-3ds
    spec:
      hostNetwork: true       # Share host network namespace
      dnsPolicy: ClusterFirstWithHostNet  # Required when hostNetwork: true
      containers:
      - name: af-cards-3ds
        image: <IMAGE>
        ports:
        - containerPort: 5001  # Must be unique per node
          hostPort: 5001
```

**DaemonSet Agent (unchanged):**

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: postman-insights-agent
  namespace: postman-insights-namespace
spec:
  template:
    spec:
      hostNetwork: true
      hostPID: true
      serviceAccountName: postman-insights-service-account
      containers:
      - name: postman-insights-agent
        image: public.ecr.aws/postman/postman-insights-agent:latest
        securityContext:
          privileged: true
        args:
        - kube
        - run
        - --discovery-mode
        - --repro-mode
        volumeMounts:
        - name: proc
          mountPath: /host/proc
          readOnly: true
        - name: cri
          mountPath: /var/run/containerd/containerd.sock
          readOnly: true
      volumes:
      - name: proc
        hostPath:
          path: /proc
      - name: cri
        hostPath:
          path: /var/run/containerd/containerd.sock
```

### hostNetwork Considerations

| Concern | Impact | Mitigation |
|---------|--------|------------|
| **Port conflicts** | Each pod on a node must use unique ports | Assign distinct ports per service (5001, 5002, etc.) |
| **DNS resolution** | Pod DNS doesn't work by default with hostNetwork | Set `dnsPolicy: ClusterFirstWithHostNet` |
| **Security** | Pod has full access to host network stack | Use NetworkPolicies, limit to non-production or demo clusters |
| **Scheduling** | Service graph attribution breaks if multiple discovery services share one node IP | Enforce anti-affinity + topology spread so each discovery service gets a dedicated node/IP |
| **Service discovery** | ClusterIP services still work but traffic routes differently | Use NodePort or hostPort for external access |

For `k8s_discovery`, `hostNetwork` alone is not enough for graph edges. The DaemonSet backend resolves traffic from observed source/destination IPs, so every graph-participating discovery workload must have a unique node IP. The deploy pipeline now treats this as a dedicated-IP topology:

- every discovery deployment is labeled for dedicated-IP scheduling
- `podAntiAffinity` and `topologySpreadConstraints` keep discovery services from landing on the same node
- rollout fails early if the cluster does not have enough schedulable nodes for the active discovery services
- inter-service dependency traffic is reconciled to `http://<node-ip>:<hostPort>/svc/<service>` after rollout instead of relying on `svc.cluster.local`

### Alternative: Sidecar Injection (Workspace Mode)

If `hostNetwork` is not acceptable, use **sidecar injection** instead of the DaemonSet. Each service pod gets its own Insights agent container that captures traffic from within the pod's network namespace.

```bash
postman kube inject \
  --workspace-id <WORKSPACE_UUID> \
  --system-env <SYSTEM_ENVIRONMENT_UUID> \
  -f deployment.yaml | kubectl apply -f -
```

This injects a sidecar container into each pod that:
- Shares the pod's network namespace (sees `eth0` traffic)
- Authenticates with workspace-specific credentials
- Doesn't require `hostNetwork` on the service pod

| | DaemonSet (Discovery) | Sidecar (Workspace) |
|---|---|---|
| **Setup** | Deploy once, auto-discovers | Per-service injection |
| **Traffic capture** | Requires `hostNetwork` on service pods | Works with any pod networking |
| **New services** | Auto-discovered | Must inject each new service |
| **Port conflicts** | Yes, with `hostNetwork` | No |
| **Best for** | Demo/dev clusters, `hostNetwork`-compatible workloads | Production, VPC CNI, strict networking |

## Agent API Reference

All agent endpoints use `x-api-key` header with the PMAK API key unless otherwise noted.

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/v2/agent/user` | GET | `x-api-key` | Validate API key, get user/team info |
| `/v2/agent/services/:service_id` | GET | `x-api-key` | Get service details (returns 403 if onboarding not acknowledged) |
| `/v2/agent/services/:service_id/settings` | GET | `x-api-key` | Get service settings (redaction config, repro mode) |
| `/v2/agent/services/:service_id/learn` | POST | `x-api-key` + `x-postman-env` | Create learn session for traffic capture |
| `/v2/agent/services/:service_id/learn` | GET | `x-api-key` + `x-postman-env` | List learn sessions |
| `/v2/agent/services/:service_id/learn/:sessionId/async_reports` | POST | `x-postman-env` | Upload captured traffic witnesses |
| `/v2/agent/services/:service_id/telemetry/client/deployment` | POST | (none) | Upload capture stats (packet counts by interface/port/host) |
| `/v2/agent/services/:service_id/telemetry/client/deployment/start` | POST | (none) | Report agent start telemetry |
| `/v2/agent/daemonset/telemetry` | POST | `postman-insights-verification-token` | DaemonSet cluster telemetry |
| `/v2/agent/workspaces/:workspaceID/services` | POST | `x-api-key` | Create a new service in workspace mode |

## Service Graph

The service graph is populated from **observed traffic** between services. The agent captures HTTP request/response pairs, uploads them as witnesses, and the Akita backend builds a dependency graph.

Query the service graph:

```bash
# Get full workspace service graph (MUST use Bifrost; api.observability.postman.com returns 404)
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

# Get edges for a specific service (also via Bifrost)
curl -X POST 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy' \
  -H 'content-type: application/json' \
  -H 'x-access-token: <ACCESS_TOKEN>' \
  -H 'x-entity-team-id: <TEAM_ID>' \
  -d '{
    "service": "akita",
    "method": "GET",
    "path": "/v3/services/<SERVICE_ID>/service-graph-edges",
    "body": {}
  }'
```

**Note:** Direct `GET https://api.observability.postman.com/v2/api-catalog/workspaces/.../service-graph` returns 404. Use Bifrost with `service: "akita"` (not `api-catalog`).

## Troubleshooting

### `403 "onboarding not acknowledged"`

**Cause:** Workspace onboarding acknowledgment (Step 5) was not completed.

**Fix:** Must go through Bifrost (direct `api.observability.postman.com` returns 404):
```bash
curl -X POST 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy' \
  -H 'content-type: application/json' \
  -H 'x-access-token: <ACCESS_TOKEN>' \
  -H 'x-entity-team-id: <TEAM_ID>' \
  -d '{"service":"akita","method":"POST","path":"/v2/workspaces/<WORKSPACE_UUID>/onboarding/acknowledge","body":{}}'
```

### `"Postman Insights verification token is empty"`

**Cause:** The `POSTMAN_INSIGHTS_VERIFICATION_TOKEN` env var is not set on the DaemonSet.

**Fix:** Retrieve the token from `/v2/workspaces/<WORKSPACE_UUID>/team-verification-token` and set it as a Kubernetes secret (see Verification Token section above).

### `endpointsCount: 0` on all services

**Cause:** Agent can only capture on `lo` interface. Service pods are not using `hostNetwork`, so traffic is invisible to the DaemonSet.

**Fix:** Either:
1. Set `hostNetwork: true` on service pods (see Host Network Configuration section)
2. Switch to sidecar injection mode

### `no insights project found for workspace`

**Cause:** The workspace has no Insights project. This happens when services were provisioned with `k8s_discovery_workspace_link=false` (skipping workspace bootstrap) or when onboarding was never completed.

**Fix:** The workspace must have services onboarded (converted from discovered to managed) to create an Insights project. Either:
1. Re-provision with `k8s_discovery_workspace_link=true` so the finalize step runs full onboarding
2. Manually run the onboarding flow (prepare-collection, git, onboard, acknowledge) for the workspace
3. Use a workspace that already has onboarded services (e.g. from a prior k8s_workspace or ECS provision)

### `projectID: svc_0000000000000000000000`

**Cause:** Agent can't map pods to their discovered service IDs. Usually caused by the 403 onboarding error preventing the agent from fetching service metadata.

**Fix:** Complete all onboarding steps (especially Step 5), then restart the DaemonSet.

### RBAC errors: `"cannot list pods at cluster scope"`

**Cause:** DaemonSet pods have stale ServiceAccount tokens from before the ClusterRoleBinding was created.

**Fix:**
```bash
kubectl rollout restart daemonset/postman-insights-agent -n postman-insights-namespace
```

### Services discovered but not appearing in API Catalog

**Cause:** Discovery traffic has a TTL window (~24h). If services aren't onboarded within that window, the agent pauses capture.

**Fix:** Complete onboarding steps promptly after discovery. If the window has expired, restart the DaemonSet to re-discover.

## Source References

- **Insights #blueprint collection** — `Insights APIs` workspace (`eb967314-3b6f-4861-bb5f-e3b4df02f073`)
- **Dogfooding - API observability** workspace (`76316670-d69a-4b96-805b-9bc952b0f5d6`)
- **API Catalog Service** workspace (`4d1ceb70-3c30-4d0f-a678-f0e4a1f73c96`)
- **Postman Internal Services** workspace (`70986393-06b3-40cc-908f-1d5575b8aa04`)
- Agent image: `public.ecr.aws/postman/postman-insights-agent:latest`
- Agent manifest: `https://releases.observability.postman.com/scripts/postman-insights-agent-daemonset.yaml`
- `postman-cs/postman-insights-onboarding-action` — GitHub Action for automated onboarding
- `api-catalog-service` repo in `postman-eng` — Source for `onServiceIntegrated` → `integrateServices` flow
