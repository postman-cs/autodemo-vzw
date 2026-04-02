import type { BatchRunState } from "../lib/types";
import type { RunUnit } from "../lib/provision-progress";

interface ProvisionLinks {
  repoUrl?: string;
  workspaceUrl?: string;
  invokeUrl?: string;
}

interface GraphBoardCounts {
  completed: number;
  reused: number;
  attached: number;
  provisioned: number;
  failed: number;
  running: number;
}

interface ExecutionTakeoverProps {
  renderedBoardMode: "single" | "graph";
  batchRun: BatchRunState;
  runUnits: RunUnit[];
  totalCount: number;
  canReset: boolean;
  onReset: () => void;
  graphBoardCounts?: GraphBoardCounts;
  graphDeploymentGroupId?: string;
  graphRootSpecId?: string;
  graphError?: string;
}

interface ExecutionTakeoverStateInput {
  batchRunning: boolean;
  renderedBoardMode: "single" | "graph";
  graphBoardNodeCount: number;
  orderedItemCount: number;
}

export function shouldShowExecutionTakeover({
  batchRunning,
  renderedBoardMode,
  graphBoardNodeCount,
  orderedItemCount,
}: ExecutionTakeoverStateInput): boolean {
  return batchRunning || (renderedBoardMode === "graph" ? graphBoardNodeCount : orderedItemCount) > 0;
}

function buildLinks(result?: Record<string, unknown>): ProvisionLinks {
  if (!result) return {};

  const github = typeof result.github === "object" && result.github !== null
    ? result.github as Record<string, unknown>
    : null;
  const postman = typeof result.postman === "object" && result.postman !== null
    ? result.postman as Record<string, unknown>
    : null;
  const aws = typeof result.aws === "object" && result.aws !== null
    ? result.aws as Record<string, unknown>
    : null;

  return {
    repoUrl: typeof github?.repo_url === "string" ? github.repo_url : undefined,
    workspaceUrl: typeof postman?.workspace_url === "string" ? postman.workspace_url : undefined,
    invokeUrl: typeof aws?.invoke_url === "string" ? aws.invoke_url : undefined,
  };
}

