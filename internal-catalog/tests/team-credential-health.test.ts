import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkCredentialHealth,
  discoverIdentityProfileFromAccessToken,
  validateAccessTokenForTeam,
  withRuntimeMetadata,
} from "../src/lib/team-credential-health";

describe("checkCredentialHealth", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns healthy when both credentials resolve to the same team", async () => {
    const mockFetch = vi.fn()
      // fetchApiKeyProfile -> public API /me
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user: { teamId: "111", teamName: "Alpha", teamDomain: "alpha" } }),
      })
      // discoverIdentityProfile -> iapub sessions
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session: {
            status: "active",
            identity: { team: 111, domain: "alpha" },
            data: { user: { teamName: "Alpha" } },
          },
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await checkCredentialHealth("PMAK-test", "token-test", "111");

    expect(result.status).toBe("healthy");
    expect(result.code).toBe("healthy");
    expect(result.blocked).toBe(false);
    expect(result.api_key_identity?.team_id).toBe("111");
    expect(result.access_token_identity?.team_id).toBe("111");
    expect(result.checked_at).toBeTruthy();
  });

  it("returns invalid with team_identity_mismatch when credentials belong to different teams", async () => {
    const mockFetch = vi.fn()
      // fetchApiKeyProfile
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user: { teamId: "111", teamName: "Alpha Team", teamDomain: "alpha" } }),
      })
      // iapub sessions -> different team
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session: {
            status: "active",
            identity: { team: 222, domain: "beta" },
            data: { user: { teamName: "Beta Team" } },
          },
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await checkCredentialHealth("PMAK-test", "token-test");

    expect(result.status).toBe("invalid");
    expect(result.code).toBe("team_identity_mismatch");
    expect(result.blocked).toBe(true);
    expect(result.message).toContain("Alpha Team");
    expect(result.message).toContain("Beta Team");
    expect(result.message).toContain("111");
    expect(result.message).toContain("222");
  });

  it("returns invalid when API key is rejected", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await checkCredentialHealth("bad-key", "token-test");

    expect(result.status).toBe("invalid");
    expect(result.code).toBe("api_key_invalid");
    expect(result.blocked).toBe(true);
    expect(result.message).toContain("invalid or revoked");
  });

  it("returns invalid when access token resolves to empty profile across all strategies", async () => {
    const mockFetch = vi.fn()
      // fetchApiKeyProfile
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user: { teamId: "111", teamName: "Alpha", teamDomain: "alpha" } }),
      })
      // iapub sessions -> fail
      .mockResolvedValueOnce({ ok: false })
      // system-envs fallback -> fail
      .mockResolvedValueOnce({ ok: false });
    vi.stubGlobal("fetch", mockFetch);

    const result = await checkCredentialHealth("PMAK-test", "bad-token");

    expect(result.status).toBe("invalid");
    expect(result.code).toBe("access_token_invalid");
    expect(result.blocked).toBe(true);
  });

  it("returns healthy when iapub fails but system-envs fallback resolves team", async () => {
    const mockFetch = vi.fn()
      // fetchApiKeyProfile
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user: { teamId: "999", teamName: "Gamma", teamDomain: "gamma" } }),
      })
      // iapub sessions -> fail
      .mockResolvedValueOnce({ ok: false })
      // system-envs fallback -> returns team data
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ teamId: "999", name: "Production" }] }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await checkCredentialHealth("PMAK-test", "token-test", "999");

    expect(result.status).toBe("healthy");
    expect(result.code).toBe("healthy");
    expect(result.blocked).toBe(false);
    expect(result.access_token_identity?.team_id).toBe("999");
  });

  it("includes x-entity-team-id for org-mode teams when checkCredentialHealth falls back from iapub to Bifrost", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user: { teamId: "999", teamName: "Gamma", teamDomain: "gamma" } }),
      })
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ teamId: "999" }] }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await checkCredentialHealth("PMAK-test", "token-test", { teamId: "999", orgMode: true });

    expect(result.status).toBe("healthy");
    const fallbackHeaders = mockFetch.mock.calls[2]?.[1]?.headers as Record<string, string>;
    expect(fallbackHeaders["x-entity-team-id"]).toBe("999");
  });

  it("returns warning when fetch throws a network error on API key check", async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await checkCredentialHealth("PMAK-test", "token-test");

    expect(result.status).toBe("warning");
    expect(result.code).toBe("postman_unreachable");
    expect(result.blocked).toBe(false);
  });
});

describe("withRuntimeMetadata", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attaches derived runtime metadata to a health summary", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user: { teamId: "111", teamName: "Alpha", teamDomain: "alpha" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session: {
            status: "active",
            identity: { team: 111, domain: "alpha" },
            data: { user: { teamName: "Alpha" } },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 111, name: "Alpha", handle: "alpha", memberCount: 22 },
            { id: 222, name: "Alpha Platform", handle: "alpha-platform", memberCount: 8 },
          ],
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await withRuntimeMetadata(
      { status: "healthy", code: "healthy", blocked: false },
      { api_key: "PMAK-test", access_token: "token-test", team_id: "111" },
    );

    expect(result.runtime_metadata?.workspace_team_count).toBe(2);
    expect(result.runtime_metadata?.detected_org_mode).toBe(true);
    expect(result.runtime_metadata?.workspace_teams).toHaveLength(2);
  });

  it("preserves existing runtime metadata when re-derivation fails", async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await withRuntimeMetadata(
      {
        status: "healthy",
        code: "healthy",
        blocked: false,
        runtime_metadata: {
          identity: { team_id: "111", team_name: "Alpha", slug: "alpha" },
          workspace_teams: [{ id: 111, name: "Alpha", handle: "alpha", memberCount: 22 }],
          workspace_team_count: 1,
          detected_org_mode: false,
          resolved_at: "2026-03-15T00:00:00.000Z",
        },
      },
      { api_key: "PMAK-test", access_token: "token-test", team_id: "111" },
    );

    expect(result.runtime_metadata?.workspace_team_count).toBe(1);
    expect(result.runtime_metadata?.identity.slug).toBe("alpha");
  });
});

