import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const FRONTEND_SRC = path.resolve(__dirname, "../../frontend/src");

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(FRONTEND_SRC, relPath), "utf-8");
}

describe("services table design contracts", () => {
  it("tokens define a shared control radius for interactive elements", () => {
    const css = readSrc("styles/tokens.css");
    expect(css).toMatch(/--radius-control\s*:\s*8px;/);
  });

  it("buttons.css enforces a default rounded radius for button primitives", () => {
    const css = readSrc("styles/buttons.css");
    expect(css).toMatch(/button,[\s\S]*\[role="button"\][\s\S]*border-radius\s*:\s*var\(--radius-md\);/);
  });

  it("services-table.css uses a shared menu trigger shell for header and row actions", () => {
    const css = readSrc("styles/services-table.css");
    expect(css).toMatch(/\.services-menu-trigger\s*\{[\s\S]*border-radius\s*:\s*var\(--radius-control\);/);
    expect(css).toMatch(/\.services-menu-trigger\s*\{[\s\S]*height\s*:\s*28px;/);
  });

  it("services-table.css renders selection count as a text indicator with a dedicated icon slot", () => {
    const css = readSrc("styles/services-table.css");
    expect(css).toMatch(/\.services-bulk-selection-indicator\s*\{/);
    expect(css).toMatch(/\.services-bulk-selection-icon\s*\{/);
  });

  it("badges.css clamps domain pills to a fixed width with ellipsis", () => {
    const css = readSrc("styles/badges.css");
    expect(css).toMatch(/\.domain-pill\s*\{[\s\S]*min-inline-size\s*:\s*10rem;/);
    expect(css).toMatch(/\.domain-pill\s*\{[\s\S]*max-inline-size\s*:\s*10rem;/);
    expect(css).toMatch(/\.domain-pill-label\s*\{[\s\S]*text-overflow\s*:\s*ellipsis;/);
  });

  it("CatalogPage composes shared domain, selection, and menu trigger components", () => {
    const src = readSrc("pages/CatalogPage.tsx");
    expect(src).toMatch(/DomainPill/);
    expect(src).toMatch(/SelectionCountBadge/);
    expect(src).toMatch(/OverflowMenuIcon/);
    expect(src).not.toMatch(/services-bulk-selected-chip/);
  });

  it("RecoveryPage uses the shared selection indicator and aligned menu trigger icon", () => {
    const src = readSrc("pages/RecoveryPage.tsx");
    expect(src).toMatch(/SelectionCountBadge/);
    expect(src).toMatch(/OverflowMenuIcon/);
    expect(src).not.toMatch(/>\s*\.\.\.\s*</);
  });

  it("SpecSelector routes domain labels through the shared domain pill component", () => {
    const src = readSrc("components/SpecSelector.tsx");
    expect(src).toMatch(/DomainPill/);
    expect(src).not.toMatch(/className="domain-pill"/);
  });
});
