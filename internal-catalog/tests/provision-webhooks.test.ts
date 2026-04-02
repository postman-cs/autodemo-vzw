import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clearInMemoryCallbackState, streamRunProgressFromCallbacks } from "../src/lib/provision-webhooks";
import { shouldUseCallbackWatchdogOnly } from "../src/lib/provision";
import { TEST_GITHUB_ORG } from "./helpers/constants";

describe("provision webhook callback streaming", () => {
  beforeEach(() => {
    clearInMemoryCallbackState();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearInMemoryCallbackState();
  });

  it("invokes onUpdate for non-terminal callback snapshots before watchdog timeout", async () => {
    vi.useFakeTimers();
    const onUpdate = vi.fn();
    const sse = { send: vi.fn() };
    let reads = 0;
    const env = {
      PROVISION_STATE: {
        put: vi.fn(),
        get: vi.fn(async () => {
          reads += 1;
          if (reads === 1) {
            return JSON.stringify({
              delivery: "delivery-1",
              event: "workflow_job",
              repo: `${TEST_GITHUB_ORG}/demo-repo`,
              runId: "42",
              status: "in_progress",
              conclusion: null,
              htmlUrl: "https://example.com/run/42",
              updatedAt: new Date().toISOString(),
              payload: {},
            });
          }
          return null;
        }),
      },
    };

    const promise = streamRunProgressFromCallbacks({
      env,
      repoName: "demo-repo",
      runId: 42,
      sse: sse as any,
      timeoutMs: 1000,
      onUpdate,
    });

    await vi.advanceTimersByTimeAsync(6000);
    await expect(promise).resolves.toEqual({ status: "timeout", conclusion: null, html_url: "" });
    expect(onUpdate).toHaveBeenCalledWith({
      status: "in_progress",
      conclusion: null,
      html_url: "https://example.com/run/42",
    });
  });

  it("treats fresh callback progress as watchdog-only state", () => {
    expect(shouldUseCallbackWatchdogOnly({
      callbacksEnabled: true,
      callbackState: { status: "in_progress", conclusion: null, html_url: "https://example.com/run/42" },
      callbackError: null,
      lastCallbackUpdateAt: 5_000,
      watchdogIntervalMs: 60_000,
      now: 20_000,
    })).toBe(true);

    expect(shouldUseCallbackWatchdogOnly({
      callbacksEnabled: true,
      callbackState: { status: "completed", conclusion: "success", html_url: "https://example.com/run/42" },
      callbackError: null,
      lastCallbackUpdateAt: 5_000,
      watchdogIntervalMs: 60_000,
      now: 20_000,
    })).toBe(false);
  });
});