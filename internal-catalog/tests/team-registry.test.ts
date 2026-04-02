import { describe, it, expect, beforeEach } from "vitest";
import {
  deleteTeam,
  getTeam,
  getTeamById,
  listTeams,
  parseTeamConfigsFromEnv,
  putTeam,
  resolveTeamCredentials,
  seedTeamsFromEnv,
  type TeamConfig,
} from "../src/lib/team-registry";

class MockKv {
  private store = new Map<string, string>();

  async get(key: string, type?: "json"): Promise<any> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    if (type === "json") return JSON.parse(value);
    return value;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

const TEAM: TeamConfig = {
  slug: "field-services-v12-demo",
  team_id: "13347347",
  team_name: "Field Services v12 Demo",
  api_key: "PMAK-test",
  access_token: "token-test",
};

describe("team-registry", () => {
  let kv: MockKv;

  beforeEach(() => {
    kv = new MockKv();
  });

  it("putTeam creates team, reverse lookup, and index", async () => {
    await putTeam(kv as unknown as KVNamespace, TEAM);

    expect(await getTeam(kv as unknown as KVNamespace, TEAM.slug)).toMatchObject(TEAM);
    expect(await getTeamById(kv as unknown as KVNamespace, TEAM.team_id)).toMatchObject(TEAM);
    expect(await listTeams(kv as unknown as KVNamespace)).toEqual([TEAM.slug]);
  });

  it("org_mode flag round-trips correctly", async () => {
    const orgTeam = { ...TEAM, slug: "org-team", team_id: "222", org_mode: true };
    await putTeam(kv as unknown as KVNamespace, orgTeam);

    const retrieved = await getTeam(kv as unknown as KVNamespace, orgTeam.slug);
    expect(retrieved?.org_mode).toBe(true);

    const defaultRetrieved = await getTeam(kv as unknown as KVNamespace, TEAM.slug);
    expect(defaultRetrieved?.org_mode).toBeFalsy(); // It's strictly boolean, so it's undefined or false, but `getTeam` normalizes to false/boolean.
  });

  it("deleteTeam removes team keys and index entry", async () => {
    await putTeam(kv as unknown as KVNamespace, TEAM);
    const deleted = await deleteTeam(kv as unknown as KVNamespace, TEAM.slug);

    expect(deleted).toBe(true);
    expect(await getTeam(kv as unknown as KVNamespace, TEAM.slug)).toBeNull();
    expect(await getTeamById(kv as unknown as KVNamespace, TEAM.team_id)).toBeNull();
    expect(await listTeams(kv as unknown as KVNamespace)).toEqual([]);
  });

  it("resolveTeamCredentials throws error when KV is unbound", async () => {
    await expect(
      resolveTeamCredentials(undefined, {}, "some-slug")
    ).rejects.toThrow("TEAM_REGISTRY KV binding is required to resolve tenant credentials.");
  });

  it("resolveTeamCredentials throws error when team slug is missing", async () => {
    await expect(
      resolveTeamCredentials(kv as unknown as KVNamespace, {})
    ).rejects.toThrow("Missing or invalid team_slug. Cannot resolve tenant context.");
  });

  it("resolveTeamCredentials returns KV credentials when slug matches", async () => {
    await putTeam(kv as unknown as KVNamespace, TEAM);
    const creds = await resolveTeamCredentials(
      kv as unknown as KVNamespace,
      {
        POSTMAN_API_KEY: "fallback-key",
        POSTMAN_ACCESS_TOKEN: "fallback-token",
        POSTMAN_TEAM_ID: "111",
      },
      TEAM.slug,
    );

    expect(creds).toEqual({
      api_key: TEAM.api_key,
      access_token: TEAM.access_token,
      team_id: TEAM.team_id,
      team_name: TEAM.team_name,
      slug: TEAM.slug,
      org_mode: false,
    });
  });
});

describe("parseTeamConfigsFromEnv", () => {
  it("parses multiple teams from POSTMAN_TEAM__* env vars", () => {
    const env: Record<string, unknown> = {
      POSTMAN_TEAM__FIELD_SERVICES__API_KEY: "PMAK-fs",
      POSTMAN_TEAM__FIELD_SERVICES__ACCESS_TOKEN: "token-fs",
      POSTMAN_TEAM__FIELD_SERVICES__TEAM_ID: "13347347",
      POSTMAN_TEAM__FIELD_SERVICES__TEAM_NAME: "Field Services v12 Demo",
      POSTMAN_TEAM__FIELD_SERVICES__ORG_MODE: "true",
      POSTMAN_TEAM__ACME_CORP__API_KEY: "PMAK-acme",
      POSTMAN_TEAM__ACME_CORP__ACCESS_TOKEN: "token-acme",
      POSTMAN_TEAM__ACME_CORP__TEAM_ID: "99887766",
      POSTMAN_TEAM__ACME_CORP__TEAM_NAME: "Acme Corp",
      GH_TOKEN: "ghp_xxx",
    };

    const teams = parseTeamConfigsFromEnv(env);

    expect(teams).toHaveLength(2);
    const fs = teams.find((t) => t.slug === "field-services");
    expect(fs).toBeDefined();
    expect(fs!.api_key).toBe("PMAK-fs");
    expect(fs!.access_token).toBe("token-fs");
    expect(fs!.team_id).toBe("13347347");
    expect(fs!.team_name).toBe("Field Services v12 Demo");
    expect(fs!.org_mode).toBe(true);

    const acme = teams.find((t) => t.slug === "acme-corp");
    expect(acme).toBeDefined();
    expect(acme!.api_key).toBe("PMAK-acme");
    expect(acme!.team_id).toBe("99887766");
    expect(acme!.org_mode).toBe(false);
  });

  it("skips teams missing required fields", () => {
    const env: Record<string, unknown> = {
      POSTMAN_TEAM__INCOMPLETE__API_KEY: "PMAK-inc",
      // Missing ACCESS_TOKEN and TEAM_ID
      POSTMAN_TEAM__VALID__API_KEY: "PMAK-valid",
      POSTMAN_TEAM__VALID__ACCESS_TOKEN: "token-valid",
      POSTMAN_TEAM__VALID__TEAM_ID: "12345",
    };

    const teams = parseTeamConfigsFromEnv(env);
    expect(teams).toHaveLength(1);
    expect(teams[0].slug).toBe("valid");
  });

  it("returns empty array when no POSTMAN_TEAM__* vars exist", () => {
    const env: Record<string, unknown> = {
      GH_TOKEN: "ghp_xxx",
      POSTMAN_API_KEY: "legacy-key",
    };

    expect(parseTeamConfigsFromEnv(env)).toEqual([]);
  });

  it("handles SYSTEM_ENV_ID optional field", () => {
    const env: Record<string, unknown> = {
      POSTMAN_TEAM__MY_TEAM__API_KEY: "PMAK-mt",
      POSTMAN_TEAM__MY_TEAM__ACCESS_TOKEN: "token-mt",
      POSTMAN_TEAM__MY_TEAM__TEAM_ID: "555",
      POSTMAN_TEAM__MY_TEAM__SYSTEM_ENV_ID: "uuid-123",
    };

    const teams = parseTeamConfigsFromEnv(env);
    expect(teams).toHaveLength(1);
    expect(teams[0].system_env_id).toBe("uuid-123");
    expect(teams[0].team_name).toBe("my-team"); // Falls back to slug
  });

  it("emits entries with empty team_id when TEAM_ID is non-string", () => {
    const env: Record<string, unknown> = {
      POSTMAN_TEAM__TEST__API_KEY: "PMAK-test",
      POSTMAN_TEAM__TEST__ACCESS_TOKEN: "token-test",
      POSTMAN_TEAM__TEST__TEAM_ID: 12345 as unknown,
    };

    const teams = parseTeamConfigsFromEnv(env);
    expect(teams).toHaveLength(1);
    expect(teams[0].slug).toBe("test");
    expect(teams[0].team_id).toBe("");
  });
});

describe("seedTeamsFromEnv", () => {
  it("seeds KV from env vars and returns slugs", async () => {
    const kv = new MockKv();
    const env: Record<string, unknown> = {
      POSTMAN_TEAM__ALPHA__API_KEY: "PMAK-a",
      POSTMAN_TEAM__ALPHA__ACCESS_TOKEN: "token-a",
      POSTMAN_TEAM__ALPHA__TEAM_ID: "111",
      POSTMAN_TEAM__BETA__API_KEY: "PMAK-b",
      POSTMAN_TEAM__BETA__ACCESS_TOKEN: "token-b",
      POSTMAN_TEAM__BETA__TEAM_ID: "222",
    };

    const seeded = await seedTeamsFromEnv(kv as unknown as KVNamespace, env);
    expect(seeded).toEqual(["alpha", "beta"]);

    const alpha = await getTeam(kv as unknown as KVNamespace, "alpha");
    expect(alpha).not.toBeNull();
    expect(alpha!.api_key).toBe("PMAK-a");
    expect(alpha!.team_id).toBe("111");

    const slugs = await listTeams(kv as unknown as KVNamespace);
    expect(slugs).toContain("alpha");
    expect(slugs).toContain("beta");
  });
});
