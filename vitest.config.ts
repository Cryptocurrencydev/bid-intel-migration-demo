import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    reporters: process.env.CI ? ["default", "json"] : ["default"],
    outputFile: { json: `artifacts/vitest-${process.env.VITEST_SUITE ?? "all"}.json` },
  },
  resolve: { alias: { "@": new URL("./", import.meta.url).pathname } },
});
