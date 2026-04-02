# Plan: Enable Sub-Team Selection for Org-Mode Teams -- COMPLETE
> **Document role:** Plan (completed)
> **Canonical parent:** vzw/internal-catalog/docs/README.md

All phases implemented. This plan is retained for historical reference.

## Root Cause Analysis

**Is missing squad selection why provisioning fails?** **YES -- this is the root cause.**

### Evidence

1. The **Postman Public API** rejects workspace creation with the org-level team ID:
   ```
   POST /workspaces with teamId=13347347 -> 403 forbiddenError
   "You are not authorized to perform this action"
   ```

2. Workspace creation **succeeds** with a sub-team ID:
   ```
   POST /workspaces with teamId=132109 -> 200 OK (workspace created)
   ```

3. The team registry entry for "Field Services v12 Demo" has `org_mode: false`, so the existing workspace-team dropdown (already built in the UI!) never appears.

4. Without a sub-team selection, the provisioning flow sends `workspace_team_id=""` and the workflow falls back to the org-level `postman_team_id=13347347`, which the API rejects.

### What already exists (no code changes needed)

The entire sub-team selection pipeline is **already built**:
- **Frontend**: `ProvisionLaunchPanel.tsx` lines 246-264 -- "Workspace Team" dropdown, only rendered when `orgTeams.length > 0`
- **Frontend**: `ProvisionPage.tsx` lines 580-600 -- loads org teams via `/api/teams` when `activeTeam.org_mode === true`
- **Frontend**: `RegisterTeamModal.tsx` -- has "Org Mode" checkbox
- **Frontend**: `SettingsPage.tsx` -- has "Org Mode" column and edit toggle
- **Backend**: `team-registry.ts` -- stores and returns `org_mode` per team
- **Backend**: `/api/teams` endpoint -- fetches sub-teams from Postman API
- **Provision flow**: `provision-launch.ts` -- sends `workspace_team_id` + `workspace_team_name`
- **Workflow templates**: pass `workspace_team_id` + `workspace_team_name` through to bootstrap action

## Solution

**Implement smart auto-detection of Org Mode at both runtime and registration time, and fix the GitHub action fallback logic to respect explicit empty values.**

## Phase 1: Fix GitHub Action Fallback Logic (Critical) -- DONE

The bootstrap action now checks `/api/teams` before falling back to `postman_team_id`. If `teams.length > 1`, it throws a clear error requiring explicit `workspace_team_id` instead of silently using the org-level ID.

- [x] Task 1.1: Update `.github/actions/postman-bootstrap/src/index.ts` -- org-mode detection at lines 61-88, throws clear error for org accounts missing `workspace_team_id`.
- [x] Task 1.2: Rebuilt action dist bundle.

## Phase 2: Backend Fallback Support (Backend) -- DONE

- [x] Task 2.1: `resolveTeamCredentials` returns `org_mode: boolean` in `src/lib/team-registry.ts`.
- [x] Task 2.2: Default team ID `13347347` defaults `org_mode` to `true`.
- [x] Task 2.3: `/api/teams/registry` fallback passes `org_mode` correctly to frontend.

## Phase 3: Implement Smarter Auto-Detection & Validation (Frontend) -- DONE

- [x] Task 3.1: `RegisterTeamModal.tsx` probes `/api/teams` on API key change (lines 22-43), auto-sets `orgMode=true` with "auto-detected" badge.
- [x] Task 3.2: `ProvisionPage.tsx` eagerly fetches `/api/teams` for ALL credentials (lines 589-613), no `org_mode` gate. Auto-detects via `orgTeamsList.length > 1`.
- [x] Task 3.3: UI auto-reveals Workspace sub-team dropdown when `/api/teams` returns 2+ squads.
- [x] Task 3.4: Provisioning blocked when org-mode detected but no `workspace_team_id` selected (via `orgModeRequiresSelection` gate).
- [x] Task 3.5: `ProvisionLaunchPanel.tsx` line 240 shows "Cannot list sub-teams" warning when `/api/teams` is unavailable.

## Phase 4: UX Terminology Updates (Mandatory) -- DONE

- [x] Task 4.1: Primary dropdown label is "Postman credential" (`ProvisionLaunchPanel.tsx` line 212).
- [x] Task 4.2: Secondary dropdown label is "Workspace sub-team" (`ProvisionLaunchPanel.tsx` line 249).
- [x] Task 4.3: Helper text: "Select the specific squad that will own this workspace." (`ProvisionLaunchPanel.tsx` line 250).

## Phase 5: Verification and Testing

| Test Case | Expected Result | Status |
| :--- | :--- | :--- |
| Non-org API key (regular team) | No sub-team dropdown appears, provisioning succeeds. | [x] |
| Org API key with 8 sub-teams | Dropdown appears with 8 options, first selected by default. | [x] |
| Org API key, user selects sub-team X | Workspace created successfully in sub-team X. | [x] |
| Org API key, `/api/teams` returns 403 | Error message: "Cannot list sub-teams" is displayed, provisioning blocked. | [x] |
| Fallback team (no KV registry) | Auto-detects org mode, shows dropdown successfully. | [x] |
| Bootstrap action receives empty `workspace_team_id` for org | Action fails gracefully, does not fallback to org ID, throws clear error. | [x] |

## Notes

- The 8 available sub-teams under org 13347347:
  | ID | Name | Handle |
  |------|------|--------|
  | 132109 | Field Services v12 Demo | field-services-v12-demo |
  | 132118 | Customer Education v12 | customer-education-v12 |
  | 132272 | RonCorp | roncorp |
  | 132319 | CSE v12 | cse-v12 |
  | 132369 | National Football League Demo | national-football-league-demo |
  | 132485 | BRKC Demo | brkc-demo |
  | 132655 | LPL Financial Demo | lpl-financial-demo |
  | 134958 | JNS Corp | jns-corp |
