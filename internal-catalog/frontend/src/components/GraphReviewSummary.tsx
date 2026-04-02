interface GraphReviewSummaryProps {
  provision: number;
  reuse: number;
  attach: number;
  blocked: number;
  total: number;
}

export function GraphReviewSummary({ provision, reuse, attach, blocked, total }: GraphReviewSummaryProps) {
  return (
    <div className="graph-review-summary">
      <div className="graph-review-stat-row">
        <span className="graph-review-chip graph-review-chip--provision">
          <span className="graph-review-chip-count">{provision}</span> provision
        </span>
        <span className="graph-review-chip graph-review-chip--reuse">
          <span className="graph-review-chip-count">{reuse}</span> reuse
        </span>
        <span className="graph-review-chip graph-review-chip--attach">
          <span className="graph-review-chip-count">{attach}</span> attach
        </span>
        {blocked > 0 && (
          <span className="graph-review-chip graph-review-chip--blocked">
            <span className="graph-review-chip-count">{blocked}</span> blocked
          </span>
        )}
        <span className="graph-review-chip graph-review-chip--total">
          <span className="graph-review-chip-count">{total}</span> total
        </span>
      </div>
    </div>
  );
}
