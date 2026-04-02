import { getSecretString } from "./aws-secrets-manager";
import { type WorkerSecretBundle, type SmBootstrapCredentials, SM_SECRET_PATH } from "./worker-secret-bundle";

let _cachedBundle: WorkerSecretBundle | null = null;
let _inflight: Promise<WorkerSecretBundle> | null = null;

async function fetchBundleFromSM(bootstrap: SmBootstrapCredentials): Promise<WorkerSecretBundle> {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION } = bootstrap;

  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_REGION) {
    console.warn("[worker-config-cache] Bootstrap credentials incomplete — skipping SM fetch");
    return {};
  }

  try {
    const config = {
      region: AWS_REGION,
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
      endpoint: `https://secretsmanager.${AWS_REGION}.amazonaws.com/`,
    };

    const raw = await getSecretString(config, SM_SECRET_PATH);
    if (!raw) {
      console.warn("[worker-config-cache] SM secret has no SecretString");
      return {};
    }

    try {
      return JSON.parse(raw) as WorkerSecretBundle;
    } catch {
      console.error("[worker-config-cache] Failed to parse SM SecretString as JSON");
      return {};
    }
  } catch (err) {
    console.error("[worker-config-cache] Unexpected error fetching from SM:", err);
    return {};
  }
}

export async function getWorkerSecretBundle(
  bootstrap: SmBootstrapCredentials,
): Promise<WorkerSecretBundle> {
  if (_cachedBundle !== null) return _cachedBundle;
  if (_inflight !== null) return _inflight;

  _inflight = fetchBundleFromSM(bootstrap).then((bundle) => {
    _cachedBundle = bundle;
    _inflight = null;
    return bundle;
  });

  return _inflight;
}

export function invalidateWorkerSecretBundleCache(): void {
  _cachedBundle = null;
  _inflight = null;
}
