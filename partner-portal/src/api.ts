import type { GraphsResponse, LinkFields, ServiceDetailResponse, ServiceSummary } from "./types";

const API_BASE = "/api/partner";
const FERN_BASE = "https://vzw-demo.docs.buildwithfern.com";
const POSTMAN_BASE = "https://app.getpostman.com/workspace";

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export function fetchGraphs(): Promise<GraphsResponse> {
  return requestJson<GraphsResponse>(`${API_BASE}/graphs?env=prod`);
}

export function fetchServiceDetail(serviceId: string): Promise<ServiceDetailResponse> {
  return requestJson<ServiceDetailResponse>(`${API_BASE}/services/${serviceId}`);
}

export function getFernDocsUrl(service: Pick<ServiceSummary, "service_id"> & LinkFields): string {
  return service.fern_docs_url ?? service.fernDocsUrl ?? `${FERN_BASE}`;
}

export function getRunInPostmanUrl(service: Pick<ServiceSummary, "service_id"> & LinkFields): string {
  return service.run_in_postman_url ?? service.runInPostmanUrl ?? `${POSTMAN_BASE}/${service.service_id}`;
}

export function getEntrypointUrl(service: LinkFields): string | null {
  return service.entrypoint_url ?? service.entrypointUrl ?? null;
}

export function formatRuntime(runtime: string): string {
  switch (runtime) {
    case "lambda":
      return "Lambda";
    case "ecs_service":
      return "ECS";
    case "k8s_workspace":
      return "K8s Workspace";
    case "k8s_discovery":
      return "K8s Discovery";
    default:
      return runtime.replaceAll("_", " ");
  }
}
