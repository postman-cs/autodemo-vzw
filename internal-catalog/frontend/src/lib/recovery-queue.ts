export interface RecoverableFailure {
  spec_id: string;
  reason: string;
  project_name: string;
  postman_team_slug?: string;
  error_message?: string;
  failed_at_step?: string;
  deployed_at?: string;
}

export interface RecoveryRegistryEntry {
  id: string;
  title: string;
}

export interface RecoveryQueueEntry extends RecoverableFailure {
  title: string;
  reason_label: string;
}

export type RecoveryItemRunState = "idle" | "running" | "success" | "error";

const REASON_MAP: Record<string, { label: string; cssClass: string }> = {
  github_repo_conflict: { label: "GitHub repo already exists", cssClass: "recovery-reason-conflict" },
  residual_resources: { label: "Residual resources detected", cssClass: "recovery-reason-residual" },
  stale_provisioning: { label: "Stuck provisioning", cssClass: "recovery-reason-stale" },
};

const REASON_FALLBACK = { label: "Recoverable failure", cssClass: "recovery-reason-generic" };

export function recoveryReasonLabel(reason: string): string {
  const normalized = (reason || "").trim().toLowerCase();
  return (REASON_MAP[normalized] || REASON_FALLBACK).label;
}

export function recoveryReasonClass(reason: string): string {
  const normalized = (reason || "").trim().toLowerCase();
  return (REASON_MAP[normalized] || REASON_FALLBACK).cssClass;
}

function parseDateMs(value?: string): number {
  const ms = Date.parse((value || "").trim());
  return Number.isFinite(ms) ? ms : 0;
}

export function toRecoveryQueueEntries(
  failures: RecoverableFailure[],
  registryEntries: RecoveryRegistryEntry[],
): RecoveryQueueEntry[] {
  const titleById = new Map(registryEntries.map((entry) => [entry.id, entry.title]));

  return failures
    .map((failure) => ({
      ...failure,
      title: titleById.get(failure.spec_id) || failure.project_name || failure.spec_id,
      reason_label: recoveryReasonLabel(failure.reason),
    }))
    .sort((a, b) => {
      const aMs = parseDateMs(a.deployed_at);
      const bMs = parseDateMs(b.deployed_at);
      if (aMs !== bMs) return bMs - aMs;
      return a.title.localeCompare(b.title);
    });
}

export function transitionRecoveryItemState(
  _current: RecoveryItemRunState,
  transition: "start" | "succeed" | "fail" | "reset",
): RecoveryItemRunState {
  if (transition === "start") return "running";
  if (transition === "succeed") return "success";
  if (transition === "fail") return "error";
  return "idle";
}
