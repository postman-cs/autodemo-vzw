import { afterAll, describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PortalConfig } from "../src/lib/config";
import type { ProvisioningEnv } from "../src/lib/provisioning-env";
import { getDomainCode, handleProvision, buildFinalData, resolveSpec } from "../src/lib/provision";
import { makeTeamRegistryKV, makeEmptyTeamRegistryKV, TEST_TEAM_SLUG } from "./helpers/team-registry";
import { buildFinalDeploymentSnapshot } from "../src/lib/deployment-success";
import { ORG, setGitHubOrg } from "../src/lib/github";
import { http, HttpResponse } from "msw";
import { server, setupFetchMock, teardownFetchMock } from "./helpers/fetch-mock";
import { TEST_GITHUB_ORG, TEST_K8S_NAMESPACE, TEST_WORKER_URL, TEST_MOCK_SYSTEM_ENV_ID } from "./helpers/constants";

// Mock sleep to resolve instantly
vi.mock("../src/lib/sleep", () => ({
  sleep: () => Promise.resolve(),
}));

describe("getDomainCode", () => {
  it("maps wealth to WEAL", () => {
    expect(getDomainCode("wealth")).toBe("WEAL");
  });

  it("maps payments to PAYM", () => {
    expect(getDomainCode("payments")).toBe("PAYM");
  });

  it("maps identity to IDEN", () => {
    expect(getDomainCode("identity")).toBe("IDEN");
  });

  it("maps platform to PLAT", () => {
    expect(getDomainCode("platform")).toBe("PLAT");
  });

  it("derives unknown domain codes from the domain name", () => {
    expect(getDomainCode("unknown")).toBe("UNKN");
    expect(getDomainCode("")).toBe("MISC");
  });
});

describe("canonical Postman workspace handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    process.env.GITHUB_REPOSITORY = `${TEST_GITHUB_ORG}/test-repo`;
    vi.doMock("@actions/core", () => ({
      getInput: vi.fn(),
      group: vi.fn(async (_name: string, fn: () => Promise<void>) => fn()),
      setFailed: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
    }));
    vi.doMock("@actions/exec", () => ({ exec: vi.fn() }));
    vi.doMock("@actions/io", () => ({ which: vi.fn().mockResolvedValue("/usr/bin/postman") }));
    vi.doMock("../.github/actions/_lib/step-output", () => ({
      setStepOutput: vi.fn(),
      logStepInfo: vi.fn(),
    }));
  });

  afterEach(() => {
    delete process.env.GITHUB_REPOSITORY;
    vi.doUnmock("@actions/core");
    vi.doUnmock("@actions/exec");
    vi.doUnmock("@actions/io");
    vi.doUnmock("../.github/actions/_lib/step-output");
    vi.doUnmock("../.github/actions/_lib/postman-api");
    vi.doUnmock("../.github/actions/_lib/github-api");
  });

  it("prefers a single GitHub-linked duplicate over the persisted unlinked repo workspace", async () => {
    const { chooseCanonicalWorkspace } = await import("../.github/actions/postman-bootstrap/src/workspace-selection");

    expect(chooseCanonicalWorkspace({
      repoWorkspaceId: "ws-unlinked",
      repoUrl: `https://github.com/${TEST_GITHUB_ORG}/test-repo`,
      matchingWorkspaces: [
        { id: "ws-unlinked", linkedRepoUrl: null },
        { id: "ws-linked", linkedRepoUrl: `https://github.com/${TEST_GITHUB_ORG}/test-repo` },
      ],
    })).toMatchObject({ type: "existing", workspaceId: "ws-linked", source: "linked_match" });
  });

  it("preserves the current repo workspace when no linked duplicate exists", async () => {
    const { chooseCanonicalWorkspace } = await import("../.github/actions/postman-bootstrap/src/workspace-selection");

    expect(chooseCanonicalWorkspace({
      repoWorkspaceId: "ws-current",
      repoUrl: `https://github.com/${TEST_GITHUB_ORG}/test-repo`,
      matchingWorkspaces: [
        { id: "ws-alt-a", linkedRepoUrl: null },
        { id: "ws-alt-b", linkedRepoUrl: `https://github.com/${TEST_GITHUB_ORG}/other-repo` },
      ],
    })).toMatchObject({ type: "existing", workspaceId: "ws-current", source: "repo_var" });
  });

  it("reads GitHub-linked repo metadata from Bifrost workspace filesystem lookup", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { filesystem: { repo: `git@github.com:${TEST_GITHUB_ORG}/test-repo.git` } } }),
      } as any);

    const { PostmanApiClient } = await import("../.github/actions/_lib/postman-api");
    const client = new PostmanApiClient("key");

    await expect(client.getWorkspaceGitRepoUrl("ws-123", "team-123", "token-123")).resolves.toBe(`https://github.com/${TEST_GITHUB_ORG}/test-repo`);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("fails Bifrost already-exists when the workspace is linked to a different repo", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => '{"type":"invalidParamError","message":"already exists"}',
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { repo: `https://github.com/${TEST_GITHUB_ORG}/other-repo` } }),
      } as any);

    const { PostmanApiClient } = await import("../.github/actions/_lib/postman-api");
    const client = new PostmanApiClient("key");

    await expect(
      client.proxyBifrost("ws-123", `https://github.com/${TEST_GITHUB_ORG}/test-repo`, "team-123", "token-123"),
    ).rejects.toThrow("workspace ws-123 is not linked to that repo");
  });

  it("treats projectAlreadyConnected as idempotent when the workspace is linked to the same repo", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({
          error: {
            name: "projectAlreadyConnected",
            message: "Workspace already has a file system connected.",
          },
        }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: {
            filesystem: {
              repo: `https://github.com/${TEST_GITHUB_ORG}/test-repo`,
            },
          },
        }),
      } as any);

    const { PostmanApiClient } = await import("../.github/actions/_lib/postman-api");
    const client = new PostmanApiClient("key");

    await expect(
      client.proxyBifrost("ws-123", `https://github.com/${TEST_GITHUB_ORG}/test-repo`, "team-123", "token-123"),
    ).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("persists the canonical linked workspace back to POSTMAN_WORKSPACE_ID", async () => {
    const { resolveCanonicalWorkspaceSelection, storePostmanRepoVariables } = await import("../.github/actions/postman-bootstrap/src/workspace-selection");
    const setRepositoryVariable = vi.fn().mockResolvedValue(undefined);
    const findWorkspacesByName = vi.fn().mockResolvedValue([
      { id: "ws-unlinked", name: "[CARD] test-api" },
      { id: "ws-linked", name: "[CARD] test-api" },
    ]);

    const selection = await resolveCanonicalWorkspaceSelection({
      postman: {
        findWorkspacesByName,
        getWorkspaceGitRepoUrl: vi.fn().mockImplementation(async (workspaceId: string) => {
          return workspaceId === "ws-linked" ? `https://github.com/${TEST_GITHUB_ORG}/test-repo` : null;
        }),
      },
      workspaceName: "[CARD] test-api",
      repoWorkspaceId: "ws-unlinked",
      repoUrl: `https://github.com/${TEST_GITHUB_ORG}/test-repo`,
      teamId: "team",
      accessToken: "token",
    });

    expect(findWorkspacesByName).toHaveBeenCalledWith("[CARD] test-api");
    expect(selection).toMatchObject({ type: "existing", workspaceId: "ws-linked" });

    if (selection.type !== "existing") {
      throw new Error("expected an existing canonical workspace");
    }

    await storePostmanRepoVariables({
      github: { setRepositoryVariable },
      workspaceId: selection.workspaceId,
      specId: "spec-123",
      baselineUid: "baseline-123",
      smokeUid: "smoke-123",
      contractUid: "contract-123",
      environments: ["prod"],
      systemEnvMap: { prod: "sys-prod" },
    });

    expect(setRepositoryVariable).toHaveBeenCalledWith("POSTMAN_WORKSPACE_ID", "ws-linked");
  });
});


const mockEnv = {
  ASSETS: { fetch: async () => new Response("asset") },
  POSTMAN_API_KEY: "test-key",
  POSTMAN_ACCESS_TOKEN: "test-token",
  GH_TOKEN: "test-gh",
  AWS_ACCESS_KEY_ID: "test-aws-key",
  AWS_SECRET_ACCESS_KEY: "test-aws-secret",
  AIRTABLE_API_KEY: "airtable-key",
  AIRTABLE_BASE_ID: "base-test",
  PORTAL_CONFIG: { get: async () => null } as unknown as KVNamespace,
  TEAM_REGISTRY: makeTeamRegistryKV() as KVNamespace,
};

const FINAL_VAR_NAMES = [
  "POSTMAN_WORKSPACE_ID",
  "POSTMAN_SPEC_UID",
  "POSTMAN_BASELINE_COLLECTION_UID",
  "POSTMAN_SMOKE_COLLECTION_UID",
  "POSTMAN_CONTRACT_COLLECTION_UID",
  "POSTMAN_RUN_URL",
  "POSTMAN_ENVIRONMENT_UID",
  "POSTMAN_ENV_UIDS_JSON",
  "POSTMAN_SYSTEM_ENV_PROD",
  "POSTMAN_SYSTEM_ENV_STAGE",
  "DEV_GW_URL",
  "DEV_API_ID",
  "MOCK_URL",
  "FUNCTION_NAME",
  "RUNTIME_MODE",
  "RUNTIME_BASE_URL",
  "LINT_WARNINGS",
  "LINT_ERRORS",
  "FERN_DOCS_URL",
  "CHAOS_ENABLED",
  "CHAOS_CONFIG",
  "PROD_GW_URL",
  "PROD_API_ID",
  "STAGE_GW_URL",
  "STAGE_API_ID",
  "ENVIRONMENT_DEPLOYMENTS_JSON",
  "ENV_BRANCH_MAP_JSON",
];

const ECS_FINAL_VAR_NAMES = [
  "ECS_CLUSTER_NAME",
  "ECS_SERVICE_NAME",
  "ECS_TASK_DEFINITION",
  "ECS_TARGET_GROUP_ARN",
  "ECS_LISTENER_RULE_ARN",
];

const portalProvisionConfig: PortalConfig = {
  slug: "portal-api",
  customer_name: "Portal API Customer",
  platform: { name: "Portal API", subtitle: "Provisioning", jira_prefix: "TEN", iam_role_prefix: "portal" },
  branding: { primary: "#0b6dff", primary_hover: "#0a5cd4", logo: "logo.png", favicon: "favicon.png", hero_image: "hero.png" },
  contact: {
    email_domain: "portal-api.test",
    email_from: "noreply@portal-api.test",
    email_signature: "Portal API Team",
    support_label: "Support",
  },
  domains: [{ value: "wealth", label: "Wealth", code: "WEAL", governance_group: "Wealth APIs" }],
  aws_accounts: [{ id: "111111111111", label: "1111****1111 - Dev", product_code: "TEN-DEV", service_name: "Tenant Service" }],
  templates: [{ title: "Template", description: "Default template", version: "v1" }],
  form_defaults: { project_name: "portal-api", application_id: "APP-TENANT", form_title: "Portal API", form_subtitle: "Provision API" },
  specs: [{ value: "portal-spec", label: "Tenant Default Spec", url: "https://portal-api.test/specs/default.yaml" }],
  sidebar: { navigation: [{ label: "Templates", action: "showTemplates", active: true }], tools: [], support: [] },
  backend: {
    github_org: TEST_GITHUB_ORG,
    user_agent: "portal-demo-worker",
    boilerplate_url: "https://raw.githubusercontent.com/postman-cs/portal-ci-bootstrap/main/server/boilerplate",
    git_committer_name: "Portal API",
    git_committer_email: "noreply@portal-api.test",
    fallback_team_id: 132319,
    fallback_team_name: "CSE v12",
  },
  spec_content: "openapi: 3.0.3\npaths: {}\n",
  spec_url: "https://portal-api.test/preloaded-spec.yaml",
};

beforeEach(() => {
  setGitHubOrg("postman-cs");
});

afterEach(() => {
  setGitHubOrg(ORG);
});

describe("handleProvision", () => {
  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      body: "not json",
    });
    const resp = await handleProvision(req, mockEnv);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain("Invalid JSON");
  });

  it("returns 400 when project_name is missing", async () => {
    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requester_email: "test@test.com" }),
    });
    const resp = await handleProvision(req, mockEnv);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain("required");
  });

  it("returns 400 when requester_email is missing", async () => {
    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "test" }),
    });
    const resp = await handleProvision(req, mockEnv);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain("required");
  });
});

// Helper to set up the full mock chain for a successful pipeline
function setupAirtableMocks(
  baseId = "base-test",
  options?: {
    discoveryInfraStatus?: "active" | "inactive" | "tearing_down" | "error";
    discoveryNamespace?: string;
    discoveryDaemonsetName?: string;
    deploymentRecords?: Array<{ id: string; fields: Record<string, unknown> }>;
    resolveDeploymentRecords?: (params: {
      targetSpecId: string;
      filterFormula: string;
      maxRecords: number;
      records: Array<{ id: string; fields: Record<string, unknown> }>;
      requestPath: string;
    }) => Array<{ id: string; fields: Record<string, unknown> }> | undefined;
    graphMembershipTableAvailable?: boolean;
    graphMembershipRecords?: Array<{ id: string; fields: Record<string, unknown> }>;
    onCreateDeployment?: (body: Record<string, unknown>) => void;
    onPatchDeployment?: (recordId: string, body: Record<string, unknown>) => void;
    onCreateGraphMembership?: (body: Record<string, unknown>) => void;
    onPatchGraphMembership?: (recordId: string, body: Record<string, unknown>) => void;
  },
) {
  // Use server.use() with MSW async handlers
  const BASE = `https://api.airtable.com`;

  const deploymentRecords = (options?.deploymentRecords || []).map((record) => ({
    id: record.id,
    fields: { ...record.fields },
  }));
  const graphMembershipTableAvailable = options?.graphMembershipTableAvailable ?? true;
  const graphMembershipRecords = (options?.graphMembershipRecords || []).map((record) => ({
    id: record.id,
    fields: { ...record.fields },
  }));
  let createCounter = 0;
  let graphMembershipCreateCounter = 0;
  const infraRecords: Array<Record<string, unknown>> = [];
  if (options?.discoveryInfraStatus) {
    infraRecords.push({
      id: "rec_k8s_discovery_shared",
      fields: {
        component: "k8s_discovery_shared",
        status: options.discoveryInfraStatus,
        k8s_namespace: options.discoveryNamespace || TEST_K8S_NAMESPACE,
        k8s_daemonset_name: options.discoveryDaemonsetName || "postman-insights-agent",
      },
    });
  }

  server.use(
    http.get(new RegExp(`${BASE}/v0/${baseId}/Infrastructure.*`), () =>
      HttpResponse.json({ records: infraRecords })),
    http.get(new RegExp(`${BASE}/v0/${baseId}/Deployments.*`), async ({ request }) => {
      const url = new URL(request.url);
      const filterFormula = url.searchParams.get("filterByFormula") || "";
      const maxRecords = Number(url.searchParams.get("maxRecords") || "0");
      let records = deploymentRecords;
      const filterMatch = filterFormula.match(/\{spec_id\}="([^"]+)"/);
      const targetSpecId = filterMatch?.[1] || "";
      if (filterMatch?.[1]) {
        records = records.filter((record) => String(record.fields?.spec_id || "") === targetSpecId);
      }
      const resolvedRecords = options?.resolveDeploymentRecords?.({
        targetSpecId, filterFormula, maxRecords,
        records: records.map((record) => ({ id: record.id, fields: { ...record.fields } })),
        requestPath: url.pathname + url.search,
      });
      if (resolvedRecords) records = resolvedRecords;
      if (Number.isFinite(maxRecords) && maxRecords > 0) records = records.slice(0, maxRecords);
      return HttpResponse.json({ records });
    }),
    http.post(`${BASE}/v0/${baseId}/Deployments`, async ({ request }) => {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      options?.onCreateDeployment?.(body);
      const fields = (body.fields && typeof body.fields === "object") ? { ...(body.fields as Record<string, unknown>) } : {};
      const specId = String(fields.spec_id || `created-${createCounter + 1}`);
      const existing = deploymentRecords.find((record) => String(record.fields?.spec_id || "") === specId);
      if (existing) {
        existing.fields = { ...existing.fields, ...fields };
        return HttpResponse.json({ id: existing.id, fields: existing.fields });
      }
      createCounter += 1;
      const created = { id: `rec-${specId.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}-${createCounter}`, fields };
      deploymentRecords.push(created);
      return HttpResponse.json(created);
    }),
    http.patch(new RegExp(`${BASE}/v0/${baseId}/Deployments/.*`), async ({ request }) => {
      const url = new URL(request.url);
      const match = url.pathname.match(/\/Deployments\/([^/?]+)/);
      const recordId = match?.[1] || "rec-provision-test";
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      options?.onPatchDeployment?.(recordId, body);
      const fields = (body.fields && typeof body.fields === "object") ? { ...(body.fields as Record<string, unknown>) } : {};
      const existing = deploymentRecords.find((record) => record.id === recordId);
      if (existing) {
        existing.fields = { ...existing.fields, ...fields };
        return HttpResponse.json({ id: recordId, fields: existing.fields });
      }
      const created = { id: recordId, fields };
      deploymentRecords.push(created);
      return HttpResponse.json(created);
    }),
    http.get(new RegExp(`${BASE}/v0/${baseId}/GraphMemberships.*`), async ({ request }) => {
      if (!graphMembershipTableAvailable) return HttpResponse.json({ error: { type: "MODEL_NOT_FOUND", message: "Could not find table GraphMemberships" } }, { status: 404 });
      const url = new URL(request.url);
      const filterFormula = url.searchParams.get("filterByFormula") || "";
      const maxRecords = Number(url.searchParams.get("maxRecords") || "0");
      let records = graphMembershipRecords;
      const match = filterFormula.match(/AND\(\{deployment_group_id\}="([^"]+)",\{spec_id\}="([^"]+)",\{environment\}="([^"]+)"\)/);
      if (match) {
        const [, deploymentGroupId, specId, environment] = match;
        records = graphMembershipRecords.filter((record) =>
          String(record.fields?.deployment_group_id || "") === deploymentGroupId &&
          String(record.fields?.spec_id || "") === specId &&
          String(record.fields?.environment || "") === environment,
        );
      }
      if (Number.isFinite(maxRecords) && maxRecords > 0) records = records.slice(0, maxRecords);
      return HttpResponse.json({ records });
    }),
    http.post(`${BASE}/v0/${baseId}/GraphMemberships`, async ({ request }) => {
      if (!graphMembershipTableAvailable) return HttpResponse.json({ error: { type: "MODEL_NOT_FOUND", message: "Could not find table GraphMemberships" } }, { status: 404 });
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      options?.onCreateGraphMembership?.(body);
      const fields = (body.fields && typeof body.fields === "object") ? { ...(body.fields as Record<string, unknown>) } : {};
      graphMembershipCreateCounter += 1;
      const created = { id: `rec-graph-membership-${graphMembershipCreateCounter}`, fields };
      graphMembershipRecords.push(created);
      return HttpResponse.json(created);
    }),
    http.patch(new RegExp(`${BASE}/v0/${baseId}/GraphMemberships/.*`), async ({ request }) => {
      if (!graphMembershipTableAvailable) return HttpResponse.json({ error: { type: "MODEL_NOT_FOUND", message: "Could not find table GraphMemberships" } }, { status: 404 });
      const url = new URL(request.url);
      const match = url.pathname.match(/\/GraphMemberships\/([^/?]+)/);
      const recordId = match?.[1] || "rec-graph-membership";
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      options?.onPatchGraphMembership?.(recordId, body);
      const fields = (body.fields && typeof body.fields === "object") ? { ...(body.fields as Record<string, unknown>) } : {};
      const existing = graphMembershipRecords.find((record) => record.id === recordId);
      if (existing) {
        existing.fields = { ...existing.fields, ...fields };
        return HttpResponse.json({ id: recordId, fields: existing.fields });
      }
      const created = { id: recordId, fields };
      graphMembershipRecords.push(created);
      return HttpResponse.json(created);
    }),
  );
}

