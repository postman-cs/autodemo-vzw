import { describe, it, expect } from "vitest";
import {
  fetchBoilerplate,
  generateGitignore,
  generateEnvExample,
} from "../src/lib/boilerplate";

describe("generateGitignore", () => {
  it("returns a non-empty string", () => {
    const result = generateGitignore();
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes Python patterns", () => {
    const result = generateGitignore();
    expect(result).toContain("__pycache__/");
    expect(result).toContain("*.py[cod]");
  });

  it("includes environment and deployment patterns", () => {
    const result = generateGitignore();
    expect(result).toContain(".env");
    expect(result).toContain("deployment.zip");
    expect(result).toContain("venv/");
  });
});

describe("generateEnvExample", () => {
  it("includes the project name in a comment", () => {
    const result = generateEnvExample("my-project");
    expect(result).toContain("# my-project");
  });

  it("includes Flask env variables", () => {
    const result = generateEnvExample("test");
    expect(result).toContain("FLASK_ENV=development");
    expect(result).toContain("FLASK_DEBUG=1");
    expect(result).toContain("PORT=5000");
    expect(result).toContain("OTEL_PROPAGATORS=tracecontext,baggage,b3,b3multi");
  });
});

describe("fetchBoilerplate", () => {
  it("returns all boilerplate files inline (no network)", async () => {
    const files = await fetchBoilerplate("fake-token");
    expect(files).toHaveLength(13);
    expect(files[0].path).toBe("app/__init__.py");
    expect(files[0].content).toContain("Flask");
  });

  it("includes expected file paths", async () => {
    const files = await fetchBoilerplate("fake-token");
    const paths = files.map((f) => f.path);
    expect(paths).toContain("app/__init__.py");
    expect(paths).toContain("app/chaos.py");
    expect(paths).toContain("app/dependency_caller.py");
    expect(paths).toContain("app/routes.py");
    expect(paths).toContain("requirements.txt");
    expect(paths).toContain("Dockerfile");
    expect(paths).toContain("index.yaml");
  });

  it("generates non-empty content for each file", async () => {
    const files = await fetchBoilerplate("fake-token");
    for (const f of files) {
      if (f.path !== "tests/__init__.py") {
        expect(f.content.length).toBeGreaterThan(0);
      }
    }
  });

  it("uses BuildKit pip cache in Dockerfile to speed repeated image builds", async () => {
    const files = await fetchBoilerplate("fake-token");
    const dockerfile = files.find((f) => f.path === "Dockerfile")?.content || "";
    expect(dockerfile).toContain("# syntax=docker/dockerfile:1.7");
    expect(dockerfile).toContain("--mount=type=cache,target=/root/.cache/pip");
    expect(dockerfile).not.toContain("--no-cache-dir");
    expect(dockerfile).toContain("ENV OTEL_PROPAGATORS=tracecontext,baggage,b3,b3multi");
  });

  it("seeds background dependency traffic with fresh tracecontext and B3 headers", async () => {
    const files = await fetchBoilerplate("fake-token");
    const caller = files.find((f) => f.path === "app/dependency_caller.py")?.content || "";
    expect(caller).toContain('def _fresh_trace_headers():');
    expect(caller).toContain('"traceparent": f"00-{trace_id}-{span_id}-01"');
    expect(caller).toContain('"b3": f"{trace_id}-{span_id}-1"');
    expect(caller).toContain('"x-b3-traceid": trace_id');
    expect(caller).toContain('requests.request(method, url, json={}, timeout=5, headers=tp_headers)');
    expect(caller).toContain('requests.get(f"{target}/health", timeout=5, headers=_fresh_trace_headers())');
  });

  it("extracts and re-emits tracecontext plus B3 headers in the default app factory", async () => {
    const files = await fetchBoilerplate("fake-token");
    const initPy = files.find((f) => f.path === "app/__init__.py")?.content || "";
    expect(initPy).toContain('g.trace_headers = _extract_trace_headers()');
    expect(initPy).toContain('for key, value in getattr(g, "trace_headers", {}).items():');
    expect(initPy).toContain('value = value.rjust(32, "0")');
    expect(initPy).toContain('incoming_tracestate = incoming.get("tracestate", "")');
    expect(initPy).toContain('headers["tracestate"] = incoming_tracestate');
    expect(initPy).toContain('"tracestate"');
    expect(initPy).toContain('"x-b3-traceid"');
  });
});
