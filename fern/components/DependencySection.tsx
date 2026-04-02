import { DependencyGroup } from "./DependencyGroup";

export function DependencySection() {
  return (
    <div className="vzw-deps-section">
      <DependencyGroup
        title="Upstream Dependencies"
        countField="upstream-count"
        listField="upstream-list"
      />
      <DependencyGroup
        title="Downstream Consumers"
        countField="downstream-count"
        listField="downstream-list"
      />
      <DependencyGroup
        title="Runtime API Consumers"
        countField="consumes-count"
        listField="consumes-list"
      />
    </div>
  );
}
