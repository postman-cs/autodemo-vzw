// POST /api/teardown handler
// Deletes Postman Insights service + workspace + GitHub repo and handles runtime-specific cleanup.
// Returns an SSE stream with step-by-step progress.

import type { ProvisioningEnv as Env } from "./provisioning-env";
import {
  createRepoSecret,
  deleteRepo,
  getLatestWorkflowRun,
  getOrg,
  getWorkflowJobs,
  listRepoVariables,
  normalizeGitHubToken,
  triggerWorkflow,
} from "./github";
import { parseEnvironmentDeploymentsJson } from "./environment-deployments";
import { SSEWriter, type SSEEvent } from "./sse";
import {
  isContainerRuntime,
  isKubernetesRuntime,
  normalizeRuntimeMode,
  type CanonicalRuntimeMode,
} from "./config";
import { sleep } from "./sleep";
import { getDeployment, updateDeployment, isAirtableConfigured, DEPLOYMENT_TOMBSTONE_FIELDS } from "./airtable";
import { disassociateWorkspaceFromSystemEnvironments } from "./system-envs";
import { resolveTeamCredentials } from "./team-registry";
import { deleteDiscoveredServiceEntries } from "./insights-onboarding";

interface TeardownRequest {
  project_name: string;
  /** Optional credential override for teardown when the team is not registered. */
  override_api_key?: string;
  override_access_token?: string;
}

interface BatchTeardownItemRequest {
  spec_id?: string;
  project_name?: string;
  override_api_key?: string;
  override_access_token?: string;
}

interface BatchTeardownRequest {
  items?: BatchTeardownItemRequest[];
  project_names?: string[];
}

interface TeardownPipelineInput {
  project_name: string;
  spec_id?: string;
  override_api_key?: string;
  override_access_token?: string;
}

interface TeardownPipelineResult {
  project_name: string;
  spec_id?: string;
  success: boolean;
  runtime_mode: CanonicalRuntimeMode;
  results: Record<string, string>;
  error?: string;
}

const BATCH_PROJECT_KEY = "__batch__";
const MAX_BATCH_SIZE = 50;
const BATCH_MAX_CONCURRENT = 3;

