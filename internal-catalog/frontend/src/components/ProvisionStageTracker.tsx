interface Stage {
  key: string;
  label: string;
  status: "completed" | "current" | "upcoming" | "disabled";
}

interface ProvisionStageTrackerProps {
  stages: Stage[];
}

export function ProvisionStageTracker({ stages }: ProvisionStageTrackerProps) {
  return (
    <nav className="provision-stage-tracker" aria-label="Provisioning steps">
      <ol className="provision-stage-list">
        {stages.map((stage, i) => (
          <li key={stage.key} className={`provision-stage provision-stage--${stage.status}`}>
            <span className="provision-stage-number" aria-hidden="true">{i + 1}</span>
            <span className="provision-stage-label">{stage.label}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
