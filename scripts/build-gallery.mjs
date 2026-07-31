// Build the design gallery into a real, hydrating page.
//
// The charts measure their container before they draw, so rendering them to a
// static string produces a page of empty boxes — a harness that would report
// everything fine no matter what shipped. This bundles the gallery with Vite
// so a browser actually mounts it.
//
// The stylesheet is the app's own compiled CSS (`.next/static/css`), not a
// second copy of the tokens: a gallery styled by hand is a picture of a design
// system rather than the design system, and it drifts the first time anything
// changes. Run `npm run build` first — the script says so rather than quietly
// rendering unstyled.

import { build } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "tests/ui/design");
const OUT = "/tmp/design-gallery";

function appCss() {
  const dir = join(ROOT, ".next/static/css");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".css"));
  if (files.length === 0) return null;
  return files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

const css = appCss();
if (css === null) {
  console.error(
    "No compiled CSS at .next/static/css — run `npm run build` first, or the\n" +
      "gallery will show you the components without the design system.",
  );
  process.exit(1);
}

await build({
  root: SRC,
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": join(ROOT, "src"),
      "@convex": join(ROOT, "convex"),
    },
  },
  build: { outDir: OUT, emptyOutDir: true },
  logLevel: "warn",
});

const html = join(OUT, "index.html");
writeFileSync(
  html,
  readFileSync(html, "utf8").replace("<!--APP_CSS-->", `<style>${css}</style>`),
);

console.log(`gallery built → ${html}`);
