import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";

export type ToastType = "success" | "error" | "warning" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration: number;
  action?: ToastAction;
  exiting?: boolean;
}

interface AddToastOptions {
  type?: ToastType;
  duration?: number;
  action?: ToastAction;
}

interface ToastContextValue {
  toasts: Toast[];
  addToast: (message: string, options?: AddToastOptions) => string;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const MAX_TOASTS = 5;

function defaultDuration(type: ToastType): number {
  return type === "error" || type === "warning" ? 8000 : 5000;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const startExitAnimation = useCallback(
    (id: string) => {
      setToasts((prev) =>
        prev.map((t) => (t.id === id ? { ...t, exiting: true } : t))
      );
      const exitTimer = setTimeout(() => removeToast(id), 220);
      timers.current.set(`${id}__exit`, exitTimer);
    },
    [removeToast]
  );

  const dismissToast = useCallback(
    (id: string) => {
      const existingExit = timers.current.get(`${id}__exit`);
      if (existingExit !== undefined) return;
      const autoTimer = timers.current.get(id);
      if (autoTimer !== undefined) {
        clearTimeout(autoTimer);
        timers.current.delete(id);
      }
      startExitAnimation(id);
    },
    [startExitAnimation]
  );

  const addToast = useCallback(
    (message: string, options: AddToastOptions = {}): string => {
      const id = crypto.randomUUID();
      const type: ToastType = options.type ?? "info";
      const duration = options.duration ?? defaultDuration(type);

      const toast: Toast = {
        id,
        message,
        type,
        duration,
        action: options.action,
      };

      setToasts((prev) => {
        let next = [...prev, toast];
        if (next.length > MAX_TOASTS) {
          const oldest = next[0];
          const exitTimer = timers.current.get(`${oldest.id}__exit`);
          if (exitTimer === undefined) {
            const autoTimer = timers.current.get(oldest.id);
            if (autoTimer !== undefined) {
              clearTimeout(autoTimer);
              timers.current.delete(oldest.id);
            }
            next = next.map((t, i) =>
              i === 0 ? { ...t, exiting: true } : t
            );
            const removeTimer = setTimeout(() => removeToast(oldest.id), 220);
            timers.current.set(`${oldest.id}__exit`, removeTimer);
          } else {
            next = next.slice(1);
          }
        }
        return next;
      });

      const autoTimer = setTimeout(() => startExitAnimation(id), duration);
      timers.current.set(id, autoTimer);

      return id;
    },
    [startExitAnimation, removeToast]
  );

  return (
    <ToastContext.Provider value={{ toasts, addToast, dismissToast }}>
      {children}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
