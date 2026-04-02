import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/spec-structure.test.ts"],
    testTimeout: 30000,
  },
});
