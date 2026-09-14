import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import convexPlugin from "@convex-dev/eslint-plugin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  // Convex rules start as warnings. Backfill validators file-by-file;
  // do not flip these to error in one PR.
  {
    files: ["convex/**/*.ts"],
    plugins: { "@convex-dev": convexPlugin },
    rules: {
      "@convex-dev/require-args-validator": "warn",
      "@convex-dev/no-old-registered-function-syntax": "warn",
      "@convex-dev/explicit-table-ids": "warn",
      "@convex-dev/no-filter-in-query": "warn",
      "@convex-dev/no-top-of-hour-crons": "warn",
      "@convex-dev/no-schema-import-cycle": "warn",
    },
  },
  {
    // Vendored chart primitives, pulled in from the @bklit shadcn registry.
    // They are upstream source we re-sync rather than code we author, so
    // rewriting their generics to satisfy our own rules would be lost on the
    // next `shadcn add`. Anything WE write on top of them lives outside this
    // directory and is held to the normal bar.
    files: ["src/components/charts/**", "src/components/cult/**"],
    // `operate/` is ours — the dispatcher that turns a panel definition
    // into one of these, plus the SVG shapes the library has no equivalent for.
    ignores: ["src/components/charts/operate/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "react-hooks/exhaustive-deps": "off",
    },
  },
];

export default config;
