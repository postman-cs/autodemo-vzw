import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, setupFetchMock, teardownFetchMock } from "./helpers/fetch-mock";

describe("fetch mock hygiene", () => {
  beforeEach(() => {
    setupFetchMock();
  });

  afterEach(() => {
    teardownFetchMock();
  });

  afterAll(() => server.close());

  it("uses test-local interceptor payloads", async () => {
    server.use(
      http.get("https://example.com/specs/financial/af-cards-3ds.yaml", () =>
        new HttpResponse("first-response", { status: 200 }), { once: true }),
    );

    const resp = await fetch("https://example.com/specs/financial/af-cards-3ds.yaml");
    expect(await resp.text()).toBe("first-response");
  });

  it("does not leak overlapping endpoint interceptors between tests", async () => {
    server.use(
      http.get("https://example.com/specs/financial/af-cards-3ds.yaml", () =>
        new HttpResponse("second-response", { status: 200 }), { once: true }),
    );

    const resp = await fetch("https://example.com/specs/financial/af-cards-3ds.yaml");
    expect(await resp.text()).toBe("second-response");
  });
});
