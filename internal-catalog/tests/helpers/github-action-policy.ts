import type { WorkflowDefinition, WorkflowStep } from "../../src/lib/provision-workflow";

export type TokenKind = "github-token" | "pat" | "app-token" | "unknown";
export type Operation = "push-workflow-file" | "checkout-cross-repo" | "write-repo-variable";

export interface PolicyWorkflowStep extends WorkflowStep {
  touchesPaths?: string[];
}

export interface PolicyWorkflowModel {
  permissions?: Record<string, string>;
  jobs: Record<string, { permissions?: Record<string, string>; steps: PolicyWorkflowStep[] }>;
}

const ALLOWED_GITHUB_TOKEN_PERMISSION_KEYS = new Set([
  "actions",
  "attestations",
  "checks",
  "contents",
  "deployments",
  "discussions",
  "id-token",
  "issues",
  "models",
  "packages",
  "pages",
  "pull-requests",
  "repository-projects",
  "security-events",
  "statuses",
]);

export function classifyTokenExpression(expression?: string): TokenKind {
  const value = expression ?? "";
  if (/github\.token|secrets\.GITHUB_TOKEN/.test(value)) return "github-token";
  if (/github_app|app_token|installation_token/i.test(value)) return "app-token";
  if (/GH_TOKEN|PAT|CROSS_REPO_PAT|push_token/i.test(value)) return "pat";
  return "unknown";
}

export function invalidPermissionKeys(permissions?: Record<string, string>): string[] {
  if (!permissions) return [];
  return Object.keys(permissions).filter((key) => !ALLOWED_GITHUB_TOKEN_PERMISSION_KEYS.has(key));
}

export function validateCrossRepoCheckout(step: PolicyWorkflowStep): string[] {
  if (!step.uses?.startsWith("actions/checkout@")) return [];
  const repository = step.with?.repository;
  if (!repository || /github\.repository/.test(repository)) return [];

  const token = step.with?.token;
  const kind = classifyTokenExpression(token);
  const violations: string[] = [];
  if (kind === "github-token" || kind === "unknown") {
    violations.push(`Cross-repo checkout for ${repository} must not use github.token`);
  }
  return violations;
}

export function validateWorkflowFilePush(step: PolicyWorkflowStep, checkoutPersistedCredentials: boolean): string[] {
  const touchesWorkflowFile = (step.touchesPaths ?? []).some((path) => path.includes(".github/workflows/"))
    || /\.github\/workflows\//.test(step.run ?? "");
  if (!touchesWorkflowFile) return [];

  const token = step.with?.push_token ?? step.with?.github_app_token ?? step.with?.token ?? step.env?.GH_TOKEN;
  const kind = classifyTokenExpression(token);
  const violations: string[] = [];

  if (kind === "github-token" || kind === "unknown") {
    violations.push("Workflow-file writes must use an app token or PAT, never github.token");
  }
  if (checkoutPersistedCredentials) {
    violations.push("Workflow-file writes require actions/checkout persist-credentials=false to avoid auth override");
  }
  return violations;
}

export function toPolicyWorkflowModel(definition: WorkflowDefinition): PolicyWorkflowModel {
  return {
    permissions: definition.permissions,
    jobs: Object.fromEntries(
      Object.entries(definition.jobs).map(([name, job]) => [
        name,
        {
          permissions: job.permissions,
          steps: (job.steps || []).map((step) => {
            const next: PolicyWorkflowStep = { ...step };
            if (step.uses?.includes("/finalize")) {
              next.touchesPaths = [".github/workflows/ci.yml", ".github/workflows/provision.yml"];
            }
            return next;
          }),
        },
      ]),
    ),
  };
}
