#!/usr/bin/env node
/**
 * Delete all workspaces in the Postman team using the Postman API.
 * Requires POSTMAN_API_KEY in env (e.g. source .env first).
 */

const API_BASE = "https://api.getpostman.com";

async function main() {
  const apiKey = process.env.POSTMAN_API_KEY;
  if (!apiKey) {
    console.error("POSTMAN_API_KEY is required. Run: source .env");
    process.exit(1);
  }
  const headers = {
    "X-Api-Key": apiKey,
    "Content-Type": "application/json",
  };

  // List all workspaces (API returns workspaces the key has access to)
  const listRes = await fetch(`${API_BASE}/workspaces`, { headers });
  if (!listRes.ok) {
    console.error("Failed to list workspaces:", listRes.status, await listRes.text());
    process.exit(1);
  }

  const listBody = await listRes.json();
  const workspaces = listBody.workspaces || [];

  if (workspaces.length === 0) {
    console.log("No workspaces found");
    return;
  }

  console.log(`Deleting ${workspaces.length} workspace(s):`);
  for (const w of workspaces) {
    console.log(`  - ${w.name} (${w.id})`);
  }

  for (const w of workspaces) {
    const delRes = await fetch(`${API_BASE}/workspaces/${w.id}`, {
      method: "DELETE",
      headers,
    });
    if (delRes.ok) {
      console.log(`Deleted: ${w.name} (${w.id})`);
    } else {
      console.error(`Failed to delete ${w.name} (${w.id}):`, delRes.status, await delRes.text());
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
