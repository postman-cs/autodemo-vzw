import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { handleBatchTeardown, handleTeardown, handleStatus, runAwsCleanupWorkflow } from "../src/lib/teardown";
import type { ProvisioningEnv } from "../src/lib/provisioning-env";
import { ORG, setGitHubOrg } from "../src/lib/github";
import { server, setupFetchMock, teardownFetchMock } from "./helpers/fetch-mock";
import { TEST_K8S_NAMESPACE, TEST_WORKER_URL } from "./helpers/constants";
import { makeTeamRegistryKV, TEST_TEAM_SLUG } from "./helpers/team-registry";

vi.mock("../src/lib/sleep", () => ({
  sleep: () => Promise.resolve(),
}));

const mockEnv = {
  ASSETS: { fetch: async () => new Response("asset") },
  POSTMAN_API_KEY: "test-key",
  POSTMAN_ACCESS_TOKEN: "test-token",
  GH_TOKEN: "test-gh",
  AWS_ACCESS_KEY_ID: "test-aws-key",
  AWS_SECRET_ACCESS_KEY: "test-aws-secret",
  TEAM_REGISTRY: makeTeamRegistryKV(),
} as unknown as ProvisioningEnv;

async function readAllSSEEvents(resp: Response): Promise<any[]> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: any[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        events.push(JSON.parse(line.substring(6)));
      }
    }
  }
  return events;
}

// ---- helpers ----

const repoVariableMocks = new Map<string, Record<string, string>>();

function mockRepoVariables(
  repoName: string,
  vars: Record<string, string>,
  options: { status?: number } = {},
): Record<string, string> {
  const existing = repoVariableMocks.get(repoName);
  if (existing) {
    Object.assign(existing, vars);
    return existing;
  }
  const nextVars = { ...vars };
  repoVariableMocks.set(repoName, nextVars);
  const status = options.status ?? 200;
  // Match with or without query params (listRepoVariables uses ?per_page=30&page=1)
  server.use(
    http.get(new RegExp(`^https://api\\.github\\.com/repos/postman-cs/${repoName}/actions/variables`), () => {
      if (status !== 200) {
        return new HttpResponse("not found", { status });
      }
      return HttpResponse.json({
        total_count: Object.keys(nextVars).length,
        variables: Object.entries(nextVars).map(([name, value]) => ({ name, value })),
      });
    }),
  );
  return nextVars;
}

function mockMissingRepoVariables(repoName: string): void {
  mockRepoVariables(repoName, { POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG }, { status: 404 });
}

function mockCommonRepoVariableLookups(repoName: string): void {
  mockRepoVariables(repoName, { POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG });
}

function mockBifrostWorkspaceLookup(count = 2): void {
  for (let i = 0; i < count; i += 1) {
    server.use(
      http.post("https://bifrost-premium-https-v4.gw.postman.com/ws/proxy", () =>
        HttpResponse.json({ data: [] }), { once: true }),
    );
  }
}

function mockLambdaHintLookups(repoName: string, hints: { functionName?: string; gatewayUrl?: string } = {}): void {
  mockCommonRepoVariableLookups(repoName);
  const vars: Record<string, string> = {};
  if (hints.functionName) vars.FUNCTION_NAME = hints.functionName;
  if (hints.gatewayUrl) vars.DEV_GW_URL = hints.gatewayUrl;
  mockRepoVariables(repoName, vars);
  server.use(
    http.get(`https://api.github.com/repos/postman-cs/${repoName}`, () =>
      HttpResponse.json({ full_name: `postman-cs/${repoName}` }), { once: true }),
  );
}

function mockEcsHintLookups(
  repoName: string,
  hints: { clusterName?: string; serviceName?: string; targetGroupArn?: string; listenerRuleArn?: string } = {},
): void {
  mockCommonRepoVariableLookups(repoName);
  const vars: Record<string, string> = {};
  if (hints.clusterName) vars.ECS_CLUSTER_NAME = hints.clusterName;
  if (hints.serviceName) vars.ECS_SERVICE_NAME = hints.serviceName;
  if (hints.targetGroupArn) vars.ECS_TARGET_GROUP_ARN = hints.targetGroupArn;
  if (hints.listenerRuleArn) vars.ECS_LISTENER_RULE_ARN = hints.listenerRuleArn;
  mockRepoVariables(repoName, vars);
}

function mockK8sHintLookups(
  repoName: string,
  hints: { namespace?: string; deploymentName?: string; serviceName?: string; ingressName?: string } = {},
): void {
  mockCommonRepoVariableLookups(repoName);
  const vars: Record<string, string> = {};
  if (hints.namespace) vars.K8S_NAMESPACE = hints.namespace;
  if (hints.deploymentName) vars.K8S_DEPLOYMENT_NAME = hints.deploymentName;
  if (hints.serviceName) vars.K8S_SERVICE_NAME = hints.serviceName;
  if (hints.ingressName) vars.K8S_INGRESS_NAME = hints.ingressName;
  mockRepoVariables(repoName, vars);
}

function mockTeardownSecretProvisioning(repoName: string, secretCount = 2): void {
  for (let i = 0; i < secretCount; i += 1) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${repoName}/actions/secrets/public-key`, () =>
        HttpResponse.json({ key_id: "test-key-id", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }), { once: true }),
      http.put(new RegExp(`https://api\\.github\\.com/repos/postman-cs/${repoName}/actions/secrets/[^/]+$`), () =>
        HttpResponse.json({}, { status: 201 }), { once: true }),
    );
  }
}

function mockWorkflowRunCorrelation(
  runsUrl: string,
  run: { id: number; status: string; conclusion: string | null; html_url: string },
): void {
  let requestCount = 0;
  server.use(
    http.get(runsUrl, () => {
      requestCount += 1;
      if (requestCount === 1) {
        return HttpResponse.json({ total_count: 0, workflow_runs: [] });
      }
      return HttpResponse.json({ total_count: 1, workflow_runs: [run] });
    }),
  );
}

