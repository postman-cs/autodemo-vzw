import { describe, expect, it } from "vitest";
import { buildCanonicalManifest } from "../src/lib/docs-manifest";
import { buildDeploymentPatch, buildRepoVariablePlan, buildServiceIndex } from "../scripts/backfill-urls";

describe("backfill-urls", () => {
  it("produces no patch when deployment and repo metadata are already canonical", () => {
    const manifest = buildCanonicalManifest([
      {
        spec_id: "vzw-city-dispatch-api",
        status: "active",
        workspace_team_id: "ws-123",
        github_repo_name: "af-vzw-city-dispatch-api",
        fern_docs_url: "https://verizon-demo.docs.buildwithfern.com/emergency-dispatch/vzw-city-dispatch-api",
        postman_workspace_url: "https://verizon-partner-demo.postman.co/workspace/ws-123",
      },
    ]);
    const serviceIndex = buildServiceIndex(manifest);
    const service = serviceIndex.get("vzw-city-dispatch-api");

    expect(service).toBeDefined();
    expect(buildDeploymentPatch({
      spec_id: "vzw-city-dispatch-api",
      status: "active",
      workspace_team_id: "ws-123",
      github_repo_name: "af-vzw-city-dispatch-api",
      fern_docs_url: service?.fernDocsUrl,
      postman_workspace_url: service?.postmanWorkspaceUrl,
      run_in_postman_url: service?.postmanWorkspaceUrl,
      postman_run_url: service?.postmanWorkspaceUrl,
    } as any, service!)).toBeNull();
    expect(buildRepoVariablePlan({
      FERN_DOCS_URL: service?.fernDocsUrl || "",
      POSTMAN_RUN_URL: service?.postmanWorkspaceUrl || "",
    }, service!)).toEqual([]);
  });

  it("returns canonical fern and postman targets when metadata is stale", () => {
    const manifest = buildCanonicalManifest([
      {
        spec_id: "vzw-city-dispatch-api",
        status: "active",
        workspace_team_id: "ws-123",
        github_repo_name: "af-vzw-city-dispatch-api",
      },
    ]);
    const service = buildServiceIndex(manifest).get("vzw-city-dispatch-api");

    expect(service).toBeDefined();

    expect(buildDeploymentPatch({
      spec_id: "vzw-city-dispatch-api",
      status: "active",
      workspace_team_id: "ws-123",
      github_repo_name: "af-vzw-city-dispatch-api",
      fern_docs_url: "https://old.example/docs",
      postman_workspace_url: "https://old.example/workspace",
      run_in_postman_url: "https://old.example/workspace",
    } as any, service!)).toEqual({
      fern_docs_url: service?.fernDocsUrl,
      postman_workspace_url: service?.postmanWorkspaceUrl,
      run_in_postman_url: service?.postmanWorkspaceUrl,
      postman_run_url: service?.postmanWorkspaceUrl,
    });
  });
});
