export interface FrozenInstallCheckResult {
  ok: boolean;
  output: string;
}

export interface CollectBunLockErrorsOptions {
  cwd?: string;
  stagedFiles?: string[];
  runFrozenInstallCheck?: (cwd: string) => FrozenInstallCheckResult;
}

export function collectBunLockErrors(options?: CollectBunLockErrorsOptions): string[];
