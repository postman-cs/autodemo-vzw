// Portal configuration types and loading utilities.
// Config is stored in Workers KV (PORTAL_CONFIG namespace) keyed by slug.

// --- Type definitions matching customers/_template/config.yaml ---

export interface PortalConfig {
  slug: string;
  customer_name: string;
  platform: PlatformConfig;
  branding: BrandingConfig;
  contact: ContactConfig;
  domains: DomainConfig[];
  aws_accounts: AwsAccountConfig[];
  templates: TemplateConfig[];
  form_defaults: FormDefaultsConfig;
  specs: SpecConfig[];
  sidebar: SidebarConfig;
  backend: BackendConfig;
  docs_cards?: DocsCardConfig[];
  // Backend-only optional spec source data persisted in KV/DO.
  spec_content?: string;
  spec_url?: string;
}

export interface PlatformConfig {
  name: string;
  subtitle: string;
  jira_prefix: string;
  iam_role_prefix: string;
}

export interface BrandingConfig {
  primary: string;
  primary_hover: string;
  accent?: string;
  bg?: string;
  surface?: string;
  border?: string;
  text?: string;
  text_secondary?: string;
  postman_orange?: string;
  success?: string;
  warning?: string;
  error?: string;
  font_family?: string;
  logo: string;
  favicon: string;
  hero_image: string;
}

export interface ContactConfig {
  email_domain: string;
  email_from: string;
  email_signature: string;
  support_label: string;
}

export interface DomainConfig {
  value: string;
  label: string;
  code: string;
  /** Bifrost governance group UUID. Created via the ruleset API; see docs/workspace-governance-rules.md. */
  governance_group: string;
  default?: boolean;
}

export interface AwsAccountConfig {
  id: string;
  label: string;
  product_code: string;
  service_name: string;
}

export interface TemplateConfig {
  id?: string;
  title: string;
  description: string;
  version: string;
  runtime?: RuntimeMode;
  provisioning_enabled?: boolean;
  highlighted?: boolean;
  enabled?: boolean;
  postman_integrated?: boolean;
}

export type RuntimeMode = "lambda" | "ecs_service" | "k8s_workspace" | "k8s_discovery" | "k8s_roadmap";
export type CanonicalRuntimeMode = "lambda" | "ecs_service" | "k8s_workspace" | "k8s_discovery";

export interface FormDefaultsConfig {
  project_name: string;
  application_id: string;
  form_title: string;
  form_subtitle: string;
}

export interface SpecConfig {
  value: string;
  label: string;
  url: string;
  preview_title?: string;
  preview_meta?: string;
  preview_tags?: string[];
}

export interface SidebarConfig {
  navigation: SidebarLink[];
  tools: SidebarLink[];
  support: SidebarLink[];
}

export interface SidebarLink {
  label: string;
  action: string;
  active?: boolean;
}

export interface BackendConfig {
  github_org: string;
  user_agent: string;
  boilerplate_url: string;
  git_committer_name: string;
  git_committer_email: string;
  fallback_team_id?: number;
  fallback_team_name?: string;
  runtime_defaults?: RuntimeDefaultsConfig;
}

export interface RuntimeDefaultsConfig {
  default_runtime?: RuntimeMode;
  ecs_base_url?: string;
  ecs_cluster_name?: string;
  ecs_vpc_id?: string;
  ecs_subnet_ids?: string;
  ecs_security_group_ids?: string;
  ecs_execution_role_arn?: string;
  ecs_task_role_arn?: string;
  ecs_alb_listener_arn?: string;
  ecs_alb_dns_name?: string;
  ecs_ecr_repository?: string;
  ecs_max_services?: number;
}

export interface DocsCardConfig {
  number: number;
  title: string;
  description: string;
  value_items?: string[];
}

// --- Config resolution and loading ---

