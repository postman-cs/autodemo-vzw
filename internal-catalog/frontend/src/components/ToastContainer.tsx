import { createPortal } from "react-dom";
import { useToast } from "../hooks/useToast";
import type { ToastType } from "../hooks/useToast";

const ICONS: Record<ToastType, string> = {
  success: "\u2713",
  error: "\u2715",
  warning: "\u26a0",
  info: "i",
};

export function ToastContainer() {
  const { toasts, dismissToast } = useToast();

  return createPortal(
    <div
      className="toast-container"
      role="status"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast--${toast.type}${toast.exiting ? " toast--exiting" : ""}`}
        >
          <span
            className={`toast-icon toast-icon--${toast.type}`}
            aria-hidden="true"
          >
            {ICONS[toast.type]}
          </span>
          <span className="toast-message">{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                toast.action!.onClick();
                dismissToast(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            className="toast-dismiss"
            onClick={() => dismissToast(toast.id)}
            aria-label="Dismiss notification"
          >
            &times;
          </button>
        </div>
      ))}
    </div>,
    document.body
  );
}
