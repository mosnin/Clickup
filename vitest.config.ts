import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // convex-test runs Convex functions in an edge-runtime-like isolate;
    // pure unit tests (tests/*.test.ts) don't care either way.
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
  },
});
