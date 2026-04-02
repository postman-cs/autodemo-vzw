import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { handleTeardown } from "../src/lib/teardown";
import { ORG, setGitHubOrg } from "../src/lib/github";
import { server, setupFetchMock, teardownFetchMock } from "./helpers/fetch-mock";
import { makeTeamRegistryKV, TEST_TEAM_SLUG } from "./helpers/team-registry";

vi.mock("../src/lib/sleep", () => ({
  sleep: () => Promise.resolve(),
}));

const baseEnv = {
  POSTMAN_API_KEY: "test-key",
  POSTMAN_ACCESS_TOKEN: "test-token",
  GH_TOKEN: "test-gh",
  AWS_ACCESS_KEY_ID: "test-aws-key",
  AWS_SECRET_ACCESS_KEY: "test-aws-secret",
  TEAM_REGISTRY: makeTeamRegistryKV(),
};

async function readAllSSEEvents(resp: Response): Promise<any[]> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: any[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      if (!chunk.startsWith("data: ")) continue;
      events.push(JSON.parse(chunk.slice(6)));
    }
  }
  return events;
}

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
      if (status !== 200) return new HttpResponse("not found", { status });
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

function mockTeardownSecretProvisioning(repoName: string, count = 2): void {
  for (let i = 0; i < count; i += 1) {
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

describe("multi-env teardown", () => {
  beforeEach(() => {
    setGitHubOrg("postman-cs");
    repoVariableMocks.clear();
    setupFetchMock();
  });

  afterEach(() => {
    teardownFetchMock({
      assertNoPendingInterceptors: false,
      onFinally: () => { setGitHubOrg(ORG); },
    });
  });

  afterAll(() => server.close());

  it("forwards env resource metadata into teardown workflow dispatch for ecs_service", async () => {
    const repoName = "multi-ecs-teardown";
    let dispatchBody: Record<string, unknown> = {};

    mockRepoVariables(repoName, {
      RUNTIME_MODE: "ecs_service",
      ECS_CLUSTER_NAME: "vzw-partner-demo-cluster",
      ENV_RESOURCE_NAMES_JSON: JSON.stringify({ prod: "multi-ecs-teardown-svc-prod", stage: "multi-ecs-teardown-svc-stage" }),
      ENVIRONMENT_DEPLOYMENTS_JSON: JSON.stringify([
        { environment: "prod", postman_env_uid: "env-prod" },
        { environment: "stage", postman_env_uid: "env-stage" },
      ]),
      POSTMAN_TEAM_SLUG: TEST_TEAM_SLUG,
    });

    mockTeardownSecretProvisioning(repoName, 2);
    mockWorkflowRunCorrelation(
      `https://api.github.com/repos/postman-cs/${repoName}/actions/workflows/worker-teardown.yml/runs`,
      { id: 7001, status: "in_progress", conclusion: null, html_url: "https://github.com/run/7001" },
    );
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${repoName}`, () =>
        HttpResponse.json({ full_name: `postman-cs/${repoName}` }), { once: true }),
      http.get(`https://api.github.com/repos/postman-cs/${repoName}/contents/.github/workflows/worker-teardown.yml`, () =>
        new HttpResponse("not found", { status: 404 }), { once: true }),
      http.put(`https://api.github.com/repos/postman-cs/${repoName}/contents/.github/workflows/worker-teardown.yml`, () =>
        HttpResponse.json({ content: { path: ".github/workflows/worker-teardown.yml" } }, { status: 201 }), { once: true }),
      http.post(`https://api.github.com/repos/postman-cs/${repoName}/actions/workflows/worker-teardown.yml/dispatches`, async ({ request }) => {
        dispatchBody = await request.json() as any;
        return HttpResponse.json({});
      }, { once: true }),
      http.get(`https://api.github.com/repos/postman-cs/${repoName}/actions/runs/7001`, () =>
        HttpResponse.json({ id: 7001, status: "completed", conclusion: "success", html_url: "https://github.com/run/7001" }), { once: true }),
      http.get(`https://api.github.com/repos/postman-cs/${repoName}/actions/runs/7001/jobs`, () =>
        HttpResponse.json({ jobs: [{ name: "teardown", status: "completed", conclusion: "success", steps: [{ name: "Delete ECS Service, Listener Rule, and Target Group", status: "completed", conclusion: "success", number: 1 }] }] }), { once: true }),
      http.delete(`https://api.github.com/repos/postman-cs/${repoName}`, () =>
        HttpResponse.json({}), { once: true }),
    );

    const req = new Request("https://example.com/api/teardown", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: repoName }),
    });
    const resp = await handleTeardown(req, baseEnv as any);
    const events = await readAllSSEEvents(resp);
    const dispatchInputs = ((dispatchBody.inputs || {}) as Record<string, string>);
    expect(dispatchInputs.env_resource_names_json).toContain("multi-ecs-teardown-svc-prod");
    expect(dispatchInputs.environment_deployments_json).toContain('"environment":"prod"');
    expect(events.some((event) => event.phase === "complete" && event.status === "complete")).toBe(true);
  });

  it("uses Airtable environment_deployments UIDs for system-env disassociation fallback", async () => {
    const repoName = "multi-airtable-fallback";
    const associationsPutBodies: Array<Record<string, unknown>> = [];

    mockMissingRepoVariables(repoName);
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${repoName}`, () =>
        new HttpResponse("not found", { status: 404 })),
      http.delete(`https://api.github.com/repos/postman-cs/${repoName}`, () =>
        new HttpResponse("not found", { status: 404 })),
      // Airtable Deployments GET (persist)
      http.get(new RegExp("https://api\\.airtable\\.com/v0/base-test/Deployments.*"), () =>
        HttpResponse.json({
          records: [{
            id: "rec-fallback",
            fields: {
              spec_id: repoName, status: "active", workspace_id: "ws-fallback",
              runtime_mode: "lambda", postman_team_slug: TEST_TEAM_SLUG,
              environment_deployments: JSON.stringify([
                { environment: "prod", postman_env_uid: "env-prod" },
                { environment: "stage", postman_env_uid: "env-stage" },
              ]),
            },
          }],
        })),
      // Airtable Deployments PATCH (persist)
      http.patch(new RegExp("https://api\\.airtable\\.com/v0/base-test/Deployments/rec-fallback"), () =>
        HttpResponse.json({ id: "rec-fallback", fields: { status: "deprovisioned" } })),
      // Bifrost (persist) - handles all proxy calls dynamically
      http.post("https://bifrost-premium-https-v4.gw.postman.com/ws/proxy", async ({ request }) => {
        const payload = await request.json() as Record<string, unknown>;
        const method = String(payload.method || "").toLowerCase();
        const path = String(payload.path || "");
        const systemEnvironmentId = String(((payload.query || {}) as Record<string, unknown>).systemEnvironmentId || "");
        if (method === "get" && path === "/api/system-envs") {
          return HttpResponse.json({ data: [{ id: "sys-prod", name: "Production" }, { id: "sys-stage", name: "Stage" }, { id: "sys-other", name: "Other" }] });
        }
        if (method === "get" && path === "/api/system-envs/associations" && systemEnvironmentId === "sys-prod") {
          return HttpResponse.json({ data: { systemEnvironmentId: "sys-prod", workspaces: [{ workspaceId: "ws-fallback", associations: [{ systemEnvironmentId: "sys-prod", postmanEnvironmentId: "env-prod", workspaceId: "ws-fallback" }] }] } });
        }
        if (method === "get" && path === "/api/system-envs/associations" && systemEnvironmentId === "sys-stage") {
          return HttpResponse.json({ data: { systemEnvironmentId: "sys-stage", workspaces: [{ workspaceId: "ws-fallback", associations: [{ systemEnvironmentId: "sys-stage", postmanEnvironmentId: "env-stage", workspaceId: "ws-fallback" }] }] } });
        }
        if (method === "get" && path === "/api/system-envs/associations" && systemEnvironmentId === "sys-other") {
          return HttpResponse.json({ data: { systemEnvironmentId: "sys-other", workspaces: [{ workspaceId: "other-ws", associations: [{ systemEnvironmentId: "sys-other", postmanEnvironmentId: "env-other", workspaceId: "other-ws" }] }] } });
        }
        if (method === "put" && path === "/api/system-envs/associations") {
          associationsPutBodies.push(payload);
          return HttpResponse.json({ data: { success: true, data: [], count: 0 } });
        }
        return HttpResponse.json({ data: { data: [] } });
      }),
      // Postman workspace delete (once)
      http.delete("https://api.getpostman.com/workspaces/ws-fallback", () =>
        HttpResponse.json({ workspace: { id: "ws-fallback" } })),
    );

    const req = new Request("https://example.com/api/teardown", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: repoName }),
    });
    const resp = await handleTeardown(req, { ...baseEnv, AIRTABLE_API_KEY: "airtable-key", AIRTABLE_BASE_ID: "base-test" } as any);
    const events = await readAllSSEEvents(resp);

    expect(events.some((event) => event.phase === "postman" && event.status === "complete")).toBe(true);
    expect(associationsPutBodies).toHaveLength(2);
    expect(associationsPutBodies.map((body) => ((body.body || {}) as Record<string, unknown>).systemEnvironmentId)).toEqual(["sys-prod", "sys-stage"]);
    expect((((associationsPutBodies[0]?.body || {}) as Record<string, unknown>).workspaceEntries || [])).toEqual([]);
    expect((((associationsPutBodies[1]?.body || {}) as Record<string, unknown>).workspaceEntries || [])).toEqual([]);
  });
});
