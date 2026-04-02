# Workspace Governance Rules -- Validated API Contract
> **Document role:** Reference
> **Canonical parent:** vzw/internal-catalog/docs/README.md



All operations go through the Bifrost proxy at `https://bifrost-premium-https-v4.gw.postman.com/ws/proxy`.

Every request is a POST to that URL with a JSON body containing `service`, `method`, `path`, and optionally `body` and `query`.

## Required Headers

The Bifrost proxy requires browser-style headers. Minimal required set validated against the enterprise trial:

```
accept: */*
accept-language: en-US
content-type: application/json
priority: u=1, i
referer: https://desktop.postman.com/?desktopVersion=12.0.6&userId=$USER_ID&teamId=$TEAM_ID&region=us
sec-ch-ua: "Not A(Brand";v="8", "Chromium";v="132"
sec-ch-ua-mobile: ?0
sec-ch-ua-platform: "macOS"
sec-fetch-dest: empty
sec-fetch-mode: cors
sec-fetch-site: same-site
user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Postman/12.0.6 Electron/34.5.8 Safari/537.36
x-access-token: $ACCESS_TOKEN
x-app-version: 12.0.7
x-entity-team-id: $TEAM_ID
```

Without the browser-style headers (sec-ch-ua, sec-fetch-*, referer, user-agent), the proxy returns `400 Invalid auth config`.

The `x-entity-team-id` header is not strictly required for Bifrost calls, but including it scopes the operation to the correct team.

## Auth Notes

- `x-access-token` is a session token obtained via `postman login` (PKCE browser flow), NOT a PMAK API key.
- The token stored in `~/.postman/postmanrc` at `login._profiles[].accessToken` is the correct value.
- `gateway.postman.com/configure/workspace-groups` (the direct gateway) returns `404` for both GET and PATCH from the trial org. All governance operations must go through the Bifrost proxy.

## Validated Operations

Validated live against enterprise trial org (team 13347347) on 2026-03-09.

### Create Group

```
POST https://bifrost-premium-https-v4.gw.postman.com/ws/proxy
```

```json
{
  "service": "ruleset",
  "method": "post",
  "path": "/configure/workspace-groups",
  "body": {
    "name": "GroupName"
  }
}
```

Response (200):

```json
{
  "createdAt": "2026-03-09T01:06:30.000Z",
  "updatedAt": "2026-03-09T01:06:30.000Z",
  "id": "5a063b84-77a2-4e2e-b7f8-1131b25ed2bd",
  "name": "TestGroup-LiveValidate",
  "summary": "",
  "teamId": 13347347,
  "meta": { "userId": 53017284 },
  "workspaces": [],
  "vulnerabilities": []
}
```

### Rename Group

```json
{
  "service": "ruleset",
  "method": "patch",
  "path": "/configure/workspace-groups/$GROUP_ID",
  "body": {
    "name": "NewName"
  }
}
```

### Delete Group

```json
{
  "service": "ruleset",
  "method": "delete",
  "path": "/configure/workspace-groups/$GROUP_ID"
}
```

Response (200):

```json
{ "status": "Success" }
```

### Add Workspace to Group

```json
{
  "service": "ruleset",
  "method": "patch",
  "path": "/configure/workspace-groups/$GROUP_ID",
  "body": {
    "workspaces": { "add": ["$WORKSPACE_ID"], "remove": [] },
    "vulnerabilities": { "add": [], "remove": [] }
  }
}
```

Response (200): full group object with `workspaces` array updated.

### Remove Workspace from Group

```json
{
  "service": "ruleset",
  "method": "patch",
  "path": "/configure/workspace-groups/$GROUP_ID",
  "body": {
    "workspaces": { "add": [], "remove": ["$WORKSPACE_ID"] },
    "vulnerabilities": { "add": [], "remove": [] }
  }
}
```

Response (200): full group object with workspace removed from `workspaces` array.

### Create Rule

```json
{
  "method": "post",
  "service": "ruleset",
  "path": "/security/configure/vulnerabilities",
  "query": { "tag": "governance" },
  "body": {
    "body": "rules:\n    rule-name:\n        description: Rule description.\n        message: Lint message.\n        given: $.paths.*.*.parameters[?(@.in=='query')].name\n        severity: warn\n        formats:\n            - oas3\n        then:\n            function: truthy",
    "tags": ["governance"],
    "engine": "SPECTRAL 6.0",
    "language": "yaml"
  }
}
```

Response (200): `{ "vulnerabilities": [{ "id": 5077, "name": "rule-name", "rules": [...], ... }] }`

The returned `id` (vulnerability ID) is the numeric identifier used for attach/detach operations.

### Delete Rule

```json
{
  "service": "ruleset",
  "method": "delete",
  "path": "/security/configure/teams/checks/vulnerabilities/$VULNERABILITY_ID",
  "query": { "tag": "governance" }
}
```

Response (200):

```json
{ "status": "Success" }
```

### Attach Rule to Group

