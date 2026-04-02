import { TEARDOWN_PHASES, type TeardownProgress } from "../lib/teardown-progress";

export function TeardownStepTracker({ progress }: { progress: TeardownProgress }) {
  return (
    <div className="teardown-tracker">
      <div className="teardown-tracker-dots" role="progressbar" aria-valuenow={progress.stepIndex + 1} aria-valuemin={1} aria-valuemax={TEARDOWN_PHASES.length}>
        {TEARDOWN_PHASES.map((_, i) => (
          <span
            key={i}
            className={`teardown-dot ${
              i < progress.stepIndex ? "teardown-dot-done" :
              i === progress.stepIndex ? "teardown-dot-active" :
              "teardown-dot-pending"
            }`}
          />
        ))}
      </div>
      <span className="teardown-tracker-label">{progress.message}</span>
    </div>
  );
}
