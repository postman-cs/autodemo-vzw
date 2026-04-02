import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildUnauthenticatedResponse,
  getCookieValue,
  isAuthBypassPath,
  isLocalDevAuthBypassEnabled,
  normalizeLocalDevAuthMode,
  normalizeCfAccessConfig,
  validateCfAccessRequest,
  resetJwksCache,
} from "../src/lib/auth";

describe("normalizeCfAccessConfig", () => {
  it("is disabled when AUTH_ENABLED is falsy", () => {
    const cfg = normalizeCfAccessConfig({});
    expect(cfg.enabled).toBe(false);
  });

  it("is disabled when team domain or aud is missing", () => {
    const cfg = normalizeCfAccessConfig({ AUTH_ENABLED: "true", CF_ACCESS_TEAM_DOMAIN: "test" });
    expect(cfg.enabled).toBe(false);
  });

  it("is enabled when all fields are present", () => {
    const cfg = normalizeCfAccessConfig({
      AUTH_ENABLED: "true",
      CF_ACCESS_TEAM_DOMAIN: "myteam",
      CF_ACCESS_AUD: "aud-123",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.teamDomain).toBe("myteam");
    expect(cfg.aud).toBe("aud-123");
    expect(cfg.logoutUrl).toBe("https://myteam.cloudflareaccess.com/cdn-cgi/access/logout");
  });
});

describe("normalizeLocalDevAuthMode", () => {
  it("defaults to strict mode", () => {
    expect(normalizeLocalDevAuthMode({})).toBe("strict");
  });

  it("accepts bypass mode", () => {
    expect(normalizeLocalDevAuthMode({ LOCAL_DEV_AUTH_MODE: "bypass" })).toBe("bypass");
  });
});

describe("isLocalDevAuthBypassEnabled", () => {
  it("allows localhost requests in bypass mode", () => {
    const request = new Request("http://localhost:5173/api/config");

    expect(isLocalDevAuthBypassEnabled(request, { AUTH_ENABLED: "true", LOCAL_DEV_AUTH_MODE: "bypass" })).toBe(true);
  });

  it("does not allow localhost requests in strict mode", () => {
    const request = new Request("http://localhost:5173/api/config");

    expect(isLocalDevAuthBypassEnabled(request, { AUTH_ENABLED: "true", LOCAL_DEV_AUTH_MODE: "strict" })).toBe(false);
  });

  it("does not allow non-local requests in bypass mode", () => {
    const request = new Request("https://se.pm-catalog.dev/api/config");

    expect(isLocalDevAuthBypassEnabled(request, { AUTH_ENABLED: "true", LOCAL_DEV_AUTH_MODE: "bypass" })).toBe(false);
  });
});

describe("validateCfAccessRequest", () => {
  const TEST_AUD = "test-audience-tag";
  const TEST_TEAM = "testteam";

  let rsaKeyPair: CryptoKeyPair;
  let jwkPublic: JsonWebKey;
  const kid = "test-kid-1";

  beforeEach(async () => {
    resetJwksCache();

    rsaKeyPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );

    jwkPublic = await crypto.subtle.exportKey("jwk", rsaKeyPair.publicKey);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetJwksCache();
  });

  function b64url(data: Uint8Array): string {
    let binary = "";
    for (const byte of data) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function signJwt(payload: Record<string, unknown>): Promise<string> {
    const encoder = new TextEncoder();
    const header = { alg: "RS256", kid, typ: "JWT" };
    const headerB64 = b64url(encoder.encode(JSON.stringify(header)));
    const payloadB64 = b64url(encoder.encode(JSON.stringify(payload)));
    const signatureInput = `${headerB64}.${payloadB64}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsaKeyPair.privateKey, encoder.encode(signatureInput));
    return `${signatureInput}.${b64url(new Uint8Array(sig))}`;
  }

  function mockJwks(): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (url.includes("/cdn-cgi/access/certs")) {
        return new Response(JSON.stringify({
          keys: [{ ...jwkPublic, kid, alg: "RS256" }],
          public_cert: [],
          public_certs: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    });
  }

  function makeEnv() {
    return {
      AUTH_ENABLED: "true",
      CF_ACCESS_TEAM_DOMAIN: TEST_TEAM,
      CF_ACCESS_AUD: TEST_AUD,
    };
  }

  it("returns claims for a valid JWT", async () => {
    mockJwks();
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt({
      sub: "user-123",
      email: "jared@postman.com",
      iss: `https://${TEST_TEAM}.cloudflareaccess.com`,
      aud: [TEST_AUD],
      iat: now - 10,
      exp: now + 3600,
      type: "app",
      identity_nonce: "nonce-1",
      country: "US",
    });

    const request = new Request("https://se.pm-catalog.dev/api/config", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    });

    const claims = await validateCfAccessRequest(request, makeEnv());
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("user-123");
    expect(claims!.email).toBe("jared@postman.com");
    expect(claims!.aud).toEqual([TEST_AUD]);
  });

  it("returns null for expired JWT", async () => {
    mockJwks();
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt({
      sub: "user-123",
      email: "jared@postman.com",
      aud: [TEST_AUD],
      iat: now - 7200,
      exp: now - 3600,
      type: "app",
    });

    const request = new Request("https://se.pm-catalog.dev/api/config", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    });

    const claims = await validateCfAccessRequest(request, makeEnv());
    expect(claims).toBeNull();
  });

  it("returns null for wrong audience", async () => {
    mockJwks();
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt({
      sub: "user-123",
      email: "jared@postman.com",
      aud: ["wrong-audience"],
      iat: now - 10,
      exp: now + 3600,
      type: "app",
    });

    const request = new Request("https://se.pm-catalog.dev/api/config", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    });

    const claims = await validateCfAccessRequest(request, makeEnv());
    expect(claims).toBeNull();
  });

  it("returns null when header is missing", async () => {
    const request = new Request("https://se.pm-catalog.dev/api/config");
    const claims = await validateCfAccessRequest(request, makeEnv());
    expect(claims).toBeNull();
  });

  it("returns null when auth is disabled", async () => {
    const request = new Request("https://se.pm-catalog.dev/api/config", {
      headers: { "Cf-Access-Jwt-Assertion": "some.jwt.token" },
    });
    const claims = await validateCfAccessRequest(request, { AUTH_ENABLED: "false" });
    expect(claims).toBeNull();
  });

  it("returns null for tampered signature", async () => {
    mockJwks();
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt({
      sub: "user-123",
      email: "jared@postman.com",
      aud: [TEST_AUD],
      iat: now - 10,
      exp: now + 3600,
      type: "app",
    });

    const tampered = jwt.slice(0, -4) + "XXXX";
    const request = new Request("https://se.pm-catalog.dev/api/config", {
      headers: { "Cf-Access-Jwt-Assertion": tampered },
    });

    const claims = await validateCfAccessRequest(request, makeEnv());
    expect(claims).toBeNull();
  });
});

