import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import {
  handleInfraSetup,
  handleInfraTeardown,
  handleK8sDiscoveryInfraSetup,
  handleK8sDiscoveryInfraTeardown,
} from "../src/lib/infra";
import { ORG, setGitHubOrg } from "../src/lib/github";
import { server, setupFetchMock, teardownFetchMock } from "./helpers/fetch-mock";
import { TEST_GITHUB_ORG, TEST_ADMIN_REPO } from "./helpers/constants";
import { makeTeamRegistryKV, TEST_TEAM_SLUG } from "./helpers/team-registry";

vi.mock("../src/lib/sleep", () => ({
  sleep: () => Promise.resolve(),
}));

const mockEnv = {
  GH_TOKEN: "test-gh-token",
  AIRTABLE_API_KEY: "airtable-key",
  AIRTABLE_BASE_ID: "base-test",
  POSTMAN_API_KEY: "default-team-api-key",
  POSTMAN_ACCESS_TOKEN: "default-team-access-token",
  POSTMAN_TEAM_ID: "13347347",
  TEAM_REGISTRY: makeTeamRegistryKV(),
};

async function readAllSSEEvents(resp: Response): Promise<Array<Record<string, unknown>>> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<Record<string, unknown>> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      if (!part.startsWith("data: ")) continue;
      events.push(JSON.parse(part.slice(6)) as Record<string, unknown>);
    }
  }

  return events;
}

beforeEach(() => {
  setupFetchMock();
  setGitHubOrg("postman-cs");
});

afterEach(() => {
  teardownFetchMock({
    onFinally: () => {
      setGitHubOrg(ORG);
    },
  });
});

afterAll(() => server.close());

