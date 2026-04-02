/**
 * Execution Progress Normalization Tests
 *
 * Defines the normalized run-unit contract for SSE-based and Graph-based
 * provisioning progress. This test file serves as the specification for
 * the normalization layer that unifies disparate progress event formats.
 *
 * Normalization Rules:
 * - SSE "success" -> "completed"
 * - SSE "error" -> "failed"
 * - Graph statuses preserved as-is except they become terminal states
 * - Graph "skipped" is terminal and immutable (once skipped, always skipped)
 * - runUrl, result, and error details are preserved through normalization
 */

import { describe, expect, it } from "vitest";
import {
  mapSseItemToRunUnit,
  mapGraphNodeToRunUnit,
  resolveRunUnitCssClass,
  type SseProvisionItem,
  type GraphBoardNode,
  type RunUnitStatus,
  type RunUnit,
} from "../frontend/src/lib/provision-progress";

// Types imported from frontend/src/lib/provision-progress.ts
// Local type aliases for test clarity
type SseProvisionStatus = "queued" | "running" | "success" | "error";
type GraphNodeStatus =
  | "queued"
  | "running"
  | "reused"
  | "attached"
  | "completed"
  | "failed"
  | "skipped";

// Test helper to check terminal status
function isTerminalStatus(status: RunUnitStatus): boolean {
  return ["completed", "failed", "reused", "attached", "skipped"].includes(status);
}

