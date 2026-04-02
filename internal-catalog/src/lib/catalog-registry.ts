import { SERVICE_REGISTRY_SCHEMA } from "./two-worker-contract";

export type ServiceRuntimeMode = "lambda" | "ecs_service" | "k8s_workspace" | "k8s_discovery";

export interface ServiceRegistryRecord {
  service_id: string;
  project_name: string;
  runtime_mode: ServiceRuntimeMode;
  aws_region: string;
  status: string;
  environment_urls: Record<string, string>;
  updated_at: string;
  [key: string]: unknown;
}

export interface CatalogQuery {
  page: number;
  page_size: number;
  runtime_mode?: string;
  status?: string;
  search?: string;
}

export interface CatalogListResult {
  services: ServiceRegistryRecord[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function parsePositiveInt(raw: string | null, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : fallback;
}

function parseUpdatedAt(value: string): number {
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : 0;
}

function normalizeRecord(
  raw: unknown,
  keyName: string,
): ServiceRegistryRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  const rawRuntimeMode = String(candidate.runtime_mode || "").trim();
  const runtimeMode: ServiceRuntimeMode =
    rawRuntimeMode === "ecs_service"
      ? "ecs_service"
      : rawRuntimeMode === "k8s_workspace" || rawRuntimeMode === "k8s_roadmap"
        ? "k8s_workspace"
        : rawRuntimeMode === "k8s_discovery"
          ? "k8s_discovery"
          : "lambda";

  const record: ServiceRegistryRecord = {
    service_id: String(candidate.service_id || keyName.replace(SERVICE_REGISTRY_SCHEMA.record_key_prefix, "")),
    project_name: String(candidate.project_name || ""),
    runtime_mode: runtimeMode,
    aws_region: String(candidate.aws_region || ""),
    status: String(candidate.status || "unknown"),
    environment_urls: (candidate.environment_urls || {}) as Record<string, string>,
    updated_at: String(candidate.updated_at || ""),
    ...candidate,
  };

  if (!record.service_id || !record.project_name) {
    return null;
  }

  return record;
}

function matchesFilters(record: ServiceRegistryRecord, query: CatalogQuery): boolean {
  if (query.runtime_mode && record.runtime_mode !== query.runtime_mode) {
    return false;
  }
  if (query.status && record.status !== query.status) {
    return false;
  }
  if (query.search) {
    const haystack = `${record.service_id} ${record.project_name}`.toLowerCase();
    if (!haystack.includes(query.search.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function toServiceKey(serviceId: string): string {
  return `${SERVICE_REGISTRY_SCHEMA.record_key_prefix}${serviceId}`;
}

export function normalizeCatalogQuery(url: URL): CatalogQuery {
  const page = parsePositiveInt(url.searchParams.get("page"), 1);
  const pageSizeRaw = parsePositiveInt(url.searchParams.get("page_size"), DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(pageSizeRaw, MAX_PAGE_SIZE);
  const runtime_mode = url.searchParams.get("runtime") || url.searchParams.get("runtime_mode") || undefined;
  const status = url.searchParams.get("status") || undefined;
  const search = url.searchParams.get("search") || undefined;

  return {
    page,
    page_size: pageSize,
    runtime_mode,
    status,
    search,
  };
}

export async function getServiceRecord(
  registry: KVNamespace,
  serviceId: string,
): Promise<ServiceRegistryRecord | null> {
  const trimmed = serviceId.trim();
  if (!trimmed) return null;

  const raw = await registry.get(toServiceKey(trimmed), "json");
  return normalizeRecord(raw, toServiceKey(trimmed));
}

export async function listServiceRecords(
  registry: KVNamespace,
  query: CatalogQuery,
): Promise<CatalogListResult> {
  const keyNames: string[] = [];
  let cursor: string | undefined;

  do {
    const page = await registry.list({
      prefix: SERVICE_REGISTRY_SCHEMA.record_key_prefix,
      limit: 1000,
      cursor,
    });
    keyNames.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const filtered: ServiceRegistryRecord[] = [];

  for (const keyName of keyNames) {
    const raw = await registry.get(keyName, "json");
    const record = normalizeRecord(raw, keyName);
    if (!record) {
      continue;
    }
    if (!matchesFilters(record, query)) {
      continue;
    }
    filtered.push(record);
  }

  filtered.sort((a, b) => parseUpdatedAt(b.updated_at) - parseUpdatedAt(a.updated_at));

  const total = filtered.length;
  const start = (query.page - 1) * query.page_size;
  const end = start + query.page_size;
  const services = filtered.slice(start, end);

  return {
    services,
    total,
    page: query.page,
    page_size: query.page_size,
    has_more: end < total,
  };
}
