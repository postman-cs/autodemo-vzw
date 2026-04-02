import { describe, expect, it } from "vitest";

import { readBatchTeardownStream } from "../frontend/src/lib/sse-stream";

function makeSseResponse(payload: unknown): Response {
  const body = `data: ${JSON.stringify(payload)}\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("readBatchTeardownStream", () => {
  it("filters null results from the batch complete payload", async () => {
    const resp = makeSseResponse({
      project: "__batch__",
      phase: "complete",
      status: "complete",
      data: {
        total: 2,
        completed: 2,
        success: 1,
        failed: 1,
        results: [
          { project_name: "first-project", spec_id: "spec-first-project", success: true },
          null,
        ],
      },
    });

    const data = await readBatchTeardownStream(resp);

    expect(data.results).toHaveLength(1);
    expect(data.results[0].project_name).toBe("first-project");
    expect(data.results[0].spec_id).toBe("spec-first-project");
  });
});
