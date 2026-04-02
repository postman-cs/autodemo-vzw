import type { ProvisioningEnv as Env } from "./provisioning-env";
import {
  getLatestWorkflowRun,
  getWorkflowJobs,
  normalizeGitHubToken,
  triggerWorkflow,
  createRepoSecret,
} from "./github";
import { getInfraRecord, isAirtableConfigured, getActiveEcsServiceCount, getActiveK8sDiscoveryServiceCount } from "./airtable";
import { SSEWriter } from "./sse";
import { sleep } from "./sleep";
import { resolveTeamCredentials } from "./team-registry";

const ADMIN_REPO = "vzw-partner-demo";
const SETUP_WORKFLOW = "ecs-infra-setup.yml";
const TEARDOWN_WORKFLOW = "ecs-infra-teardown.yml";
const K8S_DISCOVERY_SETUP_WORKFLOW = "k8s-discovery-infra-setup.yml";
const K8S_DISCOVERY_TEARDOWN_WORKFLOW = "k8s-discovery-infra-teardown.yml";
const DEFAULT_AWS_REGION = "eu-central-1";
const DEFAULT_RESOURCE_PREFIX = "vzw-partner-demo";
const DEFAULT_K8S_NAMESPACE = "vzw-partner-demo";
const K8S_DISCOVERY_COMPONENT = "k8s_discovery_shared";

