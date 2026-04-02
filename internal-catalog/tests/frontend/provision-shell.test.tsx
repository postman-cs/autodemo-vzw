import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { renderRoute, waitForElement } from "./helpers/render";
import { clearThemeState } from "./helpers/theme-mock";
import { jsonResponse, mockFetch, restoreFetch } from "./helpers/mock-fetch";

const EMPTY_DEPLOYMENTS = { deployments: [], recoverable_failures: [] };
const EMPTY_CONFIG = { runtime: null, aws_region: "eu-central-1", github_org: "postman-cs", github_org_url: "https://github.com/postman-cs" };
const K8S_DOWN_CONFIG = {
  runtime: {
    lambda: { mode: "lambda", available: true },
    ecs_service: { mode: "ecs_service", available: true, needsSetup: false, activeServices: 0, maxServices: 100, remainingServices: 100, unavailableReason: "", infra: { maxServices: 100 } },
    k8s_workspace: { mode: "k8s_workspace", available: false, unavailableReason: "Kubernetes runtime is missing required configuration: KUBECONFIG_B64, K8S_INGRESS_BASE_DOMAIN", namespace: "vzw-partner-demo" },
    k8s_discovery: { mode: "k8s_discovery", available: false, needsSetup: false, unavailableReason: "Kubernetes runtime is missing required configuration: KUBECONFIG_B64, K8S_INGRESS_BASE_DOMAIN", namespace: "vzw-partner-demo", activeServices: 0, sharedInfraActive: false, sharedInfraStatus: "", daemonsetName: "" },
  },
  aws_region: "eu-central-1",
  github_org: "postman-cs",
  github_org_url: "https://github.com/postman-cs",
};
const GRAPH_CAPABLE_CONFIG = {
  runtime: {
    lambda: { mode: "lambda", available: true },
    ecs_service: { mode: "ecs_service", available: true, needsSetup: false, activeServices: 0, maxServices: 100, remainingServices: 100, unavailableReason: "", infra: { maxServices: 100 } },
    k8s_workspace: { mode: "k8s_workspace", available: true, unavailableReason: "", namespace: "vzw-partner-demo" },
    k8s_discovery: { mode: "k8s_discovery", available: false, needsSetup: false, unavailableReason: "Kubernetes discovery mode unavailable", namespace: "vzw-partner-demo", activeServices: 0, sharedInfraActive: false, sharedInfraStatus: "", daemonsetName: "" },
  },
  aws_region: "eu-central-1",
  github_org: "postman-cs",
  github_org_url: "https://github.com/postman-cs",
};
const EMPTY_REGISTRY = { teams: [] };
const EMPTY_USERS = { users: [] };
const EMPTY_SYSTEM_ENVS = { system_environments: [] };
const EMPTY_ORG_MEMBERS = { members: [] };
const PLAN_RESPONSE = {
  plan: {
    deployment_mode: "single",
    root_spec_id: "payments-api",
    runtime: "lambda",
    environments: ["prod"],
    hard_closure_spec_ids: ["payments-api"],
    soft_neighbor_spec_ids: [],
    layers: [{ layer_index: 0, spec_ids: ["payments-api"] }],
    nodes: [],
    summary: {
      total_nodes: 1,
      reuse_count: 0,
      attach_count: 0,
      provision_count: 1,
      blocked_count: 0,
    },
    single_mode_guidance: {
      recommend_graph_mode: false,
      missing_hard_prerequisites: [],
    },
  },
  warnings: [],
};

function setupDefaultMocks(): void {
  mockFetch({
    "/api/deployments": () => jsonResponse(EMPTY_DEPLOYMENTS),
    "/api/config": () => jsonResponse(EMPTY_CONFIG),
    "/api/teams/registry": () => jsonResponse(EMPTY_REGISTRY),
    "/api/users": () => jsonResponse(EMPTY_USERS),
    "/api/system-envs": () => jsonResponse(EMPTY_SYSTEM_ENVS),
    "/api/github/org-members": () => jsonResponse(EMPTY_ORG_MEMBERS),
    "/api/provision/plan": () => jsonResponse(PLAN_RESPONSE),
  });
}

