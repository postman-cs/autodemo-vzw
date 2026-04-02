export interface InstallationToken {
  token: string;
  expires_at: string;
}

const JWT_VALIDITY_SECONDS = 9 * 60;
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;

interface CachedInstallationToken {
  token: string;
  expiresAtMs: number;
}

type BufferLike = {
  from(input: Uint8Array | string, encoding?: string): { toString(encoding: string): string } | Uint8Array;
};

function getBuffer(): BufferLike | null {
  const maybeBuffer = (globalThis as typeof globalThis & { Buffer?: BufferLike }).Buffer;
  return maybeBuffer ?? null;
}

const installationTokenCache = new Map<string, CachedInstallationToken>();

function b64urlEncode(bytes: Uint8Array): string {
  let base64 = "";
  const buffer = getBuffer();
  if (buffer) {
    base64 = (buffer.from(bytes) as { toString(encoding: string): string }).toString("base64");
  } else {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    base64 = btoa(binary);
  }
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const buffer = getBuffer();
  if (buffer) {
    return new Uint8Array(buffer.from(base64, "base64") as Uint8Array);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function pemToPkcs8Bytes(pemPrivateKey: string): Uint8Array {
  const raw = String(pemPrivateKey || "");
  const isRsa = raw.includes("BEGIN RSA PRIVATE KEY");

  const normalized = raw
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, "")
    .replace(/-----END (RSA )?PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "")
    .trim();
  if (!normalized) {
    throw new Error("GitHub App private key is empty");
  }

  const derBytes = decodeBase64ToBytes(normalized);

  if (!isRsa) {
    // Already PKCS#8
    return derBytes;
  }

  // Wrap PKCS#1 RSA key in PKCS#8 ASN.1 envelope
  // PKCS#8 = SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { pkcs1 } }
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaOid = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const algSeq = wrapAsn1(0x30, rsaOid);
  const keyOctet = wrapAsn1(0x04, derBytes);
  return wrapAsn1(0x30, concatBytes(concatBytes(version, algSeq), keyOctet));
}

function wrapAsn1(tag: number, content: Uint8Array): Uint8Array {
  const len = content.length;
  let header: number[];
  if (len < 0x80) {
    header = [tag, len];
  } else if (len < 0x100) {
    header = [tag, 0x81, len];
  } else if (len < 0x10000) {
    header = [tag, 0x82, (len >> 8) & 0xff, len & 0xff];
  } else {
    header = [tag, 0x83, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff];
  }
  const result = new Uint8Array(header.length + len);
  result.set(header);
  result.set(content, header.length);
  return result;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}

export async function createAppJwt(
  appId: string,
  pemPrivateKey: string,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const normalizedAppId = String(appId || "").trim();
  if (!normalizedAppId) {
    throw new Error("GitHub App ID is required");
  }

  const headerBytes = new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payloadBytes = new TextEncoder().encode(JSON.stringify({
    iat: nowEpochSeconds - 60,
    exp: nowEpochSeconds + JWT_VALIDITY_SECONDS,
    iss: normalizedAppId,
  }));

  const header = b64urlEncode(headerBytes);
  const payload = b64urlEncode(payloadBytes);
  const signingInput = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8Bytes(pemPrivateKey) as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${b64urlEncode(new Uint8Array(signatureBuffer))}`;
}

export async function getInstallationToken(
  appId: string,
  installationId: string,
  pemPrivateKey: string,
): Promise<InstallationToken> {
  const jwt = await createAppJwt(appId, pemPrivateKey);
  const normalizedInstallationId = String(installationId || "").trim();
  if (!normalizedInstallationId) {
    throw new Error("GitHub App installation ID is required");
  }

  const resp = await fetch(
    `https://api.github.com/app/installations/${normalizedInstallationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!resp.ok) {
    const details = await resp.text().catch(() => "");
    const suffix = details ? ` ${details}` : "";
    throw new Error(`Failed to create installation token: ${resp.status}${suffix}`.trim());
  }

  return (await resp.json()) as InstallationToken;
}

export async function getCachedInstallationToken(
  appId: string,
  installationId: string,
  pemPrivateKey: string,
): Promise<string> {
  const cacheKey = `${appId}:${installationId}`;
  const now = Date.now();
  const cached = installationTokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - TOKEN_EXPIRY_SAFETY_MARGIN_MS > now) {
    return cached.token;
  }

  const fresh = await getInstallationToken(appId, installationId, pemPrivateKey);
  const expiresAtMs = Date.parse(fresh.expires_at);
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error(`Invalid installation token expiry: ${fresh.expires_at}`);
  }

  installationTokenCache.set(cacheKey, {
    token: fresh.token,
    expiresAtMs,
  });

  return fresh.token;
}

export function clearInstallationTokenCache(): void {
  installationTokenCache.clear();
}
