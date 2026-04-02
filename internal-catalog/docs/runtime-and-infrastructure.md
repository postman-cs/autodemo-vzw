# Runtime and Infrastructure

> **Document role:** Reference
> **Canonical parent:** vzw/internal-catalog/docs/README.md

## Runtime Modes

Provisioning supports four runtime modes, selected in the admin UI or via `POST /api/provision`:

| Mode | Infrastructure | Insights Integration |
|------|---------------|---------------------|
| `lambda` | AWS Lambda + API Gateway | None |
| `ecs_service` | ECS Fargate (ARM64) + shared ALB | Sidecar (workspace mode) |
| `k8s_workspace` | EKS (ARM64) + NGINX Ingress | Sidecar via `kube inject` (workspace mode) |
| `k8s_discovery` | EKS (ARM64) + NGINX Ingress | Shared DaemonSet via `kube run` (discovery mode) |

All container modes (ECS, k8s) build ARM64 Docker images and push to the shared ECR repository.

### Kubernetes Modes

Both k8s modes deploy to the `vzw-partner-demo` EKS cluster in eu-central-1 using path-based ingress routing (`https://<NLB>/svc/<project-slug>`).

- **k8s_workspace**: Injects the Postman Insights Agent as a sidecar into the workload pod, configured with a workspace ID and system environment ID.
- **k8s_discovery**: Deploys the workload without a sidecar. Requires a shared Insights DaemonSet to already be active in the cluster. The DaemonSet is shared infrastructure and is never deleted during per-service teardown.

Runtime availability is reported by `GET /api/config` and depends on worker secrets being configured (`KUBECONFIG_B64`, `K8S_INGRESS_BASE_DOMAIN`, and mode-specific prerequisites).

### Discovery Shared Infrastructure

Discovery shared infra is managed outside per-service provisioning:

- `POST /api/infra/k8s-discovery/setup` creates/verifies the shared discovery DaemonSet and records status in Airtable `Infrastructure`.
- `POST /api/infra/k8s-discovery/teardown` tears down the shared DaemonSet only when no active `k8s_discovery` services remain.
- `GET /api/infra/resources?component=k8s_discovery_shared` returns inventory for the shared discovery infra record.

Per-service teardown (`POST /api/teardown`) deletes only service workload resources (Deployment/Service/Ingress) and must not delete the shared discovery DaemonSet.

### EKS Infrastructure

- Cluster: `vzw-partner-demo` (Kubernetes 1.31, eu-central-1)
- Nodes: `c7g.large` ARM64 managed node group (`vzw-partner-demo-nodes-c7g-large`, desired/min 7, max 12)
- Ingress: NGINX Ingress Controller with NLB
- Namespace: `vzw-partner-demo`
- RBAC: Role `se-catalog-deployer` (namespace-scoped: deployments, services, ingresses, pods) + ClusterRole `se-catalog-daemonset-manager`
- Auth: `API-Catalog-Demo-User` mapped via aws-auth to k8s group `se-catalog-deployers`

### GitHub Repo Variables (on `postman-cs/vzw-partner-demo`)

Non-secret configuration values used by k8s and infra workflows:

| Variable | Value | Used by |
|----------|-------|---------|
| `AWS_ROLE_ARN` | `arn:aws:iam::780401591112:role/API-Catalog-Demo-User` | AWS operations |
| `POSTMAN_INSIGHTS_CLUSTER_NAME` | `vzw-partner-demo` | k8s discovery infra setup, provisioned repo workflows |
| `K8S_INGRESS_BASE_DOMAIN` | `a85da2cf565d24f02bc3f93403f2f04e-779b2c9673d3aed1.elb.eu-central-1.amazonaws.com` | k8s ingress routing, infra Airtable records |

To get kubectl access:

```bash
aws eks update-kubeconfig --name vzw-partner-demo --region eu-central-1 --profile vzw-partner-demo-user
```

## Insights Dependency Graph (Sidecar Mode)

The Postman Insights Agent sidecar builds dependency graphs from real observed traffic using passive packet capture (pcap). No DaemonSet is required -- the per-pod sidecar is sufficient for workspace mode.

**How it works:**