function mockAwsTeardownWorkflowSuccess(
  repoName: string,
  runId: number,
  stepName = "Delete Lambda Functions and API Gateways",
): void {
  const secretCount = stepName.includes("Kubernetes") ? 3 : 2;
  mockTeardownSecretProvisioning(repoName, secretCount);
  const runsPath = `https://api.github.com/repos/postman-cs/${repoName}/actions/workflows/worker-teardown.yml/runs`;
  mockWorkflowRunCorrelation(runsPath, {
    id: runId,
    status: "in_progress",
    conclusion: null,
    html_url: `https://github.com/postman-cs/${repoName}/actions/runs/${runId}`,
  });
  server.use(
    http.get(`https://api.github.com/repos/postman-cs/${repoName}/contents/.github/workflows/worker-teardown.yml`, () =>
      new HttpResponse("not found", { status: 404 }), { once: true }),
    http.put(`https://api.github.com/repos/postman-cs/${repoName}/contents/.github/workflows/worker-teardown.yml`, () =>
      HttpResponse.json({ content: { path: ".github/workflows/worker-teardown.yml" } }, { status: 201 }), { once: true }),
    http.post(`https://api.github.com/repos/postman-cs/${repoName}/actions/workflows/worker-teardown.yml/dispatches`, () =>
      HttpResponse.json({}), { once: true }),
    http.get(`https://api.github.com/repos/postman-cs/${repoName}/actions/runs/${runId}`, () =>
      HttpResponse.json({ id: runId, status: "completed", conclusion: "success", html_url: `https://github.com/postman-cs/${repoName}/actions/runs/${runId}` }), { once: true }),
    http.get(`https://api.github.com/repos/postman-cs/${repoName}/actions/runs/${runId}/jobs`, () =>
      HttpResponse.json({ jobs: [{ name: "teardown", status: "completed", conclusion: "success", steps: [{ name: stepName, status: "completed", conclusion: "success", number: 1 }] }] }), { once: true }),
  );
}

// ---- lifecycle ----

beforeEach(() => {
  setGitHubOrg("postman-cs");
  repoVariableMocks.clear();
});

afterEach(() => {
  setGitHubOrg(ORG);
});

afterAll(() => server.close());