const AWS_TEARDOWN_WORKFLOW_FILE = "worker-teardown.yml";
const AWS_TEARDOWN_WORKFLOW_PATH = ".github/workflows/worker-teardown.yml";
const AWS_TEARDOWN_WORKFLOW_CONTENT = [
  "name: Worker AWS Teardown",
  "",
  "on:",
  "  workflow_dispatch:",
  "    inputs:",
  "      project_name:",
  "        description: \"Project/repo name prefix\"",
  "        required: true",
  "        type: string",
  "      runtime_mode:",
  "        description: \"Runtime mode (lambda, ecs_service, k8s_workspace, or k8s_discovery)\"",
  "        required: false",
  "        type: string",
  "        default: \"lambda\"",
  "      aws_region:",
  "        description: \"AWS region\"",
  "        required: false",
  "        type: string",
  "        default: \"eu-central-1\"",
  "      ecs_cluster_name:",
  "        description: \"ECS cluster name (ecs_service)\"",
  "        required: false",
  "        type: string",
  "      ecs_service_name:",
  "        description: \"ECS service name (ecs_service)\"",
  "        required: false",
  "        type: string",
  "      ecs_target_group_arn:",
  "        description: \"ECS target group ARN (ecs_service)\"",
  "        required: false",
  "        type: string",
  "      ecs_listener_rule_arn:",
  "        description: \"ALB listener rule ARN (ecs_service)\"",
  "        required: false",
  "        type: string",
  "      k8s_namespace:",
  "        description: \"Kubernetes namespace (k8s modes)\"",
  "        required: false",
  "        type: string",
  "      k8s_deployment_name:",
  "        description: \"Kubernetes deployment name (k8s modes)\"",
  "        required: false",
  "        type: string",
  "      k8s_service_name:",
  "        description: \"Kubernetes service name (k8s modes)\"",
  "        required: false",
  "        type: string",
  "      k8s_ingress_name:",
  "        description: \"Kubernetes ingress name (k8s modes)\"",
  "        required: false",
  "        type: string",
  "      env_resource_names_json:",
  "        description: \"JSON map of environment slug to runtime resource name\"",
  "        required: false",
  "        type: string",
  "      environment_deployments_json:",
  "        description: \"JSON array of environment deployment records\"",
  "        required: false",
  "        type: string",
  "",
  "jobs:",
  "  teardown:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - name: Configure AWS Credentials",
      "        uses: aws-actions/configure-aws-credentials@v6.0.0",
  "        with:",
  "          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}",
  "          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}",
  "          aws-region: ${{ github.event.inputs.aws_region }}",
  "",
  "      - name: Delete Lambda Functions and API Gateways",
  "        if: ${{ github.event.inputs.runtime_mode == 'lambda' }}",
  "        run: |",
  "          set -euo pipefail",
  "          PROJECT=\"${{ github.event.inputs.project_name }}\"",
  "          RAW_FUNCTIONS=$(aws lambda list-functions --output json 2>/dev/null || echo '{\"Functions\":[]}')",
  "          FUNCTIONS=$(echo \"${RAW_FUNCTIONS}\" | jq -r --arg prefix \"${PROJECT}-\" '.Functions[]?.FunctionName | select(startswith($prefix))')",
  "          RAW_APIS=$(aws apigatewayv2 get-apis --output json 2>/dev/null || echo '{\"Items\":[]}')",
  "          API_IDS=$(echo \"${RAW_APIS}\" | jq -r --arg prefix \"${PROJECT}\" '.Items[]? | select((.Name // empty) | startswith($prefix)) | .ApiId')",
  "",
  "          if [ -z \"${FUNCTIONS}\" ] && [ -z \"${API_IDS}\" ]; then",
  "            echo \"No Lambda or API Gateway resources found for ${PROJECT}\"",
  "            exit 0",
  "          fi",
  "",
  "          while IFS= read -r API_ID; do",
  "            [ -z \"${API_ID}\" ] && continue",
  "            aws apigatewayv2 delete-api --api-id \"${API_ID}\" 2>/dev/null || true",
  "            echo \"Deleted API Gateway: ${API_ID}\"",
  "          done <<< \"${API_IDS}\"",
  "",
  "          while IFS= read -r FUNC_NAME; do",
  "            [ -z \"${FUNC_NAME}\" ] && continue",
  "            aws lambda delete-function --function-name \"${FUNC_NAME}\" 2>/dev/null || true",
  "            aws logs delete-log-group --log-group-name \"/aws/lambda/${FUNC_NAME}\" >/dev/null 2>&1 || true",
  "            echo \"Deleted Lambda: ${FUNC_NAME}\"",
  "          done <<< \"${FUNCTIONS}\"",
  "",
  "      - name: Delete ECS Service, Listener Rule, and Target Group",
  "        if: ${{ github.event.inputs.runtime_mode == 'ecs_service' }}",
  "        run: |",
  "          set -euo pipefail",
  "          PROJECT=\"${{ github.event.inputs.project_name }}\"",
  "          CLUSTER=\"${{ github.event.inputs.ecs_cluster_name }}\"",
  "          SERVICE_INPUT=\"${{ github.event.inputs.ecs_service_name }}\"",
  "          TARGET_GROUP_INPUT=\"${{ github.event.inputs.ecs_target_group_arn }}\"",
  "          LISTENER_RULE_INPUT=\"${{ github.event.inputs.ecs_listener_rule_arn }}\"",
  "          RESOURCE_MAP_JSON='${{ github.event.inputs.env_resource_names_json }}'",
  "",
  "          [ -z \"${CLUSTER}\" ] && CLUSTER=\"verizon-partner-demo-cluster\"",
  "          [ -z \"${RESOURCE_MAP_JSON}\" ] && RESOURCE_MAP_JSON='{}'",
  "",
  "          SERVICE_LIST=$(echo \"${RESOURCE_MAP_JSON}\" | jq -r 'if type==\"object\" then .[] else empty end' 2>/dev/null | sort -u)",
  "          if [ -z \"${SERVICE_LIST}\" ] && [ -n \"${SERVICE_INPUT}\" ]; then",
  "            SERVICE_LIST=\"${SERVICE_INPUT}\"",
  "          fi",
  "          if [ -z \"${SERVICE_LIST}\" ]; then",
  "            SERVICE_LIST=$(aws ecs list-services --cluster \"${CLUSTER}\" --output json 2>/dev/null | jq -r --arg project \"${PROJECT}\" '.serviceArns[]? | split(\"/\")[-1] | select(startswith($project + \"-svc\"))' | sort -u)",
  "          fi",
  "          if [ -z \"${SERVICE_LIST}\" ]; then",
  "            SERVICE_LIST=\"${PROJECT}-svc\"",
  "          fi",
  "",
  "          while IFS= read -r SERVICE; do",
  "            [ -z \"${SERVICE}\" ] && continue",
  "            TARGET_GROUP_ARN=\"${TARGET_GROUP_INPUT}\"",
  "            LISTENER_RULE_ARN=\"${LISTENER_RULE_INPUT}\"",
  "            SERVICE_STATUS=$(aws ecs describe-services --cluster \"${CLUSTER}\" --services \"${SERVICE}\" --query 'services[0].status' --output text 2>/dev/null || echo MISSING)",
  "            if [ -z \"${TARGET_GROUP_ARN}\" ]; then",
  "              TARGET_GROUP_ARN=$(aws ecs describe-services --cluster \"${CLUSTER}\" --services \"${SERVICE}\" --output json 2>/dev/null | jq -r '.services[0].loadBalancers[0].targetGroupArn // \"\"')",
  "            fi",
  "            if [ -n \"${SERVICE_STATUS}\" ] && [ \"${SERVICE_STATUS}\" != \"None\" ] && [ \"${SERVICE_STATUS}\" != \"INACTIVE\" ] && [ \"${SERVICE_STATUS}\" != \"MISSING\" ]; then",
  "              aws ecs update-service --cluster \"${CLUSTER}\" --service \"${SERVICE}\" --desired-count 0 >/dev/null 2>&1 || true",
  "              aws ecs wait services-stable --cluster \"${CLUSTER}\" --services \"${SERVICE}\" || true",
  "              aws ecs delete-service --cluster \"${CLUSTER}\" --service \"${SERVICE}\" --force >/dev/null 2>&1 || true",
  "            fi",
  "            if [ -z \"${LISTENER_RULE_ARN}\" ] && [ -n \"${TARGET_GROUP_ARN}\" ]; then",
  "              RULE_ARNS=$(aws resourcegroupstaggingapi get-resources --tag-filters Key=ResourceGroup,Values=verizon-partner-demo --resource-type-filters elasticloadbalancing:listener-rule --output json 2>/dev/null | jq -r '.ResourceTagMappingList[]?.ResourceARN')",
  "              while IFS= read -r RULE_ARN; do",
  "                [ -z \"${RULE_ARN}\" ] && continue",
  "                MATCH=$(aws elbv2 describe-rules --rule-arns \"${RULE_ARN}\" --output json 2>/dev/null | jq -r --arg tg \"${TARGET_GROUP_ARN}\" '.Rules[0].Actions[]? | select((.TargetGroupArn // \"\") == $tg) | .TargetGroupArn' | head -1)",
  "                if [ -n \"${MATCH}\" ]; then",
  "                  LISTENER_RULE_ARN=\"${RULE_ARN}\"",
  "                  break",
  "                fi",
  "              done <<< \"${RULE_ARNS}\"",
  "            fi",
  "            if [ -n \"${LISTENER_RULE_ARN}\" ]; then",
  "              aws elbv2 delete-rule --rule-arn \"${LISTENER_RULE_ARN}\" >/dev/null 2>&1 || true",
  "            fi",
  "            if [ -n \"${TARGET_GROUP_ARN}\" ]; then",
  "              for i in $(seq 1 12); do",
  "                if aws elbv2 delete-target-group --target-group-arn \"${TARGET_GROUP_ARN}\" >/dev/null 2>&1; then",
  "                  break",
  "                fi",
  "                sleep 5",
  "              done",
  "            fi",
  "            aws logs delete-log-group --log-group-name \"/ecs/${SERVICE}\" >/dev/null 2>&1 || true",
  "          done <<< \"${SERVICE_LIST}\"",
  "",
  "          TASK_DEFINITIONS=$(aws ecs list-task-definitions --family-prefix \"${PROJECT}-task\" --status ACTIVE --query 'taskDefinitionArns[]' --output text 2>/dev/null || true)",
  "          for TASK_DEF in ${TASK_DEFINITIONS}; do",
  "            [ -z \"${TASK_DEF}\" ] && continue",
  "            aws ecs deregister-task-definition --task-definition \"${TASK_DEF}\" >/dev/null 2>&1 || true",
  "          done",
  "",
  "      - name: Delete Kubernetes Workload Resources",
  "        if: ${{ contains('k8s_workspace,k8s_discovery', github.event.inputs.runtime_mode) }}",
  "        run: |",
  "          set -euo pipefail",
  "          if [ -z \"${{ secrets.KUBECONFIG_B64 }}\" ]; then",
  "            echo \"::error::KUBECONFIG_B64 secret is required for kubernetes teardown\"",
  "            exit 1",
  "          fi",
  "",
  "          NAMESPACE=\"${{ github.event.inputs.k8s_namespace }}\"",
  "          DEPLOYMENT_NAME=\"${{ github.event.inputs.k8s_deployment_name }}\"",
  "          SERVICE_NAME=\"${{ github.event.inputs.k8s_service_name }}\"",
  "          INGRESS_NAME=\"${{ github.event.inputs.k8s_ingress_name }}\"",
  "          RESOURCE_MAP_JSON='${{ github.event.inputs.env_resource_names_json }}'",
  "          [ -z \"${NAMESPACE}\" ] && NAMESPACE=\"verizon-partner-demo\"",
  "          [ -z \"${DEPLOYMENT_NAME}\" ] && DEPLOYMENT_NAME=\"${{ github.event.inputs.project_name }}\"",
  "          [ -z \"${SERVICE_NAME}\" ] && SERVICE_NAME=\"${DEPLOYMENT_NAME}\"",
  "          [ -z \"${INGRESS_NAME}\" ] && INGRESS_NAME=\"${DEPLOYMENT_NAME}-ing\"",
  "          [ -z \"${RESOURCE_MAP_JSON}\" ] && RESOURCE_MAP_JSON='{}'",
  "",
  "          mkdir -p \"$HOME/.kube\"",
  "          echo \"${{ secrets.KUBECONFIG_B64 }}\" | base64 --decode > \"$HOME/.kube/config\"",
  "          chmod 600 \"$HOME/.kube/config\"",
  "",
  "          # Remove kubeconfig profile references so aws CLI uses env var credentials",
  "          sed -i '/^[[:space:]]*- --profile$/ {N;d;}' \"$HOME/.kube/config\"",
  "          sed -i '/^[[:space:]]*- --profile=.*/d' \"$HOME/.kube/config\"",
  "          sed -i '/^[[:space:]]*- name: AWS_PROFILE$/ {N;d;}' \"$HOME/.kube/config\"",
  "          sed -i '/^[[:space:]]*- name: AWS_DEFAULT_PROFILE$/ {N;d;}' \"$HOME/.kube/config\"",
  "          if grep -Eq -- '^[[:space:]]*- --profile($|=)|^[[:space:]]*- name: AWS_(DEFAULT_)?PROFILE$' \"$HOME/.kube/config\"; then",
  "            echo \"::error::kubeconfig still contains AWS profile references after sanitization\"",
  "            exit 1",
  "          fi",
  "          echo \"Kubeconfig profile references sanitized\"",
  "",
  "          # Pre-flight: verify cluster connectivity before attempting deletes",
  "          if ! kubectl cluster-info --request-timeout=10s >/dev/null 2>&1; then",
  "            echo \"::warning::kubectl cannot reach the cluster -- resources may already be gone or credentials expired\"",
  "            echo \"Skipping Kubernetes resource deletion (cluster unreachable)\"",
  "            exit 0",
  "          fi",
  "          echo \"Cluster connectivity verified\"",
  "",
  "          RESOURCE_NAMES=$(echo \"${RESOURCE_MAP_JSON}\" | jq -r 'if type==\"object\" then .[] else empty end' 2>/dev/null | sort -u || true)",
  "          if [ -z \"${RESOURCE_NAMES}\" ]; then",
  "            RESOURCE_NAMES=$(kubectl get deployments -n \"${NAMESPACE}\" -o json 2>/dev/null | jq -r --arg project \"${{ github.event.inputs.project_name }}\" '.items[]?.metadata.name | select(startswith($project))' | sort -u || true)",
  "          fi",
  "          if [ -z \"${RESOURCE_NAMES}\" ]; then",
  "            RESOURCE_NAMES=\"${SERVICE_NAME}\"",
  "          fi",
  "          CLEANUP_ERRORS=0",
  "          while IFS= read -r RESOURCE_NAME; do",
  "            [ -z \"${RESOURCE_NAME}\" ] && continue",
  "            DEPLOYMENT=\"${RESOURCE_NAME}\"",
  "            SERVICE=\"${RESOURCE_NAME}\"",
  "            kubectl delete ingress \"${RESOURCE_NAME}-ingress\" -n \"${NAMESPACE}\" --ignore-not-found=true 2>&1 || { echo \"::warning::Failed to delete ingress ${RESOURCE_NAME}-ingress\"; CLEANUP_ERRORS=$((CLEANUP_ERRORS+1)); }",
  "            kubectl delete ingress \"${RESOURCE_NAME}-ing\" -n \"${NAMESPACE}\" --ignore-not-found=true 2>&1 || { echo \"::warning::Failed to delete ingress ${RESOURCE_NAME}-ing\"; CLEANUP_ERRORS=$((CLEANUP_ERRORS+1)); }",
  "            kubectl delete service \"${SERVICE}\" -n \"${NAMESPACE}\" --ignore-not-found=true 2>&1 || { echo \"::warning::Failed to delete service ${SERVICE}\"; CLEANUP_ERRORS=$((CLEANUP_ERRORS+1)); }",
  "            kubectl delete deployment \"${DEPLOYMENT}\" -n \"${NAMESPACE}\" --ignore-not-found=true 2>&1 || { echo \"::warning::Failed to delete deployment ${DEPLOYMENT}\"; CLEANUP_ERRORS=$((CLEANUP_ERRORS+1)); }",
  "            kubectl delete configmap \"dep-targets-${RESOURCE_NAME}\" -n \"${NAMESPACE}\" --ignore-not-found=true 2>&1 || true",
  "            kubectl delete configmap \"dep-targets-${{ github.event.inputs.project_name }}\" -n \"${NAMESPACE}\" --ignore-not-found=true 2>&1 || true",
  "            echo \"Deleted Kubernetes resources in ${NAMESPACE}: deployment=${DEPLOYMENT}, service=${SERVICE}, configmap=dep-targets-${RESOURCE_NAME}\"",
  "          done <<< \"${RESOURCE_NAMES}\"",
  "",
  "          # Clean up ECR images for this project",
  "          ECR_REPO=\"vzw-partner-demo\"",
  "          PROJECT_PREFIX=\"${{ github.event.inputs.project_name }}\"",
  "          IMAGES=$(aws ecr list-images --repository-name \"${ECR_REPO}\" --filter tagStatus=TAGGED --query \"imageIds[?starts_with(imageTag, '${PROJECT_PREFIX}')]\" --output json 2>/dev/null || echo '[]')",
  "          if [ \"${IMAGES}\" != '[]' ] && [ -n \"${IMAGES}\" ]; then",
  "            aws ecr batch-delete-image --repository-name \"${ECR_REPO}\" --image-ids \"${IMAGES}\" 2>&1 || echo \"::warning::ECR image cleanup failed (non-fatal)\"",
  "            echo \"Cleaned ECR images matching prefix ${PROJECT_PREFIX}\"",
  "          else",
  "            echo \"No ECR images found matching prefix ${PROJECT_PREFIX}\"",
  "          fi",
  "          if [ \"${CLEANUP_ERRORS}\" -gt 0 ]; then",
  "            echo \"::warning::${CLEANUP_ERRORS} resource deletion(s) failed -- resources may need manual cleanup\"",
  "          fi",
].join("\n");

