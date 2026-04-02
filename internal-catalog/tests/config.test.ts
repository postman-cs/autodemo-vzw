import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  loadConfig,
  buildFrontendConfig,
  normalizeRuntimeMode,
  inferTemplateRuntime,
  isContainerRuntime,
  isKubernetesRuntime,
} from "../src/lib/config";
import type { PortalConfig } from "../src/lib/config";
import {
  LOCAL_DEV_IDLE_TIMEOUT_MS,
  resolveDevSpecFilePath,
  shouldExitForIdle,
} from "../frontend/vite.config";

// --- loadConfig ---

const validConfig: PortalConfig = {
  slug: "test",
  customer_name: "Test Corp",
  platform: { name: "TestHub", subtitle: "Dev Platform", jira_prefix: "TEST", iam_role_prefix: "test" },
  branding: {
    primary: "#000000", primary_hover: "#111111",
    logo: "logo.png", favicon: "favicon.png", hero_image: "hero.png",
  },
  contact: { email_domain: "test.com", email_from: "dev@test.com", email_signature: "Test Team", support_label: "Contact Test" },
  domains: [{ value: "eng", label: "Engineering", code: "ENG", governance_group: "Eng-APIs" }],
  aws_accounts: [{ id: "111111111111", label: "1111****1111 - Dev", product_code: "ENG-001", service_name: "Test Service" }],
  templates: [
    {
      id: "python-3-11-flask-system-api-lambda",
      title: "Python 3.11 Flask System API (AWS Lambda)",
      description: "Lambda template",
      version: "v1.0",
      runtime: "lambda",
      provisioning_enabled: true,
      enabled: true,
      highlighted: true,
    },
    {
      id: "python-3-11-flask-system-api-ecs-k8s",
      title: "Python 3.11 Flask System API (ECS/K8s)",
      description: "ECS template",
      version: "v1.0",
      runtime: "ecs_service",
      provisioning_enabled: true,
      enabled: true,
      highlighted: true,
    },
  ],
  form_defaults: { project_name: "test-api", application_id: "APP-00001", form_title: "Test API", form_subtitle: "Provision a test API" },
  specs: [{ value: "test-api", label: "Test API", url: "https://example.com/spec.yaml" }],
  sidebar: {
    navigation: [{ label: "Templates", action: "showTemplates", active: true }],
    tools: [{ label: "Linter", action: "toast" }],
    support: [{ label: "Help", action: "toast" }],
  },
  backend: {
    github_org: "test-org", user_agent: "test-worker",
    boilerplate_url: "https://example.com/boilerplate",
    git_committer_name: "Test Bot", git_committer_email: "bot@test.com",
    fallback_team_id: 1, fallback_team_name: "Test Team",
    runtime_defaults: {
      default_runtime: "lambda",
      ecs_base_url: "https://ecs-pool.example.com",
      ecs_cluster_name: "demo-cluster",
    },
  },
};