describe("handleTeardown", () => {
  beforeEach(() => { setupFetchMock(); });
  afterEach(() => { teardownFetchMock({ assertNoPendingInterceptors: false }); });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("https://example.com/api/teardown", { method: "POST", body: "not json" });
    const resp = await handleTeardown(req, mockEnv);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain("Invalid JSON");
  });

  it("returns 400 when project_name is missing", async () => {
    const req = new Request("https://example.com/api/teardown", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    const resp = await handleTeardown(req, mockEnv);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain("project_name");
  });

  it("streams teardown progress for valid request", async () => {
    mockBifrostWorkspaceLookup();
    mockRepoVariables("test-project", { POSTMAN_WORKSPACE_ID: "ws-123", RUNTIME_MODE: "lambda", POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG });
    mockLambdaHintLookups("test-project");
    mockEcsHintLookups("test-project");
    server.use(
      http.delete("https://api.getpostman.com/workspaces/ws-123", () =>
        HttpResponse.json({ workspace: { id: "ws-123" } }), { once: true }),
    );
    mockAwsTeardownWorkflowSuccess("test-project", 12345);
    server.use(
      http.delete("https://api.github.com/repos/postman-cs/test-project", () =>
        HttpResponse.json({}), { once: true }),
    );

    const req = new Request("https://example.com/api/teardown", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_name: "test-project" }),
    });
    const resp = await handleTeardown(req, mockEnv);
    expect(resp.headers.get("Content-Type")).toBe("text/event-stream");
    const events = await readAllSSEEvents(resp);

    expect(events.some(e => e.phase === "lookup" && e.status === "running")).toBe(true);
    expect(events.some(e => e.phase === "lookup" && e.status === "complete")).toBe(true);
    expect(events.some(e => e.phase === "insights" && e.status === "complete")).toBe(true);
    expect(events.some(e => e.phase === "postman" && e.status === "running")).toBe(true);
    expect(events.some(e => e.phase === "postman" && e.status === "complete")).toBe(true);
    expect(events.some(e => e.phase === "lambda" && e.status === "running")).toBe(true);
    expect(events.some(e => e.phase === "lambda" && e.status === "complete")).toBe(true);
    expect(events.some(e => e.phase === "iam" && e.status === "complete")).toBe(true);
    expect(events.some(e => e.phase === "github" && e.status === "running")).toBe(true);
    expect(events.some(e => e.phase === "github" && e.status === "complete")).toBe(true);
    const completeEvent = events.find(e => e.phase === "complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent.status).toBe("complete");
    expect(completeEvent.data.project).toBe("test-project");
    expect(completeEvent.data.results.postman).toBe("deleted");
    expect(completeEvent.data.results.lambda).toBe("deleted_or_not_found");
    expect(completeEvent.data.results.api_gateway).toBe("deleted_or_not_found");
    expect(completeEvent.data.results.iam).toBe("skipped");
    expect(completeEvent.data.results.github).toBe("deleted");
  });

  it("runs AWS teardown workflow when lambda hints exist", async () => {
    mockTeardownSecretProvisioning("aws-cleanup-proj", 2);
    mockRepoVariables("aws-cleanup-proj", { RUNTIME_MODE: "lambda", POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG });
    mockLambdaHintLookups("aws-cleanup-proj", { functionName: "aws-cleanup-proj-dev" });
    mockEcsHintLookups("aws-cleanup-proj");
    mockWorkflowRunCorrelation(
      "https://api.github.com/repos/postman-cs/aws-cleanup-proj/actions/workflows/worker-teardown.yml/runs",
      { id: 12345, status: "in_progress", conclusion: null, html_url: "https://github.com/postman-cs/aws-cleanup-proj/actions/runs/12345" },
    );
    server.use(
      http.get("https://api.github.com/repos/postman-cs/aws-cleanup-proj/contents/.github/workflows/worker-teardown.yml", () =>
        new HttpResponse("not found", { status: 404 }), { once: true }),
      http.put("https://api.github.com/repos/postman-cs/aws-cleanup-proj/contents/.github/workflows/worker-teardown.yml", () =>
        HttpResponse.json({ content: { path: ".github/workflows/worker-teardown.yml" } }, { status: 201 }), { once: true }),
      http.post("https://api.github.com/repos/postman-cs/aws-cleanup-proj/actions/workflows/worker-teardown.yml/dispatches", () =>
        HttpResponse.json({}), { once: true }),
      http.get("https://api.github.com/repos/postman-cs/aws-cleanup-proj/actions/runs/12345", () =>
        HttpResponse.json({ id: 12345, status: "completed", conclusion: "success", html_url: "https://github.com/postman-cs/aws-cleanup-proj/actions/runs/12345" }), { once: true }),
      http.get("https://api.github.com/repos/postman-cs/aws-cleanup-proj/actions/runs/12345/jobs", () =>
        HttpResponse.json({ jobs: [{ name: "teardown", status: "completed", conclusion: "success", steps: [{ name: "Delete Lambda Functions and API Gateways", status: "completed", conclusion: "success", number: 1 }] }] }), { once: true }),
      http.delete("https://api.github.com/repos/postman-cs/aws-cleanup-proj", () =>
        HttpResponse.json({}), { once: true }),
    );

    const req = new Request("https://example.com/api/teardown", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_name: "aws-cleanup-proj" }),
    });
    const resp = await handleTeardown(req, mockEnv as any);
    const events = await readAllSSEEvents(resp);
    expect(events.some(e => e.phase === "lambda" && e.status === "complete")).toBe(true);
    expect(events.some(e => e.phase === "github" && e.status === "complete")).toBe(true);
    const completeEvent = events.find(e => e.phase === "complete");
    expect(completeEvent.data.results.lambda).toBe("deleted_or_not_found");
    expect(completeEvent.data.results.github).toBe("deleted");
  });

  it("deletes insights service when insights variable exists", async () => {
    mockRepoVariables("insights-proj", {
      POSTMAN_WORKSPACE_ID: "ws-123", RUNTIME_MODE: "ecs_service",
      POSTMAN_INSIGHTS_PROJECT_ID: "svc_abc123def456ghi789jklm", POSTMAN_TEAM_ID: "132319",
      ECS_CLUSTER_NAME: "shared-ecs-cluster", ECS_SERVICE_NAME: "insights-proj-svc",
      ECS_TARGET_GROUP_ARN: "arn:aws:elasticloadbalancing:eu-west-2:123:targetgroup/tg/abc",
      ECS_LISTENER_RULE_ARN: "arn:aws:elasticloadbalancing:eu-west-2:123:listener-rule/app/alb/def",
      POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG,
    });
    mockLambdaHintLookups("insights-proj");
    mockAwsTeardownWorkflowSuccess("insights-proj", 444, "Delete ECS Service, Listener Rule, and Target Group");
    mockBifrostWorkspaceLookup();
    server.use(
      http.delete("https://api.getpostman.com/workspaces/ws-123", () =>
        HttpResponse.json({ workspace: { id: "ws-123" } }), { once: true }),
      http.delete("https://api.github.com/repos/postman-cs/insights-proj", () =>
        HttpResponse.json({}), { once: true }),
    );

    const req = new Request("https://example.com/api/teardown", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_name: "insights-proj" }),
    });
    const resp = await handleTeardown(req, mockEnv);
    const events = await readAllSSEEvents(resp);
    expect(events.some(e => e.phase === "insights" && e.status === "running")).toBe(true);
    expect(events.some(e => e.phase === "insights" && e.status === "complete")).toBe(true);
    const completeEvent = events.find(e => e.phase === "complete");
    expect(completeEvent.data.results.insights).toBe("deleted");
  });

  it("handles missing workspace gracefully in SSE stream", async () => {
    mockRepoVariables("test-project", { RUNTIME_MODE: "lambda", POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG });
    mockLambdaHintLookups("test-project");
    mockEcsHintLookups("test-project");
    server.use(
      http.delete("https://api.github.com/repos/postman-cs/test-project", () =>
        HttpResponse.json({}), { once: true }),
    );
    mockAwsTeardownWorkflowSuccess("test-project", 12346);

    const req = new Request("https://example.com/api/teardown", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_name: "test-project" }),
    });
    const resp = await handleTeardown(req, mockEnv);
    const events = await readAllSSEEvents(resp);
    const lookupComplete = events.find(e => e.phase === "lookup" && e.status === "complete");
    expect(lookupComplete.message).toContain("No workspace found");
    const postmanComplete = events.find(e => e.phase === "postman" && e.status === "complete");
    expect(postmanComplete.message).toContain("No workspace to delete");
    expect(events.some(e => e.phase === "github" && e.status === "complete")).toBe(true);
    const completeEvent = events.find(e => e.phase === "complete");
    expect(completeEvent.data.results.postman).toBeUndefined();
    expect(completeEvent.data.results.github).toBe("deleted");
  });

  it("normalizes k8s_roadmap runtime to k8s_workspace and dispatches kubernetes teardown inputs", async () => {
    let dispatchBody: Record<string, unknown> = {};
    mockTeardownSecretProvisioning("k8s-proj", 3);
    mockRepoVariables("k8s-proj", { RUNTIME_MODE: "k8s_roadmap", POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG });
    mockEcsHintLookups("k8s-proj");
    mockK8sHintLookups("k8s-proj", { namespace: TEST_K8S_NAMESPACE, deploymentName: "k8s-proj", serviceName: "k8s-proj", ingressName: "k8s-proj-ing" });
    mockLambdaHintLookups("k8s-proj");
    mockWorkflowRunCorrelation(
      "https://api.github.com/repos/postman-cs/k8s-proj/actions/workflows/worker-teardown.yml/runs",
      { id: 555, status: "in_progress", conclusion: null, html_url: "https://github.com/postman-cs/k8s-proj/actions/runs/555" },
    );
    server.use(
      http.get("https://api.github.com/repos/postman-cs/k8s-proj/contents/.github/workflows/worker-teardown.yml", () =>
        new HttpResponse("not found", { status: 404 }), { once: true }),
      http.put("https://api.github.com/repos/postman-cs/k8s-proj/contents/.github/workflows/worker-teardown.yml", () =>
        HttpResponse.json({ content: { path: ".github/workflows/worker-teardown.yml" } }, { status: 201 }), { once: true }),
      http.post("https://api.github.com/repos/postman-cs/k8s-proj/actions/workflows/worker-teardown.yml/dispatches", async ({ request }) => {
        dispatchBody = await request.json() as any;
        return HttpResponse.json({});
      }, { once: true }),
      http.get("https://api.github.com/repos/postman-cs/k8s-proj/actions/runs/555", () =>
        HttpResponse.json({ id: 555, status: "completed", conclusion: "success", html_url: "https://github.com/postman-cs/k8s-proj/actions/runs/555" }), { once: true }),
      http.get("https://api.github.com/repos/postman-cs/k8s-proj/actions/runs/555/jobs", () =>
        HttpResponse.json({ jobs: [{ name: "teardown", status: "completed", conclusion: "success", steps: [{ name: "Delete Kubernetes Workload Resources", status: "completed", conclusion: "success", number: 1 }] }] }), { once: true }),
      http.delete("https://api.github.com/repos/postman-cs/k8s-proj", () =>
        HttpResponse.json({}), { once: true }),
    );

    const req = new Request(`${TEST_WORKER_URL}/api/teardown`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_name: "k8s-proj" }),
    });
    const resp = await handleTeardown(req, mockEnv as any);
    const events = await readAllSSEEvents(resp);
    const dispatchInputs = ((dispatchBody.inputs || {}) as Record<string, string>);
    expect(dispatchInputs.runtime_mode).toBe("k8s_workspace");
    expect(dispatchInputs.k8s_namespace).toBe(TEST_K8S_NAMESPACE);
    expect(dispatchInputs.k8s_deployment_name).toBe("k8s-proj");
    expect(dispatchInputs.k8s_service_name).toBe("k8s-proj");
    expect(dispatchInputs.k8s_ingress_name).toBe("k8s-proj-ing");
    expect(events.some(e => e.phase === "lambda" && e.message?.includes("Deleting Kubernetes deployment"))).toBe(true);
    expect(events.some(e => e.phase === "iam" && e.message?.includes("cluster auth is managed separately"))).toBe(true);
  });
});