function parseEnvUidsJson(raw: string): string[] {
  const normalized = String(raw || "").trim();
  if (!normalized) return [];
  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return [];
    const values = Object.values(parsed)
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    return Array.from(new Set(values));
  } catch {
    return [];
  }
}

function parseStringMap(raw: string): Record<string, string> {
  const normalized = String(raw || "").trim();
  if (!normalized) return {};
  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const normalizedKey = String(key || "").trim();
      const normalizedValue = String(value || "").trim();
      if (!normalizedKey || !normalizedValue) continue;
      out[normalizedKey] = normalizedValue;
    }
    return out;
  } catch {
    return {};
  }
}

function parseEnvUidsFromDeployment(raw: string): string[] {
  const parsed = parseEnvironmentDeploymentsJson(raw);
  const values = parsed
    .map((entry) => String(entry.postman_env_uid || "").trim())
    .filter(Boolean);
  return Array.from(new Set(values));
}

export async function handleTeardown(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  let body: TeardownRequest;
  try {
    body = (await request.json()) as TeardownRequest;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!body.project_name) {
    return jsonResponse({ error: "project_name is required" }, 400);
  }

  const sse = new SSEWriter();
  const response = sse.toResponse();

  const pipeline = runTeardownPipeline(
    {
      project_name: body.project_name,
      override_api_key: body.override_api_key,
      override_access_token: body.override_access_token,
    },
    env,
    (event) => sse.send(event),
  )
    /* istanbul ignore next -- @preserve defensive: runTeardownPipeline is catch-and-return */
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      sse.send({ phase: "error", status: "error", message: msg || "Unknown error" });
    })
    .finally(() => sse.close());

  // Keep the worker alive until the pipeline completes (avoids premature termination
  // during long-running AWS cleanup workflow polling)
  if (ctx) ctx.waitUntil(pipeline);

  return response;
}

export async function handleBatchTeardown(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  let body: BatchTeardownRequest;
  try {
    body = (await request.json()) as BatchTeardownRequest;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const normalized = normalizeBatchItems(body);
  if (normalized.error) {
    return jsonResponse({ error: normalized.error }, 400);
  }

  const sse = new SSEWriter();
  const response = sse.toResponse();
  const pipeline = runBatchTeardownPipeline(
    normalized.items,
    env,
    (event) => sse.send(event),
  )
    /* istanbul ignore next -- @preserve defensive: runBatchTeardownPipeline should not throw */
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      sse.send({
        project: BATCH_PROJECT_KEY,
        phase: "error",
        status: "error",
        message: msg || "Batch teardown failed",
      });
    })
    .finally(() => sse.close());

  if (ctx) ctx.waitUntil(pipeline);
  return response;
}

