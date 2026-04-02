import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateKeyPairSync } from "crypto";
import {
  buildSecretInjectionPlan,
  resolveCredentialSourcePolicy,
  resolveProvisionFeatureFlags,
} from "../src/lib/provision-credential-policy";
import { setRepoVarRespectingOrgScope } from "../src/lib/provision-variable-scope";
import { verifyWebhookSignature } from "../src/lib/github-webhook-signature";
import { getInstallationToken, clearInstallationTokenCache } from "../src/lib/github-app-auth";
import {
  applyGraphEventToBoard,
  applySelectionToggle,
  applyVisibleSelection,
  buildInitialGraphBoardNodes,
  coerceDeploymentMode,
  ensureSingleRootSelection,
  normalizeRuntimeForGraphModeSelection,
  summarizeGraphSubmit,
  supportsGraphDeploymentMode,
} from "../frontend/src/lib/provision-graph-ui";
import type { ProvisionPlan } from "../frontend/src/lib/types";

vi.mock("../src/lib/github", () => ({
  createRepoVariable: vi.fn(async () => {}),
}));

import { createRepoVariable } from "../src/lib/github";

describe("phase 2/3 helpers", () => {
  const graphPlan: ProvisionPlan = {
    deployment_mode: "graph",
    root_spec_id: "root",
    runtime: "k8s_workspace",
    environments: ["prod"],
    hard_closure_spec_ids: ["dep-a", "dep-b", "root"],
    soft_neighbor_spec_ids: ["neighbor-a"],
    layers: [
      { layer_index: 0, spec_ids: ["dep-a", "dep-b"] },
      { layer_index: 1, spec_ids: ["root"] },
    ],
    nodes: [
      {
        key: "dep-a:prod:k8s_workspace",
        spec_id: "dep-a",
        environment: "prod",
        runtime: "k8s_workspace",
        layer_index: 0,
        action: "reuse",
        hard_dependencies: [],
        soft_neighbors: [],
      },
      {
        key: "dep-b:prod:k8s_workspace",
        spec_id: "dep-b",
        environment: "prod",
        runtime: "k8s_workspace",
        layer_index: 0,
        action: "provision",
        hard_dependencies: [],
        soft_neighbors: [],
      },
      {
        key: "root:prod:k8s_workspace",
        spec_id: "root",
        environment: "prod",
        runtime: "k8s_workspace",
        layer_index: 1,
        action: "provision",
        hard_dependencies: ["dep-a", "dep-b"],
        soft_neighbors: ["neighbor-a"],
      },
    ],
    summary: {
      total_nodes: 3,
      reuse_count: 1,
      attach_count: 0,
      provision_count: 2,
      blocked_count: 0,
    },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    clearInstallationTokenCache();
  });

  it("defaults shared secrets to org scope while leaving other feature flags disabled", () => {
    const flags = resolveProvisionFeatureFlags({});
    expect(flags.orgSecretsEnabled).toBe(true);
    expect(flags.orgVarsEnabled).toBe(false);
    expect(flags.patFallbackEnabled).toBe(false);
    expect(flags.oidcAwsEnabled).toBe(false);
    expect(flags.githubAppAuthEnabled).toBe(false);
    expect(flags.workflowCallbacksEnabled).toBe(false);
  });

  it("allows org secret default to be explicitly disabled", () => {
    const flags = resolveProvisionFeatureFlags({ ORG_SECRETS_ENABLED: "false" });
    expect(flags.orgSecretsEnabled).toBe(false);
  });

  it("builds repo-mode secret plan with all secrets", () => {
    const result = buildSecretInjectionPlan(
      {
        POSTMAN_API_KEY: "pmk",
        GH_TOKEN: "ght",
        RUNTIME_ONLY_SECRET: "runtime",
      },
      "repo",
      ["POSTMAN_API_KEY", "GH_TOKEN"],
    );

    expect(Object.keys(result.injectRepoSecrets).sort()).toEqual([
      "GH_TOKEN",
      "POSTMAN_API_KEY",
      "RUNTIME_ONLY_SECRET",
    ]);
    expect(result.skippedBecauseOrgScoped).toEqual([]);
  });

  it("builds org-mode secret plan but still repo-injects Postman secrets", () => {
    const result = buildSecretInjectionPlan(
      {
        POSTMAN_API_KEY: "pmk",
        POSTMAN_ACCESS_TOKEN: "pmt",
        GH_TOKEN: "ght",
        RUNTIME_ONLY_SECRET: "runtime",
      },
      "org",
      ["GH_TOKEN"],
    );

    expect(result.injectRepoSecrets).toEqual({
      POSTMAN_API_KEY: "pmk",
      POSTMAN_ACCESS_TOKEN: "pmt",
      RUNTIME_ONLY_SECRET: "runtime",
    });
    expect(result.skippedBecauseOrgScoped.sort()).toEqual(["GH_TOKEN"]);
  });

  it("supports hybrid mode PAT fallback for GH_TOKEN", () => {
    const result = buildSecretInjectionPlan(
      {
        POSTMAN_API_KEY: "pmk",
        GH_TOKEN: "ght",
      },
      "hybrid",
      ["POSTMAN_API_KEY", "GH_TOKEN"],
      ["GH_TOKEN"],
    );

    expect(result.injectRepoSecrets).toEqual({ GH_TOKEN: "ght" });
    expect(result.skippedBecauseOrgScoped).toEqual(["POSTMAN_API_KEY"]);
  });

  it("resolves hybrid source mode when org secrets + pat fallback are enabled", () => {
    const policy = resolveCredentialSourcePolicy({
      orgSecretsEnabled: true,
      orgVarsEnabled: true,
      patFallbackEnabled: true,
      oidcAwsEnabled: false,
      githubAppAuthEnabled: false,
      workflowCallbacksEnabled: false,
    });
    expect(policy.secretSourceMode).toBe("hybrid");
    expect(policy.variableSourceMode).toBe("org");
  });

  it("skips shared infra repo vars when org vars are enabled", async () => {
    const mock = vi.mocked(createRepoVariable);
    await setRepoVarRespectingOrgScope(
      "token",
      "af-svc",
      "ECS_CLUSTER_NAME",
      "cluster-shared",
      "org",
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it("writes runtime-specific repo vars when org vars are enabled", async () => {
    const mock = vi.mocked(createRepoVariable);
    await setRepoVarRespectingOrgScope(
      "token",
      "af-svc",
      "RUNTIME_BASE_URL",
      "https://example.internal",
      "org",
    );
    expect(mock).toHaveBeenCalledWith(
      "token",
      "af-svc",
      "RUNTIME_BASE_URL",
      "https://example.internal",
    );
  });

  it("verifies webhook signatures", async () => {
    const payload = JSON.stringify({ action: "completed", workflow_run: { id: 42 } });
    const secret = "secret123";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    const digest = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");

    const req = new Request("https://example.com/webhook", { method: "POST", body: payload });
    await expect(verifyWebhookSignature(req, `sha256=${digest}`, secret)).resolves.toBe(payload);
  });

  it("rejects invalid webhook signatures", async () => {
    const req = new Request("https://example.com/webhook", {
      method: "POST",
      body: JSON.stringify({ action: "completed" }),
    });
    await expect(verifyWebhookSignature(req, "sha256=bad", "secret123")).rejects.toThrow(
      "Invalid GitHub webhook signature",
    );
  });

  it("creates installation tokens with GitHub App auth", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ token: "inst_token", expires_at: "2030-03-04T16:00:00Z" }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const token = await getInstallationToken("12345", "67890", privateKey);
    expect(token.token).toBe("inst_token");
    expect(token.expires_at).toBe("2030-03-04T16:00:00Z");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws descriptive errors when installation token creation fails", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const fetchMock = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getInstallationToken("12345", "67890", privateKey)).rejects.toThrow(
      "Failed to create installation token: 401 Unauthorized",
    );
  });

  it("restricts graph deployment mode to kubernetes runtimes", () => {
    expect(supportsGraphDeploymentMode("k8s_workspace")).toBe(true);
    expect(supportsGraphDeploymentMode("k8s_discovery")).toBe(true);
    expect(supportsGraphDeploymentMode("lambda")).toBe(false);
    expect(coerceDeploymentMode("ecs_service", "graph")).toBe("single");
    expect(coerceDeploymentMode("k8s_workspace", "graph")).toBe("graph");
  });

  it("normalizes runtime selection when entering graph mode", () => {
    expect(normalizeRuntimeForGraphModeSelection("lambda")).toBe("k8s_workspace");
    expect(normalizeRuntimeForGraphModeSelection("ecs_service")).toBe("k8s_workspace");
    expect(normalizeRuntimeForGraphModeSelection("k8s_workspace")).toBe("k8s_workspace");
    expect(normalizeRuntimeForGraphModeSelection("k8s_discovery")).toBe("k8s_discovery");
  });

  it("enforces single-root selection in graph mode", () => {
    expect(applySelectionToggle(new Set(["dep-a"]), "root", "graph")).toEqual(new Set(["root"]));
    expect(applySelectionToggle(new Set(["root"]), "root", "graph")).toEqual(new Set());
    expect(applyVisibleSelection(new Set(["root"]), ["dep-a", "dep-b"], "graph")).toEqual(new Set(["root"]));
    expect(ensureSingleRootSelection(new Set(["root", "dep-a"]), "graph")).toEqual(new Set(["root"]));
  });

  it("summarizes graph submit counts from the planner response", () => {
    expect(summarizeGraphSubmit(graphPlan)).toEqual({
      rootSpecId: "root",
      additionalServices: 2,
      totalNodes: 3,
      reuseCount: 1,
      attachCount: 0,
      provisionCount: 2,
    });
  });

  it("applies graph events onto preview-backed board nodes", () => {
    const initial = buildInitialGraphBoardNodes(graphPlan);
    const reused = applyGraphEventToBoard(initial, {
      phase: "graph-node",
      status: "complete",
      message: "Reused existing deployment",
      data: {
        current_spec_id: "dep-a",
        layer_index: 0,
        node_status: "reused",
      },
    });
    expect(reused[0]?.status).toBe("reused");
    expect(reused[0]?.message).toBe("Reused existing deployment");

    const running = applyGraphEventToBoard(reused, {
      phase: "graph-node",
      status: "running",
      message: "Provisioning dep-b/prod",
      data: {
        current_spec_id: "dep-b",
        layer_index: 0,
        node_status: "running",
        run_url: "https://example.com/run/1",
      },
    });
    expect(running[1]?.status).toBe("running");
    expect(running[1]?.runUrl).toBe("https://example.com/run/1");

    const completed = applyGraphEventToBoard(running, {
      phase: "graph-node",
      status: "complete",
      message: "Provisioned root/prod",
      data: {
        current_spec_id: "root",
        layer_index: 1,
        node_status: "completed",
      },
    });
    expect(completed[2]?.status).toBe("completed");
  });

  it("applies attached graph events onto preview-backed board nodes", () => {
    const planWithAttach: ProvisionPlan = {
      ...graphPlan,
      nodes: [
        {
          key: "dep-attached:prod:k8s_workspace",
          spec_id: "dep-attached",
          environment: "prod",
          runtime: "k8s_workspace",
          layer_index: 0,
          action: "attach",
          hard_dependencies: [],
          soft_neighbors: [],
        },
      ],
      hard_closure_spec_ids: ["dep-attached"],
      layers: [{ layer_index: 0, spec_ids: ["dep-attached"] }],
      summary: {
        total_nodes: 1,
        reuse_count: 0,
        attach_count: 1,
        provision_count: 0,
        blocked_count: 0,
      },
    };

    const initial = buildInitialGraphBoardNodes(planWithAttach);
    expect(initial[0]?.status).toBe("attached");
    expect(initial[0]?.message).toBe("Attached existing deployment");

    const attached = applyGraphEventToBoard(initial, {
      phase: "graph-node",
      status: "complete",
      message: "Attached existing deployment",
      data: {
        current_spec_id: "dep-attached",
        layer_index: 0,
        node_status: "attached",
      },
    });

    expect(attached[0]?.status).toBe("attached");
    expect(attached[0]?.message).toBe("Attached existing deployment");
  });
});
