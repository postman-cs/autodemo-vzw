import { describe, it, expect } from "vitest";
import { generateFlaskRoutes } from "../src/lib/spec-to-flask";

const TEST_SPEC = `
openapi: "3.0.3"
info: {title: Chaining Test API, version: "1.0.0"}
paths:
  /api/v1/items:
    get: {operationId: listItems, tags: [Items]}
    post: {operationId: createItem, tags: [Items], requestBody: {required: true, content: {application/json: {schema: {type: object}}}}}
  /api/v1/items/{itemId}:
    get: {operationId: getItem, tags: [Items]}
    put: {operationId: updateItem, tags: [Items], requestBody: {required: true, content: {application/json: {schema: {type: object}}}}}
  /api/v1/items/{itemId}/ping:
    post: {operationId: pingItem, tags: [Items]}
`;

describe("Realistic Dependency Chaining", () => {
  const result = generateFlaskRoutes(TEST_SPEC);

  describe("infrastructure helpers", () => {
    it("includes _stable_hash using zlib.adler32", () => {
      expect(result.routes).toContain("def _stable_hash(s):");
      expect(result.routes).toContain("zlib.adler32(s.encode('utf-8'))");
    });

    it("includes _load_config with hot-reload and fallback logic", () => {
      expect(result.routes).toContain("def _load_config():");
      expect(result.routes).toContain("os.path.exists(_CONFIG_FILE)");
      expect(result.routes).toContain("os.path.getmtime(_CONFIG_FILE)");
      expect(result.routes).toContain('os.environ.get("DEPENDENCY_TARGETS_JSON")');
      // Verify both list and dict format handling
      expect(result.routes).toContain("isinstance(data, list)");
      expect(result.routes).toContain('_dep_config = {"hard": data, "soft": []}');
    });

    it("includes _call_upstream helper with multi-target support", () => {
      expect(result.routes).toContain("def _call_upstream(method=\"GET\", seed=\"\", mode=\"hard\", call_all=False):");
      expect(result.routes).toContain("if call_all:");
      expect(result.routes).toContain("selected_targets = [t.rstrip(\"/\") for t in targets]");
      expect(result.routes).toContain("idx = _stable_hash(path_seed) % len(targets)");
    });

    it("includes _discover_cache and _DISCOVER_TTL", () => {
      expect(result.routes).toContain("_discover_cache = {}");
      expect(result.routes).toContain("_DISCOVER_TTL = 300");
    });
  });

  describe("/discover endpoint", () => {
    it("returns method-keyed endpoints", () => {
      expect(result.routes).toContain("by_method = {}");
      expect(result.routes).toContain("for m in (\"GET\", \"POST\", \"PUT\", \"PATCH\", \"DELETE\"):");
      expect(result.routes).toContain("by_method.setdefault(m, []).append(path)");
    });
  });

  describe("trace context propagation", () => {
    it("extracts and re-emits W3C tracecontext plus B3 headers in the generated app factory", () => {
      expect(result.initPy).toContain('g.trace_headers = _extract_trace_headers()');
      expect(result.initPy).toContain('for key, value in getattr(g, "trace_headers", {}).items():');
      expect(result.initPy).toContain('value = value.rjust(32, "0")');
      expect(result.initPy).toContain('incoming_tracestate = incoming.get("tracestate", "")');
      expect(result.initPy).toContain('headers["tracestate"] = incoming_tracestate');
      expect(result.initPy).toContain('"traceparent"');
      expect(result.initPy).toContain('"tracestate"');
      expect(result.initPy).toContain('"b3"');
      expect(result.initPy).toContain('"x-b3-traceid"');
    });

    it("forwards tracecontext plus B3 headers on generated upstream dependency calls", () => {
      expect(result.routes).toContain("def _current_trace_headers():");
      expect(result.routes).toContain('trace_headers = _current_trace_headers()');
      expect(result.routes).toContain('http_client.request(method, url, json={}, timeout=2, headers=trace_headers)');
      expect(result.routes).toContain('http_client.get(url, timeout=2, headers=trace_headers)');
      expect(result.routes).toContain('"tracestate"');
      expect(result.routes).toContain('"x-b3-traceid"');
    });
  });

  describe("_simulate_latency hook", () => {
    it("no longer contains cascading dependency calls", () => {
      // Old code had random.random() < 0.25 and targets_json checks
      expect(result.routes).not.toContain("random.random() < 0.25");
      expect(result.routes).not.toMatch(/if\s+targets_json:/);
      expect(result.routes).toContain("def _simulate_latency():");
      expect(result.routes).toContain("Add realistic processing latency.");
    });
  });

  describe("route handler injection (Phase 3 preview)", () => {
    it("injects _call_upstream in GET detail handler (hash-select one)", () => {
      // genGetBody
      expect(result.routes).toContain("_call_upstream(\"GET\", mode=\"hard\", call_all=False)");
    });

    it("injects _call_upstream in POST handler (call all)", () => {
      // genCreateBody
      expect(result.routes).toContain("_call_upstream(\"POST\", mode=\"hard\", call_all=True)");
    });

    it("injects _call_upstream in PUT handler (call all)", () => {
      // genUpdateBody
      expect(result.routes).toContain("_call_upstream(\"PUT\", mode=\"hard\", call_all=True)");
    });

    it("injects _call_upstream in action handler (call all)", () => {
      // genActionBody
      expect(result.routes).toContain("_call_upstream(request.method, mode=\"hard\", call_all=True)");
    });

    it("merges _upstream into response bodies", () => {
      expect(result.routes).toContain("if upstream:");
      expect(result.routes).toContain("item[\"_upstream\"] = upstream");
    });
  });
});
