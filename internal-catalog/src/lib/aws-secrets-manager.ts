/**
 * Worker-safe AWS Secrets Manager client with SigV4 signing via Web Crypto.
 * No external dependencies. Uses fetch() which goes through Cloudflare's HTTP
 * stack, bypassing the Python/urllib3 IPv6 hang that affects the AWS CLI locally.
 */

const SERVICE = "secretsmanager";
const CONTENT_TYPE = "application/x-amz-json-1.1";
const encoder = new TextEncoder();

export interface AwsSecretsManagerEnv {
  TENANT_SECRETS_SYNC_ENABLED?: string;
  TENANT_SECRETS_AWS_REGION?: string;
  TENANT_SECRETS_AWS_ACCESS_KEY_ID?: string;
  TENANT_SECRETS_AWS_SECRET_ACCESS_KEY?: string;
  TENANT_SECRETS_AWS_SESSION_TOKEN?: string;
  TENANT_SECRETS_PREFIX?: string;
}

export interface AwsSecretsManagerConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  endpoint: string;
}

export interface SecretTag {
  Key: string;
  Value: string;
}

export class AwsSecretsManagerError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly raw?: unknown;

  constructor(code: string, message: string, httpStatus: number, raw?: unknown) {
    super(message);
    this.name = "AwsSecretsManagerError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.raw = raw;
  }
}

function parseBool(value: unknown, defaultValue = true): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return defaultValue;
  return ["1", "true", "yes", "on"].includes(normalized);
}

export function isTenantSecretSyncEnabled(env: AwsSecretsManagerEnv): boolean {
  return parseBool(env.TENANT_SECRETS_SYNC_ENABLED, true);
}

export function getTenantSecretsPrefix(env: AwsSecretsManagerEnv): string {
  return String(env.TENANT_SECRETS_PREFIX || "/postman/tenants").replace(/\/+$/, "") || "/postman/tenants";
}

export function resolveAwsSecretsManagerConfig(env: AwsSecretsManagerEnv): AwsSecretsManagerConfig {
  const region = String(env.TENANT_SECRETS_AWS_REGION || "eu-central-1").trim();
  const accessKeyId = String(env.TENANT_SECRETS_AWS_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(env.TENANT_SECRETS_AWS_SECRET_ACCESS_KEY || "").trim();
  const sessionToken = String(env.TENANT_SECRETS_AWS_SESSION_TOKEN || "").trim() || undefined;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Tenant secret sync is enabled but AWS credentials are not configured in Worker secrets.");
  }

  return {
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    endpoint: `https://secretsmanager.${region}.amazonaws.com/`,
  };
}

// -- SigV4 signing primitives --

function toUint8Array(value: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value);
}

function toHex(value: Uint8Array | ArrayBuffer): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toHex(digest);
}

async function hmac(key: string | Uint8Array, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toUint8Array(key) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
  return new Uint8Array(signature);
}