function normalizeBatchItems(body: BatchTeardownRequest): {
  items: TeardownPipelineInput[];
  error?: string;
} {
  const candidates: TeardownPipelineInput[] = [];

  if (Array.isArray(body.items)) {
    for (const item of body.items) {
      const projectName = typeof item?.project_name === "string"
        ? item.project_name.trim()
        : "";
      const specId = typeof item?.spec_id === "string"
        ? item.spec_id.trim()
        : "";
      candidates.push({
        project_name: projectName,
        spec_id: specId || undefined,
        override_api_key: typeof item?.override_api_key === "string" ? item.override_api_key.trim() || undefined : undefined,
        override_access_token: typeof item?.override_access_token === "string" ? item.override_access_token.trim() || undefined : undefined,
      });
    }
  }

  if (Array.isArray(body.project_names)) {
    for (const projectNameRaw of body.project_names) {
      const projectName = typeof projectNameRaw === "string"
        ? projectNameRaw.trim()
        : "";
      candidates.push({ project_name: projectName });
    }
  }

  if (!candidates.length) {
    return { items: [], error: "items or project_names must include at least one project" };
  }

  const deduped = new Map<string, TeardownPipelineInput>();
  for (const candidate of candidates) {
    if (!candidate.project_name) {
      return { items: [], error: "Each batch teardown item requires project_name" };
    }
    const dedupeKey = candidate.project_name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const existing = deduped.get(dedupeKey);
    if (!existing) {
      deduped.set(dedupeKey, candidate);
      continue;
    }
    if (!existing.spec_id && candidate.spec_id) {
      deduped.set(dedupeKey, candidate);
    }
  }

  const items = Array.from(deduped.values());
  if (!items.length) {
    return { items: [], error: "No valid batch teardown projects provided" };
  }
  if (items.length > MAX_BATCH_SIZE) {
    return { items: [], error: `Batch teardown supports at most ${MAX_BATCH_SIZE} projects per request` };
  }
  return { items };
}

async function runBatchTeardownPipeline(
  inputs: TeardownPipelineInput[],
  env: Env,
  emit: (event: SSEEvent) => void,
): Promise<void> {
  const total = inputs.length;
  const results: TeardownPipelineResult[] = new Array(total);
  let completed = 0;
  let success = 0;
  let failed = 0;
  let cursor = 0;
  let aborted = false;

  emit({
    project: BATCH_PROJECT_KEY,
    phase: "start",
    status: "running",
    message: `Starting batch teardown for ${total} project${total === 1 ? "" : "s"}`,
    data: { total, completed, success, failed },
  });

  const runWorker = async () => {
    while (true) {
      if (aborted) return;
      const index = cursor;
      cursor += 1;
      if (index >= total) return;

      const input = inputs[index];
      const result = await runTeardownPipeline(
        input,
        env,
        (event) => emit({
          ...event,
          project: input.project_name,
          spec_id: input.spec_id || event.spec_id,
        }),
      );
      results[index] = result;
      completed += 1;
      if (result.success) success += 1;
      else failed += 1;

      if (!result.success && result.error && /Unknown team slug/.test(result.error)) {
        aborted = true;
      }

      emit({
        project: BATCH_PROJECT_KEY,
        phase: "progress",
        status: "running",
        message: `${completed}/${total} complete`,
        data: { total, completed, success, failed },
      });
    }
  };

  const workerCount = Math.min(BATCH_MAX_CONCURRENT, total);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  const serializedResults = results.filter(
    (result): result is TeardownPipelineResult => Boolean(result),
  );

  // Trigger Fern docs republish after batch teardown so torn-down services
  // are removed from the unified documentation site.
  if (success > 0) {
    try {
      const ghToken = normalizeGitHubToken(env.GH_TOKEN);
      await triggerWorkflow(ghToken, "vzw-partner-demo", "unified-fern-publish.yml", {});
      emit({
        project: BATCH_PROJECT_KEY,
        phase: "fern",
        status: "complete",
        message: "Fern docs republish triggered",
      });
    } catch {
      emit({
        project: BATCH_PROJECT_KEY,
        phase: "fern",
        status: "error",
        message: "Fern docs republish failed (non-fatal)",
      });
    }
  }

  emit({
    project: BATCH_PROJECT_KEY,
    phase: "complete",
    status: "complete",
    message: "Batch teardown complete",
    data: { total, completed, success, failed, results: serializedResults },
  });
}

