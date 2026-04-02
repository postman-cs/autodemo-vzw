import { describe, expect, it } from "vitest";
import { shouldTriggerRecheck, mergeHealthIntoTeams } from "../frontend/src/lib/credential-verify";
import type { TeamRegistryEntry } from "../frontend/src/lib/types";

function makeTeam(overrides: Partial<TeamRegistryEntry> = {}): TeamRegistryEntry {
  return {
    slug: "test-team",
    team_id: "12345",
    team_name: "Test Team",
    has_api_key: true,
    has_access_token: true,
    health_status: "unchecked",
    ...overrides,
  };
}

describe("shouldTriggerRecheck", () => {
  it("returns true for unchecked team with credentials", () => {
    expect(shouldTriggerRecheck(makeTeam({ health_status: "unchecked" }))).toBe(true);
  });

  it("returns true for stale team with credentials", () => {
    expect(shouldTriggerRecheck(makeTeam({ health_status: "stale" }))).toBe(true);
  });

  it("returns true when health_status is undefined (defaults to unchecked)", () => {
    expect(shouldTriggerRecheck(makeTeam({ health_status: undefined }))).toBe(true);
  });

  it("returns false for healthy team", () => {
    expect(shouldTriggerRecheck(makeTeam({ health_status: "healthy" }))).toBe(false);
  });

  it("returns false for invalid team", () => {
    expect(shouldTriggerRecheck(makeTeam({ health_status: "invalid" }))).toBe(false);
  });

  it("returns false for warning team", () => {
    expect(shouldTriggerRecheck(makeTeam({ health_status: "warning" }))).toBe(false);
  });

  it("returns false when API key is missing", () => {
    expect(shouldTriggerRecheck(makeTeam({ has_api_key: false }))).toBe(false);
  });

  it("returns false when access token is missing", () => {
    expect(shouldTriggerRecheck(makeTeam({ has_access_token: false }))).toBe(false);
  });

  it("returns false for undefined team", () => {
    expect(shouldTriggerRecheck(undefined)).toBe(false);
  });
});

describe("mergeHealthIntoTeams", () => {
  const teamA = makeTeam({ slug: "alpha", team_name: "Alpha", health_status: "unchecked" });
  const teamB = makeTeam({ slug: "bravo", team_name: "Bravo", health_status: "stale" });
  const teamC = makeTeam({ slug: "charlie", team_name: "Charlie", health_status: "unchecked" });
  const teams = [teamA, teamB, teamC];

  it("updates only the matching team by slug", () => {
    const result = mergeHealthIntoTeams(teams, "bravo", {
      status: "healthy",
      message: "All good",
      checked_at: "2026-03-14T10:00:00Z",
      blocked: false,
    });

    expect(result).toHaveLength(3);
    expect(result[0].health_status).toBe("unchecked");
    expect(result[1].health_status).toBe("healthy");
    expect(result[1].health_message).toBe("All good");
    expect(result[1].health_checked_at).toBe("2026-03-14T10:00:00Z");
    expect(result[1].provisioning_blocked).toBe(false);
    expect(result[2].health_status).toBe("unchecked");
  });

  it("preserves non-health fields on the updated team", () => {
    const result = mergeHealthIntoTeams(teams, "bravo", {
      status: "healthy",
      message: "OK",
      checked_at: "2026-03-14T10:00:00Z",
      blocked: false,
    });

    expect(result[1].slug).toBe("bravo");
    expect(result[1].team_name).toBe("Bravo");
    expect(result[1].team_id).toBe("12345");
    expect(result[1].has_api_key).toBe(true);
    expect(result[1].has_access_token).toBe(true);
  });

  it("returns a new array (does not mutate input)", () => {
    const result = mergeHealthIntoTeams(teams, "bravo", { status: "healthy" });
    expect(result).not.toBe(teams);
    expect(teams[1].health_status).toBe("stale");
  });

  it("returns unchanged array copy when slug does not match", () => {
    const result = mergeHealthIntoTeams(teams, "nonexistent", { status: "healthy" });
    expect(result).toHaveLength(3);
    expect(result[0].health_status).toBe("unchecked");
    expect(result[1].health_status).toBe("stale");
    expect(result[2].health_status).toBe("unchecked");
  });
});
