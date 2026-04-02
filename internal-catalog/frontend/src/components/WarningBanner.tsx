interface WarningBannerProps {
  message: string;
  onDismiss?: () => void;
  action?: { label: string; onClick: () => void };
}

export function WarningBanner({ message, onDismiss, action }: WarningBannerProps) {
  if (!message) return null;
  return (
    <div className="warning-banner" role="alert">
      <span className="warning-banner-message">{message}</span>
      <div className="warning-banner-actions">
        {action && (
          <button type="button" className="warning-banner-btn" onClick={action.onClick}>
            {action.label}
          </button>
        )}
        {onDismiss && (
          <button type="button" className="warning-banner-btn" onClick={onDismiss} aria-label="Dismiss warning">
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
