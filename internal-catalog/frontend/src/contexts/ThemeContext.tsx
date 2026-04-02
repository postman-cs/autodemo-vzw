import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";

type ThemeMode = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  theme: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setTheme: (mode: ThemeMode) => void;
}

const STORAGE_KEY = "catalog-theme";

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

function readStoredMode(): ThemeMode | null {
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light" || stored === "system") {
      return stored;
    }
  } catch {
    return null;
  }
  return null;
}

function getInitialMode(): ThemeMode {
  return readStoredMode() || "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(getInitialMode);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(getInitialMode()));

  const applyTheme = useCallback((m: ThemeMode) => {
    const r = resolveTheme(m);
    setMode(m);
    setResolved(r);
    document.documentElement.setAttribute("data-theme", r);
    try {
      window.localStorage?.setItem(STORAGE_KEY, m);
    } catch {
      // Ignore storage writes in environments where localStorage is unavailable.
    }
  }, []);

  useEffect(() => {
    const r = resolveTheme(mode);
    setResolved(r);
    document.documentElement.setAttribute("data-theme", r);
  }, [mode]);

  useEffect(() => {
    if (mode !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: { matches: boolean }) => {
      const r = e.matches ? "dark" : "light";
      setResolved(r);
      document.documentElement.setAttribute("data-theme", r);
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [mode]);

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const newMode = (e.newValue || "system") as ThemeMode;
      setMode(newMode);
      const r = resolveTheme(newMode);
      setResolved(r);
      document.documentElement.setAttribute("data-theme", r);
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  return (
    <ThemeContext value={{ theme: mode, resolvedTheme: resolved, setTheme: applyTheme }}>
      {children}
    </ThemeContext>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
