type StatusVariant = "loading" | "empty" | "error" | "warning" | "success" | "in-progress";

interface StatusCardProps {
  variant: StatusVariant;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  secondaryAction?: { label: string; onClick: () => void };
  className?: string;
}

export function StatusCard({
  variant,
  title,
  description,
  action,
  secondaryAction,
  className,
}: StatusCardProps) {
  const roleAttr =
    variant === "error" || variant === "warning"
      ? "alert"
      : variant === "loading" || variant === "in-progress"
      ? "status"
      : undefined;

  return (
    <div
      className={["status-card", `status-card--${variant}`, className].filter(Boolean).join(" ")}
      role={roleAttr}
    >
      {variant === "in-progress" && (
        <div className="status-progress-bar">
          <div className="status-progress-bar-fill" />
        </div>
      )}
      <div className="status-card-content">
        <h3 className="status-card-title">
          {variant === "loading" && (
            <span className="status-spinner" aria-hidden="true" />
          )}
          {title}
        </h3>
        {description && (
          <p className="status-card-description">{description}</p>
        )}
      </div>
      {(action || secondaryAction) && (
        <div className="status-card-actions">
          {action && (
            <button type="button" className="btn btn-sm btn-primary" onClick={action.onClick}>
              {action.label}
            </button>
          )}
          {secondaryAction && (
            <button type="button" className="btn btn-sm btn-secondary" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