async function runTeardownPipeline(
  input: TeardownPipelineInput,
  env: Env,
  emit: (event: SSEEvent) => void,
): Promise<TeardownPipelineResult> {
  const repoName = input.project_name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const ghToken = normalizeGitHubToken(env.GH_TOKEN);
  const results: Record<string, string> = {};
  let runtimeMode: CanonicalRuntimeMode = "lambda";

  try {
    // 1. Look up workspace ID from repo variables
    emit({ phase: "lookup", status: "running", message: "Looking up resources..." });
    const airtableEnabled = isAirtableConfigured(env);
    let deploymentRecord = null;
    if (airtableEnabled) {
      try {
        deploymentRecord = input.spec_id
          ? await getDeployment(env, input.spec_id)
          : null;
        if (!deploymentRecord) {
          deploymentRecord = await getDeployment(env, repoName);
        }
      } catch {
        deploymentRecord = null;
      }
    }

    let workspaceId: string | null = deploymentRecord?.workspace_id || null;
    let insightsProjectId: string | null = deploymentRecord?.postman_insights_project_id || null;
    let postmanTeamId: string | null = deploymentRecord?.postman_team_id || null;
    let postmanTeamSlugFromRepo: string | null = null;
    let postmanEnvUids: string[] = deploymentRecord?.environment_deployments
      ? parseEnvUidsFromDeployment(deploymentRecord.environment_deployments)
      : [];
    let functionName: string | null = deploymentRecord?.lambda_function_name || null;
    let gatewayUrl: string | null = deploymentRecord?.aws_invoke_url || null;
    let ecsClusterName: string | null = deploymentRecord?.ecs_cluster_name || null;
    let ecsServiceName: string | null = deploymentRecord?.ecs_service_name || null;
    let ecsTargetGroupArn: string | null = deploymentRecord?.ecs_target_group_arn || null;
    let ecsListenerRuleArn: string | null = deploymentRecord?.ecs_listener_rule_arn || null;
    let k8sNamespace: string | null = deploymentRecord?.k8s_namespace || null;
    let k8sDeploymentName: string | null = deploymentRecord?.k8s_deployment_name || null;
    let k8sServiceName: string | null = deploymentRecord?.k8s_service_name || null;
    let k8sIngressName: string | null = deploymentRecord?.k8s_ingress_name || null;
    let envResourceNamesJson = "";
    let environmentDeploymentsJson = deploymentRecord?.environment_deployments || "";

    if (deploymentRecord?.runtime_mode) {
      runtimeMode = normalizeRuntimeMode(deploymentRecord.runtime_mode);
    }
    if (deploymentRecord) {
      emit({
        phase: "lookup",
        status: "running",
        message: "Loaded teardown context from Airtable ledger...",
      });
    }

    let repoVariables: Record<string, string> = {};
    try {
      repoVariables = await listRepoVariables(ghToken, repoName);
    } catch {
      repoVariables = {};
    }
    const getRepoVar = (name: string): string | null => {
      const value = repoVariables[name];
      if (typeof value !== "string") {
        return null;
      }
      const trimmed = value.trim();
      return trimmed || null;
    };

    if (deploymentRecord && Object.keys(repoVariables).length === 0) {
      emit({
        phase: "lookup",
        status: "running",
        message: "Repo variables unavailable, using Airtable records for teardown context...",
      });
    }

    workspaceId = workspaceId || getRepoVar("POSTMAN_WORKSPACE_ID");
    postmanTeamId = postmanTeamId || getRepoVar("POSTMAN_TEAM_ID");
    postmanTeamSlugFromRepo = deploymentRecord?.postman_team_slug || getRepoVar("POSTMAN_TEAM_SLUG");
    if (postmanEnvUids.length === 0) {
      const envUidMapJson = getRepoVar("POSTMAN_ENV_UIDS_JSON");
      if (envUidMapJson) {
        postmanEnvUids = parseEnvUidsJson(envUidMapJson);
      }
    }
    if (postmanEnvUids.length === 0) {
      const primaryEnvUid = getRepoVar("POSTMAN_ENVIRONMENT_UID");
      if (primaryEnvUid) {
        postmanEnvUids = [primaryEnvUid];
      }
    }
    const runtimeModeValue = getRepoVar("RUNTIME_MODE");
    if (runtimeModeValue) {
      runtimeMode = normalizeRuntimeMode(runtimeModeValue);
    }
    insightsProjectId = insightsProjectId || getRepoVar("POSTMAN_INSIGHTS_PROJECT_ID");
    functionName = functionName || getRepoVar("FUNCTION_NAME");
    gatewayUrl = gatewayUrl || getRepoVar("DEV_GW_URL");
    ecsClusterName = ecsClusterName || getRepoVar("ECS_CLUSTER_NAME");
    ecsServiceName = ecsServiceName || getRepoVar("ECS_SERVICE_NAME");
    ecsTargetGroupArn = ecsTargetGroupArn || getRepoVar("ECS_TARGET_GROUP_ARN");
    ecsListenerRuleArn = ecsListenerRuleArn || getRepoVar("ECS_LISTENER_RULE_ARN");
    envResourceNamesJson = getRepoVar("ENV_RESOURCE_NAMES_JSON") || envResourceNamesJson;
    environmentDeploymentsJson = getRepoVar("ENVIRONMENT_DEPLOYMENTS_JSON") || environmentDeploymentsJson;

    if (isKubernetesRuntime(runtimeMode)) {
      k8sNamespace = k8sNamespace || getRepoVar("K8S_NAMESPACE");
      k8sDeploymentName = k8sDeploymentName || getRepoVar("K8S_DEPLOYMENT_NAME");
      k8sServiceName = k8sServiceName || getRepoVar("K8S_SERVICE_NAME");
      k8sIngressName = k8sIngressName || getRepoVar("K8S_INGRESS_NAME");
    }

    if (!envResourceNamesJson && environmentDeploymentsJson) {
      const deployments = parseEnvironmentDeploymentsJson(environmentDeploymentsJson);
      const resourceNameMap: Record<string, string> = {};
      for (const deployment of deployments) {
        const environment = String(deployment.environment || "").trim();
        const resourceNameFromBranch = String(deployment.branch || "").replace(/^env\//, "").trim();
        if (!environment || !resourceNameFromBranch) continue;
        if (runtimeMode === "ecs_service") {
          resourceNameMap[environment] = `${repoName}-svc-${resourceNameFromBranch}`;
        } else if (isKubernetesRuntime(runtimeMode)) {
          resourceNameMap[environment] = `${repoName}-${resourceNameFromBranch}`;
        }
      }
      if (Object.keys(resourceNameMap).length > 0) {
        envResourceNamesJson = JSON.stringify(resourceNameMap);
      }
    }
    const envResourceNameMap = parseStringMap(envResourceNamesJson);
    const firstEnvResourceName = Object.values(envResourceNameMap)[0] || null;
    if (!ecsServiceName && runtimeMode === "ecs_service" && firstEnvResourceName) {
      ecsServiceName = firstEnvResourceName;
    }
    if (isKubernetesRuntime(runtimeMode) && firstEnvResourceName) {
      if (!k8sDeploymentName) k8sDeploymentName = firstEnvResourceName;
      if (!k8sServiceName) k8sServiceName = firstEnvResourceName;
      if (!k8sIngressName) k8sIngressName = `${firstEnvResourceName}-ingress`;
    }

    emit({
      phase: "lookup",
      status: "complete",
      message: workspaceId ? `Found workspace ${workspaceId}` : "No workspace found",
    });

    const postmanTeamSlug = String(deploymentRecord?.postman_team_slug || "").trim();
    const effectiveTeamSlug = postmanTeamSlug || String(postmanTeamSlugFromRepo || "").trim();

    let teamCreds: { api_key: string; access_token: string; team_id: string };
    if (input.override_api_key || input.override_access_token) {
      teamCreds = {
        api_key: input.override_api_key || "",
        access_token: input.override_access_token || "",
        team_id: postmanTeamId || deploymentRecord?.postman_team_id || "13347347",
      };
      emit({ phase: "lookup", status: "running", message: `Using override credentials for team '${effectiveTeamSlug || "unknown"}'` });
    } else {
      if (!effectiveTeamSlug) {
        throw new Error("Missing postman_team_slug. Cannot resolve tenant context for teardown.");
      }
      teamCreds = await resolveTeamCredentials(
        env.TEAM_REGISTRY,
        env,
        effectiveTeamSlug,
      );
    }
    const effectivePostmanTeamId = (postmanTeamId || teamCreds.team_id || "13347347").trim();
    const postmanAccessToken = teamCreds.access_token;

    // 2. Delete Insights project if provision workflow stored one
    if (insightsProjectId) {
      emit({ phase: "insights", status: "running", message: "Deleting Postman Insights service..." });
      try {
        const deleteResult = await deleteInsightsService(
          insightsProjectId,
          postmanAccessToken,
          postmanTeamId,
        );
        if (deleteResult.status === "deleted" || deleteResult.status === "already_deleted") {
          results.insights = "deleted";
          emit({
            phase: "insights",
            status: "complete",
            message: deleteResult.status === "already_deleted"
              ? `Insights service already deleted: ${insightsProjectId}`
              : `Insights service deleted: ${insightsProjectId}`,
          });
        } else {
          results.insights = `error: ${deleteResult.message || "failed to delete insights service"}`;
          emit({
            phase: "insights",
            status: "error",
            message: `Insights delete failed for ${insightsProjectId}: ${deleteResult.message || "unknown error"}`,
          });
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        results.insights = `error: ${msg}`;
        emit({ phase: "insights", status: "error", message: `Insights delete failed: ${msg}` });
      }
    } else {
      emit({ phase: "insights", status: "complete", message: "No Insights service to delete" });
    }

    // 2b. Clean up discovered service entries from Insights (prevents stale UI clutter)
    if (postmanAccessToken && postmanTeamId) {
      const clusterName = getRepoVar("POSTMAN_INSIGHTS_CLUSTER_NAME") || "";
      const specId = input.spec_id || repoName;
      try {
        const cleanup = await deleteDiscoveredServiceEntries(postmanAccessToken, postmanTeamId, specId, clusterName);
        if (cleanup.deleted > 0) {
          emit({ phase: "insights", status: "complete", message: `Cleaned up ${cleanup.deleted} discovered service entries` });
        }
      } catch {
        // Non-fatal: discovered service cleanup is best-effort
      }
    }

    // 3. Disassociate workspace environments from system environments, then delete workspace
    if (workspaceId) {
      emit({ phase: "postman", status: "running", message: "Disassociating workspace system environments..." });
      if (postmanAccessToken) {
        try {
          await disassociateWorkspaceFromSystemEnvironments(
            workspaceId,
            postmanAccessToken,
            effectivePostmanTeamId,
            postmanEnvUids.length > 0 ? postmanEnvUids : undefined,
          );
          results.postman_disassociate = "deleted";
          emit({ phase: "postman", status: "complete", message: "Workspace system-environment associations removed" });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          results.postman_disassociate = `error: ${msg}`;
          emit({ phase: "postman", status: "error", message: `Association cleanup failed: ${msg}` });
        }
      } else {
        results.postman_disassociate = "skipped_missing_access_token";
        emit({ phase: "postman", status: "complete", message: "Skipped association cleanup (POSTMAN_ACCESS_TOKEN missing)" });
      }

      emit({ phase: "postman", status: "running", message: "Deleting Postman workspace..." });
      try {
        await fetch(`https://api.getpostman.com/workspaces/${workspaceId}`, {
          method: "DELETE",
          headers: { "X-Api-Key": teamCreds.api_key },
        });
        results.postman = "deleted";
        emit({ phase: "postman", status: "complete", message: "Workspace deleted" });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        results.postman = `error: ${msg}`;
        emit({ phase: "postman", status: "error", message: `Workspace delete failed: ${msg}` });
      }
    } else {
      emit({ phase: "postman", status: "complete", message: "No workspace to delete" });
    }

    const repoStillExists = await ghFetch(
      `https://api.github.com/repos/${getOrg()}/${repoName}`,
      ghToken,
    ).then(r => r.ok).catch(() => false);

    if (runtimeMode === "ecs_service") {
      if (!envResourceNamesJson) {
        envResourceNamesJson = getRepoVar("ENV_RESOURCE_NAMES_JSON") || "";
      }
      if (!environmentDeploymentsJson) {
        environmentDeploymentsJson = getRepoVar("ENVIRONMENT_DEPLOYMENTS_JSON") || "";
      }
      if (!ecsServiceName) {
        ecsServiceName = Object.values(parseStringMap(envResourceNamesJson))[0] || null;
      }
      if (!repoStillExists) {
        results.ecs_service = "skipped_no_repo";
        emit({
          phase: "lambda",
          status: "complete",
          message: "ECS cleanup skipped (no repo to run teardown workflow)",
        });
        emit({
          phase: "iam",
          status: "complete",
          message: "IAM roles retained (shared execution/task roles)",
        });
      } else {
        emit({
          phase: "lambda",
          status: "running",
          message: "Deleting ECS resources and shared ALB attachments...",
        });
        try {
          const teardownRun = await runAwsCleanupWorkflow(
            repoName,
            input.project_name,
            runtimeMode,
            env,
            ghToken,
            {
              ecs_cluster_name: ecsClusterName,
              ecs_service_name: ecsServiceName,
              ecs_target_group_arn: ecsTargetGroupArn,
              ecs_listener_rule_arn: ecsListenerRuleArn,
              env_resource_names_json: envResourceNamesJson,
              environment_deployments_json: environmentDeploymentsJson,
            },
          );
          results.ecs_service = "deleted";
          results.ecs_target_group = "deleted_or_not_found";
          results.ecs_listener_rule = "deleted_or_not_found";
          results.ecs_task_definitions = "deregistered_or_not_found";
          emit({
            phase: "lambda",
            status: "complete",
            message: `ECS cleanup completed (${teardownRun.html_url})`,
          });
          emit({
            phase: "iam",
            status: "complete",
            message: "IAM roles retained (shared execution/task roles)",
          });
        } catch (e: unknown) {
          const errMessage = e instanceof Error ? e.message : "unknown ECS teardown error";
          results.ecs_service = `error: ${errMessage}`;
          emit({
            phase: "lambda",
            status: "error",
            message: `ECS cleanup failed: ${errMessage}`,
          });
          throw new Error(`Aborting teardown: ECS cleanup failed for ${input.project_name}. Repository retained for retry/debug.`);
        }
      }
    } else if (isKubernetesRuntime(runtimeMode)) {
      if (!repoStillExists) {
        results.k8s_deployment = "skipped_no_repo";
        results.k8s_service = "skipped_no_repo";
        results.k8s_ingress = "skipped_no_repo";
        emit({
          phase: "lambda",
          status: "complete",
          message: "Kubernetes cleanup skipped (no repo to run teardown workflow)",
        });
        emit({
          phase: "iam",
          status: "complete",
          message: "IAM cleanup skipped (cluster auth is managed separately)",
        });
      } else {
        emit({
          phase: "lambda",
          status: "running",
          message: "Deleting Kubernetes deployment, service, and ingress resources...",
        });
        try {
          const teardownRun = await runAwsCleanupWorkflow(
            repoName,
            input.project_name,
            runtimeMode,
            env,
            ghToken,
            {
              k8s_namespace: k8sNamespace,
              k8s_deployment_name: k8sDeploymentName,
              k8s_service_name: k8sServiceName,
              k8s_ingress_name: k8sIngressName,
              env_resource_names_json: envResourceNamesJson,
              environment_deployments_json: environmentDeploymentsJson,
            },
          );
          results.k8s_namespace = k8sNamespace || "verizon-partner-demo";
          results.k8s_deployment = "deleted_or_not_found";
          results.k8s_service = "deleted_or_not_found";
          results.k8s_ingress = "deleted_or_not_found";
          emit({
            phase: "lambda",
            status: "complete",
            message: `Kubernetes cleanup completed (${teardownRun.html_url})`,
          });
          emit({
            phase: "iam",
            status: "complete",
            message: "IAM cleanup skipped (cluster auth is managed separately)",
          });
        } catch (e: unknown) {
          const errMessage = e instanceof Error ? e.message : "unknown Kubernetes teardown error";
          results.k8s_deployment = `error: ${errMessage}`;
          results.k8s_service = `error: ${errMessage}`;
          results.k8s_ingress = `error: ${errMessage}`;
          emit({
            phase: "lambda",
            status: "error",
            message: `Kubernetes cleanup failed: ${errMessage}`,
          });
          throw new Error(`Aborting teardown: Kubernetes cleanup failed for ${input.project_name}. Repository retained for retry/debug.`);
        }
      }
    } else {
      if (!repoStillExists) {
        emit({
          phase: "lambda",
          status: "running",
          message: "No repo to run cleanup workflow; skipping AWS cleanup...",
        });
        results.lambda = "skipped_no_repo";
        results.api_gateway = "skipped_no_repo";
        emit({
          phase: "lambda",
          status: "complete",
          message: "AWS cleanup skipped (no repo to dispatch teardown workflow)",
        });
        emit({
          phase: "iam",
          status: "complete",
          message: "IAM cleanup skipped (shared execution role)",
        });
        results.iam = "skipped";
      } else {
        emit({
          phase: "lambda",
          status: "running",
          message: "Deleting Lambda functions/API Gateways by project prefix...",
        });
        try {
          const teardownRun = await runAwsCleanupWorkflow(
            repoName,
            input.project_name,
            runtimeMode,
            env,
            ghToken,
          );
          results.lambda = "deleted_or_not_found";
          results.api_gateway = "deleted_or_not_found";
          emit({
            phase: "lambda",
            status: "complete",
            message: `Lambda/API Gateway cleanup completed (${teardownRun.html_url})`,
          });
          emit({
            phase: "iam",
            status: "complete",
            message: "IAM cleanup skipped (shared execution role)",
          });
          results.iam = "skipped";
        } catch (e: unknown) {
          const errMessage = e instanceof Error ? e.message : "unknown AWS teardown error";
          results.lambda = `error: ${errMessage}`;
          results.api_gateway = `error: ${errMessage}`;
          emit({
            phase: "lambda",
            status: "error",
            message: `Lambda/API Gateway cleanup failed: ${errMessage}`,
          });
          throw new Error(`Aborting teardown: AWS cleanup failed for ${input.project_name}. Repository retained for retry/debug.`);
        }
      }
    }

    emit({ phase: "github", status: "running", message: "Deleting GitHub repository..." });
    try {
      await deleteRepo(ghToken, repoName);
      results.github = "deleted";
      emit({ phase: "github", status: "complete", message: "Repository deleted" });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.github = `error: ${msg}`;
      emit({ phase: "github", status: "error", message: `Repo delete failed: ${msg}` });
      throw new Error(`Aborting teardown: repository cleanup failed for ${input.project_name}. ${msg}`);
    }

    if (isAirtableConfigured(env)) {
      try {
        const dep = input.spec_id
          ? await getDeployment(env, input.spec_id)
          : await getDeployment(env, repoName);
        const fallbackDep = !dep?.id && input.spec_id
          ? await getDeployment(env, repoName)
          : null;
        const record = dep?.id ? dep : fallbackDep;
        if (!record?.id) {
          throw new Error("No matching Airtable deployment record found for teardown update");
        }
        await updateDeployment(env, record.id, {
          status: "deprovisioned",
          logs: `Deprovisioned at ${new Date().toISOString()}\nResults: ${JSON.stringify(results)}`,
          ...DEPLOYMENT_TOMBSTONE_FIELDS,
        });
        emit({ phase: "airtable", status: "complete", message: "Airtable record updated" });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ phase: "airtable", status: "error", message: `Airtable update failed: ${msg}` });
      }
    }

    // Trigger Fern docs republish so torn-down service is removed from the unified site
    try {
      await triggerWorkflow(ghToken, "vzw-partner-demo", "unified-fern-publish.yml", {});
      emit({ phase: "fern", status: "complete", message: "Fern docs republish triggered" });
    } catch {
      emit({ phase: "fern", status: "error", message: "Fern docs republish failed (non-fatal)" });
    }

    emit({
      phase: "complete",
      status: "complete",
      message: "Teardown complete",
      data: { project: input.project_name, spec_id: input.spec_id || null, runtime: { mode: runtimeMode }, results },
    });

    return {
      project_name: input.project_name,
      spec_id: input.spec_id,
      success: true,
      runtime_mode: runtimeMode,
      results,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ phase: "error", status: "error", message });

    if (isAirtableConfigured(env)) {
      try {
        const dep = input.spec_id
          ? await getDeployment(env, input.spec_id)
          : await getDeployment(env, repoName);
        const fallbackDep = !dep?.id && input.spec_id
          ? await getDeployment(env, repoName)
          : null;
        const record = dep?.id ? dep : fallbackDep;
        if (record?.id) {
          await updateDeployment(env, record.id, {
            status: "failed",
            failed_at_step: "teardown",
            error_message: `Teardown failed: ${message}`,
          });
        }
      } catch {
        // best-effort on error path
      }
    }

    return {
      project_name: input.project_name,
      spec_id: input.spec_id,
      success: false,
      runtime_mode: runtimeMode,
      results,
      error: message,
    };
  }
}

