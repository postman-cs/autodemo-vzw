// Generate Flask route stubs from an OpenAPI spec at provision time.
// Parses the YAML spec and produces routes.py, models.py, and __init__.py
// so the deployed Flask app has matching routes for every spec endpoint.

import YAML from "yaml";

export interface GeneratedFlask {
  routes: string;
  models: string;
  initPy: string;
}

interface ParsedEndpoint {
  path: string;
  flaskPath: string;
  method: string;
  operationId: string;
  tag: string;
  pathParams: string[];
  hasRequestBody: boolean;
}

interface ParsedResource {
  name: string;
  singular: string;
  idParam: string;
  endpoints: ParsedEndpoint[];
  parentChain: { resource: string; idParam: string }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PYTHON_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await",
  "break", "class", "continue", "def", "del", "elif", "else", "except",
  "finally", "for", "from", "global", "if", "import", "in", "is",
  "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
  "while", "with", "yield",
]);

function camelToSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function singularize(s: string): string {
  if (s.endsWith("ies")) return s.slice(0, -3) + "y";
  if (s.endsWith("ses") || s.endsWith("xes") || s.endsWith("zes")) return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss")) return s.slice(0, -1);
  return s;
}

/** Convert OpenAPI {paramName} to Flask <param_name> */
function toFlaskPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_, p) => `<${camelToSnake(p)}>`);
}

/** Sanitize a string into a valid Python function name */
function toPythonIdentifier(s: string): string {
  let name = camelToSnake(s);
  name = name.replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  // Ensure doesn't start with a digit
  if (/^\d/.test(name)) name = `fn_${name}`;
  // Avoid Python keywords
  if (!name || PYTHON_KEYWORDS.has(name)) name = `${name}_handler`;
  return name;
}

/** Detect the longest common path prefix across all API paths (excluding exact /health) */
function detectPrefix(paths: string[]): string {
  // Only exclude the exact top-level /health, not /something/health
  const apiPaths = paths.filter(p => p !== "/health");
  if (apiPaths.length === 0) return "";

  const segments = apiPaths.map(p => p.split("/").filter(Boolean));
  const first = segments[0];
  let prefixLen = 0;

  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (seg.startsWith("{")) break;
    if (!segments.every(s => s[i] === seg)) break;

    // Only include this segment if every path still has at least one
    // non-param segment remaining after the prefix. Otherwise we'd
    // consume the resource name itself.
    const candidateLen = i + 1;
    const allHaveRemainder = segments.every(segs => {
      const remaining = segs.slice(candidateLen);
      return remaining.some(s => !s.startsWith("{"));
    });
    if (allHaveRemainder) {
      prefixLen = candidateLen;
    } else {
      break;
    }
  }

  if (prefixLen === 0) return "";
  return "/" + first.slice(0, prefixLen).join("/");
}

/** Parse path into resource segments: [{resource, idParam}] */
function parsePathSegments(path: string, prefix: string): { resource: string; idParam: string }[] {
  const stripped = prefix ? path.slice(prefix.length) : path;
  const parts = stripped.split("/").filter(Boolean);
  const result: { resource: string; idParam: string }[] = [];
  let i = 0;

  while (i < parts.length) {
    const part = parts[i];
    if (part.startsWith("{")) { i++; continue; }
    const idPart = parts[i + 1];
    const idParam = idPart && idPart.startsWith("{") ? idPart.slice(1, -1) : "";
    result.push({ resource: part, idParam });
    i += idParam ? 2 : 1;
  }
  return result;
}

/** Classify an endpoint: list, create, get, update, delete, or action */
function classifyEndpoint(ep: ParsedEndpoint, resource: ParsedResource): string {
  const segs = ep.flaskPath.split("/").filter(Boolean);
  const lastSeg = segs[segs.length - 1];
  const isItemPath = lastSeg?.startsWith("<");
  const isAction = !lastSeg?.startsWith("<") && lastSeg !== resource.name;

  if (isAction) return "action";

  switch (ep.method) {
    case "get": return isItemPath ? "get" : "list";
    case "post": return "create";
    case "put": case "patch": return "update";
    case "delete": return "delete";
    default: return "action";
  }
}

