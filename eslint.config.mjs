import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // Vendored chart primitives, pulled in from the @bklit shadcn registry.
    // They are upstream source we re-sync rather than code we author, so
    // rewriting their generics to satisfy our own rules would be lost on the
    // next `shadcn add`. Anything WE write on top of them lives outside this
    // directory and is held to the normal bar.
    files: ["src/components/charts/**"],
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