export const CANONICAL_RUNTIME_TEMPLATES: Required<Pick<TemplateConfig, "id" | "title" | "description" | "version" | "runtime" | "provisioning_enabled" | "enabled" | "postman_integrated" | "highlighted">>[] = [
  {
    id: "python-3-11-flask-system-api-lambda",
    title: "Python 3.11 Flask System API (AWS Lambda)",
    description: "Production-ready REST API with Postman workspace, test collections, CI/CD pipeline, and API Gateway integration.",
    version: "Template Version 4.0",
    runtime: "lambda",
    provisioning_enabled: true,
    enabled: true,
    postman_integrated: true,
    highlighted: true,
  },
  {
    id: "python-3-11-flask-system-api-ecs-k8s",
    title: "Python 3.11 Flask System API (ECS/K8s)",
    description: "Production-ready REST API with Postman workspace, test collections, CI/CD pipeline, and prewarmed ECS runtime for fast demo deployment.",
    version: "Template Version 4.0",
    runtime: "ecs_service",
    provisioning_enabled: true,
    enabled: true,
    postman_integrated: true,
    highlighted: true,
  },
];

function slugifyTemplateId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "template";
}

export function inferTemplateRuntime(template: Pick<TemplateConfig, "title" | "runtime">): RuntimeMode {
  if (template.runtime) return template.runtime;
  const title = (template.title || "").toLowerCase();
  if (title.includes("lambda")) return "lambda";
  if (title.includes("ecs") || title.includes("eks")) return "ecs_service";
  if (title.includes("k8s") || title.includes("kubernetes")) return "k8s_workspace";
  return "lambda";
}

export function normalizeRuntimeMode(runtime?: RuntimeMode | string | null): CanonicalRuntimeMode {
  if (runtime === "ecs_service") {
    return "ecs_service";
  }
  if (runtime === "k8s_roadmap" || runtime === "k8s_workspace") {
    return "k8s_workspace";
  }
  if (runtime === "k8s_discovery") {
    return "k8s_discovery";
  }
  return "lambda";
}

export function isContainerRuntime(mode: CanonicalRuntimeMode): boolean {
  return mode === "ecs_service" || mode === "k8s_workspace" || mode === "k8s_discovery";
}

export function isKubernetesRuntime(mode: CanonicalRuntimeMode): boolean {
  return mode === "k8s_workspace" || mode === "k8s_discovery";
}

export function normalizeTemplates(templates: TemplateConfig[] = []): TemplateConfig[] {
  const normalized = templates.map((template, index) => {
    const runtime = inferTemplateRuntime(template);
    const enabled = template.enabled ?? true;
    const provisioningEnabled = template.provisioning_enabled ?? enabled;
    return {
      ...template,
      id: template.id || slugifyTemplateId(template.title || `template-${index + 1}`),
      runtime,
      enabled,
      provisioning_enabled: provisioningEnabled,
      postman_integrated: template.postman_integrated ?? true,
      highlighted: Boolean(template.highlighted),
    } satisfies TemplateConfig;
  });

  const hasRuntime = (runtime: RuntimeMode) =>
    normalized.some((template) => template.runtime === runtime && template.provisioning_enabled);

  if (!hasRuntime("lambda")) {
    normalized.push({ ...CANONICAL_RUNTIME_TEMPLATES[0] });
  }
  if (!hasRuntime("ecs_service")) {
    normalized.push({ ...CANONICAL_RUNTIME_TEMPLATES[1] });
  }

  const deduped = new Map<string, TemplateConfig>();
  for (const template of normalized) {
    const id = template.id || slugifyTemplateId(template.title);
    if (!deduped.has(id)) deduped.set(id, { ...template, id });
  }

  const ranked = Array.from(deduped.values()).sort((a, b) => {
    const rank = (runtime?: RuntimeMode): number =>
      runtime === "lambda"
        ? 0
        : runtime === "ecs_service"
          ? 1
          : runtime === "k8s_workspace"
            ? 2
            : runtime === "k8s_discovery"
              ? 3
              : 4;
    return rank(a.runtime) - rank(b.runtime);
  });

  if (!ranked.some((template) => template.highlighted)) {
    const lambdaTemplate = ranked.find((template) => template.runtime === "lambda");
    if (lambdaTemplate) lambdaTemplate.highlighted = true;
  }

  return ranked;
}