// ---------------------------------------------------------------------------
// Parse OpenAPI spec into endpoints
// ---------------------------------------------------------------------------

function parseSpec(specYaml: string): { endpoints: ParsedEndpoint[]; title: string; prefix: string } {
  const spec = YAML.parse(specYaml);
  const title = spec?.info?.title || "api-service";
  const paths = spec?.paths || {};
  const allPaths = Object.keys(paths);
  const prefix = detectPrefix(allPaths);

  const endpoints: ParsedEndpoint[] = [];
  const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

  for (const [path, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== "object") continue;
    // Skip exact /health -- we generate it separately on ops_bp
    if (path === "/health") continue;

    const pathParams = [...(path.match(/\{([^}]+)\}/g) || [])].map(p => p.slice(1, -1));
    const strippedPath = prefix ? path.slice(prefix.length) : path;

    for (const [method, operation] of Object.entries(methods as Record<string, any>)) {
      if (!HTTP_METHODS.includes(method)) continue;
      if (!operation || typeof operation !== "object") continue;

      const op = operation as { operationId?: string; tags?: string[]; requestBody?: unknown };
      const operationId = op.operationId || `${method}_${strippedPath.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const tag = Array.isArray(op.tags) && op.tags.length > 0 ? op.tags[0] : "";
      const hasRequestBody = !!op.requestBody;

      endpoints.push({
        path,
        flaskPath: toFlaskPath(strippedPath),
        method,
        operationId,
        tag,
        pathParams,
        hasRequestBody,
      });
    }
  }

  return { endpoints, title, prefix };
}

// ---------------------------------------------------------------------------
// Group endpoints by resource
// ---------------------------------------------------------------------------

function groupByResource(endpoints: ParsedEndpoint[], prefix: string): ParsedResource[] {
  const resourceMap = new Map<string, ParsedResource>();

  for (const ep of endpoints) {
    const segs = parsePathSegments(ep.path, prefix);
    if (segs.length === 0) continue;

    const last = segs[segs.length - 1];

    // Detect action segments: a trailing segment with no idParam that follows
    // a parameterized resource AND no other path extends it with an {id} param.
    // e.g., /webhooks/{webhookId}/ping is an action (no /ping/{pingId} exists)
    // but /projects/{projectId}/tasks is a child resource (tasks/{taskId} exists)
    if (segs.length >= 2 && !last.idParam) {
      const parent = segs[segs.length - 2];
      const childKey = segs.map(s => s.resource).join("/");

      const hasChildWithId = endpoints.some(other => {
        const otherSegs = parsePathSegments(other.path, prefix);
        const otherKey = otherSegs.map(s => s.resource).join("/");
        return otherKey === childKey &&
          otherSegs.length >= segs.length &&
          otherSegs[segs.length - 1]?.idParam;
      });

      if (parent.idParam && !hasChildWithId) {
        // Action endpoint -- group under the parent resource
        const parentSegs = segs.slice(0, -1);
        const parentLast = parentSegs[parentSegs.length - 1];
        const key = parentSegs.map(s => s.resource).join("/");

        if (!resourceMap.has(key)) {
          resourceMap.set(key, {
            name: parentLast.resource,
            singular: singularize(parentLast.resource),
            idParam: parentLast.idParam,
            endpoints: [],
            parentChain: parentSegs.slice(0, -1).filter(s => !!s.idParam),
          });
        }
        resourceMap.get(key)!.endpoints.push(ep);
        continue;
      }
    }

    const resourceName = last.resource;
    const key = segs.map(s => s.resource).join("/");

    if (!resourceMap.has(key)) {
      resourceMap.set(key, {
        name: resourceName,
        singular: singularize(resourceName),
        idParam: last.idParam,
        endpoints: [],
        parentChain: segs.slice(0, -1).filter(s => !!s.idParam),
      });
    }
    // Merge idParam from item-level paths (e.g., /orgs has no id, /orgs/{orgId} does)
    const existing = resourceMap.get(key)!;
    if (!existing.idParam && last.idParam) {
      existing.idParam = last.idParam;
    }
    existing.endpoints.push(ep);
  }

  return Array.from(resourceMap.values());
}

// ---------------------------------------------------------------------------
// Generate Python code
// ---------------------------------------------------------------------------

function genFunctionName(ep: ParsedEndpoint, usedNames: Set<string>): string {
  let name = toPythonIdentifier(ep.operationId);

  const base = name;
  let i = 2;
  while (usedNames.has(name)) {
    name = `${base}_${i}`;
    i++;
  }
  usedNames.add(name);
  return name;
}

function genFlaskArgs(ep: ParsedEndpoint): string {
  const params = ep.pathParams.map(p => camelToSnake(p));
  return params.length > 0 ? params.join(", ") : "";
}

function genListBody(resource: ParsedResource): string {
  const filterLines: string[] = [];
  for (const parent of resource.parentChain) {
    const camelId = parent.idParam;
    const snakeId = camelToSnake(parent.idParam);
    filterLines.push(`    all_items = [v for v in all_items if v.get("${camelId}") == ${snakeId}]`);
  }

  return `    store = get_store("${resource.name}")
    limit = request.args.get("limit", 20, type=int)
    offset = request.args.get("offset", 0, type=int)
    limit = max(1, min(limit, 100))
    offset = max(0, offset)
    all_items = list(store.values())
${filterLines.join("\n")}
    page = all_items[offset:offset + limit]
    return jsonify({"${resource.name}": page, "total": len(all_items), "limit": limit, "offset": offset})`;
}

function genCreateBody(resource: ParsedResource): string {
  const parentSets: string[] = [];
  for (const parent of resource.parentChain) {
    parentSets.push(`    item["${parent.idParam}"] = ${camelToSnake(parent.idParam)}`);
  }

  const idField = resource.idParam ? resource.idParam : `${resource.singular}Id`;
  return `    upstream, _ = _call_upstream("POST", mode="hard", call_all=True)
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "bad_request", "message": "Request body must be JSON"}), 400
    item_id = str(uuid.uuid4())
    item = {"${idField}": item_id, **data, "createdAt": datetime.now(timezone.utc).isoformat(), "updatedAt": datetime.now(timezone.utc).isoformat()}
