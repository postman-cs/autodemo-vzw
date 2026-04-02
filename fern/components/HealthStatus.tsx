export function HealthStatus() {
  return (
    <div className="vzw-health-block">
      <span className="vzw-metric-label">Health</span>
      <div className="vzw-health-value" data-field="health">
        <span className="vzw-status-dot vzw-is-offline"></span>
        <strong>Loading...</strong>
      </div>
    </div>
  );
}
