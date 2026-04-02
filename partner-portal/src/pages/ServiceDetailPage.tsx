import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchServiceDetail, getEntrypointUrl, getFernDocsUrl, getRunInPostmanUrl } from "../api";
import { CopyButton, DependencyCard } from "../components";
import type { ServiceDetailResponse } from "../types";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: ServiceDetailResponse };

export function ServiceDetailPage() {
  const { serviceId = "" } = useParams();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    fetchServiceDetail(serviceId)
      .then((data) => {
        if (!cancelled) {
          setState({ status: "ready", data });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Unable to load service details.",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [serviceId]);

  const promptValue = useMemo(() => {
    if (state.status !== "ready") {
      return "";
    }

    return state.data.service.agent_prompt;
  }, [state]);

  if (state.status === "loading") {
    return <div className="info-banner">Loading service detail.</div>;
  }

  if (state.status === "error") {
    return <div className="info-banner is-error">{state.message}</div>;
  }

  const { service, dependencies } = state.data;
  const docsUrl = getFernDocsUrl(service);
  const postmanUrl = getRunInPostmanUrl(service);
  const entrypointUrl = getEntrypointUrl(service);
  const environmentDeployments = state.data.environment_deployments ?? [];
  const health = service.health ?? (service.deployed ? "healthy" : "offline");
  const healthClassByStatus = {
    healthy: "is-healthy",
    degraded: "is-degraded",
    offline: "is-offline",
  } as const;
  const healthLabelByStatus = {
    healthy: "Healthy",
    degraded: "Degraded",
    offline: "Offline",
  } as const;
  const healthClass = healthClassByStatus[health];
  const healthLabel = healthLabelByStatus[health];

  return (
    <>
      <Link className="back-link" to="/">
        &lt; Back to Services
      </Link>

      <section className="detail-shell">
        <div className="detail-hero">
          <div className="detail-header-row">
            <div>
              <div className="eyebrow">Documentation</div>
              <h1>{service.title}</h1>
            </div>
            <div className="detail-badges">
              {service.graph_name ? <span className="graph-pill">{service.graph_name}</span> : null}
            </div>
          </div>
          {service.description ? (
            <p style={{ fontSize: "var(--text-xl)", color: "var(--vze-gray-500)", marginTop: "12px", marginBottom: "24px", lineHeight: 1.6, maxWidth: "800px" }}>
              {service.description}
            </p>
          ) : null}

          <div className="detail-status-card">
            <div>
              <span className="metric-label">Health</span>
              <div className="detail-status-line">
                <span className={`status-dot ${healthClass}`} aria-hidden="true" />
                <strong>{healthLabel}</strong>
              </div>
            </div>

            {environmentDeployments.length > 0 ? (
              <div className="base-urls-block">
                <span className="metric-label">Base URLs</span>
                <div className="env-url-list">
                  {environmentDeployments.map((ed) => (
                    <div key={ed.environment} className="env-url-row">
                      <span className="env-badge">{ed.environment}</span>
                      <code className="env-url">{ed.runtime_url}</code>
                      <CopyButton value={ed.runtime_url} defaultLabel="Copy" copiedLabel="Copied" />
                    </div>
                  ))}
                </div>
              </div>
            ) : entrypointUrl ? (
              <div className="base-urls-block">
                <span className="metric-label">Base URLs</span>
                <div className="env-url-list">
                  <div className="env-url-row">
                    <span className="env-badge">prod</span>
                    <code className="env-url">{entrypointUrl}</code>
                    <CopyButton value={entrypointUrl} defaultLabel="Copy" copiedLabel="Copied" />
                  </div>
                </div>
              </div>
            ) : (
              <div className="base-urls-block">
                <span className="metric-label">Base URLs</span>
                <span className="muted-copy">Available when the service is deployed.</span>
              </div>
            )}
          </div>

          <div className="detail-actions">
            <a className="secondary-action" href={postmanUrl} target="_blank" rel="noreferrer">
              Run in Postman
            </a>
            <button className="ghost-action" type="button" onClick={() => setIsModalOpen(true)}>
              Auto-Onboard in Postman
            </button>
          </div>
        </div>

        <section className="dependency-section">
          <div className="section-head">
            <div>
              <p className="eyebrow">Dependency Traversal</p>
              <h2>Upstream Dependencies</h2>
            </div>
            <span className="count-pill">{dependencies.upstream.length}</span>
          </div>
          <div className="dependency-list">
            {dependencies.upstream.length > 0 ? (
              dependencies.upstream.map((dependency) => (
                <DependencyCard key={`${dependency.edge_type}-${dependency.service_id}`} dependency={dependency} />
              ))
            ) : (
              <div className="empty-inline">No upstream dependencies for this service.</div>
            )}
          </div>
        </section>

        <section className="dependency-section">
          <div className="section-head">
            <div>
              <p className="eyebrow">Dependency Traversal</p>
              <h2>Downstream Consumers</h2>
            </div>
            <span className="count-pill">{dependencies.downstream.length}</span>
          </div>
          <div className="dependency-list">
            {dependencies.downstream.length > 0 ? (
              dependencies.downstream.map((dependency) => (
                <DependencyCard key={`${dependency.edge_type}-${dependency.service_id}`} dependency={dependency} />
              ))
            ) : (
              <div className="empty-inline">No downstream consumers are currently linked.</div>
            )}
          </div>
        </section>

        <section className="dependency-section">
          <div className="section-head">
            <div>
              <p className="eyebrow">Dependency Traversal</p>
              <h2>Runtime API Consumers</h2>
            </div>
            <span className="count-pill">{dependencies.consumes.length}</span>
          </div>
          <div className="dependency-list">
            {dependencies.consumes.length > 0 ? (
              dependencies.consumes.map((dependency) => (
                <DependencyCard key={`${dependency.edge_type}-${dependency.service_id}`} dependency={dependency} />
              ))
            ) : (
              <div className="empty-inline">No runtime API consumers are registered.</div>
            )}
          </div>
        </section>

        <section className="docs-embed-section">
          <div className="section-head">
            <div>
              <p className="eyebrow">API Reference</p>
              <h2>Documentation</h2>
            </div>
            <a className="secondary-action" href={docsUrl} target="_blank" rel="noreferrer">
              Open Full Docs
            </a>
          </div>
          <div className="docs-iframe-container">
            <iframe
              src={`${docsUrl}?embedded=true`}
              className="docs-iframe"
              title={`${service.title} API Documentation`}
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
            />
          </div>
        </section>
      </section>

      <div className={`modal ${isModalOpen ? "" : "hidden"}`} aria-hidden={isModalOpen ? "false" : "true"}>
        <button
          className="modal-backdrop"
          type="button"
          onClick={() => setIsModalOpen(false)}
          aria-label="Close dialog backdrop"
        />
        <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="agent-modal-title">
          <button className="modal-close" type="button" onClick={() => setIsModalOpen(false)} aria-label="Close">
            x
          </button>
          <p className="eyebrow">Auto-Onboard in Postman</p>
          <h3 id="agent-modal-title">{service.title}</h3>
          <p className="modal-copy">
            Copy this prompt into Postman Agent Mode to auto-onboard this API -- it will import the spec, configure auth, wire dependencies, and build a working collection.
          </p>
          <textarea className="prompt-box" value={promptValue} readOnly />
          <div className="modal-actions">
            <CopyButton value={promptValue} defaultLabel="Copy Prompt" copiedLabel="Copied" />
            <button className="secondary-action" type="button" onClick={() => setIsModalOpen(false)}>
              Close
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
