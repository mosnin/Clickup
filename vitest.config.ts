import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

// Two test environments, because they test genuinely different things.
//
//  - `backend` runs Convex functions through convex-test, which needs an
//    edge-runtime-like isolate. Pure unit tests don't care either way.
//  - `ui` renders React components, which needs a DOM. Keeping it separate
//    means the backend suite doesn't pay jsdom's startup cost, and a DOM
//    global never leaks into a Convex test that should not have one.
export default defineConfig({
  test: {
    projects: [
      {
        // The same path aliases the app uses. Modules under src/ import each
        // other through `@/`, so a pure unit test of one of them cannot
        // resolve its dependencies without this — and the failure looks like
        // a missing package rather than like missing config.
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
            "@convex": fileURLToPath(new URL("./convex", import.meta.url)),
          },
        },
        test: {
          name: "backend",
          environment: "edge-runtime",
          include: ["tests/**/*.test.ts"],
          server: { deps: { inline: ["convex-test"] } },
        },
      },
      {
        // The app's tsconfig sets jsx: "preserve" for Next, so esbuild
        // alone won't transform JSX here. The React plugin does.
        plugins: [react()],
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
            "@convex": fileURLToPath(new URL("./convex", import.meta.url)),
          },
        },
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["tests/ui/**/*.test.tsx"],
          setupFiles: ["tests/ui/setup.ts"],
          // Last resort for the CI flake: React 19's scheduler can still
          // fire `performWorkUntilDeadline` after jsdom is torn down
          // (`window is not defined` attributed to page-editor-fixes
          // after 3183 passing tests). Returning false keeps that
          // post-teardown leak from failing a green run; real test
          // failures still throw inside the test.
          onUnhandledError(error) {
            const stack = error instanceof Error ? error.stack ?? "" : "";
            if (
              error instanceof ReferenceError &&
              error.message.includes("window is not defined") &&
              stack.includes("performWorkUntilDeadline")
            ) {
              return false;
            }
          },
        },
      },
    ],
  },
});
