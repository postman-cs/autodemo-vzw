import { useEffect, useRef, type RefObject } from 'react';

export function useMenuKeyboardNav(
    isOpen: boolean,
    closeMenu: () => void,
    triggerRef?: RefObject<HTMLElement | null>,
) {
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                closeMenu();
                requestAnimationFrame(() => triggerRef?.current?.focus());
                return;
            }

            const el = menuRef.current;
            if (!el) return;

            const items = Array.from(el.querySelectorAll<HTMLElement>('button, a, input'));
            const currentIndex = items.indexOf(document.activeElement as HTMLElement);

            if (e.key === "ArrowDown") {
                e.preventDefault();
                const next = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
                items[next]?.focus();
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                const next = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
                items[next]?.focus();
            }
        };

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [isOpen, closeMenu, triggerRef]);

    return menuRef;
}
