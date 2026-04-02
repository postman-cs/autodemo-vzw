import { Link } from "react-router-dom";
import { formatRuntime, getRunInPostmanUrl } from "./api";
import type { DependencyService, ServiceSummary } from "./types";

export function VerizonCheckmark() {
  return (
    <svg className="portal-logo" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M22.5 2L9.75 22l-4.5-8.5L8.25 13l1.5 2.85L19.5 2h3z" fill="#cd040b" />
    </svg>
  );
}

export function RuntimeBadge({ runtime }: { runtime: string }) {
  return <span className="runtime-pill">{formatRuntime(runtime)}</span>;
}


export function ServiceCard({ service }: { service: ServiceSummary }) {
  const postmanUrl = getRunInPostmanUrl(service);

  return (
    <article className="service-card">


      <h3>{service.title}</h3>

      {service.description ? (
        <div style={{ marginTop: "-8px", marginBottom: "16px", color: "var(--text-secondary)", fontSize: "var(--text-md)", flexGrow: 1, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {service.description}
        </div>
      ) : null}

      <div className="actions">
        <Link className="primary-action" to={`/services/${service.service_id}`}>
          Documentation
        </Link>
        <a className="try-action" href={postmanUrl} target="_blank" rel="noreferrer">
          Try It
        </a>
      </div>
    </article>
  );
}

export function DependencyCard({ dependency }: { dependency: DependencyService }) {
  return (
    <Link className="dependency-card" to={`/services/${dependency.service_id}`}>
      <div>
        <div className="dependency-card-title">{dependency.title}</div>
        <div className="dependency-card-subtitle">{dependency.service_id}</div>
      </div>

      <div className="dependency-card-right">
        <span className={`edge-pill ${dependency.edge_type === "consumesApis" ? "is-consumes" : "is-depends"}`}>
          {dependency.edge_type === "consumesApis" ? "consumes" : "requires"}
        </span>
      </div>
    </Link>
  );
}

export function CopyButton({
  value,
  defaultLabel,
  copiedLabel,
}: {
  value: string;
  defaultLabel: string;
  copiedLabel: string;
}) {
  async function handleCopy(event: React.MouseEvent<HTMLButtonElement>) {
    const button = event.currentTarget;
    const originalText = defaultLabel;

    await navigator.clipboard.writeText(value);
    button.textContent = copiedLabel;

    window.setTimeout(() => {
      button.textContent = originalText;
    }, 1200);
  }

  return (
    <button className="secondary-action" type="button" onClick={handleCopy}>
      {defaultLabel}
    </button>
  );
}
