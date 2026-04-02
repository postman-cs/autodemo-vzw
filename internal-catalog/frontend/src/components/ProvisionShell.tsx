import { StepRail, type StepRailItem } from "./StepRail";

interface ProvisionShellProps {
  steps: StepRailItem[];
  activeStep: string;
  onStepChange: (stepId: string) => void;
  children: React.ReactNode;
  nextStepId?: string;
  nextStepLabel?: string;
}

export function ProvisionShell({
  steps,
  activeStep,
  onStepChange,
  children,
  nextStepId,
  nextStepLabel,
}: ProvisionShellProps) {
  return (
    <section className="provision-shell" data-provision-shell>
      <aside className="provision-shell-rail card">
        <StepRail steps={steps} activeStep={activeStep} onStepChange={onStepChange} />
      </aside>

      <div className="provision-shell-content card">
        {children}
        {nextStepId && nextStepLabel ? (
          <div className="provision-shell-footer">
            <button
              type="button"
              className="btn btn-primary provision-shell-next"
              onClick={() => onStepChange(nextStepId)}
              data-provision-next-step
            >
              Continue to {nextStepLabel}
              <span aria-hidden="true">→</span>
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
