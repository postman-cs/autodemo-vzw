import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "../../../frontend/src/contexts/ThemeContext";
import { Layout } from "../../../frontend/src/components/Layout";
import { ProvisionLayout } from "../../../frontend/src/components/ProvisionLayout";
import { CatalogPage } from "../../../frontend/src/pages/CatalogPage";
import { ProvisionPage } from "../../../frontend/src/pages/ProvisionPage";
import { SettingsPage } from "../../../frontend/src/pages/SettingsPage";
import { RecoveryPage } from "../../../frontend/src/pages/RecoveryPage";
import { DocsPage } from "../../../frontend/src/pages/DocsPage";
import { NotFoundPage } from "../../../frontend/src/pages/NotFoundPage";

export interface RenderResult {
  container: HTMLElement;
  unmount: () => void;
}

export function renderRoute(path: string): RenderResult {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // Ensure matchMedia exists for ThemeProvider (JSDOM doesn't provide it)
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
      }),
    });
  }

  if (typeof globalThis.ResizeObserver !== "function") {
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    Object.defineProperty(globalThis, "ResizeObserver", {
      writable: true,
      configurable: true,
      value: ResizeObserverMock,
    });
  }

  const container = document.createElement("div");
  document.body.appendChild(container);

  const root = createRoot(container);
  root.render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<CatalogPage />} />
            <Route path="recovery" element={<RecoveryPage />} />
            <Route path="provision" element={<ProvisionLayout />}>
              <Route index element={<ProvisionPage />} />
            </Route>
            <Route path="settings" element={<SettingsPage />} />
            <Route path="docs" element={<DocsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ThemeProvider>
  );

  return {
    container,
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

export function waitForElement(
  selector: string,
  container: HTMLElement = document.body,
  timeoutMs = 2000
): Promise<Element> {
  return new Promise((resolve, reject) => {
    const el = container.querySelector(selector);
    if (el) {
      resolve(el);
      return;
    }

    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      const found = container.querySelector(selector);
      if (found) {
        clearInterval(interval);
        resolve(found);
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(interval);
        reject(new Error(`waitForElement: "${selector}" not found within ${timeoutMs}ms`));
      }
    }, 16);
  });
}
