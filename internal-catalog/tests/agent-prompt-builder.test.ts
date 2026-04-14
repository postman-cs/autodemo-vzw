import { describe, it, expect } from "vitest";
import { buildAgentPrompt, buildAgentPromptTitle, AgentPromptContext } from "../src/lib/agent-prompt-builder";

const baseCtx: AgentPromptContext = {
  title: "VZW Network Operations API",
  description: "Verizon network operations APIs for OAuth, device location, and QoD.",
  specDescription: "Provides network policy controls for incident-critical mobile endpoints.",
  endpointSummaries: ["Issue OAuth2 token", "Resolve device location", "Create QoD session"],
  endpointCount: 7,
  dependsOn: ["vzw-incident-intake-gateway-api", "vzw-geospatial-hazard-intel-api"],
  consumesApis: ["vzw-identity-federation-api"],
  fernDocsUrl: "https://vzw-demo.docs.buildwithfern.com/emergency-dispatch/vzw-network-operations-api",
  runtime: "lambda",
};

describe("buildAgentPrompt", () => {
  it("includes intro with spec description and endpoint summaries", () => {
    const prompt = buildAgentPrompt(baseCtx);
    expect(prompt).toContain("Onboard the VZW Network Operations API into this Postman workspace");
    expect(prompt).toContain("Provides network policy controls");
    expect(prompt).toContain("Key capabilities include:");
    expect(prompt).toContain("issue oauth2 token");
  });

  it("includes all 8 steps when both dependsOn and consumesApis are present", () => {
    const prompt = buildAgentPrompt(baseCtx);
    expect(prompt).toContain("Complete the following steps in order:");
    expect(prompt).toContain("1. Import the OpenAPI spec");
    expect(prompt).toContain("2. Configure collection-level authentication");
    expect(prompt).toContain("3. Create a \"Production\" environment");
    expect(prompt).toContain("4. This service depends on: vzw-incident-intake-gateway-api, vzw-geospatial-hazard-intel-api");
    expect(prompt).toContain("5. This service also consumes: vzw-identity-federation-api");
    expect(prompt).toContain("6. For every endpoint in the spec");
    expect(prompt).toContain("7. Add a basic test script");
    expect(prompt).toContain("8. Run the full collection");
  });

  it("includes only dependsOn step when consumesApis is empty", () => {
    const prompt = buildAgentPrompt({ ...baseCtx, consumesApis: [] });
    expect(prompt).toContain("4. This service depends on:");
    expect(prompt).not.toContain("This service also consumes:");
    expect(prompt).toContain("5. For every endpoint");
    expect(prompt).toContain("6. Add a basic test script");
    expect(prompt).toContain("7. Run the full collection");
  });

  it("omits dependency steps and renumbers to 6 steps when no dependencies", () => {
    const prompt = buildAgentPrompt({ ...baseCtx, dependsOn: [], consumesApis: [] });
    expect(prompt).not.toContain("depends on:");
    expect(prompt).not.toContain("also consumes:");
    expect(prompt).toContain("1. Import the OpenAPI spec");
    expect(prompt).toContain("2. Configure collection-level authentication");
    expect(prompt).toContain("3. Create a \"Production\" environment");
    expect(prompt).toContain("4. For every endpoint");
    expect(prompt).toContain("5. Add a basic test script");
    expect(prompt).toContain("6. Run the full collection");
    expect(prompt).not.toContain("7.");
    expect(prompt).not.toContain("8.");
  });

  it("falls back to registry description when specDescription is empty", () => {
    const prompt = buildAgentPrompt({ ...baseCtx, specDescription: "" });
    expect(prompt).toContain("Verizon network operations APIs for OAuth");
    expect(prompt).not.toContain("Provides network policy controls");
  });

  it("handles empty specDescription and empty description gracefully", () => {
    const prompt = buildAgentPrompt({ ...baseCtx, specDescription: "", description: "" });
    expect(prompt).toContain("Onboard the VZW Network Operations API into this Postman workspace.");
    expect(prompt).toContain("Complete the following steps");
  });
});

describe("buildAgentPromptTitle", () => {
  it("returns formatted title", () => {
    expect(buildAgentPromptTitle("VZW Network Operations API")).toBe(
      "Onboard VZW Network Operations API into Postman Agent Mode",
    );
  });
});
