import { vi } from "vitest";

const STORAGE_KEY = "catalog-theme";

interface MockMediaQueryList {
  matches: boolean;
  media: string;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  dispatchEvent: ReturnType<typeof vi.fn>;
  onchange: null;
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
}

let mockDarkMode = false;
let mediaQueryListeners: Array<(e: { matches: boolean }) => void> = [];

// In-memory localStorage mock for environments where window.localStorage is undefined
const storageMap = new Map<string, string>();

function ensureLocalStorage(): void {
  if (typeof window !== "undefined" && !window.localStorage) {
    Object.defineProperty(window, "localStorage", {
      writable: true,
      configurable: true,
      value: {
        getItem: (key: string) => storageMap.get(key) ?? null,
        setItem: (key: string, value: string) => { storageMap.set(key, String(value)); },
        removeItem: (key: string) => { storageMap.delete(key); },
        clear: () => { storageMap.clear(); },
        get length() { return storageMap.size; },
        key: (index: number) => [...storageMap.keys()][index] ?? null,
      },
    });
  }
}

export function mockMatchMedia(prefersDark: boolean): void {
  mockDarkMode = prefersDark;
  mediaQueryListeners = [];

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn((query: string): MockMediaQueryList => ({
      matches: query === "(prefers-color-scheme: dark)" ? mockDarkMode : false,
      media: query,
      addEventListener: vi.fn((_event: string, listener: (e: { matches: boolean }) => void) => {
        if (query === "(prefers-color-scheme: dark)") {
          mediaQueryListeners.push(listener);
        }
      }),
      removeEventListener: vi.fn((_event: string, listener: (e: { matches: boolean }) => void) => {
        mediaQueryListeners = mediaQueryListeners.filter(l => l !== listener);
      }),
      dispatchEvent: vi.fn(),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

export function simulateSystemThemeChange(prefersDark: boolean): void {
  mockDarkMode = prefersDark;
  for (const listener of mediaQueryListeners) {
    listener({ matches: prefersDark });
  }
}

export function setStoredTheme(theme: string | null): void {
  ensureLocalStorage();
  try {
    if (theme === null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, theme);
    }
  } catch { /* no storage */ }
}

export function getStoredTheme(): string | null {
  ensureLocalStorage();
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch { return null; }
}

export function clearThemeState(): void {
  ensureLocalStorage();
  storageMap.clear();
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* no storage */ }
  if (typeof document !== "undefined") {
    document.documentElement.removeAttribute("data-theme");
  }
  mediaQueryListeners = [];
}