// GET /api/status handler
// Reports resource ownership using GitHub repo metadata.

export async function handleStatus(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const project = url.searchParams.get("project");

  if (!project) {
    return jsonResponse({ error: "project query param required" }, 400);
  }

  const repoName = project.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const ghToken = normalizeGitHubToken(env.GH_TOKEN);
  const resources: Record<string, any> = {};
  let activeProject: string | null = null;
  let runtimeMode: CanonicalRuntimeMode | null = null;

  // Check if repo exists
  try {
    const resp = await ghFetch(
      `https://api.github.com/repos/${getOrg()}/${repoName}`,
      ghToken
    );
    if (resp.ok) {
      resources.github = true;
      activeProject = project;
      let repoVariables: Record<string, string> = {};
      try {
        repoVariables = await listRepoVariables(ghToken, repoName);
      } catch {
        repoVariables = {};
      }
      const hasRepoVar = (name: string): boolean => {
        const value = repoVariables[name];
        return typeof value === "string" && value.trim().length > 0;
      };
      const runtimeModeValue = repoVariables.RUNTIME_MODE;
      runtimeMode = runtimeModeValue ? normalizeRuntimeMode(runtimeModeValue) : "lambda";

      if (hasRepoVar("POSTMAN_WORKSPACE_ID")) {
        resources.postman = 1;
      }

      if (runtimeMode && isContainerRuntime(runtimeMode)) {
        if (runtimeMode === "ecs_service") {
          resources.ecs_service = true;
        }
        if (isKubernetesRuntime(runtimeMode)) {
          resources.k8s_runtime = true;
        }
        if (hasRepoVar("RUNTIME_BASE_URL")) {
          resources.runtime_assignment = true;
        }
      }

      for (const [varName, resKey] of [
        ["FUNCTION_NAME", "lambda"],
        ["DEV_GW_URL", "api_gateway"],
      ] as const) {
        if (runtimeMode && isContainerRuntime(runtimeMode)) {
          continue;
        }
        if (hasRepoVar(varName)) {
          resources[resKey] = true;
        }
      }

      if (runtimeMode && isKubernetesRuntime(runtimeMode)) {
        for (const [varName, resKey] of [
          ["K8S_DEPLOYMENT_NAME", "k8s_deployment"],
          ["K8S_SERVICE_NAME", "k8s_service"],
        ] as const) {
          if (hasRepoVar(varName)) {
            resources[resKey] = true;
          }
        }
      }
    }
  } catch {
    // Repo doesn't exist
  }

  return jsonResponse({
    active_project: activeProject,
    runtime: runtimeMode
      ? {
          mode: runtimeMode,
          ownership: isKubernetesRuntime(runtimeMode)
            ? "dedicated_kubernetes_shared_cluster"
            : runtimeMode === "ecs_service"
              ? "dedicated_service_shared_infra"
              : "dedicated_lambda",
          cleanup: "external_teardown_workflow",
        }
      : null,
    resources,
    source: "live",
  });
}

