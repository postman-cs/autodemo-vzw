export function DependencyGroup({
  title,
  countField,
  listField,
}: {
  title: string;
  countField: string;
  listField: string;
}) {
  return (
    <div className="vzw-deps-group">
      <div className="vzw-deps-header">
        <div>
          <span className="vzw-eyebrow">Dependency Traversal</span>
          <h2>{title}</h2>
        </div>
        <span className="vzw-count-pill" data-field={countField}>--</span>
      </div>
      <div className="vzw-deps-list" data-field={listField}>
        <span className="vzw-muted">Loading...</span>
      </div>
    </div>
  );
}
