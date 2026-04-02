# Chaos Engineering Realism and Control Model
> **Document role:** Runbook
> **Canonical parent:** vzw/internal-catalog/docs/README.md

## Overview

The API Catalog Demo Infrastructure includes a robust, profile-driven Chaos Engineering engine built into the generated Python Flask runtimes. It replaces the legacy boolean-only approach with configurable profiles that allow you to test how clients handle realistically degraded services.

## Profiles and Configuration

Chaos configuration is driven by the `CHAOS_CONFIG` environment variable, passed as a JSON string during provisioning. The configuration supports setting default behaviors based on the deployment tier (prod, stage, dev) and can be overridden.

### Supported Fault Types

1.  **error** (default): Returns a specified HTTP status code (default `503`).
2.  **latency**: Injects a sleep delay before fulfilling the request normally.
3.  **timeout**: Injects a massive sleep delay (`30s`) and returns an HTTP `504 Gateway Timeout`.

### Default Tier Policies

If a custom configuration is not provided during provisioning, the system applies the following defaults:
-   **prod**: `{"fault_type": "latency", "latency_ms": 1500, "fault_rate": 0.05}` (5% chance of adding 1.5s delay)
-   **stage**: `{"fault_type": "error", "status_code": 503, "fault_rate": 0.20}` (20% chance of returning a 503 error)
-   **dev**: `{"fault_type": "error", "status_code": 500, "fault_rate": 0.50}` (50% chance of returning a 500 error)

## Deterministic Behavior

To prevent flapping and ensure realistic testing scenarios, fault injection decisions are **deterministic** within 5-minute time windows per service. This is achieved by combining a service-specific `seed` (generated during deployment) with the current time window.

This means if a specific service instance enters a degraded state, it will consistently exhibit the same failure pattern for the remainder of the 5-minute window, accurately simulating partial infrastructure outages.

## Control Plane and Visibility

Operators can toggle chaos globally or on a per-environment basis via the Catalog UI. The UI interacts with the `PATCH /api/catalog/:id/chaos` endpoint. 

The worker intelligently merges partial failures, ensuring that the Airtable metadata accurately reflects the true state of the runtime instances. The Backstage catalog feed also exposes these outcomes to downstream consumers via the `catalog-admin.postman.com/chaos-enabled` annotations.

## Safe Defaults and Exemptions

Critical diagnostic endpoints (`/health` and `/chaos`) are inherently exempt from fault injection, guaranteeing that observability and control plane mechanisms remain operational even during heavy degradation.

## Migration Path

Existing repositories that were provisioned before this feature was introduced only contain the `CHAOS_ENABLED` repository variable. The updated runtime generator is fully backward compatible:
- It respects `CHAOS_ENABLED="true"` as a fallback.
- It degrades to the legacy default behavior (20% chance of 503 error) when `CHAOS_CONFIG` is missing or malformed.
- The UI handles the legacy boolean state correctly, and future updates to these services will automatically adopt the new configuration structure.
