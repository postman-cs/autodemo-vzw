import type { ReactElement } from "react";

interface SkeletonProps {
  variant?: "text" | "rect" | "circle" | "table-row";
  width?: string;
  height?: string;
  className?: string;
  count?: number;
  columns?: number;
}

function SkeletonItem({ variant = "text", width, height, className }: Omit<SkeletonProps, "count" | "columns">): ReactElement {
  const classes = [
    "skeleton",
    `skeleton--${variant}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const style: Record<string, string> = {};
  if (width) style.width = width;
  if (height) style.height = height;

  return <span className={classes} style={Object.keys(style).length > 0 ? style : undefined} aria-hidden="true" />;
}

function SkeletonTableRow({ columns = 5, rowIndex }: { columns?: number; rowIndex: number }): ReactElement {
  const colKeys = Array.from({ length: columns }, (_, n) => `col-${rowIndex}-${n}`);
  return (
    <tr className="skeleton-table-row">
      {colKeys.map((colKey) => (
        <td key={colKey} className="skeleton-table-cell">
          <span className="skeleton skeleton--text" aria-hidden="true" />
        </td>
      ))}
    </tr>
  );
}

export function Skeleton({ variant = "text", width, height, className, count = 1, columns }: SkeletonProps): ReactElement {
  if (variant === "table-row") {
    const rowKeys = Array.from({ length: count }, (_, n) => `skeleton-row-${n}`);
    return (
      <>
        {rowKeys.map((rowKey, n) => (
          <SkeletonTableRow key={rowKey} columns={columns} rowIndex={n} />
        ))}
      </>
    );
  }

  if (count > 1) {
    return (
      <span className="skeleton-group">
        {Array.from({ length: count }, (_, i) => {
          const key = `skeleton-${variant}-${i}`;
          return <SkeletonItem key={key} variant={variant} width={width} height={height} className={className} />;
        })}
      </span>
    );
  }

  return <SkeletonItem variant={variant} width={width} height={height} className={className} />;
}
