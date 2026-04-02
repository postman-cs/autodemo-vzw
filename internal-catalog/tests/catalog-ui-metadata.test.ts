import { describe, expect, it } from "vitest";
import { TEST_MOCK_SYSTEM_ENV_ID } from "./helpers/constants";
import {
  matchesCatalogTeam,
  normalizeCatalogTeamSlug,
  resolveCatalogTeamLabel,
} from "../frontend/src/lib/catalog-team-filter";
import {
  environmentMappingSummary,
  environmentStatusLabel,
  isChaosEnabled,
  parseChaosEnabledMap,
  parseEnvironmentDeployments,
} from "../frontend/src/lib/deployment-metadata";
import type { Deployment, EnvironmentDeployment } from "../frontend/src/lib/types";

describe("catalog UI deployment metadata helpers", () => {
  it("parses multi-environment metadata even when one environment has no runtime URL", () => {
    const deployment: Deployment = {
      spec_id: "svc-1",
      status: "active",
      environment_deployments: JSON.stringify([
        {
          environment: "prod",
          runtime_url: "https://prod.example.test/",
          postman_env_uid: "env-prod",
          system_env_id: "sys-prod",
          branch: "env/prod",
        },
        {
          environment: "stage",
          postman_env_uid: "env-stage",
          system_env_id: "sys-stage",
          status: "provisioning",
        },
      ]),
    };

    const parsed = parseEnvironmentDeployments(deployment);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].runtime_url).toBe("https://prod.example.test/");
    expect(parsed[1].environment).toBe("stage");
    expect(parsed[1].runtime_url).toBe("");
    expect(parsed[1].postman_env_uid).toBe("env-stage");
    expect(parsed[1].system_env_id).toBe("sys-stage");
  });

  it("parses all per-environment fields including api_gateway_id and system_env_name", () => {
    const deployment: Deployment = {
      spec_id: "svc-full",
      status: "active",
      environment_deployments: JSON.stringify([
        {
          environment: "prod",
          runtime_url: "https://prod.example.test",
          api_gateway_id: "gw-prod-001",
          postman_env_uid: "env-prod-uid",
          system_env_id: TEST_MOCK_SYSTEM_ENV_ID,
          system_env_name: "Production",
          status: "active",
          deployed_at: "2026-03-04T10:00:00Z",
          branch: "env/prod",
        },
        {
          environment: "stage",
          runtime_url: "https://stage.example.test",
          api_gateway_id: "gw-stage-001",
          postman_env_uid: "env-stage-uid",
          system_env_id: "abc12345-0000-0000-0000-000000000000",
          status: "active",
          deployed_at: "2026-03-04T10:05:00Z",
          branch: "env/stage",
        },
      ]),
    };

    const parsed = parseEnvironmentDeployments(deployment);
    expect(parsed).toHaveLength(2);

    const prod = parsed[0];
    expect(prod.api_gateway_id).toBe("gw-prod-001");
    expect(prod.system_env_name).toBe("Production");
    expect(prod.system_env_id).toBe(TEST_MOCK_SYSTEM_ENV_ID);
    expect(prod.deployed_at).toBe("2026-03-04T10:00:00Z");
    expect(prod.branch).toBe("env/prod");

    const stage = parsed[1];
    expect(stage.api_gateway_id).toBe("gw-stage-001");
    expect(stage.system_env_name).toBeUndefined();
    expect(stage.branch).toBe("env/stage");
  });

  it("synthesizes a prod fallback for active deployments with no environment_deployments", () => {
    const fallback = [{ environment: "prod", status: "active", runtime_url: "" }];
    expect(parseEnvironmentDeployments({ spec_id: "x", status: "active" })).toEqual(fallback);
    expect(parseEnvironmentDeployments({ spec_id: "x", status: "active", environment_deployments: "" })).toEqual(fallback);
    expect(parseEnvironmentDeployments({ spec_id: "x", status: "active", environment_deployments: "not-json" })).toEqual(fallback);
    expect(parseEnvironmentDeployments({ spec_id: "x", status: "active", environment_deployments: "{}" })).toEqual(fallback);
    expect(parseEnvironmentDeployments({ spec_id: "x", status: "active", environment_deployments: "null" })).toEqual(fallback);
  });

  it("returns empty array for non-active deployments with no environment_deployments", () => {
    expect(parseEnvironmentDeployments({ spec_id: "x", status: "failed" })).toEqual([]);
    expect(parseEnvironmentDeployments({ spec_id: "x", status: "provisioning" })).toEqual([]);
  });

  it("filters out entries with empty environment slug", () => {
    const deployment: Deployment = {
      spec_id: "svc-filter",
      status: "active",
      environment_deployments: JSON.stringify([
        { environment: "prod", runtime_url: "https://prod.test" },
        { environment: "", runtime_url: "https://orphan.test" },
        { environment: "  ", runtime_url: "https://whitespace.test" },
      ]),
    };
    const parsed = parseEnvironmentDeployments(deployment);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].environment).toBe("prod");
  });

  it("uses per-environment chaos map first and falls back to aggregate flag", () => {
    const scoped: Deployment = {
      spec_id: "svc-1",
      status: "active",
      chaos_enabled: false,
      chaos_enabled_map: JSON.stringify({ prod: true, stage: false }),
    };
    expect(parseChaosEnabledMap(scoped)).toEqual({ prod: true, stage: false });
    expect(isChaosEnabled(scoped, "prod")).toBe(true);
    expect(isChaosEnabled(scoped, "stage")).toBe(false);

    const aggregate: Deployment = {
      spec_id: "svc-2",
      status: "active",
      chaos_enabled: true,
    };
    expect(isChaosEnabled(aggregate, "prod")).toBe(false);
    expect(isChaosEnabled(aggregate)).toBe(true);
  });

  it("builds readable mapping summaries with all fields", () => {
    const summary = environmentMappingSummary({
      environment: "prod",
      runtime_url: "https://prod.example.test",
      postman_env_uid: "env-prod",
      system_env_id: "sys-prod",
      branch: "env/prod",
      api_gateway_id: "gw-prod-001",
      status: "active",
    });
    expect(summary).toContain("System sys-prod");
    expect(summary).toContain("Postman env-prod");
    expect(summary).toContain("Branch env/prod");
    expect(summary).toContain("Gateway gw-prod-001");
    expect(summary).toContain("Runtime https://prod.example.test");
    expect(summary).toContain("Status active");
  });

  it("prefers system_env_name over system_env_id in summary", () => {
    const withName = environmentMappingSummary({
      environment: "prod",
      system_env_id: "4ed1a682-0394",
      system_env_name: "Production",
    });
    expect(withName).toContain("System Production");
    expect(withName).not.toContain("4ed1a682");

    const withoutName = environmentMappingSummary({
      environment: "stage",
      system_env_id: "abc12345-0000",
    });
    expect(withoutName).toContain("System abc12345-0000");
  });

  it("returns empty string for environment with no metadata", () => {
    const summary = environmentMappingSummary({ environment: "dev" });
    expect(summary).toBe("");
  });

  it("returns correct status labels from environmentStatusLabel", () => {
    expect(environmentStatusLabel({ environment: "prod", status: "active" })).toBe("active");
    expect(environmentStatusLabel({ environment: "stage", status: "provisioning" })).toBe("provisioning");
    expect(environmentStatusLabel({ environment: "dev" })).toBe("unknown");
    expect(environmentStatusLabel({ environment: "test", status: "" })).toBe("unknown");
  });

  it("handles three-environment deployment parsing", () => {
    const deployment: Deployment = {
      spec_id: "svc-triple",
      status: "active",
      environment_deployments: JSON.stringify([
        { environment: "prod", runtime_url: "https://prod.test", status: "active" },
        { environment: "stage", runtime_url: "https://stage.test", status: "active" },
        { environment: "dev", runtime_url: "https://dev.test", status: "provisioning" },
      ]),
      chaos_enabled_map: JSON.stringify({ prod: true, stage: false, dev: false }),
    };

    const parsed = parseEnvironmentDeployments(deployment);
    expect(parsed).toHaveLength(3);
    expect(parsed.map((e: EnvironmentDeployment) => e.environment)).toEqual(["prod", "stage", "dev"]);

    expect(isChaosEnabled(deployment, "prod")).toBe(true);
    expect(isChaosEnabled(deployment, "stage")).toBe(false);
    expect(isChaosEnabled(deployment, "dev")).toBe(false);
  });

  it("normalizes selected team slug against the registered team list", () => {
    const teams = [
      { slug: "field-services-v12-demo", team_id: "13347347", team_name: "Field Services v12 Demo" },
    ];

    expect(normalizeCatalogTeamSlug("field-services-v12-demo", teams)).toBe("field-services-v12-demo");
    expect(normalizeCatalogTeamSlug("unknown-team", teams)).toBe("");
    expect(normalizeCatalogTeamSlug("", teams)).toBe("");
  });

  it("matches deployments and recovery items by the selected team slug", () => {
    expect(matchesCatalogTeam("", "field-services-v12-demo")).toBe(true);
    expect(matchesCatalogTeam("field-services-v12-demo", "field-services-v12-demo")).toBe(true);
    expect(matchesCatalogTeam("field-services-v12-demo", "customer-success-demo")).toBe(false);
    expect(matchesCatalogTeam("field-services-v12-demo", undefined)).toBe(false);
  });

  it("resolves team badges to the registered team name and falls back to slug", () => {
    const teams = [
      { slug: "field-services-v12-demo", team_id: "13347347", team_name: "Field Services v12 Demo" },
    ];

    expect(resolveCatalogTeamLabel("field-services-v12-demo", teams)).toBe("Field Services v12 Demo");
    expect(resolveCatalogTeamLabel("customer-success-demo", teams)).toBe("customer-success-demo");
    expect(resolveCatalogTeamLabel(undefined, teams)).toBe("");
  });
});