describe("Execution Progress Normalization", () => {
  describe("mapSseItemToRunUnit", () => {
    it("maps SSE 'queued' to normalized 'queued' (non-terminal)", () => {
      const item: SseProvisionItem = {
        spec_id: "af-cards-3ds",
        status: "queued",
        phase: "queued",
        message: "Waiting to start...",
      };

      const unit = mapSseItemToRunUnit(item);

      expect(unit.status).toBe("queued");
      expect(unit.isTerminal).toBe(false);
      expect(unit.id).toBe("af-cards-3ds");
      expect(unit.displayName).toBe("af-cards-3ds");
      expect(unit.message).toBe("Waiting to start...");
    });

    it("maps SSE 'running' to normalized 'running' (non-terminal)", () => {
      const item: SseProvisionItem = {
        spec_id: "af-core-deposits",
        status: "running",
        phase: "aws",
        message: "Deploying to AWS...",
        runUrl: "https://github.com/org/repo/actions/runs/123",
      };

      const unit = mapSseItemToRunUnit(item);

      expect(unit.status).toBe("running");
      expect(unit.isTerminal).toBe(false);
      expect(unit.runUrl).toBe("https://github.com/org/repo/actions/runs/123");
      expect(unit.cssClass).toBe("status-provision-running");
    });

    it("maps SSE 'success' to normalized 'completed' (terminal)", () => {
      const item: SseProvisionItem = {
        spec_id: "af-cards-fraud",
        status: "success",
        phase: "complete",
        message: "Provisioning complete",
        result: {
          github: { repo_url: "https://github.com/org/repo" },
          postman: { workspace_url: "https://postman.co/workspace" },
        },
      };

      const unit = mapSseItemToRunUnit(item);

      expect(unit.status).toBe("completed");
      expect(unit.isTerminal).toBe(true);
      expect(unit.result).toEqual(item.result);
    });

    it("maps SSE 'error' to normalized 'failed' (terminal)", () => {
      const item: SseProvisionItem = {
        spec_id: "af-cards-token",
        status: "error",
        phase: "aws",
        message: "ECS deployment failed: insufficient capacity",
        error: "ECS deployment failed: insufficient capacity",
        runUrl: "https://github.com/org/repo/actions/runs/456",
      };

      const unit = mapSseItemToRunUnit(item);

      expect(unit.status).toBe("failed");
      expect(unit.isTerminal).toBe(true);
      expect(unit.error).toBe("ECS deployment failed: insufficient capacity");
      expect(unit.cssClass).toBe("status-provision-error");
    });

    it("preserves runUrl through normalization", () => {
      const runUrl = "https://github.com/postman-cs/svc/actions/runs/789";
      const item: SseProvisionItem = {
        spec_id: "test-svc",
        status: "running",
        phase: "postman",
        message: "Creating collections...",
        runUrl,
      };

      const unit = mapSseItemToRunUnit(item);

      expect(unit.runUrl).toBe(runUrl);
    });

    it("handles missing optional fields gracefully", () => {
      const item: SseProvisionItem = {
        spec_id: "minimal-svc",
        status: "queued",
        phase: "prepare",
        message: "Preparing...",
      };

      const unit = mapSseItemToRunUnit(item);

      expect(unit.runUrl).toBeUndefined();
      expect(unit.result).toBeUndefined();
      expect(unit.error).toBeUndefined();
      expect(unit.environment).toBeUndefined();
    });
  });

  describe("mapGraphNodeToRunUnit", () => {
    it("maps graph 'queued' to normalized 'queued' (non-terminal)", () => {
      const node: GraphBoardNode = {
        key: "af-cards-3ds/prod",
        spec_id: "af-cards-3ds",
        environment: "prod",
        layer_index: 0,
        status: "queued",
        message: "Queued for provisioning",
      };

      const unit = mapGraphNodeToRunUnit(node);

      expect(unit.status).toBe("queued");
      expect(unit.isTerminal).toBe(false);
      expect(unit.id).toBe("af-cards-3ds/prod");
      expect(unit.displayName).toBe("af-cards-3ds");
      expect(unit.environment).toBe("prod");
      expect(unit.layerIndex).toBe(0);
    });

    it("maps graph 'running' to normalized 'running' (non-terminal)", () => {
      const node: GraphBoardNode = {
        key: "af-core-deposits/stage",
        spec_id: "af-core-deposits",
        environment: "stage",
        layer_index: 1,
        status: "running",
        message: "Provisioning...",
        runUrl: "https://github.com/org/repo/actions/runs/321",
      };

      const unit = mapGraphNodeToRunUnit(node);

      expect(unit.status).toBe("running");
      expect(unit.isTerminal).toBe(false);
      expect(unit.cssClass).toBe("status-provision-running");
    });

    it("maps graph 'reused' to normalized 'reused' (terminal)", () => {
      const node: GraphBoardNode = {
        key: "existing-svc/prod",
        spec_id: "existing-svc",
        environment: "prod",
        layer_index: 0,
        status: "reused",
        message: "Reused existing deployment",
        result: { reuse_reason: "already_active" },
      };

      const unit = mapGraphNodeToRunUnit(node);

      expect(unit.status).toBe("reused");
      expect(unit.isTerminal).toBe(true);
      expect(unit.cssClass).toBe("status-provision-reused");
    });

    it("maps graph 'attached' to normalized 'attached' (terminal)", () => {
      const node: GraphBoardNode = {
        key: "attached-svc/dev",
        spec_id: "attached-svc",
        environment: "dev",
        layer_index: 0,
        status: "attached",
        message: "Attached existing deployment",
      };

      const unit = mapGraphNodeToRunUnit(node);

      expect(unit.status).toBe("attached");
      expect(unit.isTerminal).toBe(true);
      expect(unit.cssClass).toBe("status-provision-attached");
    });

    it("maps graph 'completed' to normalized 'completed' (terminal)", () => {
      const node: GraphBoardNode = {
        key: "new-svc/prod",
        spec_id: "new-svc",
        environment: "prod",
        layer_index: 2,
        status: "completed",
        message: "Provisioned successfully",
        result: {
          github: { repo_url: "https://github.com/org/new-svc" },
          aws: { invoke_url: "https://api.example.com/svc" },
        },
      };

      const unit = mapGraphNodeToRunUnit(node);

      expect(unit.status).toBe("completed");
      expect(unit.isTerminal).toBe(true);
      expect(unit.result).toEqual(node.result);
    });

    it("maps graph 'failed' to normalized 'failed' (terminal)", () => {
      const node: GraphBoardNode = {
        key: "failing-svc/prod",
        spec_id: "failing-svc",
        environment: "prod",
        layer_index: 1,
        status: "failed",
        message: "Workflow failed: container image not found",
      };

      const unit = mapGraphNodeToRunUnit(node);

      expect(unit.status).toBe("failed");
      expect(unit.isTerminal).toBe(true);
      expect(unit.cssClass).toBe("status-provision-error");
    });

    it("maps graph 'skipped' to normalized 'skipped' (terminal and immutable)", () => {
      const node: GraphBoardNode = {
        key: "blocked-svc/prod",
        spec_id: "blocked-svc",
        environment: "prod",
        layer_index: 1,
        status: "skipped",
        message: "Skipped due to missing hard dependency",
      };

      const unit = mapGraphNodeToRunUnit(node);

      expect(unit.status).toBe("skipped");
      expect(unit.isTerminal).toBe(true);
      expect(unit.cssClass).toBe("status-provision-skipped");
    });

    it("preserves runUrl through graph normalization", () => {
      const runUrl = "https://github.com/postman-cs/svc/actions/runs/999";
      const node: GraphBoardNode = {
        key: "svc-with-url/prod",
        spec_id: "svc-with-url",
        environment: "prod",
        layer_index: 0,
        status: "running",
        message: "In progress...",
        runUrl,
      };

      const unit = mapGraphNodeToRunUnit(node);

      expect(unit.runUrl).toBe(runUrl);
    });

    it("preserves result data through graph normalization", () => {
      const result = {
        github: { repo_url: "https://github.com/org/repo" },
        postman: { workspace_url: "https://postman.co/ws" },
        graph_node_status: "completed",
      };
      const node: GraphBoardNode = {
        key: "svc-with-result/stage",
        spec_id: "svc-with-result",
        environment: "stage",
        layer_index: 0,
        status: "completed",
        message: "Done",
        result,
      };

      const unit = mapGraphNodeToRunUnit(node);

      expect(unit.result).toEqual(result);
    });

    it("correctly identifies skipped nodes as immutable", () => {
      // Once a node is skipped, it should never transition to another state
      const skippedNode: GraphBoardNode = {
        key: "immutable-skip/prod",
        spec_id: "immutable-skip",
        environment: "prod",
        layer_index: 1,
        status: "skipped",
        message: "Blocked by dependency failure",
      };

      const unit = mapGraphNodeToRunUnit(skippedNode);

      // Skipped is terminal - no further transitions allowed
      expect(unit.isTerminal).toBe(true);
      expect(unit.status).toBe("skipped");
      
      // Verify skipped is in the terminal status list
      expect(isTerminalStatus(unit.status)).toBe(true);
    });
  });

  describe("resolveRunUnitCssClass", () => {
    it("returns correct CSS class for 'queued' status", () => {
      expect(resolveRunUnitCssClass("queued")).toBe("status-provision-queued");
    });

    it("returns correct CSS class for 'running' status", () => {
      expect(resolveRunUnitCssClass("running")).toBe("status-provision-running");
    });

    it("returns correct CSS class for 'completed' status", () => {
      expect(resolveRunUnitCssClass("completed")).toBe("status-provision-success");
    });

    it("returns correct CSS class for 'failed' status", () => {
      expect(resolveRunUnitCssClass("failed")).toBe("status-provision-error");
    });

    it("returns correct CSS class for 'reused' status", () => {
      expect(resolveRunUnitCssClass("reused")).toBe("status-provision-reused");
    });

    it("returns correct CSS class for 'attached' status", () => {
      expect(resolveRunUnitCssClass("attached")).toBe("status-provision-attached");
    });

    it("returns correct CSS class for 'skipped' status", () => {
      expect(resolveRunUnitCssClass("skipped")).toBe("status-provision-skipped");
    });

    it("returns fallback class for unknown statuses", () => {
      // This handles any future statuses that might be added
      const unknownStatus = "unknown" as RunUnitStatus;
      const cssClass = resolveRunUnitCssClass(unknownStatus);
      // Should return a safe fallback
      expect(cssClass).toBeDefined();
      expect(typeof cssClass).toBe("string");
    });
  });

  describe("Cross-format consistency", () => {
    it("both SSE 'success' and Graph 'completed' map to same terminal status", () => {
      const sseItem: SseProvisionItem = {
        spec_id: "svc-1",
        status: "success",
        phase: "complete",
        message: "Done",
      };
      const graphNode: GraphBoardNode = {
        key: "svc-2/prod",
        spec_id: "svc-2",
        environment: "prod",
        layer_index: 0,
        status: "completed",
        message: "Done",
      };

      const sseUnit = mapSseItemToRunUnit(sseItem);
      const graphUnit = mapGraphNodeToRunUnit(graphNode);

      expect(sseUnit.status).toBe("completed");
      expect(graphUnit.status).toBe("completed");
      expect(sseUnit.isTerminal).toBe(true);
      expect(graphUnit.isTerminal).toBe(true);
      expect(sseUnit.cssClass).toBe(graphUnit.cssClass);
    });

    it("both SSE 'error' and Graph 'failed' map to same terminal status", () => {
      const sseItem: SseProvisionItem = {
        spec_id: "svc-1",
        status: "error",
        phase: "error",
        message: "Failed",
        error: "Something went wrong",
      };
      const graphNode: GraphBoardNode = {
        key: "svc-2/prod",
        spec_id: "svc-2",
        environment: "prod",
        layer_index: 0,
        status: "failed",
        message: "Failed",
      };

      const sseUnit = mapSseItemToRunUnit(sseItem);
      const graphUnit = mapGraphNodeToRunUnit(graphNode);

      expect(sseUnit.status).toBe("failed");
      expect(graphUnit.status).toBe("failed");
      expect(sseUnit.isTerminal).toBe(true);
      expect(graphUnit.isTerminal).toBe(true);
      expect(sseUnit.cssClass).toBe(graphUnit.cssClass);
    });

    it("preserves all metadata fields through normalization", () => {
      const runUrl = "https://github.com/org/repo/actions/runs/123";
      const result = { test: "data", nested: { value: 42 } };
      
      const sseItem: SseProvisionItem = {
        spec_id: "metadata-test",
        status: "success",
        phase: "complete",
        message: "Complete",
        runUrl,
        result,
      };

      const graphNode: GraphBoardNode = {
        key: "metadata-test/prod",
        spec_id: "metadata-test",
        environment: "prod",
        layer_index: 3,
        status: "completed",
        message: "Complete",
        runUrl,
        result,
      };

      const sseUnit = mapSseItemToRunUnit(sseItem);
      const graphUnit = mapGraphNodeToRunUnit(graphNode);

      expect(sseUnit.runUrl).toBe(runUrl);
      expect(graphUnit.runUrl).toBe(runUrl);
      expect(sseUnit.result).toEqual(result);
      expect(graphUnit.result).toEqual(result);
    });
  });

  describe("Terminal state immutability", () => {
    it("skipped status is terminal and should never transition", () => {
      // This test documents the requirement that skipped nodes are immutable
      const skippedNode: GraphBoardNode = {
        key: "blocked/prod",
        spec_id: "blocked",
        environment: "prod",
        layer_index: 1,
        status: "skipped",
        message: "Skipped due to blocked dependency",
      };

      const unit = mapGraphNodeToRunUnit(skippedNode);
      
      // Verify the contract: skipped is terminal
      expect(unit.status).toBe("skipped");
      expect(unit.isTerminal).toBe(true);
      
      // Verify skipped is in the terminal list
      expect(isTerminalStatus("skipped")).toBe(true);
    });

    it("all terminal statuses are correctly identified", () => {
      const terminalStatuses: RunUnitStatus[] = [
        "completed",
        "failed",
        "reused",
        "attached",
        "skipped",
      ];
      const nonTerminalStatuses: RunUnitStatus[] = ["queued", "running"];

      for (const status of terminalStatuses) {
        expect(isTerminalStatus(status)).toBe(true);
      }

      for (const status of nonTerminalStatuses) {
        expect(isTerminalStatus(status)).toBe(false);
      }
    });
  });

  describe("Error detail preservation", () => {
    it("preserves SSE error message in normalized unit", () => {
      const errorMessage = "ECS task definition failed: Invalid container image";
      const item: SseProvisionItem = {
        spec_id: "failing-svc",
        status: "error",
        phase: "aws",
        message: errorMessage,
        error: errorMessage,
      };

      const unit = mapSseItemToRunUnit(item);

      expect(unit.error).toBe(errorMessage);
      expect(unit.message).toBe(errorMessage);
    });

    it("handles graph nodes with implicit error in message", () => {
      // Graph nodes don't always have a separate error field,
      // the error is often in the message
      const node: GraphBoardNode = {
        key: "failing/prod",
        spec_id: "failing",
        environment: "prod",
        layer_index: 0,
        status: "failed",
        message: "Workflow failed: timeout waiting for rollout",
      };

      const unit = mapGraphNodeToRunUnit(node);

      expect(unit.status).toBe("failed");
      expect(unit.message).toBe("Workflow failed: timeout waiting for rollout");
    });
  });
});

// Type-level tests to ensure the contract is sound
describe("Type-level contract verification", () => {
  it("RunUnitStatus covers all expected states", () => {
    const allStatuses: RunUnitStatus[] = [
      "queued",
      "running",
      "completed",
      "failed",
      "reused",
      "attached",
      "skipped",
    ];

    // This test will fail at compile time if RunUnitStatus is missing any states
    expect(allStatuses).toHaveLength(7);
  });

  it("RunUnit has all required fields", () => {
    const minimalUnit: RunUnit = {
      id: "test",
      displayName: "Test Service",
      status: "queued",
      message: "Testing",
      cssClass: "status-provision-queued",
      isTerminal: false,
    };

    expect(minimalUnit.id).toBeDefined();
    expect(minimalUnit.displayName).toBeDefined();
    expect(minimalUnit.status).toBeDefined();
    expect(minimalUnit.message).toBeDefined();
    expect(minimalUnit.cssClass).toBeDefined();
    expect(minimalUnit.isTerminal).toBeDefined();
  });
});