function createMockKV(data: Record<string, string>): KVNamespace {
  return {
    get: async (key: string) => data[key] ?? null,
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

describe("loadConfig", () => {
  it("returns parsed config from KV", async () => {
    const kv = createMockKV({ test: JSON.stringify(validConfig) });
    const result = await loadConfig("test", kv);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("test");
    expect(result!.platform.name).toBe("TestHub");
  });

  it("returns null for missing slug", async () => {
    const kv = createMockKV({});
    const result = await loadConfig("missing", kv);
    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const kv = createMockKV({ bad: "not json{" });
    const result = await loadConfig("bad", kv);
    expect(result).toBeNull();
  });

  it("returns null when required fields are missing", async () => {
    const incomplete = { slug: "x" }; // missing platform, branding
    const kv = createMockKV({ x: JSON.stringify(incomplete) });
    const result = await loadConfig("x", kv);
    expect(result).toBeNull();
  });
});

// --- buildFrontendConfig ---

describe("buildFrontendConfig", () => {
  it("includes frontend-safe fields", () => {
    const fe = buildFrontendConfig(validConfig);
    expect(fe.slug).toBe("test");
    expect(fe.platform).toEqual(validConfig.platform);
    expect(fe.branding).toEqual(validConfig.branding);
    const templates = fe.templates as Array<Record<string, unknown>>;
    expect(templates).toHaveLength(validConfig.templates.length);
    for (const expectedTemplate of validConfig.templates) {
      expect(templates).toContainEqual(expect.objectContaining(expectedTemplate));
    }
    expect(fe.runtime_default).toBe("lambda");
  });

  it("excludes backend config", () => {
    const fe = buildFrontendConfig(validConfig);
    expect(fe).not.toHaveProperty("backend");
    expect(fe).not.toHaveProperty("spec_content");
  });
});

describe("normalizeRuntimeMode regression guards", () => {
  it("defaults to lambda when runtime is undefined", () => {
    expect(normalizeRuntimeMode(undefined)).toBe("lambda");
  });

  it("keeps lambda runtime unchanged", () => {
    expect(normalizeRuntimeMode("lambda")).toBe("lambda");
  });

  it("keeps ecs_service runtime unchanged", () => {
    expect(normalizeRuntimeMode("ecs_service")).toBe("ecs_service");
  });

  it("falls back to lambda for unknown values", () => {
    expect(normalizeRuntimeMode("garbage")).toBe("lambda");
  });

  it("maps k8s_roadmap to k8s_workspace for migration compatibility", () => {
    expect(normalizeRuntimeMode("k8s_roadmap")).toBe("k8s_workspace");
  });

  it("keeps k8s_workspace runtime unchanged", () => {
    expect(normalizeRuntimeMode("k8s_workspace")).toBe("k8s_workspace");
  });

  it("keeps k8s_discovery runtime unchanged", () => {
    expect(normalizeRuntimeMode("k8s_discovery")).toBe("k8s_discovery");
  });
});

describe("runtime mode helpers", () => {
  it("isContainerRuntime returns true for ECS and Kubernetes runtimes", () => {
    expect(isContainerRuntime("ecs_service")).toBe(true);
    expect(isContainerRuntime("k8s_workspace")).toBe(true);
    expect(isContainerRuntime("k8s_discovery")).toBe(true);
  });

  it("isContainerRuntime returns false for lambda", () => {
    expect(isContainerRuntime("lambda")).toBe(false);
  });

  it("isKubernetesRuntime returns true for kubernetes modes only", () => {
    expect(isKubernetesRuntime("k8s_workspace")).toBe(true);
    expect(isKubernetesRuntime("k8s_discovery")).toBe(true);
  });

  it("isKubernetesRuntime returns false for lambda and ecs_service", () => {
    expect(isKubernetesRuntime("lambda")).toBe(false);
    expect(isKubernetesRuntime("ecs_service")).toBe(false);
  });
});

describe("inferTemplateRuntime", () => {
  it("infers k8s_workspace for kubernetes title strings", () => {
    expect(inferTemplateRuntime({ title: "Python Service (Kubernetes)", runtime: undefined })).toBe("k8s_workspace");
    expect(inferTemplateRuntime({ title: "Python Service (K8s)", runtime: undefined })).toBe("k8s_workspace");
  });
});

describe("local unified dev configuration", () => {
  const repoRoot = path.resolve(__dirname, "..");

  it("defines npm run dev as the primary local entrypoint", () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.dev).toBeTruthy();
    expect(packageJson.scripts?.dev).toContain("vite");
  });

  it("adds the Cloudflare Vite plugin dependency", () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.devDependencies?.["@cloudflare/vite-plugin"]).toBeTruthy();
  });

  it("wires the Vite config through the Cloudflare plugin instead of a dev proxy", () => {
    const viteConfig = readFileSync(path.join(repoRoot, "frontend/vite.config.ts"), "utf8");

    expect(viteConfig).toContain("@cloudflare/vite-plugin");
    expect(viteConfig).toContain("cloudflare(");
    expect(viteConfig).not.toContain('"/api": "http://localhost:8787"');
    expect(viteConfig).not.toContain('"/specs": "http://localhost:8787"');
  });

  it("configures SPA asset routing in wrangler", () => {
    const wranglerConfig = readFileSync(path.join(repoRoot, "wrangler.toml"), "utf8");

    expect(wranglerConfig).toContain('not_found_handling = "single-page-application"');
    expect(wranglerConfig).toContain('run_worker_first = ["/api/*", "/auth/logout"]');
  });

  it("rejects spec path traversal during local dev serving", () => {
    expect(resolveDevSpecFilePath("/specs/../../package.json")).toBeNull();
  });

  it("rejects spec directory requests during local dev serving", () => {
    expect(resolveDevSpecFilePath("/specs/")).toBeNull();
  });

  it("disables idle timeout by default (0 = no auto-shutdown)", () => {
    expect(LOCAL_DEV_IDLE_TIMEOUT_MS).toBe(0);
  });

  it("never exits when timeout is disabled (0)", () => {
    expect(shouldExitForIdle({
      lastActivityAt: 1_000,
      now: 1_000 + 999_999_999,
      timeoutMs: 0,
    })).toBe(false);
  });

  it("exits once the idle deadline has elapsed when timeout is positive", () => {
    const customTimeout = 5 * 60 * 1000;
    expect(shouldExitForIdle({
      lastActivityAt: 1_000,
      now: 1_000 + customTimeout,
      timeoutMs: customTimeout,
    })).toBe(true);
  });

  it("does not exit before the idle deadline when timeout is positive", () => {
    const customTimeout = 5 * 60 * 1000;
    expect(shouldExitForIdle({
      lastActivityAt: 1_000,
      now: 1_000 + customTimeout - 1,
      timeoutMs: customTimeout,
    })).toBe(false);
  });

  it("defines launch, restart, and kill recipes for the local server", () => {
    const justfile = readFileSync(path.join(repoRoot, "justfile"), "utf8");

    expect(justfile).toContain("local-server-launch:");
    expect(justfile).toContain("local-server-restart:");
    expect(justfile).toContain("local-server-kill:");
  });

  it("uses tmux to manage the local server session", () => {
    const justfile = readFileSync(path.join(repoRoot, "justfile"), "utf8");

    expect(justfile).toContain("tmux new-session -d -s");
    expect(justfile).toContain("tmux kill-session -t");
    expect(justfile).toContain("tmux has-session -t");
  });
});