interface InfraRequestBody {
  aws_region?: string;
  resource_prefix?: string;
  k8s_namespace?: string;
  team_slug?: string;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function normalizeInput(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeTeamSlug(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildDiscoveryDaemonsetNamespace(teamSlug: string): string {
  return `postman-insights-${normalizeTeamSlug(teamSlug) || "default"}`;
}

async function parseRequestBody(request: Request): Promise<InfraRequestBody> {
  const text = await request.text();
  if (!text.trim()) return {};
  return JSON.parse(text) as InfraRequestBody;
}

async function streamWorkflow(
  token: string,
  workflow: string,
  sse: SSEWriter,
  phase: "infra_setup" | "infra_teardown" | "k8s_discovery_infra_setup" | "k8s_discovery_infra_teardown",
  previousRunId?: number,
): Promise<{ runId: number; runUrl: string }> {
  let runId: number | null = null;
  let runUrl = "";

  for (let attempt = 0; attempt < 30; attempt++) {
    const latest = await getLatestWorkflowRun(token, ADMIN_REPO, workflow);
    if (latest && latest.id !== previousRunId) {
      runId = latest.id;
      runUrl = latest.html_url;
      break;
    }
    await sleep(2000);
  }

  if (!runId) {
    throw new Error("Timed out waiting for workflow run to start");
  }

  sse.send({
    phase,
    status: "running",
    message: "Workflow run detected",
    data: { run_id: runId, run_url: runUrl },
  });

  const seenSteps = new Set<string>();
  for (let attempt = 0; attempt < 120; attempt++) {
    const latest = await getLatestWorkflowRun(token, ADMIN_REPO, workflow);
    if (!latest || latest.id !== runId) {
      await sleep(3000);
      continue;
    }

    const jobs = await getWorkflowJobs(token, ADMIN_REPO, runId);
    for (const job of jobs) {
      for (const step of job.steps || []) {
        if (step.status !== "completed") continue;

        const key = `${job.name}:${step.number}:${step.conclusion || "unknown"}`;
        if (seenSteps.has(key)) continue;
        seenSteps.add(key);

        if (step.conclusion === "failure") {
          throw new Error(`Workflow step failed: ${step.name}`);
        }

        sse.send({
          phase,
          status: "running",
          message: `Completed step: ${step.name}`,
          data: { run_id: runId, run_url: latest.html_url },
        });
      }
    }

    if (latest.status === "completed") {
      if (latest.conclusion !== "success") {
        throw new Error(`Workflow completed with status: ${latest.conclusion || "unknown"}`);
      }
      return { runId, runUrl: latest.html_url };
    }

    await sleep(3000);
  }

  throw new Error("Timed out waiting for workflow completion");
}

export async function handleInfraSetup(request: Request, env: Env): Promise<Response> {
  let body: InfraRequestBody;
  try {
    body = await parseRequestBody(request);
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!isAirtableConfigured(env)) {
    return jsonResponse({ error: "Airtable is not configured" }, 503);
  }

  let ghToken = "";
  try {
    ghToken = normalizeGitHubToken(env.GH_TOKEN);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 503);
  }

  const region = normalizeInput(body.aws_region, DEFAULT_AWS_REGION);
  const resourcePrefix = normalizeInput(body.resource_prefix, DEFAULT_RESOURCE_PREFIX);

  const sse = new SSEWriter();
  const response = sse.toResponse();

  const pipeline = (async () => {
    try {
      const existing = await getInfraRecord(env as Record<string, unknown>, "ecs_shared");
      if (existing?.status === "active") {
        sse.send({
          phase: "infra_setup",
          status: "complete",
          message: "Shared ECS infrastructure is already active",
          data: { no_op: true, record_id: existing.id || "" },
        });
        sse.close();
        return;
      }

      const previousRun = await getLatestWorkflowRun(ghToken, ADMIN_REPO, SETUP_WORKFLOW);
      sse.send({
        phase: "infra_setup",
        status: "running",
        message: "Triggering ECS infrastructure setup workflow",
      });

      await triggerWorkflow(ghToken, ADMIN_REPO, SETUP_WORKFLOW, {
        aws_region: region,
        resource_prefix: resourcePrefix,
      });

      const completed = await streamWorkflow(
        ghToken,
        SETUP_WORKFLOW,
        sse,
        "infra_setup",
        previousRun?.id,
      );
      sse.send({
        phase: "infra_setup",
        status: "complete",
        message: "Infrastructure setup workflow completed",
        data: {
          no_op: false,
          run_id: completed.runId,
          run_url: completed.runUrl,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sse.send({ phase: "infra_setup", status: "error", message });
    } finally {
      sse.close();
    }
  })();

  // Keep stream alive after response return.
  pipeline.catch(() => {
    // Errors are already sent through SSE.
  });

  return response;
}

export async function handleInfraTeardown(request: Request, env: Env): Promise<Response> {
  let body: InfraRequestBody;
  try {
    body = await parseRequestBody(request);
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!isAirtableConfigured(env)) {
    return jsonResponse({ error: "Airtable is not configured" }, 503);
  }

  let ghToken = "";
  try {
    ghToken = normalizeGitHubToken(env.GH_TOKEN);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 503);
  }

  const region = normalizeInput(body.aws_region, DEFAULT_AWS_REGION);
  const resourcePrefix = normalizeInput(body.resource_prefix, DEFAULT_RESOURCE_PREFIX);

  const sse = new SSEWriter();
  const response = sse.toResponse();

  const pipeline = (async () => {
    try {
      const infraRecord = await getInfraRecord(env as Record<string, unknown>, "ecs_shared");
      if (!infraRecord || infraRecord.status !== "active") {
        sse.send({
          phase: "infra_teardown",
          status: "complete",
          message: "No active shared ECS infrastructure record found",
          data: { no_op: true },
        });
        sse.close();
        return;
      }

      const activeServices = await getActiveEcsServiceCount(env as Record<string, unknown>);
      if (activeServices > 0) {
        sse.send({
          phase: "infra_teardown",
          status: "error",
          message: "Remove all ECS services first",
          data: { active_services: activeServices },
        });
        sse.close();
        return;
      }

      const previousRun = await getLatestWorkflowRun(ghToken, ADMIN_REPO, TEARDOWN_WORKFLOW);
      sse.send({
        phase: "infra_teardown",
        status: "running",
        message: "Triggering ECS infrastructure teardown workflow",
      });

      await triggerWorkflow(ghToken, ADMIN_REPO, TEARDOWN_WORKFLOW, {
        aws_region: region,
        resource_prefix: resourcePrefix,
        airtable_record_id: infraRecord.id || "",
      });

      const completed = await streamWorkflow(
        ghToken,
        TEARDOWN_WORKFLOW,
        sse,
        "infra_teardown",
        previousRun?.id,
      );
      sse.send({
        phase: "infra_teardown",
        status: "complete",
        message: "Infrastructure teardown workflow completed",
        data: {
          no_op: false,
          run_id: completed.runId,
          run_url: completed.runUrl,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sse.send({ phase: "infra_teardown", status: "error", message });
    } finally {
      sse.close();
    }
  })();

  // Keep stream alive after response return.
  pipeline.catch(() => {
    // Errors are already sent through SSE.
  });

  return response;
}

export async function handleK8sDiscoveryInfraSetup(request: Request, env: Env): Promise<Response> {
  let body: InfraRequestBody;
  try {
    body = await parseRequestBody(request);
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!isAirtableConfigured(env)) {
    return jsonResponse({ error: "Airtable is not configured" }, 503);
  }

  let ghToken = "";
  try {
    ghToken = normalizeGitHubToken(env.GH_TOKEN);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 503);
  }

  const region = normalizeInput(body.aws_region, DEFAULT_AWS_REGION);
  const resourcePrefix = normalizeInput(body.resource_prefix, DEFAULT_RESOURCE_PREFIX);
  const k8sNamespace = normalizeInput(body.k8s_namespace, DEFAULT_K8S_NAMESPACE);
  const teamSlug = normalizeTeamSlug(body.team_slug);

  const sse = new SSEWriter();
  const response = sse.toResponse();

  const pipeline = (async () => {
    try {
      const existing = await getInfraRecord(env as Record<string, unknown>, K8S_DISCOVERY_COMPONENT);
      if (existing?.status === "active") {
        sse.send({
          phase: "k8s_discovery_infra_setup",
          status: "complete",
          message: "Shared Kubernetes discovery infrastructure is already active",
          data: { no_op: true, record_id: existing.id || "" },
        });
        sse.close();
        return;
      }

      const creds = await resolveTeamCredentials(
        (env as Record<string, unknown>).TEAM_REGISTRY as KVNamespace | undefined,
        env as Record<string, unknown>,
        teamSlug
      );

      sse.send({
        phase: "k8s_discovery_infra_setup",
        status: "running",
        message: `Injecting team-specific admin-repo secrets for ${creds.slug || "default"}`,
      });
      await createRepoSecret(ghToken, ADMIN_REPO, "POSTMAN_API_KEY", creds.api_key);
      await createRepoSecret(ghToken, ADMIN_REPO, "POSTMAN_ACCESS_TOKEN", creds.access_token);

      const previousRun = await getLatestWorkflowRun(ghToken, ADMIN_REPO, K8S_DISCOVERY_SETUP_WORKFLOW);
      sse.send({
        phase: "k8s_discovery_infra_setup",
        status: "running",
        message: "Triggering Kubernetes discovery infrastructure setup workflow",
      });

      await triggerWorkflow(ghToken, ADMIN_REPO, K8S_DISCOVERY_SETUP_WORKFLOW, {
        aws_region: region,
        resource_prefix: resourcePrefix,
        k8s_namespace: k8sNamespace,
        team_slug: creds.slug || "default",
        team_id: creds.team_id,
      });

      const completed = await streamWorkflow(
        ghToken,
        K8S_DISCOVERY_SETUP_WORKFLOW,
        sse,
        "k8s_discovery_infra_setup",
        previousRun?.id,
      );
      sse.send({
        phase: "k8s_discovery_infra_setup",
        status: "complete",
        message: "Kubernetes discovery infrastructure setup workflow completed",
        data: {
          no_op: false,
          run_id: completed.runId,
          run_url: completed.runUrl,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sse.send({ phase: "k8s_discovery_infra_setup", status: "error", message });
    } finally {
      sse.close();
    }
  })();

  pipeline.catch(() => {
    // Errors are already sent through SSE.
  });

  return response;
}

export async function handleK8sDiscoveryInfraTeardown(request: Request, env: Env): Promise<Response> {
  let body: InfraRequestBody;
  try {
    body = await parseRequestBody(request);
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!isAirtableConfigured(env)) {
    return jsonResponse({ error: "Airtable is not configured" }, 503);
  }

  let ghToken = "";
  try {
    ghToken = normalizeGitHubToken(env.GH_TOKEN);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 503);
  }

  const region = normalizeInput(body.aws_region, DEFAULT_AWS_REGION);
  const resourcePrefix = normalizeInput(body.resource_prefix, DEFAULT_RESOURCE_PREFIX);
  const k8sNamespace = normalizeInput(body.k8s_namespace, DEFAULT_K8S_NAMESPACE);
  const teamSlug = normalizeTeamSlug(body.team_slug);

  const sse = new SSEWriter();
  const response = sse.toResponse();

  const pipeline = (async () => {
    try {
      const infraRecord = await getInfraRecord(env as Record<string, unknown>, K8S_DISCOVERY_COMPONENT);
      if (!infraRecord || infraRecord.status !== "active") {
        sse.send({
          phase: "k8s_discovery_infra_teardown",
          status: "complete",
          message: "No active shared Kubernetes discovery infrastructure record found",
          data: { no_op: true },
        });
        sse.close();
        return;
      }

      const activeServices = await getActiveK8sDiscoveryServiceCount(env as Record<string, unknown>);
      if (activeServices > 0) {
        sse.send({
          phase: "k8s_discovery_infra_teardown",
          status: "error",
          message: "Remove all Kubernetes discovery-mode services first",
          data: { active_services: activeServices },
        });
        sse.close();
        return;
      }

      const previousRun = await getLatestWorkflowRun(ghToken, ADMIN_REPO, K8S_DISCOVERY_TEARDOWN_WORKFLOW);
      sse.send({
        phase: "k8s_discovery_infra_teardown",
        status: "running",
        message: "Triggering Kubernetes discovery infrastructure teardown workflow",
      });

      await triggerWorkflow(ghToken, ADMIN_REPO, K8S_DISCOVERY_TEARDOWN_WORKFLOW, {
        aws_region: region,
        resource_prefix: resourcePrefix,
        airtable_record_id: infraRecord.id || "",
        k8s_namespace: k8sNamespace,
        team_slug: teamSlug || "default",
        daemonset_namespace: buildDiscoveryDaemonsetNamespace(teamSlug || "default"),
      });

      const completed = await streamWorkflow(
        ghToken,
        K8S_DISCOVERY_TEARDOWN_WORKFLOW,
        sse,
        "k8s_discovery_infra_teardown",
        previousRun?.id,
      );
      sse.send({
        phase: "k8s_discovery_infra_teardown",
        status: "complete",
        message: "Kubernetes discovery infrastructure teardown workflow completed",
        data: {
          no_op: false,
          run_id: completed.runId,
          run_url: completed.runUrl,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sse.send({ phase: "k8s_discovery_infra_teardown", status: "error", message });
    } finally {
      sse.close();
    }
  })();

  pipeline.catch(() => {
    // Errors are already sent through SSE.
  });

  return response;
}
