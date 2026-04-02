import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { Modal } from "../../frontend/src/components/Modal";
import { installDialogMocks, restoreDialogMocks } from "./helpers/dialog-mock";
import { simulateEscapeKey, simulateBackdropClick, isDialogOpen } from "./helpers/modal-test-utils";

describe("Modal", () => {
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
      root.render(<Modal open={false} onClose={() => {}}><Modal.Body>Hi</Modal.Body></Modal>);
    });
    expect(document.querySelector("dialog")).toBeTruthy();
  });

  it("calls showModal when open=true", () => {
    act(() => {
      root.render(<Modal open={true} onClose={() => {}}><Modal.Body>Hi</Modal.Body></Modal>);
    });
    const dialog = document.querySelector("dialog")!;
    expect(isDialogOpen(dialog)).toBe(true);
  });

  it("calls close when open transitions to false", () => {
    const onClose = () => {};
    act(() => { root.render(<Modal open={true} onClose={onClose}><Modal.Body>Hi</Modal.Body></Modal>); });
    act(() => { root.render(<Modal open={false} onClose={onClose}><Modal.Body>Hi</Modal.Body></Modal>); });
    const dialog = document.querySelector("dialog")!;
    expect(isDialogOpen(dialog)).toBe(false);
  });

  it("calls onClose when Escape is pressed", () => {
    let closed = false;
    act(() => {
      root.render(<Modal open={true} onClose={() => { closed = true; }}><Modal.Body>Hi</Modal.Body></Modal>);
    });
    const dialog = document.querySelector("dialog")!;
    simulateEscapeKey(dialog);
    expect(closed).toBe(true);
  });

  it("calls onClose on backdrop click", () => {
    let closed = false;
    act(() => {
      root.render(<Modal open={true} onClose={() => { closed = true; }}><Modal.Body>Hi</Modal.Body></Modal>);
    });
    const dialog = document.querySelector("dialog")!;
    simulateBackdropClick(dialog);
    expect(closed).toBe(true);
  });

  it("does NOT call onClose when clicking inside content", () => {
    let closed = false;
    act(() => {
      root.render(
        <Modal open={true} onClose={() => { closed = true; }}>
          <Modal.Body><span id="inner">Content</span></Modal.Body>
        </Modal>
      );
    });
    const inner = document.querySelector("#inner")!;
    inner.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(closed).toBe(false);
  });

  it("renders Header, Body, Footer compound children", () => {
    act(() => {
      root.render(
        <Modal open={true} onClose={() => {}}>
          <Modal.Header title="Test Title" />
          <Modal.Body><p>Body content</p></Modal.Body>
          <Modal.Footer><button type="button">OK</button></Modal.Footer>
        </Modal>
      );
    });
    expect(document.querySelector(".modal-header-modern")).toBeTruthy();
    expect(document.querySelector(".modal-body-modern")).toBeTruthy();
    expect(document.querySelector(".modal-footer-modern")).toBeTruthy();
    expect(document.querySelector(".modal-header-modern")?.textContent).toContain("Test Title");
  });

  it("has aria-modal attribute", () => {
    act(() => {
      root.render(<Modal open={true} onClose={() => {}}><Modal.Body>Hi</Modal.Body></Modal>);
    });
    const dialog = document.querySelector("dialog")!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("applies custom className to the dialog", () => {
    act(() => {
      root.render(<Modal open={true} onClose={() => {}} className="test-modal-shell"><Modal.Body>Hi</Modal.Body></Modal>);
    });
    const dialog = document.querySelector("dialog")!;
    expect(dialog.className).toContain("test-modal-shell");
  });

  it("Header renders close button that calls onClose", () => {
    let closed = false;
    act(() => {
      root.render(
        <Modal open={true} onClose={() => { closed = true; }}>
          <Modal.Header title="Title" />
          <Modal.Body>Content</Modal.Body>
        </Modal>
      );
    });
    const closeBtn = document.querySelector(".modal-close") as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    act(() => { closeBtn.click(); });
    expect(closed).toBe(true);
  });

  it("close button is inside modal-inner (card anchor, not dialog viewport)", () => {
    act(() => {
      root.render(
        <Modal open={true} onClose={() => {}}>
          <Modal.Header title="Title" />
          <Modal.Body>Content</Modal.Body>
        </Modal>
      );
    });
    const inner = document.querySelector(".modal-inner");
    const closeBtn = document.querySelector(".modal-close");
    expect(inner).toBeTruthy();
    expect(closeBtn).toBeTruthy();
    expect(inner?.contains(closeBtn)).toBe(true);
  });
});
