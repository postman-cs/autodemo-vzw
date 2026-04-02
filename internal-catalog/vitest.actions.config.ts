import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: [
            "tests/action-input-contracts.test.ts",
            "tests/postman-bootstrap.test.ts",
            "tests/postman-v3-simple.test.ts",
            "tests/docker-build.test.ts",
            "tests/aws-deploy.test.ts",
            "tests/finalize.test.ts",
            "tests/cleanup.test.ts",
        ],
        testTimeout: 15000,
        environment: "node",
        server: {
            deps: {
                inline: ["@actions/core", "@actions/exec", "@actions/github"],
            },
        },
    },
});