${parentSets.join("\n")}
    store = get_store("${resource.name}")
    store[item_id] = item
    if upstream:
        item["_upstream"] = upstream
    return jsonify(item), 201`;
}

function genGetBody(resource: ParsedResource): string {
  const idSnake = camelToSnake(resource.idParam || `${resource.singular}_id`);
  const idField = resource.idParam || `${resource.singular}Id`;
  // Build stub fields including parent IDs for nested resources
  const stubFields = [`"${idField}": ${idSnake}`];
  for (const parent of resource.parentChain) {
    stubFields.push(`"${parent.idParam}": ${camelToSnake(parent.idParam)}`);
  }
  stubFields.push(`"createdAt": datetime.now(timezone.utc).isoformat()`);
  stubFields.push(`"updatedAt": datetime.now(timezone.utc).isoformat()`);
  const stubDict = stubFields.join(", ");

  return `    upstream, _ = _call_upstream("GET", mode="hard", call_all=False)
    store = get_store("${resource.name}")
    item = store.get(${idSnake})
    if not item:
        # Return stub so smoke/contract tests pass against empty stores
        item = {${stubDict}}
    if upstream:
        item["_upstream"] = upstream
    return jsonify(item)`;
}

function genUpdateBody(resource: ParsedResource): string {
  const idSnake = camelToSnake(resource.idParam || `${resource.singular}_id`);
  const idField = resource.idParam || `${resource.singular}Id`;
  return `    upstream, _ = _call_upstream("PUT", mode="hard", call_all=True)
    store = get_store("${resource.name}")
    item = store.get(${idSnake})
    if not item:
        item = {"${idField}": ${idSnake}, "createdAt": datetime.now(timezone.utc).isoformat()}
        store[${idSnake}] = item
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "bad_request", "message": "Request body must be JSON"}), 400
    item.update(data)
    item["updatedAt"] = datetime.now(timezone.utc).isoformat()
    if upstream:
        item["_upstream"] = upstream
    return jsonify(item)`;
}

function genDeleteBody(resource: ParsedResource): string {
  const idSnake = camelToSnake(resource.idParam || `${resource.singular}_id`);
  return `    store = get_store("${resource.name}")
    store.pop(${idSnake}, None)
    return "", 204`;
}

function genActionBody(resource: ParsedResource, ep: ParsedEndpoint): string {
  const segs = ep.flaskPath.split("/").filter(Boolean);
  const actionName = segs[segs.length - 1] || "action";

  if (ep.method === "get") {
    return `    upstream, _ = _call_upstream("GET", mode="hard", call_all=False)
    resp = {"status": "ok", "action": "${actionName}", "timestamp": datetime.now(timezone.utc).isoformat()}
    if upstream:
        resp["_upstream"] = upstream
    return jsonify(resp)`;
  }
  return `    upstream, _ = _call_upstream(request.method, mode="hard", call_all=True)
    data = request.get_json(silent=True) or {}
    resp = {"status": "ok", "action": "${actionName}", "timestamp": datetime.now(timezone.utc).isoformat(), **data}
    if upstream:
        resp["_upstream"] = upstream
    return jsonify(resp)`;
}

function generateRoutes(resources: ParsedResource[], title: string): string {
  const usedNames = new Set<string>();
  const sections: string[] = [];

  sections.push(`from __future__ import annotations