describe("handleBatchTeardown", () => {
  beforeEach(() => { setupFetchMock(); });
  afterEach(() => { teardownFetchMock({ assertNoPendingInterceptors: false }); });

  it("returns 400 when batch request has no projects", async () => {
    const req = new Request("https://example.com/api/teardown/batch", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [] }),
    });
    const resp = await handleBatchTeardown(req, mockEnv as any);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(String(body.error || "")).toContain("items or project_names");
  });

  it("streams multiplexed project events and batch completion summary", async () => {
    mockRepoVariables("batch-project", { RUNTIME_MODE: "lambda", POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG });
    mockLambdaHintLookups("batch-project");
    mockEcsHintLookups("batch-project");
    mockAwsTeardownWorkflowSuccess("batch-project", 4444);
    server.use(
      http.delete("https://api.github.com/repos/postman-cs/batch-project", () =>
        HttpResponse.json({}), { once: true }),
    );

    const req = new Request("https://example.com/api/teardown/batch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ spec_id: "spec-batch-project", project_name: "batch-project" }] }),
    });
    const resp = await handleBatchTeardown(req, mockEnv as any);
    const events = await readAllSSEEvents(resp);
    expect(events.some((event) => event.project === "batch-project")).toBe(true);
    expect(events.some((event) => event.project === "__batch__" && event.phase === "progress")).toBe(true);
    const completeEvent = events.find((event) => event.project === "__batch__" && event.phase === "complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent.data.total).toBe(1);
    expect(completeEvent.data.success).toBe(1);
    expect(completeEvent.data.failed).toBe(0);
    expect(completeEvent.data.results[0].project_name).toBe("batch-project");
    expect(completeEvent.data.results[0].spec_id).toBe("spec-batch-project");
  });

  it("emits a dense results array after early aborts without null holes", async () => {
    mockRepoVariables("first-project", { RUNTIME_MODE: "lambda", POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG });
    mockRepoVariables("second-project", { RUNTIME_MODE: "lambda", POSTMAN_TEAM_SLUG: "missing-team" });
    mockRepoVariables("third-project", { RUNTIME_MODE: "lambda", POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG });
    mockRepoVariables("fourth-project", { RUNTIME_MODE: "lambda", POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG });

    mockLambdaHintLookups("first-project");
    mockLambdaHintLookups("second-project");
    mockLambdaHintLookups("third-project");
    mockEcsHintLookups("first-project");
    mockEcsHintLookups("second-project");
    mockEcsHintLookups("third-project");

    mockAwsTeardownWorkflowSuccess("first-project", 5555);
    mockAwsTeardownWorkflowSuccess("third-project", 6666);
    server.use(
      http.delete("https://api.github.com/repos/postman-cs/first-project", () =>
        HttpResponse.json({}), { once: true }),
      http.delete("https://api.github.com/repos/postman-cs/third-project", () =>
        HttpResponse.json({}), { once: true }),
    );

    const req = new Request("https://example.com/api/teardown/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          { spec_id: "spec-first-project", project_name: "first-project" },
          { spec_id: "spec-second-project", project_name: "second-project" },
          { spec_id: "spec-third-project", project_name: "third-project" },
          { spec_id: "spec-fourth-project", project_name: "fourth-project" },
        ],
      }),
    });

    const resp = await handleBatchTeardown(req, mockEnv as any);
    const events = await readAllSSEEvents(resp);
    const completeEvent = events.find((event) => event.project === "__batch__" && event.phase === "complete");
    expect(completeEvent).toBeDefined();
    expect(Array.isArray(completeEvent.data.results)).toBe(true);
    expect(completeEvent.data.results.every((result: unknown) => result !== null)).toBe(true);
  });

  it("uses repo POSTMAN_TEAM_SLUG when team credentials come from env without TEAM_REGISTRY", async () => {
    const envWithoutRegistry = {
      ...mockEnv,
      TEAM_REGISTRY: undefined,
      POSTMAN_TEAM__FIELD_SERVICES_V12_DEMO__API_KEY: "test-key",
      POSTMAN_TEAM__FIELD_SERVICES_V12_DEMO__ACCESS_TOKEN: "test-token",
      POSTMAN_TEAM__FIELD_SERVICES_V12_DEMO__TEAM_ID: "13347347",
    } as unknown as ProvisioningEnv;

    mockRepoVariables("env-only-batch-project", { RUNTIME_MODE: "lambda", POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG });
    mockLambdaHintLookups("env-only-batch-project");
    mockEcsHintLookups("env-only-batch-project");
    mockAwsTeardownWorkflowSuccess("env-only-batch-project", 7777);
    server.use(
      http.delete("https://api.github.com/repos/postman-cs/env-only-batch-project", () =>
        HttpResponse.json({}), { once: true }),
    );

    const req = new Request("https://example.com/api/teardown/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ spec_id: "spec-env-only-batch-project", project_name: "env-only-batch-project" }],
      }),
    });

    const resp = await handleBatchTeardown(req, envWithoutRegistry as any);
    const events = await readAllSSEEvents(resp);
    const completeEvent = events.find((event) => event.project === "__batch__" && event.phase === "complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent.data.success).toBe(1);
    expect(completeEvent.data.failed).toBe(0);
    expect(completeEvent.data.results[0].success).toBe(true);
    expect(events.some((event) => event.project === "env-only-batch-project" && event.phase === "error")).toBe(false);
  });
});

