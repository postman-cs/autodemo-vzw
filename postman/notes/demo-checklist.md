# Pre-Demo Setup and Verification Checklist

**Date:** 2026-03-27  
**Presenter:** Run through this checklist 30 minutes before going live.

---

## Workspace Setup

- [ ] Partner Workspace "Verizon x Metro City Dispatch" exists and is accessible
- [ ] All 3 collections imported (Verizon Network, HERE Location Services, Metro City Dispatch CAD)
- [ ] Environment "Verizon x Metro City Dispatch" imported and active
- [ ] Mock servers created for all 3 collections
- [ ] Environment base URLs point to mock server URLs (verizon_base, here_base, cad_base)

---

## Request Verification

- [ ] POST /api/ts/v1/oauth2/token returns 200 with access_token
- [ ] POST /api/loc/v1/locations returns 200 with location data
- [ ] POST /quality-on-demand/v1/sessions returns 200 with sessionId
- [ ] GET /v8/routes returns 200 with route and 420s duration
- [ ] GET /geocode returns 200 with position data
- [ ] POST /v1/incidents returns 201 with incidentId
- [ ] GET /v1/units/available returns 200 with 2 ambulances
- [ ] POST /v1/incidents/{id}/dispatch returns 200 with dispatchId
- [ ] GET /v1/units/{id}/telemetry returns 200 with vitals and connectivity

---

## Debugging Lane

- [ ] POST /m2m/v1/devices/locations/actions/sync returns 410 with LEGACY_ENDPOINT error
- [ ] Comment thread is staged on the broken request
- [ ] Replacement request runs successfully after "fix"

---

## Agent Mode

- [ ] Fern docs MCP is attached to Agent Mode
- [ ] Agent can access Verizon location documentation
- [ ] Tested: Agent successfully repairs the broken request (path, header, body)

---

## Flow

- [ ] "Emergency Dispatch: First Responder Routing" Flow exists
- [ ] Flow has been pre-run at least once with successful output
- [ ] Flow output is visible and clear

---

## Presentation

- [ ] Screen resolution set for projection/sharing
- [ ] Postman dark/light theme matches presentation preference
- [ ] Browser tabs closed (no distracting notifications)
- [ ] Demo script accessible (second screen or printed)

---

## Fallback Prep

- [ ] Screenshots of each act's expected output saved locally
- [ ] Pre-run Flow output retained (in case live run is slow)
- [ ] Know which acts can be narrated from screenshots if mocks fail