import os
import time
import json
import random
import uuid
import zlib
import logging
from datetime import datetime, timezone

import requests as http_client
from flask import Blueprint, jsonify, request, current_app, g

from app.chaos import is_enabled as chaos_is_enabled, set_enabled as set_chaos_enabled, maybe_fail as maybe_chaos_fail
from app.models import get_store

ops_bp = Blueprint("ops", __name__)
api_bp = Blueprint("api", __name__)


# ---------------------------------------------------------------------------
# Chaining & Hot-Reload — enables realistic inter-service traffic
# ---------------------------------------------------------------------------

_CONFIG_FILE = "/etc/config/dependencies.json"
_dep_config = {"hard": [], "soft": []}
_last_mtime = 0
_discover_cache = {}
_DISCOVER_TTL = 300
_TRACE_HEADER_KEYS = (
    "traceparent",
    "tracestate",
    "b3",
    "x-b3-traceid",
    "x-b3-spanid",
    "x-b3-parentspanid",
    "x-b3-sampled",
    "x-b3-flags",
)

def _stable_hash(s):
    return zlib.adler32(s.encode('utf-8')) & 0xffffffff

def _load_config():
    global _dep_config, _last_mtime
    # Fallback to env var if file doesn't exist (local dev / ECS)
    if not os.path.exists(_CONFIG_FILE):
        if not _dep_config["hard"]:
            raw = os.environ.get("DEPENDENCY_TARGETS_JSON")
            if raw:
                try:
                    data = json.loads(raw)
                    # Handle both old list format and new dict format
                    if isinstance(data, list):
                        _dep_config = {"hard": data, "soft": []}
                    else:
                        _dep_config = data
                except Exception:
                    pass
        return _dep_config

    # Hot-reload if mtime changed (K8s ConfigMap)
    try:
        mtime = os.path.getmtime(_CONFIG_FILE)
        if mtime > _last_mtime:
            with open(_CONFIG_FILE, "r") as f:
                data = json.load(f)
                # Handle both old list format and new dict format
                if isinstance(data, list):
                    _dep_config = {"hard": data, "soft": []}
                else:
                    _dep_config = data
            _last_mtime = mtime
    except Exception as e:
        logging.getLogger("upstream").error(f"Config load failed: {e}")
    return _dep_config

def _current_trace_headers():
    try:
        raw = dict(getattr(g, "trace_headers", {}))
        return {k: v for k, v in raw.items() if v}
    except RuntimeError:
        return {}

