interface PageHeaderProps {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="page-header">
      <h1>{title}</h1>
      {description && <div className="page-description">{description}</div>}
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}
