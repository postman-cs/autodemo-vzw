export type Runtime = "lambda" | "ecs_service" | "k8s_workspace" | "k8s_discovery" | string;

export interface LinkFields {
  fern_docs_url?: string;
  fernDocsUrl?: string;
  run_in_postman_url?: string;
  runInPostmanUrl?: string;
  entrypoint_url?: string;
  entrypointUrl?: string;
}

export interface EnvironmentDeployment {
  environment: string;
  runtime_url: string;
  status?: string;
  deployed_at?: string;
}

export interface ServiceSummary extends LinkFields {
  service_id: string;
  title: string;
  runtime: Runtime;
  description?: string;
  deployed: boolean;
  health?: "healthy" | "degraded" | "offline";
  agent_prompt: string;
  graph_id?: string;
  graph_name?: string;
  is_graph_root?: boolean;
  is_graph_leaf?: boolean;
  upstream_count?: number;
  downstream_count?: number;
}

export interface DependencyService extends LinkFields {
  service_id: string;
  title: string;
  deployed: boolean;
  edge_type: string;
  runtime?: Runtime;
}

export interface ServiceDetailResponse {
  generated_at: string;
  service: ServiceSummary;
  environment_deployments: EnvironmentDeployment[];
  dependencies: {
    upstream: DependencyService[];
    downstream: DependencyService[];
    consumes: DependencyService[];
  };
}
