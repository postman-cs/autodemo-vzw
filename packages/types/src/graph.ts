import type { ServiceSummary } from "./service.js";

export interface ServiceGraph {
  graph_id: string;
  graph_name: string;
  services: ServiceSummary[];
}

export interface GraphsResponse {
  generated_at: string;
  graphs: ServiceGraph[];
  standalone: ServiceSummary[];
  totals: {
    deployed: number;
    graphs: number;
    standalone: number;
  };
}
