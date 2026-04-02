export interface IndustryConfig {
  id: string;
  label: string;
  description: string;
}

export const INDUSTRIES: IndustryConfig[] = [
  {
    id: "financial",
    label: "Financial Services",
    description: "Banking, payments, lending, insurance, and investment APIs",
  },
  {
    id: "vehicle",
    label: "Vehicle & Automotive",
    description: "Fleet management, telematics, and connected vehicle APIs",
  },
  {
    id: "telecom",
    label: "Telecommunications",
    description: "Network, messaging, and subscriber management APIs",
  },
];