describe("handleStatus", () => {
  beforeEach(() => { setupFetchMock(); });
  afterEach(() => { teardownFetchMock({ assertNoPendingInterceptors: false }); });

  it("returns 400 when project param is missing", async () => {
    const req = new Request("https://example.com/api/status");
    const resp = await handleStatus(req, mockEnv);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain("project");
  });

  it("returns resources for existing project", async () => {
    server.use(
      http.get("https://api.github.com/repos/postman-cs/test-project", () =>
        HttpResponse.json({ full_name: "postman-cs/test-project" }), { once: true }),
    );
    mockRepoVariables("test-project", {
      POSTMAN_WORKSPACE_ID: "ws-123", RUNTIME_MODE: "lambda",
      FUNCTION_NAME: "test-project-dev", DEV_GW_URL: "https://abc.execute-api.us-east-1.amazonaws.com/",
      POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG,
    });

    const req = new Request("https://example.com/api/status?project=test-project");
    const resp = await handleStatus(req, mockEnv);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.active_project).toBe("test-project");
    expect(body.resources.github).toBe(true);
    expect(body.resources.postman).toBe(1);
    expect(body.resources.lambda).toBe(true);
    expect(body.resources.api_gateway).toBe(true);
    expect(body.runtime.mode).toBe("lambda");
    expect(body.runtime.ownership).toBe("dedicated_lambda");
    expect(body.runtime.cleanup).toBe("external_teardown_workflow");
    expect(body.source).toBe("live");
  });

  it("returns null active_project when repo not found", async () => {
    server.use(
      http.get("https://api.github.com/repos/postman-cs/test-project", () =>
        new HttpResponse("not found", { status: 404 }), { once: true }),
    );
    const req = new Request("https://example.com/api/status?project=test-project");
    const resp = await handleStatus(req, mockEnv);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.active_project).toBeNull();
  });

  it("returns resources without postman when workspace var missing", async () => {
    server.use(
      http.get("https://api.github.com/repos/postman-cs/no-ws", () =>
        HttpResponse.json({ full_name: "postman-cs/no-ws" }), { once: true }),
    );
    mockRepoVariables("no-ws", {
      RUNTIME_MODE: "lambda", FUNCTION_NAME: "no-ws-dev",
      DEV_GW_URL: "https://abc.execute-api.us-east-1.amazonaws.com/", POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG,
    });
    const req = new Request("https://example.com/api/status?project=no-ws");
    const resp = await handleStatus(req, mockEnv);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.active_project).toBe("no-ws");
    expect(body.resources.github).toBe(true);
    expect(body.resources.postman).toBeUndefined();
    expect(body.resources.lambda).toBe(true);
    expect(body.resources.api_gateway).toBe(true);
  });

  it("reports shared runtime resources for ecs_service projects", async () => {
    server.use(
      http.get("https://api.github.com/repos/postman-cs/shared-runtime-proj", () =>
        HttpResponse.json({ full_name: "postman-cs/shared-runtime-proj" }), { once: true }),
    );
    mockRepoVariables("shared-runtime-proj", {
      POSTMAN_WORKSPACE_ID: "ws-123", RUNTIME_MODE: "ecs_service",
      RUNTIME_BASE_URL: `${TEST_WORKER_URL}/services/shared-runtime-proj`, POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG,
    });
    const req = new Request("https://example.com/api/status?project=shared-runtime-proj");
    const resp = await handleStatus(req, mockEnv);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.resources.ecs_service).toBe(true);
    expect(body.runtime.mode).toBe("ecs_service");
    expect(body.runtime.ownership).toBe("dedicated_service_shared_infra");
    expect(body.runtime.cleanup).toBe("external_teardown_workflow");
    expect(body.resources.runtime_assignment).toBe(true);
    expect(body.resources.lambda).toBeUndefined();
    expect(body.resources.api_gateway).toBeUndefined();
  });

  it("normalizes k8s_roadmap runtime to k8s_workspace status semantics", async () => {
    server.use(
      http.get("https://api.github.com/repos/postman-cs/k8s-status-proj", () =>
        HttpResponse.json({ full_name: "postman-cs/k8s-status-proj" }), { once: true }),
    );
    mockRepoVariables("k8s-status-proj", {
      POSTMAN_WORKSPACE_ID: "ws-123", RUNTIME_MODE: "k8s_roadmap",
      RUNTIME_BASE_URL: `${TEST_WORKER_URL}/svc/k8s-status-proj`,
      K8S_DEPLOYMENT_NAME: "k8s-status-proj", K8S_SERVICE_NAME: "k8s-status-proj",
      POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG,
    });
    const req = new Request("https://example.com/api/status?project=k8s-status-proj");
    const resp = await handleStatus(req, mockEnv);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.runtime.mode).toBe("k8s_workspace");
    expect(body.runtime.ownership).toBe("dedicated_kubernetes_shared_cluster");
    expect(body.resources.ecs_service).toBeUndefined();
    expect(body.resources.runtime_assignment).toBe(true);
    expect(body.resources.k8s_deployment).toBe(true);
    expect(body.resources.k8s_service).toBe(true);
    expect(body.resources.lambda).toBeUndefined();
    expect(body.resources.api_gateway).toBeUndefined();
  });

  it("handles repo check returning non-ok status", async () => {
    server.use(
      http.get("https://api.github.com/repos/postman-cs/forbidden-proj", () =>
        HttpResponse.json({ message: "forbidden" }, { status: 403 }), { once: true }),
    );
    const req = new Request("https://example.com/api/status?project=forbidden-proj");
    const resp = await handleStatus(req, mockEnv);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.active_project).toBeNull();
    expect(body.resources).toEqual({});
  });
});

