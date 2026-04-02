import { toCount } from "./types";

export interface TeardownEvent {
  project?: string;
  spec_id?: string;
  phase?: string;
  status?: string;
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * Batch teardown event. Structurally identical to TeardownEvent; kept as a
 * named alias so call-sites that previously referenced BatchTeardownEvent
 * continue to compile without changes.
 */
export type BatchTeardownEvent = TeardownEvent;

export interface BatchTeardownResult {
  project_name?: string;
  spec_id?: string;
  success?: boolean;
  error?: string;
}

function isBatchTeardownResult(value: unknown): value is BatchTeardownResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.project_name === "string"
    || typeof record.spec_id === "string"
    || typeof record.success === "boolean"
    || typeof record.error === "string"
  );
}

export interface BatchTeardownCompleteData {
  total: number;
  completed: number;
  success: number;
  failed: number;
  results: BatchTeardownResult[];
}

export async function readTeardownStream(resp: Response): Promise<void> {
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(typeof err.error === "string" ? err.error : `Teardown failed (${resp.status})`);
  }

  const reader = resp.body?.getReader();
  if (!reader) {
    throw new Error("No teardown stream");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  let streamError = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      if (!chunk.startsWith("data: ")) continue;
      const event = JSON.parse(chunk.slice(6)) as TeardownEvent;
      if (event.status === "error") {
        streamError = event.message || "Teardown failed";
      }
      if (event.phase === "complete" && event.status === "complete") {
        completed = true;
      }
    }
  }

  if (streamError) throw new Error(streamError);
  if (!completed) throw new Error("Teardown did not complete");
}

export async function readBatchTeardownStream(
  resp: Response,
  onEvent?: (event: TeardownEvent) => void,
): Promise<BatchTeardownCompleteData> {
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(typeof err.error === "string" ? err.error : `Batch teardown failed (${resp.status})`);
  }

  const reader = resp.body?.getReader();
  if (!reader) {
    throw new Error("No batch teardown stream");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let completedData: BatchTeardownCompleteData | null = null;
  let streamError = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      if (!chunk.startsWith("data: ")) continue;
      const event = JSON.parse(chunk.slice(6)) as TeardownEvent;
      onEvent?.(event);
      if (event.project === "__batch__" && event.status === "error") {
        streamError = event.message || "Teardown failed";
      }
      if (event.project === "__batch__" && event.phase === "complete" && event.status === "complete") {
        const data = event.data || {};
        completedData = {
          total: toCount(data.total),
          completed: toCount(data.completed),
          success: toCount(data.success),
          failed: toCount(data.failed),
          results: Array.isArray(data.results)
            ? data.results.filter(isBatchTeardownResult)
            : [],
        };
      }
    }
  }

  if (streamError) throw new Error(streamError);
  if (!completedData) throw new Error("Batch teardown did not complete");
  return completedData;
}
