# PMAK → x-access-token: Internal Exchange Mechanism
> **Document role:** Reference
> **Canonical parent:** vzw/internal-catalog/docs/README.md


## Summary

The Postman Identity Service (`postman-eng/postman-identity-service`) exposes an internal endpoint that exchanges a Postman API key (PMAK) for a session-scoped `x-access-token`. This endpoint is **not available on the public API** (`api.postman.com`) — it runs behind internal networking on the identity microservice.

This is relevant because several internal Postman APIs (Bifrost, workspace governance) require an `x-access-token` and do **not** accept `X-Api-Key: PMAK-*` headers directly. This creates a hard dependency on manual token extraction for any automated provisioning, teardown, or orchestration workflow that touches these APIs.

## Impact on Programmatic Orchestration

Without a public PMAK → access-token exchange, **every automated pipeline that needs to call Bifrost or Postman internal APIs requires a human to manually log into the Postman CLI, extract the session token, and save it as a repo-scoped secret or worker secret.** The token comes from either:

1. `~/.postman/postmanrc` → `login._profiles[].accessToken` (after a `postman login` browser session)
2. The PKCE OAuth flow in the Postman CLI (`postman login` without `--with-api-key`)

Both require interactive browser authentication. The resulting token is short-lived and must be periodically refreshed by hand. There is no refresh-token mechanism exposed for programmatic renewal.

### What This Means in Practice

Our provisioning infrastructure dynamically retrieves `POSTMAN_ACCESS_TOKEN` alongside `POSTMAN_API_KEY` at runtime via the `resolve-credentials` action fetching from AWS Secrets Manager. Postman access tokens are only for downstream Postman/Bifrost APIs. **When the Postman access token expires, required Bifrost steps should now fail hard rather than silently degrading.**

This is the **#1 operational fragility** in the catalog provisioning system.

## Operations Requiring x-access-token

The following is a complete catalog of every operation in this codebase that requires `x-access-token` and **cannot** be performed with a PMAK API key alone.

### 1. Workspace ↔ Repository Git Sync (Bifrost)

| | |
|---|---|
| **What** | Connects a Postman workspace to a GitHub repository for source control sync |
| **API** | `POST https://bifrost-premium-https-v4.gw.postman.com/ws/proxy` |
| **Service** | `workspaces` → `POST /workspaces/{workspaceId}/filesystem` |
| **Header** | `x-access-token` (mandatory), `x-entity-team-id` |
| **Called by** | `postman-bootstrap-action` → `BifrostInternalIntegrationAdapter.connectWorkspaceToRepository()` |
| **Provisioning step** | "Connect Workspace via Bifrost" (pre-deploy and finalize phases) |
| **If token missing** | Step is skipped; workspace has no source control connection. Every provisioned service is affected. |
| **PMAK workaround** | ❌ None |

### 2. Governance Group Assignment

| | |
|---|---|
| **What** | Assigns a workspace to a domain-specific governance group (e.g., "Payments-APIs", "WealthMgmt-APIs") |
| **API** | `GET https://gateway.postman.com/configure/workspace-groups` (list groups) |
| | `PATCH https://gateway.postman.com/configure/workspace-groups/{groupId}` (assign workspace) |
| **Header** | `x-access-token` (mandatory) |
| **Called by** | `postman-bootstrap-action` → `BifrostInternalIntegrationAdapter.assignWorkspaceToGovernanceGroup()` |
| **If token missing** | Governance assignment is skipped entirely with a warning log. Workspace loses policy enforcement. |
| **PMAK workaround** | ❌ None |

### 3. System Environment Discovery

| | |
|---|---|
| **What** | Fetches available system environments (prod, staging, dev, etc.) from the Bifrost API |
| **API** | `POST https://bifrost-premium-https-v4.gw.postman.com/ws/proxy` |
| **Service** | `api-catalog` → `GET /api/system-envs` |
| **Header** | `x-access-token` (mandatory) |
| **Called by** | `src/lib/system-envs.ts` → `fetchSystemEnvironments()` |
| **Called during** | Provisioning (environment resolution), API endpoint `/api/system-envs` |
| **If token missing** | Falls back to `POSTMAN_SYSTEM_ENVS_JSON` worker binding (static, may be stale). If that's also missing, defaults to a single "prod" environment. |
| **PMAK workaround** | ❌ None (fallback exists but is degraded) |

### 4. System Environment Association (Provision)

