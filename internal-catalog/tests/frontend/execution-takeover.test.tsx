import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionTakeover, shouldShowExecutionTakeover } from "../../frontend/src/components/ExecutionTakeover";
import type { RunUnit } from "../../frontend/src/lib/provision-progress";

const SINGLE_RUN_UNITS: RunUnit[] = [
  {
    id: "payments-api",
    displayName: "payments-api",
    status: "running",
    message: "Deploying infrastructure",
    contextLabel: "AWS deploy",
    cssClass: "status-provision-running",
    runUrl: "https://github.com/postman-cs/example/actions/runs/123",
    result: undefined,
    error: undefined,
    isTerminal: false,
  },
];

describe("execution takeover", () => {
  it("shows takeover when a single-mode run is active", () => {
    expect(shouldShowExecutionTakeover({
      batchRunning: true,
      renderedBoardMode: "single",
      graphBoardNodeCount: 0,
      orderedItemCount: 0,
    })).toBe(true);
  });

  it("shows takeover when graph mode already has run state", () => {
    expect(shouldShowExecutionTakeover({
      batchRunning: false,
      renderedBoardMode: "graph",
      graphBoardNodeCount: 3,
      orderedItemCount: 0,
    })).toBe(true);
  });

  it("does not show takeover before any run state exists", () => {
    expect(shouldShowExecutionTakeover({
      batchRunning: false,
      renderedBoardMode: "single",
      graphBoardNodeCount: 0,
      orderedItemCount: 0,
    })).toBe(false);
  });

  it("renders the reset action and run links for a completed single-mode run", () => {
    const html = renderToStaticMarkup(
      <ExecutionTakeover
        renderedBoardMode="single"
        batchRun={{ running: false, total: 1, completed: 1, success: 1, failed: 0, queued: 0, inFlight: 0 }}
        runUnits={SINGLE_RUN_UNITS}
        totalCount={1}
        canReset={true}
        onReset={() => {}}
      />,
    );

    expect(html).toContain("Execution summary");
    expect(html).toContain("Provisioning Progress");
    expect(html).toContain("Return to setup");
    expect(html).toContain("Actions");
    expect(html).toContain("Deploying infrastructure");
  });

  it("renders graph-specific metadata for graph runs", () => {
    const html = renderToStaticMarkup(
      <ExecutionTakeover
        renderedBoardMode="graph"
        batchRun={{ running: true, total: 3, completed: 1, success: 1, failed: 0, queued: 1, inFlight: 1 }}
        runUnits={SINGLE_RUN_UNITS}
        totalCount={3}
        canReset={false}
        onReset={() => {}}
        graphBoardCounts={{ completed: 2, reused: 1, attached: 0, provisioned: 1, failed: 0, running: 1 }}
        graphDeploymentGroupId="dep-group-123"
        graphRootSpecId="payments-api"
      />,
    );

    expect(html).toContain("Graph Provisioning Progress");
    expect(html).toContain("dep-group-123");
    expect(html).toContain("Reused");
    expect(html).toContain("Root:");
  });
});
