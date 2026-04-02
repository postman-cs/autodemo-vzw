# Bifrost Comprehensive API Guide
> **Document role:** Reference
> **Canonical parent:** vzw/internal-catalog/docs/README.md


> **Last Updated:** 2026-03-14  
> **Sources:** Bifrost API #blueprint, Bifrost Header Based Forwarding, Dynamic Proxy Allowlisting, SanityCheckV12API through Bifrost, UMS (PHP) #blueprint, IAM Catalogue APIs, Billing #Service, Artemis Service #blueprint

---

## Table of Contents

- [Overview](#overview)
- [Universal Bifrost Guidance: Org Mode vs Non-Org Mode](#universal-bifrost-guidance-org-mode-vs-non-org-mode)
- [Bifrost Proxy Mechanics](#bifrost-proxy-mechanics)
- [Authentication](#authentication)
  - [Identity Resolution](#identity-resolution)
- [Services Available Through Bifrost](#services-available-through-bifrost)
  - [ACS (Access Control Service)](#acs-access-control-service)
  - [Annotation](#annotation)
  - [API Catalog](#api-catalog)
  - [Billing](#billing)
  - [Echo (Testing)](#echo-testing)
  - [Insights (Akita)](#insights-akita)
  - [Monitors V2](#monitors-v2)
  - [Ruleset](#ruleset)
  - [Sentinel](#sentinel)
  - [Skill](#skill)
  - [Sync](#sync)
  - [UMS (User Management Service / god-service)](#ums-user-management-service--god-service)
- [Header-Based vs Body-Based Proxy Forwarding](#header-based-vs-body-based-proxy-forwarding)
- [Environment-Specific URLs](#environment-specific-urls)
- [Artemis: Not a Separate Proxy](#artemis-not-a-separate-proxy)
- [Adding a New Service to Bifrost](#adding-a-new-service-to-bifrost)
- [Troubleshooting](#troubleshooting)
- [Source Collections & Workspaces](#source-collections--workspaces)

---

## Overview

Bifrost is Postman's WebSocket gateway and proxy layer between Postman clients (desktop app, web app) and internal services. It holds WebSocket connections and converts WebSocket requests to HTTP requests consumed by internal services.

**Architecture flow:**
```
Postman Client → Bifrost Gateway → Bifrost API → Target Service
```

Bifrost Gateway is the public-facing unit that maintains active WebSocket connections with all Postman clients. It supports both WebSocket and HTTP requests. Bifrost API is the logical unit that processes requests and routes them to internal services based on whitelisted proxy configuration.

**Key characteristics:**
- Bifrost has **no awareness of Postman's internals** — it simply proxies requests
- It adds the `x-socket-id` header for internal service use
- All incoming requests are **authenticated by default** (public routes can be exempted per-route)
- Services and their routes must be **explicitly allowlisted** via Bifrost's proxy configuration
- Supports both **body-based** (legacy) and **header-based** (modern) proxy forwarding

---

## Universal Bifrost Guidance: Org Mode vs Non-Org Mode

### ⚠️ CRITICAL: For ALL Bifrost Operations

**When hitting Bifrost and org mode IS enabled, you MUST:**

1. Include the `x-entity-team-id` header set to the **team ID** (the org-mode team's numeric ID)
2. This header tells Bifrost to resolve the request in the context of the specified organization/team
3. Without this header, org-mode teams will receive incorrect or incomplete data scoped to the wrong entity

```
x-entity-team-id: <team_id>
```

**When hitting Bifrost and org mode is NOT enabled, you MUST:**

1. **Omit** the `x-entity-team-id` header entirely
2. Bifrost will resolve the team context from the authenticated user's session/access token
3. Including `x-entity-team-id` on a non-org-mode team may cause unexpected behavior or errors

### How to Determine if Org Mode is Enabled

Org mode is enabled when a team belongs to an **organization**. The `app_bootstrap` response will include an `organizations` array. If the user's team has an associated organization, org mode is active.

---

## Bifrost Proxy Mechanics

All requests to internal services (except Sync) go through the **`POST /ws/proxy`** endpoint. There are two forwarding mechanisms:

### 1. Body-Based Proxy (Legacy/Standard)

The target service, method, path, and body are specified in the POST body:

```
POST {{bifrostBaseUrl}}/_api/ws/proxy
```

```json
{
    "service": "<service_name>",
    "method": "<HTTP_METHOD>",
    "path": "<api_path>",
    "query": { },
    "body": { }
}
```

**Fields:**
| Field | Required | Description |
|-------|----------|-------------|
| `service` | Yes | The allowlisted service name (e.g., `ums`, `acs`, `sentinel`) |
| `method` | Yes | HTTP method: `GET`, `POST`, `PUT`, `DELETE` |
| `path` | Yes | The API path on the target service |
| `query` | No | Query parameters as key-value object |
| `body` | No | Request body for POST/PUT requests |

### 2. Header-Based Proxy (Modern)

The target service is specified via the `x-pstmn-req-service` header, and the actual HTTP method/path is used directly:

```
GET {{bifrostBaseUrl}}/_api/<api_path>
x-pstmn-req-service: <service_name>
```

**Advantages of header-based proxy:**
- Uses standard HTTP methods directly (GET, POST, PUT, DELETE)
- Query parameters are standard URL query parameters
- Request body is the standard request body
- More RESTful and easier to debug

Both mechanisms support the same authentication and org-mode headers.

---

## Authentication

Bifrost supports three authentication mechanisms:

| Method | Use Case | Header/Field |
|--------|----------|-------------|
| **Access Token** | Desktop app, API calls | `x-access-token: <token>` |
| **Session Cookie** | Web app (browser) | `cookie: <session_cookie>` |
| **Basic Auth** | Internal service-to-service | Standard Basic Auth header |

### Getting Access Tokens

| Environment | URL |
|-------------|-----|
| Beta | `https://iapub.postman-beta.co/api/sessions/current` |
| Stage | `https://iapub.postman-stage.co/api/sessions/current` |
| Preview | `https://iapub.postman-preview.co/api/sessions/current` |
| Production | `https://iapub.postman.co/api/sessions/current` |

If any request is unauthenticated, you will receive an **HTTP 401 Unauthorized** response.

### Identity Resolution

Since UMS `/api/me` is **not allowlisted** in Bifrost, the correct way to resolve user identity from an access token is via the IAP (Identity-Aware Proxy) sessions endpoint:

```http
GET https://iapub.postman.co/api/sessions/current
x-access-token: {{access_token}}
```

**Environment-specific URLs:**

| Environment | URL |
|-------------|-----|
| Production | `https://iapub.postman.co/api/sessions/current` |
| Beta | `https://iapub.postman-beta.co/api/sessions/current` |
| Stage | `https://iapub.postman-stage.co/api/sessions/current` |
| Preview | `https://iapub.postman-preview.co/api/sessions/current` |

This returns the full user identity including team-scoped user ID, team ID, email, username, roles, and plan information.

**Example response (org-mode team):**
```json
{
    "identity": {
        "domain": "field-services-v12-demo",
        "team": 13347347,
        "user": 52358261
    },
    "data": {
        "user": {
            "username": "jboynton-pm",
            "email": "jared.boynton@postman.com",
            "name": "Jared Boynton",
            "role": "admin",
            "teamName": "Field Services v12 Demo"
        }
    }
}
```

> ⚠️ **Critical: User IDs are team-scoped.** The same Postman account has different user IDs in different team contexts. For example, account user `17929829` maps to `52358261` in one team and `53152579` in another. Always use the team-scoped user ID returned by `sessions/current` when calling other Bifrost services.

**Alternative: Public Postman API**

If you have a Postman API Key (not just an access token), you can also use:

```http
GET https://api.getpostman.com/me
X-Api-Key: {{postman_api_key}}
```

This returns user profile data including `teamId`, `teamName`, and `teamDomain`. This does NOT go through Bifrost.

---

## Services Available Through Bifrost

The following services are allowlisted and accessible through Bifrost's proxy. Each service must be explicitly configured in Bifrost's Dynamic Proxy Allowlisting system.

---

### UMS (User Management Service / god-service)

**Service name:** `ums`  
**Purpose:** User profiles, flags, team membership, organizations, app bootstrap data

> ⚠️ **IMPORTANT: Most UMS endpoints are NOT allowlisted in Bifrost.** While the UMS (god-service) blueprint documents many endpoints, only a subset are accessible through Bifrost's proxy. The commonly-referenced `/api/me` and `/api/users/:user_id/app_bootstrap` endpoints return `invalidPathError` when called through Bifrost. See the [Identity Resolution](#identity-resolution) section for the correct way to get user identity data.

#### Allowlisted Endpoints (Confirmed Working)

##### GET /api/v1/users/:user_id/flags
Returns user feature flags. This endpoint IS allowlisted in Bifrost (confirmed: passes routing to permission check).

**Body-based:**
```http
POST {{bifrostBaseUrl}}/_api/ws/proxy
Content-Type: application/json
x-access-token: {{access_token}}
x-entity-team-id: {{team_id}}

{
    "service": "ums",
    "method": "GET",
    "path": "/api/v1/users/{{user_id}}/flags"
}
```

**Header-based:**
```http
GET {{bifrostBaseUrl}}/_api/api/v1/users/{{user_id}}/flags
x-access-token: {{access_token}}
x-entity-team-id: {{team_id}}
x-pstmn-req-service: ums
```

> **Note:** The `user_id` here must be the **team-scoped user ID**, not the account-level user ID. See [Identity Resolution](#identity-resolution) for how to obtain the correct ID.

#### NOT Allowlisted (Return `invalidPathError`)

The following UMS endpoints are documented in the god-service blueprint but are **NOT accessible through Bifrost's proxy allowlist**:

| Endpoint | Error | Notes |
|----------|-------|-------|
| `GET /api/me` | `invalidPathError` | Use `iapub.postman.co/api/sessions/current` instead |
| `GET /api/users/me` | `NoPermission` | Bifrost resolves `me` literally, not as authenticated user |
| `GET /api/users/:user_id` | 504 Timeout | Path not properly allowlisted |
| `GET /api/users/:user_id/app_bootstrap` | `invalidPathError` | Not in proxy allowlist |
| `GET /api/v1/users/:user_id` | `invalidPathError` | Not in proxy allowlist |

> **Note:** The service name `identity` is NOT a valid Bifrost service. Using `"service": "identity"` will always return `invalidPathError`. The correct service name is `ums`, but most UMS paths are not allowlisted.

#### Org Mode Variants

For all UMS endpoints that ARE allowlisted, add `x-entity-team-id` when the team is in org mode:

```http
POST {{bifrostBaseUrl}}/_api/ws/proxy
Content-Type: application/json
x-access-token: {{access_token}}
x-entity-team-id: {{team_id}}

{
    "service": "ums",
    "method": "GET",
    "path": "/api/v1/users/{{user_id}}/flags"
}
```

---

### ACS (Access Control Service)

**Service name:** `acs`  
**Purpose:** Permission checks, access control for workspaces, collections, and other entities

#### Key Endpoints

##### POST /api/permissions/check
Checks whether a user has a specific permission on an object.

**Body-based:**
```http
POST {{bifrostBaseUrl}}/_api/ws/proxy
Content-Type: application/json
x-access-token: {{access_token}}
x-entity-team-id: {{team_id}}

{
    "service": "acs",
    "method": "post",
    "path": "/api/permissions/check",
    "body": {
        "checks": {
            "EDIT_COLLECTION": {
                "entityType": "user",
                "entityId": "{{user_id}}",
                "permission": "EDIT_COLLECTION",
                "objectType": "collection",
                "objectId": "{{collection_uid}}"
            }
        }
    }
}
```

**Header-based:**
```http
POST {{bifrostBaseUrl}}/_api/api/permissions/check
Content-Type: application/json
x-access-token: {{access_token}}
x-entity-team-id: {{team_id}}
x-pstmn-req-service: acs

{
    "checks": {
        "isWatchingEnabled": {
            "entityType": "user",
            "entityId": "{{user_id}}",
            "permission": "WATCH_WORKSPACE",
            "objectType": "workspace",
            "objectId": "{{workspace_id}}"
        }
    }
}
```

**Permission check body schema:**
| Field | Type | Description |
|-------|------|-------------|
| `checks` | Object | Map of check names to check definitions |
| `checks.<name>.entityType` | String | Type of entity requesting access (e.g., `user`) |
| `checks.<name>.entityId` | String | ID of the entity requesting access |
| `checks.<name>.permission` | String | Permission to check (e.g., `EDIT_COLLECTION`, `WATCH_WORKSPACE`) |
| `checks.<name>.objectType` | String | Type of object being accessed (e.g., `collection`, `workspace`) |
| `checks.<name>.objectId` | String | ID of the object being accessed |

---

### Sentinel

**Service name:** `sentinel`  
**Purpose:** Security scanning, secret detection, operation registration for sensitive actions

#### Key Endpoints

##### POST /register
Registers a sensitive operation for security review.

```http
POST {{bifrostBaseUrl}}/_api/ws/proxy
Content-Type: application/json
x-access-token: {{access_token}}

{
    "service": "sentinel",
    "method": "POST",
    "path": "/register",
    "body": {
        "operation": {
            "name": "publish-workspace",
            "id": "{{operation_id}}"
        },
        "resources": [
            {
                "type": "globals",
                "id": "{{resource_id}}"
            }
        ],
        "sendEmail": true
    }
}
```

---

### Skill

**Service name:** `skill`  
**Purpose:** Interaction events, experiments, growth features, user skill tracking

#### Key Endpoints

##### GET /v1/interactionevent
Retrieves interaction events for experiments and growth features.

**Body-based:**
```http
POST {{bifrostBaseUrl}}/_api/ws/proxy
Content-Type: application/json
x-access-token: {{access_token}}
x-entity-team-id: {{team_id}}

{
    "service": "skill",
    "method": "get",
    "path": "/v1/interactionevent?entityType=user&resourceId=grw-2063&resourceType=experiment"
}
```

**Header-based:**
```http
GET {{bifrostBaseUrl}}/_api/v1/interactionevent?entityType=user&resourceId=grw-2063&resourceType=experiment
x-access-token: {{access_token}}
x-entity-team-id: {{team_id}}
x-pstmn-req-service: skill
```

---

### Annotation

**Service name:** `annotation`  
**Purpose:** Comments on collections, requests, and other Postman entities

#### Key Endpoints

##### GET /comments
Retrieves comments for an entity.

```http
POST {{bifrostBaseUrl}}/_api/ws/proxy
Content-Type: application/json
x-access-token: {{access_token}}
x-entity-team-id: {{team_id}}

{
    "service": "annotation",
    "method": "GET",
    "path": "/comments"
}
```

##### GET /comments/count
Retrieves comment counts.

**Header-based:**
```http
GET {{bifrostBaseUrl}}/_api/comments/count
x-access-token: {{access_token}}
x-entity-team-id: {{team_id}}
x-pstmn-req-service: annotation
```

##### DELETE /comments/:comment_id
Deletes a specific comment.

**Body-based:**
```http
POST {{bifrostBaseUrl}}/_api/ws/proxy
Content-Type: application/json
x-access-token: {{access_token}}
x-entity-team-id: {{team_id}}

{
    "service": "annotation",
    "method": "DELETE",
    "path": "/comments/{{comment_id}}"
}
```

**Header-based:**
```http
DELETE {{bifrostBaseUrl}}/_api/comments/{{comment_id}}
x-access-token: {{access_token}}
x-entity-team-id: {{team_id}}
x-pstmn-req-service: annotation
```

---

### API Catalog

**Service name:** `api-catalog`  
**Purpose:** API Catalog analytics, workspace entity discovery, service/API listing for the Postman API Catalog feature

#### Key Endpoints

##### GET /api/v2/analytics/workspaces
Returns workspace-level analytics for the API Catalog, including usage metrics filtered by tag, time range, and execution environment.

**Body-based:**
```http
POST {{bifrostBaseUrl}}/_api/ws/proxy
Content-Type: application/json
x-access-token: {{access_token}}
x-entity-team-id: {{team_id}}

{
    "service": "api-catalog",
    "method": "GET",
    "path": "/api/v2/analytics/workspaces",
    "query": {
        "range": "1week",
        "execution_environment": [],
        "tag": "develop-ws"
    },
    "body": {}
}
```

**Query parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `range` | String | Time range for analytics: `1week`, `1month`, etc. |
| `execution_environment` | Array | Filter by execution environment(s) |
| `tag` | String | Filter by workspace tag |

> **Note:** The `api-catalog` service requires `x-entity-team-id` for org-mode teams. Authentication is via session cookie or `x-access-token`.

---

### Ruleset

**Service name:** `ruleset`  
**Purpose:** Security scan configuration, API governance rules, scan filters

#### Key Endpoints

##### GET /security/configure/scan-filter
Retrieves scan filter configuration for an entity.

**Body-based:**
```http
POST {{bifrostBaseUrl}}/_api/ws/proxy
Content-Type: application/json
x-access-token: {{access_token}}
x-entity-team-id: {{team_id}}

{
    "service": "ruleset",
    "method": "get",
    "path": "/security/configure/scan-filter",
    "query": {
        "entityType": "Request",
        "entityId": "{{entity_uid}}",
        "containerId": "{{collection_uid}}",
        "containerType": "collection"
    }
}
```

**Header-based:**
```http
GET {{bifrostBaseUrl}}/_api/security/configure/scan-filter?entityType=Request&entityId={{entity_uid}}&containerId={{collection_uid}}&containerType=collection
x-access-token: {{access_token}}
x-entity-team-id: {{team_id}}
x-pstmn-req-service: ruleset
```

---

### Billing

**Service name:** `billing`  
**Purpose:** Billing bootstrap, subscription management, plan information

#### Key Endpoints

##### GET /api/billing/bootstrap
Returns billing configuration and plan information for the current user/team.

```http
POST {{bifrostBaseUrl}}/_api/ws/proxy
Content-Type: application/json
x-access-token: {{access_token}}

{
    "service": "billing",
    "method": "GET",
    "path": "/api/billing/bootstrap"
}
```

---

### Insights (Akita)

**Service name:** `akita`  
**Purpose:** API observability and insights — error tracking, performance metrics, endpoint timelines, and aggregate analytics for monitored services

> **Note:** The Insights service is accessed via the `akita` service name in Bifrost. Endpoints are prefixed with `/v2/services/:service_id/insights/`.

#### Key Endpoints

##### GET /v2/services/:service_id/insights/overview
Returns an overview of insights for a specific service, including endpoint-level error counts, last seen timestamps, and time series data.

```http
POST {{bifrostBaseUrl}}/_api/ws/proxy
Content-Type: application/json
x-access-token: {{access_token}}

{
    "service": "akita",
    "method": "GET",
    "path": "/v2/services/{{service_id}}/insights/overview"
}
```

**Response schema:**
```json
{
    "endpoints": [
        {
            "error_code": 0,
            "error_count": 0,
            "host": "",
            "last_seen": "",
            "method": "",
            "path_template": "",
            "time_series": [
                {
                    "timestamp": "",
                    "value": 0
                }
            ]
        }
    ]
}
```

##### GET /v2/services/:serviceID/insights/aggregate/timeline
Computes an aggregate error timeline over the last 7 days for a given Insights service.

```http
POST {{bifrostBaseUrl}}/_api/ws/proxy
Content-Type: application/json
x-access-token: {{access_token}}

{
    "service": "akita",
    "method": "GET",
    "path": "/v2/services/{{service_id}}/insights/aggregate/timeline"
}
```

##### GET /v2/services/:serviceID/insights/endpoints/timeline
Provides a performance timeline for a specific service endpoint. Supports configurable time ranges with varying granularity.

```http
POST {{bifrostBaseUrl}}/_api/ws/proxy
Content-Type: application/json
x-access-token: {{access_token}}

{
    "service": "akita",
    "method": "GET",
    "path": "/v2/services/{{service_id}}/insights/endpoints/timeline",
    "query": {
        "method": "POST",
        "host": "api.example.com",
        "path": "/v2/endpoint/path",
        "time_range": "7d"
    }
}
```

**Query parameters:**
| Parameter | Required | Description |
|-----------|----------|-------------|
| `method` | Yes | HTTP method of the endpoint being queried |
| `host` | Yes | Host of the endpoint being queried |
| `path` | Yes | Path of the endpoint being queried |
| `time_range` | No | `1h` (1-min granularity), `12h` (15-min), `1d` (30-min), `7d` (1-hour). Defaults to last 7 days |

##### GET /v2/services/:serviceID/insights/performance-summary
Returns aggregated time series statistics comparing the previous week vs. the last 7 days, including error rates, latency percentiles, and request counts.

```http
POST {{bifrostBaseUrl}}/_api/ws/proxy
Content-Type: application/json
x-access-token: {{access_token}}

{
    "service": "akita",
    "method": "GET",
    "path": "/v2/services/{{service_id}}/insights/performance-summary"
}
```

**Response schema:**
```json
{
    "performance_stats": [
        {
            "start_time": "2024-03-20T15:00:00Z",
            "end_time": "2024-03-27T15:00:00Z",
            "value": {
                "count": 1000,
                "num_errors": 100,
                "latency_90p": 1000,
                "fraction_errors": 0.1
            }
        },
        {
            "start_time": "2024-03-27T15:00:00Z",
            "end_time": "2024-04-03T15:00:00Z",
            "value": {
                "count": 1000,
                "num_errors": 120,
                "latency_90p": 950,
                "fraction_errors": 0.12
            }
        }
    ],
    "percent_change": {
        "count": 0.0,
        "num_errors": 20.0,
        "latency_90p": -5.0,
        "fraction_errors": 20.0
    }
}
```

> **Note:** `percent_change` fields will be `null` if the previous week has no data (new service or no data computed yet).

---

### Monitors V2

**Service name:** `monitorsV2`  
**Purpose:** Monitor CRUD operations, scheduled collections, uptime monitors

#### Key Endpoints

##### POST /monitors
Creates a new monitor.

```http
POST {{bifrostBaseUrl}}/_api/ws/proxy
Content-Type: application/json
x-access-token: {{access_token}}

{
    "service": "monitorsV2",
    "method": "POST",
    "path": "/monitors",
    "query": {
        "workspace": "{{workspace_id}}"
    },
    "body": {
        "name": "My Monitor",
        "type": "collection-based",
        "collection": {
            "id": "{{collection_id}}"
        },
        "environment": {
            "id": "{{environment_id}}"
        },
        "runOptions": {
            "strictSSL": false,
            "followRedirects": false,
            "requestTimeout": 5000,
            "requestDelay": 0,
            "retry": {
                "attempts": 2
            }
        },
        "schedule": {
            "cronPattern": "0 8 * * *",
            "timeZone": "America/Chicago"
        },
        "location": [
            {
                "region": "us-east"
            }
        ],
        "notifications": {
            "onFailure": [
                {
                    "type": "email",
                    "userId": {{user_id}}
                }
            ],
            "onError": [
                {
                    "type": "email",
                    "userId": {{user_id}}
                }
            ],
            "limit": 5
        }
    }
}
```

##### GET /monitors/:monitor_id
Retrieves a specific monitor.

##### DELETE /monitors/:monitor_id
Deletes a specific monitor.

##### GET /monitors (with cursor)
Lists all monitors with pagination.

##### POST /scheduled-collections
Creates a new scheduled collection run (distinct from a monitor — no schedule, runs on-demand or via trigger).

```http
POST {{bifrostBaseUrl}}/_api/ws/proxy
Content-Type: application/json
x-access-token: {{access_token}}

{
    "service": "monitorsV2",
    "method": "POST",
    "path": "/scheduled-collections",
    "body": {
        "name": "My Scheduled Collection",
        "collection": {
            "id": "{{collection_id}}"
        },
        "environment": {
            "id": "{{environment_id}}"
        },
        "runOptions": {
            "strictSSL": false,
            "followRedirects": false,
            "requestTimeout": 5000,
            "requestDelay": 0,
            "retry": {
                "attempts": 2
            }
        },
        "schedule": {
            "cronPattern": "0 8 * * *",
            "timeZone": "America/Chicago"
        },
        "notifications": {
            "onFailure": [
                {
                    "type": "email",
                    "userId": {{user_id}}
                }
            ],
            "onError": [
                {
                    "type": "email",
                    "userId": {{user_id}}
                }
            ],
            "limit": 5
        }
    }
}
```

##### GET /scheduled-collections
Lists all scheduled collections.

##### GET /scheduled-collections/:id
Retrieves a specific scheduled collection.

##### DELETE /scheduled-collections/:id
Deletes a specific scheduled collection.

##### GET /scheduled-collections/:id/activity
Retrieves activity/run history for a specific scheduled collection.

---

### Sync

**Service name:** N/A (direct routing, not via `/ws/proxy`)  
**Purpose:** Collection, environment, and workspace synchronization

Sync requests are handled differently from other services. All requests **except** `POST /ws/proxy` are proxied directly to Sync. After the release of Public Workspaces, **all requests to Sync are by default not authenticated** at Bifrost.

```http
GET {{bifrostBaseUrl}}/api/collection?team={{team_id}}&user_id={{user_id}}
x-access-token: {{access_token}}
```

---

### Echo (Testing)

**Service name:** `echo`  
**Purpose:** Testing Bifrost proxy connectivity and configuration

Used primarily for testing proxy allowlisting and connectivity. The echo service mirrors back request data for debugging purposes.

---

## Header-Based vs Body-Based Proxy Forwarding

| Aspect | Body-Based (`POST /ws/proxy`) | Header-Based (Direct URL) |
|--------|-------------------------------|---------------------------|
| **Method** | Always `POST` to `/ws/proxy` | Uses actual HTTP method (GET, POST, PUT, DELETE) |
| **Service routing** | `"service"` field in JSON body | `x-pstmn-req-service` header |
| **Path** | `"path"` field in JSON body | Actual URL path after `/_api/` |
| **Query params** | `"query"` object in JSON body | Standard URL query parameters |
| **Request body** | `"body"` object in JSON body | Standard request body |
| **Org mode** | `x-entity-team-id` header | `x-entity-team-id` header |
| **Auth** | `x-access-token` header or `cookie` | `x-access-token` header or `cookie` |

### Key Headers Reference

| Header | Required | Purpose |
|--------|----------|---------|
| `x-access-token` | Yes (or cookie) | Authentication token from sign-in |
| `x-entity-team-id` | **Only for org-mode teams** | Specifies the team context for org-mode |
| `x-app-version` | Optional | Client app version string |
| `x-pstmn-req-service` | Only for header-based proxy | Target service name |
| `x-socket-id` | Internal use | Added by Bifrost Gateway for internal service use |
| `Content-Type` | Yes for POST | Should be `application/json` |
| `cookie` | Alternative to x-access-token | Session cookie for web app auth |

---

## Environment-Specific URLs

### Bifrost Gateway URLs (Direct)

| Environment | URL |
|-------------|-----|
| **Production (US)** | `https://bifrost-premium-https-v4.gw.postman.com/ws/proxy` |
| **Beta (US)** | `https://bifrost-https-v4.gw.postman-beta.com/ws/proxy` |
| **Alpha (EU)** | `https://bifrost.gw.eu.postman-alpha.co/ws/proxy` |

### Via Web App Proxy

| Environment | URL |
|-------------|-----|
| **Production** | `https://go.postman.co/_api/ws/proxy` |
| **Beta** | `https://postman.postman-beta.co/_api/ws/proxy` |
| **Alpha (EU)** | `https://web.eu.postman-alpha.co/_api/ws/proxy` |

### UMS (God Service) Direct URLs

| Environment | URL |
|-------------|-----|
| **Production** | `{{url}}/api/users/:user_id/app_bootstrap` |
| **Beta** | `{{url}}/api/users/:user_id/app_bootstrap` |

> **Note:** Direct UMS calls use `x-access-token` header or basic auth (`god_username`/`god_password`) depending on whether the call is client-facing or service-to-service.

---

## Artemis: Not a Separate Proxy

**Artemis is NOT a proxy gateway like Bifrost.** It is the **web and desktop UI distribution service** that manages:

- **Versions:** Semver-style identifiers for each release of the web or desktop UI
- **Artifacts:** HTML content served to the client for rendering the web or desktop UI
- **Releases:** Pointers to specific versions representing web tracks served to clients
- **Version Compatibility:** Ensures correct desktop UI version is served based on platform

### Why Artemis Appears in Proxy Contexts

When accessing Postman via the web app (e.g., `go.postman.co`), Artemis serves the web app HTML. The web app then makes API calls through the same domain, which Artemis forwards to Bifrost. This is why you see `/_api/ws/proxy` endpoints on Artemis ALB URLs — Artemis is forwarding these requests to Bifrost, not acting as its own proxy layer.

```
Browser → Artemis (serves HTML) → /_api/* requests → Bifrost → Target Service
```

### Artemis Service Endpoints (Direct, Not Through Bifrost)

Artemis has its own admin and distribution endpoints that are accessed **directly**, not through Bifrost:

| Category | Purpose | Auth |
|----------|---------|------|
| **Admin: Version** | CRUD operations on web/desktop UI versions | Basic Auth |
| **Admin: Artifact** | CRUD operations on version artifacts (HTML content) | Basic Auth |
| **Admin: Release** | CRUD operations on web releases/tracks | Basic Auth |
| **Admin: Feature Flag** | Manage internal service-level feature flags | Basic Auth |
| **Admin: Version Compatibility** | Manage desktop platform ↔ UI version mappings | Basic Auth |
| **Distribution** | Public endpoints serving UI to clients | None (WAF protected) |
| **Healthchecks** | Service health monitoring | None |

**Authentication:** Admin endpoints use Basic Auth with `username`/`password` from the environment. For preview/stage admin credentials, contact `@client-distribution` in `#engineering-foundation` Slack.

**Performance:**
| Domain | Avg | p95 | p99 |
|--------|-----|-----|-----|
| Web private distribution & admin | ~25ms | ~120ms | ~190ms |
| Web public distribution | ~50ms | ~162ms | ~208ms |
| Desktop UI distribution | ~75ms | ~126ms | ~185ms |
| Desktop UI enterprise distribution | ~10ms | ~15ms | ~16ms |

---

## Adding a New Service to Bifrost

To expose a new service through Bifrost's proxy:

1. **Use the Dynamic Proxy Allowlisting API** to add your service configuration
2. Select the appropriate environment (`beta` / `preview` / `stage` / `prod` / `alpha`)
3. Use the `POST` endpoint to create a new service config, or `PUT` to update an existing one
4. For **preview, stage, or production** changes:
   - Navigate to `#bifrost-ops` on Slack after the request succeeds
   - Check the notification to confirm the correct change was applied
   - **Initiate security review** by tagging security in the notification
5. **Basic auth cannot be added/edited via the API** — create an SFSUP ticket for auth changes
6. After updating configuration, you do **not** need to update Bifrost's code

### Allowlisting API

```
# Fetch current config for a service
GET {{EndpointRegistrationAPIURL}}/v1/configuration?env=prod&api=<service_name>

# Update config for a service (body should contain FULL final config)
PUT {{EndpointRegistrationAPIURL}}/v1/configuration?env=prod&api=<service_name>

# Create new service config
POST {{EndpointRegistrationAPIURL}}/v1/configuration?env=beta&api=<service_name>
```

> **Important:** The Update endpoint sets the config to exactly what is sent in the body. Always fetch the current config first, edit it, then send the full updated config.

---

## Troubleshooting

### Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| 401 Unauthorized | Missing or expired access token | Refresh `x-access-token` or session cookie |
| Incorrect team data returned | Missing `x-entity-team-id` on org-mode team | Add `x-entity-team-id: <team_id>` header |
| Empty or partial response | Wrong service name in proxy body | Verify service name matches allowlisted name |
| 403 Forbidden | User doesn't have access to the specified team | Verify team membership and `x-entity-team-id` value |
| Service not found | Service not allowlisted in Bifrost proxy config | Check Bifrost Dynamic Proxy Allowlisting |
| Timeout | Service is down or slow | Check service health; Bifrost has configurable timeouts |

### Verifying Org Mode Status

To check if a team is in org mode, look at the `app_bootstrap` response:
- If `organizations` array is present and non-empty → **org mode is enabled**
- If `organizations` is absent or empty → **org mode is NOT enabled**

### Debugging Tips

1. **Use Echo service** to test proxy connectivity: set `"service": "echo"` to verify Bifrost is routing correctly
2. **Check allowlisting** by fetching the current config for your service via the Dynamic Proxy Allowlisting API
3. **Compare body-based vs header-based** — if one works and the other doesn't, check the `x-pstmn-req-service` header value matches the allowlisted service name
4. **Inspect `x-socket-id`** — Bifrost Gateway adds this header; internal services should use it for socket-related operations

---

## Source Collections & Workspaces

### Key Collections

| Collection | Description |
|------------|-------------|
| **Bifrost API #blueprint** | Canonical Bifrost API documentation (v0.6.9) |
| **Bifrost Header Based Forwarding** | Examples of both body-based and header-based proxy patterns |
| **Dynamic Proxy Allowlisting** | Interface to manage Bifrost proxy configuration |
| **UMS (PHP) #blueprint** | UMS/god-service endpoint definitions |
| **SanityCheckV12API through Bifrost** | Integration test patterns showing bifrost proxy usage |
| **IAM Catalogue APIs** | Comprehensive IAM endpoint catalog |
| **Artemis Service #blueprint** | Artemis web/desktop distribution service |
| **Postman Governance Server - Underlying APIs** | API Catalog proxy request examples and governance API patterns |

### Key Workspaces

| Workspace | ID | Content |
|-----------|-----|---------|
| Bifrost #service | `06105aa1-84b6-4c94-bee3-58a2d29ff48b` | Bifrost API blueprint, echo tests |
| Bifrost Header Based Proxy | `91f9df8e-ad70-412b-b0c3-b9c516f484d9` | Header-based forwarding examples |
| Bifrost - Dynamic Proxy Allowlisting | `7e36af25-03e4-4597-9011-e63d4a9a58fb` | Proxy configuration management |
| god-service | `9e4dce16-24a9-4541-a3e1-3dd04d30ce66` | UMS blueprint, app_bootstrap |
| Godserver #service | `c54cf1ff-3614-491b-a69a-8d542ecb3a56` | God service contracts, org-mode tests |
| IAM Catalogue APIs | `4935b346-812a-494a-801c-671dc60047d4` | Full IAM API catalog |
| Monitoring Squad | `27c84311-142a-4f5b-9a17-a8c9c8dd85aa` | Sanity check tests through bifrost |
| Artemis Service | `41be5f8d-fea1-449c-8337-ef3ccf28b4a0` | Artemis service blueprint |
| Artemis #service | `a39f2a0d-e86f-4d79-8b38-251290e63081` | Artemis service (alternate) |
| Billing #Service | `f332225e-347c-443e-a296-2e817dbd6f4e` | Billing service endpoints |
| Cloud Platform APIs | `66217348-04cd-4d59-be86-4ff6f164482c` | Bifrost blueprint (cloud platform) |
| Postman Internal Services | `70986393-06b3-40cc-908f-1d5575b8aa04` | Aggregated internal service blueprints |
| Insights APIs | `eb967314-3b6f-4861-bb5f-e3b4df02f073` | Akita/Insights service endpoints and Bifrost allowlist config |
| Postman Governance Server | `d658110e-4a67-4ef1-8b3d-f1641b8f9974` | API Catalog proxy examples |