| | |
|---|---|
| **What** | Associates Postman environments with system environments so Insights can correlate API traffic to deployment stages |
| **API** | Bifrost proxy → `GET /api/system-envs/associations` + `PUT /api/system-envs/associations` |
| **Header** | `x-access-token` (mandatory), `x-entity-team-id` |
| **Called by** | `src/lib/system-envs.ts` → `associateSystemEnvironmentBatch()` |
| **Called during** | Provisioning finalize/deploy phases via direct Bifrost association logic |
| **If token missing** | Associations are not created. Insights cannot map environments to system stages. |
| **PMAK workaround** | ❌ None |

### 5. System Environment Disassociation (Teardown)

| | |
|---|---|
| **What** | Removes workspace-environment associations from all system environments during teardown |
| **API** | Bifrost proxy → `GET /api/system-envs/associations` + `PUT /api/system-envs/associations` |
| **Header** | `x-access-token` (mandatory), `x-entity-team-id` |
| **Called by** | `src/lib/system-envs.ts` → `disassociateWorkspaceFromSystemEnvironments()` |
| **Called during** | Teardown postman phase |
| **If token missing** | Explicitly skipped: `results.postman_disassociate = "skipped_missing_access_token"`. Orphaned associations remain in Bifrost. |
| **PMAK workaround** | ❌ None |

### 6. Insights Service Deletion (Teardown + Provision Cleanup)

| | |
|---|---|
| **What** | Deletes an Insights (Akita) service project when tearing down or cleaning up a failed provision |
| **API** | `POST https://bifrost-premium-https-v4.gw.postman.com/ws/proxy` |
| **Service** | `akita` → `DELETE /v2/services/{serviceId}` |
| **Header** | `x-access-token` (mandatory), optionally `x-entity-team-id` |
| **Called by** | `src/lib/teardown.ts` → `deleteInsightsService()`, `src/lib/provision.ts` (cleanup path) |
| **If token missing** | Insights service is not deleted. Orphaned project remains in the Insights dashboard. |
| **PMAK workaround** | ❌ None |

### Summary: Degradation When POSTMAN_ACCESS_TOKEN Expires

| Operation | Behavior | Visible to User? |
|-----------|----------|-------------------|
| Workspace ↔ repo sync | Skipped silently | Only if user checks workspace settings |
| Governance group | Skipped with warning log | Only in GitHub Actions logs |
| System env discovery | Falls back to static JSON | No — appears to work |
| System env association | Skipped or fails | Only in SSE stream |
| System env disassociation | Skipped explicitly | Only in teardown response JSON |
| Insights service deletion | Skipped | Only in teardown response JSON |

**Net effect**: A provisioned service appears to complete successfully but is missing workspace-repo sync, governance policy enforcement, and proper environment-to-stage mapping. Teardown leaves orphaned Bifrost associations and Insights projects.

### Token Lifecycle

```
POSTMAN_ACCESS_TOKEN lifecycle (current state):

  Human logs in via browser
       │
       ▼
  ~/.postman/postmanrc → accessToken
       │
       ▼
  Manually copied to GitHub org secret (POSTMAN_ACCESS_TOKEN)
       │
       ▼
  Used by: worker (env binding) + provisioned workflows (repo secret)
       │
       ▼
  Token expires (no programmatic refresh)
       │
       ▼
  Pipeline silently degrades until human notices and repeats the cycle
```

There is no alerting, monitoring, or automated rotation for this token.

## The Endpoint

```
GET /api/keys/authenticate
```

- **Service**: `postman-eng/postman-identity-service`
- **Controller**: `ApiKeyController.authenticate`
- **Route definition**: `config/env/production.js`
- **Auth header**: `x-api-key: PMAK-...`

### Request

```http
GET /api/keys/authenticate HTTP/1.1
Host: <identity-service-internal-host>:1337
x-api-key: PMAK-<24-hex>-<34-hex>
```

### Response

```json
{
  "session": {
    "token": "<accessToken>",
    "status": "active",
    "data": {
      "scopes": ["..."],
      "identity": {
        "user": "...",
        "team": "..."
      }
    }
  }
}
```

The `session.token` value is the `x-access-token` that can be used with internal APIs.

## How It Works

1. The PMAK is read from the `x-api-key` request header.
2. `ApiKeyService.authenticate()` validates the key against the identity database.
3. A session is created via `IdentityService.createSession()`.
4. `IdentityService.getSessionData()` enriches the session with user/team identity and scopes.
5. The response includes the session object with a `token` field — this is the access token.