function getAmzDate(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

async function buildAuthorizationHeader(args: {
  config: AwsSecretsManagerConfig;
  now: Date;
  target: string;
  payload: string;
}): Promise<Headers> {
  const { config, now, target, payload } = args;
  const url = new URL(config.endpoint);
  const { amzDate, dateStamp } = getAmzDate(now);
  const host = url.host;
  const payloadHash = await sha256Hex(payload);

  const canonicalHeaderPairs: Array<[string, string]> = [
    ["content-type", CONTENT_TYPE],
    ["host", host],
    ["x-amz-date", amzDate],
    ["x-amz-target", `secretsmanager.${target}`],
  ];
  if (config.sessionToken) canonicalHeaderPairs.push(["x-amz-security-token", config.sessionToken]);
  canonicalHeaderPairs.sort(([a], [b]) => a.localeCompare(b));

  const canonicalHeaders = canonicalHeaderPairs.map(([k, v]) => `${k}:${v.trim()}\n`).join("");
  const signedHeaders = canonicalHeaderPairs.map(([k]) => k).join(";");
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${config.region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = await hmac(kDate, config.region);
  const kService = await hmac(kRegion, SERVICE);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  const authorization = [
    "AWS4-HMAC-SHA256",
    `Credential=${config.accessKeyId}/${credentialScope},`,
    `SignedHeaders=${signedHeaders},`,
    `Signature=${signature}`,
  ].join(" ");

  const headers = new Headers({
    "Content-Type": CONTENT_TYPE,
    "Host": host,
    "X-Amz-Date": amzDate,
    "X-Amz-Target": `secretsmanager.${target}`,
    "Authorization": authorization,
  });
  if (config.sessionToken) headers.set("X-Amz-Security-Token", config.sessionToken);

  return headers;
}

// -- API calls --

export async function secretsManagerCall<T>(args: {
  config: AwsSecretsManagerConfig;
  target: string;
  payload: Record<string, unknown>;
  now?: Date;
}): Promise<T> {
  const now = args.now ?? new Date();
  const payloadStr = JSON.stringify(args.payload);
  const headers = await buildAuthorizationHeader({
    config: args.config,
    now,
    target: args.target,
    payload: payloadStr,
  });

  const response = await fetch(args.config.endpoint, {
    method: "POST",
    headers,
    body: payloadStr,
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const rawCode = String(parsed.__type || parsed.code || parsed.Code || "SecretsManagerError");
    const code = rawCode.includes("#") ? rawCode.split("#").pop() as string : rawCode;
    const message = String(parsed.Message || parsed.message || response.statusText || code);
    throw new AwsSecretsManagerError(code, message, response.status, parsed);
  }

  return parsed as T;
}

export function isAwsErrorCode(error: unknown, code: string): boolean {
  return error instanceof AwsSecretsManagerError && error.code === code;
}

// -- High-level operations --

export async function getSecretString(config: AwsSecretsManagerConfig, secretId: string): Promise<string | null> {
  const result = await secretsManagerCall<{ SecretString?: string }>({
    config,
    target: "GetSecretValue",
    payload: { SecretId: secretId },
  });
  return typeof result.SecretString === "string" ? result.SecretString : null;
}

export async function createSecret(args: {
  config: AwsSecretsManagerConfig;
  name: string;
  description: string;
  value: string;
  tags?: SecretTag[];
}): Promise<void> {
  await secretsManagerCall({
    config: args.config,
    target: "CreateSecret",
    payload: {
      Name: args.name,
      Description: args.description,
      SecretString: args.value,
      ClientRequestToken: crypto.randomUUID(),
      Tags: args.tags ?? [],
    },
  });
}

export async function putSecretValue(args: {
  config: AwsSecretsManagerConfig;
  secretId: string;
  value: string;
}): Promise<void> {
  await secretsManagerCall({
    config: args.config,
    target: "PutSecretValue",
    payload: {
      SecretId: args.secretId,
      SecretString: args.value,
      ClientRequestToken: crypto.randomUUID(),
    },
  });
}

export async function tagResource(args: {
  config: AwsSecretsManagerConfig;
  secretId: string;
  tags: SecretTag[];
}): Promise<void> {
  if (!args.tags.length) return;
  await secretsManagerCall({
    config: args.config,
    target: "TagResource",
    payload: {
      SecretId: args.secretId,
      Tags: args.tags,
    },
  });
}

export async function restoreSecret(config: AwsSecretsManagerConfig, secretId: string): Promise<void> {
  await secretsManagerCall({
    config,
    target: "RestoreSecret",
    payload: { SecretId: secretId },
  });
}

export async function deleteSecret(args: {
  config: AwsSecretsManagerConfig;
  secretId: string;
  recoveryWindowInDays?: number;
  forceDeleteWithoutRecovery?: boolean;
}): Promise<void> {
  await secretsManagerCall({
    config: args.config,
    target: "DeleteSecret",
    payload: {
      SecretId: args.secretId,
      ...(args.forceDeleteWithoutRecovery
        ? { ForceDeleteWithoutRecovery: true }
        : { RecoveryWindowInDays: args.recoveryWindowInDays ?? 7 }),
    },
  });
}

// -- Authority discovery operations --

export interface ListSecretsEntry {
  Name: string;
  Tags?: SecretTag[];
  LastChangedDate?: number;
  DeletedDate?: number;
}

export async function listSecrets(
  config: AwsSecretsManagerConfig,
  filters: Array<{ Key: string; Values: string[] }>,
): Promise<ListSecretsEntry[]> {
  const results: ListSecretsEntry[] = [];
  let nextToken: string | undefined;

  do {
    const payload: Record<string, unknown> = {
      Filters: filters,
      MaxResults: 100,
    };
    if (nextToken) payload.NextToken = nextToken;

    const page = await secretsManagerCall<{
      SecretList?: ListSecretsEntry[];
      NextToken?: string;
    }>({
      config,
      target: "ListSecrets",
      payload,
    });

    if (Array.isArray(page.SecretList)) {
      results.push(...page.SecretList);
    }
    nextToken = page.NextToken;
  } while (nextToken);

  return results;
}

export interface BatchSecretEntry {
  Name: string;
  SecretString?: string;
}

export async function batchGetSecretValue(
  config: AwsSecretsManagerConfig,
  secretIds: string[],
): Promise<BatchSecretEntry[]> {
  if (secretIds.length === 0) return [];

  const result = await secretsManagerCall<{
    SecretValues?: BatchSecretEntry[];
    Errors?: Array<{ SecretId: string; ErrorCode: string; Message: string }>;
  }>({
    config,
    target: "BatchGetSecretValue",
    payload: { SecretIdList: secretIds },
  });

  return Array.isArray(result.SecretValues) ? result.SecretValues : [];
}
