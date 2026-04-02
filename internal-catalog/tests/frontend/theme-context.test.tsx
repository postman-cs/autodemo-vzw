import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ThemeProvider, useTheme } from "../../frontend/src/contexts/ThemeContext";
import {
  mockMatchMedia,
  clearThemeState,
  setStoredTheme,
  getStoredTheme,
  simulateSystemThemeChange,
} from "./helpers/theme-mock";

function TestConsumer() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{resolvedTheme}</span>
      <button type="button" onClick={() => setTheme("dark")}>Dark</button>
      <button type="button" onClick={() => setTheme("light")}>Light</button>
      <button type="button" onClick={() => setTheme("system")}>System</button>
    </div>
  );
}

describe("ThemeContext", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    clearThemeState();
    mockMatchMedia(false); // default: light system preference
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    clearThemeState();
  });

  it("defaults to light theme when no stored preference", () => {
    act(() => {
      root.render(<ThemeProvider><TestConsumer /></ThemeProvider>);
    });
    expect(container.querySelector('[data-testid="theme"]')?.textContent).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("detects system dark preference on first visit", () => {
    mockMatchMedia(true); // system prefers dark
    act(() => {
      root.render(<ThemeProvider><TestConsumer /></ThemeProvider>);
    });
    expect(container.querySelector('[data-testid="theme"]')?.textContent).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("reads stored theme from localStorage", () => {
    setStoredTheme("dark");
    act(() => {
      root.render(<ThemeProvider><TestConsumer /></ThemeProvider>);
    });
    expect(container.querySelector('[data-testid="theme"]')?.textContent).toBe("dark");
  });

  it("persists theme to localStorage on change", () => {
    act(() => {
      root.render(<ThemeProvider><TestConsumer /></ThemeProvider>);
    });
    const darkBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Dark"
    )!;
    act(() => { darkBtn.click(); });
    expect(getStoredTheme()).toBe("dark");
  });

  it("updates data-theme attribute on html element", () => {
    act(() => {
      root.render(<ThemeProvider><TestConsumer /></ThemeProvider>);
    });
    const darkBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Dark"
    )!;
    act(() => { darkBtn.click(); });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("responds to system theme changes when in system mode", () => {
    act(() => {
      root.render(<ThemeProvider><TestConsumer /></ThemeProvider>);
    });
    const sysBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "System"
    )!;
    act(() => { sysBtn.click(); });
    act(() => { simulateSystemThemeChange(true); });
    expect(container.querySelector('[data-testid="theme"]')?.textContent).toBe("dark");
  });

  it("sets data-theme=light when user explicitly selects light on a system-dark machine", () => {
    mockMatchMedia(true);
    act(() => {
      root.render(<ThemeProvider><TestConsumer /></ThemeProvider>);
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    const lightBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Light"
    )!;
    act(() => { lightBtn.click(); });

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(container.querySelector('[data-testid="theme"]')?.textContent).toBe("light");
  });

  it("sets data-theme=dark when user explicitly selects dark on a system-light machine", () => {
    mockMatchMedia(false);
    act(() => {
      root.render(<ThemeProvider><TestConsumer /></ThemeProvider>);
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    const darkBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Dark"
    )!;
    act(() => { darkBtn.click(); });

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(container.querySelector('[data-testid="theme"]')?.textContent).toBe("dark");
  });

  it("persists explicit light selection to localStorage on a system-dark machine", () => {
    mockMatchMedia(true);
    act(() => {
      root.render(<ThemeProvider><TestConsumer /></ThemeProvider>);
    });
    const lightBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Light"
    )!;
    act(() => { lightBtn.click(); });
    expect(getStoredTheme()).toBe("light");
  });
});
