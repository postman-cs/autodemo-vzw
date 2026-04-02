/**
 * Dynamic agent prompt builder.
 *
 * Generates onboarding prompts for Postman Agent Mode from service metadata
 * (registry, dependencies, OpenAPI spec descriptions) instead of static JSON.
 */

export interface AgentPromptContext {
  title: string;
  description: string;
  specDescription: string;
  endpointSummaries: string[];
  endpointCount: number;
  dependsOn: string[];
  consumesApis: string[];
  fernDocsUrl: string;
  runtime: string;
}

const STEP_IMPORT = `Import the OpenAPI spec from the linked Fern documentation into a new collection in this workspace. Organize requests by resource group, not as a flat list.`;

const STEP_AUTH = `Configure collection-level authentication. Set up any required API keys, OAuth tokens, or bearer credentials as collection variables so individual requests inherit them automatically.`;

const STEP_ENV = `Create a "Production" environment with a \`base_url\` variable pointing to the deployed service endpoint. Add any service-specific variables (IDs, tokens, region codes) that the spec references.`;

const STEP_POPULATE = `For every endpoint in the spec, populate the request body with realistic example values from the schema. Use the field descriptions and enums in the spec to choose plausible test data -- do not leave request bodies empty or use placeholder strings like "string".`;

const STEP_TESTS = `Add a basic test script to each request that asserts the response status code matches the expected success code from the spec (e.g., 200, 201, 204). For list endpoints, also assert the response body contains the expected top-level array or object key.`;

const STEP_RUN = `Run the full collection using the Production environment. Fix any failing requests before finishing.`;

function buildIntro(ctx: AgentPromptContext): string {
  const desc = ctx.specDescription || ctx.description;
  if (!desc) {
    return `Onboard the ${ctx.title} into this Postman workspace.`;
  }
  let intro = `Onboard the ${ctx.title} into this Postman workspace. ${desc}`;
  if (ctx.endpointSummaries.length > 0) {
    const caps = ctx.endpointSummaries.slice(0, 7).join(", ").toLowerCase();
    intro += ` Key capabilities include: ${caps}.`;
  }
  return intro;
}

function buildDependsOnStep(dependsOn: string[]): string {
  const list = dependsOn.join(", ");
  return `This service depends on: ${list}. Add environment variables for each upstream service base URL so cross-service request chains work end to end.`;
}

function buildConsumesStep(consumesApis: string[]): string {
  const list = consumesApis.join(", ");
  return `This service also consumes: ${list}. Include example requests that demonstrate the integration points with these APIs.`;
}

export function buildAgentPrompt(ctx: AgentPromptContext): string {
  const intro = buildIntro(ctx);
  const steps: string[] = [STEP_IMPORT, STEP_AUTH, STEP_ENV];

  if (ctx.dependsOn.length > 0) {
    steps.push(buildDependsOnStep(ctx.dependsOn));
  }
  if (ctx.consumesApis.length > 0) {
    steps.push(buildConsumesStep(ctx.consumesApis));
  }

  steps.push(STEP_POPULATE, STEP_TESTS, STEP_RUN);

  const numberedSteps = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `${intro}\n\nComplete the following steps in order:\n\n${numberedSteps}`;
}

export function buildAgentPromptTitle(title: string): string {
  return `Onboard ${title} into Postman Agent Mode`;
}