// Helpers

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function ghFetch(url: string, token: string): Promise<Response> {
  return ghFetchWithInit(url, token);
}

async function ghFetchWithInit(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  const normalizedToken = normalizeGitHubToken(token);
  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${normalizedToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "verizon-partner-demo-worker",
  };
  const initHeaders = (init.headers || {}) as Record<string, string>;
  return fetch(url, {
    ...init,
    headers: { ...baseHeaders, ...initHeaders },
  });
}

type InsightsDeleteStatus = "deleted" | "already_deleted" | "error";

interface InsightsDeleteResult {
  status: InsightsDeleteStatus;
  message?: string;
}

interface InsightsDeleteAttempt {
  ok: boolean;
  status: number;
  message: string;
}

async function deleteInsightsService(
  serviceId: string,
  accessToken: string,
  teamId: string | null,
): Promise<InsightsDeleteResult> {
  const withTeam = teamId ? await deleteInsightsServiceAttempt(serviceId, accessToken, teamId) : null;
  const initial = withTeam ?? await deleteInsightsServiceAttempt(serviceId, accessToken, null);

  if (initial.ok) {
    return { status: "deleted" };
  }
  if (initial.status === 404) {
    return { status: "already_deleted" };
  }

  const shouldRetryWithoutTeam = Boolean(
    withTeam &&
    initial.status === 403 &&
    initial.message.toLowerCase().includes("missing permission on workspace"),
  );
  if (shouldRetryWithoutTeam) {
    const retry = await deleteInsightsServiceAttempt(serviceId, accessToken, null);
    if (retry.ok) {
      return { status: "deleted" };
    }
    if (retry.status === 404) {
      return { status: "already_deleted" };
    }
    return {
      status: "error",
      message: retry.message || `HTTP ${retry.status}`,
    };
  }

  return {
    status: "error",
    message: initial.message || `HTTP ${initial.status}`,
  };
}

