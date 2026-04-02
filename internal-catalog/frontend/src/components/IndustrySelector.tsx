import { useMemo } from "react";
import { INDUSTRIES } from "../lib/industries";
import registry from "../../../specs/registry.json";
import type { RegistryEntry } from "../lib/types";

interface IndustrySelectorProps {
  selectedIndustry: string;
  onSelect: (industryId: string) => void;
  disabled?: boolean;
}

export function IndustrySelector({
  selectedIndustry,
  onSelect,
  disabled = false,
}: IndustrySelectorProps) {
  const specs = registry as RegistryEntry[];

  const countByIndustry = useMemo(() => {
    const map = new Map<string, number>();
    for (const spec of specs) {
      map.set(spec.industry, (map.get(spec.industry) || 0) + 1);
    }
    return map;
  }, [specs]);

  return (
    <div className="industry-selector">
      <div className="industry-selector-cards">
        {INDUSTRIES.map((industry) => {
          const count = countByIndustry.get(industry.id) || 0;
          const isActive = selectedIndustry === industry.id;
          const hasSpecs = count > 0;

          return (
            <button
              key={industry.id}
              type="button"
              className={`industry-card ${isActive ? "industry-card-active" : ""} ${!hasSpecs ? "industry-card-empty" : ""}`}
              onClick={() => onSelect(industry.id)}
              disabled={disabled}
              aria-pressed={isActive}
            >
              <div className="industry-card-header">
                <span className="industry-card-label">{industry.label}</span>
                {!hasSpecs && (
                  <span className="industry-card-badge">Coming soon</span>
                )}
              </div>
              <span className="industry-card-desc">{industry.description}</span>
              {hasSpecs && (
                <span className="industry-card-count">{count} APIs</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
