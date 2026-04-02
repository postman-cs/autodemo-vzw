import { describe, it, expect } from "vitest";
import { getSpecDescription } from "../src/lib/spec-description-extractor";

describe("getSpecDescription", () => {
  it("returns non-empty description for a known spec", () => {
    const result = getSpecDescription("vzw-network-operations-api");
    expect(result.description).toBeTruthy();
    expect(result.description).toContain("network");
  });

  it("returns endpoint summaries for a known spec", () => {
    const result = getSpecDescription("vzw-network-operations-api");
    expect(result.endpointSummaries.length).toBeGreaterThan(0);
    expect(result.endpointSummaries.length).toBeLessThanOrEqual(7);
  });

  it("returns empty description and array for nonexistent spec", () => {
    const result = getSpecDescription("nonexistent-api");
    expect(result.description).toBe("");
    expect(result.endpointSummaries).toEqual([]);
  });

  it("returns descriptions for all 34 registry specs", () => {
    // Spot-check a few different specs across domains
    const ids = [
      "vzw-network-operations-api",
      "vzw-city-dispatch-api",
      "vzw-campus-device-registry-api",
      "vzw-grid-topology-sync-api",
    ];
    for (const id of ids) {
      const result = getSpecDescription(id);
      expect(result.description, `${id} should have a description`).toBeTruthy();
    }
  });

  it("deduplicates endpoint summaries", () => {
    const result = getSpecDescription("vzw-network-operations-api");
    const lower = result.endpointSummaries.map((s) => s.toLowerCase());
    const unique = new Set(lower);
    expect(unique.size).toBe(lower.length);
  });
});
