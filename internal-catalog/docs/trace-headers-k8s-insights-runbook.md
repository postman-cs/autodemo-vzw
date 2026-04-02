# Trace Headers in Kubernetes for Postman Insights Service Graph
> **Document role:** Runbook
> **Canonical parent:** vzw/internal-catalog/docs/README.md


> **Purpose:** This runbook explains how to set up W3C `traceparent` header propagation so that the Postman Insights Service Graph correctly discovers edges between your services running on Kubernetes.

---

## How the Service Graph Works

Postman Insights builds the service graph by capturing live HTTP traffic via a DaemonSet agent running in `--repro-mode`. The agent extracts `traceparent` headers from captured HTTP packets and groups them by Trace ID. When two services share the same Trace ID, the backend infers an edge (Service A → Service B).

**No traceparent = no edges.** The graph will show isolated services with no connections.

```
Request arrives at Service A
  → Service A reads/creates traceparent header
  → Service A calls Service B, forwarding the SAME traceparent
  → Insights agent captures both hops
  → Backend correlates by Trace ID → draws edge A → B
```

---

## Requirements Checklist

All six are mandatory for graph edges:

- [ ] **DaemonSet runs with `--repro-mode`** — without it, agents don't capture HTTP headers
- [ ] **W3C `traceparent` propagated** on all inter-service HTTP calls
- [ ] **`hostNetwork: true`** on all service pods (required for DaemonSet packet capture on EKS VPC CNI)
- [ ] **`dnsPolicy: ClusterFirstWithHostNet`** paired with hostNetwork
- [ ] **All services in the same `system_env`**
- [ ] **Workspace onboarding acknowledged** (clears agent 403)

---

## W3C `traceparent` Header Format

```
traceparent: 00-<32-hex-trace-id>-<16-hex-span-id>-01
```

Example:
```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
```

- `00` = version
- 32-hex = Trace ID (shared across the entire call chain)
- 16-hex = Span ID (unique per hop)
- `01` = trace flags (sampled)

---

## Implementation: Python / Flask (Generated Services)

Generated Flask apps automatically include traceparent propagation. Here's how it works:

### 1. Inbound: Extract or Create

In `app/__init__.py`, lifecycle hooks handle inbound requests:

```python
import uuid, os
from flask import request, g

@app.before_request
def _extract_trace():
    tp = request.headers.get("traceparent", "")
    if not tp or len(tp.split("-")) != 4:
        # No valid traceparent — create a root trace
        tp = f"00-{uuid.uuid4().hex}-{os.urandom(8).hex()}-01"
    g.traceparent = tp

@app.after_request
def _inject_trace(response):
    # Echo traceparent on responses (useful for debugging)
    response.headers["traceparent"] = getattr(g, "traceparent", "")
    return response
```

### 2. Outbound: Forward on All HTTP Calls

In `app/dependency_caller.py`, every outbound HTTP request forwards the header:

```python
# Propagate W3C traceparent from request context
trace_headers = {}
try:
    tp = getattr(g, "traceparent", "")
    if tp:
        trace_headers["traceparent"] = tp
except RuntimeError:
    pass

# All outbound calls include trace_headers
if method in ("POST", "PUT", "PATCH"):
    resp = http_client.request(method, url, json={}, timeout=2, headers=trace_headers)
else:
    resp = http_client.get(url, timeout=2, headers=trace_headers)
```

**Key point:** Every HTTP call your service makes to another service must include the `traceparent` header from the current request context.

---

## Implementation: Go (Reference — Lab Services)

The lab services use a shared `traceutil` package:

### Trace Utility (`internal/traceutil/trace.go`)

```go
package traceutil

import (
    "context"
    "crypto/rand"
    "encoding/hex"
    "net/http"
    "strings"
)

const HeaderName = "traceparent"

type contextKey struct{}

// WithInboundRequest reads traceparent from the inbound request.
// If missing or invalid, creates a new root trace.
func WithInboundRequest(r *http.Request) *http.Request {
    header := strings.TrimSpace(r.Header.Get(HeaderName))
    if !isValidTraceparent(header) {
        header = newRootTraceparent()
    }
    return r.WithContext(context.WithValue(r.Context(), contextKey{}, header))
}

// Attach sets the traceparent header on an outbound request
// from the request's context.
func Attach(req *http.Request) {
    req.Header.Set(HeaderName, HeaderFromContext(req.Context()))
}

func isValidTraceparent(value string) bool {
    parts := strings.Split(strings.TrimSpace(value), "-")
    return len(parts) == 4 && len(parts[1]) == 32 && len(parts[2]) == 16
}

func newRootTraceparent() string {
    return "00-" + randomHex(16) + "-" + randomHex(8) + "-01"
}
```

### Usage in a Handler

```go
func handleOrder(w http.ResponseWriter, r *http.Request) {
    // 1. Extract/create traceparent from inbound request
    r = traceutil.WithInboundRequest(r)

    // 2. Build outbound request to downstream service
    req, _ := http.NewRequestWithContext(r.Context(), "GET",
        "http://inventory-svc.se-catalog-demo.svc.cluster.local/items", nil)

    // 3. Attach traceparent to outbound request
    traceutil.Attach(req)

    resp, err := httpClient.Do(req)
    // ... handle response
}
```

