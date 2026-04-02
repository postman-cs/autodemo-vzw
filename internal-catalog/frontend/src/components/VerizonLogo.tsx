interface VerizonLogoProps {
  size?: number;
  className?: string;
}

export function VerizonLogo({ size = 24, className }: VerizonLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M22.5 2L9.75 22l-4.5-8.5L8.25 13l1.5 2.85L19.5 2h3z"
        fill="#ee0000"
      />
    </svg>
  );
}
