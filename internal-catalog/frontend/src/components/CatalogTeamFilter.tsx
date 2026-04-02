import type { TeamRegistryEntry } from "../lib/types";
import { SelectDropdown } from "./SelectDropdown";

interface CatalogTeamFilterProps {
  teams: TeamRegistryEntry[];
  selectedTeamSlug: string;
  onChange: (teamSlug: string) => void;
}

export function CatalogTeamFilter({
  teams,
  selectedTeamSlug,
  onChange,
}: CatalogTeamFilterProps) {
  if (teams.length === 0) return null;

  const labelId = "catalog-team-selector-label";
  const options = [
    { value: "", label: "All teams" },
    ...teams.map((team) => ({
      value: team.slug,
      label: team.team_name,
    })),
  ];

  return (
    <div className="catalog-header-tools">
      <div className="catalog-header-filter">
        <span id={labelId} className="catalog-header-filter-label">Postman Team</span>
        <SelectDropdown
          id="catalog-team-selector"
          value={selectedTeamSlug}
          options={options}
          onChange={onChange}
          labelId={labelId}
          triggerClassName="form-input select-dropdown-trigger catalog-header-filter-select"
        />
      </div>
    </div>
  );
}
