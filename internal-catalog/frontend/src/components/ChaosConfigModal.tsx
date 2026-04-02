import React, { useState } from 'react';
import { Modal } from './Modal';

export interface TierConfig {
  error_rate: number;
  status_code: number;
  latency_rate: number;
  latency_ms: number;
  timeout_rate: number;
}

export type ChaosConfigObj = Record<string, TierConfig>;

interface ChaosConfigModalProps {
  initialConfig: string;
  onSave: (config: string) => void;
  onClose: () => void;
}

const DEFAULT_CONFIG: ChaosConfigObj = {
  prod:    { error_rate: 0,    status_code: 503, latency_rate: 0.05, latency_ms: 1500, timeout_rate: 0 },
  stage:   { error_rate: 0.20, status_code: 503, latency_rate: 0.05, latency_ms: 1000, timeout_rate: 0 },
  dev:     { error_rate: 0.50, status_code: 500, latency_rate: 0.10, latency_ms: 1000, timeout_rate: 0.02 },
  default: { error_rate: 0.20, status_code: 503, latency_rate: 0,    latency_ms: 1000, timeout_rate: 0 },
};

export function ChaosConfigModal({ initialConfig, onSave, onClose }: ChaosConfigModalProps) {
  const [config, setConfig] = useState<ChaosConfigObj>(() => {
    if (!initialConfig.trim()) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    try {
      const parsed = JSON.parse(initialConfig);
      // Basic validation to ensure it's an object of objects
      if (typeof parsed === 'object' && parsed !== null) {
        // Merge with defaults to ensure all tiers exist
        return { ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)), ...parsed };
      }
    } catch (e) {
      console.warn("Failed to parse initial chaos config", e);
    }
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  });

  const [activeTier, setActiveTier] = useState<string>("prod");
  const tiers = ["prod", "stage", "dev", "default"];

  const updateTier = (tier: string, updates: Partial<TierConfig>) => {
    setConfig(prev => ({
      ...prev,
      [tier]: {
        ...prev[tier],
        ...updates
      }
    }));
  };

  const handleSave = () => {
    onSave(JSON.stringify(config, null, 2));
    onClose();
  };

  const currentTierConfig = config[activeTier] || DEFAULT_CONFIG[activeTier];

  return (
    <Modal open={true} onClose={onClose} className="chaos-config-modal-panel">
      <Modal.Header title="Configure fault injection profiles" subtitle="Adjust fault injection settings per environment tier." />
      <Modal.Body className="chaos-config-modal-body">
          <div
            className="chaos-tier-tabs"
            role="tablist"
            aria-label="Fault profile tiers"
            onKeyDown={(e) => {
              const tabs = tiers;
              const currentIdx = tabs.indexOf(activeTier);
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                const next = tabs[(currentIdx + 1) % tabs.length];
                setActiveTier(next);
                (e.currentTarget.querySelector(`[data-tier="${next}"]`) as HTMLElement | null)?.focus();
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                const next = tabs[(currentIdx - 1 + tabs.length) % tabs.length];
                setActiveTier(next);
                (e.currentTarget.querySelector(`[data-tier="${next}"]`) as HTMLElement | null)?.focus();
              } else if (e.key === "Home") {
                e.preventDefault();
                setActiveTier(tabs[0]);
                (e.currentTarget.querySelector(`[data-tier="${tabs[0]}"]`) as HTMLElement | null)?.focus();
              } else if (e.key === "End") {
                e.preventDefault();
                setActiveTier(tabs[tabs.length - 1]);
                (e.currentTarget.querySelector(`[data-tier="${tabs[tabs.length - 1]}"]`) as HTMLElement | null)?.focus();
              }
            }}
          >
            {tiers.map(tier => (
              <button
                key={tier}
                type="button"
                role="tab"
                data-tier={tier}
                aria-selected={activeTier === tier}
                tabIndex={activeTier === tier ? 0 : -1}
                onClick={() => setActiveTier(tier)}
                className={`chaos-tier-tab${activeTier === tier ? ' chaos-tier-tab-active' : ''}`}
              >
                {tier.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="chaos-config-form">
            <div className="chaos-fault-section">
              <div className="chaos-fault-section-header">
                <span className="chaos-fault-section-title">HTTP Error</span>
                <span className="chaos-config-helper">Returns an immediate HTTP error response.</span>
              </div>
              <div className="chaos-config-field">
                <div className="chaos-config-slider-row">
                  <label className="chaos-config-label">Error Rate</label>
                  <span className="chaos-config-slider-value">
                    {Math.round((currentTierConfig.error_rate || 0) * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0" max="1" step="0.01"
                  className="chaos-config-slider"
                  value={currentTierConfig.error_rate || 0}
                  onChange={e => updateTier(activeTier, { error_rate: parseFloat(e.target.value) })}
                />
                <div className="chaos-config-slider-meta">
                  <span>0% (Off)</span>
                  <span>100%</span>
                </div>
              </div>
              <div className="chaos-config-field">
                <label className="chaos-config-label">Status Code</label>
                <input
                  type="number"
                  className="form-input chaos-config-input-control"
                  min="400" max="599"
                  value={currentTierConfig.status_code || 503}
                  onChange={e => updateTier(activeTier, { status_code: parseInt(e.target.value, 10) })}
                />
              </div>
            </div>

            <div className="chaos-fault-section">
              <div className="chaos-fault-section-header">
                <span className="chaos-fault-section-title">Latency</span>
                <span className="chaos-config-helper">Adds artificial delay before processing the request normally.</span>
              </div>
              <div className="chaos-config-field">
                <div className="chaos-config-slider-row">
                  <label className="chaos-config-label">Latency Rate</label>
                  <span className="chaos-config-slider-value">
                    {Math.round((currentTierConfig.latency_rate || 0) * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0" max="1" step="0.01"
                  className="chaos-config-slider"
                  value={currentTierConfig.latency_rate || 0}
                  onChange={e => updateTier(activeTier, { latency_rate: parseFloat(e.target.value) })}
                />
                <div className="chaos-config-slider-meta">
                  <span>0% (Off)</span>
                  <span>100%</span>
                </div>
              </div>
              <div className="chaos-config-field">
                <label className="chaos-config-label">Delay (ms)</label>
                <input
                  type="number"
                  className="form-input chaos-config-input-control"
                  min="100" max="30000" step="100"
                  value={currentTierConfig.latency_ms || 1000}
                  onChange={e => updateTier(activeTier, { latency_ms: parseInt(e.target.value, 10) })}
                />
              </div>
            </div>

            <div className="chaos-fault-section">
              <div className="chaos-fault-section-header">
                <span className="chaos-fault-section-title">Timeout</span>
                <span className="chaos-config-helper">Hangs the request for 30s then returns 504 Gateway Timeout.</span>
              </div>
              <div className="chaos-config-field">
                <div className="chaos-config-slider-row">
                  <label className="chaos-config-label">Timeout Rate</label>
                  <span className="chaos-config-slider-value">
                    {Math.round((currentTierConfig.timeout_rate || 0) * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0" max="1" step="0.01"
                  className="chaos-config-slider"
                  value={currentTierConfig.timeout_rate || 0}
                  onChange={e => updateTier(activeTier, { timeout_rate: parseFloat(e.target.value) })}
                />
                <div className="chaos-config-slider-meta">
                  <span>0% (Off)</span>
                  <span>100%</span>
                </div>
              </div>
            </div>

            {activeTier === 'prod' && (
              <p className="chaos-config-prod-note">
                Production defaults are intentionally conservative. Validate fault rates before saving a production profile.
              </p>
            )}
          </div>
      </Modal.Body>

      <Modal.Footer className="chaos-config-modal-footer">
        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={handleSave}>Save Configuration</button>
      </Modal.Footer>
    </Modal>
  );
}