import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const formsCss = readFileSync(resolve(process.cwd(), "frontend/src/styles/forms.css"), "utf8");
const provisionCss = readFileSync(resolve(process.cwd(), "frontend/src/styles/provision.css"), "utf8");

describe("design-system CSS cleanup", () => {
  it("uses typography tokens for form input and custom select text sizing", () => {
    expect(formsCss).toContain("font-size: var(--text-base);");
    expect(formsCss).toContain("font-size: var(--text-xs);");
    expect(formsCss).not.toContain("font-size: 14px;");
    expect(formsCss).not.toContain("font-size: 10px;");
  });

  it("replaces remaining hardcoded provision typography and success color values with tokens", () => {
    expect(provisionCss).toContain("font-size: var(--text-sm);");
    expect(provisionCss).toContain("font-size: var(--text-base);");
    expect(provisionCss).toContain("font-size: var(--text-md);");
    expect(provisionCss).toContain("font-size: var(--text-xl);");
    expect(provisionCss).toContain("font-size: var(--text-xs);");
    expect(provisionCss).toContain("color: var(--success-text);");

    expect(provisionCss).not.toContain("font-size: 12px;");
    expect(provisionCss).not.toContain("font-size: 14px;");
    expect(provisionCss).not.toContain("font-size: 15px;");
    expect(provisionCss).not.toContain("font-size: 18px;");
    expect(provisionCss).not.toContain("font-size: 10px;");
    expect(provisionCss).not.toContain("color: #166534;");
  });
});
