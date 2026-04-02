// Input validation and sanitization utilities for the bootstrap admin API.

const RESERVED_SLUGS = new Set([
  "bootstrap", "www", "api", "admin", "mail", "ftp", "cdn", "assets", "static",
]);

/**
 * Validate a customer slug for use as a subdomain.
 * Rules: 2-20 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphen, not reserved.
 */
export function validateSlug(slug: string): { valid: boolean; error?: string } {
  if (!slug || typeof slug !== "string") {
    return { valid: false, error: "Slug is required" };
  }
  const s = slug.trim();
  if (s.length < 2 || s.length > 20) {
    return { valid: false, error: "Slug must be 2-20 characters" };
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s)) {
    return { valid: false, error: "Slug must be lowercase alphanumeric with hyphens, no leading/trailing hyphen" };
  }
  if (RESERVED_SLUGS.has(s)) {
    return { valid: false, error: `Slug "${s}" is reserved` };
  }
  return { valid: true };
}

/**
 * Validate and normalize an email domain (e.g., "acme.com").
 */
export function validateEmailDomain(domain: string): { valid: boolean; normalized?: string; error?: string } {
  if (!domain || typeof domain !== "string") {
    return { valid: false, error: "Email domain is required" };
  }
  const d = domain.trim().toLowerCase().replace(/^@/, "");
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(d)) {
    return { valid: false, error: "Invalid email domain format" };
  }
  if (d.length > 253) {
    return { valid: false, error: "Email domain too long" };
  }
  return { valid: true, normalized: d };
}

/**
 * Strip HTML tags, trim whitespace, and cap length.
 */
export function sanitizeString(input: string, maxLength = 100): string {
  if (!input || typeof input !== "string") return "";
  return input.replace(/<[^>]*>/g, "").trim().slice(0, maxLength);
}

/**
 * Validate a hex color string (#RGB, #RRGGBB, or #RRGGBBAA).
 */
export function isValidHexColor(color: string): boolean {
  return typeof color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(color);
}

export { RESERVED_SLUGS };
