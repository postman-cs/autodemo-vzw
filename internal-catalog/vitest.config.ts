import { defineConfig, type Plugin } from "vitest/config";

function assetStubPlugin(): Plugin {
  return {
    name: "asset-stub",
    transform(_code, id) {
      if (/\.(png|svg|jpg|jpeg|gif|webp|ico)$/.test(id)) {
        return { code: "export default '';" };
      }
    },
  };
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          // These suites rely on msw/node's setupServer() helper.
          // Keep them out of the Workers pool until they use a Workers-native fetch mock.
          name: "msw-node",
          include: [
            "tests/chaos.test.ts",
            "tests/fetch-mock-hygiene.test.ts",
            "tests/provision.test.ts",
            "tests/infra.test.ts",
            "tests/provision-spec-resolution.test.ts",
            "tests/teardown.test.ts",
            "tests/teardown-multi-env.test.ts",
            "tests/github.test.ts",
            "tests/precommit/*.test.ts",
          ],
          testTimeout: 15000,
          environment: "node",
        },
      },
      {
        plugins: [assetStubPlugin()],
        test: {
          name: "frontend",
          include: ["tests/frontend/**/*.test.tsx", "tests/frontend/**/*.test.ts"],
          testTimeout: 15000,
          environment: "jsdom",
        },
      },
      {
        test: {
          name: "node",
          include: [
            "tests/catalog-provision-worker.test.ts",
            "tests/catalog-worker.test.ts",
            "tests/index-worker.test.ts",
            "tests/two-worker-contract.test.ts",
            "tests/provision-workflow.test.ts",
            "tests/environment-branches.test.ts",
            "tests/runtime-pool.test.ts",
            "tests/runtime-options.test.ts",
            "tests/resource-inventory.test.ts",
            "tests/config.test.ts",
            "tests/validation.test.ts",
            "tests/spec-to-flask.test.ts",
            "tests/spec-to-flask-chaining.test.ts",
            "tests/boilerplate.test.ts",
            "tests/provision-webhooks.test.ts",
            "tests/sse.test.ts",
            "tests/sleep.test.ts",
            "tests/auth.test.ts",
            "tests/aws-deploy.test.ts",
            "tests/airtable.test.ts",
            "tests/deployment-recovery.test.ts",
            "tests/recovery-queue-ui.test.ts",
            "tests/catalog-ui-metadata.test.ts",
            "tests/provision-ui.test.tsx",
            "tests/backstage-feed.test.ts",
            "tests/system-envs.test.ts",
            "tests/phase2-phase3-helpers.test.ts",
            "tests/blocked-graph.test.ts",
            "tests/k8s-manifest.test.ts",
            "tests/dependency-planner.test.ts",
            "tests/dependency-resolver.test.ts",
            "tests/provision-graph.test.ts",
            "tests/team-registry.test.ts",
            "tests/team-credential-health.test.ts",
            "tests/team-runtime-metadata.test.ts",
            "tests/provision-credential-verify.test.ts",
            "tests/docs-manifest.test.ts",
            "tests/backfill-urls.test.ts",
            "tests/fern-regression-harness.test.ts",
            "tests/execution-progress.test.ts",
          ],
          testTimeout: 15000,
          environment: "node",
        },
      },
    ],
  },
});
