import { StatusCard } from "./StatusCard";

interface InProgressBarProps {
  title?: string;
  description?: string;
}

export function InProgressBar({
  title = "Operation in progress",
  description,
}: InProgressBarProps) {
  return (
    <StatusCard
      variant="in-progress"
      title={title}
      description={description}
    />
  );
}
