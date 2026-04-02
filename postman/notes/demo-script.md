# Verizon Partner Workspace Demo Script

## Narrative

**Title:** A First Responder Gets There Faster  
**Presenter:** Jared Boynton, Head of Customer Success Engineering, Postman  
**Audience:** Verizon stakeholders  
**Target length:** 13 to 15 minutes

## Before the Demo

1. Open the `Verizon x Metro City Dispatch` Partner Workspace in Postman and pin it in the left sidebar.
2. Confirm these artifacts are visible and load correctly:
   - `Verizon Network` collection
   - `HERE Location Services` collection
   - `Metro City Dispatch CAD` collection
   - Shared environment for the demo
   - Mock servers for Verizon, HERE, and Metro City Dispatch
   - `Emergency Dispatch: First Responder Routing` Flow
3. Select the shared demo environment before the audience joins.
4. Verify the core happy-path requests return successful mock responses:
   - `Create Incident`
   - `List Available Units`
   - `Calculate Route`
   - `Create QoD Session`
   - `Dispatch Unit`
   - `Get Telemetry`
5. Verify the intentionally broken request returns the expected `410 LEGACY_ENDPOINT` response.
6. Pre-stage the request comment thread on the broken request so the partner mention and Verizon response are ready to show.
7. Confirm Agent Mode has access to the Fern docs MCP and can reach the Verizon location documentation.
8. Pre-run the Flow once so a successful end state is available even if you decide not to execute it live.
9. Close unrelated tabs, mute notifications, and set browser or desktop zoom so the collection tree and response panes are readable on a projected screen.
10. Keep a fallback tab ready with these items open in the background:
    - Successful location request
    - Successful QoD session response
    - Flow canvas with completed run
    - Reports or analytics page

## Key Variables

Use these names consistently during the demo. If you need to say them aloud, keep it short and literal.

| Variable | Purpose | Example demo value |
|---|---|---|
| `verizon_location_base` | Verizon Device Location mock base URL | Mock server URL |
| `verizon_network_base` | Verizon Network and QoD mock base URL | Mock server URL |
| `here_base` | HERE routing mock base URL | Mock server URL |
| `cad_base` | Metro City Dispatch CAD mock base URL | Mock server URL |
| `account_name` | Verizon account identifier used in location calls | `metro-city-dispatch` |
| `incident_address` | Address for the incoming 911 call | `1250 Market Street, Metro City` |
| `ambulance_imei` | Device identifier for the ambulance | `900000000000009` |
| `ambulance_mdn` | Mobile number for the ambulance modem | `7892345678` |
| `vz_m2m_token` | Verizon M2M token for current location endpoint | Demo token value |
| `bearer_token` | Bearer token for Verizon auth | Demo token value |
| `incident_id` | Incident created during Act 2 | Generated or mocked ID |
| `unit_id` | Selected ambulance or responder unit | Generated or mocked ID |
| `route_id` | Route response identifier | Generated or mocked ID |
| `qod_session_id` | Quality on Demand session identifier | Generated or mocked ID |

## Act 1: Partner Workspace Tour

**Time:** About 2 minutes

### Setup

- Postman is open to the `Verizon x Metro City Dispatch` Partner Workspace overview.
- The collection list is expanded enough to show the three collections, the shared environment, and mock-related assets.

### Talking Points

- "This workspace is the partner delivery surface. Everything a partner needs to integrate is in one place."
- "Instead of sending teams across portals, PDFs, and support threads, Verizon can package the full working surface inside Postman."
- "What you're seeing here is not one API, it's a partner-ready integration space that spans Verizon, HERE, and the city dispatch system."

### Exact Steps

1. Start on the Partner Workspace home and pause for two seconds so the workspace title is clear.
2. Say: "This is the Verizon x Metro City Dispatch Partner Workspace. The story today is simple, a first responder gets there faster."
3. In the left sidebar, click `Collections`.
4. Click `Verizon Network` and briefly point out the location and QoD requests.
5. Click `HERE Location Services` and point out routing.
6. Click `Metro City Dispatch CAD` and point out incident, dispatch, and telemetry requests.
7. Click `Environments` or use the environment selector in the top bar, then show the shared demo environment.
8. Call out that the same variables power the full story across all three providers.
9. Show the mock servers or reference the base URLs in the environment and say that partners can run the workflow immediately without waiting on live backends.
10. Land back on the collection list with all three collections visible.

### Transition to Next Act

"Now that the workspace is set, I'll run the exact operational flow a partner would test on day one."

### Fallback Note

If the workspace home is slow to load, stay in the collection sidebar and narrate from there. The important proof point is that the Verizon, HERE, and Metro City assets sit together in one partner-facing workspace.

## Act 2: End-to-End First Responder Flow

**Time:** About 3 minutes

### Setup

