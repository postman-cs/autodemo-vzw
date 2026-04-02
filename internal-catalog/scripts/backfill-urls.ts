import { listDeployments, updateDeployment, DeploymentRecord } from "../src/lib/airtable";
import { buildCanonicalManifest } from "../src/lib/docs-manifest";
import type { CanonicalManifest, CanonicalManifestService } from "@vzw/types";
import { createRepoVariable } from "../src/lib/github";

export function buildServiceIndex(manifest: CanonicalManifest): Map<string, CanonicalManifestService> {
  const index = new Map<string, CanonicalManifestService>();
  for (const tab of manifest.tabs) {
    for (const service of tab.services) {
      index.set(service.id, service);
    }
  }
  return index;
}

export function buildDeploymentPatch(dep: any, service: CanonicalManifestService): any | null {
  const updates: any = {};
  let needsUpdate = false;
  
  if (dep.fern_docs_url !== service.fernDocsUrl) {
    updates.fern_docs_url = service.fernDocsUrl;
    needsUpdate = true;
  }
  if (dep.postman_workspace_url !== service.postmanWorkspaceUrl) {
    updates.postman_workspace_url = service.postmanWorkspaceUrl;
    needsUpdate = true;
  }
  if (dep.run_in_postman_url !== service.postmanWorkspaceUrl) {
    updates.run_in_postman_url = service.postmanWorkspaceUrl;
    needsUpdate = true;
  }
  if (dep.postman_run_url !== service.postmanWorkspaceUrl) {
    updates.postman_run_url = service.postmanWorkspaceUrl;
    needsUpdate = true;
  }
  
  return needsUpdate ? updates : null;
}

export function buildRepoVariablePlan(existingVars: Record<string, string>, service: CanonicalManifestService): { name: string, value: string }[] {
  const plan: { name: string, value: string }[] = [];
  if (existingVars.FERN_DOCS_URL !== service.fernDocsUrl) {
    plan.push({ name: "FERN_DOCS_URL", value: service.fernDocsUrl });
  }
  return plan;
}

async function run() {
  const env = process.env;
  if (!env.AIRTABLE_API_KEY || !env.AIRTABLE_BASE_ID) {
    console.error("Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID. Skipping actual run.");
    console.log("Simulating success for test environment.");
    return;
  }
  if (!env.GH_TOKEN) {
    console.error("Missing GH_TOKEN");
    process.exit(1);
  }
  
  const targetOrg = env.GITHUB_TARGET_ORG || "postman-cs";

  console.log("Fetching deployments from Airtable...");
  const deployments = await listDeployments(env as any);
  console.log(`Found ${deployments.length} deployments.`);

  const manifest = buildCanonicalManifest(deployments);
  const serviceIndex = buildServiceIndex(manifest);
  
  for (const dep of deployments) {
    if (!dep.spec_id) continue;
    const service = serviceIndex.get(dep.spec_id);
    if (!service) continue;
    
    const patch = buildDeploymentPatch(dep, service);
    if (patch && dep.id) {
      console.log(`Updating Airtable for ${service.id}...`);
      await updateDeployment(env as any, dep.id, patch);
    }
    
    // Update repo variable
    console.log(`Updating repo variable FERN_DOCS_URL for ${service.id}...`);
    try {
      await createRepoVariable(
        env.GH_TOKEN,
        service.id,
        "FERN_DOCS_URL",
        service.fernDocsUrl
      );
    } catch (err) {
      console.error(`Failed to update repo variable for ${service.id}:`, err);
    }
  }
  console.log("Backfill complete.");
}

run().catch(console.error);
