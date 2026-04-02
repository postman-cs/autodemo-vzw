import { describe, expect, it } from "vitest";
import { buildProvisionWorkflowDefinition } from "../../src/lib/provision-workflow";
import {
  invalidPermissionKeys,
  toPolicyWorkflowModel,
  validateWorkflowFilePush,
} from "../helpers/github-action-policy";

describe("precommit class 1 workflow-file push policy", () => {
  const workflow = toPolicyWorkflowModel(buildProvisionWorkflowDefinition());

  it("never declares unsupported workflow permissions", () => {
    expect(invalidPermissionKeys(workflow.permissions)).toEqual([]);
    expect(Object.keys(workflow.permissions || {})).not.toContain("workflows");
  });

  it("requires non-persisted checkout before finalize writes workflow files", () => {
    const finalizeSteps = workflow.jobs.finalize?.steps || [];
    const checkoutPersistedCredentials = finalizeSteps
      .filter((step) => step.uses?.startsWith("actions/checkout@"))
      .some((step) => String(step.with?.["persist-credentials"] ?? "true") !== "false");

    const violations = finalizeSteps.flatMap((step) =>
      validateWorkflowFilePush(step, checkoutPersistedCredentials),
    );

    expect(violations).toEqual([]);
  });

  it("keeps finalize job permission keys within supported github token scopes", () => {
    expect(invalidPermissionKeys(workflow.jobs.finalize?.permissions)).toEqual([]);
  });
});
