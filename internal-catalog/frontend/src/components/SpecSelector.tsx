import { type CSSProperties, useMemo, useState } from "react";
import registry from "../../../specs/registry.json";
import { domainBackground, domainColor } from "../lib/domain-colors";
import type { RegistryEntry } from "../lib/types";
import { DomainPill } from "./DomainPill";
import { SelectDropdown } from "./SelectDropdown";

export type { RegistryEntry } from "../lib/types";

interface SpecSelectorProps {
  industry: string;
  deployedSpecIds: Set<string>;
  selectedIds: Set<string>;
  onToggleSelect: (spec: RegistryEntry) => void;
  onSelectVisible: (specs: RegistryEntry[]) => void;
  onClearSelection: () => void;
  selectionMode?: "multi" | "single";
  disabled?: boolean;
}

export function SpecSelector({
  industry,
  deployedSpecIds,
  selectedIds,
  onToggleSelect,
  onSelectVisible,
  onClearSelection,
  selectionMode = "multi",
  disabled = false,
}: SpecSelectorProps) {
  const [search, setSearch] = useState("");
  const [domainFilter, setDomainFilter] = useState<string>("all");

  const specs = registry as RegistryEntry[];

  const industrySpecs = useMemo(
    () => specs.filter((s) => s.industry === industry),
    [industry],
  );

  const domains = useMemo(() => {
    const set = new Set(industrySpecs.map((s) => s.domain));
    return [...set].sort();
  }, [industrySpecs]);

  const domainCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const spec of industrySpecs) {
      counts.set(spec.domain, (counts.get(spec.domain) ?? 0) + 1);
    }
    return counts;
  }, [industrySpecs]);

  const domainOptions = useMemo(
    () => [
      { value: "all", label: `All domains (${industrySpecs.length})` },
      ...domains.map((domain) => ({
        value: domain,
        label: `${domain} (${domainCounts.get(domain) ?? 0})`,
      })),
    ],
    [domainCounts, domains, industrySpecs.length],
  );

  const filtered = useMemo(() => {
    return industrySpecs.filter((s) => {
      if (domainFilter !== "all" && s.domain !== domainFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q);
      }
      return true;
    });
  }, [industrySpecs, search, domainFilter]);

  const selectableVisible = useMemo(
    () => filtered.filter((spec) => !deployedSpecIds.has(spec.id)),
    [filtered, deployedSpecIds]
  );

  const selectedVisibleCount = useMemo(
    () => selectableVisible.filter((spec) => selectedIds.has(spec.id)).length,
    [selectableVisible, selectedIds]
  );

  const grouped = useMemo(() => {
    const map = new Map<string, RegistryEntry[]>();
    for (const spec of filtered) {
      const list = map.get(spec.domain) || [];
      list.push(spec);
      map.set(spec.domain, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <div className="spec-selector">
      <div className="spec-selector-controls">
        <input
          className="form-input spec-search"
          type="text"
          placeholder={selectionMode === "single" ? "Search for a root service..." : "Search specs..."}
          aria-label={selectionMode === "single" ? "Search for a root service" : "Search specs"}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={disabled}
        />
        <SelectDropdown
          value={domainFilter}
          options={domainOptions}
          onChange={setDomainFilter}
          disabled={disabled}
          ariaLabel="Filter by domain"
          triggerClassName="form-input select-dropdown-trigger spec-domain-filter"
        />
      </div>

      <div className="spec-selector-toolbar">
        <div className="spec-selector-selection-actions">
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={() => onSelectVisible(selectableVisible)}
            disabled={disabled || selectionMode === "single" || selectableVisible.length === 0}
          >
            Select visible
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={onClearSelection}
            disabled={disabled || selectedIds.size === 0}
          >
            Clear
          </button>
        </div>
        <span className="spec-selector-selection-count">
          {selectionMode === "single" ? "Root service" : `${selectedIds.size} selected`}
          {selectableVisible.length > 0 && (
            <>
              {" "}
              {selectionMode === "single"
                ? `(${selectedIds.size === 1 ? "1 chosen" : "choose 1"} from ${selectableVisible.length} visible)`
                : `(${selectedVisibleCount}/${selectableVisible.length} visible)`}
            </>
          )}
        </span>
      </div>

      <div className="spec-list">
        {grouped.length === 0 && (
          <div className="empty spec-selector-empty">No specs match your search.</div>
        )}
        {grouped.map(([domain, domainSpecs]) => (
          <div key={domain} className="spec-domain-group">
            <div className="spec-domain-header">
              <DomainPill
                value={domain}
                
                style={{ "--domain-bg": domainBackground(domain), "--domain-fg": domainColor(domain) } as CSSProperties}
              />
              <span className="spec-domain-count">{domainSpecs.length} specs</span>
            </div>
            {domainSpecs.map((spec) => {
              const isDeployed = deployedSpecIds.has(spec.id);
              const isSelected = selectedIds.has(spec.id);
              const rowDisabled = disabled || isDeployed;
              return (
                <div
                  key={spec.id}
                  className={`spec-item ${isSelected ? "spec-item-selected" : ""} ${isDeployed ? "spec-item-deployed" : ""}`}
                >
                  {selectionMode !== "single" && (
                    <input
                      className="spec-item-checkbox"
                      type="checkbox"
                      checked={isSelected}
                      disabled={rowDisabled}
                      onChange={() => onToggleSelect(spec)}
                      aria-label={`Select ${spec.title}`}
                    />
                  )}
                  <button
                    type="button"
                    className="spec-item-content"
                    onClick={() => onToggleSelect(spec)}
                    disabled={rowDisabled}
                    aria-label={selectionMode === "single" ? `Choose root service ${spec.title}` : undefined}
                  >
                    <div className="spec-item-top">
                      <span className="spec-item-title">{spec.title}</span>
                      <div className="spec-item-badges">
                        {isDeployed && <span className="deployed-badge">Deployed</span>}
                        {selectionMode === "single" && isSelected && <span className="root-badge">Root target</span>}
                      </div>
                    </div>
                    <div className="spec-item-meta">
                      <span>{spec.endpoints} endpoints</span>
                      <span className="mono">{spec.repo_name}</span>
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
