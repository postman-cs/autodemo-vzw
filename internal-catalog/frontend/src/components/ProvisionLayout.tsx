import { useState, type ReactNode } from "react";
import { Outlet } from "react-router-dom";

export interface ProvisionLayoutContext {
  setHeaderStrip: (node: ReactNode) => void;
}

export function ProvisionLayout() {
  const [stripContent, setHeaderStrip] = useState<ReactNode>(null);

  return (
    <div className="provision-layout">
      <div className="main-header-strip">{stripContent}</div>
      <div className="main-content">
        <Outlet context={{ setHeaderStrip } satisfies ProvisionLayoutContext} />
      </div>
    </div>
  );
}
