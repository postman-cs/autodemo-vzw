import { readFileSync } from "fs";
import { parseArgs } from "util";

const WORKER_URL = process.env.WORKER_URL || "https://se.pm-catalog.dev";
const REQUESTER_EMAIL = process.env.REQUESTER_EMAIL || "admin@postman.com";

async function main() {
    const { values: args } = parseArgs({
        options: {
            "dry-run": { type: "boolean", default: false },
            "environment": { type: "string", default: "prod" },
        },
    });

    const sessionToken = process.env.SESSION_TOKEN || process.env.AUTH_SESSION_SECRET_TOKEN;
    if (!sessionToken && !args["dry-run"]) {
        console.error("ERROR: Set SESSION_TOKEN in env to authenticate.");
        process.exit(1);
    }

    const cookieHeader = sessionToken ? `catalog_admin_session=${sessionToken}` : "";

    console.log("=== Planner-backed Remediation ===");
    console.log(`Worker:      ${WORKER_URL}`);
    console.log(`Dry run:     ${args["dry-run"]}`);
    console.log(`Environment: ${args.environment}`);
    console.log("");

    // 1. Read local dependencies & registry
    const dependencies = JSON.parse(readFileSync("specs/dependencies.json", "utf-8"));
    const registry = JSON.parse(readFileSync("specs/registry.json", "utf-8"));

    // Build lookup mapping spec_id to (domain, filename)
    const specMeta = new Map();
    for (const entry of registry) {
        specMeta.set(entry.id, entry);
    }

    // Find all required dependency targets
    const requiredTargets = new Set();
    for (const [sourceId, entry] of Object.entries(dependencies)) {
        if (entry && Array.isArray(entry.dependsOn)) {
            for (const target of entry.dependsOn) {
                requiredTargets.add(target);
            }
        }
    }
    console.log(`Found ${requiredTargets.size} unique dependency targets required by services.`);

    // 2. Fetch active deployments
    console.log("Fetching current deployment state...");
    const headers = cookieHeader ? { Cookie: cookieHeader } : {};
    let deployments = [];
    try {
        const res = await fetch(`${WORKER_URL}/api/deployments`, { headers });
        if (!res.ok) {
            throw new Error(`Worker returned ${res.status}: ${await res.text()}`);
        }
        const data = await res.json();
        deployments = data.deployments || [];
    } catch (err) {
        console.error(`Failed to fetch deployments: ${err.message}`);
        if (!args["dry-run"]) process.exit(1);
    }

    // 3. Identify missing targets
    const missingTargets = [];
    for (const target of requiredTargets) {
        const active = deployments.some((dep) => {
            if (dep.spec_id !== target) return false;
            if (dep.status !== "active") return false;
            if (dep.runtime_mode !== "k8s_workspace" && dep.runtime_mode !== "k8s_discovery") return false;
            // Also verify environment includes our target environment
            try {
                const envs = JSON.parse(dep.environments_json || "[\"prod\", \"stage\"]");
                return envs.includes(args.environment);
            } catch {
                return true; // Assume true if unparseable
            }
        });

        if (!active) {
            missingTargets.push(target);
        }
    }

    missingTargets.sort();
    console.log(`Identified ${missingTargets.length} missing or inactive dependency targets for ${args.environment}.`);

    if (missingTargets.length === 0) {
        console.log("✅ Graph is healthy, no remediation required.");
        return;
    }

    console.log("\nMissing targets:");
    missingTargets.forEach((t) => console.log(`  - ${t}`));

    if (args["dry-run"]) {
        console.log("\n[DRY RUN] Exiting without provisioning.");
        return;
    }

    console.log("\nStarting remediation (deploying via graph mode)...");

    for (let i = 0; i < missingTargets.length; i++) {
        const target = missingTargets[i];
        const meta = specMeta.get(target);
        if (!meta) {
            console.error(`[${i + 1}/${missingTargets.length}] ✗ ${target}: Spec not found in registry`);
            continue;
        }

        const payload = {
            project_name: target,
            domain: meta.domain || "core",
            requester_email: REQUESTER_EMAIL,
            spec_source: target,
            spec_url: `${WORKER_URL}/specs/${meta.filename}`,
            environments: [args.environment],
            runtime: "k8s_workspace",
            deployment_mode: "graph",
            k8s_discovery_workspace_link: false
        };

        console.log(`[${i + 1}/${missingTargets.length}] START ${target} (graph mode)`);
        try {
            const res = await fetch(`${WORKER_URL}/api/provision`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...headers
                },
                body: JSON.stringify(payload)
            });
            // The worker responds with a stream. We just need to read it until completion or error.
            const reader = res.body?.getReader();
            if (!reader) {
                console.log(`[${i + 1}/${missingTargets.length}] ✗ Failed to read response stream.`);
                continue;
            }

            const decoder = new TextDecoder();
            let streamFailed = false;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                if (chunk.includes('"status":"error"')) {
                    streamFailed = true;
                    console.log(chunk.split("\n").find(l => l.includes('"status":"error"')) || chunk);
                }
            }

            if (streamFailed) {
                console.log(`[${i + 1}/${missingTargets.length}] ✗ ${target} failed during graph execution.`);
            } else {
                console.log(`[${i + 1}/${missingTargets.length}] ✓ ${target} sequence complete.`);
            }
        } catch (err) {
            console.error(`[${i + 1}/${missingTargets.length}] ✗ ${target}: Request error: ${err.message}`);
        }
    }

    console.log("\n✅ Remediation run complete.");
}

main().catch(console.error);
