/** Teardown pipeline phase ordering and progress tracking. */

export const TEARDOWN_PHASES = [
  "lookup",
  "insights",
  "postman",
  "aws",
  "github",
  "airtable",
] as const;

const PHASE_INDEX: Record<string, number> = {
  lookup: 0,
  insights: 1,
  postman: 2,
  lambda: 3,
  iam: 3,
  ecs: 3,
  k8s: 3,
  aws: 3,
  github: 4,
  airtable: 5,
};

export interface TeardownProgress {
  stepIndex: number;
  message: string;
}

/** Map a backend SSE phase string to its ordered step index (0-5). Returns 0 for unknown phases. */
export function phaseToIndex(phase: string): number {
  return PHASE_INDEX[phase] ?? 0;
}