describe("infra handlers", () => {
  it("returns setup no-op SSE when infra record is already active", async () => {
    server.use(
      http.get(new RegExp("https://api\\.airtable\\.com/v0/base-test/Infrastructure.*"), () =>
        HttpResponse.json({
          records: [{ id: "rec_infra", fields: { component: "ecs_shared", status: "active" } }],
        }), { once: true }),
    );

    const req = new Request("https://example.com/api/infra/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const resp = await handleInfraSetup(req, mockEnv as any);

    expect(resp.headers.get("Content-Type")).toBe("text/event-stream");
    const events = await readAllSSEEvents(resp);
    const done = events.find((event) => event.phase === "infra_setup" && event.status === "complete");

    expect(done).toBeDefined();
    expect((done?.data as Record<string, unknown>).no_op).toBe(true);
  });

  it("streams setup SSE when no active infra exists", async () => {
    server.use(
      http.get(new RegExp("https://api\\.airtable\\.com/v0/base-test/Infrastructure.*"), () =>
        HttpResponse.json({ records: [] }), { once: true }),
      // First poll: no runs yet
      http.get(`https://api.github.com/repos/${TEST_GITHUB_ORG}/${TEST_ADMIN_REPO}/actions/workflows/ecs-infra-setup.yml/runs`, () =>
        HttpResponse.json({ total_count: 0, workflow_runs: [] }), { once: true }),
      http.post(`https://api.github.com/repos/${TEST_GITHUB_ORG}/${TEST_ADMIN_REPO}/actions/workflows/ecs-infra-setup.yml/dispatches`, () =>
        HttpResponse.json({}), { once: true }),
      // Second poll: in_progress
      http.get(`https://api.github.com/repos/${TEST_GITHUB_ORG}/${TEST_ADMIN_REPO}/actions/workflows/ecs-infra-setup.yml/runs`, () =>
        HttpResponse.json({
          total_count: 1,
          workflow_runs: [{
            id: 321,
            status: "in_progress",
            conclusion: null,
            html_url: `https://github.com/${TEST_GITHUB_ORG}/${TEST_ADMIN_REPO}/actions/runs/321`,
          }],
        }), { once: true }),
      // Jobs (persist - polled multiple times)
      http.get(`https://api.github.com/repos/${TEST_GITHUB_ORG}/${TEST_ADMIN_REPO}/actions/runs/321/jobs`, () =>
        HttpResponse.json({
          jobs: [{
            name: "setup",
            status: "completed",
            conclusion: "success",
            steps: [{ name: "Create ECS Cluster", status: "completed", conclusion: "success", number: 1 }],
          }],
        })),
      // Third poll: completed (persist)
      http.get(`https://api.github.com/repos/${TEST_GITHUB_ORG}/${TEST_ADMIN_REPO}/actions/workflows/ecs-infra-setup.yml/runs`, () =>
        HttpResponse.json({
          total_count: 1,
          workflow_runs: [{
            id: 321,
            status: "completed",
            conclusion: "success",
            html_url: `https://github.com/${TEST_GITHUB_ORG}/${TEST_ADMIN_REPO}/actions/runs/321`,
          }],
        })),
    );

    const req = new Request("https://example.com/api/infra/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const resp = await handleInfraSetup(req, mockEnv as any);
    const events = await readAllSSEEvents(resp);

    expect(events.some((event) => event.phase === "infra_setup" && event.status === "running")).toBe(true);
    const done = events.find((event) => event.phase === "infra_setup" && event.status === "complete");
    expect(done).toBeDefined();
    expect((done?.data as Record<string, unknown>).no_op).toBe(false);
    expect((done?.data as Record<string, unknown>).run_id).toBe(321);
  });

  it("returns teardown error SSE when active ECS services still exist", async () => {
    server.use(
      http.get(new RegExp("https://api\\.airtable\\.com/v0/base-test/Infrastructure.*"), () =>
        HttpResponse.json({
          records: [{ id: "rec_infra", fields: { component: "ecs_shared", status: "active" } }],
        }), { once: true }),
      http.get(new RegExp("https://api\\.airtable\\.com/v0/base-test/Deployments.*"), () =>
        HttpResponse.json({
          records: [{ id: "rec_dep", fields: { spec_id: "svc", status: "active", runtime_mode: "ecs_service" } }],
        }), { once: true }),
    );

    const req = new Request("https://example.com/api/infra/teardown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const resp = await handleInfraTeardown(req, mockEnv as any);
    const events = await readAllSSEEvents(resp);

    const error = events.find((event) => event.phase === "infra_teardown" && event.status === "error");
    expect(error).toBeDefined();
    expect(String(error?.message)).toContain("Remove all ECS services first");
  });

  it("returns teardown no-op SSE when no active infra record exists", async () => {
    server.use(
      http.get(new RegExp("https://api\\.airtable\\.com/v0/base-test/Infrastructure.*"), () =>
        HttpResponse.json({ records: [] }), { once: true }),
    );

    const req = new Request("https://example.com/api/infra/teardown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const resp = await handleInfraTeardown(req, mockEnv as any);
    const events = await readAllSSEEvents(resp);

    const done = events.find((event) => event.phase === "infra_teardown" && event.status === "complete");
    expect(done).toBeDefined();
    expect((done?.data as Record<string, unknown>).no_op).toBe(true);
  });

  it("returns k8s discovery setup no-op SSE when infra record is already active", async () => {
    server.use(
      http.get(new RegExp("https://api\\.airtable\\.com/v0/base-test/Infrastructure.*"), () =>
        HttpResponse.json({
          records: [{ id: "rec_k8s", fields: { component: "k8s_discovery_shared", status: "active" } }],
        }), { once: true }),
    );

    const req = new Request("https://example.com/api/infra/k8s-discovery/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team_slug: TEST_TEAM_SLUG }),
    });
    const resp = await handleK8sDiscoveryInfraSetup(req, mockEnv as any);
    const events = await readAllSSEEvents(resp);
    const done = events.find((event) => event.phase === "k8s_discovery_infra_setup" && event.status === "complete");

    expect(done).toBeDefined();
    expect((done?.data as Record<string, unknown>).no_op).toBe(true);
  });

  it("streams k8s discovery setup SSE when no active infra exists", async () => {
    server.use(
      http.get(new RegExp("https://api\\.airtable\\.com/v0/base-test/Infrastructure.*"), () =>
        HttpResponse.json({ records: [] }), { once: true }),
      // Secrets public key (persist - called for each secret)
      http.get(`https://api.github.com/repos/${TEST_GITHUB_ORG}/${TEST_ADMIN_REPO}/actions/secrets/public-key`, () =>
        HttpResponse.json({ key_id: "test-key-id", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" })),
      // Secret PUT (persist - called for POSTMAN_API_KEY and POSTMAN_ACCESS_TOKEN)
      http.put(new RegExp(`https://api\\.github\\.com/repos/${TEST_GITHUB_ORG}/${TEST_ADMIN_REPO}/actions/secrets/POSTMAN_(API_KEY|ACCESS_TOKEN)`), () =>
        HttpResponse.json({}, { status: 201 })),
      // First poll: no runs yet
      http.get(`https://api.github.com/repos/${TEST_GITHUB_ORG}/${TEST_ADMIN_REPO}/actions/workflows/k8s-discovery-infra-setup.yml/runs`, () =>
        HttpResponse.json({ total_count: 0, workflow_runs: [] }), { once: true }),
      http.post(`https://api.github.com/repos/${TEST_GITHUB_ORG}/${TEST_ADMIN_REPO}/actions/workflows/k8s-discovery-infra-setup.yml/dispatches`, () =>
        HttpResponse.json({}), { once: true }),
      // Second poll: in_progress
      http.get(`https://api.github.com/repos/${TEST_GITHUB_ORG}/${TEST_ADMIN_REPO}/actions/workflows/k8s-discovery-infra-setup.yml/runs`, () =>
        HttpResponse.json({
          total_count: 1,
          workflow_runs: [{
            id: 654,
            status: "in_progress",
            conclusion: null,
            html_url: `https://github.com/${TEST_GITHUB_ORG}/${TEST_ADMIN_REPO}/actions/runs/654`,
          }],
        }), { once: true }),
      // Jobs (persist)
      http.get(`https://api.github.com/repos/${TEST_GITHUB_ORG}/${TEST_ADMIN_REPO}/actions/runs/654/jobs`, () =>
        HttpResponse.json({
          jobs: [{
            name: "setup",
            status: "completed",
            conclusion: "success",
            steps: [{ name: "Ensure Discovery DaemonSet", status: "completed", conclusion: "success", number: 1 }],
          }],
        })),
      // Third+ polls: completed (persist)
      http.get(`https://api.github.com/repos/${TEST_GITHUB_ORG}/${TEST_ADMIN_REPO}/actions/workflows/k8s-discovery-infra-setup.yml/runs`, () =>
        HttpResponse.json({
          total_count: 1,
          workflow_runs: [{
            id: 654,
            status: "completed",
            conclusion: "success",
            html_url: `https://github.com/${TEST_GITHUB_ORG}/${TEST_ADMIN_REPO}/actions/runs/654`,
          }],
        })),
    );

    const req = new Request("https://example.com/api/infra/k8s-discovery/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team_slug: TEST_TEAM_SLUG }),
    });
    const resp = await handleK8sDiscoveryInfraSetup(req, mockEnv as any);
    const events = await readAllSSEEvents(resp);

    const done = events.find((event) => event.phase === "k8s_discovery_infra_setup" && event.status === "complete");
    expect(done).toBeDefined();
    expect((done?.data as Record<string, unknown>).no_op).toBe(false);
    expect((done?.data as Record<string, unknown>).run_id).toBe(654);
  });

  it("returns k8s discovery teardown error SSE when active discovery services still exist", async () => {
    server.use(
      http.get(new RegExp("https://api\\.airtable\\.com/v0/base-test/Infrastructure.*"), () =>
        HttpResponse.json({
          records: [{ id: "rec_k8s", fields: { component: "k8s_discovery_shared", status: "active" } }],
        }), { once: true }),
      http.get(new RegExp("https://api\\.airtable\\.com/v0/base-test/Deployments.*"), () =>
        HttpResponse.json({
          records: [{ id: "rec_dep", fields: { spec_id: "svc", status: "active", runtime_mode: "k8s_discovery" } }],
        }), { once: true }),
    );

    const req = new Request("https://example.com/api/infra/k8s-discovery/teardown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team_slug: TEST_TEAM_SLUG }),
    });
    const resp = await handleK8sDiscoveryInfraTeardown(req, mockEnv as any);
    const events = await readAllSSEEvents(resp);

    const error = events.find((event) => event.phase === "k8s_discovery_infra_teardown" && event.status === "error");
    expect(error).toBeDefined();
    expect(String(error?.message)).toContain("Remove all Kubernetes discovery-mode services first");
  });

  it("returns k8s discovery teardown no-op SSE when no active infra record exists", async () => {
    server.use(
      http.get(new RegExp("https://api\\.airtable\\.com/v0/base-test/Infrastructure.*"), () =>
        HttpResponse.json({ records: [] }), { once: true }),
    );

    const req = new Request("https://example.com/api/infra/k8s-discovery/teardown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team_slug: TEST_TEAM_SLUG }),
    });
    const resp = await handleK8sDiscoveryInfraTeardown(req, mockEnv as any);
    const events = await readAllSSEEvents(resp);

    const done = events.find((event) => event.phase === "k8s_discovery_infra_teardown" && event.status === "complete");
    expect(done).toBeDefined();
    expect((done?.data as Record<string, unknown>).no_op).toBe(true);
  });
});
