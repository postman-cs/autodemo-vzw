const DEFAULT_SLUG = "field-services-v12-demo";

const DEFAULT_TEAM_CONFIG = {
  slug: DEFAULT_SLUG,
  team_id: "13347347",
  team_name: "Field Services v12 Demo",
  api_key: "test-key",
  access_token: "test-token",
};

export function makeTeamRegistryKV(slug = DEFAULT_SLUG, overrides: Record<string, unknown> = {}): unknown {
  const config = { ...DEFAULT_TEAM_CONFIG, slug, ...overrides };
  return {
    get: async (key: string, type?: string) => {
      if (key === `team:${slug}` && type === "json") return config;
      if (key === "__index" && type === "json") return [slug];
      return null;
    },
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [{ name: `team:${slug}` }], list_complete: true, cursor: "" }),
  };
}

export function makeEmptyTeamRegistryKV(): unknown {
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true, cursor: "" }),
  };
}

export { DEFAULT_SLUG as TEST_TEAM_SLUG };
