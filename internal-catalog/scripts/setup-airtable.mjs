#!/usr/bin/env node
/**
 * Creates the Specs and Deployments tables in Airtable, then seeds
 * the Specs table with all entries from specs/registry.json.
 *
 * Requires: AIRTABLE_API_KEY, AIRTABLE_BASE_ID in .env.local
 * Run: node scripts/setup-airtable.mjs
 */

import { readFileSync } from "fs";
import { resolve } from "path";

const envPath = resolve(process.cwd(), ".env.local");
const envContent = readFileSync(envPath, "utf-8");
const env = {};
for (const line of envContent.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  env[trimmed.substring(0, eq).trim()] = trimmed.substring(eq + 1).trim();
}

const API_KEY = env.AIRTABLE_API_KEY;
const BASE_ID = env.AIRTABLE_BASE_ID;

if (!API_KEY || !BASE_ID) {
  console.error("Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID in .env.local");
  process.exit(1);
}

const META_API = `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`;
const DATA_API = `https://api.airtable.com/v0/${BASE_ID}`;

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

async function createTable(name, fields) {
  console.log(`Creating table "${name}"...`);
  const resp = await fetch(META_API, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, fields }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    if (err.includes("DUPLICATE_TABLE_NAME") || err.includes("already exists")) {
      console.log(`  Table "${name}" already exists, skipping creation.`);
      return;
    }
    throw new Error(`Failed to create table "${name}": ${resp.status} ${err}`);
  }
  const data = await resp.json();
  console.log(`  Created table "${name}" (id: ${data.id})`);
}

