/** Canonical domain-to-color map. Single source of truth. */
export const DOMAIN_COLORS: Record<string, string> = {
  // Financial Services
  cards: "#e11d48",
  core: "#0284c7",
  credit: "#7c3aed",
  customer: "#059669",
  data: "#0891b2",
  digital: "#6366f1",
  docs: "#64748b",
  identity: "#d97706",
  insurance: "#be185d",
  invest: "#16a34a",
  lending: "#dc2626",
  merchant: "#9333ea",
  notify: "#ea580c",
  payments: "#2563eb",
  platform: "#475569",
  risk: "#b91c1c",
  treasury: "#0d9488",
  // Vehicle & Automotive
  "ev-services": "#16a34a",
  "vehicle-data": "#0891b2",
  "connected-services": "#d97706",
  "fleet-ops": "#dc2626",
  telematics: "#2563eb",
  safety: "#e11d48",
  manufacturing: "#475569",
  dealer: "#9333ea",
  autonomous: "#6366f1",
  // Telecommunications
  network: "#0284c7",
  subscriber: "#059669",
  messaging: "#ea580c",
  billing: "#7c3aed",
  iot: "#0891b2",
  voice: "#2563eb",
  media: "#be185d",
  security: "#b91c1c",
  enterprise: "#475569",
  "5g": "#d97706",
};

const FALLBACK = "#64748b";

/** Returns the color for a given domain key, or the fallback neutral. */
export function domainColor(domain: string): string {
  return DOMAIN_COLORS[domain] || FALLBACK;
}

/** Returns a low-opacity background tint using CSS color-mix. */
export function domainBackground(domain: string): string {
  return `color-mix(in srgb, ${domainColor(domain)} 10%, transparent)`;
}
