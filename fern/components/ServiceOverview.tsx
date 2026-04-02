export function ServiceOverview({
  serviceId,
  title,
  description,
  graphName,
  runtime,
}: {
  serviceId: string;
  title: string;
  description?: string;
  graphName?: string;
  runtime?: string;
}) {
  return (
    <div className="vzw-service-overview" data-service-id={serviceId}>
      <div className="vzw-hero">
        <div className="vzw-hero-header">
          <div>
            <span className="vzw-eyebrow">Service Documentation</span>
            <h1 className="vzw-hero-title">{title}</h1>
          </div>
          <div className="vzw-badges">
            {graphName && <span className="vzw-graph-pill">{graphName}</span>}
            {runtime && <span className="vzw-runtime-pill">{runtime}</span>}
          </div>
        </div>
        {description && <p className="vzw-hero-description">{description}</p>}

        <div className="vzw-status-card">
          <div className="vzw-health-block">
            <span className="vzw-metric-label">Health</span>
            <div className="vzw-health-value" data-field="health">
              <span className="vzw-status-dot vzw-is-offline"></span>
              <strong>Loading...</strong>
            </div>
          </div>
          <div className="vzw-urls-block">
            <span className="vzw-metric-label">Base URLs</span>
            <div className="vzw-urls-list" data-field="base-urls">
              <span className="vzw-muted">Loading...</span>
            </div>
          </div>
        </div>

        <div className="vzw-actions" data-field="actions">
          <span className="vzw-muted">Loading actions...</span>
        </div>
      </div>

      <div className="vzw-deps-section">
        <div className="vzw-deps-group" data-field="upstream-deps">
          <div className="vzw-deps-header">
            <div>
              <span className="vzw-eyebrow">Dependency Traversal</span>
              <h2>Upstream Dependencies</h2>
            </div>
            <span className="vzw-count-pill" data-field="upstream-count">--</span>
          </div>
          <div className="vzw-deps-list" data-field="upstream-list">
            <span className="vzw-muted">Loading...</span>
          </div>
        </div>
        <div className="vzw-deps-group" data-field="downstream-deps">
          <div className="vzw-deps-header">
            <div>
              <span className="vzw-eyebrow">Dependency Traversal</span>
              <h2>Downstream Consumers</h2>
            </div>
            <span className="vzw-count-pill" data-field="downstream-count">--</span>
          </div>
          <div className="vzw-deps-list" data-field="downstream-list">
            <span className="vzw-muted">Loading...</span>
          </div>
        </div>
        <div className="vzw-deps-group" data-field="consumes-deps">
          <div className="vzw-deps-header">
            <div>
              <span className="vzw-eyebrow">Dependency Traversal</span>
              <h2>Runtime API Consumers</h2>
            </div>
            <span className="vzw-count-pill" data-field="consumes-count">--</span>
          </div>
          <div className="vzw-deps-list" data-field="consumes-list">
            <span className="vzw-muted">Loading...</span>
          </div>
        </div>
      </div>
    </div>
  );
}
