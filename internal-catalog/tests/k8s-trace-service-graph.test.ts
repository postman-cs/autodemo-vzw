import { describe, it, expect } from "vitest";
import { fetchBoilerplate } from "../src/lib/boilerplate";
import { generateFlaskRoutes } from "../src/lib/spec-to-flask";
import { renderK8sManifest } from "../.github/actions/aws-deploy/src/index";

const TEST_SPEC = `
openapi: "3.0.3"
info: { title: Trace Graph Test API, version: "1.0.0" }
paths:
  /api/v1/items:
    get: { operationId: listItems, tags: [Items] }
  /api/v1/items/{itemId}:
    get: { operationId: getItem, tags: [Items] }
`;

describe("k8s trace service graph prerequisites", () => {
  it("keeps scaffolded runtime propagation and k8s manifest propagation settings aligned", async () => {
    const boilerplate = await fetchBoilerplate("fake-token");
    const generated = generateFlaskRoutes(TEST_SPEC);
    const manifest = renderK8sManifest(
      "vzw-partner-demo",
      "trace-graph-test",
      "trace-graph-test",
      "trace-graph-test",
      "trace-graph-test-ingress",
      "apps.demo.internal",
      "mock-image:latest",
      '{"hard":["http://dep1"],"soft":["http://dep2"]}',
      false,
      "{}",
    );

    const initPy = generated.initPy;
    const routes = generated.routes;
    const dependencyCaller = boilerplate.find((file) => file.path === "app/dependency_caller.py")?.content || "";

    expect(initPy).toContain('g.trace_headers = _extract_trace_headers()');
    expect(initPy).toContain('value = value.rjust(32, "0")');
    expect(initPy).toContain('incoming_tracestate = incoming.get("tracestate", "")');
    expect(initPy).toContain('"traceparent"');
    expect(initPy).toContain('"tracestate"');
    expect(initPy).toContain('"b3"');
    expect(initPy).toContain('"x-b3-traceid"');
    expect(routes).toContain('trace_headers = _current_trace_headers()');
    expect(routes).toContain('"tracestate"');
    expect(routes).toContain('"x-b3-traceid"');
    expect(dependencyCaller).toContain('def _fresh_trace_headers():');
    expect(dependencyCaller).toContain('"b3": f"{trace_id}-{span_id}-1"');

    expect(manifest).toContain("name: OTEL_PROPAGATORS");
    expect(manifest).toContain("value: 'tracecontext,baggage,b3,b3multi'");
    expect(manifest).toContain("name: DEPENDENCY_TARGETS_JSON");
    expect(manifest).toContain("mountPath: /etc/config");
  });
});
