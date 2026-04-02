interface SuccessBannerProps {
  message: string;
  onDismiss?: () => void;
}

export function SuccessBanner({ message, onDismiss }: SuccessBannerProps) {
  if (!message) return null;
  return (
    <div className="success-banner" role="status">
      <span className="success-banner-message">{message}</span>
      {onDismiss && (
        <button type="button" className="success-banner-btn" onClick={onDismiss} aria-label="Dismiss">
          Dismiss
        </button>
      )}
    </div>
  );
}