describe("validateAccessTokenForTeam", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("omits x-entity-team-id for non-org mode tokens", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => "",
    });
    vi.stubGlobal("fetch", mockFetch);

    await validateAccessTokenForTeam("tok", { teamId: "123", orgMode: false });

    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["x-access-token"]).toBe("tok");
    expect(headers["x-entity-team-id"]).toBeUndefined();
  });

  it("includes x-entity-team-id for org mode tokens", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => "",
    });
    vi.stubGlobal("fetch", mockFetch);

    await validateAccessTokenForTeam("tok", { teamId: "123", orgMode: true });

    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["x-access-token"]).toBe("tok");
    expect(headers["x-entity-team-id"]).toBe("123");
  });
});

describe("discoverIdentityProfileFromAccessToken", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns full profile from iapub sessions endpoint (org-mode)", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        session: {
          status: "active",
          identity: { team: 13347347, domain: "field-services-v12-demo", user: 52358261 },
          data: { user: { teamName: "Field Services v12 Demo", username: "jboynton-pm" } },
        },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await discoverIdentityProfileFromAccessToken("tok", "13347347");

    expect(result).toEqual({
      team_id: "13347347",
      team_name: "Field Services v12 Demo",
      slug: "field-services-v12-demo",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe("https://iapub.postman.co/api/sessions/current");
  });

  it("returns full profile from iapub sessions endpoint (non-org-mode)", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        session: {
          status: "active",
          identity: { team: 14227644, domain: "restless-desert-677846", user: 53152579 },
          data: { user: { teamName: "restless-desert-677846" } },
        },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await discoverIdentityProfileFromAccessToken("tok");

    expect(result).toEqual({
      team_id: "14227644",
      team_name: "restless-desert-677846",
      slug: "restless-desert-677846",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to system-envs when iapub is unreachable", async () => {
    const mockFetch = vi.fn()
      // iapub -> network error
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      // system-envs fallback
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ teamId: 14103640 }] }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await discoverIdentityProfileFromAccessToken("tok", "14103640");

    expect(result).toEqual({ team_id: "14103640" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("omits x-entity-team-id in Bifrost fallback when org mode is unknown", async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ teamId: 14103640 }] }),
      });
    vi.stubGlobal("fetch", mockFetch);

    await discoverIdentityProfileFromAccessToken("tok", { teamId: "14103640" });

    const fallbackHeaders = mockFetch.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(fallbackHeaders["x-access-token"]).toBe("tok");
    expect(fallbackHeaders["x-entity-team-id"]).toBeUndefined();
  });

  it("includes x-entity-team-id in Bifrost fallback when org mode is confirmed", async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ teamId: 14103640 }] }),
      });
    vi.stubGlobal("fetch", mockFetch);

    await discoverIdentityProfileFromAccessToken("tok", { teamId: "14103640", orgMode: true });

    const fallbackHeaders = mockFetch.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(fallbackHeaders["x-access-token"]).toBe("tok");
    expect(fallbackHeaders["x-entity-team-id"]).toBe("14103640");
  });

  it("falls back to system-envs when iapub returns non-active session", async () => {
    const mockFetch = vi.fn()
      // iapub -> returns inactive session
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ session: { status: "expired", data: {} } }),
      })
      // system-envs fallback
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ teamId: "555" }] }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await discoverIdentityProfileFromAccessToken("tok", "555");

    expect(result).toEqual({ team_id: "555" });
  });

  it("returns empty profile when all strategies fail", async () => {
    const mockFetch = vi.fn()
      // iapub -> fail
      .mockResolvedValueOnce({ ok: false })
      // system-envs -> fail
      .mockResolvedValueOnce({ ok: false });
    vi.stubGlobal("fetch", mockFetch);

    const result = await discoverIdentityProfileFromAccessToken("tok", "999");

    expect(result).toEqual({});
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("handles numeric teamId in system-envs fallback", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ teamId: 42 }] }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await discoverIdentityProfileFromAccessToken("tok");

    expect(result).toEqual({ team_id: "42" });
  });

  it("does not send x-entity-team-id to iapub (iapub is not a Bifrost proxy)", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        session: {
          status: "active",
          identity: { team: 123, domain: "test" },
          data: { user: { teamName: "Test" } },
        },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await discoverIdentityProfileFromAccessToken("tok", "123");

    const iapubCall = mockFetch.mock.calls[0];
    const headers = iapubCall[1]?.headers as Record<string, string>;
    expect(headers["x-access-token"]).toBe("tok");
    expect(headers["x-entity-team-id"]).toBeUndefined();
  });
});
