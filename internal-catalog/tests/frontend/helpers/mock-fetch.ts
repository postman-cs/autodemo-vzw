type Handler = () => Response | Promise<Response>;

type HandlerMap = Record<string, Handler>;

const originalFetch = globalThis.fetch;

export function mockFetch(handlers: HandlerMap): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url === pattern || url.includes(pattern)) {
        return handler();
      }
    }

    return new Response(JSON.stringify({ error: `No mock for ${url}` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  };
}

export function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
