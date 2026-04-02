import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ConfirmDialog } from "../../frontend/src/components/ConfirmDialog";
import { installDialogMocks, restoreDialogMocks } from "./helpers/dialog-mock";
import { simulateEscapeKey, simulateBackdropClick, isDialogOpen } from "./helpers/modal-test-utils";

describe("ConfirmDialog", () => {
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
        <ConfirmDialog
          open={false}
          title="Delete item"
          description="Are you sure?"
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      );
    });
    expect(document.querySelector("dialog")).toBeTruthy();
  });

  it("opens when open=true", () => {
    act(() => {
      root.render(
        <ConfirmDialog
          open={true}
          title="Delete item"
          description="Are you sure?"
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      );
    });
    const dialog = document.querySelector("dialog")!;
    expect(isDialogOpen(dialog)).toBe(true);
  });

  it("closes when open transitions to false", () => {
    const onCancel = () => {};
    act(() => {
      root.render(
        <ConfirmDialog
          open={true}
          title="Delete item"
          description="Are you sure?"
          onConfirm={() => {}}
          onCancel={onCancel}
        />
      );
    });
    act(() => {
      root.render(
        <ConfirmDialog
          open={false}
          title="Delete item"
          description="Are you sure?"
          onConfirm={() => {}}
          onCancel={onCancel}
        />
      );
    });
    const dialog = document.querySelector("dialog")!;
    expect(isDialogOpen(dialog)).toBe(false);
  });

  it("renders title and description text", () => {
    act(() => {
      root.render(
        <ConfirmDialog
          open={true}
          title="Confirm deletion"
          description="This action cannot be undone."
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      );
    });
    expect(document.querySelector(".modal-title")?.textContent).toBe("Confirm deletion");
    expect(document.querySelector(".confirm-dialog-desc")?.textContent).toBe("This action cannot be undone.");
  });

  it("calls onConfirm when confirm button is clicked", () => {
    let confirmed = false;
    act(() => {
      root.render(
        <ConfirmDialog
          open={true}
          title="Delete item"
          description="Are you sure?"
          onConfirm={() => { confirmed = true; }}
          onCancel={() => {}}
        />
      );
    });
    const confirmBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Confirm"
    ) as HTMLButtonElement;
    expect(confirmBtn).toBeTruthy();
    act(() => { confirmBtn.click(); });
    expect(confirmed).toBe(true);
  });

  it("calls onCancel when cancel button is clicked", () => {
    let cancelled = false;
    act(() => {
      root.render(
        <ConfirmDialog
          open={true}
          title="Delete item"
          description="Are you sure?"
          onConfirm={() => {}}
          onCancel={() => { cancelled = true; }}
        />
      );
    });
    const cancelBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Cancel"
    ) as HTMLButtonElement;
    expect(cancelBtn).toBeTruthy();
    act(() => { cancelBtn.click(); });
    expect(cancelled).toBe(true);
  });

  it("calls onCancel when Escape is pressed", () => {
    let cancelled = false;
    act(() => {
      root.render(
        <ConfirmDialog
          open={true}
          title="Delete item"
          description="Are you sure?"
          onConfirm={() => {}}
          onCancel={() => { cancelled = true; }}
        />
      );
    });
    const dialog = document.querySelector("dialog")!;
    simulateEscapeKey(dialog);
    expect(cancelled).toBe(true);
  });

  it("calls onCancel on backdrop click", () => {
    let cancelled = false;
    act(() => {
      root.render(
        <ConfirmDialog
          open={true}
          title="Delete item"
          description="Are you sure?"
          onConfirm={() => {}}
          onCancel={() => { cancelled = true; }}
        />
      );
    });
    const dialog = document.querySelector("dialog")!;
    simulateBackdropClick(dialog);
    expect(cancelled).toBe(true);
  });

  it("uses custom confirmLabel and cancelLabel", () => {
    act(() => {
      root.render(
        <ConfirmDialog
          open={true}
          title="Remove"
          description="Remove this?"
          confirmLabel="Yes, remove"
          cancelLabel="No, keep"
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      );
    });
    const buttons = Array.from(document.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toContain("Yes, remove");
    expect(buttons).toContain("No, keep");
  });

  it("applies btn-danger class for danger variant", () => {
    act(() => {
      root.render(
        <ConfirmDialog
          open={true}
          title="Delete"
          description="Permanently delete?"
          variant="danger"
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      );
    });
    const confirmBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Confirm"
    ) as HTMLButtonElement;
    expect(confirmBtn.classList.contains("btn-danger")).toBe(true);
    expect(confirmBtn.classList.contains("btn-primary")).toBe(false);
  });

  it("applies btn-primary class for default variant", () => {
    act(() => {
      root.render(
        <ConfirmDialog
          open={true}
          title="Confirm"
          description="Proceed?"
          variant="default"
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      );
    });
    const confirmBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Confirm"
    ) as HTMLButtonElement;
    expect(confirmBtn.classList.contains("btn-primary")).toBe(true);
    expect(confirmBtn.classList.contains("btn-danger")).toBe(false);
  });

  it("applies btn-primary class when variant is omitted (default)", () => {
    act(() => {
      root.render(
        <ConfirmDialog
          open={true}
          title="Confirm"
          description="Proceed?"
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      );
    });
    const confirmBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Confirm"
    ) as HTMLButtonElement;
    expect(confirmBtn.classList.contains("btn-primary")).toBe(true);
  });

  it("renders inside a dialog with modal-base-surface class", () => {
    act(() => {
      root.render(
        <ConfirmDialog
          open={true}
          title="Test"
          description="Test desc"
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      );
    });
    const dialog = document.querySelector("dialog")!;
    expect(dialog.classList.contains("modal-base-surface")).toBe(true);
  });

  it("renders Modal.Body and Modal.Footer wrappers", () => {
    act(() => {
      root.render(
        <ConfirmDialog
          open={true}
          title="Test"
          description="Test desc"
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      );
    });
    expect(document.querySelector(".modal-body-modern")).toBeTruthy();
    expect(document.querySelector(".modal-footer-modern")).toBeTruthy();
  });
});
