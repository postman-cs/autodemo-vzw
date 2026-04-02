interface SelectionCountBadgeProps {
  count: number;
}

export function SelectionCountBadge({ count }: SelectionCountBadgeProps) {
  return (
    <span className="services-bulk-selection-indicator">
      <svg className="services-bulk-selection-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="3" width="7" height="1.5" rx="0.75" fill="currentColor" />
        <rect x="2" y="7" width="9" height="1.5" rx="0.75" fill="currentColor" />
        <rect x="2" y="11" width="5" height="1.5" rx="0.75" fill="currentColor" />
        <path d="M10.25 10.25 11.75 11.75 14 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="services-bulk-selection-copy">{count} selected</span>
    </span>
  );
}
