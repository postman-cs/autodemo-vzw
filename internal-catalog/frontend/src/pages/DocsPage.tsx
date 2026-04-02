import { useEffect } from "react";
import { EmptyState } from "../components/EmptyState";

export function DocsPage() {
  useEffect(() => {
    document.title = "Documentation | API Catalog Admin";
  }, []);

  return (
    <EmptyState
      title="Documentation"
      description="API catalog documentation and discovery will appear here."
    />
  );
}
