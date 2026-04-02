import React, { useMemo, useState } from 'react';
import { ChaosConfigModal } from './ChaosConfigModal';

interface ChaosConfigInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function ChaosConfigInput({ value, onChange, disabled }: ChaosConfigInputProps) {
  const [modalOpen, setModalOpen] = useState(false);

  const summary = useMemo(() => {
    if (!value) return "Using default fault profiles (for example: prod 5% latency, dev 50% error + 10% latency)";
    try {
      const parsed = JSON.parse(value);
      const keys = Object.keys(parsed);
      if (keys.length === 0) return "Custom (Empty)";
      return `Custom fault profile configured for ${keys.length} tier${keys.length === 1 ? '' : 's'}`;
    } catch {
      return "Invalid fault profile";
    }
  }, [value]);

  return (
    <div className="chaos-config-input">
      <div className="chaos-config-input-header">
        <div className="chaos-config-input-copy">
          <div className="chaos-config-input-label">Fault injection profile</div>
          <div className="chaos-config-input-desc">Review or edit the per-environment fault profile used when fault injection is enabled.</div>
        </div>
        <button
          type="button"
          className="btn btn-secondary chaos-config-input-button"
          disabled={disabled}
          onClick={() => setModalOpen(true)}
        >
          {value ? 'Edit fault profile' : 'Configure fault profile'}
        </button>
      </div>

      <div className="chaos-config-summary-row">
        <span className="chaos-config-summary-label">Current fault profile</span>
        <span className="chaos-config-input-summary">{summary}</span>
      </div>

      {modalOpen && (
        <ChaosConfigModal
          initialConfig={value}
          onSave={onChange}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}