export function ExecutionTakeover({
  renderedBoardMode,
  batchRun,
  runUnits,
  totalCount,
  canReset,
  onReset,
  graphBoardCounts,
  graphDeploymentGroupId,
  graphRootSpecId,
  graphError,
}: ExecutionTakeoverProps) {
  const isGraph = renderedBoardMode === "graph";
  const completionLabel = isGraph
    ? `${graphBoardCounts?.completed ?? 0}/${totalCount} complete`
    : `${batchRun.completed}/${batchRun.total || totalCount} complete`;
  const eyebrow = batchRun.running ? "Execution takeover" : "Execution summary";
  const subtitle = batchRun.running
    ? "The setup shell is hidden while this provisioning run is actively reporting status."
    : "The latest provisioning results stay visible until you reset the board and return to setup.";

  return (
    <section className="provision-execution-takeover" data-execution-takeover>
      <div className="provision-execution-header card">
        <div className="provision-execution-copy">
          <p className="provision-execution-kicker">{eyebrow}</p>
          <h2 className="provision-execution-title">Provisioning Progress</h2>
          <p className="provision-execution-subtitle">{subtitle}</p>
        </div>
        <div className="provision-execution-actions">
          <span className="provision-execution-meta">{completionLabel}</span>
          {canReset ? (
            <button type="button" className="btn btn-secondary" onClick={onReset}>
              Return to setup
            </button>
          ) : null}
        </div>
      </div>

      <div className="card provision-board animate-fade-in-up">
        <div className="provision-board-header">
          <div className="provision-board-heading">
            <h3>{isGraph ? "Graph Provisioning Progress" : "Provisioning Progress"}</h3>
            {isGraph && graphDeploymentGroupId && (
              <span className="provision-board-group mono">{graphDeploymentGroupId}</span>
            )}
          </div>
          <span>{completionLabel}</span>
        </div>
        {isGraph && (
          <div className="provision-board-graph-meta">
            {(graphBoardCounts?.reused ?? 0) > 0 && (
              <span className="provision-board-stat-chip provision-board-stat-chip--reused">
                <span className="provision-board-stat-dot" />
                Reused <strong>{graphBoardCounts?.reused}</strong>
              </span>
            )}
            {(graphBoardCounts?.attached ?? 0) > 0 && (
              <span className="provision-board-stat-chip provision-board-stat-chip--attached">
                <span className="provision-board-stat-dot" />
                Attached <strong>{graphBoardCounts?.attached}</strong>
              </span>
            )}
            {(graphBoardCounts?.provisioned ?? 0) > 0 && (
              <span className="provision-board-stat-chip provision-board-stat-chip--provisioned">
                <span className="provision-board-stat-dot" />
                Provisioned <strong>{graphBoardCounts?.provisioned}</strong>
              </span>
            )}
            {(graphBoardCounts?.running ?? 0) > 0 && (
              <span className="provision-board-stat-chip provision-board-stat-chip--running">
                <span className="provision-board-stat-dot provision-board-stat-dot--pulse" />
                Running <strong>{graphBoardCounts?.running}</strong>
              </span>
            )}
            {(graphBoardCounts?.failed ?? 0) > 0 && (
              <span className="provision-board-stat-chip provision-board-stat-chip--failed">
                <span className="provision-board-stat-dot" />
                Failed <strong>{graphBoardCounts?.failed}</strong>
              </span>
            )}
            {graphRootSpecId && (
              <span className="provision-board-stat-chip provision-board-stat-chip--root">
                Root: <strong>{graphRootSpecId}</strong>
              </span>
            )}
          </div>
        )}
        {isGraph && graphError && (
          <p className="provision-board-graph-error">{graphError}</p>
        )}

        <div className="provision-board-list">
          {runUnits.map((item) => {
            const links = buildLinks(item.result);
            const key = item.environment ? `${item.id}-${item.environment}` : item.id;

            return (
              <div key={key} className="provision-board-row">
                <div className="provision-board-service">
                  <span className={`provision-board-status-dot ${item.cssClass}--dot`} aria-hidden="true" />
                  <div className="provision-board-service-text">
                    <strong>{item.displayName}</strong>
                    {item.environment && (
                      <span className="mono provision-board-service-env">{item.environment}</span>
                    )}
                  </div>
                </div>

                <div className="provision-board-status">
                  <span className={`status-badge ${item.cssClass}`}>{item.status}</span>
                </div>

                <div className="provision-board-message">
                  <span>{item.message}</span>
                  {item.runUrl && (
                    <a className="link provision-board-actions-link" href={item.runUrl} target="_blank" rel="noopener noreferrer">
                      Actions
                      <svg className="provision-board-ext-icon" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <path d="M2 10L10 2M10 2H5M10 2V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </a>
                  )}
                  {item.contextLabel && <span className="provision-board-phase">{item.contextLabel}</span>}
                  {(links.repoUrl || links.workspaceUrl || links.invokeUrl) && (
                    <div className="provision-board-links">
                      {links.repoUrl && (
                        <a className="link" href={links.repoUrl} target="_blank" rel="noopener noreferrer">GitHub</a>
                      )}
                      {links.workspaceUrl && (
                        <a className="link" href={links.workspaceUrl} target="_blank" rel="noopener noreferrer">Postman</a>
                      )}
                      {links.invokeUrl && (
                        <a className="link" href={`${links.invokeUrl.replace(/\/+$/, "")}/health`} target="_blank" rel="noopener noreferrer">AWS Health</a>
                      )}
                    </div>
                      )}
                  {item.error && <span className="provision-board-error">{item.error}</span>}
                  {!!item.result?.graph_node_status && <span className="provision-board-error">{String(item.result.graph_node_status)}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