function setupPipelineMocks(
  repoName: string,
  options?: {
    onDispatch?: (body: unknown) => void;
    runtimeMode?: "lambda" | "ecs_service" | "k8s_workspace" | "k8s_discovery";
    onRuntimeBaseVariable?: (body: unknown) => void;
    onVariablePatch?: (name: string, body: unknown) => void;
    onSecretPut?: (name: string) => void;
    onCreateRef?: (body: unknown) => void;
    discoveryInfraStatus?: "active" | "inactive" | "tearing_down" | "error";
    airtableBaseId?: string;
    deploymentRecords?: Array<{ id: string; fields: Record<string, unknown> }>;
    resolveDeploymentRecords?: (params: {
      targetSpecId: string;
      filterFormula: string;
      maxRecords: number;
      records: Array<{ id: string; fields: Record<string, unknown> }>;
      requestPath: string;
    }) => Array<{ id: string; fields: Record<string, unknown> }> | undefined;
    graphMembershipTableAvailable?: boolean;
    onCreateDeployment?: (body: Record<string, unknown>) => void;
    onPatchDeployment?: (recordId: string, body: Record<string, unknown>) => void;
    onCreateGraphMembership?: (body: Record<string, unknown>) => void;
    onPatchGraphMembership?: (recordId: string, body: Record<string, unknown>) => void;
    repoCreationBehavior?: "success" | "conflict_then_exists";
  },
) {
  setupAirtableMocks(options?.airtableBaseId || "base-test", {
    discoveryInfraStatus: options?.discoveryInfraStatus,
    deploymentRecords: options?.deploymentRecords,
    resolveDeploymentRecords: options?.resolveDeploymentRecords,
    graphMembershipTableAvailable: options?.graphMembershipTableAvailable,
    onCreateDeployment: options?.onCreateDeployment,
    onPatchDeployment: options?.onPatchDeployment,
    onCreateGraphMembership: options?.onCreateGraphMembership,
    onPatchGraphMembership: options?.onPatchGraphMembership,
  });

  const GH = "https://api.github.com";

  // createRepo - stateful: pre-create returns 404, post-create returns 200
  let repoCreated = false;
  server.use(
    http.get(`${GH}/repos/postman-cs/${repoName}`, () => {
      if (repoCreated) {
        return HttpResponse.json({ full_name: `postman-cs/${repoName}`, html_url: `https://github.com/postman-cs/${repoName}`, default_branch: "main" });
      }
      return HttpResponse.json({ message: "Not Found" }, { status: 404 });
    }),
  );
  if (options?.repoCreationBehavior === "conflict_then_exists") {
    server.use(
      http.post(`${GH}/orgs/postman-cs/repos`, () => {
        repoCreated = true;
        return HttpResponse.json({ message: "already exists" }, { status: 422 });
      }, { once: true }),
    );
  } else {
    server.use(
      http.post(`${GH}/orgs/postman-cs/repos`, () => {
        repoCreated = true;
        return HttpResponse.json({ full_name: `postman-cs/${repoName}`, html_url: `https://github.com/postman-cs/${repoName}`, default_branch: "main" }, { status: 201 });
      }, { once: true }),
    );
  }
  server.use(
    http.put(`${GH}/repos/postman-cs/${repoName}/topics`, () =>
      HttpResponse.json({}), { once: true }),
    http.delete(`${GH}/repos/postman-cs/${repoName}`, () =>
      HttpResponse.json({}), { once: true }),
  );

  // Default variable reads
  const defaultVars: Record<string, string> = {
    POSTMAN_WORKSPACE_ID: "ws-123",
    POSTMAN_SMOKE_COLLECTION_UID: "",
    POSTMAN_CONTRACT_COLLECTION_UID: "",
    POSTMAN_BASELINE_COLLECTION_UID: "",
    POSTMAN_SPEC_UID: "",
    POSTMAN_ENVIRONMENT_UID: "",
    MOCK_URL: "",
    DEV_GW_URL: "",
    FUNCTION_NAME: "",
    LINT_WARNINGS: "0",
    LINT_ERRORS: "0",
  };
  for (const [name, value] of Object.entries(defaultVars)) {
    server.use(
      http.get(`${GH}/repos/postman-cs/${repoName}/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value })),
    );
  }

  server.use(
    // Postman workspace delete
    http.delete("https://api.getpostman.com/workspaces/ws-123", () =>
      HttpResponse.json({ workspace: { id: "ws-123" } }), { once: true }),

    // Bifrost system-envs (persist)
    http.post("https://bifrost-premium-https-v4.gw.postman.com/ws/proxy", () =>
      HttpResponse.json({
        data: [
          { id: TEST_MOCK_SYSTEM_ENV_ID, name: "Production", slug: "prod" },
          { id: "7a942017-f58c-4f7d-995b-017e08287e0b", name: "Stage", slug: "stage" },
          { id: "3c360982-f58c-4f7d-995b-017e08287e0b", name: "Development", slug: "dev" },
        ],
      })),

    // appendCommit
    http.get(`${GH}/repos/postman-cs/${repoName}/git/refs/heads/main`, () =>
      HttpResponse.json({ object: { sha: "parent-sha" } })),
    http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/${repoName}/git/refs/heads/env/.*`), () =>
      HttpResponse.json({ message: "Not Found" }, { status: 404 })),
    http.get(`${GH}/repos/postman-cs/${repoName}/git/commits/parent-sha`, () =>
      HttpResponse.json({ sha: "parent-sha", tree: { sha: "parent-tree" } })),
    http.post(`${GH}/repos/postman-cs/${repoName}/git/trees`, () =>
      HttpResponse.json({ sha: "tree" }, { status: 201 })),
    http.post(`${GH}/repos/postman-cs/${repoName}/git/commits`, () =>
      HttpResponse.json({ sha: "commit" }, { status: 201 })),
    http.patch(`${GH}/repos/postman-cs/${repoName}/git/refs/heads/main`, () =>
      HttpResponse.json({ object: { sha: "commit" } })),
    http.post(`${GH}/repos/postman-cs/${repoName}/git/refs`, async ({ request }) => {
      const body = await request.text().catch(() => "");
      options?.onCreateRef?.(body);
      return HttpResponse.json({ ref: "refs/heads/env/prod", object: { sha: "branch-sha" } }, { status: 201 });
    }),

    // lookupUser
    http.get(new RegExp(`https://api\\.github\\.com/search/users`), () =>
      HttpResponse.json({ total_count: 0, items: [] })),

    // createRepoSecret - public key (persist)
    http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/${repoName}/actions/secrets/public-key`), () => {
      const kb = new Uint8Array(32); crypto.getRandomValues(kb);
      return HttpResponse.json({ key: btoa(String.fromCharCode(...kb)), key_id: "k" });
    }),

    // createRepoSecret - PUT (persist)
    http.put(new RegExp(`https://api\\.github\\.com/repos/postman-cs/${repoName}/actions/secrets/.*`), async ({ request }) => {
      const parts = new URL(request.url).pathname.split("/");
      options?.onSecretPut?.(parts[parts.length - 1] || "");
      return HttpResponse.json({});
    }),

    // workflow runs list (persist) - returns stale run 1 first to allow correlation
    http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/${repoName}/actions/workflows/provision\\.yml/runs`), () =>
      HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 1, status: "completed", conclusion: "success", html_url: "https://github.com/run/1" }] })),
  );

  // triggerWorkflow
  if (options?.onDispatch) {
    server.use(
      http.post(`${GH}/repos/postman-cs/${repoName}/actions/workflows/provision.yml/dispatches`, async ({ request }) => {
        const body = await request.text().catch(() => "");
        options?.onDispatch?.(body);
        return HttpResponse.json({});
      }, { once: true }),
    );
  } else {
    server.use(
      http.post(`${GH}/repos/postman-cs/${repoName}/actions/workflows/provision.yml/dispatches`, () =>
        HttpResponse.json({}), { once: true }),
    );
  }

  server.use(
    // Default run status (persist) - returns success for any run id
    http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/${repoName}/actions/runs/\\d+$`), ({ request }) => {
      const url = new URL(request.url);
      const match = url.pathname.match(/\/actions\/runs\/(\d+)$/);
      const runId = match ? Number(match[1]) : 1;
      return HttpResponse.json({ id: runId, status: "completed", conclusion: "success", html_url: `https://github.com/run/${runId}`, updated_at: "2026-03-04T00:00:00Z" });
    }),

    // Default jobs for run 1 (persist)
    http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/${repoName}/actions/runs/1/jobs`), () =>
      HttpResponse.json({ jobs: [{ name: "provision", status: "completed", conclusion: "success", steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }] }] })),

    // PATCH variable handlers
    http.patch(`${GH}/repos/postman-cs/${repoName}/actions/variables/POSTMAN_TEAM_ID`, async ({ request }) => {
      const body = await request.text().catch(() => "");
      options?.onVariablePatch?.("POSTMAN_TEAM_ID", body);
      return HttpResponse.json({});
    }),
    http.patch(`${GH}/repos/postman-cs/${repoName}/actions/variables/RUNTIME_MODE`, async ({ request }) => {
      const body = await request.text().catch(() => "");
      options?.onVariablePatch?.("RUNTIME_MODE", body);
      return HttpResponse.json({});
    }),
    http.patch(`${GH}/repos/postman-cs/${repoName}/actions/variables/RUNTIME_BASE_URL`, async ({ request }) => {
      const body = await request.text().catch(() => "");
      options?.onRuntimeBaseVariable?.(body);
      options?.onVariablePatch?.("RUNTIME_BASE_URL", body);
      return HttpResponse.json({});
    }),
    http.patch(`${GH}/repos/postman-cs/${repoName}/actions/variables/CI_ENVIRONMENT`, async ({ request }) => {
      const body = await request.text().catch(() => "");
      options?.onVariablePatch?.("CI_ENVIRONMENT", body);
      return HttpResponse.json({});
    }),
  );

  for (const name of [
    "POSTMAN_SYSTEM_ENV_PROD", "POSTMAN_SYSTEM_ENV_STAGE", "POSTMAN_SYSTEM_ENV_DEV",
    "ECS_CLUSTER_NAME", "ECS_VPC_ID", "ECS_SUBNET_IDS", "ECS_SECURITY_GROUP_IDS",
    "ECS_EXECUTION_ROLE_ARN", "ECS_TASK_ROLE_ARN", "ECS_ALB_LISTENER_ARN",
    "ECS_ALB_DNS_NAME", "ECS_ECR_REPOSITORY", "ECS_MAX_SERVICES", "ECS_SERVICE_NAME",
    "ECS_TASK_DEFINITION", "K8S_NAMESPACE", "K8S_CONTEXT", "K8S_INGRESS_BASE_DOMAIN",
    "POSTMAN_INSIGHTS_CLUSTER_NAME", "CHAOS_ENABLED", "PROD_GW_URL", "PROD_API_ID",
    "DEV_GW_URL", "DEV_API_ID", "STAGE_GW_URL", "STAGE_API_ID", "ENV_BRANCH_MAP_JSON",
    "CROSS_REPO_PAT_FALLBACK", "WORKSPACE_ADMIN_USER_IDS",
  ]) {
    server.use(
      http.patch(`${GH}/repos/postman-cs/${repoName}/actions/variables/${name}`, async ({ request }) => {
        const body = await request.text().catch(() => "");
        options?.onVariablePatch?.(name, body);
        return HttpResponse.json({});
      }),
    );
  }

  server.use(
    // listRepoVariables (persist)
    http.get(`${GH}/repos/postman-cs/${repoName}/actions/variables`, () =>
      HttpResponse.json({ variables: Object.entries(defaultVars).map(([name, value]) => ({ name, value })) })),

    // Generic GET for any variable
    http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/${repoName}/actions/variables/.*`), ({ request }) => {
      const parts = new URL(request.url).pathname.split("/");
      const name = parts[parts.length - 1];
      return HttpResponse.json({ name, value: "mock-value" });
    }),

    // createRepoVariable POST (persist)
    http.post(`${GH}/repos/postman-cs/${repoName}/actions/variables`, async ({ request }) => {
      const body = await request.text().catch(() => "");
      const payload = parseJsonBody(body);
      const name = typeof payload.name === "string" ? payload.name : "";
      if (name === "RUNTIME_BASE_URL") options?.onRuntimeBaseVariable?.(body);
      if (name) options?.onVariablePatch?.(name, body);
      return HttpResponse.json("", { status: 201 });
    }),
  );
}

