import { type RefObject } from "react";
import { Modal } from "./Modal";
import { Skeleton } from "./Skeleton";
import { runtimeLabel, type ResourceInventory } from "../lib/types";

interface ResourceModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  loading: boolean;
  error: string;
  data: ResourceInventory | null;
  showEnvironmentColumn?: boolean;
  emptyMessage?: string;
  closeButtonRef?: RefObject<HTMLButtonElement | null>;
}

export function ResourceModal({
  open,
  onClose,
  title,
  subtitle,
  loading,
  error,
  data,
  showEnvironmentColumn = false,
  emptyMessage = "No resources are currently recorded for this service.",
  closeButtonRef,
}: ResourceModalProps) {
  return (
    <Modal open={open} onClose={onClose} className="resource-modal-panel">
      <Modal.Header title={title} subtitle={subtitle} />
      {data && !loading && !error && (
        <div className="resource-modal-meta">
          <span>Runtime: {runtimeLabel(data.runtime_mode)}</span>
          <span>Source: {data.source}</span>
          {data.status && <span>Status: {data.status}</span>}
        </div>
      )}
      <Modal.Body>
        {loading && (
          <div className="resource-modal-state" aria-live="polite">
            <Skeleton variant="text" count={4} />
          </div>
        )}
        {!loading && error && (
          <p className="resource-modal-state resource-modal-state-error">{error}</p>
        )}
        {!loading && !error && data && data.resources.length === 0 && (
          <p className="resource-modal-state">{emptyMessage}</p>
        )}
        {!loading && !error && data && data.resources.length > 0 && (
          <div className="resource-table-wrap">
            <table className="resource-table">
              <caption className="sr-only">Resource inventory</caption>
              <thead>
                <tr>
                  {showEnvironmentColumn && <th>Environment</th>}
                  <th>Kind</th>
                  <th>Name</th>
                  <th>ID</th>
                  <th>ARN</th>
                  <th>Region</th>
                  <th>URL</th>
                </tr>
              </thead>
              <tbody>
                {data.resources.map((resource, index) => (
                  <tr key={`${resource.kind}-${resource.name}-${index}`}>
                    {showEnvironmentColumn && (
                      <td>{String(resource.metadata?.environment || "").trim() || "-"}</td>
                    )}
                    <td>{resource.kind}</td>
                    <td>{resource.name}</td>
                    <td>{resource.id || "-"}</td>
                    <td className="resource-cell-arn" title={resource.arn || ""}>{resource.arn || "-"}</td>
                    <td>{resource.region || "-"}</td>
                    <td>
                      {resource.url
                        ? <a href={resource.url} target="_blank" rel="noopener noreferrer" className="link">Open</a>
                        : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <button
          ref={closeButtonRef}
          type="button"
          className="btn btn-secondary"
          onClick={onClose}
        >
          Close
        </button>
      </Modal.Footer>
    </Modal>
  );
}
