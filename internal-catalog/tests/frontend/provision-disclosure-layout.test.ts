import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const provisionCss = readFileSync(
  resolve(process.cwd(), "frontend/src/styles/provision.css"),
  "utf8",
);

describe("provision disclosure layout tokens", () => {
  it("uses a larger disclosure chevron hit area with tokenized 14px text semantics", () => {
    const chevronRule = provisionCss.match(/\.provision-disclosure-chevron\s*\{[\s\S]*?width:\s*(\d+)px;[\s\S]*?height:\s*(\d+)px;[\s\S]*?font-size:\s*var\(--text-base\);/);

    expect(chevronRule).toBeTruthy();
    expect(Number(chevronRule?.[1])).toBe(24);
    expect(Number(chevronRule?.[2])).toBe(24);
  });

  it("keeps the fullwidth optional-features disclosure flush when collapsed and adds spacing only when open", () => {
    expect(provisionCss).toContain(".provision-config-section-fullwidth {");
    expect(provisionCss).toContain("gap: 0;");
    expect(provisionCss).toContain(".provision-config-section-fullwidth .provision-disclosure-body {");
    expect(provisionCss).toContain("margin-top: 0;");
    expect(provisionCss).toContain(".provision-config-section-fullwidth .provision-disclosure-body--open {");
    expect(provisionCss).toContain("margin-top: 12px;");
  });
});
