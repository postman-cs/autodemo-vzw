import { ReactNode } from "react";
import { Breadcrumbs } from "./Breadcrumbs";
import { PageHeader } from "./PageHeader";

interface PageLayoutProps {
  title: string;
  subtitle?: React.ReactNode;
  headerActions?: React.ReactNode;
  children: ReactNode;
  showBreadcrumbs?: boolean;
}

export function PageLayout({
  title,
  subtitle,
  headerActions,
  children,
  showBreadcrumbs = true,
}: PageLayoutProps) {
  return (
    <div className="page-layout">
      {showBreadcrumbs && <Breadcrumbs />}
      <PageHeader title={title} description={subtitle} actions={headerActions} />
      <div className="page-content">{children}</div>
    </div>
  );
}
