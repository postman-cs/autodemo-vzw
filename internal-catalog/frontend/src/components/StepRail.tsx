import { ReactNode } from "react";

export type ProvisionStepStatus = "complete" | "current" | "upcoming";

export interface StepRailItem {
  id: string;
  label: string;
  summary?: ReactNode;
  statusIcons?: ReactNode[];
  status: ProvisionStepStatus;
}

interface StepRailProps {
  steps: StepRailItem[];
  activeStep: string;
  onStepChange: (stepId: string) => void;
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
  );
}

function stepMarker(step: StepRailItem, index: number): ReactNode {
  if (step.status === "complete") return <CheckIcon />;
  return String(index + 1);
}

/**
 * A container for metadata badges in a StepRailItem summary
 */
export function StepRailMetadata({ children }: { children: ReactNode }) {
  return <div className="step-rail-meta">{children}</div>;
}

interface MetaItemProps {
  label: string;
  value: string | number;
  status?: "neutral" | "warning" | "error" | "success";
}

/**
 * A single metadata badge with optional status coloring
 */
export function StepRailMetaItem({ label, value, status = "neutral" }: MetaItemProps) {
  return (
    <span className={`step-rail-meta-item step-rail-meta-item--${status}`}>
      <span className="step-rail-meta-value">{value}</span>
      <span className="step-rail-meta-label">{label}</span>
    </span>
  );
}

export function StepRail({ steps, activeStep, onStepChange }: StepRailProps) {
  return (
    <nav className="step-rail" aria-label="Provision steps">
      <ol className="step-rail-list">
        {steps.map((step, index) => {
          const isActive = step.id === activeStep;

          const isLast = index === steps.length - 1;
          const isLineActive = step.status === "complete";

          return (
            <li key={step.id} className={`step-rail-item step-rail-item--${step.status}${isActive ? " is-active" : ""}`}>
              <button
                type="button"
                className="step-rail-button group"
                onClick={() => onStepChange(step.id)}
                aria-current={isActive ? "step" : undefined}
                data-step-id={step.id}
              >
                <div className="step-rail-indicator-col">
                  <span className="step-rail-marker" aria-hidden="true">
                    {stepMarker(step, index)}
                  </span>
                  {!isLast && (
                    <div className={`step-rail-connector ${isLineActive ? "step-rail-connector--active" : ""}`}></div>
                  )}
                </div>
                
                <div className="step-rail-content">
                  <div className="step-rail-header">
                    <span className="step-rail-label">{step.label}</span>
                    {step.statusIcons && step.statusIcons.length > 0 && (
                      <div className="step-rail-status-icons">
                        {step.statusIcons.map((icon, i) => (
                          <span key={`icon-${i}`} className="step-rail-status-icon">
                            {icon}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {step.summary ? <div className="step-rail-summary">{step.summary}</div> : null}
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
