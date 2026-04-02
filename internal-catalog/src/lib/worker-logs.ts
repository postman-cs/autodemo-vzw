const WORKER_LOG_TTL_SECONDS = 60 * 60 * 24;
const WORKER_LOG_PREFIX = "worker-log";

type WorkerLogLevel = "info" | "warn" | "error";

type WorkerLogEntry = {
  request_id: string;
  route: string;
  method: string;
  event: string;
  level: WorkerLogLevel;
  timestamp: string;
  message?: string;
  spec_id?: string;
  metadata?: Record<string, unknown>;
};

export type WorkerLogEnv = {
  WORKER_LOGS?: KVNamespace;
};

export function getRequestId(request: Request): string {
  return request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
}

export function withRequestId(request: Request, requestId: string): Request {
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);
  return new Request(request, { headers });
}

export function withRequestIdHeader(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function toKey(requestId: string, timestamp: string): string {
  return `${WORKER_LOG_PREFIX}:${requestId}:${timestamp}:${crypto.randomUUID()}`;
}

export async function logWorkerEvent(
  env: WorkerLogEnv,
  entry: Omit<WorkerLogEntry, "timestamp">,
): Promise<void> {
  if (!env.WORKER_LOGS) return;

  const timestamp = new Date().toISOString();
  const fullEntry: WorkerLogEntry = { ...entry, timestamp };
  try {
    await env.WORKER_LOGS.put(toKey(entry.request_id, timestamp), JSON.stringify(fullEntry), {
      expirationTtl: WORKER_LOG_TTL_SECONDS,
      metadata: {
        request_id: entry.request_id,
        route: entry.route,
        method: entry.method,
        event: entry.event,
        level: entry.level,
        spec_id: entry.spec_id ?? null,
        timestamp,
      },
    });
  } catch (error) {
    console.warn("worker log write failed", error);
  }
}

export async function listWorkerLogsForRequest(
  env: WorkerLogEnv,
  requestId: string,
  limit = 200,
): Promise<WorkerLogEntry[]> {
  if (!env.WORKER_LOGS) return [];

  const listing = await env.WORKER_LOGS.list({
    prefix: `${WORKER_LOG_PREFIX}:${requestId}:`,
    limit: Math.max(1, Math.min(limit, 1000)),
  });

  const entries = await Promise.all(
    listing.keys.map(async (key) => {
      const value = await env.WORKER_LOGS!.get(key.name, "json");
      return value as WorkerLogEntry | null;
    }),
  );

  return entries
    .filter((entry): entry is WorkerLogEntry => !!entry)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