### The Pattern (Any Language)

1. **Inbound:** Read `traceparent` from request headers. If missing, generate a root.
2. **Store:** Keep the traceparent in request-scoped context (Go `context.Context`, Flask `g`, Express `req.locals`, etc.)
3. **Outbound:** Attach the stored traceparent to every outgoing HTTP request.

---

## Kubernetes Configuration

### Pod Spec — hostNetwork + DNS

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-service
  namespace: se-catalog-demo
spec:
  template:
    spec:
      hostNetwork: true                        # Required for DaemonSet capture
      dnsPolicy: ClusterFirstWithHostNet        # Required with hostNetwork
      containers:
        - name: app
          image: 780401591112.dkr.ecr.eu-central-1.amazonaws.com/se-catalog-demo:my-service
          env:
            - name: PORT
              value: "5001"                     # Unique port per service
          ports:
            - containerPort: 5001
              hostPort: 5001
```

**Why `hostNetwork: true`?** EKS VPC CNI gives each pod its own ENI. The DaemonSet agent runs on the host network and can only capture traffic on host interfaces. Without `hostNetwork`, your service's traffic is invisible to the agent.

**Why unique ports?** With `hostNetwork`, all pods on a node share the same IP. Each service needs a distinct port to avoid collisions.

### Pod Anti-Affinity (Recommended)

Ensures each service lands on a different node, preventing IP-based edge attribution issues:

```yaml
spec:
  template:
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: my-service
              topologyKey: kubernetes.io/hostname
```

### Inter-Service URLs — Use ClusterIP DNS

The Insights backend resolves edges using the `Host` header. Always use DNS names, not raw IPs:

```
✅  http://order-svc.se-catalog-demo.svc.cluster.local:5002/orders
❌  http://10.0.1.47:5002/orders
```

---

## DaemonSet Configuration

The Insights DaemonSet must run with `--repro-mode` to capture HTTP headers:

```
kube run --discovery-mode --debug --repro-mode --include-namespaces se-catalog-demo
```

- `--repro-mode` — enables HTTP header capture (without this, `sends_witness_payloads: false`)
- `--include-namespaces` — isolates capture to your namespace
- `--debug` — verbose logging for troubleshooting

> ⚠️ The DaemonSet is **shared cluster infrastructure**. Never delete it during per-service teardown.

---

## Verifying It Works

### 1. Check DaemonSet Agent Status

```bash
# Agent health — look for sends_witness_payloads: true
curl "https://bifrost.../v2/services/{service_id}/agent-status?limit=5"

# Repro mode status — must be ALL ON
curl "https://bifrost.../v2/services/{service_id}/repro/agent-status"
```

### 2. Verify traceparent in Responses

```bash
curl -v http://<NLB>/svc/my-service/health 2>&1 | grep -i traceparent
# Should see: traceparent: 00-<32hex>-<16hex>-01
```

### 3. Check Service Graph Edges

```bash
# Direct edge query
curl "https://bifrost.../v3/services/{service_id}/service-graph-edges"

# Workspace-level graph
curl "https://bifrost.../v2/api-catalog/workspaces/{workspace_uuid}/service-graph?system_env={env_uuid}"
```

### 4. Force Model Rebuild (if edges are stale)

The graph reads from a pre-computed model, not real-time data. If edges don't appear after traffic is flowing:

```bash
curl -X POST "https://bifrost.../v2/support/services/{service_id}/rebuild-models-and-timelines"
```

---

## Common Mistakes

| Mistake | Symptom | Fix |
|---------|---------|-----|
| Missing `--repro-mode` on DaemonSet | `sends_witness_payloads: false` | Restart DaemonSet with `--repro-mode` |
| Not forwarding traceparent on outbound calls | Services appear but no edges | Add traceparent to all `requests.*()` calls |
| Using raw IPs instead of DNS names | Edges attributed to wrong services | Use `<svc>.<ns>.svc.cluster.local` URLs |
| Missing `hostNetwork: true` | Agent sees no traffic (`CAPTURE_EMPTY`) | Add to pod spec + set `dnsPolicy` |
| Multiple pods on same node | Edges wrongly merged | Add podAntiAffinity |
| Services in different `system_env` | Graph shows separate clusters | Ensure all share same system environment |
| Workspace not acknowledged | Agent returns 403 | Run workspace acknowledge API call |

---

## Red Herrings (These Are Normal)

- `identity_id = idt_0000000000000000000000` — normal for API-key auth
- `api_spec_ids = []` — graph edges work without spec association
- Graph updates lag by minutes — the model is pre-computed, not real-time

---

## Port Mapping Reference

| Service | Port |
|---------|------|
| af-cards-3ds | 5001 |
| af-cards-activation | 5002 |
| af-cards-authorization | 5003 |
| af-cards-disputes | 5004 |
| af-cards-fraud-detection | 5005 |
| af-cards-tokenization | 5006 |
| af-core-account-closure | 5007 |