describe("handleTeardown error branches", () => {
  beforeEach(() => { setupFetchMock(); });
  afterEach(() => { teardownFetchMock({ assertNoPendingInterceptors: false }); });

  it("handles Postman workspace delete and continues stream", async () => {
    mockBifrostWorkspaceLookup();
    mockRepoVariables("err-proj", { POSTMAN_WORKSPACE_ID: "ws-err", RUNTIME_MODE: "lambda", POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG });
    mockLambdaHintLookups("err-proj");
    mockEcsHintLookups("err-proj");
    server.use(
      http.delete("https://api.getpostman.com/workspaces/ws-err", () =>
        new HttpResponse("ok", { status: 200 }), { once: true }),
    );
    mockAwsTeardownWorkflowSuccess("err-proj", 12347);
    server.use(
      http.delete("https://api.github.com/repos/postman-cs/err-proj", () =>
        HttpResponse.json({}), { once: true }),
    );

    const req = new Request("https://example.com/api/teardown", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_name: "err-proj" }),
    });
    const resp = await handleTeardown(req, mockEnv);
    const events = await readAllSSEEvents(resp);
    const completeEvent = events.find(e => e.phase === "complete");
    expect(completeEvent.data.results.postman).toBe("deleted");
    expect(completeEvent.data.results.github).toBe("deleted");
  });

  it("fails teardown when GitHub repo delete returns an error", async () => {
    mockRepoVariables("gh-err", { RUNTIME_MODE: "lambda", POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG });
    mockLambdaHintLookups("gh-err");
    mockEcsHintLookups("gh-err");
    mockAwsTeardownWorkflowSuccess("gh-err", 12348);
    server.use(
      http.delete("https://api.github.com/repos/postman-cs/gh-err", () =>
        HttpResponse.json({ message: "forbidden" }, { status: 403 }), { once: true }),
    );

    const req = new Request("https://example.com/api/teardown", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_name: "gh-err" }),
    });
    const resp = await handleTeardown(req, mockEnv);
    const events = await readAllSSEEvents(resp);
    expect(events.some(e => e.phase === "github" && e.status === "error")).toBe(true);
    expect(events.some(e => e.phase === "complete")).toBe(false);
    const errorEvent = events.find(e => e.phase === "error");
    expect(errorEvent).toBeDefined();
    expect(String(errorEvent.message || "")).toContain("repository cleanup failed");
  });

  it("aborts before repository deletion when AWS cleanup workflow fails", async () => {
    mockTeardownSecretProvisioning("aws-fail-proj", 2);
    mockRepoVariables("aws-fail-proj", { RUNTIME_MODE: "lambda", POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG });
    mockLambdaHintLookups("aws-fail-proj", { functionName: "aws-fail-proj-dev" });
    mockEcsHintLookups("aws-fail-proj");
    const runsUrl = "https://api.github.com/repos/postman-cs/aws-fail-proj/actions/workflows/worker-teardown.yml/runs";
    mockWorkflowRunCorrelation(runsUrl, {
      id: 777,
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/postman-cs/aws-fail-proj/actions/runs/777",
    });
    server.use(
      http.get("https://api.github.com/repos/postman-cs/aws-fail-proj/contents/.github/workflows/worker-teardown.yml", () =>
        new HttpResponse("not found", { status: 404 }), { once: true }),
      http.put("https://api.github.com/repos/postman-cs/aws-fail-proj/contents/.github/workflows/worker-teardown.yml", () =>
        HttpResponse.json({ content: { path: ".github/workflows/worker-teardown.yml" } }, { status: 201 }), { once: true }),
      http.post("https://api.github.com/repos/postman-cs/aws-fail-proj/actions/workflows/worker-teardown.yml/dispatches", () =>
        HttpResponse.json({}), { once: true }),
      http.get("https://api.github.com/repos/postman-cs/aws-fail-proj/actions/runs/777", () =>
        HttpResponse.json({ id: 777, status: "completed", conclusion: "failure", html_url: "https://github.com/postman-cs/aws-fail-proj/actions/runs/777" }), { once: true }),
      http.get("https://api.github.com/repos/postman-cs/aws-fail-proj/actions/runs/777/jobs", () =>
        HttpResponse.json({ jobs: [{ name: "teardown", status: "completed", conclusion: "failure", steps: [{ name: "Delete Lambda Functions and API Gateways", status: "completed", conclusion: "failure", number: 1 }] }] }), { once: true }),
    );

    const req = new Request("https://example.com/api/teardown", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_name: "aws-fail-proj" }),
    });
    const resp = await handleTeardown(req, mockEnv as any);
    const events = await readAllSSEEvents(resp);
    expect(events.some(e => e.phase === "lambda" && e.status === "error")).toBe(true);
    expect(events.some(e => e.phase === "github" && e.status === "running")).toBe(false);
    expect(events.some(e => e.phase === "complete")).toBe(false);
    const errorEvent = events.find(e => e.phase === "error");
    expect(errorEvent).toBeDefined();
    expect(String(errorEvent.message)).toContain("Aborting teardown");
  });
});

