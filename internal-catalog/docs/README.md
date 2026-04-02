# Internal Catalog Docs

Canonical index for the `vzw/internal-catalog/docs/` subtree. Use this file as the parent entrypoint for onboarding guides, operator runbooks, reference material, research notes, and planning docs.

## Onboarding

- [insights-onboarding.md](./insights-onboarding.md) -- Full Insights agent onboarding flow with architecture, acknowledgment, verification token setup, and service graph requirements.

## Operations / Runbooks

- [trace-headers-k8s-insights-runbook.md](./trace-headers-k8s-insights-runbook.md) -- Traceparent header setup for Kubernetes workloads so Insights can build service graph edges.
- [service-graph-troubleshooting.md](./service-graph-troubleshooting.md) -- Root cause analysis and remediation guide for isolated services and missing graph edges.
- [fern-integration-runbook.md](./fern-integration-runbook.md) -- Fern docs generation, publication flow, recovery paths, and ownership boundaries.
- [workspace-governance-rules.md](./workspace-governance-rules.md) -- Validated Bifrost request contract, required headers, and workspace governance operations.
- [runbooks/org-secrets.md](./runbooks/org-secrets.md) -- Org-level GitHub Actions secrets migration and rollback procedure.
- [runbooks/org-variables.md](./runbooks/org-variables.md) -- Org-level GitHub Actions variables migration and rollback procedure.
- [runbooks/chaos-engineering.md](./runbooks/chaos-engineering.md) -- Chaos engineering control model, fault profiles, and operator controls.
- [runbooks/2026-03-27-vzw-partner-demo-setup.md](./runbooks/2026-03-27-vzw-partner-demo-setup.md) -- Historical VZW demo setup log covering daemonset fixes, host networking, and onboarding state.
- [operations-reference.md](./operations-reference.md) -- API routes, worker auth, Backstage feed, Recovery Queue workflow, teardown guidance, and team credential sync architecture.

## Reference

- [bifrost-api-guide.md](./bifrost-api-guide.md) -- Bifrost API reference covering proxy mechanics, auth, available services, and troubleshooting.
- [pmak-to-access-token.md](./pmak-to-access-token.md) -- PMAK to `x-access-token` exchange limits and the resulting operational constraints for internal APIs.
- [runtime-and-infrastructure.md](./runtime-and-infrastructure.md) -- Runtime modes, k8s/EKS infrastructure details, Insights sidecar dependency graph behavior, and ECR permissions.
- [provisioning-architecture.md](./provisioning-architecture.md) -- Provisioning workflow architecture, lifecycle behavior, service graph topology provisioning, and traffic generation.

## Research / Logs

- [insights-bifrost-api-log.md](./insights-bifrost-api-log.md) -- Bifrost and Insights lab log documenting the manual service-graph investigation and confirmed findings.

## Plans

- [plans/org-mode-subteam-selection.md](./plans/org-mode-subteam-selection.md) -- Historical plan and evidence for enabling org-mode sub-team selection in provisioning.

## README Decomposition

Deep operational sections from [`../README.md`](../README.md) now live in dedicated docs:

- [runtime-and-infrastructure.md](./runtime-and-infrastructure.md)
- [provisioning-architecture.md](./provisioning-architecture.md)
- [operations-reference.md](./operations-reference.md)