def _call_upstream(method="GET", seed="", mode="hard", call_all=False):
    """Call dependency services synchronously. Returns ([results], total_latency_ms) or ([], 0)."""
    config = _load_config()
    targets = config.get(mode, [])
    if not targets:
        return [], 0

    path_seed = request.path if (request and request.path) else seed
    
    # Select target(s)
    if call_all:
        selected_targets = [t.rstrip("/") for t in targets]
    else:
        idx = _stable_hash(path_seed) % len(targets)
        selected_targets = [targets[idx].rstrip("/")]

    results = []
    total_latency = 0

    trace_headers = _current_trace_headers()

    for target in selected_targets:
        # Discover endpoints on target (cached)
        cache_entry = _discover_cache.get(target)
        if not cache_entry or (time.time() - cache_entry["ts"]) > _DISCOVER_TTL:
            try:
                disc = http_client.get(f"{target}/discover", timeout=2)
                if disc.ok:
                    _discover_cache[target] = {"eps": disc.json(), "ts": time.time()}
                else:
                    _discover_cache[target] = {"eps": {}, "ts": time.time()}
            except Exception as e:
                _discover_cache[target] = {"eps": {}, "ts": time.time()}

        eps_data = _discover_cache.get(target, {}).get("eps", {})
        from urllib.parse import urlparse
        parsed = urlparse(target)
        base = f"{parsed.scheme}://{parsed.netloc}"

        candidates = eps_data.get(method, []) or eps_data.get("GET", [])
        if not candidates:
            candidates = [f"{target}/health"]
        
        # STABLE endpoint selection
        ep = candidates[_stable_hash(path_seed + target + method) % len(candidates)]
        url = ep if ep.startswith("http") else f"{base}{ep}"

        t0 = time.time()
        try:
            # Use short 2s timeout to prevent cascading failures in deep chains
            if method in ("POST", "PUT", "PATCH"):
                resp = http_client.request(method, url, json={}, timeout=2, headers=trace_headers)
            else:
                resp = http_client.get(url, timeout=2, headers=trace_headers)
            latency_ms = round((time.time() - t0) * 1000, 1)
            total_latency += latency_ms
            
            res = {"url": url, "status": resp.status_code, "latency_ms": latency_ms}
            try:
                data = resp.json()
                if isinstance(data, dict) and "_upstream" in data:
                    res["_upstream"] = data["_upstream"]
            except Exception:
                pass
            results.append(res)
        except Exception as e:
            latency_ms = round((time.time() - t0) * 1000, 1)
            total_latency += latency_ms
            logging.getLogger("upstream").warning(f"Upstream call failed: {url} ({e})")
            results.append({"url": url, "error": str(e), "latency_ms": latency_ms})
    
    return results, total_latency


# ---------------------------------------------------------------------------
# Latency simulation — makes pcap-captured timings look realistic
# ---------------------------------------------------------------------------

_LATENCY_RANGES = {
    "GET_LIST":   (0.025, 0.075),   # 25-75ms  — paginated DB scan
    "GET_DETAIL": (0.008, 0.028),   # 8-28ms   — indexed lookup
    "POST":       (0.040, 0.130),   # 40-130ms — validation + write
    "PUT":        (0.035, 0.110),   # 35-110ms — update
    "PATCH":      (0.030, 0.090),   # 30-90ms  — partial update
    "DELETE":     (0.015, 0.050),   # 15-50ms  — soft delete
}


@api_bp.before_request
def _simulate_latency():
    """Add realistic processing latency."""
    # 1. Artificial latency based on HTTP method + path shape
    method = request.method
    rule_str = request.url_rule.rule if request.url_rule else ""
    if method == "GET":
        key = "GET_DETAIL" if "<" in rule_str else "GET_LIST"
    else:
        key = method if method in _LATENCY_RANGES else "POST"
    lo, hi = _LATENCY_RANGES.get(key, (0.010, 0.040))
    time.sleep(random.uniform(lo, hi))


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------