describe("runAwsCleanupWorkflow regression guards", () => {
  beforeEach(() => { setupFetchMock(); });
  afterEach(() => { teardownFetchMock({ assertNoPendingInterceptors: false }); });

  it("dispatches lambda teardown with lambda runtime mode and lambda cleanup workflow section", async () => {
    let dispatchBody: Record<string, unknown> = {};
    let workflowPutBody: Record<string, unknown> = {};
    mockTeardownSecretProvisioning("lambda-dispatch-proj", 2);
    const runsUrl = "https://api.github.com/repos/postman-cs/lambda-dispatch-proj/actions/workflows/worker-teardown.yml/runs";
    mockWorkflowRunCorrelation(runsUrl, {
      id: 9001,
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/postman-cs/lambda-dispatch-proj/actions/runs/9001",
    });
    server.use(
      http.get("https://api.github.com/repos/postman-cs/lambda-dispatch-proj/contents/.github/workflows/worker-teardown.yml", () =>
        new HttpResponse("not found", { status: 404 }), { once: true }),
      http.put("https://api.github.com/repos/postman-cs/lambda-dispatch-proj/contents/.github/workflows/worker-teardown.yml", async ({ request }) => {
        workflowPutBody = await request.json() as any;
        return HttpResponse.json({ content: { path: ".github/workflows/worker-teardown.yml" } }, { status: 201 });
      }, { once: true }),
      http.post("https://api.github.com/repos/postman-cs/lambda-dispatch-proj/actions/workflows/worker-teardown.yml/dispatches", async ({ request }) => {
        dispatchBody = await request.json() as any;
        return HttpResponse.json({});
      }, { once: true }),
      http.get("https://api.github.com/repos/postman-cs/lambda-dispatch-proj/actions/runs/9001", () =>
        HttpResponse.json({ id: 9001, status: "completed", conclusion: "success", html_url: "https://github.com/postman-cs/lambda-dispatch-proj/actions/runs/9001" }), { once: true }),
      http.get("https://api.github.com/repos/postman-cs/lambda-dispatch-proj/actions/runs/9001/jobs", () =>
        HttpResponse.json({ jobs: [{ name: "teardown", status: "completed", conclusion: "success", steps: [{ name: "Delete Lambda Functions and API Gateways", status: "completed", conclusion: "success", number: 1 }] }] }), { once: true }),
    );

    await runAwsCleanupWorkflow("lambda-dispatch-proj", "lambda-dispatch-proj", "lambda", mockEnv as any, "test-gh");
    const dispatchInputs = (dispatchBody.inputs || {}) as Record<string, string>;
    expect(dispatchInputs.runtime_mode).toBe("lambda");
    expect(dispatchInputs.project_name).toBe("lambda-dispatch-proj");
    const encodedWorkflow = String(workflowPutBody.content || "");
    const workflowText = Buffer.from(encodedWorkflow, "base64").toString("utf8");
    expect(workflowText).toContain("Delete Lambda Functions and API Gateways");
    expect(workflowText).toContain("if: ${{ github.event.inputs.runtime_mode == 'lambda' }}");
  });

  it("dispatches ecs teardown with ecs_service runtime mode and ecs cleanup workflow section", async () => {
    let dispatchBody: Record<string, unknown> = {};
    let workflowPutBody: Record<string, unknown> = {};
    mockTeardownSecretProvisioning("ecs-dispatch-proj", 2);
    const runsUrl = "https://api.github.com/repos/postman-cs/ecs-dispatch-proj/actions/workflows/worker-teardown.yml/runs";
    mockWorkflowRunCorrelation(runsUrl, {
      id: 9002,
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/postman-cs/ecs-dispatch-proj/actions/runs/9002",
    });
    server.use(
      http.get("https://api.github.com/repos/postman-cs/ecs-dispatch-proj/contents/.github/workflows/worker-teardown.yml", () =>
        new HttpResponse("not found", { status: 404 }), { once: true }),
      http.put("https://api.github.com/repos/postman-cs/ecs-dispatch-proj/contents/.github/workflows/worker-teardown.yml", async ({ request }) => {
        workflowPutBody = await request.json() as any;
        return HttpResponse.json({ content: { path: ".github/workflows/worker-teardown.yml" } }, { status: 201 });
      }, { once: true }),
      http.post("https://api.github.com/repos/postman-cs/ecs-dispatch-proj/actions/workflows/worker-teardown.yml/dispatches", async ({ request }) => {
        dispatchBody = await request.json() as any;
        return HttpResponse.json({});
      }, { once: true }),
      http.get("https://api.github.com/repos/postman-cs/ecs-dispatch-proj/actions/runs/9002", () =>
        HttpResponse.json({ id: 9002, status: "completed", conclusion: "success", html_url: "https://github.com/postman-cs/ecs-dispatch-proj/actions/runs/9002" }), { once: true }),
      http.get("https://api.github.com/repos/postman-cs/ecs-dispatch-proj/actions/runs/9002/jobs", () =>
        HttpResponse.json({ jobs: [{ name: "teardown", status: "completed", conclusion: "success", steps: [{ name: "Delete ECS Service, Listener Rule, and Target Group", status: "completed", conclusion: "success", number: 1 }] }] }), { once: true }),
    );

    await runAwsCleanupWorkflow("ecs-dispatch-proj", "ecs-dispatch-proj", "ecs_service", mockEnv as any, "test-gh", {
      ecs_cluster_name: "shared-ecs-cluster", ecs_service_name: "ecs-dispatch-proj-svc",
      ecs_target_group_arn: "arn:aws:elasticloadbalancing:eu-west-2:123:targetgroup/tg/abc",
      ecs_listener_rule_arn: "arn:aws:elasticloadbalancing:eu-west-2:123:listener-rule/app/alb/def",
    });
    const dispatchInputs = (dispatchBody.inputs || {}) as Record<string, string>;
    expect(dispatchInputs.runtime_mode).toBe("ecs_service");
    expect(dispatchInputs.ecs_cluster_name).toBe("shared-ecs-cluster");
    expect(dispatchInputs.ecs_service_name).toBe("ecs-dispatch-proj-svc");
    expect(dispatchInputs.ecs_target_group_arn).toContain(":targetgroup/");
    expect(dispatchInputs.ecs_listener_rule_arn).toContain(":listener-rule/");
    const encodedWorkflow = String(workflowPutBody.content || "");
    const workflowText = Buffer.from(encodedWorkflow, "base64").toString("utf8");
    expect(workflowText).toContain("Delete ECS Service, Listener Rule, and Target Group");
    expect(workflowText).toContain("if: ${{ github.event.inputs.runtime_mode == 'ecs_service' }}");
  });

  it("dispatches kubernetes teardown with k8s_discovery mode and workload-only cleanup section", async () => {
    let dispatchBody: Record<string, unknown> = {};
    let workflowPutBody: Record<string, unknown> = {};
    mockTeardownSecretProvisioning("k8s-discovery-dispatch-proj", 3);
    const runsUrl = "https://api.github.com/repos/postman-cs/k8s-discovery-dispatch-proj/actions/workflows/worker-teardown.yml/runs";
    mockWorkflowRunCorrelation(runsUrl, {
      id: 9003,
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/postman-cs/k8s-discovery-dispatch-proj/actions/runs/9003",
    });
    server.use(
      http.get("https://api.github.com/repos/postman-cs/k8s-discovery-dispatch-proj/contents/.github/workflows/worker-teardown.yml", () =>
        new HttpResponse("not found", { status: 404 }), { once: true }),
      http.put("https://api.github.com/repos/postman-cs/k8s-discovery-dispatch-proj/contents/.github/workflows/worker-teardown.yml", async ({ request }) => {
        workflowPutBody = await request.json() as any;
        return HttpResponse.json({ content: { path: ".github/workflows/worker-teardown.yml" } }, { status: 201 });
      }, { once: true }),
      http.post("https://api.github.com/repos/postman-cs/k8s-discovery-dispatch-proj/actions/workflows/worker-teardown.yml/dispatches", async ({ request }) => {
        dispatchBody = await request.json() as any;
        return HttpResponse.json({});
      }, { once: true }),
      http.get("https://api.github.com/repos/postman-cs/k8s-discovery-dispatch-proj/actions/runs/9003", () =>
        HttpResponse.json({ id: 9003, status: "completed", conclusion: "success", html_url: "https://github.com/postman-cs/k8s-discovery-dispatch-proj/actions/runs/9003" }), { once: true }),
      http.get("https://api.github.com/repos/postman-cs/k8s-discovery-dispatch-proj/actions/runs/9003/jobs", () =>
        HttpResponse.json({ jobs: [{ name: "teardown", status: "completed", conclusion: "success", steps: [{ name: "Delete Kubernetes Workload Resources", status: "completed", conclusion: "success", number: 1 }] }] }), { once: true }),
    );

    await runAwsCleanupWorkflow("k8s-discovery-dispatch-proj", "k8s-discovery-dispatch-proj", "k8s_discovery", mockEnv as any, "test-gh", {
      k8s_namespace: TEST_K8S_NAMESPACE, k8s_deployment_name: "k8s-discovery-dispatch-proj",
      k8s_service_name: "k8s-discovery-dispatch-proj", k8s_ingress_name: "k8s-discovery-dispatch-proj-ing",
    });
    const dispatchInputs = (dispatchBody.inputs || {}) as Record<string, string>;
    expect(dispatchInputs.runtime_mode).toBe("k8s_discovery");
    expect(dispatchInputs.k8s_namespace).toBe(TEST_K8S_NAMESPACE);
    expect(dispatchInputs.k8s_deployment_name).toBe("k8s-discovery-dispatch-proj");
    expect(dispatchInputs.k8s_service_name).toBe("k8s-discovery-dispatch-proj");
    expect(dispatchInputs.k8s_ingress_name).toBe("k8s-discovery-dispatch-proj-ing");
    const encodedWorkflow = String(workflowPutBody.content || "");
    const workflowText = Buffer.from(encodedWorkflow, "base64").toString("utf8");
    expect(workflowText).toContain("Delete Kubernetes Workload Resources");
    expect(workflowText).toContain("if: ${{ contains('k8s_workspace,k8s_discovery', github.event.inputs.runtime_mode) }}");
    expect(workflowText).not.toContain("kubectl delete daemonset");
  });
});
