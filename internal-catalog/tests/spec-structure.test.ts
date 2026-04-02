import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, basename, join } from "path";
import YAML from "yaml";

const SPECS_DIR = resolve(process.cwd(), "specs");
const REGISTRY_PATH = resolve(SPECS_DIR, "registry.json");

const REQUIRED_INFO_FIELDS = ["title", "description", "version", "x-acme-catalog-id", "x-acme-domain"];

function getIndustryDirs(): string[] {
  return readdirSync(SPECS_DIR)
    .filter((entry) => statSync(resolve(SPECS_DIR, entry)).isDirectory())
    .sort();
}

function getSpecFiles(industry: string): string[] {
  return readdirSync(resolve(SPECS_DIR, industry))
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
}

// ---------------------------------------------------------------------------
// 1. Folder structure: no YAML files at specs/ root, all inside subdirectories
// ---------------------------------------------------------------------------

describe("specs folder structure", () => {
  it("has no YAML spec files at the specs/ root level", () => {
    const rootYaml = readdirSync(SPECS_DIR).filter(
      (f) => (f.endsWith(".yaml") || f.endsWith(".yml")) && statSync(resolve(SPECS_DIR, f)).isFile(),
    );
    expect(rootYaml).toEqual([]);
  });

  it("has at least one industry subdirectory", () => {
    expect(getIndustryDirs().length).toBeGreaterThan(0);
  });

  it("industry directories contain only YAML/YML spec files", () => {
    for (const industry of getIndustryDirs()) {
      const entries = readdirSync(resolve(SPECS_DIR, industry));
      const nonSpec = entries.filter((f) => !f.endsWith(".yaml") && !f.endsWith(".yml"));
      expect(nonSpec, `Non-spec files found in specs/${industry}/: ${nonSpec.join(", ")}`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Required headers on each spec YAML
// ---------------------------------------------------------------------------

describe("spec YAML required headers", () => {
  for (const industry of getIndustryDirs()) {
    for (const file of getSpecFiles(industry)) {
      const specPath = join(industry, file);

      it(`${specPath} is valid OpenAPI 3.x`, () => {
        const content = readFileSync(resolve(SPECS_DIR, specPath), "utf-8");
        const spec = YAML.parse(content);
        expect(spec).toHaveProperty("openapi");
        expect(spec.openapi).toMatch(/^3\./);
      });

      it(`${specPath} has all required info fields`, () => {
        const content = readFileSync(resolve(SPECS_DIR, specPath), "utf-8");
        const spec = YAML.parse(content);
        const info = spec.info || {};

        for (const field of REQUIRED_INFO_FIELDS) {
          expect(info, `Missing info.${field} in ${specPath}`).toHaveProperty(field);
          const value = info[field];
          expect(
            typeof value === "string" && value.trim().length > 0,
            `info.${field} must be a non-empty string in ${specPath}, got: ${JSON.stringify(value)}`,
          ).toBe(true);
        }
      });

      it(`${specPath} x-acme-catalog-id matches filename`, () => {
        const content = readFileSync(resolve(SPECS_DIR, specPath), "utf-8");
        const spec = YAML.parse(content);
        const catalogId = spec.info?.["x-acme-catalog-id"];
        const expectedId = basename(file, ".yaml").replace(/\.yml$/, "");
        expect(catalogId).toBe(expectedId);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 3. registry.json integrity
// ---------------------------------------------------------------------------

describe("registry.json integrity", () => {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) as Array<Record<string, unknown>>;

  it("is a non-empty array", () => {
    expect(Array.isArray(registry)).toBe(true);
    expect(registry.length).toBeGreaterThan(0);
  });

  it("every entry has the required fields including industry", () => {
    const requiredKeys = ["id", "title", "description", "industry", "domain", "filename", "repo_name", "endpoints", "version"];
    for (const entry of registry) {
      for (const key of requiredKeys) {
        expect(entry, `Entry ${entry.id} missing key: ${key}`).toHaveProperty(key);
      }
    }
  });

  it("every entry filename starts with its industry folder", () => {
    for (const entry of registry) {
      const filename = entry.filename as string;
      const industry = entry.industry as string;
      expect(
        filename.startsWith(`${industry}/`),
        `Entry ${entry.id}: filename "${filename}" should start with "${industry}/"`,
      ).toBe(true);
    }
  });

  it("every entry filename corresponds to an actual spec file", () => {
    for (const entry of registry) {
      const fullPath = resolve(SPECS_DIR, entry.filename as string);
      expect(
        statSync(fullPath, { throwIfNoEntry: false })?.isFile(),
        `Spec file not found for entry ${entry.id}: ${entry.filename}`,
      ).toBe(true);
    }
  });

  it("every spec file on disk is represented in the registry", () => {
    const registeredFiles = new Set(registry.map((e) => e.filename as string));
    for (const industry of getIndustryDirs()) {
      for (const file of getSpecFiles(industry)) {
        const relPath = join(industry, file);
        expect(
          registeredFiles.has(relPath),
          `Spec file ${relPath} exists on disk but is missing from registry.json`,
        ).toBe(true);
      }
    }
  });

  it("has no duplicate IDs", () => {
    const ids = registry.map((e) => e.id as string);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicates, `Duplicate IDs: ${duplicates.join(", ")}`).toEqual([]);
  });

  it("has no duplicate filenames", () => {
    const filenames = registry.map((e) => e.filename as string);
    const duplicates = filenames.filter((f, i) => filenames.indexOf(f) !== i);
    expect(duplicates, `Duplicate filenames: ${duplicates.join(", ")}`).toEqual([]);
  });
});
