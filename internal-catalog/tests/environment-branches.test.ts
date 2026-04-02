import { describe, expect, it } from "vitest";
import { getEnvironmentBranchMap, getEnvironmentBranchName } from "../src/lib/environment-branches";

describe("environment branch naming", () => {
  it("builds canonical env/<slug> branch names", () => {
    expect(getEnvironmentBranchName("prod")).toBe("env/prod");
    expect(getEnvironmentBranchName("stage")).toBe("env/stage");
  });

  it("normalizes branch names for mixed/unsafe input", () => {
    expect(getEnvironmentBranchName("Staging EU")).toBe("env/staging-eu");
    expect(getEnvironmentBranchName("   ")).toBe("env/prod");
  });

  it("returns a deterministic map for selected environments", () => {
    expect(getEnvironmentBranchMap(["prod", "Stage", "dev env"])).toEqual({
      prod: "env/prod",
      stage: "env/stage",
      "dev-env": "env/dev-env",
    });
  });
});