The session inherits the scopes defined on the API key (not the full set of scopes a browser-based session would have).

## Why This Matters

### The Two Auth Worlds

Postman's architecture has two distinct authentication mechanisms that are **not interchangeable** at the public API boundary:

| Mechanism | Header | Obtained via | Accepted by |
|-----------|--------|-------------|-------------|
| API Key (PMAK) | `X-Api-Key` | Postman UI → API Keys page | Public REST API (`api.postman.com`) |
| Session Token | `x-access-token` | Browser login / PKCE flow / identity service | Internal APIs (Bifrost, gateway, governance) |

The public Postman API resolves PMAK → session internally (via this same identity service endpoint), but **never exposes the resulting access token to the caller**.

### Postman CLI Behavior

The Postman CLI (`postman-cs/postman-cli-rust`) maintains these as separate, non-convertible auth paths:

- `postman login --with-api-key PMAK-...` → stores the PMAK, sends it as `X-Api-Key` on requests
- `postman login` (no `--with-api-key`) → runs PKCE browser OAuth flow, stores the resulting `x-access-token`

In `api_client.rs`:
```rust
request = match &self.config.auth {
    ApiAuth::ApiKey(value) => request.header("X-Api-Key", value),
    ApiAuth::AccessToken(value) => request.header("x-access-token", value),
};
```

No conversion happens client-side.

### Productization Blocker

Internal APIs like Bifrost (`bifrost-v10.getpostman.com/ws/proxy`) require `x-access-token` and reject `X-Api-Key`. This is documented as the **#1 productization blocker** for workspace ↔ repo git sync in the provisioning pipeline (see `postman-cs/portal-ci-bootstrap` README).

Current workaround: manually extract `accessToken` from `~/.postman/postmanrc` → `login._profiles[].accessToken` after a browser-based Postman login session.

## Related Endpoints on the Identity Service

| Route | Controller | Purpose |
|-------|-----------|---------|
| `GET /api/keys/authenticate` | `ApiKeyController.authenticate` | Exchange PMAK for session token |
| `GET /x/api/keys/availability` | `ApiKeyController.getKeyAvailability` | Verify key validity (server-auth) |
| `GET /api/keys` | `ApiKeyController` | List user's API keys (user-auth) |
| `POST /api/keys` | `ApiKeyController` | Create new API key (user-auth) |
| `PUT /api/keys/revoke` | `ApiKeyController.revokeUserAPIKey` | Revoke a key (user-auth) |
| `GET /api/team/keys` | `ApiKeyController.listTeamMembersApiKeys` | List team API keys (user-auth) |

## Inverse Flow: Access Token → PMAK Generation

While the internal `GET /api/keys/authenticate` exchanges a PMAK for an access token, it is sometimes necessary to perform the inverse: given an access token (e.g., from `postmanrc`), dynamically generate a Postman API Key (PMAK). 

This is now implemented in the Catalog Demo via the **UI Team Onboarding** flow:
1. The user uploads their `~/.postman/postmanrc` file (or pastes their `x-access-token`) in the "Register Team" modal.
2. The worker proxies a `POST /api/keys` request to the Bifrost `identity` service, authenticating with the provided `x-access-token`.
3. Bifrost generates a new PMAK (e.g., `catalog-demo-<slug>`).
4. The worker uses the new PMAK to call the public `GET https://api.getpostman.com/me` endpoint to discover the user's `teamId`, `teamName`, and `teamDomain` (used as the slug).
5. The full credential pair (PMAK + Access Token) is persisted to the `TEAM_REGISTRY` KV store for future automated workflows.

This significantly reduces manual credential shuffling and ensures both auth domains (internal Bifrost APIs and public REST APIs) are satisfied automatically.

## Source References

- **Identity service**: `postman-eng/postman-identity-service`
  - `api/controllers/ApiKeyController.js` — authenticate method
  - `api/services/IdentityService.js` — session creation
  - `config/env/production.js` — route definitions
- **CLI auth logic**: `postman-cs/postman-cli-rust`
  - `postman-cli/src/auth.rs` — `LoginProfile::with_api_key` vs `with_access_token`
  - `postman-cli/src/api_client.rs` — `ApiAuth` enum, header selection
- **Blocker documentation**: `postman-cs/portal-ci-bootstrap` README — productization blockers section
