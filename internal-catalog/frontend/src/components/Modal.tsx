import { useEffect, useRef, useId, createContext, useContext, type ReactNode } from "react";

const ModalContext = createContext<{
  onClose: () => void;
  bodyRef: React.RefObject<HTMLDivElement | null> | null;
  topSentinelRef: React.RefObject<HTMLDivElement | null> | null;
  bottomSentinelRef: React.RefObject<HTMLDivElement | null> | null;
}>({ onClose: () => {}, bodyRef: null, topSentinelRef: null, bottomSentinelRef: null });

function useScrollDividers(
  dialogRef: React.RefObject<HTMLDialogElement | null>,
  open: boolean,
  topSentinelRef: React.RefObject<HTMLDivElement | null>,
  bottomSentinelRef: React.RefObject<HTMLDivElement | null>
) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !bodyRef.current || !dialogRef.current) return;
    if (typeof IntersectionObserver === "undefined") return;
    if (!topSentinelRef.current || !bottomSentinelRef.current) return;

    const body = bodyRef.current;
    const dialog = dialogRef.current;
    const topSentinel = topSentinelRef.current;
    const bottomSentinel = bottomSentinelRef.current;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target === topSentinel) {
            dialog.setAttribute("data-scrolled-top", String(!entry.isIntersecting));
          } else if (entry.target === bottomSentinel) {
            dialog.setAttribute("data-scrolled-bottom", String(!entry.isIntersecting));
          }
        }
      },
      { root: body, threshold: 0 }
    );

    observer.observe(topSentinel);
    observer.observe(bottomSentinel);

    return () => {
      observer.disconnect();
      dialog.removeAttribute("data-scrolled-top");
      dialog.removeAttribute("data-scrolled-bottom");
    };
  }, [open, dialogRef, topSentinelRef, bottomSentinelRef]);

  return bodyRef;
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}

export function Modal({ open, onClose, className, children }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useScrollDividers(dialogRef, open, topSentinelRef, bottomSentinelRef);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  return (
    <ModalContext value={{ onClose, bodyRef, topSentinelRef, bottomSentinelRef }}>
      <dialog
        ref={dialogRef}
        className={`modal-base-surface${className ? ` ${className}` : ""}`}
        aria-modal="true"
        aria-labelledby={titleId}
        onCancel={(e) => {
          e.preventDefault();
          onClose();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        onClick={(e) => {
          if (e.target === dialogRef.current) {
            onClose();
          }
        }}
      >
        <div className="modal-inner modal-noise" data-title-id={titleId}>
          <ModalCloseButton onClose={onClose} />
          {children}
        </div>
      </dialog>
    </ModalContext>
  );
}

function ModalCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  );
}

interface HeaderProps {
  title: string;
  subtitle?: string;
}

function ModalHeader({ title, subtitle }: HeaderProps) {
  return (
    <div className="modal-header-modern">
      <h2 className="modal-title">{title}</h2>
      {subtitle && <p className="modal-subtitle">{subtitle}</p>}
    </div>
  );
}

function ModalBody({ children, className }: { children: ReactNode; className?: string }) {
  const { bodyRef, topSentinelRef, bottomSentinelRef } = useContext(ModalContext);
  return (
    <div ref={bodyRef} className={`modal-body-modern${className ? ` ${className}` : ""}`}>
      <div ref={topSentinelRef} data-sentinel="top" style={{ height: "1px", flexShrink: 0 }} />
      {children}
      <div ref={bottomSentinelRef} data-sentinel="bottom" style={{ height: "1px", flexShrink: 0 }} />
    </div>
  );
}

function ModalFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`modal-footer-modern${className ? ` ${className}` : ""}`}>{children}</div>;
}

Modal.Header = ModalHeader;
Modal.Body = ModalBody;
Modal.Footer = ModalFooter;
