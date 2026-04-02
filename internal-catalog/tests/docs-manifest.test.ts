import { describe, it, expect } from "vitest";
import { buildCanonicalManifest } from "../src/lib/docs-manifest";
import canonicalManifestFixture from "../test/fixtures/canonical-manifest.json";

describe("docs-manifest", () => {
  it("builds the canonical manifest matching the golden fixture", () => {
    const manifest = buildCanonicalManifest([]);
    expect(manifest).toEqual(canonicalManifestFixture);
  });
});
