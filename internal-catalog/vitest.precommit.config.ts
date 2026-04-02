import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/precommit/**/*.test.ts"],
    testTimeout: 15000,
    environment: "node",
  },
});
