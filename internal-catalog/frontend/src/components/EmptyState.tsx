import { StatusCard } from "./StatusCard";

interface EmptyStateProps {
  title?: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({
  title = "Nothing here yet",
  description,
  action,
}: EmptyStateProps) {
  return (
    <StatusCard
      variant="empty"
      title={title}
      description={description}
      action={action}
    />
  );
}