1. **Identity registration**: Each sidecar registers its service identity at startup via `frontClient.CreateApplication(workspaceID, systemEnv)`. The `POSTMAN_K8S_POD_IP` env var (injected via Kubernetes downward API by `kube inject`) tells the Postman backend which pod IP maps to which ServiceID.
2. **Traffic capture**: The sidecar captures all TCP traffic on `lo` and `eth0`. Each uploaded `WitnessReport` contains `OriginAddr`/`OriginPort` (caller) and `DestinationAddr`/`DestinationPort` (target).
3. **IP resolution**: The Postman backend resolves source/destination IPs to registered ServiceIDs and draws dependency edges.

**Critical requirement -- ClusterIP routing for inter-service traffic:**

The synthetic dependency caller (`DEPENDENCY_TARGETS_JSON`) must use internal ClusterIP DNS URLs, not the external NLB hostname. Traffic routed through the NLB/ingress destroys pod IP identity (the sidecar sees NLB or ingress-controller IPs instead of the peer pod's IP), which prevents the backend from resolving dependency edges.

Correct URL format (ClusterIP DNS):

```
http://<service-name>.vzw-partner-demo.svc.cluster.local/svc/<service-name>
```

Wrong URL format (NLB -- breaks dep graph):

```
http://a85da2cf565d24f02bc3f93403f2f04e-779b2c9673d3aed1.elb.eu-central-1.amazonaws.com/svc/<service-name>
```

The provisioning worker generates these URLs in `src/lib/provision.ts`. If existing deployments have stale NLB-based targets, patch them in-place:

```bash
kubectl set env deployment/<name> -n vzw-partner-demo -c api \
  DEPENDENCY_TARGETS_JSON='["http://<target>.vzw-partner-demo.svc.cluster.local/svc/<target>"]'
```

**Sidecar env vars (injected automatically by `kube inject`):**

| Env Var | Source | Purpose |
|---------|--------|---------|
| `POSTMAN_K8S_POD_IP` | `status.podIP` | IP->ServiceID registration (critical for dep graph) |
| `POSTMAN_K8S_NODE` | `spec.nodeName` | Node identity |
| `POSTMAN_K8S_NAMESPACE` | `metadata.namespace` | Namespace identity |
| `POSTMAN_K8S_POD` | `metadata.name` | Pod identity |
| `POSTMAN_K8S_HOST_IP` | `status.hostIP` | Host node IP |

**Sidecar vs DaemonSet:**

- **Sidecar** (`kube inject --workspace-id`): Per-pod agent, captures that pod's traffic. Used by `k8s_workspace` mode. Sufficient for dependency graphs when traffic uses ClusterIP routing.
- **DaemonSet** (`kube run --discovery-mode`): Per-node agent, captures all node traffic. Used by `k8s_discovery` mode for cluster-wide passive discovery. Not needed when sidecars are already injected.

## ECR Permissions

All container runtime modes (`ecs_service`, `k8s_workspace`, `k8s_discovery`) require these ECR read/write actions for `API-Catalog-Demo-User`:

- `ecr:GetAuthorizationToken`
- `ecr:BatchGetImage`
- `ecr:GetDownloadUrlForLayer`
- `ecr:BatchCheckLayerAvailability`
- `ecr:InitiateLayerUpload`
- `ecr:UploadLayerPart`
- `ecr:CompleteLayerUpload`
- `ecr:PutImage`

Validation probes:

```bash
aws ecr batch-get-image \
  --profile vzw-partner-demo-user \
  --region eu-central-1 \
  --repository-name vzw-partner-demo \
  --image-ids imageTag=non-existent-permission-probe

aws ecr get-download-url-for-layer \
  --profile vzw-partner-demo-user \
  --region eu-central-1 \
  --repository-name vzw-partner-demo \
  --layer-digest sha256:0000000000000000000000000000000000000000000000000000000000000000
```

Expected behavior:

- First command returns `ImageNotFound` (not `AccessDeniedException`).
- Second command returns `LayersNotFoundException` (not `AccessDeniedException`).

If provisioning fails with `403 Forbidden` during ECR manifest HEAD/push, re-run the probes above and confirm `ecr:BatchGetImage` is explicitly allowed for `API-Catalog-Demo-User`.