function parseJsonBody(bodyText: unknown): Record<string, string> {
  if (typeof bodyText === "object" && bodyText && !ArrayBuffer.isView(bodyText) && !(bodyText instanceof ArrayBuffer)) {
    return bodyText as Record<string, string>;
  }

  if (bodyText instanceof ArrayBuffer) {
    const text = new TextDecoder().decode(new Uint8Array(bodyText));
    return parseJsonBody(text);
  }

  if (ArrayBuffer.isView(bodyText)) {
    return parseJsonBody(new TextDecoder().decode(bodyText as Uint8Array));
  }

  const text = typeof bodyText === "string" ? bodyText : "";
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function readSSEStream(resp: Response): Promise<string> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

describe("handleProvision pipeline", () => {
  afterAll(() => server.close());
  beforeEach(async () => {
    await setupFetchMock();
    server.use(
      http.get("https://example.com/spec.yaml", () =>
        new HttpResponse("openapi: 3.0.3\npaths: {}\n", { status: 200 })),
    );
    server.use(
      http.post("https://bifrost-premium-https-v4.gw.postman.com/ws/proxy", () =>
        HttpResponse.json({ data: [
          { id: TEST_MOCK_SYSTEM_ENV_ID, name: "Production", slug: "prod" },
          { id: "7a942017-f58c-4f7d-995b-017e08287e0b", name: "Stage", slug: "stage" },
          { id: "3c360982-f58c-4f7d-995b-017e08287e0b", name: "Development", slug: "dev" },
        ] })),
    );
  });

  afterEach(() => {
    teardownFetchMock({ assertNoPendingInterceptors: false });
  });

  it("streams SSE events for a successful pipeline run", async () => {
    const repoName = "pipeline-success";
    setupPipelineMocks(repoName);
    server.use(
      http.get("https://example.com/spec.yaml", () =>
        new HttpResponse("openapi: 3.0.3\npaths: {}\n", { status: 200 }), { once: true }),
    );

    // getLatestWorkflowRun — completed immediately (narrow path to avoid shadowing)
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/${repoName}/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 99, status: "completed", conclusion: "success", html_url: "https://github.com/run/99" }] }), { once: true }),
    );

    // getWorkflowJobs (narrow path)
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/${repoName}/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision", status: "completed", conclusion: "success",
          steps: [
            { name: "Create Postman Workspace", status: "completed", conclusion: "success", number: 1 },
            { name: "Deploy Lambda Functions", status: "completed", conclusion: "success", number: 2 },
            { name: "Summary", status: "completed", conclusion: "success", number: 3 },
          ]
        }]
      }), { once: true }),
    );

    // buildFinalData
    for (const name of FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/pipeline-success/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: `v-${name}` })),
    );
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "pipeline-success", domain: "wealth", requester_email: "user@test.com", spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG }),
    });

    const resp = await handleProvision(req, mockEnv);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"github"');
    expect(text).toContain('"phase":"postman"');
    expect(text).toContain('"phase":"complete"');
    expect(text).toContain('"status":"complete"');
  });

  it("continues provisioning when repo creation loses a race but the repo now exists", async () => {
    const repoName = "pipeline-race";
    setupPipelineMocks(repoName, { repoCreationBehavior: "conflict_then_exists" });
    server.use(
      http.get("https://example.com/spec.yaml", () =>
        new HttpResponse("openapi: 3.0.3\npaths: {}\n", { status: 200 }), { once: true }),
    );

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/${repoName}/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 97, status: "completed", conclusion: "success", html_url: "https://github.com/run/97" }] }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/${repoName}/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision", status: "completed", conclusion: "success",
          steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }],
        }],
      }), { once: true }),
    );

    for (const name of FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${repoName}/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: `v-${name}` })),
    );
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: repoName, domain: "wealth", requester_email: "user@test.com", spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG }),
    });

    const resp = await handleProvision(req, mockEnv);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"complete"');
    expect(text).toContain('"status":"complete"');
    expect(text).not.toContain('"phase":"error"');
  });

  it("persists empty runtime base URL metadata for lambda mode", async () => {
    const repoName = "lambda-runtime";
    let runtimeBaseVariableBody: Record<string, string> = {};
    setupPipelineMocks(repoName, {
      onRuntimeBaseVariable: (body) => {
        runtimeBaseVariableBody = parseJsonBody(body);
      },
    });
    server.use(
      http.get("https://example.com/spec.yaml", () =>
        new HttpResponse("openapi: 3.0.3\npaths: {}\n", { status: 200 }), { once: true }),
    );

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/${repoName}/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 98, status: "completed", conclusion: "success", html_url: "https://github.com/run/98" }] }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/${repoName}/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision", status: "completed", conclusion: "success",
          steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }],
        }]
      }), { once: true }),
    );

    for (const name of FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${repoName}/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: "v" })),
    );
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: repoName,
        domain: "wealth",
        requester_email: "user@test.com",
        runtime: "lambda",
        spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, mockEnv);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"complete"');
    expect(runtimeBaseVariableBody.name).toBe("RUNTIME_BASE_URL");
    expect(runtimeBaseVariableBody.value).toBe("");
  });


  it("dispatches with chaos_config if provided, preserving chaos_enabled default", async () => {
    const repoName = "chaos-config-test";
    let dispatchBody: Record<string, unknown> = {};
    setupPipelineMocks(repoName, {
      onDispatch: (body) => {
        dispatchBody = parseJsonBody(body);
      },
    });

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/${repoName}/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 890, status: "completed", conclusion: "success", html_url: "https://github.com/run/890" }] }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/${repoName}/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision", status: "completed", conclusion: "success",
          steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }],
        }]
      }), { once: true }),
    );

    for (const name of FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${repoName}/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: "v" })),
    );
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: repoName,
        domain: "wealth",
        requester_email: "user@test.com",
        runtime: "lambda",
        spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
        chaos_config: JSON.stringify({ fault_rate: 0.5, fault_type: "latency" }),
      }),
    });

    const resp = await handleProvision(req, mockEnv);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"complete"');

    const inputs = dispatchBody.inputs as Record<string, string>;
    expect(inputs.chaos_enabled).toBe("true"); // default preserved
    expect(inputs.chaos_config).toBe('{"fault_rate":0.5,"fault_type":"latency"}');
  });

  it("dispatches lambda runtime and does not inject ECS repo variables", async () => {
    const repoName = "lambda-regression";
    let dispatchBody: Record<string, unknown> = {};
    const ecsVarPatches: string[] = [];
    setupPipelineMocks(repoName, {
      onDispatch: (body) => {
        dispatchBody = parseJsonBody(body);
      },
      onVariablePatch: (name) => {
        ecsVarPatches.push(name);
      },
    });

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/${repoName}/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 188, status: "completed", conclusion: "success", html_url: "https://github.com/run/188" }] }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/${repoName}/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision", status: "completed", conclusion: "success",
          steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }],
        }]
      }), { once: true }),
    );

    for (const name of FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${repoName}/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: name === "RUNTIME_MODE" ? "lambda" : "v" })),
    );
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: repoName,
        domain: "wealth",
        requester_email: "user@test.com",
        runtime: "lambda",
        spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, mockEnv);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"complete"');
    expect((dispatchBody.inputs as Record<string, string>).runtime_mode).toBe("lambda");
    expect((dispatchBody.inputs as Record<string, string>).chaos_enabled).toBe("true");
    expect((dispatchBody.inputs as Record<string, string>).github_workspace_sync).toBe("true");
    expect((dispatchBody.inputs as Record<string, string>).environment_sync_enabled).toBe("true");
    expect((dispatchBody.inputs as Record<string, string>).dependency_targets_json).toBe('{"hard":[],"soft":[]}');
    expect(ecsVarPatches).toContain("POSTMAN_SYSTEM_ENV_PROD");
    expect(ecsVarPatches).toContain("POSTMAN_SYSTEM_ENV_STAGE");
    expect(ecsVarPatches).toContain("POSTMAN_SYSTEM_ENV_DEV");
  });

  it("reuses active dependency nodes, provisions the root, and persists graph memberships", async () => {
    const airtableBaseId = "base-graph-success";
    const dispatchBodies: Array<Record<string, unknown>> = [];
    const airtableCreates: Array<Record<string, unknown>> = [];
    const graphMembershipCreates: Array<Record<string, unknown>> = [];
    const ghApi = setupPipelineMocks("vzw-geospatial-hazard-intel-api", {
      airtableBaseId,
      onDispatch: (body) => {
        dispatchBodies.push(parseJsonBody(body));
      },
      onCreateDeployment: (body) => {
        airtableCreates.push(body);
      },
      onCreateGraphMembership: (body) => {
        graphMembershipCreates.push(body);
      },
      deploymentRecords: [
        {
          id: "rec-vzw-incident-intake-gateway-api",
          fields: {
            spec_id: "vzw-incident-intake-gateway-api",
            status: "active",
            runtime_mode: "k8s_workspace",
            environments_json: JSON.stringify(["prod"]),
            environment_deployments: JSON.stringify([
              {
                environment: "prod",
                runtime_url: "https://runtime.example/svc/vzw-incident-intake-gateway-api",
                status: "active",
              },
            ]),
          },
        },
      ],
    });
    const envWithK8sGraph = {
      ...mockEnv,
      AIRTABLE_BASE_ID: airtableBaseId,
      KUBECONFIG_B64: "ZHVtbXkta3ViZWNvbmZpZw==",
      K8S_INGRESS_BASE_DOMAIN: "apps.demo.internal",
      POSTMAN_SYSTEM_ENV_PROD: "4ed1a682-0394-4d71-b1a8-d24ef1af5c5b",
    } as any;

    server.use(
      http.get("https://example.com/specs/repos/vzw-geospatial-hazard-intel-api/openapi.yaml", () =>
        new HttpResponse("openapi: 3.0.3\npaths: {}\n", { status: 200 })),
    );

    let successRunListCalls = 0;
    server.use(
      http.get(new RegExp("https://api\\.github\\.com/repos/postman-cs/vzw-geospatial-hazard-intel-api/actions/workflows/provision\\.yml/runs"), () => {
        successRunListCalls += 1;
        return HttpResponse.json({
          total_count: 1,
          workflow_runs: [successRunListCalls === 1
            ? { id: 1, status: "completed", conclusion: "success", html_url: "https://github.com/run/1", updated_at: "2026-03-07T00:00:00Z" }
            : { id: 501, status: "completed", conclusion: "success", html_url: "https://github.com/run/501", updated_at: "2026-03-07T00:00:00Z" }],
        });
      })
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision",
          status: "completed",
          conclusion: "success",
          steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }],
        }],
      })),
    );

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: "graph-request-root",
        domain: "cards",
        requester_email: "graph@test.com",
        runtime: "k8s_workspace",
        deployment_mode: "graph",
        spec_source: "vzw-geospatial-hazard-intel-api",
        environments: ["prod"],
        postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, envWithK8sGraph);
    const text = await readSSEStream(resp);
    const events = parseSSEEvents(text);

    expect(dispatchBodies).toHaveLength(1);
    expect((dispatchBodies[0].inputs as Record<string, string>).runtime_mode).toBe("k8s_workspace");

    const reusedEvent = events.find((event) =>
      event.phase === "graph-node"
      && event.status === "complete"
      && event.message?.includes("Reused existing deployment")
      && event.data?.current_spec_id === "vzw-incident-intake-gateway-api");
    expect(reusedEvent?.data?.deployment_root_spec_id).toBe("vzw-geospatial-hazard-intel-api");
    expect(reusedEvent?.data?.layer_index).toBe(0);

    const rootWorkflowEvent = events.find((event) =>
      event.phase === "postman"
      && event.status === "running"
      && event.data?.current_spec_id === "vzw-geospatial-hazard-intel-api");
    expect(rootWorkflowEvent?.data?.deployment_root_spec_id).toBe("vzw-geospatial-hazard-intel-api");
    expect(rootWorkflowEvent?.data?.layer_index).toBe(1);

    const finalEvent = [...events].reverse().find((event) =>
      event.phase === "complete"
      && event.status === "complete"
      && Boolean(event.data?.graph_summary));
    expect(finalEvent?.data?.deployment_group_id).toEqual(expect.any(String));
    expect(finalEvent?.data?.deployment_root_spec_id).toBe("vzw-geospatial-hazard-intel-api");
    const graphSummary = finalEvent?.data?.graph_summary as Record<string, any>;
    expect(graphSummary.success).toBe(true);
    expect(graphSummary.reused_nodes.map((entry: { spec_id: string }) => entry.spec_id)).toEqual(["vzw-incident-intake-gateway-api"]);
    expect(graphSummary.completed_nodes.map((entry: { spec_id: string }) => entry.spec_id)).toEqual(["vzw-geospatial-hazard-intel-api"]);

    const rootCreate = airtableCreates.find((body) => {
      const fields = body.fields as Record<string, unknown> | undefined;
      return fields?.spec_id === "vzw-geospatial-hazard-intel-api";
    });
    expect(rootCreate?.fields).toEqual(expect.objectContaining({
      spec_id: "vzw-geospatial-hazard-intel-api",
      deployment_mode: "single",
    }));
    expect(rootCreate?.fields).not.toHaveProperty("deployment_root_spec_id");
    expect(rootCreate?.fields).not.toHaveProperty("deployment_group_id");
    expect(rootCreate?.fields).not.toHaveProperty("graph_node_meta_json");

    const dependencyGraphMembership = graphMembershipCreates.find((body) => {
      const fields = body.fields as Record<string, unknown> | undefined;
      return fields?.spec_id === "vzw-incident-intake-gateway-api";
    });
    expect(dependencyGraphMembership?.fields).toEqual(expect.objectContaining({
      spec_id: "vzw-incident-intake-gateway-api",
      deployment_root_spec_id: "vzw-geospatial-hazard-intel-api",
      deployment_group_id: expect.any(String),
      environment: "prod",
      layer_index: 0,
      node_status: "reused",
      node_action: "reused",
      runtime_mode: "k8s_workspace",
    }));
    expect(JSON.parse(String((dependencyGraphMembership?.fields as Record<string, unknown>).graph_node_meta_json))).toEqual(expect.objectContaining({
      spec_id: "vzw-incident-intake-gateway-api",
      environment: "prod",
      layer_index: 0,
      node_status: "reused",
      node_action: "reused",
      runtime_mode: "k8s_workspace",
    }));

    const rootGraphMembership = graphMembershipCreates.find((body) => {
      const fields = body.fields as Record<string, unknown> | undefined;
      try {
        return JSON.parse(String(fields?.graph_node_meta_json || "{}")).spec_id === "vzw-geospatial-hazard-intel-api";
      } catch {
        return false;
      }
    });
    expect(rootGraphMembership?.fields).toEqual(expect.objectContaining({
      spec_id: "vzw-geospatial-hazard-intel-api",
      deployment_root_spec_id: "vzw-geospatial-hazard-intel-api",
      deployment_group_id: expect.any(String),
      environment: "prod",
      layer_index: 1,
      node_status: "completed",
      node_action: "provisioned",
      runtime_mode: "k8s_workspace",
    }));
    expect(JSON.parse(String((rootGraphMembership?.fields as Record<string, unknown>).graph_node_meta_json))).toEqual(expect.objectContaining({
      spec_id: "vzw-geospatial-hazard-intel-api",
      environment: "prod",
      layer_index: 1,
      node_status: "completed",
      node_action: "provisioned",
      runtime_mode: "k8s_workspace",
    }));
  });

  it("attaches compatible kubernetes dependencies into a new graph without redispatching them", async () => {
    const airtableBaseId = "base-graph-attach";
    const dispatchBodies: Array<Record<string, unknown>> = [];
    const graphMembershipCreates: Array<Record<string, unknown>> = [];
    const ghApi = setupPipelineMocks("vzw-campus-device-registry-api", {
      airtableBaseId,
      onDispatch: (body) => {
        dispatchBodies.push(parseJsonBody(body));
      },
      onCreateGraphMembership: (body) => {
        graphMembershipCreates.push(body);
      },
      deploymentRecords: [
        {
          id: "rec-vzw-campus-identity-proxy-api",
          fields: {
            spec_id: "vzw-campus-identity-proxy-api",
            status: "active",
            runtime_mode: "k8s_discovery",
            environments_json: JSON.stringify(["prod"]),
            environment_deployments: JSON.stringify([
              {
                environment: "prod",
                runtime_url: "https://runtime.example/svc/vzw-campus-identity-proxy-api",
                status: "active",
              },
            ]),
          },
        },
      ],
    });
    const envWithK8sGraph = {
      ...mockEnv,
      AIRTABLE_BASE_ID: airtableBaseId,
      KUBECONFIG_B64: "ZHVtbXkta3ViZWNvbmZpZw==",
      K8S_INGRESS_BASE_DOMAIN: "apps.demo.internal",
      POSTMAN_SYSTEM_ENV_PROD: "4ed1a682-0394-4d71-b1a8-d24ef1af5c5b",
    } as any;

    server.use(
      http.get("https://example.com/specs/repos/vzw-campus-device-registry-api/openapi.yaml", () =>
        new HttpResponse("openapi: 3.0.3\npaths: {}\n", { status: 200 })),
    );

    let successRunListCalls = 0;
    server.use(
      http.get(new RegExp("https://api\\.github\\.com/repos/postman-cs/vzw-campus-device-registry-api/actions/workflows/provision\\.yml/runs"), () => {
        successRunListCalls += 1;
        return HttpResponse.json({
          total_count: 1,
          workflow_runs: [successRunListCalls === 1
            ? { id: 1, status: "completed", conclusion: "success", html_url: "https://github.com/run/1", updated_at: "2026-03-07T00:00:00Z" }
            : { id: 601, status: "completed", conclusion: "success", html_url: "https://github.com/run/601", updated_at: "2026-03-07T00:00:00Z" }],
        });
      })
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision",
          status: "completed",
          conclusion: "success",
          steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }],
        }],
      })),
    );

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: "graph-request-root",
        domain: "cards",
        requester_email: "graph@test.com",
        runtime: "k8s_workspace",
        deployment_mode: "graph",
        spec_source: "vzw-campus-device-registry-api",
        environments: ["prod"],
        postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, envWithK8sGraph);
    const text = await readSSEStream(resp);
    const events = parseSSEEvents(text);

    expect(dispatchBodies).toHaveLength(1);

    const attachedEvent = events.find((event) =>
      event.phase === "graph-node"
      && event.status === "complete"
      && event.message?.includes("Attached existing deployment")
      && event.data?.current_spec_id === "vzw-campus-identity-proxy-api");
    expect(attachedEvent?.data?.deployment_root_spec_id).toBe("vzw-campus-device-registry-api");

    const finalEvent = [...events].reverse().find((event) =>
      event.phase === "complete"
      && event.status === "complete"
      && Boolean(event.data?.graph_summary));
    const graphSummary = finalEvent?.data?.graph_summary as Record<string, any>;
    expect(graphSummary.success).toBe(true);
    expect(graphSummary.attached_nodes.map((entry: { spec_id: string }) => entry.spec_id)).toEqual([
      "vzw-campus-identity-proxy-api",
    ]);
    expect(graphSummary.reused_nodes).toEqual([]);
    expect(graphSummary.completed_nodes.map((entry: { spec_id: string }) => entry.spec_id)).toEqual(["vzw-campus-device-registry-api"]);

    const attachedMembership = graphMembershipCreates.find((body) => {
      const fields = body.fields as Record<string, unknown> | undefined;
      return fields?.spec_id === "vzw-campus-identity-proxy-api";
    });
    expect(attachedMembership?.fields).toEqual(expect.objectContaining({
      spec_id: "vzw-campus-identity-proxy-api",
      deployment_root_spec_id: "vzw-campus-device-registry-api",
      deployment_group_id: expect.any(String),
      environment: "prod",
      layer_index: 0,
      node_status: "attached",
      node_action: "attached",
      runtime_mode: "k8s_workspace",
    }));
  });

  it("emits a graph-level failure summary when the root node fails", async () => {
    const airtableBaseId = "base-graph-failure";
    const dispatchBodies: Array<Record<string, unknown>> = [];
    const graphMembershipCreates: Array<Record<string, unknown>> = [];
    const ghApi = setupPipelineMocks("vzw-campus-identity-proxy-api", {
      airtableBaseId,
      onDispatch: (body) => {
        dispatchBodies.push(parseJsonBody(body));
      },
      onCreateGraphMembership: (body) => {
        graphMembershipCreates.push(body);
      },
      deploymentRecords: [
        {
          id: "rec-vzw-incident-intake-gateway-api",
          fields: {
            spec_id: "vzw-incident-intake-gateway-api",
            status: "active",
            runtime_mode: "k8s_workspace",
            environments_json: JSON.stringify(["prod"]),
            environment_deployments: JSON.stringify([
              {
                environment: "prod",
                runtime_url: "https://runtime.example/svc/vzw-incident-intake-gateway-api",
                status: "active",
              },
            ]),
          },
        },
        {
          id: "rec-vzw-geospatial-hazard-intel-api",
          fields: {
            spec_id: "vzw-geospatial-hazard-intel-api",
            status: "active",
            runtime_mode: "k8s_workspace",
            environments_json: JSON.stringify(["prod"]),
            environment_deployments: JSON.stringify([
              {
                environment: "prod",
                runtime_url: "https://runtime.example/svc/vzw-geospatial-hazard-intel-api",
                status: "active",
              },
            ]),
          },
        },
      ],
    });
    const envWithK8sGraph = {
      ...mockEnv,
      AIRTABLE_BASE_ID: airtableBaseId,
      KUBECONFIG_B64: "ZHVtbXkta3ViZWNvbmZpZw==",
      K8S_INGRESS_BASE_DOMAIN: "apps.demo.internal",
      POSTMAN_SYSTEM_ENV_PROD: "4ed1a682-0394-4d71-b1a8-d24ef1af5c5b",
    } as any;

    server.use(
      http.get("https://example.com/specs/repos/vzw-campus-identity-proxy-api/openapi.yaml", () =>
        new HttpResponse("openapi: 3.0.3\npaths: {}\n", { status: 200 })),
    );

    let failedRunListCalls = 0;
    server.use(
      http.get(new RegExp("https://api\\.github\\.com/repos/postman-cs/vzw-campus-identity-proxy-api/actions/workflows/provision\\.yml/runs"), () => {
        failedRunListCalls += 1;
        return HttpResponse.json({
          total_count: 1,
          workflow_runs: [failedRunListCalls === 1
            ? { id: 1, status: "completed", conclusion: "success", html_url: "https://github.com/run/1", updated_at: "2026-03-07T00:00:00Z" }
            : { id: 502, status: "completed", conclusion: "failure", html_url: "https://github.com/run/502", updated_at: "2026-03-07T00:00:00Z" }],
        });
      }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision",
          status: "completed",
          conclusion: "failure",
          steps: [{ name: "Summary", status: "completed", conclusion: "failure", number: 1 }],
        }],
      })),
    );

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: "graph-request-root",
        domain: "cards",
        requester_email: "graph@test.com",
        runtime: "k8s_workspace",
        deployment_mode: "graph",
        spec_source: "vzw-campus-identity-proxy-api",
        environments: ["prod"],
        postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, envWithK8sGraph);
    const text = await readSSEStream(resp);
    const events = parseSSEEvents(text);

    expect(dispatchBodies).toHaveLength(1);

    const finalEvent = [...events].reverse().find((event) =>
      event.phase === "complete"
      && event.status === "error"
      && Boolean(event.data?.graph_summary));
    expect(finalEvent?.message).toContain("Workflow failed");
    expect(finalEvent?.data?.deployment_root_spec_id).toBe("vzw-campus-identity-proxy-api");
    const graphSummary = finalEvent?.data?.graph_summary as Record<string, any>;
    expect(graphSummary.success).toBe(false);
    expect(graphSummary.failed_layer_index).toBe(0);
    expect(graphSummary.failed_node.spec_id).toBe("vzw-campus-identity-proxy-api");
    expect(graphSummary.reused_nodes).toEqual([]);
    expect(graphSummary.completed_nodes).toEqual([]);
    expect(graphSummary.not_started_nodes).toEqual([]);

    const rootFailureMembership = graphMembershipCreates.find((body) => {
      const fields = body.fields as Record<string, unknown> | undefined;
      try {
        const meta = JSON.parse(String(fields?.graph_node_meta_json || "{}"));
        return meta.spec_id === "vzw-campus-identity-proxy-api" && meta.node_status === "failed";
      } catch {
        return false;
      }
    });
    expect(rootFailureMembership?.fields).toEqual(expect.objectContaining({
      spec_id: "vzw-campus-identity-proxy-api",
      deployment_root_spec_id: "vzw-campus-identity-proxy-api",
      deployment_group_id: expect.any(String),
      node_status: "failed",
      node_action: "failed",
    }));
  });

  it("treats retry runs as reusable graph nodes and avoids redispatching active children", async () => {
    const airtableBaseId = "base-graph-retry";
    const dispatchBodies: Array<Record<string, unknown>> = [];
    const graphMembershipCreates: Array<Record<string, unknown>> = [];
    const envWithK8sGraph = {
      ...mockEnv,
      AIRTABLE_BASE_ID: airtableBaseId,
      KUBECONFIG_B64: "ZHVtbXkta3ViZWNvbmZpZw==",
      K8S_INGRESS_BASE_DOMAIN: "apps.demo.internal",
      POSTMAN_SYSTEM_ENV_PROD: "4ed1a682-0394-4d71-b1a8-d24ef1af5c5b",
    } as any;
    setupPipelineMocks("vzw-geospatial-hazard-intel-api", {
      airtableBaseId,
      onDispatch: (body) => {
        dispatchBodies.push(parseJsonBody(body));
      },
      onCreateGraphMembership: (body) => {
        graphMembershipCreates.push(body);
      },
      deploymentRecords: [
        {
          id: "rec-vzw-incident-intake-gateway-api",
          fields: {
            spec_id: "vzw-incident-intake-gateway-api",
            status: "active",
            runtime_mode: "k8s_workspace",
            environments_json: JSON.stringify(["prod"]),
            environment_deployments: JSON.stringify([
              {
                environment: "prod",
                runtime_url: "https://runtime.example/svc/vzw-incident-intake-gateway-api",
                status: "active",
              },
            ]),
          },
        },
        {
          id: "rec-vzw-geospatial-hazard-intel-api",
          fields: {
            spec_id: "vzw-geospatial-hazard-intel-api",
            status: "active",
            runtime_mode: "k8s_workspace",
            environments_json: JSON.stringify(["prod"]),
            environment_deployments: JSON.stringify([
              {
                environment: "prod",
                runtime_url: "https://runtime.example/svc/vzw-geospatial-hazard-intel-api",
                status: "active",
              },
            ]),
          },
        },
      ],
    });

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: "graph-request-root",
        domain: "cards",
        requester_email: "graph@test.com",
        runtime: "k8s_workspace",
        deployment_mode: "graph",
        spec_source: "vzw-geospatial-hazard-intel-api",
        environments: ["prod"],
        postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, envWithK8sGraph);
    const text = await readSSEStream(resp);
    const events = parseSSEEvents(text);

    expect(dispatchBodies).toHaveLength(0);

    const finalEvent = [...events].reverse().find((event) =>
      event.phase === "complete"
      && event.status === "complete"
      && Boolean(event.data?.graph_summary));
    expect(finalEvent?.data?.deployment_root_spec_id).toBe("vzw-geospatial-hazard-intel-api");
    const graphSummary = finalEvent?.data?.graph_summary as Record<string, any>;
    expect(graphSummary.success).toBe(true);
    expect(graphSummary.completed_nodes).toEqual([]);
    expect(graphSummary.reused_nodes.map((entry: { spec_id: string }) => entry.spec_id)).toEqual([
      "vzw-incident-intake-gateway-api",
      "vzw-geospatial-hazard-intel-api",
    ]);

    const reusedPatchSpecIds = graphMembershipCreates
      .map((body) => body.fields as Record<string, unknown> | undefined)
      .filter((fields): fields is Record<string, unknown> => Boolean(fields?.deployment_group_id))
      .map((fields) => {
        try {
          return JSON.parse(String(fields.graph_node_meta_json || "{}")).spec_id;
        } catch {
          return "";
        }
      })
      .filter(Boolean)
      .sort();
    expect(reusedPatchSpecIds).toEqual(["vzw-geospatial-hazard-intel-api", "vzw-incident-intake-gateway-api"]);
  });

  it("dispatches ecs_service runtime and injects all ECS repo variables", async () => {
    let dispatchBody: Record<string, unknown> = {};
    const ecsVarPatches: string[] = [];
    const projectName = "ecs-regression";
    const ghApi = setupPipelineMocks(projectName, {
      onDispatch: (body) => {
        dispatchBody = parseJsonBody(body);
      },
      onVariablePatch: (name) => {
        ecsVarPatches.push(name);
      },
    });

    const envWithPool = {
      ...mockEnv,
      POSTMAN_SYSTEM_ENV_PROD: "4ed1a682-0394-4d71-b1a8-d24ef1af5c5b",
      RUNTIME_POOL_ECS_CLUSTER_NAME: "shared-ecs-cluster",
      RUNTIME_POOL_ECS_VPC_ID: "vpc-123",
      RUNTIME_POOL_ECS_SUBNET_IDS: "subnet-1,subnet-2",
      RUNTIME_POOL_ECS_SECURITY_GROUP_IDS: "sg-1",
      RUNTIME_POOL_ECS_EXECUTION_ROLE_ARN: "arn:aws:iam::123456789012:role/ecsExecutionRole",
      RUNTIME_POOL_ECS_ALB_LISTENER_ARN: "arn:aws:elasticloadbalancing:eu-west-2:123456789012:listener/app/shared/abc/def",
      RUNTIME_POOL_ECS_ALB_DNS_NAME: "shared-alb.eu-west-2.elb.amazonaws.com",
      RUNTIME_POOL_ECS_ECR_REPOSITORY: "api-catalog-shared",
    } as any;

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 288, status: "completed", conclusion: "success", html_url: "https://github.com/run/288" }] }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision", status: "completed", conclusion: "success",
          steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }],
        }]
      }), { once: true }),
    );

    for (const name of FINAL_VAR_NAMES) {
      const value = name === "RUNTIME_MODE"
        ? "ecs_service"
        : name === "RUNTIME_BASE_URL"
          ? "http://shared-alb.eu-west-2.elb.amazonaws.com/svc/ecs-regression"
          : "v";
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${projectName}/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value })),
    );
    }
    for (const name of ECS_FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${projectName}/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: `${name.toLowerCase()}-value` })),
    );
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: projectName,
        domain: "wealth",
        requester_email: "user@test.com",
        runtime: "ecs_service",
        spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, envWithPool);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"complete"');
    expect((dispatchBody.inputs as Record<string, string>).runtime_mode).toBe("ecs_service");
    expect((dispatchBody.inputs as Record<string, string>).chaos_enabled).toBe("true");
    expect((dispatchBody.inputs as Record<string, string>).github_workspace_sync).toBe("true");
    expect((dispatchBody.inputs as Record<string, string>).environment_sync_enabled).toBe("true");
    expect((dispatchBody.inputs as Record<string, string>).dependency_targets_json).toBe('{"hard":[],"soft":[]}');
    expect(ecsVarPatches).toContain("POSTMAN_SYSTEM_ENV_PROD");
    expect(ecsVarPatches).toContain("POSTMAN_SYSTEM_ENV_STAGE");
    expect(ecsVarPatches).toContain("ECS_CLUSTER_NAME");
    expect(ecsVarPatches).toContain("ECS_SERVICE_NAME");
    expect(ecsVarPatches).toContain("ECS_TASK_DEFINITION");
  });

  it("dispatches k8s_workspace runtime and injects kubernetes repo variables", async () => {
    let dispatchBody: Record<string, unknown> = {};
    const varPatches: string[] = [];
    const projectName = "k8s-workspace-regression";
    const ghApi = setupPipelineMocks(projectName, {
      onDispatch: (body) => {
        dispatchBody = parseJsonBody(body);
      },
      onVariablePatch: (name) => {
        varPatches.push(name);
      },
    });

    const envWithK8Workspace = {
      ...mockEnv,
      KUBECONFIG_B64: "ZHVtbXkta3ViZWNvbmZpZw==",
      K8S_NAMESPACE: "payments",
      K8S_CONTEXT: "demo-context",
      K8S_INGRESS_BASE_DOMAIN: "apps.demo.internal",
      POSTMAN_SYSTEM_ENV_PROD: "4ed1a682-0394-4d71-b1a8-d24ef1af5c5b",
    } as any;

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 388, status: "completed", conclusion: "success", html_url: "https://github.com/run/388" }] }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision", status: "completed", conclusion: "success",
          steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }],
        }]
      }), { once: true }),
    );

    for (const name of FINAL_VAR_NAMES) {
      const value = name === "RUNTIME_MODE"
        ? "k8s_workspace"
        : name === "RUNTIME_BASE_URL"
          ? "https://k8s-workspace-regression.apps.demo.internal"
          : "v";
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${projectName}/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value })),
    );
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: projectName,
        domain: "wealth",
        requester_email: "user@test.com",
        runtime: "k8s_workspace",
        spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, envWithK8Workspace);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"complete"');
    expect((dispatchBody.inputs as Record<string, string>).runtime_mode).toBe("k8s_workspace");
    expect((dispatchBody.inputs as Record<string, string>).chaos_enabled).toBe("true");
    expect((dispatchBody.inputs as Record<string, string>).github_workspace_sync).toBe("true");
    expect((dispatchBody.inputs as Record<string, string>).environment_sync_enabled).toBe("true");
    expect((dispatchBody.inputs as Record<string, string>).dependency_targets_json).toBe('{"hard":[],"soft":[]}');
    expect(varPatches).toContain("POSTMAN_SYSTEM_ENV_PROD");
    expect(varPatches).toContain("K8S_NAMESPACE");
    expect(varPatches).toContain("K8S_CONTEXT");
    expect(varPatches).toContain("K8S_INGRESS_BASE_DOMAIN");
    expect(varPatches).not.toContain("POSTMAN_INSIGHTS_CLUSTER_NAME");
    expect(varPatches).not.toContain("ECS_CLUSTER_NAME");
    expect(varPatches).not.toContain("ECS_SERVICE_NAME");
  });

  it("uses team-resolved system environments for k8s_workspace preflight when worker fallback envs are empty", async () => {
    let dispatchBody: Record<string, unknown> = {};
    const projectName = "k8s-workspace-team-envs";
    setupPipelineMocks(projectName, {
      onDispatch: (body) => {
        dispatchBody = parseJsonBody(body);
      },
    });

    const envWithTeamScopedK8s = {
      ...mockEnv,
      TEAM_REGISTRY: makeTeamRegistryKV("postman", {
        team_id: "6029",
        team_name: "Postman",
        api_key: "postman-api-key",
        access_token: "postman-access-token",
      }),
      KUBECONFIG_B64: "ZHVtbXkta3ViZWNvbmZpZw==",
      K8S_NAMESPACE: "payments",
      K8S_CONTEXT: "demo-context",
      K8S_INGRESS_BASE_DOMAIN: "apps.demo.internal",
      POSTMAN_SYSTEM_ENV_PROD: "",
      POSTMAN_SYSTEM_ENVS_JSON: "",
    } as any;

    server.use(
      http.post("https://bifrost-premium-https-v4.gw.postman.com/ws/proxy", async ({ request }) => {
        const body = await request.json() as { query?: { teamId?: string } };
        expect(body.query?.teamId).toBe("6029");
        return HttpResponse.json({
          data: [{ id: TEST_MOCK_SYSTEM_ENV_ID, name: "Production", slug: "prod" }],
        });
      }),
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 401, status: "completed", conclusion: "success", html_url: "https://github.com/run/401" }] }), { once: true }),
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
          jobs: [{
            name: "provision",
            status: "completed",
            conclusion: "success",
            steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }],
          }],
        }), { once: true }),
    );

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: projectName,
        domain: "wealth",
        requester_email: "user@test.com",
        runtime: "k8s_workspace",
        spec_url: "https://example.com/spec.yaml",
        postman_team_slug: "postman",
      }),
    });

    const resp = await handleProvision(req, envWithTeamScopedK8s);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"complete"');
    expect((dispatchBody.inputs as Record<string, string>).runtime_mode).toBe("k8s_workspace");
    expect((dispatchBody.inputs as Record<string, string>).system_env_map).toBe(JSON.stringify({ prod: TEST_MOCK_SYSTEM_ENV_ID }));
  });

  it("builds dependency_targets_json from spec_source graph ids when project_name differs", async () => {
    let dispatchBody: Record<string, unknown> = {};
    const projectName = "custom-cards-activation-service";
    const airtableBaseId = "base-custom-cards-activation-service";
    const ghApi = setupPipelineMocks(projectName, {
      onDispatch: (body) => {
        dispatchBody = parseJsonBody(body);
      },
      airtableBaseId,
      deploymentRecords: [
        {
          id: "rec-dep-1",
          fields: {
            spec_id: "vzw-incident-intake-gateway-api",
            status: "active",
            runtime_base_url: "https://svc.cards-3ds.internal",
          },
        },
        {
          id: "rec-dep-2",
          fields: {
            spec_id: "vzw-api-consumer-analytics-api",
            status: "active",
            aws_invoke_url: "https://cards-statements.example/execute",
          },
        },
        {
          id: "rec-dep-inactive",
          fields: {
            spec_id: "vzw-incident-intake-gateway-api",
            status: "failed",
            runtime_base_url: "https://should-not-be-used.internal",
          },
        },
      ],
    });

    const envWithPool = {
      ...mockEnv,
      AIRTABLE_BASE_ID: airtableBaseId,
      POSTMAN_SYSTEM_ENV_PROD: "4ed1a682-0394-4d71-b1a8-d24ef1af5c5b",
      RUNTIME_POOL_ECS_CLUSTER_NAME: "shared-ecs-cluster",
      RUNTIME_POOL_ECS_VPC_ID: "vpc-123",
      RUNTIME_POOL_ECS_SUBNET_IDS: "subnet-1,subnet-2",
      RUNTIME_POOL_ECS_SECURITY_GROUP_IDS: "sg-1",
      RUNTIME_POOL_ECS_EXECUTION_ROLE_ARN: "arn:aws:iam::123456789012:role/ecsExecutionRole",
      RUNTIME_POOL_ECS_ALB_LISTENER_ARN: "arn:aws:elasticloadbalancing:eu-west-2:123456789012:listener/app/shared/abc/def",
      RUNTIME_POOL_ECS_ALB_DNS_NAME: "shared-alb.eu-west-2.elb.amazonaws.com",
      RUNTIME_POOL_ECS_ECR_REPOSITORY: "api-catalog-shared",
    } as any;

    server.use(
      http.get("https://example.com/specs/repos/vzw-geospatial-hazard-intel-api/openapi.yaml", () =>
        new HttpResponse("openapi: 3.0.3\npaths: {}\n", { status: 200 }), { once: true }),
    );

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 908, status: "completed", conclusion: "success", html_url: "https://github.com/run/908" }] }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision", status: "completed", conclusion: "success",
          steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }],
        }],
      }), { once: true }),
    );

    for (const name of FINAL_VAR_NAMES) {
      const value = name === "RUNTIME_MODE"
        ? "ecs_service"
        : name === "RUNTIME_BASE_URL"
          ? "http://shared-alb.eu-west-2.elb.amazonaws.com/svc/custom-cards-activation-service"
          : "v";
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${projectName}/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value })),
    );
    }
    for (const name of ECS_FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${projectName}/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: `${name.toLowerCase()}-value` })),
    );
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: projectName,
        domain: "cards",
        requester_email: "user@test.com",
        runtime: "ecs_service",
        spec_source: "vzw-geospatial-hazard-intel-api",
        postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, envWithPool);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"complete"');
    const dispatchInputs = (dispatchBody.inputs || {}) as Record<string, string>;
    expect(dispatchInputs.runtime_mode).toBe("ecs_service");
    expect(JSON.parse(dispatchInputs.dependency_targets_json || "[]")).toEqual({
      hard: ["https://svc.cards-3ds.internal"],
      soft: ["https://cards-statements.example/execute"],
    });
  });

  it("dispatches k8s_discovery dependency targets as ClusterIP DNS URLs", async () => {
    let dispatchBody: Record<string, unknown> = {};
    const projectName = "k8s-discovery-dependency-descriptors";
    const ghApi = setupPipelineMocks(projectName, {
      onDispatch: (body) => {
        dispatchBody = parseJsonBody(body);
      },
      discoveryInfraStatus: "active",
      airtableBaseId: "base-k8s-discovery-dependency-descriptors",
    });

    const envWithK8Discovery = {
      ...mockEnv,
      AIRTABLE_BASE_ID: "base-k8s-discovery-dependency-descriptors",
      KUBECONFIG_B64: "ZHVtbXkta3ViZWNvbmZpZw==",
      K8S_INGRESS_BASE_DOMAIN: "apps.demo.internal",
      POSTMAN_INSIGHTS_CLUSTER_NAME: "demo-cluster",
    } as any;

    server.use(
      http.get("https://example.com/specs/repos/vzw-geospatial-hazard-intel-api/openapi.yaml", () =>
        new HttpResponse("openapi: 3.0.3\ninfo:\n  title: Card Activation API\n  version: 1.0.0\npaths: {}\n", { status: 200 }), { once: true }),
    );

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 490, status: "completed", conclusion: "success", html_url: "https://github.com/run/490" }] }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision", status: "completed", conclusion: "success",
          steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }],
        }],
      }), { once: true }),
    );

    for (const name of FINAL_VAR_NAMES) {
      const value = name === "RUNTIME_MODE"
        ? "k8s_discovery"
        : name === "RUNTIME_BASE_URL"
          ? "https://apps.demo.internal/svc/k8s-discovery-dependency-descriptors"
          : "v";
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${projectName}/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value })),
    );
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: projectName,
        domain: "cards",
        requester_email: "user@test.com",
        runtime: "k8s_discovery",
        spec_source: "vzw-geospatial-hazard-intel-api",
        postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, envWithK8Discovery);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"complete"');
    const dispatchInputs = (dispatchBody.inputs || {}) as Record<string, string>;
    expect(dispatchInputs.runtime_mode).toBe("k8s_discovery");
    expect(JSON.parse(dispatchInputs.dependency_targets_json || "[]")).toEqual({
      hard: [
        "http://vzw-incident-intake-gateway-api-prod.vzw-partner-demo.svc.cluster.local/svc/vzw-incident-intake-gateway-api-prod",
        "http://vzw-incident-intake-gateway-api-stage.vzw-partner-demo.svc.cluster.local/svc/vzw-incident-intake-gateway-api-stage",
        "http://vzw-incident-intake-gateway-api-dev.vzw-partner-demo.svc.cluster.local/svc/vzw-incident-intake-gateway-api-dev",
      ],
      soft: [
        "http://vzw-api-consumer-analytics-api-prod.vzw-partner-demo.svc.cluster.local/svc/vzw-api-consumer-analytics-api-prod",
        "http://vzw-api-consumer-analytics-api-stage.vzw-partner-demo.svc.cluster.local/svc/vzw-api-consumer-analytics-api-stage",
        "http://vzw-api-consumer-analytics-api-dev.vzw-partner-demo.svc.cluster.local/svc/vzw-api-consumer-analytics-api-dev",
      ],
    });
  });

  it("dispatches k8s_discovery runtime, injects cluster vars, and does not require POSTMAN_ACCESS_TOKEN", async () => {
    let dispatchBody: Record<string, unknown> = {};
    const varPatches: string[] = [];
    const projectName = "k8s-discovery-regression";
    const ghApi = setupPipelineMocks(projectName, {
      onDispatch: (body) => {
        dispatchBody = parseJsonBody(body);
      },
      onVariablePatch: (name) => {
        varPatches.push(name);
      },
      discoveryInfraStatus: "active",
      airtableBaseId: "base-k8s-discovery-regression",
    });

    const envWithK8Discovery = {
      ...mockEnv,
      POSTMAN_ACCESS_TOKEN: "",
      AIRTABLE_BASE_ID: "base-k8s-discovery-regression",
      KUBECONFIG_B64: "ZHVtbXkta3ViZWNvbmZpZw==",
      K8S_INGRESS_BASE_DOMAIN: "apps.demo.internal",
      POSTMAN_INSIGHTS_CLUSTER_NAME: "demo-cluster",
    } as any;

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 488, status: "completed", conclusion: "success", html_url: "https://github.com/run/488" }] }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision", status: "completed", conclusion: "success",
          steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }],
        }]
      }), { once: true }),
    );

    for (const name of FINAL_VAR_NAMES) {
      const value = name === "RUNTIME_MODE"
        ? "k8s_discovery"
        : name === "RUNTIME_BASE_URL"
          ? "https://k8s-discovery-regression.apps.demo.internal"
          : "v";
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${projectName}/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value })),
    );
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: projectName,
        domain: "wealth",
        requester_email: "user@test.com",
        runtime: "k8s_discovery",
        spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, envWithK8Discovery);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"complete"');
    expect((dispatchBody.inputs as Record<string, string>).runtime_mode).toBe("k8s_discovery");
    expect((dispatchBody.inputs as Record<string, string>).chaos_enabled).toBe("true");
    expect((dispatchBody.inputs as Record<string, string>).github_workspace_sync).toBe("false");
    expect((dispatchBody.inputs as Record<string, string>).environment_sync_enabled).toBe("true");
    expect((dispatchBody.inputs as Record<string, string>).k8s_discovery_workspace_link).toBe("false");
    expect((dispatchBody.inputs as Record<string, string>).dependency_targets_json).toBe('{"hard":[],"soft":[]}');
    expect(varPatches).toContain("K8S_NAMESPACE");
    expect(varPatches).toContain("K8S_INGRESS_BASE_DOMAIN");
    expect(varPatches).toContain("POSTMAN_INSIGHTS_CLUSTER_NAME");
    expect(varPatches).toContain("POSTMAN_SYSTEM_ENV_PROD");
    expect(varPatches).toContain("POSTMAN_SYSTEM_ENV_STAGE");
    expect(varPatches).not.toContain("ECS_CLUSTER_NAME");
    expect(varPatches).not.toContain("ECS_SERVICE_NAME");
  });

  it("dispatches k8s_discovery runtime with workspace-link toggle enabled", async () => {
    let dispatchBody: Record<string, unknown> = {};
    const projectName = "k8s-discovery-link-true";
    const ghApi = setupPipelineMocks(projectName, {
      onDispatch: (body) => {
        dispatchBody = parseJsonBody(body);
      },
      discoveryInfraStatus: "active",
      airtableBaseId: "base-k8s-discovery-link-true",
    });

    const envWithK8Discovery = {
      ...mockEnv,
      AIRTABLE_BASE_ID: "base-k8s-discovery-link-true",
      KUBECONFIG_B64: "ZHVtbXkta3ViZWNvbmZpZw==",
      K8S_INGRESS_BASE_DOMAIN: "apps.demo.internal",
      POSTMAN_INSIGHTS_CLUSTER_NAME: "demo-cluster",
    } as any;

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 489, status: "completed", conclusion: "success", html_url: "https://github.com/run/489" }] }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision", status: "completed", conclusion: "success",
          steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }],
        }]
      }), { once: true }),
    );

    for (const name of FINAL_VAR_NAMES) {
      const value = name === "RUNTIME_MODE" ? "k8s_discovery" : "v";
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${projectName}/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value })),
    );
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: projectName,
        domain: "wealth",
        requester_email: "user@test.com",
        runtime: "k8s_discovery",
        k8s_discovery_workspace_link: true,
        spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, envWithK8Discovery);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"complete"');
    expect((dispatchBody.inputs as Record<string, string>).runtime_mode).toBe("k8s_discovery");
    expect((dispatchBody.inputs as Record<string, string>).chaos_enabled).toBe("true");
    expect((dispatchBody.inputs as Record<string, string>).github_workspace_sync).toBe("true");
    expect((dispatchBody.inputs as Record<string, string>).environment_sync_enabled).toBe("true");
    expect((dispatchBody.inputs as Record<string, string>).k8s_discovery_workspace_link).toBe("true");
    expect((dispatchBody.inputs as Record<string, string>).dependency_targets_json).toBe('{"hard":[],"soft":[]}');
  });

  it("uses registry spec URL from request payload", async () => {
    const ghApi = setupPipelineMocks("registry-spec-selected");

    server.use(
      http.get("https://example.com/specs/repos/vzw-incident-intake-gateway-api/openapi.yaml", () =>
        new HttpResponse("openapi: 3.0.3\npaths: {}\n", { status: 200 }), { once: true }),
    );

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 44, status: "completed", conclusion: "success", html_url: "https://github.com/run/44" }] }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision", status: "completed", conclusion: "success",
          steps: [
            { name: "Create Postman Workspace", status: "completed", conclusion: "success", number: 1 },
            { name: "Deploy Lambda Functions", status: "completed", conclusion: "success", number: 2 },
            { name: "Summary", status: "completed", conclusion: "success", number: 3 },
          ]
        }]
      }), { once: true }),
    );

    for (const name of FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/registry-spec-selected/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: `v-${name}` })),
    );
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: "registry-spec-selected",
        domain: "wealth",
        requester_email: "user@portal-api.test",
        spec_source: "vzw-incident-intake-gateway-api",
        spec_url: "https://spec-host.test/spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, mockEnv, portalProvisionConfig);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"complete"');
  });

  it("returns a clear error when inline spec_content is provided", async () => {
    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: "bad-upload",
        domain: "wealth",
        requester_email: "user@portal-api.test",
        spec_source: "payments-api",
        spec_url: "https://spec-host.test/spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
        spec_content: "openapi: 3.0.3\npaths: {}\n",
      }),
    });

    const resp = await handleProvision(req, mockEnv, portalProvisionConfig);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"error"');
    expect(text).toContain("Inline spec_content is no longer supported");
  });

  it("returns a clear error when custom source is requested", async () => {
    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: "bad-url",
        domain: "wealth",
        requester_email: "user@portal-api.test",
        spec_source: "custom-url",
        spec_url: "https://spec-host.test/spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, mockEnv, portalProvisionConfig);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"error"');
    expect(text).toContain("Custom spec sources are no longer supported");
  });

  it("returns a clear error when spec_source is missing", async () => {
    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: "missing-spec-url",
        domain: "wealth",
        requester_email: "user@portal-api.test",
        postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, mockEnv, portalProvisionConfig);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"error"');
    expect(text).toContain("spec_source is required");
  });

  it("streams error when createRepo fails", async () => {
    setGitHubOrg("postman-cs-create-fail");
    const env = { ...mockEnv, AIRTABLE_BASE_ID: "base-create-repo-fails" };
    setupAirtableMocks(env.AIRTABLE_BASE_ID as string);
    server.use(
      http.get(`https://api.github.com/repos/postman-cs-create-fail/fail-test`, () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 })),
    );
    server.use(
      http.post(`https://api.github.com/orgs/postman-cs-create-fail/repos`, () =>
        HttpResponse.json({ message: "already exists" }, { status: 422 }), { once: true }),
    );

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "fail-test", domain: "wealth", requester_email: "user@test.com", spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG }),
    });

    const resp = await handleProvision(req, env);
    const text = await readSSEStream(resp);
    expect(text).toContain('"status":"error"');
    expect(text).toContain("Failed to create repo: already exists");
  });

  it("reconciles to active when repo creation errors but a successful provision run already exists", async () => {
    setGitHubOrg("postman-cs-create-fail");
    const env = { ...mockEnv, AIRTABLE_BASE_ID: "base-reconcile-create-repo" };
    const patchedBodies: Record<string, unknown>[] = [];
    setupAirtableMocks(env.AIRTABLE_BASE_ID as string, {
      deploymentRecords: [
        {
          id: "rec-fail-test",
          fields: {
            spec_id: "fail-test",
            status: "failed",
            github_repo_name: "fail-test",
            github_repo_url: "https://github.com/postman-cs-create-fail/fail-test",
            environments_json: JSON.stringify(["stage"]),
            failed_at_step: "provisioning",
            error_message: "Failed to create repo: Repository creation failed.",
          },
        },
      ],
      onPatchDeployment: (_recordId, body) => {
        patchedBodies.push(body.fields as Record<string, unknown>);
      },
    });
    server.use(
      http.get(`https://api.github.com/repos/postman-cs-create-fail/fail-test`, () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 })),
    );
    server.use(
      http.post(`https://api.github.com/orgs/postman-cs-create-fail/repos`, () =>
        HttpResponse.json({ message: "already exists" }, { status: 422 }), { once: true }),
    );
    server.use(
      http.get("https://api.github.com/repos/postman-cs-create-fail/fail-test/actions/runs", () =>
        HttpResponse.json({
        workflow_runs: [
          {
            id: 22815860705,
            name: "Provision API Lifecycle",
            path: ".github/workflows/provision.yml",
            status: "completed",
            conclusion: "success",
            html_url: `https://github.com/${TEST_GITHUB_ORG}/fail-test/actions/runs/22815860705`,
            updated_at: "2026-03-08T06:48:06Z",
            event: "workflow_dispatch",
            head_branch: "main",
            created_at: "2026-03-08T06:45:52Z",
          },
        ],
      }), { once: true }),
    );
    server.use(
      http.get("https://api.github.com/repos/postman-cs-create-fail/fail-test/actions/variables", () =>
        HttpResponse.json({
          variables: [
            { name: "RUNTIME_MODE", value: "k8s_workspace" },
            { name: "RUNTIME_BASE_URL", value: "https://runtime.example/svc/fail-test/" },
            { name: "ENVIRONMENT_DEPLOYMENTS_JSON", value: JSON.stringify([{ environment: "prod", runtime_url: "https://runtime.example/svc/fail-test", status: "active" }]) },
            { name: "POSTMAN_WORKSPACE_ID", value: "ws-123" },
            { name: "POSTMAN_SPEC_UID", value: "spec-123" },
            { name: "POSTMAN_BASELINE_COLLECTION_UID", value: "baseline-123" },
            { name: "POSTMAN_SMOKE_COLLECTION_UID", value: "smoke-123" },
            { name: "POSTMAN_CONTRACT_COLLECTION_UID", value: "contract-123" },
          ],
        })),
    );

    server.use(
      http.post("https://bifrost-premium-https-v4.gw.postman.com/ws/proxy", () =>
        HttpResponse.json({ data: [{ id: "sys-prod", name: "Production", slug: "prod" }] })),
    );

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "fail-test", domain: "wealth", requester_email: "user@test.com", spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG }),
    });

    const resp = await handleProvision(req, env);
    const text = await readSSEStream(resp);
    expect(text).toContain('"status":"complete"');
    expect(text).toContain("Provisioning complete!");
    expect(patchedBodies.some((fields) => fields.status === "active")).toBe(true);
    expect(patchedBodies.some((fields) => {
      if (typeof fields.environments_json !== "string") return false;
      return JSON.parse(fields.environments_json).includes("prod");
    })).toBe(true);
  });

  it("streams clear error when GH_TOKEN is blank", async () => {
    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "blank-token", domain: "wealth", requester_email: "user@test.com", spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG }),
    });

    const resp = await handleProvision(req, { ...mockEnv, GH_TOKEN: " \n\t " });
    const text = await readSSEStream(resp);
    expect(text).toContain('"status":"error"');
    expect(text).toContain("GH_TOKEN is missing or empty");
  });

  it("handles workflow that fails", async () => {
    const ghApi = setupPipelineMocks("wf-fail");

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 77, status: "completed", conclusion: "failure", html_url: "https://github.com/run/77" }] }), { once: true }),
    );

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision", status: "completed", conclusion: "failure",
          steps: [{ name: "Deploy Lambda Functions", status: "completed", conclusion: "failure", number: 1 }]
        }]
      }), { once: true }),
    );

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "wf-fail", domain: "payments", requester_email: "u@t.com", spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG }),
    });

    const resp = await handleProvision(req, mockEnv);
    const text = await readSSEStream(resp);
    expect(text).toContain('"status":"error"');
    expect(text).toContain("Workflow failed");
  });

  it("handles in_progress step status", async () => {
    const ghApi = setupPipelineMocks("prog");

    // Find-run poll: in_progress (sets runId)
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 88, status: "in_progress", conclusion: null, html_url: "https://github.com/run/88" }] }), { once: true }),
    );

    // Main loop iteration 1: still in_progress (exercises in_progress step handling)
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision", status: "in_progress", conclusion: null,
          steps: [{ name: "Install Postman CLI", status: "in_progress", conclusion: null, number: 1 }]
        }]
      }), { once: true }),
    );

    // Main loop iteration 2: completed
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision", status: "completed", conclusion: "success",
          steps: [
            { name: "Install Postman CLI", status: "completed", conclusion: "success", number: 1 },
            { name: "Summary", status: "completed", conclusion: "success", number: 2 },
          ]
        }]
      }), { once: true }),
    );

    for (const name of FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/prog/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: "v" })),
    );
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "prog", domain: "platform", requester_email: "u@t.com", environments: ["dev"], spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG }),
    });

    const resp = await handleProvision(req, mockEnv);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"complete"');
  });

  it("handles polling retry when workflow run not immediately found", async () => {
    const ghApi = setupPipelineMocks("poll-retry");

    // First getLatestWorkflowRun → null (triggers polling retry)
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 0, workflow_runs: [] }), { once: true }),
    );

    // Second getLatestWorkflowRun → found
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 42, status: "completed", conclusion: "success", html_url: "https://github.com/run/42" }] }), { once: true }),
    );

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision", status: "completed", conclusion: "success",
          steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }]
        }]
      }), { once: true }),
    );

    for (const name of FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/poll-retry/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: "v" })),
    );
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "poll-retry", domain: "wealth", requester_email: "u@t.com", spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG }),
    });

    const resp = await handleProvision(req, mockEnv);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"complete"');
    expect(text).toContain('"status":"complete"');
  });

  it("fails when team registry has no matching team entry", async () => {
    setupPipelineMocks("sec-fail");

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "sec-fail", domain: "wealth", requester_email: "u@t.com", spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG }),
    });

    const resp = await handleProvision(req, {
      ...mockEnv,
      TEAM_REGISTRY: makeEmptyTeamRegistryKV(),
    } as any);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"error"');
    expect(text).toContain("Unknown team slug");
  });

  it("fails when team registry credentials are unavailable for ecs_service runtime", async () => {
    setupPipelineMocks("ecs-missing-access-token");

    const envWithoutTeam = {
      ...mockEnv,
      TEAM_REGISTRY: makeEmptyTeamRegistryKV(),
      POSTMAN_SYSTEM_ENV_PROD: "4ed1a682-0394-4d71-b1a8-d24ef1af5c5b",
      AIRTABLE_API_KEY: "airtable-key",
      AIRTABLE_BASE_ID: "base-test",
      RUNTIME_POOL_ECS_CLUSTER_NAME: "shared-ecs-cluster",
      RUNTIME_POOL_ECS_VPC_ID: "vpc-123",
      RUNTIME_POOL_ECS_SUBNET_IDS: "subnet-1,subnet-2",
      RUNTIME_POOL_ECS_SECURITY_GROUP_IDS: "sg-1",
      RUNTIME_POOL_ECS_EXECUTION_ROLE_ARN: "arn:aws:iam::123456789012:role/ecsExecutionRole",
      RUNTIME_POOL_ECS_ALB_LISTENER_ARN: "arn:aws:elasticloadbalancing:eu-west-2:123456789012:listener/app/shared/abc/def",
      RUNTIME_POOL_ECS_ALB_DNS_NAME: "shared-alb.eu-west-2.elb.amazonaws.com",
      RUNTIME_POOL_ECS_ECR_REPOSITORY: "api-catalog-shared",
    } as any;

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: "ecs-missing-access-token",
        domain: "wealth",
        requester_email: "u@t.com",
        runtime: "ecs_service",
        spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, envWithoutTeam);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"error"');
    expect(text).toContain("Unknown team slug");
  });

  it("fails when team registry credentials are unavailable for k8s_workspace runtime", async () => {
    setupPipelineMocks("k8s-workspace-missing-access-token");

    const envWithoutTeam = {
      ...mockEnv,
      TEAM_REGISTRY: makeEmptyTeamRegistryKV(),
      KUBECONFIG_B64: "ZHVtbXkta3ViZWNvbmZpZw==",
      K8S_INGRESS_BASE_DOMAIN: "apps.demo.internal",
      POSTMAN_SYSTEM_ENV_PROD: "4ed1a682-0394-4d71-b1a8-d24ef1af5c5b",
      AIRTABLE_API_KEY: "airtable-key",
      AIRTABLE_BASE_ID: "base-test",
    } as any;

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: "k8s-workspace-missing-access-token",
        domain: "wealth",
        requester_email: "u@t.com",
        runtime: "k8s_workspace",
        spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, envWithoutTeam);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"error"');
    expect(text).toContain("Unknown team slug");
  });

  it("fails when team registry credentials are unavailable for k8s_discovery runtime with workspace-link enabled", async () => {
    setupPipelineMocks("k8s-discovery-missing-access-token", {
      discoveryInfraStatus: "active",
      airtableBaseId: "base-k8s-discovery-missing-access-token",
    });

    const envWithoutTeam = {
      ...mockEnv,
      TEAM_REGISTRY: makeEmptyTeamRegistryKV(),
      AIRTABLE_BASE_ID: "base-k8s-discovery-missing-access-token",
      KUBECONFIG_B64: "ZHVtbXkta3ViZWNvbmZpZw==",
      K8S_INGRESS_BASE_DOMAIN: "apps.demo.internal",
      POSTMAN_INSIGHTS_CLUSTER_NAME: "demo-cluster",
    } as any;

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: "k8s-discovery-missing-access-token",
        domain: "wealth",
        requester_email: "user@test.com",
        runtime: "k8s_discovery",
        k8s_discovery_workspace_link: true,
        spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, envWithoutTeam);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"error"');
    expect(text).toContain("Unknown team slug");
  });

  it("fails k8s_discovery preflight when POSTMAN_INSIGHTS_CLUSTER_NAME is missing", async () => {
    setupAirtableMocks();
    const envMissingClusterName = {
      ...mockEnv,
      KUBECONFIG_B64: "ZHVtbXkta3ViZWNvbmZpZw==",
      K8S_INGRESS_BASE_DOMAIN: "apps.demo.internal",
    } as any;

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: "k8s-discovery-missing-cluster",
        domain: "wealth",
        requester_email: "u@t.com",
        runtime: "k8s_discovery",
        spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, envMissingClusterName);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"error"');
    expect(text).toContain("POSTMAN_INSIGHTS_CLUSTER_NAME");
  });

  it("fails k8s_discovery preflight when shared discovery infrastructure is inactive", async () => {
    setupAirtableMocks("base-k8s-discovery-infra-inactive", { discoveryInfraStatus: "inactive" });
    const envWithK8Discovery = {
      ...mockEnv,
      AIRTABLE_BASE_ID: "base-k8s-discovery-infra-inactive",
      KUBECONFIG_B64: "ZHVtbXkta3ViZWNvbmZpZw==",
      K8S_INGRESS_BASE_DOMAIN: "apps.demo.internal",
      POSTMAN_INSIGHTS_CLUSTER_NAME: "demo-cluster",
    } as any;

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: "k8s-discovery-infra-inactive",
        domain: "wealth",
        requester_email: "u@t.com",
        runtime: "k8s_discovery",
        spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, envWithK8Discovery);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"error"');
    expect(text).toContain("Kubernetes discovery shared infrastructure is inactive");
  });

  it("test_provision_pipeline_org_credentials_mode_end_to_end", async () => {
    let dispatchBody: Record<string, unknown> = {};
    const varPatches: string[] = [];
    const projectName = "org-creds-mode";

    const ghApi = setupPipelineMocks(projectName, {
      onDispatch: (body) => { dispatchBody = parseJsonBody(body); },
      onVariablePatch: (name) => { varPatches.push(name); },
    });

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 401, status: "completed", conclusion: "success", html_url: "https://github.com/run/401" }] }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{ name: "provision", status: "completed", conclusion: "success", steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }] }]
      }), { once: true }),
    );

    for (const name of FINAL_VAR_NAMES) {
      server.use(
        http.get(`https://api.github.com/repos/postman-cs/${projectName}/actions/variables/${name}`, () =>
          HttpResponse.json({ name, value: "v" }), { once: true }),
      );
    }
    for (const name of ECS_FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${projectName}/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: "v" })),
    );
    }

    server.use(
      http.patch(new RegExp(`https://api\.github\.com/repos/postman-cs/${projectName}/actions/variables/.*`), async ({ request }) => {
        const parts = new URL(request.url).pathname.split("/");
        varPatches.push(parts[parts.length - 1]);
        return HttpResponse.json({});
      }),
      http.post(`https://api.github.com/repos/postman-cs/${projectName}/actions/variables`, async ({ request }) => {
        try {
          const payload = await request.json() as any;
          if (payload.name) varPatches.push(payload.name);
        } catch { }
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    const envWithFlags: any = {
      ...mockEnv,
      ORG_SECRETS_ENABLED: "true",
      ORG_VARS_ENABLED: "true",
      POSTMAN_SYSTEM_ENV_PROD: "4ed1a682-0394-4d71-b1a8-d24ef1af5c5b",
      RUNTIME_POOL_ECS_CLUSTER_NAME: "shared-ecs-cluster",
      RUNTIME_POOL_ECS_VPC_ID: "vpc-123",
      RUNTIME_POOL_ECS_SUBNET_IDS: "subnet-1,subnet-2",
      RUNTIME_POOL_ECS_SECURITY_GROUP_IDS: "sg-1",
      RUNTIME_POOL_ECS_EXECUTION_ROLE_ARN: "arn:aws:iam::123456789012:role/ecsExecutionRole",
      RUNTIME_POOL_ECS_ALB_LISTENER_ARN: "arn:aws:elasticloadbalancing:eu-west-2:123456789012:listener/app/shared/abc/def",
      RUNTIME_POOL_ECS_ALB_DNS_NAME: "shared-alb.eu-west-2.elb.amazonaws.com",
      RUNTIME_POOL_ECS_ECR_REPOSITORY: "api-catalog-shared",
    };

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: projectName, domain: "wealth", requester_email: "u@t.com", runtime: "ecs_service", spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG }),
    });

    const resp = await handleProvision(req, envWithFlags);
    const text = await readSSEStream(resp);
    console.log("varPatches debug array", varPatches);
    expect(text).toContain('"phase":"complete"');

    // Asserts that no repo shared-var API calls were made
    expect(varPatches).not.toContain("ECS_CLUSTER_NAME");
    expect(varPatches).not.toContain("ECS_VPC_ID");

    // Non-shared should still be patched
    expect(varPatches).toContain("RUNTIME_MODE");

    // dispatch body should still resolve correctly
    expect((dispatchBody.inputs as Record<string, string>).runtime_mode).toBe("ecs_service");


  });

  it("test_callback_progress_parity_with_polling_shadow_mode", async () => {
    const projectName = "callback-shadow-mode";

    const ghApi = setupPipelineMocks(projectName);

    let runStatus = "queued";
    let runConclusion = null as string | null;

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 402, status: "queued", conclusion: null, html_url: "https://github.com/run/402" }] }), { once: true }),
    );

    server.use(
      http.get(new RegExp(`https://api\.github\.com/repos/postman-cs/${projectName}/actions/runs/402$`), () =>
        HttpResponse.json({ id: 402, status: runStatus, conclusion: runConclusion, html_url: "https://github.com/run/402", updated_at: new Date().toISOString() })),
      http.get(new RegExp(`https://api\.github\.com/repos/postman-cs/${projectName}/actions/runs/402/jobs`), () =>
        HttpResponse.json({ jobs: [{ name: "provision", status: runStatus, conclusion: runConclusion, steps: [{ name: "Summary", status: runStatus, conclusion: runConclusion, number: 1 }] }] })),
    );

    for (const name of FINAL_VAR_NAMES) {
      server.use(
        http.get(`https://api.github.com/repos/postman-cs/${projectName}/actions/variables/${name}`, () =>
          HttpResponse.json({ name, value: "v" }), { once: true }),
      );
    }

    const envWithFlags: any = {
      ...mockEnv,
      WORKFLOW_CALLBACKS_ENABLED: "true",
      PROVISION_STATE: {
        put: async () => { },
        get: async () => {
          if (runStatus === "completed") {
            return JSON.stringify({ delivery: "del-id", event: "workflow_run", status: "completed", conclusion: "success", htmlUrl: "https://github.com" });
          }
          return null;
        }
      }
    };

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: projectName, domain: "wealth", requester_email: "u@t.com", runtime: "lambda", spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG }),
    });

    const provisionPromise = handleProvision(req, envWithFlags);

    setTimeout(() => {
      runStatus = "in_progress";
    }, 10);
    setTimeout(() => {
      runStatus = "completed";
      runConclusion = "success";
    }, 20);

    const resp = await provisionPromise;
    const text = await readSSEStream(resp);

    expect(text).toContain("Workflow callback shadow mode enabled");
    expect(text).toContain('"phase":"complete"');
  });

});