```json
{
  "service": "ruleset",
  "method": "patch",
  "path": "/configure/workspace-groups/$GROUP_ID",
  "body": {
    "workspaces": { "add": [], "remove": [] },
    "vulnerabilities": { "add": [$VULNERABILITY_ID], "remove": [] }
  }
}
```

Response (200): full group object with `vulnerabilities` array updated. Only works if the rule is not already attached.

### Detach Rule from Group

```json
{
  "service": "ruleset",
  "method": "patch",
  "path": "/configure/workspace-groups/$GROUP_ID",
  "body": {
    "workspaces": { "add": [], "remove": [] },
    "vulnerabilities": { "add": [], "remove": [$VULNERABILITY_ID] }
  }
}
```

Response (200): full group object with rule removed from `vulnerabilities` array.

## Operations That Do NOT Work

| Operation | Method | Path | Result |
|-----------|--------|------|--------|
| List all groups | GET | `/configure/workspace-groups` | 403 Access denied |
| Get single group | GET | `/configure/workspace-groups/$GROUP_ID` | 403 Access denied |
| List rules | GET | `/security/configure/vulnerabilities` | 400 invalid path |

Group discovery by name is not available through the Bifrost proxy. The PATCH response for any mutation returns the full group object, so group state can be read as a side effect of any no-op PATCH.

### Workaround: Read Group State via No-Op PATCH

```json
{
  "service": "ruleset",
  "method": "patch",
  "path": "/configure/workspace-groups/$GROUP_ID",
  "body": {
    "workspaces": { "add": [], "remove": [] },
    "vulnerabilities": { "add": [], "remove": [] }
  }
}
```

Returns the full group object (name, workspaces, vulnerabilities, partners) without making any changes. This is the only validated way to read group state.

## Direct Gateway (gateway.postman.com) -- NOT WORKING

The existing code in `.github/actions/_lib/postman-api.ts` uses `https://gateway.postman.com/configure/workspace-groups` for both listing groups and patching workspace assignments. This endpoint returns `404 Not Found` from the trial org for both GET and PATCH operations. All governance operations must go through the Bifrost proxy.

## Spectral Rule Format

Rules are authored as YAML strings in the Spectral 6.0 format. The `body.body` field contains the rule YAML with the rule name as the top-level key under `rules:`. Example:

```yaml
rules:
    operation-summary-required:
        description: All operations need summaries.
        message: All of your operations need summaries.
        given: $.paths.*[get,put,post,delete,patch]
        severity: error
        formats:
            - oas3
        then:
            field: summary
            function: truthy
```

Supported severity values: `error`, `warn`, `info`, `hint`.

Supported Spectral functions: `truthy`, `falsy`, `casing`, `pattern`, `length`, `schema`, `defined`, `undefined`, `enumeration`, `alphabetical`.

## Governance Rule Definitions

The following rules are configured for the demo org. Each rule maps to one of the 8 governance checks surfaced during provisioning lint.

### ERROR-level (block provisioning)

| Rule | Spectral given | Function |
|------|---------------|----------|
| The info object should have a description | `$.info` | `truthy` on field `description` |
| There should be no trailing slashes on paths | `$.paths.*~` | `pattern` (must not end with `/`) |
| All operations need summaries | `$.paths.*[get,put,post,delete,patch]` | `truthy` on field `summary` |

### WARN-level (flag but allow provisioning)

| Rule | Spectral given | Function |
|------|---------------|----------|
| A 204 No Content response can't have a body | `$.paths.*.*.responses.204` | `falsy` on field `content` |
| A schema property should have a $ref property | `$.paths.*.*.responses.*.content.*.schema` | `truthy` on field `$ref` |
| Operation should return a 2xx HTTP status code | `$.paths.*.*.responses` | `pattern` on keys matching `2[0-9]{2}` |
| Operation should return a 5xx HTTP status code | `$.paths.*.*.responses` | `pattern` on keys matching `5[0-9]{2}` |
| Operation summaries should not end with a period | `$.paths.*[get,put,post,delete,patch].summary` | `pattern` (must not end with `.`) |

## Tuning Strategy

There are two levers for controlling lint outcomes without editing spec files:

1. **Rule severity**: Change a rule from `error` to `warn` (or vice versa) to adjust whether it blocks provisioning or just flags.
2. **Group scope**: Attach different rule sets to different governance groups so domains can enforce different strictness levels.

Spec edits should only be used when the goal is genuine spec quality improvement, not demo tuning. When editing specs, work from a measured baseline (run `scripts/lint-all-specs.sh` first) and target specific cohorts rather than applying arbitrary percentages.

## Setup Sequence

To set up governance on a new org:

1. Create governance groups (one per domain) using the create-group contract above.
2. Record the returned group UUIDs.
3. Create governance rules using the create-rule contract above.
4. Attach rules to groups using the attach-rule contract.
5. Update the governance mapping in `src/lib/provision-workflow.ts` (or `config.domains[].governance_group`) with the group UUIDs.
6. Provisioning will automatically assign new workspaces to the correct group based on domain.