- The shared demo environment is selected.
- The `Metro City Dispatch CAD` collection is expanded and ready.
- The six requests are easy to reach in sequence.

### Talking Points

- "A 911 call comes in, the system finds the right ambulance, calculates the best route, reserves network priority, dispatches the unit, and then keeps monitoring the response."
- "The point is the cross-API integration. City systems, Verizon network capabilities, and HERE routing all work as one operational chain."
- "Postman is where the partner proves the full business workflow, not just isolated endpoint calls."

### Exact Steps

1. Click `Create Incident` in `Metro City Dispatch CAD`.
2. Point to the body and say: "A 911 call has just come in for this incident address."
3. Click `Send`.
4. In the response, call out the returned `incident_id` and say: "We now have an active incident in the dispatch system."
5. Click `List Available Units`.
6. Click `Send`.
7. In the response, say: "Now the system checks which ambulances are available for dispatch."
8. If the response includes a nearest or suitable unit, point to it and name it as the responding ambulance.
9. Click `Calculate Route` in `HERE Location Services`.
10. Click `Send`.
11. Say: "HERE gives us the fastest route from the selected unit to the incident."
12. Point to ETA, distance, or route summary fields if present.
13. Click `Create QoD Session` in `Verizon Network`.
14. Click `Send`.
15. Say: "Before the ambulance is dispatched, Verizon reserves higher-priority bandwidth so video or telemetry doesn't compete with ordinary traffic."
16. Point to the successful session creation and mention the `qod_session_id` if available.
17. Click `Dispatch Unit` in `Metro City Dispatch CAD`.
18. Click `Send`.
19. Say: "Now the ambulance is officially dispatched with route and network priority already in place."
20. Click `Get Telemetry`.
21. Click `Send`.
22. Say: "And this closes the loop. The ER or command center can monitor the unit once it is en route."
23. Pause on the final successful response and summarize the chain: city incident, unit selection, HERE routing, Verizon QoD, dispatch, telemetry.

### Transition to Next Act

"That is the happy path. In reality, partners don't just need APIs, they need a fast way to recover when an integration drifts."

### Fallback Note

If any live request slows down or the responses feel too dense, switch to previously successful tabs and narrate the sequence from the saved responses. Keep the story moving. The important point is the operational chain across the three API surfaces.

## Act 3: Human-in-the-Loop Fix

**Time:** About 2 minutes

### Setup

- The intentionally broken Verizon location request is visible.
- The request comment thread is already staged.
- A working corrected request or edit history is ready in another tab if needed.

### Talking Points

- "When a partner hits an outdated endpoint, the fix should happen in the same place as the failing request."
- "Collaboration happens where the work happens."
- "This shortens the time from failure to resolution because the engineer sees the exact request, exact error, and exact fix in context."

### Exact Steps

1. Click the `Legacy - BROKEN` Verizon location request.
2. Point to the legacy path `/m2m/v1/devices/locations/actions/sync` and say: "This is an intentionally outdated request that a partner might still be using from an older integration pattern."
3. Click `Send`.
4. In the response, point to the `410` status and the `LEGACY_ENDPOINT` message.
5. Read the core error message aloud: "Use POST /api/loc/v1/locations with accountName, deviceList, and VZ-M2M-Token."
6. Open the request comments or activity thread.
7. Show the partner developer tagging a Verizon engineer.
8. Say: "The partner doesn't need to leave the request and open a separate support process. The escalation happens in place."
9. Show the Verizon engineer response and the updated request.
10. Point out the changes at a high level: new endpoint, new header, new body shape.
11. Re-run the corrected request.
12. Show the success response.
13. Say: "The same request is now fixed and runnable inside the shared workspace."

### Transition to Next Act

"Now I'll show the same repair flow, but instead of waiting for a human teammate, I'll use Agent Mode with the docs attached."

### Fallback Note

If comments are slow or unavailable, narrate the collaboration lane from the staged thread screenshot or preloaded response. The key proof point is that the failure, discussion, and fix are all attached to the request itself.

## Act 4: Agent Mode and Docs MCP

**Time:** About 2 minutes

### Setup

- The same broken Verizon request is open.
- Agent Mode is available.
- Fern docs MCP is connected and verified before the demo.

### Talking Points

- "The AI consults the actual docs, not hallucinated knowledge."
- "Because the docs are attached to the workspace context, the model can reason over the real endpoint contract."
- "This is not generic code generation. It is guided repair against the current Verizon documentation."

### Exact Steps

1. Return to the broken request state, or open a fresh copy of the `Legacy - BROKEN` request.
2. Launch Agent Mode.
3. State the prompt out loud as you enter it: "Repair this Verizon location request using the attached Fern docs. Update the path, required headers, and request body to the current supported format."
4. Call out that the docs MCP is attached before you run the agent.
5. Run the agent.
6. As the response appears, point out each change:
   - legacy path replaced with `/api/loc/v1/locations`
   - `VZ-M2M-Token` header added
   - body reshaped from `devices` to `accountName`, `cacheMode`, and `deviceList`