function setupGraphCapableMocks(): void {
  mockFetch({
    "/api/deployments": () => jsonResponse(EMPTY_DEPLOYMENTS),
    "/api/config": () => jsonResponse(GRAPH_CAPABLE_CONFIG),
    "/api/teams/registry": () => jsonResponse(EMPTY_REGISTRY),
    "/api/users": () => jsonResponse(EMPTY_USERS),
    "/api/system-envs": () => jsonResponse(EMPTY_SYSTEM_ENVS),
    "/api/github/org-members": () => jsonResponse(EMPTY_ORG_MEMBERS),
    "/api/provision/plan": () => jsonResponse(PLAN_RESPONSE),
  });
}

async function selectTelecomIndustry(container: HTMLElement): Promise<void> {
  await waitForElement("[data-step-panel='target'] button.industry-card", container);
  const telecomButton = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-step-panel='target'] button.industry-card"))
    .find((button) => (button.textContent || "").toLowerCase().includes("telecom"))
    ?? Array.from(container.querySelectorAll<HTMLButtonElement>("[data-step-panel='target'] button.industry-card")).at(-1)
    ?? null;
  expect(telecomButton).not.toBeNull();

  await act(async () => {
    telecomButton!.click();
  });

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe("provision shell", () => {
  beforeEach(() => {
    setupDefaultMocks();
    clearThemeState();
  });

  afterEach(() => {
    restoreFetch();
    clearThemeState();
  });

  it("shows one active provision step at a time and switches content from the rail", async () => {
    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/provision");
    });

    const { container, unmount } = result!;
    await waitForElement("[data-provision-shell]", container);

    expect(container.querySelector("[data-step-panel='configure']")).not.toBeNull();
    expect(container.textContent || "").toContain("Deployment Mode");
    expect(container.querySelector("[data-step-panel='target']")).toBeNull();

    const targetStepButton = container.querySelector<HTMLButtonElement>("button[data-step-id='target']");
    expect(targetStepButton).not.toBeNull();

    await act(async () => {
      targetStepButton!.click();
    });

    expect(container.querySelector("[data-step-panel='configure']")).toBeNull();
    expect(container.querySelector("[data-step-panel='target']")).not.toBeNull();
    expect(container.textContent || "").toContain("Select visible");

    unmount();
  });

  it("adds the conditional plan step only when graph mode has a selected root service", async () => {
    let result: ReturnType<typeof renderRoute>;

    setupGraphCapableMocks();

    await act(async () => {
      result = renderRoute("/provision");
    });

    const { container, unmount } = result!;
    await waitForElement("[data-provision-shell]", container);

    expect(container.querySelector("button[data-step-id='plan']")).toBeNull();

    const graphModeInput = container.querySelector<HTMLInputElement>("input[name='deployment_mode'][value='graph']");
    expect(graphModeInput).not.toBeNull();

    await act(async () => {
      graphModeInput!.click();
    });

    const targetStepButton = container.querySelector<HTMLButtonElement>("button[data-step-id='target']");
    expect(targetStepButton).not.toBeNull();

    await act(async () => {
      targetStepButton!.click();
    });

    await selectTelecomIndustry(container);

    const rootServiceButton = await waitForElement("button.spec-item-content", container) as HTMLButtonElement;

    await act(async () => {
      rootServiceButton.click();
    });

    expect(container.querySelector("button[data-step-id='plan']")).not.toBeNull();

    unmount();
  });

  it("can open the review step from the query param and keeps the launch panel", async () => {
    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/provision?step=review");
    });

    const { container, unmount } = result!;
    await waitForElement("[data-provision-shell]", container);

    expect(container.querySelector("[data-step-panel='review']")).not.toBeNull();
    expect(container.textContent || "").toContain("Launch configuration");
    expect(container.querySelector("button[data-step-id='review'][aria-current='step']")).not.toBeNull();

    unmount();
  });

  it("shows an integrated next-step action in the content panel", async () => {
    let result: ReturnType<typeof renderRoute>;

    await act(async () => {
      result = renderRoute("/provision");
    });

    const { container, unmount } = result!;
    await waitForElement("[data-provision-shell]", container);

    const nextButton = container.querySelector<HTMLButtonElement>("button[data-provision-next-step]");
    expect(nextButton).not.toBeNull();
    expect(nextButton?.textContent || "").toContain("Select Target");

    await act(async () => {
      nextButton!.click();
    });

    expect(container.querySelector("[data-step-panel='target']")).not.toBeNull();
    unmount();
  });

  it("disables graph mode and disabled k8s runtimes when kubernetes config is unavailable", async () => {
    let result: ReturnType<typeof renderRoute>;

    mockFetch({
      "/api/deployments": () => jsonResponse(EMPTY_DEPLOYMENTS),
      "/api/config": () => jsonResponse(K8S_DOWN_CONFIG),
      "/api/teams/registry": () => jsonResponse(EMPTY_REGISTRY),
      "/api/users": () => jsonResponse(EMPTY_USERS),
      "/api/system-envs": () => jsonResponse(EMPTY_SYSTEM_ENVS),
      "/api/github/org-members": () => jsonResponse(EMPTY_ORG_MEMBERS),
    });

    await act(async () => {
      result = renderRoute("/provision");
    });

    const { container, unmount } = result!;
    await waitForElement("[data-provision-shell]", container);

    const graphModeInput = container.querySelector<HTMLInputElement>("input[name='deployment_mode'][value='graph']");
    const workspaceInput = container.querySelector<HTMLInputElement>("input[name='runtime_mode'][value='k8s_workspace']");
    const discoveryInput = container.querySelector<HTMLInputElement>("input[name='runtime_mode'][value='k8s_discovery']");

    expect(graphModeInput?.disabled).toBe(true);
    expect(workspaceInput?.disabled).toBe(true);
    expect(discoveryInput?.disabled).toBe(true);
    unmount();
  });

  it("makes the single-service plan step explain what will and will not be provisioned", async () => {
    let result: ReturnType<typeof renderRoute>;

    setupGraphCapableMocks();

    await act(async () => {
      result = renderRoute("/provision");
    });

    const { container, unmount } = result!;
    await waitForElement("[data-provision-shell]", container);

    const targetStepButton = container.querySelector<HTMLButtonElement>("button[data-step-id='target']");
    expect(targetStepButton).not.toBeNull();

    await act(async () => {
      targetStepButton!.click();
    });

    await selectTelecomIndustry(container);

    const rootServiceButton = await waitForElement("button.spec-item-content", container) as HTMLButtonElement;

    await act(async () => {
      rootServiceButton.click();
    });

    const planStepButton = container.querySelector<HTMLButtonElement>("button[data-step-id='plan']");
    expect(planStepButton).not.toBeNull();

    await act(async () => {
      planStepButton!.click();
    });

    expect(container.textContent || "").toContain("Only the selected service will be provisioned in single-service mode");
    expect(container.textContent || "").toContain("Dependencies are not added automatically");
    unmount();
  });

  it("keeps the plan step upcoming on target until Continue to Plan is used", async () => {
    let result: ReturnType<typeof renderRoute>;

    setupGraphCapableMocks();

    await act(async () => {
      result = renderRoute("/provision");
    });

    const { container, unmount } = result!;
    await waitForElement("[data-provision-shell]", container);

    const graphModeInput = container.querySelector<HTMLInputElement>("input[name='deployment_mode'][value='graph']");
    expect(graphModeInput).not.toBeNull();

    await act(async () => {
      graphModeInput!.click();
    });

    const targetStepButton = container.querySelector<HTMLButtonElement>("button[data-step-id='target']");
    expect(targetStepButton).not.toBeNull();

    await act(async () => {
      targetStepButton!.click();
    });

    await selectTelecomIndustry(container);

    const rootServiceButton = await waitForElement("button.spec-item-content", container) as HTMLButtonElement;

    await act(async () => {
      rootServiceButton.click();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const planStepButton = container.querySelector<HTMLButtonElement>("button[data-step-id='plan']");
    expect(planStepButton).not.toBeNull();
    expect(planStepButton?.closest(".step-rail-item")?.classList.contains("step-rail-item--upcoming")).toBe(true);
    expect(planStepButton?.closest(".step-rail-item")?.classList.contains("step-rail-item--complete")).toBe(false);
    expect(planStepButton?.getAttribute("aria-current")).toBeNull();

    const continueButton = container.querySelector<HTMLButtonElement>("button[data-provision-next-step]");
    expect(continueButton?.textContent || "").toContain("Plan");

    await act(async () => {
      continueButton!.click();
    });

    const currentPlanButton = container.querySelector<HTMLButtonElement>("button[data-step-id='plan'][aria-current='step']");
    expect(currentPlanButton).not.toBeNull();
    expect(currentPlanButton?.closest(".step-rail-item")?.classList.contains("step-rail-item--current")).toBe(true);

    unmount();
  });
});
