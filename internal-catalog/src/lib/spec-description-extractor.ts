/**
 * OpenAPI spec description extractor.
 *
 * Imports pre-extracted spec descriptions from a build-time generated JSON file.
 * The JSON is produced by scripts/extract-spec-descriptions.mjs during `npm run build`.
 */

import specDescriptionsRaw from "../../specs/spec-descriptions.json";

export interface SpecDescription {
  description: string;
  endpointSummaries: string[];
}

const EMPTY: SpecDescription = { description: "", endpointSummaries: [] };

const SPEC_DESCRIPTIONS = specDescriptionsRaw as Record<string, SpecDescription>;

export function getSpecDescription(specId: string): SpecDescription {
  return SPEC_DESCRIPTIONS[specId] || EMPTY;
}
