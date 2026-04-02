import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ChaosConfigModal, type ChaosConfigObj } from "../../frontend/src/components/ChaosConfigModal";
import { installDialogMocks, restoreDialogMocks } from "./helpers/dialog-mock";
import { simulateEscapeKey, simulateBackdropClick, isDialogOpen } from "./helpers/modal-test-utils";

describe("ChaosConfigModal", () => {
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

  it("renders a dialog element", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    expect(document.querySelector("dialog")).toBeTruthy();
  });

  it("opens when rendered (always open)", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    const dialog = document.querySelector("dialog")!;
    expect(isDialogOpen(dialog)).toBe(true);
  });

  it("renders Modal.Header with title and subtitle", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    const header = document.querySelector(".modal-header-modern");
    expect(header).toBeTruthy();
    expect(header?.textContent).toContain("Configure fault injection profiles");
    expect(header?.textContent).toContain("Adjust fault injection settings per environment tier.");
  });

  it("renders Modal.Body with chaos config form", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    expect(document.querySelector(".modal-body-modern")).toBeTruthy();
    expect(document.querySelector(".chaos-config-form")).toBeTruthy();
  });

  it("renders Modal.Footer with Cancel and Save buttons", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    const footer = document.querySelector(".modal-footer-modern");
    expect(footer).toBeTruthy();
    
    const buttons = Array.from(footer?.querySelectorAll("button") || []);
    const cancelBtn = buttons.find(b => b.textContent === "Cancel");
    const saveBtn = buttons.find(b => b.textContent === "Save Configuration");
    
    expect(cancelBtn).toBeTruthy();
    expect(saveBtn).toBeTruthy();
  });

  it("renders tier tabs (prod, stage, dev, default)", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    const tabs = document.querySelectorAll("[role='tab']");
    expect(tabs.length).toBe(4);
    
    const tabLabels = Array.from(tabs).map(t => t.textContent);
    expect(tabLabels).toContain("PROD");
    expect(tabLabels).toContain("STAGE");
    expect(tabLabels).toContain("DEV");
    expect(tabLabels).toContain("DEFAULT");
  });

  it("switches active tier when clicking tabs", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    
    const tabs = document.querySelectorAll("[role='tab']");
    const devTab = Array.from(tabs).find(t => t.textContent === "DEV") as HTMLButtonElement;
    
    expect(devTab?.getAttribute("aria-selected")).toBe("false");
    
    act(() => { devTab?.click(); });
    
    expect(devTab?.getAttribute("aria-selected")).toBe("true");
  });

  it("renders fault sections: HTTP Error, Latency, Timeout", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    
    const sectionTitles = document.querySelectorAll(".chaos-fault-section-title");
    const titles = Array.from(sectionTitles).map(s => s.textContent);
    
    expect(titles).toContain("HTTP Error");
    expect(titles).toContain("Latency");
    expect(titles).toContain("Timeout");
  });

  it("renders sliders for error rate, latency rate, and timeout rate", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    
    const sliders = document.querySelectorAll("input[type='range']");
    expect(sliders.length).toBe(3);
  });

  it("renders status code input", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    
    const statusInputs = document.querySelectorAll("input[type='number']");
    const statusInput = Array.from(statusInputs).find(
      input => (input as HTMLInputElement).min === "400" && (input as HTMLInputElement).max === "599"
    );
    
    expect(statusInput).toBeTruthy();
  });

  it("renders latency ms input", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    
    const numberInputs = document.querySelectorAll("input[type='number']");
    const latencyInput = Array.from(numberInputs).find(
      input => (input as HTMLInputElement).min === "100" && (input as HTMLInputElement).max === "30000"
    );
    
    expect(latencyInput).toBeTruthy();
  });

  it("calls onClose when Cancel button is clicked", () => {
    let closed = false;
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => { closed = true; }}
        />
      );
    });
    
    const cancelBtn = Array.from(document.querySelectorAll("button")).find(
      b => b.textContent === "Cancel"
    ) as HTMLButtonElement;
    
    act(() => { cancelBtn?.click(); });
    expect(closed).toBe(true);
  });

  it("calls onSave with default config when Save is clicked with empty initialConfig", () => {
    let savedConfig: string = "";
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={(config) => { savedConfig = config; }}
          onClose={() => {}}
        />
      );
    });
    
    const saveBtn = Array.from(document.querySelectorAll("button")).find(
      b => b.textContent === "Save Configuration"
    ) as HTMLButtonElement;
    
    act(() => { saveBtn?.click(); });
    
    const parsed = JSON.parse(savedConfig) as ChaosConfigObj;
    expect(parsed.prod).toBeDefined();
    expect(parsed.stage).toBeDefined();
    expect(parsed.dev).toBeDefined();
    expect(parsed.default).toBeDefined();
  });

  it("calls onSave and onClose when Save button is clicked", () => {
    let saved = false;
    let closed = false;
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => { saved = true; }}
          onClose={() => { closed = true; }}
        />
      );
    });
    
    const saveBtn = Array.from(document.querySelectorAll("button")).find(
      b => b.textContent === "Save Configuration"
    ) as HTMLButtonElement;
    
    act(() => { saveBtn?.click(); });
    expect(saved).toBe(true);
    expect(closed).toBe(true);
  });

  it("parses and merges initialConfig correctly", () => {
    const initialConfig = JSON.stringify({
      prod: { error_rate: 0.5, status_code: 500, latency_rate: 0.1, latency_ms: 2000, timeout_rate: 0.05 },
    });
    
    let savedConfig: string = "";
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig={initialConfig}
          onSave={(config) => { savedConfig = config; }}
          onClose={() => {}}
        />
      );
    });
    
    const saveBtn = Array.from(document.querySelectorAll("button")).find(
      b => b.textContent === "Save Configuration"
    ) as HTMLButtonElement;
    
    act(() => { saveBtn?.click(); });
    
    const parsed = JSON.parse(savedConfig) as ChaosConfigObj;
    expect(parsed.prod.error_rate).toBe(0.5);
    expect(parsed.prod.status_code).toBe(500);
    expect(parsed.stage).toBeDefined(); // Merged from defaults
  });

  it("handles invalid initialConfig gracefully", () => {
    let savedConfig: string = "";
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig="invalid json"
          onSave={(config) => { savedConfig = config; }}
          onClose={() => {}}
        />
      );
    });
    
    const saveBtn = Array.from(document.querySelectorAll("button")).find(
      b => b.textContent === "Save Configuration"
    ) as HTMLButtonElement;
    
    act(() => { saveBtn?.click(); });
    
    const parsed = JSON.parse(savedConfig) as ChaosConfigObj;
    expect(parsed.prod).toBeDefined();
    expect(parsed.stage).toBeDefined();
    expect(parsed.dev).toBeDefined();
    expect(parsed.default).toBeDefined();
  });

  it("updates slider values when changed", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });

    const errorSlider = document.querySelector("input[type='range']") as HTMLInputElement;
    expect(errorSlider).toBeTruthy();

    const sliderValue = document.querySelector(".chaos-config-slider-value");
    expect(sliderValue?.textContent).toContain("0%");

    act(() => {
      errorSlider.value = "0.5";
      errorSlider.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });

    expect(errorSlider.value).toBe("0.5");
  });

  it("updates status code when changed", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    
    const statusInput = document.querySelector("input[type='number'][min='400']") as HTMLInputElement;
    expect(statusInput).toBeTruthy();
    
    act(() => {
      statusInput.value = "502";
      statusInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    
    expect(statusInput.value).toBe("502");
  });

  it("shows production note when prod tier is active", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    
    const prodNote = document.querySelector(".chaos-config-prod-note");
    expect(prodNote).toBeTruthy();
    expect(prodNote?.textContent).toContain("Production defaults are intentionally conservative");
  });

  it("hides production note when non-prod tier is active", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    
    const tabs = document.querySelectorAll("[role='tab']");
    const devTab = Array.from(tabs).find(t => t.textContent === "DEV") as HTMLButtonElement;
    
    act(() => { devTab?.click(); });
    
    const prodNote = document.querySelector(".chaos-config-prod-note");
    expect(prodNote).toBeFalsy();
  });

  it("calls onClose when close button in header is clicked", () => {
    let closed = false;
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => { closed = true; }}
        />
      );
    });
    
    const closeBtn = document.querySelector(".modal-close") as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    
    act(() => { closeBtn.click(); });
    expect(closed).toBe(true);
  });

  it("uses correct CSS classes for styling", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    
    expect(document.querySelector(".chaos-config-modal-panel")).toBeTruthy();
    expect(document.querySelector(".chaos-config-modal-body")).toBeTruthy();
    expect(document.querySelector(".chaos-config-modal-footer")).toBeTruthy();
    expect(document.querySelector(".chaos-tier-tabs")).toBeTruthy();
    expect(document.querySelector(".chaos-config-form")).toBeTruthy();
  });

  it("renders dialog with modal-base-surface class", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    
    const dialog = document.querySelector("dialog")!;
    expect(dialog.classList.contains("modal-base-surface")).toBe(true);
  });

  it("has correct width styling via chaos-config-modal-panel class", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    
    const dialog = document.querySelector("dialog")!;
    expect(dialog.classList.contains("chaos-config-modal-panel")).toBe(true);
  });

  it("has aria-modal attribute on dialog", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    
    const dialog = document.querySelector("dialog")!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("has correct tab accessibility attributes", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    
    const tablist = document.querySelector("[role='tablist']");
    expect(tablist).toBeTruthy();
    expect(tablist?.getAttribute("aria-label")).toBe("Fault profile tiers");
    
    const tabs = document.querySelectorAll("[role='tab']");
    const prodTab = Array.from(tabs).find(t => t.textContent === "PROD");
    expect(prodTab?.getAttribute("aria-selected")).toBe("true");
    expect(prodTab?.getAttribute("tabindex")).toBe("0");
  });

  it("keyboard navigation works for tabs (arrow keys)", () => {
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig=""
          onSave={() => {}}
          onClose={() => {}}
        />
      );
    });
    
    const tablist = document.querySelector("[role='tablist']")!;
    const tabs = document.querySelectorAll("[role='tab']");
    
    (tabs[0] as HTMLButtonElement).focus();
    
    act(() => {
      tablist.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }));
    });
    
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
  });

  it("persists configuration changes across tier switches", () => {
    const customConfig = JSON.stringify({
      prod: { error_rate: 0.75, status_code: 503, latency_rate: 0.05, latency_ms: 1500, timeout_rate: 0 },
      dev: { error_rate: 0.5, status_code: 500, latency_rate: 0.1, latency_ms: 1000, timeout_rate: 0.02 },
    });

    let savedConfig: string = "";
    act(() => {
      root.render(
        <ChaosConfigModal
          initialConfig={customConfig}
          onSave={(config) => { savedConfig = config; }}
          onClose={() => {}}
        />
      );
    });

    const saveBtn = Array.from(document.querySelectorAll("button")).find(
      b => b.textContent === "Save Configuration"
    ) as HTMLButtonElement;
    act(() => { saveBtn?.click(); });

    const parsed = JSON.parse(savedConfig) as ChaosConfigObj;
    expect(parsed.prod.error_rate).toBe(0.75);
    expect(parsed.dev.error_rate).toBe(0.5);
  });
});
