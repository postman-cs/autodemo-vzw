import type { CSSProperties } from "react";
import { Tooltip } from "./Tooltip";

interface DomainPillProps {
  value: string;
  tone?: "domain" | "team";
  style?: CSSProperties;
  tooltip?: string;
}

export function DomainPill({ value, tone = "domain", style, tooltip }: DomainPillProps) {
  const className = tone === "team" ? "domain-pill domain-pill--team" : "domain-pill";

  if (tooltip) {
    return (
      <Tooltip content={tooltip} position="top">
        <span className={className} style={style}>
          <span className="domain-pill-label">{value}</span>
        </span>
      </Tooltip>
    );
  }

  return (
    <span className={className} style={style}>
      <span className="domain-pill-label">{value}</span>
    </span>
  );
}
