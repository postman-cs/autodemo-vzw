import { ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useFloating, offset, flip, shift, autoUpdate, type Placement } from "@floating-ui/react-dom";

export interface DropdownMenuProps {
  trigger: ReactNode;
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placement?: Placement;
  panelClassName?: string;
  panelId?: string;
  ariaLabel?: string;
  offsetValue?: number;
}

export function DropdownMenu({
  trigger,
  children,
  open,
  onOpenChange,
  placement = "bottom-start",
  panelClassName = "admin-dropdown-panel",
  panelId,
  ariaLabel,
  offsetValue = 4,
}: DropdownMenuProps) {
  const { refs, floatingStyles, elements } = useFloating({
    placement,
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(offsetValue),
      flip({ padding: 8 }),
      shift({ padding: 8 })
    ],
  });

  const triggerRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    refs.setReference(triggerRef.current);
  }, [refs]);

  useEffect(() => {
    if (!open) return;

    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      
      const referenceEl = elements.reference as Element | null;
      const floatingEl = elements.floating as Element | null;

      if (
        (referenceEl && referenceEl.contains(target)) ||
        (floatingEl && floatingEl.contains(target))
      ) {
        return;
      }
      onOpenChange(false);
    }

    const timeoutId = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open, onOpenChange, elements.reference, elements.floating]);

  return (
    <>
      <div 
        ref={triggerRef}
        className="dropdown-trigger-container"
        aria-haspopup="dialog"
      >
        {trigger}
      </div>

      {open && typeof document !== "undefined" && createPortal(
        <section
          ref={refs.setFloating}
          style={{
            ...floatingStyles,
            zIndex: 1050,
            width: elements.reference ? elements.reference.getBoundingClientRect().width : 'auto'
          }}
          className={panelClassName}
          id={panelId}
          aria-label={ariaLabel}
          role="dialog"
        >
          {children}
        </section>,
        document.body
      )}
    </>
  );
}