import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  deriveTeamRuntimeMetadata,
  fetchAccessibleTeams,
  validateIdentityConsistency,
  summarizeWorkspaceTeams,
  type WorkspaceTeam,
  type TeamRuntimeMetadata,
} from "../src/lib/team-runtime-metadata";

describe("team-runtime-metadata", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fetchAccessibleTeams", () => {
    it("returns teams from the direct Postman teams API", async () => {
      const mockTeams: WorkspaceTeam[] = [
        { id: 12345, name: "Acme Corp", handle: "acme-corp", memberCount: 42 },
        { id: 12346, name: "Acme Subsidiary", handle: "acme-subsidiary", memberCount: 15 },
      ];
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: mockTeams }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await fetchAccessibleTeams("PMAK-test");

      expect(result).toEqual(mockTeams);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.getpostman.com/teams",
        {
          headers: { "X-Api-Key": "PMAK-test" },
        },
      );
    });

    it("returns empty array when API returns no teams", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await fetchAccessibleTeams("PMAK-test");

      expect(result).toEqual([]);
    });

    it("throws when API request fails", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(fetchAccessibleTeams("bad-key")).rejects.toThrow("Failed to fetch teams");
    });

    it("uses the API key even when an access token is also available", async () => {
      const mockTeams: WorkspaceTeam[] = [
        { id: 12345, name: "Acme Corp", handle: "acme-corp", memberCount: 42 },
      ];
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: mockTeams }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await fetchAccessibleTeams("PMAK-test", "test-access-token");

      expect(result).toEqual(mockTeams);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.getpostman.com/teams",
        {
          headers: { "X-Api-Key": "PMAK-test" },
        },
      );
    });
  });

  describe("deriveTeamRuntimeMetadata", () => {
    it("derives runtime metadata for org-mode team (multiple teams)", async () => {
      const mockFetch = vi.fn()
        // fetchApiKeyProfile -> /me
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ user: { teamId: "12345", teamName: "Acme Corp", teamDomain: "acme-corp" } }),
        })
        // fetchAccessibleTeams -> Bifrost /api/teams
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [
              { id: 12345, name: "Acme Corp", handle: "acme-corp", memberCount: 42 },
              { id: 12346, name: "Acme Subsidiary", handle: "acme-subsidiary", memberCount: 15 },
            ],
          }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const result = await deriveTeamRuntimeMetadata({ api_key: "PMAK-test" });

      expect(result.identity.team_id).toBe("12345");
      expect(result.identity.team_name).toBe("Acme Corp");
      expect(result.identity.slug).toBe("acme-corp");
      expect(result.workspace_team_count).toBe(2);
      expect(result.detected_org_mode).toBe(true);
      expect(result.workspace_teams).toHaveLength(2);
      expect(result.resolved_at).toBeTruthy();
    });

    it("derives runtime metadata for non-org team (single team)", async () => {
      const mockFetch = vi.fn()
        // fetchApiKeyProfile -> /me
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ user: { teamId: "54321", teamName: "Solo Dev", teamDomain: "solo-dev" } }),
        })
        // fetchAccessibleTeams -> Bifrost /api/teams
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [
              { id: 54321, name: "Solo Dev", handle: "solo-dev", memberCount: 1 },
            ],
          }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const result = await deriveTeamRuntimeMetadata({ api_key: "PMAK-test" });

      expect(result.identity.team_id).toBe("54321");
      expect(result.workspace_team_count).toBe(1);
      expect(result.detected_org_mode).toBe(false);
    });

    it("derives runtime metadata using both api_key and access_token", async () => {
      const mockFetch = vi.fn()
        // fetchApiKeyProfile -> /me
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ user: { teamId: "12345", teamName: "Acme Corp", teamDomain: "acme-corp" } }),
        })
        // discoverIdentityProfileFromAccessToken -> iapub
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            session: {
              status: "active",
              identity: { team: 12345, domain: "acme-corp" },
              data: { user: { teamName: "Acme Corp" } },
            },
          }),
        })
        // fetchAccessibleTeams -> Bifrost /api/teams
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [
              { id: 12345, name: "Acme Corp", handle: "acme-corp", memberCount: 42 },
            ],
          }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const result = await deriveTeamRuntimeMetadata({
        api_key: "PMAK-test",
        access_token: "tok-test",
      });

      expect(result.identity.team_id).toBe("12345");
      expect(result.identity.team_name).toBe("Acme Corp");
      expect(result.workspace_team_count).toBe(1);
    });

    it("fills identity gaps from access token when api_key profile is incomplete", async () => {
      const mockFetch = vi.fn()
        // fetchApiKeyProfile -> /me (no teamName or slug)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ user: { teamId: "12345" } }),
        })
        // discoverIdentityProfileFromAccessToken -> iapub
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            session: {
              status: "active",
              identity: { team: 12345, domain: "acme-corp" },
              data: { user: { teamName: "Acme Corp" } },
            },
          }),
        })
        // fetchAccessibleTeams -> /teams
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [
              { id: 12345, name: "Acme Corp", handle: "acme-corp", memberCount: 42 },
            ],
          }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const result = await deriveTeamRuntimeMetadata({
        api_key: "PMAK-test",
        access_token: "tok-test",
      });

      expect(result.identity.team_id).toBe("12345");
      expect(result.identity.team_name).toBe("Acme Corp");
      expect(result.identity.slug).toBe("acme-corp");
      expect(result.workspace_team_count).toBe(1);
      expect(result.workspace_teams).toHaveLength(1);
    });

    it("handles teams fetch failure gracefully", async () => {
      const mockFetch = vi.fn()
        // fetchApiKeyProfile -> /me
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ user: { teamId: "12345", teamName: "Acme Corp", teamDomain: "acme-corp" } }),
        })
        // fetchAccessibleTeams -> fails
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        });
      vi.stubGlobal("fetch", mockFetch);

      const result = await deriveTeamRuntimeMetadata({ api_key: "PMAK-test" });

      // Identity should still be resolved
      expect(result.identity.team_id).toBe("12345");
      // But teams should be empty
      expect(result.workspace_teams).toEqual([]);
      expect(result.workspace_team_count).toBe(0);
      expect(result.detected_org_mode).toBe(false);
    });

    it("handles api_key identity resolution failure gracefully", async () => {
      const mockFetch = vi.fn()
        // fetchApiKeyProfile -> fails
        .mockRejectedValueOnce(new Error("Network error"))
        // discoverIdentityProfileFromAccessToken -> iapub
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            session: {
              status: "active",
              identity: { team: 12345, domain: "acme-corp" },
              data: { user: { teamName: "Acme Corp" } },
            },
          }),
        })
        // fetchAccessibleTeams -> Bifrost /api/teams
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [
              { id: 12345, name: "Acme Corp", handle: "acme-corp", memberCount: 42 },
            ],
          }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const result = await deriveTeamRuntimeMetadata({
        api_key: "bad-key",
        access_token: "tok-test",
      });

      // Should still resolve from access token
      expect(result.identity.team_id).toBe("12345");
      expect(result.identity.team_name).toBe("Acme Corp");
    });

    it("derives runtime metadata with zero teams (edge case)", async () => {
      const mockFetch = vi.fn()
        // fetchApiKeyProfile -> /me
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ user: { teamId: "12345", teamName: "Acme Corp", teamDomain: "acme-corp" } }),
        })
        // fetchAccessibleTeams -> Bifrost returns empty
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [] }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const result = await deriveTeamRuntimeMetadata({ api_key: "PMAK-test" });

      expect(result.workspace_team_count).toBe(0);
      expect(result.detected_org_mode).toBe(false);
    });
  });

  describe("validateIdentityConsistency", () => {
    const baseMetadata: TeamRuntimeMetadata = {
      identity: {
        team_id: "12345",
        team_name: "Acme Corp",
        slug: "acme-corp",
      },
      workspace_teams: [],
      workspace_team_count: 1,
      detected_org_mode: false,
      resolved_at: new Date().toISOString(),
    };

    it("passes when no expected values provided", () => {
      expect(() => validateIdentityConsistency(baseMetadata)).not.toThrow();
    });

    it("passes when expected values match resolved identity", () => {
      expect(() =>
        validateIdentityConsistency(baseMetadata, {
          team_id: "12345",
          team_name: "Acme Corp",
          slug: "acme-corp",
        }),
      ).not.toThrow();
    });

    it("throws when team_id mismatches", () => {
      expect(() =>
        validateIdentityConsistency(baseMetadata, { team_id: "99999" }),
      ).toThrow("Team ID mismatch");
    });

    it("throws when slug mismatches", () => {
      expect(() =>
        validateIdentityConsistency(baseMetadata, { slug: "different-slug" }),
      ).toThrow("Team slug mismatch");
    });

    it("throws when team_name mismatches", () => {
      expect(() =>
        validateIdentityConsistency(baseMetadata, { team_name: "Different Name" }),
      ).toThrow("Team name mismatch");
    });

    it("passes when resolved value is undefined", () => {
      const metadataWithUndefined: TeamRuntimeMetadata = {
        ...baseMetadata,
        identity: { team_id: undefined, team_name: undefined, slug: undefined },
      };
      // Should not throw even with expected values, since we can't validate
      expect(() =>
        validateIdentityConsistency(metadataWithUndefined, { team_id: "12345" }),
      ).not.toThrow();
    });
  });

  describe("summarizeWorkspaceTeams", () => {
    it("summarizes teams without memberCount", () => {
      const teams: WorkspaceTeam[] = [
        { id: 12345, name: "Acme Corp", handle: "acme-corp", memberCount: 42 },
        { id: 12346, name: "Acme Subsidiary", handle: "acme-subsidiary", memberCount: 15 },
      ];

      const result = summarizeWorkspaceTeams(teams);

      expect(result).toEqual([
        { id: 12345, name: "Acme Corp", handle: "acme-corp" },
        { id: 12346, name: "Acme Subsidiary", handle: "acme-subsidiary" },
      ]);
    });

    it("returns empty array for empty input", () => {
      const result = summarizeWorkspaceTeams([]);
      expect(result).toEqual([]);
    });
  });

  describe("derives runtime metadata correctly for integration scenarios", () => {
    it("handles org-mode detection with exact boundary condition (2 teams)", async () => {
      const mockFetch = vi.fn()
        // fetchApiKeyProfile -> /me
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ user: { teamId: "1", teamName: "Team One", teamDomain: "team-one" } }),
        })
        // fetchAccessibleTeams -> Bifrost returns exactly 2 teams (boundary condition)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [
              { id: 1, name: "Team One", handle: "team-one", memberCount: 10 },
              { id: 2, name: "Team Two", handle: "team-two", memberCount: 5 },
            ],
          }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const result = await deriveTeamRuntimeMetadata({ api_key: "PMAK-test" });

      expect(result.workspace_team_count).toBe(2);
      expect(result.detected_org_mode).toBe(true);
    });

    it("handles non-org detection at boundary condition (1 team)", async () => {
      const mockFetch = vi.fn()
        // fetchApiKeyProfile -> /me
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ user: { teamId: "1", teamName: "Solo Team", teamDomain: "solo-team" } }),
        })
        // fetchAccessibleTeams -> Bifrost returns exactly 1 team
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [
              { id: 1, name: "Solo Team", handle: "solo-team", memberCount: 1 },
            ],
          }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const result = await deriveTeamRuntimeMetadata({ api_key: "PMAK-test" });

      expect(result.workspace_team_count).toBe(1);
      expect(result.detected_org_mode).toBe(false);
    });
  });
});
