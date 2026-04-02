import { describe, expect, it } from "vitest";
import {
  recoveryReasonLabel,
  toRecoveryQueueEntries,
  transitionRecoveryItemState,
} from "../frontend/src/lib/recovery-queue";

describe("recovery queue UI helpers", () => {
  it("maps recovery reason codes to user-facing labels", () => {
    expect(recoveryReasonLabel("github_repo_conflict")).toBe("GitHub repo already exists");
    expect(recoveryReasonLabel("residual_resources")).toBe("Residual resources detected");
    expect(recoveryReasonLabel("stale_provisioning")).toBe("Stuck provisioning");
    expect(recoveryReasonLabel("unknown_reason")).toBe("Recoverable failure");
  });

  it("builds and sorts recovery queue entries using registry titles", () => {
    const entries = toRecoveryQueueEntries(
      [
        {
          spec_id: "af-cards-3ds",
          reason: "github_repo_conflict",
          project_name: "af-cards-3ds",
          deployed_at: "2026-03-02T05:20:00.000Z",
        },
        {
          spec_id: "af-core-deposits",
          reason: "residual_resources",
          project_name: "af-core-deposits",
          deployed_at: "2026-03-02T06:20:00.000Z",
        },
      ],
      [
        { id: "af-cards-3ds", title: "3D Secure API" },
        { id: "af-core-deposits", title: "Core Deposits API" },
      ],
    );

    expect(entries).toHaveLength(2);
    expect(entries[0].spec_id).toBe("af-core-deposits");
    expect(entries[0].title).toBe("Core Deposits API");
    expect(entries[1].title).toBe("3D Secure API");
  });

  it("transitions item run states for recovery actions", () => {
    expect(transitionRecoveryItemState("idle", "start")).toBe("running");
    expect(transitionRecoveryItemState("running", "succeed")).toBe("success");
    expect(transitionRecoveryItemState("running", "fail")).toBe("error");
    expect(transitionRecoveryItemState("error", "reset")).toBe("idle");
  });
});
