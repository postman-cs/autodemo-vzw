import { getOrg } from "./github";
import { verifyWebhookSignature } from "./github-webhook-signature";
import type { SSEEvent } from "./sse";

interface SSESink {
  send(event: SSEEvent): void;
}

interface CallbackStateSnapshot {
  delivery: string;
  event: string;
  repo: string;
  runId: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  updatedAt: string;
  payload: unknown;
}

interface CallbackStoreLike {
  put: (key: string, value: string, opts?: { expirationTtl?: number }) => Promise<void>;
  get: (key: string) => Promise<string | null>;
}

const CALLBACK_TTL_SECONDS = 60 * 60;
const CALLBACK_POLL_INTERVAL_MS = 5_000;

const inMemoryCallbackStore = new Map<string, { value: string; expiresAt: number }>();

function callbackKey(repoFullName: string, runId: string): string {
  return `workflow-callback:${repoFullName}:${runId}`;
}

function getStore(env: Record<string, unknown>): CallbackStoreLike {
  const kv = env.PROVISION_STATE as CallbackStoreLike | undefined;
  if (kv && typeof kv.put === "function" && typeof kv.get === "function") {
    return kv;
  }

  return {
    async put(key, value, opts) {
      const ttl = Math.max(1, opts?.expirationTtl || CALLBACK_TTL_SECONDS);
      inMemoryCallbackStore.set(key, {
        value,
        expiresAt: Date.now() + ttl * 1000,
      });
    },
    async get(key) {
      const hit = inMemoryCallbackStore.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= Date.now()) {
        inMemoryCallbackStore.delete(key);
        return null;
      }
      return hit.value;
    },
  };
}

function extractRunState(payload: any): {
  repo: string;
  runId: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
} {
  const repo = String(payload?.repository?.full_name || "").trim();

  const workflowRun = payload?.workflow_run;
  const workflowJob = payload?.workflow_job;
  const runId = String(workflowRun?.id || workflowJob?.run_id || "").trim();
  const status = String(workflowRun?.status || workflowJob?.status || "").trim();
  const conclusion = workflowRun?.conclusion ?? workflowJob?.conclusion ?? null;
  const htmlUrl = String(workflowRun?.html_url || payload?.repository?.html_url || "").trim();

  return {
    repo,
    runId,
    status,
    conclusion,
    htmlUrl,
  };
}

export async function handleGitHubWebhook(req: Request, env: Record<string, unknown>): Promise<Response> {
  const event = req.headers.get("x-github-event") || "";
  const delivery = req.headers.get("x-github-delivery") || "";
  const signature = req.headers.get("x-hub-signature-256") || "";

  try {
    const bodyText = await verifyWebhookSignature(
      req.clone() as unknown as Request<unknown, CfProperties<unknown>>,
      signature,
      String(env.GITHUB_WEBHOOK_SECRET || ""),
    );
    const payload = JSON.parse(bodyText || "{}");

    if (event === "workflow_run" || event === "workflow_job") {
      const state = extractRunState(payload);
      if (state.repo && state.runId) {
        const snapshot: CallbackStateSnapshot = {
          delivery,
          event,
          repo: state.repo,
          runId: state.runId,
          status: state.status,
          conclusion: state.conclusion,
          htmlUrl: state.htmlUrl,
          updatedAt: new Date().toISOString(),
          payload,
        };
        await getStore(env).put(
          callbackKey(state.repo, state.runId),
          JSON.stringify(snapshot),
          { expirationTtl: CALLBACK_TTL_SECONDS },
        );
      }
    }

    return new Response(JSON.stringify({ ok: true, delivery }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: message, delivery }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function streamRunProgressFromCallbacks(args: {
  env: Record<string, unknown>;
  repoName: string;
  runId: number;
  sse: SSESink;
  timeoutMs: number;
  onUpdate?: (state: { status: string; conclusion: string | null; html_url: string }) => void;
}): Promise<{ status: string; conclusion: string | null; html_url: string }> {
  const { env, repoName, runId, sse, timeoutMs, onUpdate } = args;
  const repoFullName = `${getOrg()}/${repoName}`;
  const key = callbackKey(repoFullName, String(runId));
  const deadline = Date.now() + Math.max(timeoutMs, CALLBACK_POLL_INTERVAL_MS);

  let lastDelivery = "";
  while (Date.now() < deadline) {
    const raw = await getStore(env).get(key);
    if (raw) {
      try {
        const snapshot = JSON.parse(raw) as CallbackStateSnapshot;
        if (snapshot.delivery && snapshot.delivery !== lastDelivery) {
          lastDelivery = snapshot.delivery;
          onUpdate?.({
            status: snapshot.status,
            conclusion: snapshot.conclusion,
            html_url: snapshot.htmlUrl,
          });
          sse.send({
            phase: "postman",
            status: "running",
            message: `GitHub callback received (${snapshot.event}:${snapshot.status || "unknown"})`,
            data: {
              callback_delivery: snapshot.delivery,
              callback_event: snapshot.event,
              callback_status: snapshot.status,
              callback_conclusion: snapshot.conclusion,
            },
          });
        }

        if (snapshot.status === "completed") {
          return {
            status: snapshot.status,
            conclusion: snapshot.conclusion,
            html_url: snapshot.htmlUrl,
          };
        }
      } catch {
        // Ignore malformed callback payloads and keep waiting.
      }
    }

    await new Promise((resolve) => setTimeout(resolve, CALLBACK_POLL_INTERVAL_MS));
  }

  return { status: "timeout", conclusion: null, html_url: "" };
}

export function clearInMemoryCallbackState(): void {
  inMemoryCallbackStore.clear();
}
