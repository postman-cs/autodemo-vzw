import { createRoot } from "react-dom/client";
import { act } from "react";
import type { ReactElement } from "react";

export function simulateEscapeKey(element: HTMLElement): void {
  element.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    })
  );
}

export function simulateBackdropClick(dialog: HTMLDialogElement): void {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "target", { value: dialog });
  dialog.dispatchEvent(event);
}

export function isDialogOpen(dialog: HTMLDialogElement): boolean {
  return dialog.hasAttribute("open");
}

export interface ModalRenderResult {
  container: HTMLElement;
  dialog: HTMLDialogElement;
  unmount: () => void;
}

export function renderModal(modalElement: ReactElement): ModalRenderResult {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const root = createRoot(container);
  act(() => {
    root.render(modalElement);
  });

  const dialog = container.querySelector("dialog");
  if (!dialog) {
    throw new Error("renderModal: No <dialog> element found in rendered output");
  }

  return {
    container,
    dialog: dialog as HTMLDialogElement,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

export function waitForDialogOpen(
  dialog: HTMLDialogElement,
  timeoutMs = 1000
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (dialog.hasAttribute("open")) {
      resolve();
      return;
    }

    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      if (dialog.hasAttribute("open")) {
        clearInterval(interval);
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(interval);
        reject(new Error(`waitForDialogOpen: dialog did not open within ${timeoutMs}ms`));
      }
    }, 16);
  });
}
