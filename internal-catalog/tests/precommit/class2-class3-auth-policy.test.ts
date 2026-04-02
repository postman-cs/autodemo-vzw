import { describe, expect, it } from "vitest";
import { buildProvisionWorkflowDefinition } from "../../src/lib/provision-workflow";
import { selectAuthStrategyForRequest } from "../../.github/actions/_lib/github-api";
import {
  toPolicyWorkflowModel,
  validateCrossRepoCheckout,
} from "../helpers/github-action-policy";
import { TEST_GITHUB_ORG } from "../helpers/constants";

describe("precommit class 2 cross-repo checkout policy", () => {
  const workflow = toPolicyWorkflowModel(buildProvisionWorkflowDefinition());

  it("never uses github.token for cross-repo checkouts", () => {
    const violations = Object.values(workflow.jobs)
      .flatMap((job) => job.steps)
      .flatMap((step) => validateCrossRepoCheckout(step));

    expect(violations).toEqual([]);
  });
});

describe("precommit class 3 auth selection policy", () => {
  it("prefers github-token for same-repo repository variable writes", () => {
    expect(selectAuthStrategyForRequest({
      method: "POST",
      pathname: "/repos/postman-cs/demo/actions/variables",
      sameRepository: true,
    })).toBe("github-token");

    expect(selectAuthStrategyForRequest({
      method: "PATCH",
      pathname: "/repos/postman-cs/demo/actions/variables/RUNTIME_BASE_URL",
      sameRepository: true,
    })).toBe("github-token");
  });

  it("preserves pat usage for cross-repo and workflow-file operations", () => {
    expect(selectAuthStrategyForRequest({
      method: "GET",
      pathname: `/repos/${TEST_GITHUB_ORG}/vzw-partner-demo-admin-management/contents/.github/actions/finalize/action.yml`,
      sameRepository: false,
    })).toBe("pat");

    expect(selectAuthStrategyForRequest({
      method: "PUT",
      pathname: "/repos/postman-cs/demo/contents/.github/workflows/ci.yml",
      sameRepository: true,
    })).toBe("pat");
  });

  it("keeps repo-scoped token budget for bulk variable writes", () => {
    const writes = Array.from({ length: 65 }, (_, index) =>
      selectAuthStrategyForRequest({
        method: index % 2 === 0 ? "POST" : "PATCH",
        pathname: index % 2 === 0
          ? "/repos/postman-cs/demo/actions/variables"
          : `/repos/postman-cs/demo/actions/variables/VAR_${index}`,
        sameRepository: true,
      }),
    );

    expect(new Set(writes)).toEqual(new Set(["github-token"]));
  });
});