describe("buildFinalData", () => {
  afterAll(() => server.close());
  beforeEach(async () => {
    await setupFetchMock();
    server.use(
      http.post("https://bifrost-premium-https-v4.gw.postman.com/ws/proxy", () =>
        HttpResponse.json({ data: [
          { id: TEST_MOCK_SYSTEM_ENV_ID, name: "Production", slug: "prod" },
          { id: "7a942017-f58c-4f7d-995b-017e08287e0b", name: "Stage", slug: "stage" },
          { id: "3c360982-f58c-4f7d-995b-017e08287e0b", name: "Development", slug: "dev" },
        ] })),
    );
  });

  afterEach(() => {
    teardownFetchMock({ assertNoPendingInterceptors: false });
  });

  it("fetches repo variables and builds summary", async () => {

    const values: Record<string, string> = {
      POSTMAN_WORKSPACE_ID: "ws-abc",
      POSTMAN_SPEC_UID: "spec-uid",
      POSTMAN_BASELINE_COLLECTION_UID: "baseline-uid",
      POSTMAN_SMOKE_COLLECTION_UID: "smoke-uid",
      POSTMAN_CONTRACT_COLLECTION_UID: "contract-uid",
      POSTMAN_RUN_URL: "",
      POSTMAN_ENVIRONMENT_UID: "env-prod",
      POSTMAN_ENV_UIDS_JSON: "{\"prod\":\"env-prod\",\"stage\":\"env-stage\"}",
      POSTMAN_SYSTEM_ENV_PROD: "sys-prod",
      POSTMAN_SYSTEM_ENV_STAGE: "sys-stage",
      DEV_GW_URL: "https://abc123.execute-api.us-east-1.amazonaws.com/",
      DEV_API_ID: "abc123",
      STAGE_GW_URL: "https://stage123.execute-api.us-east-1.amazonaws.com/",
      STAGE_API_ID: "stage123",
      PROD_GW_URL: "https://abc123.execute-api.us-east-1.amazonaws.com/",
      PROD_API_ID: "abc123",
      MOCK_URL: "https://mock.pstmn.io",
      FUNCTION_NAME: "test-dev",
      RUNTIME_MODE: "lambda",
      RUNTIME_BASE_URL: "",
      LINT_WARNINGS: "21",
      LINT_ERRORS: "0",
      FERN_DOCS_URL: "https://vzw-demo.docs.buildwithfern.com",
    };

    // listRepoVariables bulk mock
    server.use(
      http.get("https://api.github.com/repos/postman-cs/test/actions/variables", () =>
        HttpResponse.json({ variables: Object.entries(values).map(([name, value]) => ({ name, value })) }), { once: true }),
    );

    for (const name of FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/test/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: values[name] }), { once: true }),
    );
    }

    const result = await buildFinalData("token", "test", {
      project_name: "test",
      requester_email: "x@x.com",
      domain: "wealth",
      environments: ["prod", "stage"],
    } as any);

    expect((result.postman as any).workspace_url).toContain("ws-abc");
    expect((result.postman as any).smoke_uid).toBe("smoke-uid");
    expect((result.aws as any).invoke_url).not.toMatch(/\/$/);
    expect((result.aws as any).api_gateway_id).toBe("abc123");
    expect((result.aws as any).function_name).toBe("test-dev");
    expect((result.runtime as any).mode).toBe("lambda");
    expect((result.fern as any).docs_url).toBe("https://vzw-demo.docs.buildwithfern.com");
    expect((result.environment_deployments as any[])).toHaveLength(2);
    expect((result.environment_deployments as any[])[0]).toMatchObject({
      environment: "prod",
      runtime_url: "https://abc123.execute-api.us-east-1.amazonaws.com",
      postman_env_uid: "env-prod",
      system_env_id: "sys-prod",
      status: "active",
      branch: "env/prod",
    });
    expect((result.environment_deployments as any[])[1]).toMatchObject({
      environment: "stage",
      runtime_url: "https://stage123.execute-api.us-east-1.amazonaws.com",
      postman_env_uid: "env-stage",
      system_env_id: "sys-stage",
      status: "active",
      branch: "env/stage",
    });
  });

  it("handles missing variables gracefully", async () => {

    // listRepoVariables returns empty (simulates all vars missing)
    server.use(
      http.get("https://api.github.com/repos/postman-cs/test/actions/variables", () =>
        HttpResponse.json({ variables: [] }), { once: true }),
    );

    for (const name of FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/test/actions/variables/${name}`, () =>
        new HttpResponse("not found", { status: 404 }), { once: true }),
    );
    }

    const result = await buildFinalData("token", "test", { project_name: "test", requester_email: "x@x.com", domain: "wealth" } as any);

    expect((result.postman as any).smoke_uid).toBe("");
    expect((result.aws as any).function_name).toBe("");
    expect((result.fern as any).docs_url).toBe("");
  });

  it("normalizes legacy k8s_roadmap runtime metadata to k8s_workspace semantics", async () => {

    const values: Record<string, string> = {
      POSTMAN_WORKSPACE_ID: "ws-abc",
      POSTMAN_SPEC_UID: "spec-uid",
      POSTMAN_BASELINE_COLLECTION_UID: "baseline-uid",
      POSTMAN_SMOKE_COLLECTION_UID: "smoke-uid",
      POSTMAN_CONTRACT_COLLECTION_UID: "contract-uid",
      POSTMAN_RUN_URL: "",
      DEV_GW_URL: "",
      DEV_API_ID: "",
      MOCK_URL: "https://mock.pstmn.io",
      FUNCTION_NAME: "",
      RUNTIME_MODE: "k8s_roadmap",
      RUNTIME_BASE_URL: `${TEST_WORKER_URL}/services/runtime-k8s/`,
      LINT_WARNINGS: "0",
      LINT_ERRORS: "0",
    };

    // listRepoVariables bulk mock (includes both FINAL and ECS vars)
    const allVars: Record<string, string> = { ...values };
    for (const name of ECS_FINAL_VAR_NAMES) {
      allVars[name] = `${name.toLowerCase()}-value`;
    }
    server.use(
      http.get("https://api.github.com/repos/postman-cs/test/actions/variables", () =>
        HttpResponse.json({ variables: Object.entries(allVars).map(([name, value]) => ({ name, value })) }), { once: true }),
    );

    for (const name of FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/test/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: values[name] }), { once: true }),
    );
    }
    for (const name of ECS_FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/test/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: `${name.toLowerCase()}-value` }), { once: true }),
    );
    }

    const result = await buildFinalData("token", "test", { project_name: "test", requester_email: "x@x.com", domain: "wealth" } as any);

    expect((result.runtime as any).mode).toBe("k8s_workspace");
    expect((result.aws as any).invoke_url).toBe(`${TEST_WORKER_URL}/services/runtime-k8s`);
    expect((result.aws as any).function_name).toBe("");
  });

  it("uses ENVIRONMENT_DEPLOYMENTS_JSON when present for complete multi-env metadata", async () => {

    const values: Record<string, string> = {
      POSTMAN_WORKSPACE_ID: "ws-abc",
      POSTMAN_SPEC_UID: "spec-uid",
      POSTMAN_BASELINE_COLLECTION_UID: "baseline-uid",
      POSTMAN_SMOKE_COLLECTION_UID: "smoke-uid",
      POSTMAN_CONTRACT_COLLECTION_UID: "contract-uid",
      POSTMAN_RUN_URL: "",
      POSTMAN_ENVIRONMENT_UID: "env-prod",
      POSTMAN_ENV_UIDS_JSON: "{\"prod\":\"env-prod\",\"stage\":\"env-stage\"}",
      POSTMAN_SYSTEM_ENV_PROD: "sys-prod",
      POSTMAN_SYSTEM_ENV_STAGE: "sys-stage",
      DEV_GW_URL: "https://runtime.example/svc/test-api-prod/",
      DEV_API_ID: "",
      PROD_GW_URL: "https://runtime.example/svc/test-api-prod/",
      PROD_API_ID: "",
      MOCK_URL: "https://mock.pstmn.io",
      FUNCTION_NAME: "test-api-prod",
      RUNTIME_MODE: "ecs_service",
      RUNTIME_BASE_URL: "https://runtime.example/svc/test-api-prod/",
      LINT_WARNINGS: "0",
      LINT_ERRORS: "0",
      ENVIRONMENT_DEPLOYMENTS_JSON: JSON.stringify([
        {
          environment: "prod",
          runtime_url: "https://runtime.example/svc/test-api-prod",
          postman_env_uid: "env-prod",
          system_env_id: "sys-prod",
          status: "active",
          deployed_at: "2026-03-04T15:00:00.000Z",
          branch: "env/prod",
        },
        {
          environment: "stage",
          runtime_url: "https://runtime.example/svc/test-api-stage",
          postman_env_uid: "env-stage",
          system_env_id: "sys-stage",
          status: "active",
          deployed_at: "2026-03-04T15:00:00.000Z",
          branch: "env/stage",
        },
      ]),
    };

    // listRepoVariables bulk mock (includes both FINAL and ECS vars)
    const allVars4: Record<string, string> = { ...values };
    for (const name of ECS_FINAL_VAR_NAMES) {
      allVars4[name] = `${name.toLowerCase()}-value`;
    }
    server.use(
      http.get("https://api.github.com/repos/postman-cs/test/actions/variables", () =>
        HttpResponse.json({ variables: Object.entries(allVars4).map(([name, value]) => ({ name, value })) }), { once: true }),
    );

    for (const name of FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/test/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: values[name] || "" }), { once: true }),
    );
    }
    for (const name of ECS_FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/test/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: `${name.toLowerCase()}-value` }), { once: true }),
    );
    }

    const result = await buildFinalData("token", "test", {
      project_name: "test",
      requester_email: "x@x.com",
      domain: "wealth",
      environments: ["prod", "stage"],
    } as any);

    expect((result.environment_deployments as any[])).toEqual([
      expect.objectContaining({
        environment: "prod",
        runtime_url: "https://runtime.example/svc/test-api-prod",
        postman_env_uid: "env-prod",
        system_env_id: "sys-prod",
        status: "active",
        branch: "env/prod",
      }),
      expect.objectContaining({
        environment: "stage",
        runtime_url: "https://runtime.example/svc/test-api-stage",
        postman_env_uid: "env-stage",
        system_env_id: "sys-stage",
        status: "active",
        branch: "env/stage",
      }),
    ]);
  });

  it("merges existing environment deployments when auto-healing a missing environment", async () => {

    server.use(
      http.get("https://api.github.com/repos/postman-cs/svc-a/actions/variables", () =>
        HttpResponse.json({
        variables: [
          { name: "RUNTIME_MODE", value: "k8s_workspace" },
          { name: "RUNTIME_BASE_URL", value: "https://runtime.example/svc-a-stage/" },
          { name: "POSTMAN_ENV_UIDS_JSON", value: JSON.stringify({ prod: "env-prod", stage: "env-stage" }) },
          { name: "POSTMAN_SYSTEM_ENV_PROD", value: "sys-prod" },
          { name: "POSTMAN_SYSTEM_ENV_STAGE", value: "sys-stage" },
          {
            name: "ENVIRONMENT_DEPLOYMENTS_JSON",
            value: JSON.stringify([
              { environment: "stage", runtime_url: "https://runtime.example/svc-a-stage", status: "active" },
            ]),
          },
        ],
      }), { once: true }),
    );

    const snapshot = await buildFinalDeploymentSnapshot({
      token: "token",
      repoName: "svc-a",
      projectName: "svc-a",
      requestedEnvironments: ["stage"],
      existingRecord: {
        environment_deployments: JSON.stringify([
          { environment: "prod", runtime_url: "https://runtime.example/svc-a-prod", status: "active" },
        ]),
        environments_json: JSON.stringify(["prod"]),
      },
    });

    expect(snapshot.environmentDeployments).toEqual([
      expect.objectContaining({ environment: "prod", runtime_url: "https://runtime.example/svc-a-prod", branch: "env/prod" }),
      expect.objectContaining({ environment: "stage", runtime_url: "https://runtime.example/svc-a-stage", branch: "env/stage" }),
    ]);
    expect(snapshot.airtableFields.environments_json).toBe(JSON.stringify(["prod", "stage"]));
  });
});

function parseSSEEvents(text: string): Array<{
  phase: string;
  status: string;
  message?: string;
  spec_id?: string;
  data?: Record<string, any>;
}> {
  return text.split("\n")
    .filter(l => l.startsWith("data: "))
    .map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .filter(Boolean);
}

describe("phase completion with realistic step ordering", () => {
  afterAll(() => server.close());
  beforeEach(async () => {
    await setupFetchMock();
    server.use(
      http.get("https://example.com/spec.yaml", () =>
        new HttpResponse("openapi: 3.0.3\npaths: {}\n", { status: 200 })),
    );
    server.use(
      http.post("https://bifrost-premium-https-v4.gw.postman.com/ws/proxy", () =>
        HttpResponse.json({ data: [
          { id: TEST_MOCK_SYSTEM_ENV_ID, name: "Production", slug: "prod" },
          { id: "7a942017-f58c-4f7d-995b-017e08287e0b", name: "Stage", slug: "stage" },
          { id: "3c360982-f58c-4f7d-995b-017e08287e0b", name: "Development", slug: "dev" },
        ] })),
    );
  });

  afterEach(() => {
    teardownFetchMock({ assertNoPendingInterceptors: false });
  });

  it("sends postman phase complete after Postman Bootstrap job completes", async () => {
    const ghApi = setupPipelineMocks("phase-test");

    // Job-to-phase mapping: each job maps to SSE phases
    const jobs = [
      { name: "Postman Bootstrap", status: "completed", conclusion: "success", steps: [] },
      { name: "AWS Deploy", status: "completed", conclusion: "success", steps: [] },
      { name: "Finalize", status: "completed", conclusion: "success", steps: [] },
    ];

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 100, status: "completed", conclusion: "success", html_url: "https://github.com/run/100" }] }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({ jobs }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 100, status: "completed", conclusion: "success", html_url: "https://github.com/run/100" }] }), { once: true }),
    );

    // fetchRepoVar for POSTMAN_WORKSPACE_ID (called when postman phase completes)
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/phase-test/actions/variables/POSTMAN_WORKSPACE_ID`, () =>
        HttpResponse.json({ name: "POSTMAN_WORKSPACE_ID", value: "ws-123" })),
    );
    // fetchLintVars (called when spec phase completes at "Store Postman UIDs" step)
    for (const name of ["LINT_WARNINGS", "LINT_ERRORS"]) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/phase-test/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: "0" })),
    );
    }
    // buildFinalData (called after workflow completes successfully)
    for (const name of FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/phase-test/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: "v" })),
    );
    }
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/phase-test/actions/variables/POSTMAN_BASELINE_COLLECTION_UID`, () =>
        HttpResponse.json({ name: "POSTMAN_BASELINE_COLLECTION_UID", value: "" })),
    );
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/phase-test/actions/variables/POSTMAN_SPEC_UID`, () =>
        HttpResponse.json({ name: "POSTMAN_SPEC_UID", value: "" })),
    );

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "phase-test", domain: "wealth", requester_email: "u@t.com", spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG }),
    });

    const resp = await handleProvision(req, mockEnv);
    const text = await readSSEStream(resp);
    const events = parseSSEEvents(text);

    const postmanEvent = events.find(e => e.phase === "postman");
    expect(postmanEvent).toBeDefined();

    const completeEvent = events.find(e => e.phase === "complete" && e.status === "complete");
    expect(completeEvent).toBeDefined();
  });

  it("postman phase completes even when AWS phase fails", async () => {
    const ghApi = setupPipelineMocks("aws-fail");

    // AWS Deploy job fails, but Postman Bootstrap succeeded
    const jobs = [
      { name: "Postman Bootstrap", status: "completed", conclusion: "success", steps: [] },
      { name: "AWS Deploy", status: "completed", conclusion: "failure", steps: [] },
    ];

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 200, status: "completed", conclusion: "failure", html_url: "https://github.com/run/200" }] }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({ jobs }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 200, status: "completed", conclusion: "failure", html_url: "https://github.com/run/200" }] }), { once: true }),
    );

    // fetchRepoVar for POSTMAN_WORKSPACE_ID (called when postman phase completes)
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/aws-fail/actions/variables/POSTMAN_WORKSPACE_ID`, () =>
        HttpResponse.json({ name: "POSTMAN_WORKSPACE_ID", value: "ws-123" })),
    );
    // fetchLintVars (called when spec phase completes at "Store Postman UIDs" step)
    for (const name of ["LINT_WARNINGS", "LINT_ERRORS"]) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/aws-fail/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: "0" })),
    );
    }
    for (const name of FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/aws-fail/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: "v" })),
    );
    }
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/aws-fail/actions/variables/POSTMAN_BASELINE_COLLECTION_UID`, () =>
        HttpResponse.json({ name: "POSTMAN_BASELINE_COLLECTION_UID", value: "" })),
    );
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/aws-fail/actions/variables/POSTMAN_SPEC_UID`, () =>
        HttpResponse.json({ name: "POSTMAN_SPEC_UID", value: "" })),
    );

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "aws-fail", domain: "wealth", requester_email: "u@t.com", spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG }),
    });

    const resp = await handleProvision(req, mockEnv);
    const text = await readSSEStream(resp);
    const events = parseSSEEvents(text);

    const postmanEvent = events.find(e => e.phase === "postman");
    expect(postmanEvent).toBeDefined();
  });

  it("ignores jobs with unknown names (no SSE events for unmapped jobs)", async () => {
    const ghApi = setupPipelineMocks("internal-steps");

    // Jobs include unknown names that should be silently ignored
    const jobs = [
      { name: "Postman Bootstrap", status: "completed", conclusion: "success", steps: [] },
      { name: "Docker Build", status: "completed", conclusion: "success", steps: [] },
      { name: "AWS Deploy", status: "completed", conclusion: "success", steps: [] },
      { name: "Finalize", status: "completed", conclusion: "success", steps: [] },
      { name: "Some Unknown Job", status: "completed", conclusion: "success", steps: [] },
    ];

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 300, status: "completed", conclusion: "success", html_url: "https://github.com/run/300" }] }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({ jobs }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 300, status: "completed", conclusion: "success", html_url: "https://github.com/run/300" }] }), { once: true }),
    );

    // fetchRepoVar for POSTMAN_WORKSPACE_ID (called when postman phase completes)
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/internal-steps/actions/variables/POSTMAN_WORKSPACE_ID`, () =>
        HttpResponse.json({ name: "POSTMAN_WORKSPACE_ID", value: "ws-123" })),
    );
    // fetchLintVars (called when spec phase completes at "Store Postman UIDs" step)
    for (const name of ["LINT_WARNINGS", "LINT_ERRORS"]) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/internal-steps/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: "0" })),
    );
    }
    // buildFinalData (called after workflow completes successfully)
    for (const name of FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/internal-steps/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: "v" })),
    );
    }
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/internal-steps/actions/variables/POSTMAN_BASELINE_COLLECTION_UID`, () =>
        HttpResponse.json({ name: "POSTMAN_BASELINE_COLLECTION_UID", value: "" })),
    );
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/internal-steps/actions/variables/POSTMAN_SPEC_UID`, () =>
        HttpResponse.json({ name: "POSTMAN_SPEC_UID", value: "" })),
    );

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "internal-steps", domain: "wealth", requester_email: "u@t.com", spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG }),
    });

    const resp = await handleProvision(req, mockEnv);
    const text = await readSSEStream(resp);
    const events = parseSSEEvents(text);

    // Should not have events for unknown job names
    const unknownEvents = events.filter(e => e.message && e.message.includes("Unknown"));
    expect(unknownEvents).toHaveLength(0);

    // Postman phase should still complete from Postman Bootstrap job
    const postmanComplete = events.find(e => e.phase === "postman" || e.phase === "spec");
    expect(postmanComplete).toBeDefined();
  });

  it("maps the canonical repo-variable workspace id into Airtable workspace fields", async () => {

    server.use(
      http.get("https://api.github.com/repos/postman-cs/canonical-airtable/actions/variables", () =>
        HttpResponse.json({
        variables: [
          { name: "POSTMAN_WORKSPACE_ID", value: "ws-canonical" },
          { name: "POSTMAN_SPEC_UID", value: "spec-123" },
          { name: "POSTMAN_BASELINE_COLLECTION_UID", value: "baseline-123" },
          { name: "POSTMAN_SMOKE_COLLECTION_UID", value: "smoke-123" },
          { name: "POSTMAN_CONTRACT_COLLECTION_UID", value: "contract-123" },
          { name: "RUNTIME_MODE", value: "lambda" },
          { name: "DEV_GW_URL", value: "https://runtime.example/dev" },
          { name: "FUNCTION_NAME", value: "canonical-airtable" },
          { name: "LINT_WARNINGS", value: "0" },
          { name: "LINT_ERRORS", value: "0" },
        ],
      }), { once: true }),
    );

    const snapshot = await buildFinalDeploymentSnapshot({
      token: "token",
      repoName: "canonical-airtable",
      projectName: "canonical-airtable",
      requestedEnvironments: ["prod"],
      existingRecord: null,
    });

    expect(snapshot.airtableFields.workspace_id).toBe("ws-canonical");
    expect(snapshot.airtableFields.postman_workspace_url).toBe("https://go.postman.co/workspace/ws-canonical");
  });

  it("normalizes k8s_roadmap runtime inputs to k8s_workspace while preserving AWS phase reporting", async () => {
    let dispatchBody: Record<string, unknown> = {};
    const projectName = "k8s-roadmap-proj";
    const expectedRoute = "https://shared-alb.eu-west-2.elb.amazonaws.com/svc/k8s-roadmap-proj";
    const ghApi = setupPipelineMocks(projectName, {
      runtimeMode: "ecs_service",
      onDispatch: (body) => {
        dispatchBody = parseJsonBody(body);
      },
    });

    server.use(
      http.get(new RegExp("https://api\.airtable\.com/v0/base-test/Deployments.*"), () =>
        HttpResponse.json({ records: [] })),
    );
    server.use(
      http.post("https://api.airtable.com/v0/base-test/Deployments", () =>
        HttpResponse.json({ id: "rec-k8s-roadmap-proj", fields: { spec_id: "k8s-roadmap-proj", status: "provisioning" } })),
    );
    server.use(
      http.patch(new RegExp("https://api\.airtable\.com/v0/base-test/Deployments/.*"), () =>
        HttpResponse.json({ id: "rec-k8s-roadmap-proj", fields: { status: "provisioning" } })),
    );

    const envWithPool = {
      ...mockEnv,
      KUBECONFIG_B64: "ZHVtbXkta3ViZWNvbmZpZw==",
      K8S_INGRESS_BASE_DOMAIN: "apps.demo.internal",
      POSTMAN_SYSTEM_ENV_PROD: "4ed1a682-0394-4d71-b1a8-d24ef1af5c5b",
      RUNTIME_POOL_ECS_CLUSTER_NAME: "td-api",
      RUNTIME_POOL_ECS_VPC_ID: "vpc-123",
      RUNTIME_POOL_ECS_SUBNET_IDS: "subnet-1,subnet-2",
      RUNTIME_POOL_ECS_SECURITY_GROUP_IDS: "sg-1",
      RUNTIME_POOL_ECS_EXECUTION_ROLE_ARN: "arn:aws:iam::123456789012:role/ecsExecutionRole",
      RUNTIME_POOL_ECS_ALB_LISTENER_ARN: "arn:aws:elasticloadbalancing:eu-west-2:123456789012:listener/app/shared/abc/def",
      RUNTIME_POOL_ECS_ALB_DNS_NAME: "shared-alb.eu-west-2.elb.amazonaws.com",
      RUNTIME_POOL_ECS_ECR_REPOSITORY: "api-catalog-shared",
      AIRTABLE_API_KEY: "airtable-key",
      AIRTABLE_BASE_ID: "base-test",
    } as any;

    const jobs = [
      { name: "Postman Bootstrap", status: "completed", conclusion: "success", steps: [] },
      { name: "AWS Deploy", status: "completed", conclusion: "success", steps: [] },
      { name: "Finalize", status: "completed", conclusion: "success", steps: [] },
    ];

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 400, status: "completed", conclusion: "success", html_url: "https://github.com/run/400" }] }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({ jobs }), { once: true }),
    );

    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${projectName}/actions/variables/POSTMAN_WORKSPACE_ID`, () =>
        HttpResponse.json({ name: "POSTMAN_WORKSPACE_ID", value: "ws-123" })),
    );
    for (const name of ["LINT_WARNINGS", "LINT_ERRORS"]) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${projectName}/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: "0" })),
    );
    }

    const finalVars: Record<string, string> = {
      POSTMAN_WORKSPACE_ID: "ws-123",
      POSTMAN_SPEC_UID: "spec-123",
      POSTMAN_BASELINE_COLLECTION_UID: "baseline-123",
      POSTMAN_SMOKE_COLLECTION_UID: "smoke-123",
      POSTMAN_CONTRACT_COLLECTION_UID: "contract-123",
      POSTMAN_RUN_URL: "",
      DEV_GW_URL: "",
      MOCK_URL: "",
      FUNCTION_NAME: "",
      RUNTIME_MODE: "k8s_workspace",
      RUNTIME_BASE_URL: expectedRoute,
      LINT_WARNINGS: "0",
      LINT_ERRORS: "0",
    };
    for (const name of FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${projectName}/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: finalVars[name] || "" })),
    );
    }
    const ecsFinalVars: Record<string, string> = {
      ECS_CLUSTER_NAME: "td-api",
      ECS_SERVICE_NAME: `${projectName}-svc`,
      ECS_TASK_DEFINITION: `${projectName}-task`,
      ECS_TARGET_GROUP_ARN: "arn:aws:elasticloadbalancing:eu-west-2:123456789012:targetgroup/k8s-roadmap-proj/abc",
      ECS_LISTENER_RULE_ARN: "arn:aws:elasticloadbalancing:eu-west-2:123456789012:listener-rule/app/shared/abc/def",
    };
    for (const name of ECS_FINAL_VAR_NAMES) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${projectName}/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: ecsFinalVars[name] })),
    );
    }
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${projectName}/actions/variables/POSTMAN_BASELINE_COLLECTION_UID`, () =>
        HttpResponse.json({ name: "POSTMAN_BASELINE_COLLECTION_UID", value: "" })),
    );
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${projectName}/actions/variables/POSTMAN_SPEC_UID`, () =>
        HttpResponse.json({ name: "POSTMAN_SPEC_UID", value: "" })),
    );

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: projectName,
        domain: "wealth",
        requester_email: "u@t.com",
        runtime: "k8s_roadmap",
        spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
      }),
    });

    const resp = await handleProvision(req, envWithPool);
    const text = await readSSEStream(resp);
    const events = parseSSEEvents(text);

    expect((dispatchBody.inputs as Record<string, string>).runtime_mode).toBe("k8s_workspace");
    expect((dispatchBody.inputs as Record<string, string>).runtime_base_url).toBeUndefined();
    expect((dispatchBody.inputs as Record<string, string>).ecs_cluster_name).toBeUndefined();
    expect((dispatchBody.inputs as Record<string, string>).ecs_vpc_id).toBeUndefined();
    expect((dispatchBody.inputs as Record<string, string>).ecs_subnet_ids).toBeUndefined();
  });
});

describe("multi-environment branch provisioning", () => {
  afterAll(() => server.close());
  beforeEach(async () => {
    await setupFetchMock();
    server.use(
      http.get("https://example.com/spec.yaml", () =>
        new HttpResponse("openapi: 3.0.3\npaths: {}\n", { status: 200 })),
    );
    server.use(
      http.post("https://bifrost-premium-https-v4.gw.postman.com/ws/proxy", () =>
        HttpResponse.json({ data: [
          { id: TEST_MOCK_SYSTEM_ENV_ID, name: "Production", slug: "prod" },
          { id: "7a942017-f58c-4f7d-995b-017e08287e0b", name: "Stage", slug: "stage" },
          { id: "3c360982-f58c-4f7d-995b-017e08287e0b", name: "Development", slug: "dev" },
        ] })),
    );
  });

  afterEach(() => {
    teardownFetchMock({ assertNoPendingInterceptors: false });
  });

  it("creates one env/<slug> branch per selected environment", async () => {
    const repoName = "env-branch-creation-test";
    const createdRefs: string[] = [];
    const ghApi = setupPipelineMocks(repoName, {
      onCreateRef: (body) => {
        const payload = parseJsonBody(body);
        if (typeof payload.ref === "string") createdRefs.push(payload.ref);
      },
    });

    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 101, status: "completed", conclusion: "success", html_url: "https://github.com/run/101" }] })),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
        jobs: [{
          name: "provision", status: "completed", conclusion: "success",
          steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }]
        }]
      })),
    );

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: "env-branch-creation-test",
        domain: "wealth",
        requester_email: "u@t.com",
        spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
        environments: ["prod", "stage"],
      }),
    });

    const resp = await handleProvision(req, mockEnv);
    await readSSEStream(resp);

    expect(createdRefs).toContain("refs/heads/env/prod");
    expect(createdRefs).toContain("refs/heads/env/stage");
  });
});

describe("resolveSpec", () => {
  afterAll(() => server.close());
  beforeEach(async () => {
    await setupFetchMock();
    server.use(
      http.get("https://example.com/spec.yaml", () =>
        new HttpResponse("openapi: 3.0.3\npaths: {}\n", { status: 200 })),
    );
    server.use(
      http.post("https://bifrost-premium-https-v4.gw.postman.com/ws/proxy", () =>
        HttpResponse.json({ data: [
          { id: TEST_MOCK_SYSTEM_ENV_ID, name: "Production", slug: "prod" },
          { id: "7a942017-f58c-4f7d-995b-017e08287e0b", name: "Stage", slug: "stage" },
          { id: "3c360982-f58c-4f7d-995b-017e08287e0b", name: "Development", slug: "dev" },
        ] })),
    );
  });

  afterEach(() => {
    teardownFetchMock({ assertNoPendingInterceptors: false });
  });

  it("should reject inline spec content in request", async () => {
    const req = {
      spec_source: "vzw-incident-intake-gateway-api",
      spec_url: "https://example.com/custom-spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
      spec_content: "openapi: 3.0.3\ninfo:\n  title: Custom API\npaths: {}\n",
    };

    await expect(resolveSpec(req as any, null)).rejects.toThrow("Inline spec_content is no longer supported");
  });

  it("should fetch spec from canonical registry URL when spec_source is provided", async () => {
    const specContent = "openapi: 3.0.3\ninfo:\n  title: Fetched API\npaths: {}\n";
    server.use(
      http.get("https://example.com/specs/repos/vzw-incident-intake-gateway-api/openapi.yaml", () =>
        new HttpResponse(specContent, { status: 200 }), { once: true }),
    );

    const req = {
      spec_source: "vzw-incident-intake-gateway-api",
    };

    const resolved = await resolveSpec(req as any, null, { requestOrigin: "https://example.com" });
    // fetchSpecFromUrl trims the content
    expect(resolved.content).toContain("title: Fetched API");
    expect(resolved.source).toBe("vzw-incident-intake-gateway-api");
    expect(resolved.specUrl).toBe("https://example.com/specs/repos/vzw-incident-intake-gateway-api/openapi.yaml");
  });

  describe("multi-environment validation and dispatch", () => {
    it("fails when an unrecognized environment is requested", async () => {
      setupAirtableMocks();
      const projectName = "invalid-env-test";
      const req = new Request("https://example.com/api/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_name: projectName,
          domain: "platform",
          requester_email: "u@t.com",
          environments: ["invalid-slug"],
          spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG,
        }),
      });

      // Mock Bifrost system-envs
      server.use(
        http.post("https://bifrost-premium-https-v4.gw.postman.com/ws/proxy", () =>
          HttpResponse.json({ data: [{ id: TEST_MOCK_SYSTEM_ENV_ID, name: "Production", slug: "prod" }] }), { once: true }),
      );

      const resp = await handleProvision(req, mockEnv);
      const text = await readSSEStream(resp);
      expect(text).toContain('"phase":"error"');
      expect(text).toContain("Unrecognized environments: invalid-slug");
    });

    it("dispatches multiple environments in the workflow payload", async () => {
      let dispatchBody: any = null;
      const repoName = "multi-env-dispatch";
      const ghApi = setupPipelineMocks(repoName, {
        onDispatch: (body) => { dispatchBody = JSON.parse(body as string); },
      });

      const req = new Request("https://example.com/api/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_name: repoName,
          domain: "platform",
          requester_email: "u@t.com",
          environments: ["prod", "stage"],
          spec_url: "https://example.com/spec.yaml", postman_team_slug: TEST_TEAM_SLUG
        }),
      });

      // Mock Bifrost system-envs
      server.use(
        http.post("https://bifrost-premium-https-v4.gw.postman.com/ws/proxy", () =>
          HttpResponse.json({ data: [
            { id: TEST_MOCK_SYSTEM_ENV_ID, name: "Production", slug: "prod" },
            { id: "7a942017-f58c-4f7d-995b-017e08287e0b", name: "Stage", slug: "stage" },
          ] }), { once: true }),
      );

      // Mock final variables for buildFinalData
      for (const name of ["POSTMAN_RUN_URL", "DEV_API_ID", "RUNTIME_MODE", "RUNTIME_BASE_URL", "FERN_DOCS_URL"]) {
    server.use(
      http.get(`https://api.github.com/repos/postman-cs/${repoName}/actions/variables/${name}`, () =>
        HttpResponse.json({ name, value: "v" })),
    );
      }

      // Correlation + polling mocks
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/workflows/provision\\.yml/runs`), () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 301, status: "completed", conclusion: "success", html_url: "https://github.com/run/301" }] }), { once: true }),
    );
    server.use(
      http.get(new RegExp(`https://api\\.github\\.com/repos/postman-cs/[^/]+/actions/runs/\\d+/jobs`), () =>
        HttpResponse.json({
          jobs: [{
            name: "provision", status: "completed", conclusion: "success",
            steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }]
          }]
        }), { once: true }),
    );

      const resp = await handleProvision(req, mockEnv);
      await readSSEStream(resp);

      expect(dispatchBody.inputs.environments).toBe(JSON.stringify(["prod", "stage"]));
      const systemEnvMap = JSON.parse(dispatchBody.inputs.system_env_map);
      expect(systemEnvMap.prod).toBe("4ed1a682-0394-4d71-b1a8-d24ef1af5c5b");
      expect(systemEnvMap.stage).toBe("7a942017-f58c-4f7d-995b-017e08287e0b");
    });

    it("rejects mismatched postman_team_id when postman_team_slug resolves to a different team", async () => {
      const req = new Request("https://example.com/api/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_name: "team-mismatch-test",
          domain: "platform",
          requester_email: "u@t.com",
          postman_team_slug: "field-services-v12-demo",
          postman_team_id: "99999999",
        }),
      });

      const resp = await handleProvision(req, {
        ...mockEnv,
        TEAM_REGISTRY: {
          get: async (key: string, type?: string) => {
            if (key === "team:field-services-v12-demo" && type === "json") {
              return {
                slug: "field-services-v12-demo",
                team_id: "13347347",
                team_name: "Field Services v12 Demo",
                api_key: "registry-key",
                access_token: "registry-access-token",
              };
            }
            return null;
          },
          put: async () => undefined,
          delete: async () => undefined,
        } as unknown as KVNamespace,
      } as any);

      const text = await readSSEStream(resp);
      expect(text).toContain('"phase":"error"');
      expect(text).toContain("Requested postman_team_id '99999999' does not match team slug 'field-services-v12-demo'");
    });
  });

});