async function seedSpecs() {
  const registryPath = resolve(process.cwd(), "specs/registry.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
  console.log(`\nSeeding ${registry.length} specs into Specs table...`);

  // Airtable allows max 10 records per request
  for (let i = 0; i < registry.length; i += 10) {
    const batch = registry.slice(i, i + 10);
    const records = batch.map((spec) => ({
      fields: {
        spec_id: spec.id,
        title: spec.title,
        description: spec.description?.substring(0, 1000) || "",
        domain: spec.domain,
        filename: spec.filename,
        repo_name: spec.repo_name,
        endpoints: spec.endpoints,
        server_url: spec.server_url,
      },
    }));

    const resp = await fetch(`${DATA_API}/Specs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ records }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error(`  Batch ${i}-${i + batch.length} failed: ${err}`);
    } else {
      console.log(`  Seeded batch ${i + 1}-${i + batch.length}`);
    }
  }
}

// ── Main ──

try {
  await createTable("Specs", [
    { name: "spec_id", type: "singleLineText" },
    { name: "title", type: "singleLineText" },
    { name: "description", type: "multilineText" },
    { name: "domain", type: "singleLineText" },
    { name: "filename", type: "singleLineText" },
    { name: "repo_name", type: "singleLineText" },
    { name: "endpoints", type: "number", options: { precision: 0 } },
    { name: "server_url", type: "url" },
  ]);

  await createTable("Deployments", [
    { name: "spec_id", type: "singleLineText" },
    { name: "status", type: "singleLineText" },
    { name: "runtime_mode", type: "singleLineText" },
    { name: "deployment_mode", type: "singleLineText" },
    { name: "deployment_group_id", type: "singleLineText" },
    { name: "deployment_root_spec_id", type: "singleLineText" },
    { name: "graph_node_meta_json", type: "multilineText" },
    { name: "runtime_base_url", type: "url" },
    { name: "github_repo_url", type: "url" },
    { name: "github_repo_name", type: "singleLineText" },
    { name: "postman_workspace_url", type: "url" },
    { name: "workspace_id", type: "singleLineText" },
    { name: "postman_spec_uid", type: "singleLineText" },
    { name: "postman_collection_uids", type: "multilineText" },
    { name: "postman_run_url", type: "url" },
    { name: "postman_environment_uid", type: "singleLineText" },
    { name: "mock_url", type: "url" },
    { name: "aws_invoke_url", type: "url" },
    { name: "lambda_function_name", type: "singleLineText" },
    { name: "api_gateway_id", type: "singleLineText" },
    { name: "ecs_cluster_name", type: "singleLineText" },
    { name: "ecs_service_name", type: "singleLineText" },
    { name: "ecs_task_definition", type: "singleLineText" },
    { name: "ecs_target_group_arn", type: "singleLineText" },
    { name: "ecs_listener_rule_arn", type: "singleLineText" },
    { name: "k8s_namespace", type: "singleLineText" },
    { name: "k8s_deployment_name", type: "singleLineText" },
    { name: "k8s_service_name", type: "singleLineText" },
    { name: "k8s_ingress_name", type: "singleLineText" },
    { name: "k8s_cluster_name", type: "singleLineText" },
    { name: "dedicated_ip", type: "singleLineText" },
    { name: "dedicated_port", type: "singleLineText" },
    { name: "graph_transport_url", type: "url" },
    { name: "node_name", type: "singleLineText" },
    { name: "resource_inventory_json", type: "multilineText" },
    { name: "system_env_map", type: "multilineText" },
    { name: "environments_json", type: "multilineText" },
    { name: "environment_deployments", type: "multilineText" },
    { name: "chaos_enabled", type: "checkbox", options: { color: "yellowBright", icon: "check" } },
    { name: "chaos_config", type: "multilineText" },
    { name: "chaos_enabled_map", type: "multilineText" },
    { name: "aws_region", type: "singleLineText" },
    { name: "iam_role_name", type: "singleLineText" },
    { name: "deployed_at", type: "singleLineText" },
    { name: "logs", type: "multilineText" },
    { name: "failed_at_step", type: "singleLineText" },
    { name: "error_message", type: "multilineText" },
    { name: "fern_docs_url", type: "url" },
  ]);

  await createTable("Infrastructure", [
    { name: "component", type: "singleLineText" },
    { name: "status", type: "singleLineText" },
    { name: "cluster_name", type: "singleLineText" },
    { name: "vpc_id", type: "singleLineText" },
    { name: "subnet_ids", type: "singleLineText" },
    { name: "security_group_ids", type: "singleLineText" },
    { name: "execution_role_arn", type: "singleLineText" },
    { name: "task_role_arn", type: "singleLineText" },
    { name: "alb_arn", type: "singleLineText" },
    { name: "alb_listener_arn", type: "singleLineText" },
    { name: "alb_dns_name", type: "singleLineText" },
    { name: "ecr_repository", type: "singleLineText" },
    { name: "alb_sg_id", type: "singleLineText" },
    { name: "ecs_sg_id", type: "singleLineText" },
    { name: "aws_region", type: "singleLineText" },
    { name: "k8s_namespace", type: "singleLineText" },
    { name: "k8s_daemonset_name", type: "singleLineText" },
    { name: "k8s_cluster_name", type: "singleLineText" },
    { name: "k8s_context", type: "singleLineText" },
    { name: "created_at", type: "singleLineText" },
    { name: "updated_at", type: "singleLineText" },
    { name: "last_error", type: "multilineText" },
    { name: "last_run_url", type: "url" },
  ]);

  await createTable("GraphMemberships", [
    { name: "deployment_group_id", type: "singleLineText" },
    { name: "deployment_root_spec_id", type: "singleLineText" },
    { name: "spec_id", type: "singleLineText" },
    { name: "environment", type: "singleLineText" },
    { name: "layer_index", type: "number", options: { precision: 0 } },
    { name: "node_status", type: "singleLineText" },
    { name: "node_action", type: "singleLineText" },
    { name: "runtime_mode", type: "singleLineText" },
    { name: "graph_node_meta_json", type: "multilineText" },
  ]);

  await seedSpecs();

  console.log("\nDone! Airtable is set up.");
} catch (err) {
  console.error("Setup failed:", err.message);
  process.exit(1);
}