export function normalizeRuntimeDefaults(backend: BackendConfig): BackendConfig {
  return {
    ...backend,
    runtime_defaults: {
      default_runtime: backend.runtime_defaults?.default_runtime || "lambda",
      ecs_base_url: backend.runtime_defaults?.ecs_base_url || "",
      ecs_cluster_name: backend.runtime_defaults?.ecs_cluster_name || "",
      ecs_vpc_id: backend.runtime_defaults?.ecs_vpc_id || "",
      ecs_subnet_ids: backend.runtime_defaults?.ecs_subnet_ids || "",
      ecs_security_group_ids: backend.runtime_defaults?.ecs_security_group_ids || "",
      ecs_execution_role_arn: backend.runtime_defaults?.ecs_execution_role_arn || "",
      ecs_task_role_arn: backend.runtime_defaults?.ecs_task_role_arn || "",
      ecs_alb_listener_arn: backend.runtime_defaults?.ecs_alb_listener_arn || "",
      ecs_alb_dns_name: backend.runtime_defaults?.ecs_alb_dns_name || "",
      ecs_ecr_repository: backend.runtime_defaults?.ecs_ecr_repository || "",
      ecs_max_services: backend.runtime_defaults?.ecs_max_services || 10,
    },
  };
}

export function normalizePortalConfig(config: PortalConfig): PortalConfig {
  const backend: BackendConfig = {
    github_org: config.backend?.github_org || "postman-cs",
    user_agent: config.backend?.user_agent || "vzw-partner-demo-worker",
    boilerplate_url: config.backend?.boilerplate_url || "",
    git_committer_name: config.backend?.git_committer_name || `${config.platform?.name || config.slug} Platform`,
    git_committer_email: config.backend?.git_committer_email || "platform@postman.com",
    fallback_team_id: config.backend?.fallback_team_id || 13347347,
    fallback_team_name: config.backend?.fallback_team_name || "Field Services v12 Demo",
    runtime_defaults: config.backend?.runtime_defaults,
  };

  return {
    ...config,
    templates: normalizeTemplates(config.templates),
    backend: normalizeRuntimeDefaults(backend),
  };
}

// In-memory cache: slug -> { config, timestamp }
const configCache = new Map<string, { config: PortalConfig; ts: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Load customer config from Workers KV with in-memory caching.
 * Returns null if the customer slug has no config in KV.
 */
export async function loadConfig(
  slug: string,
  kv: KVNamespace,
): Promise<PortalConfig | null> {
  // Check in-memory cache first
  const cached = configCache.get(slug);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.config;
  }

  // Read from KV
  const raw = await kv.get(slug, "text");
  if (!raw) {
    return null;
  }

  let config: PortalConfig;
  try {
    config = JSON.parse(raw) as PortalConfig;
  } catch {
    return null;
  }

  // Validate required fields
  if (!config.slug || !config.platform?.name || !config.branding?.primary) {
    return null;
  }

  config = normalizePortalConfig(config);

  // Cache it
  configCache.set(slug, { config, ts: Date.now() });

  return config;
}

/**
 * Build the frontend-safe config object injected as window.__PORTAL_CONFIG.
 * Strips backend-only fields to avoid leaking org/token info to the browser.
 */
export function buildFrontendConfig(config: PortalConfig): Record<string, unknown> {
  const normalized = normalizePortalConfig(config);
  return {
    slug: normalized.slug,
    customer_name: normalized.customer_name,
    platform: normalized.platform,
    branding: normalized.branding,
    contact: normalized.contact,
    domains: normalized.domains,
    aws_accounts: normalized.aws_accounts,
    templates: normalized.templates,
    form_defaults: normalized.form_defaults,
    specs: normalized.specs,
    sidebar: normalized.sidebar,
    docs_cards: normalized.docs_cards,
    fallback_team_id: normalized.backend?.fallback_team_id,
    fallback_team_name: normalized.backend?.fallback_team_name,
    runtime_default: normalized.backend?.runtime_defaults?.default_runtime || "lambda",
  };
}