async function deleteInsightsServiceAttempt(
  serviceId: string,
  accessToken: string,
  teamId: string | null,
): Promise<InsightsDeleteAttempt> {
  const headers: Record<string, string> = {
    "x-access-token": accessToken,
    "Content-Type": "application/json",
  };
  if (teamId) {
    headers["x-entity-team-id"] = teamId;
  }

  const response = await fetch("https://bifrost-premium-https-v4.gw.postman.com/ws/proxy", {
    method: "POST",
    headers,
    body: JSON.stringify({
      service: "akita",
      method: "delete",
      path: `/v2/services/${serviceId}`,
      body: {},
    }),
  });

  const responseText = await response.text();
  const message = parseGatewayErrorMessage(responseText);
  return {
    ok: response.ok,
    status: response.status,
    message,
  };
}

function parseGatewayErrorMessage(responseText: string): string {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      message?: string;
      error?: { message?: string };
    };
    if (parsed?.message && typeof parsed.message === "string") {
      return parsed.message;
    }
    if (parsed?.error?.message && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {
    // Non-JSON payload; return raw text.
  }
  return trimmed;
}

interface WorkflowRunSummary {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
}

export interface AwsCleanupOptions {
  ecs_cluster_name?: string | null;
  ecs_service_name?: string | null;
  ecs_target_group_arn?: string | null;
  ecs_listener_rule_arn?: string | null;
  k8s_namespace?: string | null;
  k8s_deployment_name?: string | null;
  k8s_service_name?: string | null;
  k8s_ingress_name?: string | null;
  env_resource_names_json?: string | null;
  environment_deployments_json?: string | null;
}

export async function runAwsCleanupWorkflow(
  repoName: string,
  projectName: string,
  runtimeMode: CanonicalRuntimeMode,
  env: Env,
  ghToken: string,
  options: AwsCleanupOptions = {},
): Promise<WorkflowRunSummary> {
  const workflowFileChanged = await upsertTeardownWorkflow(repoName, ghToken);

  // Ensure the repo has the secrets required by the teardown workflow.
  // Provisioning injects these at creation time, but they may be missing if
  // provisioning partially failed or the repo was created before secret
  // injection was added for a given key.
  await ensureTeardownSecrets(repoName, runtimeMode, env, ghToken);

  // GitHub Actions needs time to index a new/updated workflow before dispatch works
  if (workflowFileChanged) {
    await sleep(5000);
  }

  const previousRun = await getLatestWorkflowRun(ghToken, repoName, AWS_TEARDOWN_WORKFLOW_FILE);
  await triggerWorkflow(ghToken, repoName, AWS_TEARDOWN_WORKFLOW_FILE, {
    project_name: projectName,
    runtime_mode: runtimeMode,
    aws_region: String(env.AWS_REGION || "eu-central-1"),
    ecs_cluster_name: options.ecs_cluster_name || "",
    ecs_service_name: options.ecs_service_name || "",
    ecs_target_group_arn: options.ecs_target_group_arn || "",
    ecs_listener_rule_arn: options.ecs_listener_rule_arn || "",
    k8s_namespace: options.k8s_namespace || "",
    k8s_deployment_name: options.k8s_deployment_name || "",
    k8s_service_name: options.k8s_service_name || "",
    k8s_ingress_name: options.k8s_ingress_name || "",
    env_resource_names_json: options.env_resource_names_json || "",
    environment_deployments_json: options.environment_deployments_json || "",
  });

  let runId: number | null = null;
  for (let i = 0; i < 30; i++) {
    const latest = await getLatestWorkflowRun(ghToken, repoName, AWS_TEARDOWN_WORKFLOW_FILE);
    if (latest && latest.id !== previousRun?.id) {
      runId = latest.id;
      break;
    }
    await sleep(2000);
  }
  if (!runId) {
    throw new Error("Timed out waiting for AWS teardown workflow run to start");
  }

  // Poll until completion; fail fast on any failed step.
  for (let i = 0; i < 120; i++) {
    const run = await getWorkflowRun(repoName, runId, ghToken);
    if (!run) {
      await sleep(3000);
      continue;
    }

    const jobs = await getWorkflowJobs(ghToken, repoName, runId);
    for (const job of jobs) {
      for (const step of job.steps || []) {
        if (step.status === "completed" && step.conclusion === "failure") {
          throw new Error(`Workflow step failed: ${step.name}`);
        }
      }
    }

    if (run.status === "completed") {
      if (run.conclusion !== "success") {
        throw new Error(`AWS teardown workflow ended with conclusion=${run.conclusion || "unknown"}`);
      }
      return run;
    }
    await sleep(3000);
  }

  throw new Error("Timed out waiting for AWS teardown workflow completion");
}

async function getWorkflowRun(
  repoName: string,
  runId: number,
  token: string,
): Promise<WorkflowRunSummary | null> {
  const resp = await ghFetch(
    `https://api.github.com/repos/${getOrg()}/${repoName}/actions/runs/${runId}`,
    token,
  );
  if (!resp.ok) return null;
  const run = (await resp.json()) as {
    id: number;
    status: string;
    conclusion: string | null;
    html_url: string;
  };
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    html_url: run.html_url,
  };
}

async function ensureTeardownSecrets(
  repoName: string,
  runtimeMode: CanonicalRuntimeMode,
  env: Env,
  ghToken: string,
): Promise<void> {
  const secrets: [string, string | undefined][] = [
    ["AWS_ACCESS_KEY_ID", env.AWS_ACCESS_KEY_ID],
    ["AWS_SECRET_ACCESS_KEY", env.AWS_SECRET_ACCESS_KEY],
  ];
  if (isKubernetesRuntime(runtimeMode)) {
    secrets.push(["KUBECONFIG_B64", env.KUBECONFIG_B64]);
  }
  for (const [name, value] of secrets) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) continue;
    try {
      await createRepoSecret(ghToken, repoName, name, trimmed);
    } catch (err) {
      console.warn(`Failed to ensure teardown secret ${name} on ${repoName}:`, err);
    }
  }
}

// Returns true if the file was created/updated, false if already up-to-date.
async function upsertTeardownWorkflow(repoName: string, token: string): Promise<boolean> {
  const url = `https://api.github.com/repos/${getOrg()}/${repoName}/contents/${AWS_TEARDOWN_WORKFLOW_PATH}`;

  let sha: string | undefined;
  const current = await ghFetch(url, token);
  if (current.ok) {
    const currentBody = (await current.json()) as { sha?: string; content?: string };
    sha = currentBody.sha;
    // GitHub returns base64 content with embedded newlines; strip them for comparison
    const existingContent = (currentBody.content || "").replace(/\n/g, "");
    const newContent = btoa(AWS_TEARDOWN_WORKFLOW_CONTENT);
    if (existingContent === newContent) {
      return false;
    }
  } else if (current.status !== 404) {
    const body = await current.text();
    throw new Error(`Failed to read teardown workflow file: ${current.status} ${body}`);
  }

  const payload: Record<string, string> = {
    message: "chore: ensure worker teardown workflow",
    content: btoa(AWS_TEARDOWN_WORKFLOW_CONTENT),
    branch: "main",
  };
  if (sha) payload.sha = sha;

  const put = await ghFetchWithInit(url, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!put.ok) {
    const body = await put.text();
    throw new Error(`Failed to write teardown workflow file: ${put.status} ${body}`);
  }
  return true;
}
