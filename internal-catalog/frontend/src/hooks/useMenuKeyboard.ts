import { useEffect } from "react";

/**
 * Handles arrow-key navigation within menu elements (role="menu").
 * ArrowDown/Up move focus; Home/End jump to first/last.
 * Only active when a menu is open.
 */
export function useMenuKeyboard(menuOpen: boolean) {
  useEffect(() => {
    if (!menuOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const menu = target.closest('[role="menu"]');
      if (!menu) return;

      const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
      if (items.length === 0) return;

      const currentIndex = items.findIndex((el) => el === document.activeElement);
      let nextIndex = -1;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        nextIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
      } else if (e.key === "Home") {
        e.preventDefault();
        nextIndex = 0;
      } else if (e.key === "End") {
        e.preventDefault();
        nextIndex = items.length - 1;
      }

      if (nextIndex >= 0) {
        items[nextIndex].focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);
}
