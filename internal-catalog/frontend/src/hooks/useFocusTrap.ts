import { useEffect, useRef } from "react";

export function useFocusTrap(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusable = Array.from(
      el.querySelectorAll<HTMLElement>(
        'a[href], button, textarea, input[type="text"], input[type="radio"], input[type="checkbox"], select, [tabindex]:not([tabindex="-1"])'
      )
    );
    if (focusable.length === 0) return;

    focusable[0].focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        if (e.shiftKey) {
          if (document.activeElement === focusable[0]) {
            focusable[focusable.length - 1].focus();
            e.preventDefault();
          }
        } else {
          if (document.activeElement === focusable[focusable.length - 1]) {
            focusable[0].focus();
            e.preventDefault();
          }
        }
      }
    };

    el.addEventListener("keydown", handleKeyDown);
    return () => {
      el.removeEventListener("keydown", handleKeyDown);
      if (previouslyFocused?.focus) {
        previouslyFocused.focus();
      }
    };
  }, [active]);

  return ref;
}
