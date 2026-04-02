interface ErrorBannerProps {
  message: string;
  onDismiss?: () => void;
  onRetry?: () => void;
}

export function ErrorBanner({ message, onDismiss, onRetry }: ErrorBannerProps) {
  if (!message) return null;

  return (
    <div className="error-banner" role="alert">
      <span className="error-banner-message">{message}</span>
      <div className="error-banner-actions">
        {onRetry && (
          <button className="error-banner-btn" onClick={onRetry}>
            Retry
          </button>
        )}
        {onDismiss && (
          <button className="error-banner-btn" onClick={onDismiss} aria-label="Dismiss error">
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
