import { describe, expect, it } from "vitest";
import type { DeploymentRecord } from "../src/lib/airtable";
import {
  buildRecoverableFailures,
  classifyRecoverableFailure,
} from "../src/lib/deployment-recovery";
import { TEST_GITHUB_ORG } from "./helpers/constants";

function failedRecord(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    spec_id: "af-cards-3ds",
    status: "failed",
    ...overrides,
  };
}

describe("deployment recovery classification", () => {
  it("classifies GitHub repo conflict failures as recoverable", () => {
    const record = failedRecord({
      error_message: `GitHub repo ${TEST_GITHUB_ORG}/af-cards-3ds already exists. Deprovision it first or choose a different name.`,
      github_repo_name: "af-cards-3ds",
    });

    const classified = classifyRecoverableFailure(record);
    expect(classified).toBeTruthy();
    expect(classified?.reason).toBe("github_repo_conflict");
    expect(classified?.project_name).toBe("af-cards-3ds");
  });

  it("classifies failed rows with residual resource hints as recoverable", () => {
    const record = failedRecord({
      error_message: "Workflow failed: cancelled",
      workspace_id: "ws-123",
    });

    const classified = classifyRecoverableFailure(record);
    expect(classified).toBeTruthy();
    expect(classified?.reason).toBe("residual_resources");
  });

  it("excludes deprovisioned tombstones from recoverable failures", () => {
    const record = failedRecord({
      error_message: "Deprovisioned",
      github_repo_name: "af-cards-3ds",
      workspace_id: "ws-123",
    });

    expect(classifyRecoverableFailure(record)).toBeNull();
  });

  it("excludes failed rows without residual signals", () => {
    const record = failedRecord({
      error_message: "Validation failed",
    });

    expect(classifyRecoverableFailure(record)).toBeNull();
  });

  it("returns only recoverable failed rows from mixed deployment states", () => {
    const records: DeploymentRecord[] = [
      {
        spec_id: "af-core-deposits",
        status: "active",
      },
      failedRecord({
        spec_id: "af-cards-3ds",
        error_message: `GitHub repo ${TEST_GITHUB_ORG}/af-cards-3ds already exists`,
        github_repo_name: "af-cards-3ds",
      }),
      failedRecord({
        spec_id: "af-risk-rules",
        error_message: "Deprovisioned",
        github_repo_name: "af-risk-rules",
      }),
    ];

    const recoverable = buildRecoverableFailures(records);
    expect(recoverable).toHaveLength(1);
    expect(recoverable[0].spec_id).toBe("af-cards-3ds");
  });

  it("preserves postman team slug on recoverable failures", () => {
    const recoverable = buildRecoverableFailures([
      failedRecord({
        spec_id: "af-cards-3ds",
        postman_team_slug: "field-services-v12-demo",
        error_message: `GitHub repo ${TEST_GITHUB_ORG}/af-cards-3ds already exists`,
        github_repo_name: "af-cards-3ds",
      }),
    ]);

    expect(recoverable).toHaveLength(1);
    expect(recoverable[0].postman_team_slug).toBe("field-services-v12-demo");
  });

  it("classifies provisioning records older than 30 min as stale_provisioning", () => {
    const thirtyOneMinAgo = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const record: DeploymentRecord = {
      spec_id: "af-invest-orders",
      status: "provisioning",
      deployed_at: thirtyOneMinAgo,
      github_repo_name: "af-invest-orders",
    };

    const classified = classifyRecoverableFailure(record);
    expect(classified).toBeTruthy();
    expect(classified?.reason).toBe("stale_provisioning");
    expect(classified?.project_name).toBe("af-invest-orders");
  });

  it("does not classify provisioning records younger than 30 min", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const record: DeploymentRecord = {
      spec_id: "af-invest-orders",
      status: "provisioning",
      deployed_at: tenMinAgo,
    };

    expect(classifyRecoverableFailure(record)).toBeNull();
  });

  it("classifies provisioning records with no deployed_at as stale", () => {
    const record: DeploymentRecord = {
      spec_id: "af-invest-orders",
      status: "provisioning",
    };

    const classified = classifyRecoverableFailure(record);
    expect(classified).toBeTruthy();
    expect(classified?.reason).toBe("stale_provisioning");
  });

  it("synthesizes a clear error message for stale provisioning without error text", () => {
    const staleTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const record: DeploymentRecord = {
      spec_id: "af-invest-orders",
      status: "provisioning",
      deployed_at: staleTime,
      error_message: "",
    };

    const classified = classifyRecoverableFailure(record);
    expect(classified).toBeTruthy();
    expect(classified?.reason).toBe("stale_provisioning");
    expect(classified?.error_message).toBe("Provisioning exceeded 30 minutes without terminal workflow state.");
  });

  it("includes stale provisioning alongside failed records in buildRecoverableFailures", () => {
    const now = Date.parse("2026-03-04T12:00:00.000Z");
    const staleTime = "2026-03-04T10:00:00.000Z"; // 2 hours ago
    const records: DeploymentRecord[] = [
      {
        spec_id: "af-core-deposits",
        status: "active",
      },
      failedRecord({
        spec_id: "af-cards-3ds",
        error_message: `GitHub repo ${TEST_GITHUB_ORG}/af-cards-3ds already exists`,
        github_repo_name: "af-cards-3ds",
        deployed_at: "2026-03-04T11:00:00.000Z",
      }),
      {
        spec_id: "af-invest-orders",
        status: "provisioning",
        deployed_at: staleTime,
        github_repo_name: "af-invest-orders",
      },
    ];

    const recoverable = buildRecoverableFailures(records, now);
    expect(recoverable).toHaveLength(2);
    const reasons = recoverable.map((r) => r.reason);
    expect(reasons).toContain("github_repo_conflict");
    expect(reasons).toContain("stale_provisioning");
  });

  it("keeps only the latest recoverable failed row per spec", () => {
    const records: DeploymentRecord[] = [
      failedRecord({
        spec_id: "af-core-ledger",
        error_message: `GitHub repo ${TEST_GITHUB_ORG}/af-core-ledger already exists`,
        github_repo_name: "af-core-ledger",
        deployed_at: "2026-03-02T01:00:00.000Z",
      }),
      failedRecord({
        spec_id: "af-core-ledger",
        error_message: `GitHub repo ${TEST_GITHUB_ORG}/af-core-ledger already exists`,
        github_repo_name: "af-core-ledger",
        deployed_at: "2026-03-02T03:00:00.000Z",
        failed_at_step: "github",
      }),
    ];

    const recoverable = buildRecoverableFailures(records);
    expect(recoverable).toHaveLength(1);
    expect(recoverable[0].spec_id).toBe("af-core-ledger");
    expect(recoverable[0].deployed_at).toBe("2026-03-02T03:00:00.000Z");
    expect(recoverable[0].failed_at_step).toBe("github");
  });
});
