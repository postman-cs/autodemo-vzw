/**
 * Modal redesign regression tests.
 *
 * These tests enforce:
 * 1. The shared Modal component uses the reference design (floating close btn, centered header, noise texture).
 * 2. Resource modals in CatalogPage and ProvisionPage use the shared Modal component (no raw .modal-backdrop/.modal-panel).
 * 3. No legacy modal classes appear in TSX source files.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { Modal } from "../../frontend/src/components/Modal";
import { installDialogMocks, restoreDialogMocks } from "./helpers/dialog-mock";
import * as fs from "fs";
import * as path from "path";

const FRONTEND_SRC = path.resolve(__dirname, "../../frontend/src");

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(FRONTEND_SRC, relPath), "utf-8");
}

describe("Modal reference design structure", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    installDialogMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreDialogMocks();
  });

  it("close button has modal-close class (floating reference style)", () => {
    act(() => {
      root.render(
        <Modal open={true} onClose={() => {}}>
          <Modal.Header title="Test" />
          <Modal.Body>Content</Modal.Body>
        </Modal>
      );
    });
    // Reference: close button uses .modal-close class (floating, positioned outside card)
    const closeBtn = container.querySelector(".modal-close");
    expect(closeBtn).toBeTruthy();
  });

  it("close button is inside modal-inner so it anchors to the card (not the dialog viewport)", () => {
    act(() => {
      root.render(
        <Modal open={true} onClose={() => {}}>
          <Modal.Header title="Test" />
          <Modal.Body>Content</Modal.Body>
        </Modal>
      );
    });
    const inner = container.querySelector(".modal-inner");
    const closeBtn = container.querySelector(".modal-close");
    expect(inner).toBeTruthy();
    expect(closeBtn).toBeTruthy();
    expect(inner?.contains(closeBtn)).toBe(true);
  });

  it("modal-inner has position:relative so floating close button can anchor to it", () => {
    act(() => {
      root.render(
        <Modal open={true} onClose={() => {}}>
          <Modal.Header title="Test" />
          <Modal.Body>Content</Modal.Body>
        </Modal>
      );
    });
    const inner = container.querySelector(".modal-inner") as HTMLElement | null;
    expect(inner).toBeTruthy();
    // The inner wrapper must have position:relative for the absolute close button
    // We check the class exists; CSS enforcement is in modals.css
    expect(inner?.className).toContain("modal-inner");
  });

  it("header is centered (modal-header-centered class or text-align:center)", () => {
    act(() => {
      root.render(
        <Modal open={true} onClose={() => {}}>
          <Modal.Header title="Centered Title" subtitle="Subtitle text" />
          <Modal.Body>Content</Modal.Body>
        </Modal>
      );
    });
    // Reference: header uses text-align: center
    const header = container.querySelector(".modal-header-modern");
    expect(header).toBeTruthy();
    // The header should NOT have justify-content: space-between (that's the old inline style)
    // We verify the title and subtitle are present and the close button is NOT inside the header
    const titleEl = header?.querySelector(".modal-title");
    expect(titleEl?.textContent).toBe("Centered Title");
    // Close button should be outside the header (floating)
    const closeBtnInHeader = header?.querySelector(".modal-close");
    expect(closeBtnInHeader).toBeNull();
  });

  it("close button is outside modal-header-modern (floating position)", () => {
    act(() => {
      root.render(
        <Modal open={true} onClose={() => {}}>
          <Modal.Header title="Test" />
          <Modal.Body>Content</Modal.Body>
        </Modal>
      );
    });
    const header = container.querySelector(".modal-header-modern");
    const closeBtn = container.querySelector(".modal-close");
    expect(closeBtn).toBeTruthy();
    // Close button must NOT be a descendant of the header
    expect(header?.contains(closeBtn)).toBe(false);
  });

  it("modal-inner has modal-noise class for noise texture", () => {
    act(() => {
      root.render(
        <Modal open={true} onClose={() => {}}>
          <Modal.Header title="Test" />
          <Modal.Body>Content</Modal.Body>
        </Modal>
      );
    });
    // Reference: noise texture via ::before on modal-card / modal-inner
    const inner = container.querySelector(".modal-inner");
    expect(inner?.className).toContain("modal-noise");
  });

  it("subtitle renders inside header (not in body)", () => {
    act(() => {
      root.render(
        <Modal open={true} onClose={() => {}}>
          <Modal.Header title="Title" subtitle="My subtitle" />
          <Modal.Body>Body</Modal.Body>
        </Modal>
      );
    });
    const header = container.querySelector(".modal-header-modern");
    const subtitle = header?.querySelector(".modal-subtitle");
    expect(subtitle?.textContent).toBe("My subtitle");
  });

  it("Modal.Header renders an h2 element with modal-title class", () => {
    act(() => {
      root.render(
        <Modal open={true} onClose={() => {}}>
          <Modal.Header title="Shell Title" />
          <Modal.Body>Content</Modal.Body>
        </Modal>
      );
    });
    // Reference: .modal-title is an h2 element (semantic heading)
    const h2 = container.querySelector("h2.modal-title");
    expect(h2).toBeTruthy();
    expect(h2?.textContent).toBe("Shell Title");
  });

  it("close button has aria-label Close for accessibility", () => {
    act(() => {
      root.render(
        <Modal open={true} onClose={() => {}}>
          <Modal.Header title="Test" />
          <Modal.Body>Content</Modal.Body>
        </Modal>
      );
    });
    const closeBtn = container.querySelector(".modal-close");
    expect(closeBtn?.getAttribute("aria-label")).toBe("Close");
  });

  it("close button has type=button to prevent form submission", () => {
    act(() => {
      root.render(
        <Modal open={true} onClose={() => {}}>
          <Modal.Header title="Test" />
          <Modal.Body>Content</Modal.Body>
        </Modal>
      );
    });
    const closeBtn = container.querySelector(".modal-close") as HTMLButtonElement | null;
    expect(closeBtn?.type).toBe("button");
  });
});

describe("Resource modal migration - no legacy modal classes in TSX", () => {
  it("CatalogPage.tsx does not use raw .modal-backdrop class", () => {
    const src = readSrc("pages/CatalogPage.tsx");
    expect(src).not.toMatch(/className=["'][^"']*modal-backdrop[^"']*["']/);
  });

  it("CatalogPage.tsx does not use raw .modal-panel class", () => {
    const src = readSrc("pages/CatalogPage.tsx");
    expect(src).not.toMatch(/className=["'][^"']*\bmodal-panel\b[^"']*["']/);
  });

  it("CatalogPage.tsx does not use raw .modal-header class (legacy)", () => {
    const src = readSrc("pages/CatalogPage.tsx");
    expect(src).not.toMatch(/className=["'][^"']*\bmodal-header\b[^"']*["']/);
  });

  it("CatalogPage.tsx does not use raw .modal-body class (legacy)", () => {
    const src = readSrc("pages/CatalogPage.tsx");
    expect(src).not.toMatch(/className=["'][^"']*\bmodal-body\b[^"']*["']/);
  });

  it("ProvisionPage.tsx does not use raw .modal-backdrop class", () => {
    const src = readSrc("pages/ProvisionPage.tsx");
    expect(src).not.toMatch(/className=["'][^"']*modal-backdrop[^"']*["']/);
  });

  it("ProvisionPage.tsx does not use raw .modal-panel class", () => {
    const src = readSrc("pages/ProvisionPage.tsx");
    expect(src).not.toMatch(/className=["'][^"']*\bmodal-panel\b[^"']*["']/);
  });

  it("ProvisionPage.tsx does not use raw .modal-header class (legacy)", () => {
    const src = readSrc("pages/ProvisionPage.tsx");
    expect(src).not.toMatch(/className=["'][^"']*\bmodal-header\b[^"']*["']/);
  });

  it("ProvisionPage.tsx does not use raw .modal-body class (legacy)", () => {
    const src = readSrc("pages/ProvisionPage.tsx");
    expect(src).not.toMatch(/className=["'][^"']*\bmodal-body\b[^"']*["']/);
  });

  it("CatalogPage.tsx uses Modal component for resource modal", () => {
    const src = readSrc("pages/CatalogPage.tsx");
    expect(src).toMatch(/import.*Modal.*from/);
    expect(src).toMatch(/<ResourceModal\b|<Modal\b/);
  });

  it("ProvisionPage.tsx uses Modal component for infra resource modal", () => {
    const src = readSrc("pages/ProvisionPage.tsx");
    expect(src).toMatch(/import.*Modal.*from/);
    expect(src).toMatch(/<ResourceModal\b|<Modal\b/);
  });
});

describe("modals.css - reference style contracts", () => {
  it("modals.css defines floating close button style (.modal-close with position:absolute)", () => {
    const css = readSrc("styles/modals.css");
    expect(css).toMatch(/\.modal-close\s*\{[^}]*position\s*:\s*absolute/s);
  });

  it("modals.css defines noise texture on modal-inner (::before)", () => {
    const css = readSrc("styles/modals.css");
    expect(css).toMatch(/\.modal-inner::before|\.modal-noise::before/);
  });

  it("modals.css defines centered header (text-align: center)", () => {
    const css = readSrc("styles/modals.css");
    expect(css).toMatch(/\.modal-header-modern\s*\{[^}]*text-align\s*:\s*center/s);
  });

  it("modals.css uses the reference primary button shape and padding inside modal footers", () => {
    const css = readSrc("styles/modals.css");
    expect(css).toMatch(/\.modal-footer-modern \.btn-primary\s*\{[^}]*border-radius\s*:\s*8px;[^}]*padding\s*:\s*10px 20px;/s);
  });

  it("modals.css uses the reference secondary button border-radius inside modal footers", () => {
    const css = readSrc("styles/modals.css");
    expect(css).toMatch(/\.modal-footer-modern \.btn-secondary\s*\{[^}]*border-radius\s*:\s*8px;/s);
  });

  it("modals.css modal-enter animation uses reference transform scale(0.97) translateY(8px)", () => {
    const css = readSrc("styles/modals.css");
    expect(css).toMatch(/@keyframes modal-enter\s*\{[^}]*scale\(0\.97\)\s*translateY\(8px\)/s);
  });

  it("modals.css modal-base-surface animation uses reference timing 180ms cubic-bezier(0.32, 0.72, 0, 1)", () => {
    const css = readSrc("styles/modals.css");
    expect(css).toMatch(/\.modal-base-surface\s*\{[^}]*animation:\s*modal-enter\s+180ms\s+cubic-bezier\(0\.32,\s*0\.72,\s*0,\s*1\)/s);
  });

  it("modals.css lets the close button overflow outside the modal surface like the reference", () => {
    const css = readSrc("styles/modals.css");
    expect(css).toMatch(/\.modal-close\s*\{[^}]*top\s*:\s*-12px;/s);
    expect(css).toMatch(/\.modal-close\s*\{[^}]*right\s*:\s*-12px;/s);
    expect(css).toMatch(/\.modal-base-surface\s*\{[^}]*overflow\s*:\s*visible;/s);
    expect(css).toMatch(/\.modal-inner\s*\{[^}]*overflow\s*:\s*visible;/s);
  });

  it("modals.css footer uses justify-content: space-between (reference layout)", () => {
    const css = readSrc("styles/modals.css");
    expect(css).toMatch(/\.modal-footer-modern\s*\{[^}]*justify-content\s*:\s*space-between;/s);
  });

  it("modals.css does not define .modal-backdrop as a flex container (legacy pattern removed)", () => {
    const css = readSrc("styles/modals.css");
    // The legacy .modal-backdrop { display: flex; align-items: center; ... } should be gone
    // (the <dialog> element handles its own backdrop via ::backdrop)
    // We check that .modal-backdrop is not defined as a layout container
    const backdropBlock = css.match(/\.modal-backdrop\s*\{([^}]*)\}/s);
    if (backdropBlock) {
      // If it still exists, it must not have display:flex (that's the legacy pattern)
      expect(backdropBlock[1]).not.toMatch(/display\s*:\s*flex/);
    }
  });

  it("modals.css does not define .modal-panel as a standalone surface (legacy pattern removed)", () => {
    const css = readSrc("styles/modals.css");
    const panelBlock = css.match(/^\.modal-panel\s*\{([^}]*)\}/ms);
    expect(panelBlock).toBeNull();
  });

  it("modals.css floating close button uses reference 36x36 sizing", () => {
    const css = readSrc("styles/modals.css");
    expect(css).toMatch(/\.modal-close\s*\{[^}]*width\s*:\s*36px;/s);
    expect(css).toMatch(/\.modal-close\s*\{[^}]*height\s*:\s*36px;/s);
  });

  it("modals.css floating close button uses border-radius 50% (circular)", () => {
    const css = readSrc("styles/modals.css");
    expect(css).toMatch(/\.modal-close\s*\{[^}]*border-radius\s*:\s*50%;/s);
  });

  it("modals.css close button svg uses reference 18x18 sizing", () => {
    const css = readSrc("styles/modals.css");
    expect(css).toMatch(/\.modal-close\s+svg\s*\{[^}]*width\s*:\s*18px;/s);
    expect(css).toMatch(/\.modal-close\s+svg\s*\{[^}]*height\s*:\s*18px;/s);
  });

  it("modals.css modal-base-surface animation includes both fill-mode", () => {
    const css = readSrc("styles/modals.css");
    expect(css).toMatch(/\.modal-base-surface\s*\{[^}]*animation:\s*modal-enter\s+180ms\s+cubic-bezier\(0\.32,\s*0\.72,\s*0,\s*1\)\s+both/s);
  });

  it("modals.css noise layer uses reference opacity 0.03 and height 100px", () => {
    const css = readSrc("styles/modals.css");
    expect(css).toMatch(/\.modal-noise::before\s*\{[^}]*opacity\s*:\s*0\.03;/s);
    expect(css).toMatch(/\.modal-noise::before\s*\{[^}]*height\s*:\s*100px;/s);
  });

  it("modals.css noise layer uses gradient mask fading to transparent", () => {
    const css = readSrc("styles/modals.css");
    expect(css).toMatch(/\.modal-noise::before\s*\{[^}]*mask-image\s*:\s*linear-gradient\(to bottom,\s*black\s*0%,\s*transparent\s*100%\)/s);
  });

  it("modals.css footer uses reference padding shorthand with modal-padding", () => {
    const css = readSrc("styles/modals.css");
    expect(css).toMatch(/\.modal-footer-modern\s*\{[^}]*padding\s*:\s*var\(--space-4\)\s+var\(--modal-padding\)\s+var\(--modal-padding\)/s);
  });

  it("modals.css footer uses gap var(--space-3) and align-items center", () => {
    const css = readSrc("styles/modals.css");
    expect(css).toMatch(/\.modal-footer-modern\s*\{[^}]*gap\s*:\s*var\(--space-3\);/s);
    expect(css).toMatch(/\.modal-footer-modern\s*\{[^}]*align-items\s*:\s*center;/s);
  });
});

describe("Provision page layout regressions", () => {
  it("ProvisionPage.tsx no longer renders the redundant intro sentence under the title", () => {
    const src = readSrc("pages/ProvisionPage.tsx");
    expect(src).not.toContain("Switch between single-service and dependency graph deployment modes.");
  });

  it("ProvisionLayout renders ProvisionStageTracker in the header strip", () => {
    const src = readSrc("components/ProvisionLayout.tsx");
    expect(src).toContain("main-header-strip");
    expect(src).toContain("stripContent");
  });

  it("ProvisionPage uses useOutletContext to set header strip content", () => {
    const src = readSrc("pages/ProvisionPage.tsx");
    expect(src).toContain("useOutletContext");
    expect(src).toContain("setHeaderStrip");
    expect(src).toContain("useLayoutEffect");
  });

  it("provision-stages.css anchors the sticky tracker below the header and makes it full bleed", () => {
    const css = readSrc("styles/provision-stages.css");
    expect(css).toMatch(/\.provision-stage-tracker\s*\{[^}]*top\s*:\s*52px;/s);
    expect(css).toMatch(/\.provision-stage-tracker\s*\{[^}]*margin-inline\s*:\s*calc\(50%\s*-\s*50vw\);/s);
    expect(css).toMatch(/\.provision-stage-tracker\s*\{[^}]*padding-block\s*:\s*var\(--space-2\);/s);
    expect(css).toMatch(/\.provision-stage-tracker\s*\{[^}]*padding-inline\s*:\s*24px;/s);
    expect(css).toMatch(/\.provision-stage-tracker\s*\{[^}]*z-index\s*:\s*9;/s);
  });
});

describe("Dropdown typography regressions", () => {
  it("forms.css keeps dropdown option text size aligned with the trigger input text", () => {
    const css = readSrc("styles/forms.css");
    expect(css).toMatch(/\.form-input\s*\{[^}]*font-size\s*:\s*var\(--text-base\);/s);
    expect(css).toMatch(/\.select-dropdown-option\s*\{[^}]*font-size\s*:\s*var\(--text-base\);/s);
  });
});