@ops_bp.route("/health", methods=["GET"])
def health_check():
    return jsonify({
        "status": "healthy",
        "service": "${title}",
        "version": "1.0.0",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


@ops_bp.route("/discover", methods=["GET"])
def discover_endpoints():
    """Returns endpoints keyed by method with params replaced by test values."""
    import re
    by_method = {}
    for rule in current_app.url_map.iter_rules():
        if rule.endpoint.startswith("api."):
            path = re.sub(r"<[^>]+>", "test-1", rule.rule)
            for m in ("GET", "POST", "PUT", "PATCH", "DELETE"):
                if m in rule.methods:
                    by_method.setdefault(m, []).append(path)
    return jsonify(by_method)`);

  sections.push(`

@ops_bp.route("/chaos", methods=["GET", "PATCH"])
def chaos_toggle():
    if request.method == "GET":
        return jsonify({"chaos_enabled": chaos_is_enabled()})
    body = request.get_json(silent=True) or {}
    if "enabled" not in body:
        return jsonify({"error": "bad_request", "message": "enabled boolean is required"}), 400
    set_chaos_enabled(bool(body.get("enabled")))
    return jsonify({"chaos_enabled": chaos_is_enabled()})`);

  // Group resources by tag for section headers
  const tagOrder: string[] = [];
  const tagResources = new Map<string, ParsedResource[]>();
  for (const res of resources) {
    const tag = res.endpoints[0]?.tag || res.name;
    if (!tagResources.has(tag)) {
      tagOrder.push(tag);
      tagResources.set(tag, []);
    }
    tagResources.get(tag)!.push(res);
  }

  for (const tag of tagOrder) {
    sections.push(`\n\n# ---------------------------------------------------------------------------
# ${tag}
# ---------------------------------------------------------------------------`);

    for (const res of tagResources.get(tag)!) {
      for (const ep of res.endpoints) {
        const funcName = genFunctionName(ep, usedNames);
        const args = genFlaskArgs(ep);
        const methodUpper = ep.method.toUpperCase();
        const kind = classifyEndpoint(ep, res);

        let body: string;
        switch (kind) {
          case "list": body = genListBody(res); break;
          case "create": body = genCreateBody(res); break;
          case "get": body = genGetBody(res); break;
          case "update": body = genUpdateBody(res); break;
          case "delete": body = genDeleteBody(res); break;
          default: body = genActionBody(res, ep); break;
        }

        sections.push(`\n
@api_bp.route("${ep.flaskPath}", methods=["${methodUpper}"])
def ${funcName}(${args}):
    chaos_response = maybe_chaos_fail(request.path)
    if chaos_response:
        return chaos_response
${body}`);
      }
    }
  }

  return sections.join("\n");
}

function generateModels(): string {
  return `from __future__ import annotations


# ---------------------------------------------------------------------------
# In-memory stores (one dict per resource)
# ---------------------------------------------------------------------------

_stores: dict[str, dict[str, dict]] = {}


def get_store(resource: str) -> dict[str, dict]:
    """Return the in-memory store for a resource, creating it if needed."""
    if resource not in _stores:
        _stores[resource] = {}
    return _stores[resource]


def reset_stores():
    """Clear all stores (used by tests)."""
    _stores.clear()
`;
}

