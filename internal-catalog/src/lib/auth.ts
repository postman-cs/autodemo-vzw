// Cloudflare Access JWT validation for worker auth.
// CF Access handles login, IdP integration, and org policy enforcement at the edge.
// The worker validates the Cf-Access-Jwt-Assertion header as defense-in-depth.

const STATIC_EXT_RE = /\.[a-zA-Z0-9]+$/;
const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;

export interface CfAccessClaims {
  sub: string;
  email: string;
  iss: string;
  aud: string[];
  iat: number;
  exp: number;
  type: string;
  identity_nonce: string;
  country: string;
}

export interface CfAccessConfig {
  enabled: boolean;
  teamDomain: string;
  aud: string;
  logoutUrl: string;
}

export type LocalDevAuthMode = "strict" | "bypass";

interface JwksKey {
  kid: string;
  kty: string;
  alg: string;
  n: string;
  e: string;
  use?: string;
}

interface JwksResponse {
  keys: JwksKey[];
  public_cert: { kid: string; cert: string }[];
  public_certs: { kid: string; cert: string }[];
}

let _jwksCache: { keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === "localhost"
    || host === "127.0.0.1"
    || host === "::1"
    || host === "[::1]"
    || host === "0.0.0.0";
}

function readGlobalProcessEnv(key: string): string {
  const processValue = Reflect.get(globalThis, "process");
  if (typeof processValue !== "object" || processValue === null) return "";
  const envValue = Reflect.get(processValue, "env");
  if (typeof envValue !== "object" || envValue === null) return "";
  return readString(Reflect.get(envValue, key));
}

function readLocalDevAuthModeValue(env: Record<string, unknown>): string {
  return (readString(env.LOCAL_DEV_AUTH_MODE) || readGlobalProcessEnv("LOCAL_DEV_AUTH_MODE")).toLowerCase();
}

export function normalizeLocalDevAuthMode(env: Record<string, unknown>): LocalDevAuthMode {
  const raw = readLocalDevAuthModeValue(env);
  return raw === "bypass" ? "bypass" : "strict";
}

export function isLocalDevAuthBypassEnabled(
  request: Request,
  env: Record<string, unknown>,
): boolean {
  if (!parseBoolean(env.AUTH_ENABLED)) return false;

  try {
    const isLoopbackRequest = isLoopbackHost(new URL(request.url).hostname);
    if (!isLoopbackRequest) return false;

    return normalizeLocalDevAuthMode(env) === "bypass";
  } catch {
    return false;
  }
}

function fromBase64Url(input: string): Uint8Array | null {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  try {
    const binary = atob(padded);
    const output = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) output[i] = binary.charCodeAt(i);
    return output;
  } catch {
    return null;
  }
}

function decodeJwtParts(token: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signatureInput: string; signature: Uint8Array } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  const headerBytes = fromBase64Url(headerB64);
  const payloadBytes = fromBase64Url(payloadB64);
  const signature = fromBase64Url(sigB64);

  if (!headerBytes || !payloadBytes || !signature) return null;

  try {
    const header = JSON.parse(new TextDecoder().decode(headerBytes)) as Record<string, unknown>;
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<string, unknown>;
    return { header, payload, signatureInput: `${headerB64}.${payloadB64}`, signature };
  } catch {
    return null;
  }
}

async function importRsaPublicKey(jwk: JwksKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

async function fetchJwks(teamDomain: string): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (_jwksCache && now - _jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
    return _jwksCache.keys;
  }

  const url = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`);

  const data = (await resp.json()) as JwksResponse;
  const keys = new Map<string, CryptoKey>();

  for (const jwk of data.keys) {
    if (jwk.kty === "RSA" && (jwk.alg === "RS256" || !jwk.alg)) {
      keys.set(jwk.kid, await importRsaPublicKey(jwk));
    }
  }

  _jwksCache = { keys, fetchedAt: now };
  return keys;
}

export function resetJwksCache(): void {
  _jwksCache = null;
}

export function normalizeCfAccessConfig(env: Record<string, unknown>): CfAccessConfig {
  const teamDomain = readString(env.CF_ACCESS_TEAM_DOMAIN);
  const aud = readString(env.CF_ACCESS_AUD);
  const enabled = parseBoolean(env.AUTH_ENABLED) && !!teamDomain && !!aud;

  return {
    enabled,
    teamDomain,
    aud,
    logoutUrl: teamDomain ? `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/logout` : "",
  };
}

export async function validateCfAccessRequest(
  request: Request,
  env: Record<string, unknown>,
): Promise<CfAccessClaims | null> {
  const config = normalizeCfAccessConfig(env);
  if (!config.enabled) return null;

  const jwt =
    request.headers.get("Cf-Access-Jwt-Assertion") ||
    getCookieValue(request.headers.get("Cookie"), "CF_Authorization") ||
    "";
  if (!jwt) return null;

  const decoded = decodeJwtParts(jwt);
  if (!decoded) return null;

  const { header, payload, signatureInput, signature } = decoded;
  if (header.alg !== "RS256") return null;

  const kid = typeof header.kid === "string" ? header.kid : "";
  if (!kid) return null;

  let keys: Map<string, CryptoKey>;
  try {
    keys = await fetchJwks(config.teamDomain);
  } catch {
    return null;
  }

  let key = keys.get(kid);
  if (!key) {
    resetJwksCache();
    try {
      keys = await fetchJwks(config.teamDomain);
    } catch {
      return null;
    }
    key = keys.get(kid);
    if (!key) return null;
  }

  const encoder = new TextEncoder();
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature as BufferSource,
    encoder.encode(signatureInput),
  );
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  if (exp <= now) return null;

  const aud = Array.isArray(payload.aud) ? payload.aud : typeof payload.aud === "string" ? [payload.aud] : [];
  if (!aud.includes(config.aud)) return null;

  return {
    sub: typeof payload.sub === "string" ? payload.sub : "",
    email: typeof payload.email === "string" ? payload.email : "",
    iss: typeof payload.iss === "string" ? payload.iss : "",
    aud,
    iat: typeof payload.iat === "number" ? payload.iat : 0,
    exp,
    type: typeof payload.type === "string" ? payload.type : "",
    identity_nonce: typeof payload.identity_nonce === "string" ? payload.identity_nonce : "",
    country: typeof payload.country === "string" ? payload.country : "",
  };
}

export function getCookieValue(cookieHeader: string | null | undefined, cookieName: string): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    if (key !== cookieName) continue;
    const value = trimmed.slice(idx + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

export function isAuthBypassPath(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === "/api/health" || normalized === "/auth/logout") return true;
  if (normalized === "/api/provision" || normalized === "/api/provision/plan" || normalized === "/api/deployments") return true;
  if (normalized.startsWith("/api/partner/")) return true;
  if (normalized.startsWith("/api/public/")) return true;
  if (normalized.startsWith("/assets/") || normalized.startsWith("/specs/")) return true;
  return STATIC_EXT_RE.test(normalized);
}

export function buildUnauthenticatedResponse(request: Request): Response {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  return new Response(null, {
    status: 403,
    headers: { "Content-Type": "text/plain" },
  });
}