describe("cookie helpers", () => {
  it("reads cookie value by name", () => {
    const value = getCookieValue("a=1; portal_session=abc123; z=9", "portal_session");
    expect(value).toBe("abc123");
  });

  it("returns null for missing cookie", () => {
    expect(getCookieValue("a=1", "missing")).toBeNull();
    expect(getCookieValue(null, "any")).toBeNull();
  });
});

describe("auth gate helpers", () => {
  it("allows health, logout, and static paths to bypass auth guard", () => {
    expect(isAuthBypassPath("/api/health")).toBe(true);
    expect(isAuthBypassPath("/api/health/")).toBe(true);
    expect(isAuthBypassPath("/auth/logout")).toBe(true);
    expect(isAuthBypassPath("/auth/logout/")).toBe(true);
    expect(isAuthBypassPath("/assets/app.js")).toBe(true);
    expect(isAuthBypassPath("/favicon.ico")).toBe(true);
    expect(isAuthBypassPath("/specs/financial/af-cards-3ds.yaml")).toBe(true);
    expect(isAuthBypassPath("/specs/healthcare/hc-patients.yaml")).toBe(true);
  });

  it("requires auth for app and non-bypass api routes", () => {
    expect(isAuthBypassPath("/")).toBe(false);
    expect(isAuthBypassPath("/provision")).toBe(false);
    expect(isAuthBypassPath("/api/config")).toBe(false);
    expect(isAuthBypassPath("/auth/login")).toBe(false);
    expect(isAuthBypassPath("/auth/callback")).toBe(false);
  });

  it("returns 401 JSON response for unauthenticated API requests", async () => {
    const response = buildUnauthenticatedResponse(
      new Request("https://example.com/api/health"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 403 for unauthenticated non-API requests (defense-in-depth)", () => {
    const response = buildUnauthenticatedResponse(
      new Request("https://example.com/provision"),
    );
    expect(response.status).toBe(403);
  });
});