function generateInitPy(prefix: string): string {
  const urlPrefix = prefix || "";

  return `from flask import Flask, request, g
from flask_cors import CORS
import os
import uuid
from app.dependency_caller import start_dependency_caller

_TRACE_HEADER_KEYS = (
    "traceparent",
    "tracestate",
    "b3",
    "x-b3-traceid",
    "x-b3-spanid",
    "x-b3-parentspanid",
    "x-b3-sampled",
    "x-b3-flags",
)

def _build_b3_headers(trace_id, span_id, sampled):
    headers = {
        "b3": f"{trace_id}-{span_id}-{sampled}",
        "x-b3-traceid": trace_id,
        "x-b3-spanid": span_id,
        "x-b3-sampled": sampled,
    }
    return headers

def _normalize_trace_id(trace_id):
    value = (trace_id or "").strip().lower()
    if len(value) == 16:
        value = value.rjust(32, "0")
    if len(value) != 32 or value == ("0" * 32):
        return ""
    if any(ch not in "0123456789abcdef" for ch in value):
        return ""
    return value

def _normalize_span_id(span_id):
    value = (span_id or "").strip().lower()
    if len(value) != 16 or value == ("0" * 16):
        return ""
    if any(ch not in "0123456789abcdef" for ch in value):
        return ""
    return value

def _normalize_trace_flags(flags):
    value = (flags or "").strip().lower()
    if len(value) != 2 or any(ch not in "0123456789abcdef" for ch in value):
        return ""
    return value

def _fresh_trace_headers():
    trace_id = uuid.uuid4().hex
    span_id = os.urandom(8).hex()
    headers = {"traceparent": f"00-{trace_id}-{span_id}-01"}
    headers.update(_build_b3_headers(trace_id, span_id, "1"))
    return headers

def _parse_traceparent(header):
    parts = (header or "").split("-")
    if len(parts) != 4:
        return None
    _version, trace_id, span_id, flags = parts
    trace_id = _normalize_trace_id(trace_id)
    span_id = _normalize_span_id(span_id)
    flags = _normalize_trace_flags(flags)
    if not trace_id or not span_id or not flags:
        return None
    return trace_id, span_id, flags

def _parse_b3(headers):
    single = headers.get("b3", "").strip().lower()
    if single:
        parts = single.split("-")
        if len(parts) >= 2:
            trace_id = _normalize_trace_id(parts[0])
            span_id = _normalize_span_id(parts[1])
            sampled = parts[2] if len(parts) >= 3 and parts[2] else "1"
            if trace_id and span_id:
                flags = "01" if sampled in ("1", "d") else "00"
                return trace_id, span_id, sampled, flags

    trace_id = _normalize_trace_id(headers.get("x-b3-traceid", ""))
    span_id = _normalize_span_id(headers.get("x-b3-spanid", ""))
    sampled = headers.get("x-b3-sampled", headers.get("x-b3-flags", "1"))
    if trace_id and span_id:
        flags = "01" if sampled in ("1", "d") else "00"
        return trace_id, span_id, sampled, flags
    return None

def _extract_trace_headers():
    incoming = {}
    for key in _TRACE_HEADER_KEYS:
        value = request.headers.get(key, "").strip()
        if value:
            incoming[key] = value

    incoming_tracestate = incoming.get("tracestate", "")
    headers = {}

    tp = _parse_traceparent(incoming.get("traceparent", ""))
    if tp:
        trace_id, span_id, flags = tp
        sampled = "1" if int(flags, 16) & 1 else "0"
        headers["traceparent"] = incoming["traceparent"]
        if incoming_tracestate:
            headers["tracestate"] = incoming_tracestate
        headers.update(_build_b3_headers(trace_id, span_id, sampled))
    else:
        b3 = _parse_b3(incoming)
        if b3:
            trace_id, span_id, sampled, flags = b3
            headers["traceparent"] = f"00-{trace_id}-{span_id}-{flags}"
            headers.update(_build_b3_headers(trace_id, span_id, sampled))
        else:
            headers = _fresh_trace_headers()
    return headers

def create_app():
    app = Flask(__name__)
    CORS(app)

    @app.before_request
    def _extract_trace():
        g.trace_headers = _extract_trace_headers()

    @app.after_request
    def _inject_trace(response):
        for key, value in getattr(g, "trace_headers", {}).items():
            if value:
                response.headers[key] = value
        return response

    from app.routes import api_bp, ops_bp

    base_path = (os.environ.get("API_BASE_PATH", "") or "").rstrip("/")
    if base_path and not base_path.startswith("/"):
        base_path = "/" + base_path
    spec_prefix = "${urlPrefix}"

    ops_prefix = base_path
    api_prefix = f"{base_path}{spec_prefix}" if spec_prefix else base_path

    if ops_prefix:
        app.register_blueprint(ops_bp, url_prefix=ops_prefix)
    else:
        app.register_blueprint(ops_bp)

    if api_prefix:
        app.register_blueprint(api_bp, url_prefix=api_prefix)
    else:
        app.register_blueprint(api_bp)

    # Start background traffic generator for container runtimes
    start_dependency_caller()

    return app
`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateFlaskRoutes(specYaml: string): GeneratedFlask {
  const { endpoints, title, prefix } = parseSpec(specYaml);
  const resources = groupByResource(endpoints, prefix);

  return {
    routes: generateRoutes(resources, title),
    models: generateModels(),
    initPy: generateInitPy(prefix),
  };
}
