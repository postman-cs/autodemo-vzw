interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  INTERNAL_CATALOG_ORIGIN: string;
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Proxy /api/partner/* to the internal catalog with service token auth
    if (url.pathname.startsWith("/api/partner/")) {
      const target = new URL(url.pathname + url.search, env.INTERNAL_CATALOG_ORIGIN);
      const proxyHeaders = new Headers(request.headers);
      proxyHeaders.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
      proxyHeaders.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);

      const upstream = await fetch(target.toString(), {
        method: request.method,
        headers: proxyHeaders,
      });

      // Pass through response with CORS headers for partner portal
      const response = new Response(upstream.body, {
        status: upstream.status,
        headers: upstream.headers,
      });
      response.headers.set("Access-Control-Allow-Origin", "*");
      response.headers.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
      return response;
    }

    // Redirect /docs to Fern docs site
    if (url.pathname.startsWith("/docs")) {
      const fernBase = "https://vzw-demo.docs.buildwithfern.com";
      return Response.redirect(fernBase, 302);
    }

    // Serve the partner portal SPA for all other routes
    return env.ASSETS.fetch(request);
  },
};
