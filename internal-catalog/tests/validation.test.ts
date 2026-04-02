import { describe, it, expect } from "vitest";
import {
  validateSlug,
  validateEmailDomain,
  sanitizeString,
  isValidHexColor,
  RESERVED_SLUGS,
} from "../src/lib/validation";

// --- validateSlug ---

describe("validateSlug", () => {
  it("accepts valid slugs", () => {
    expect(validateSlug("acme")).toEqual({ valid: true });
    expect(validateSlug("my-app")).toEqual({ valid: true });
    expect(validateSlug("a1")).toEqual({ valid: true });
    expect(validateSlug("ab")).toEqual({ valid: true });
    expect(validateSlug("test-co")).toEqual({ valid: true });
    expect(validateSlug("x9")).toEqual({ valid: true });
  });

  it("rejects empty or missing slug", () => {
    expect(validateSlug("").valid).toBe(false);
    expect(validateSlug("").error).toBe("Slug is required");
    expect(validateSlug(null as any).valid).toBe(false);
    expect(validateSlug(undefined as any).valid).toBe(false);
  });

  it("rejects single character slug (below min length)", () => {
    const result = validateSlug("a");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("2-20");
  });

  it("rejects slug longer than 20 characters", () => {
    const result = validateSlug("a".repeat(21));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("2-20");
  });

  it("accepts slug at exactly 20 characters", () => {
    expect(validateSlug("a".repeat(20)).valid).toBe(true);
  });

  it("accepts slug at exactly 2 characters", () => {
    expect(validateSlug("ab").valid).toBe(true);
  });

  it("rejects slug with leading hyphen", () => {
    const result = validateSlug("-test");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("leading/trailing hyphen");
  });

  it("rejects slug with trailing hyphen", () => {
    const result = validateSlug("test-");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("leading/trailing hyphen");
  });

  it("rejects uppercase characters", () => {
    const result = validateSlug("Acme");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("lowercase");
  });

  it("rejects special characters", () => {
    expect(validateSlug("ac me").valid).toBe(false);
    expect(validateSlug("ac_me").valid).toBe(false);
    expect(validateSlug("ac.me").valid).toBe(false);
    expect(validateSlug("ac@me").valid).toBe(false);
    expect(validateSlug("ac!me").valid).toBe(false);
  });

  it("rejects reserved words", () => {
    for (const reserved of ["bootstrap", "www", "api", "admin"]) {
      const result = validateSlug(reserved);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("reserved");
    }
  });

  it("rejects all reserved slugs from the set", () => {
    for (const reserved of RESERVED_SLUGS) {
      expect(validateSlug(reserved).valid).toBe(false);
    }
  });
});

// --- validateEmailDomain ---

describe("validateEmailDomain", () => {
  it("accepts valid email domains", () => {
    const r1 = validateEmailDomain("acme.com");
    expect(r1.valid).toBe(true);
    expect(r1.normalized).toBe("acme.com");

    const r2 = validateEmailDomain("sub.domain.co.uk");
    expect(r2.valid).toBe(true);
    expect(r2.normalized).toBe("sub.domain.co.uk");
  });

  it("rejects empty or missing domain", () => {
    expect(validateEmailDomain("").valid).toBe(false);
    expect(validateEmailDomain("").error).toBe("Email domain is required");
    expect(validateEmailDomain(null as any).valid).toBe(false);
    expect(validateEmailDomain(undefined as any).valid).toBe(false);
  });

  it("rejects domain without a dot", () => {
    expect(validateEmailDomain("nodot").valid).toBe(false);
  });

  it("rejects domain starting with a dot", () => {
    expect(validateEmailDomain(".com").valid).toBe(false);
  });

  it("rejects single character without TLD", () => {
    expect(validateEmailDomain("a").valid).toBe(false);
  });

  it("strips leading @ prefix and normalizes", () => {
    const result = validateEmailDomain("@acme.com");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("acme.com");
  });

  it("normalizes to lowercase", () => {
    const result = validateEmailDomain("ACME.COM");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("acme.com");
  });

  it("rejects domain longer than 253 characters", () => {
    const long = "a".repeat(250) + ".com";
    expect(validateEmailDomain(long).valid).toBe(false);
    expect(validateEmailDomain(long).error).toContain("too long");
  });
});

// --- sanitizeString ---

describe("sanitizeString", () => {
  it("strips HTML tags", () => {
    expect(sanitizeString("<b>hello</b>")).toBe("hello");
    expect(sanitizeString('<script>alert("xss")</script>')).toBe('alert("xss")');
    expect(sanitizeString("<p>text</p>")).toBe("text");
  });

  it("trims whitespace", () => {
    expect(sanitizeString("  hello  ")).toBe("hello");
  });

  it("caps at maxLength", () => {
    const long = "a".repeat(200);
    expect(sanitizeString(long).length).toBe(100);
    expect(sanitizeString(long, 50).length).toBe(50);
  });

  it("handles empty and null-ish values", () => {
    expect(sanitizeString("")).toBe("");
    expect(sanitizeString(null as any)).toBe("");
    expect(sanitizeString(undefined as any)).toBe("");
  });

  it("handles strings with no tags", () => {
    expect(sanitizeString("plain text")).toBe("plain text");
  });
});

// --- isValidHexColor ---

describe("isValidHexColor", () => {
  it("accepts valid hex colors", () => {
    expect(isValidHexColor("#fff")).toBe(true);
    expect(isValidHexColor("#FF6C37")).toBe(true);
    expect(isValidHexColor("#00000080")).toBe(true);
    expect(isValidHexColor("#abc")).toBe(true);
    expect(isValidHexColor("#aabbcc")).toBe(true);
  });

  it("rejects named colors", () => {
    expect(isValidHexColor("red")).toBe(false);
    expect(isValidHexColor("blue")).toBe(false);
  });

  it("rejects hex without hash", () => {
    expect(isValidHexColor("FF6C37")).toBe(false);
  });

  it("rejects invalid hex characters", () => {
    expect(isValidHexColor("#GGG")).toBe(false);
    expect(isValidHexColor("#ZZZZZZ")).toBe(false);
  });

  it("rejects non-string inputs", () => {
    expect(isValidHexColor(null as any)).toBe(false);
    expect(isValidHexColor(undefined as any)).toBe(false);
    expect(isValidHexColor(123 as any)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidHexColor("")).toBe(false);
    expect(isValidHexColor("#")).toBe(false);
  });
});