7. Apply the suggested changes if they are not already inserted.
8. Click `Send` on the repaired request.
9. Show the successful response.
10. Say: "The fix came from the current docs inside the workspace context, not from guesswork."

### Transition to Next Act

"So far everything has been request-level. Next I'll show the same operational story in a format that product, operations, and partner teams can understand at a glance."

### Fallback Note

If Agent Mode is slow or inconsistent, show a prepared repaired version and narrate the intended agent changes one by one. Explicitly say the verified change set: new path, `VZ-M2M-Token` header, and `accountName` plus `deviceList` body.

## Act 5: Postman Flows

**Time:** About 2 minutes

### Setup

- The `Emergency Dispatch: First Responder Routing` Flow is open.
- A previously successful run is available on screen, or the blocks are arranged cleanly for walkthrough.

### Talking Points

- "The same workflow you just ran is now visible to any stakeholder."
- "Flows turn a technical integration sequence into an operational picture that is easy to review with partner, product, and business teams."
- "This helps Verizon align engineering and non-engineering teams around the same live workflow."

### Exact Steps

1. Open the Flow titled `Emergency Dispatch: First Responder Routing`.
2. Pause so the full canvas is visible.
3. Say: "This is the same chain you just watched at the request level."
4. Click or highlight the `Create Incident` block.
5. Move to `Get Ambulance Location` or equivalent location lookup block.
6. Move to `Select Nearest Unit` and explain that the workflow chooses the right responder.
7. Move to `Calculate Route` and say that HERE provides the fastest path.
8. Move to `Reserve QoD Session` and say that Verizon network priority is established before dispatch.
9. Move to `Dispatch Unit`.
10. Move to `Check Telemetry`.
11. If the Flow has visible outputs, point to the final success state.
12. Say: "What was six API calls in sequence is now one visible operational pipeline."

### Transition to Next Act

"The last question Verizon usually asks is not whether a single partner can run the workflow, it's whether Verizon can see how every partner is progressing at scale."

### Fallback Note

If the Flow editor is slow, use the static canvas and narrate the blocks without executing anything. If needed, refer back to the request sequence from Act 2 and map each request to its Flow block.

## Act 6: Analytics and Next Steps

**Time:** About 2 minutes

### Setup

- Reports, analytics, or a prepared talk track is ready.
- If live analytics are not available, stay on a clean Postman screen and speak to the built-in reporting capabilities.

### Talking Points

- "Postman gives Verizon native visibility into how every partner is progressing."
- "The built-in reports show where onboarding friction happens, which partners need attention, and how API success is trending."
- "This lets partner success, platform, and engineering teams operate from one shared operational view."

### Exact Steps

1. Open the reports or partner workspace analytics view if available.
2. Say: "At the platform level, Verizon needs more than a demo. It needs visibility into partner progress."
3. Call out the partner onboarding funnel:
   - total partners
   - workspace visits
   - viewed collections
   - requests sent
   - successful API responses
4. Call out API health metrics such as aggregate success rate and where partners may need attention.
5. Call out per-partner drill-down, including request-level or endpoint-level visibility where available.
6. If live analytics are not open, describe them directly and keep moving.
7. Close with: "So the value here is not just that Verizon can publish partner-ready APIs. Verizon can also see how partners onboard, where they stall, and what needs intervention."
8. End with next steps:
   - publish the partner workspace structure for the target Verizon partner segment
   - refine the mock and auth posture for the pilot audience
   - instrument partner onboarding and success reviews around these built-in reports

### Transition to Close

"That is the full picture: partner-ready workspace, end-to-end workflow, human repair, agent-assisted repair, visual orchestration, and partner analytics in one operating surface."

### Fallback Note

If the analytics page is unavailable, present the analytics talk track verbally. The critical message is that Postman already provides a partner onboarding funnel, API success visibility, and per-partner drill-down without requiring a custom reporting build for the initial motion.

## Closing Line

"For Verizon, this means a partner can go from invitation to a working first responder workflow in one shared environment, and your teams can see progress, fix issues, and improve partner outcomes without leaving Postman."

## Optional Presenter Notes

- Keep the emotional center on response time and operational reliability, not on telecom jargon.
- If the room goes technical, emphasize the current Verizon location path, the required `VZ-M2M-Token` header, and the cross-system orchestration with HERE and city dispatch.
- If the room goes strategic, emphasize partner onboarding speed, fewer support loops, and native visibility into partner progress.
- If time gets tight, shorten Act 2 by summarizing one or two responses instead of reading each response body.
