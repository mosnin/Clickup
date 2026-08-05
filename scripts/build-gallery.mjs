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
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  renameSync,
  rmSync,
  cpSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "tests/ui/design");
const FINAL = "/tmp/design-gallery";
// Built beside the gallery and moved into place only once it is whole.
// `emptyOutDir` deletes first and writes afterwards, so a build that throws
// half way — a syntax error in a surface somebody else is mid-edit on — leaves
// an EMPTY gallery, and every harness pointed at it then fails for a reason
// that has nothing to do with what it was measuring. The swap is the last
// thing that happens.
const OUT = "/tmp/design-gallery.building";

/**
 * The app's compiled stylesheet, made usable outside Next.
 *
 * Two rewrites, and the gallery was silently wrong without either.
 *
 * **The typefaces.** next/font emits `@font-face` rules plus a generated class
 * (`.__variable_e3b56d { --font-space-grotesk: … }`) that the root layout puts
 * on <html>. The harness renders its own document, so that class was never
 * there, every `--font-*` resolved to nothing, and the whole gallery fell
 * through to the browser's default sans. Months of "does this look right"
 * were answered in a typeface the product does not ship. Hoisting those
 * declarations into `:root` is what makes the shot show the real face.
 *
 * **The font files.** Their URLs are absolute `/_next/static/media/…`, which
 * the gallery's little static server does not serve. So they are pointed at
 * `./media/…`, and the directory is copied in beside the HTML.
 */
function appCss() {
  const dir = join(ROOT, ".next/static/css");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".css"));
  if (files.length === 0) return null;
  let css = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");

  const vars = [...css.matchAll(/\.__variable_[a-z0-9]+\{([^}]*)\}/g)]
    .map((m) => m[1])
    .join(";");
  if (vars) css += `\n:root{${vars}}`;
  return css.replaceAll("/_next/static/media/", "./media/");
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
      // The gallery renders real dashboard surfaces, and a real surface talks
      // to Convex, Clerk and the router. Stubbing those three at the module
      // boundary is what lets the harness show the actual component rather
      // than a hand-built lookalike — a lookalike is a picture of a design,
      // and it drifts the moment the real one changes.
      "convex/react": join(ROOT, "tests/ui/design/stubs/convex-react.tsx"),
      "@clerk/nextjs": join(ROOT, "tests/ui/design/stubs/clerk.tsx"),
      "next/navigation": join(ROOT, "tests/ui/design/stubs/next-navigation.ts"),
      "next/link": join(ROOT, "tests/ui/design/stubs/next-link.tsx"),
    },
  },
  build: {
    outDir: OUT,
    emptyOutDir: true,
    // Stacks in the harness must name source files, or a crash is a riddle.
    sourcemap: true,
    minify: false,
    rollupOptions: {
      input: {
        index: join(SRC, "index.html"),
        sidebar: join(SRC, "sidebar.html"),
        labels: join(SRC, "labels.html"),
        grid: join(SRC, "grid.html"),
        // The product's own Home, not a specimen sheet. Every other page here
        // is a demo of components; this one is the screen people open.
        home: join(SRC, "home.html"),
        // A panel arriving because a condition became true, on a real canvas.
        // The one claim jsdom cannot check: that it displaces nothing.
        situation: join(SRC, "situation.html"),
        // The other real canvas: the project screen, with its tray, its
        // builder and the two banners an agent can raise on it.
        project: join(SRC, "project.html"),
        // Every shape the one panel renderer can draw, in every state it can
        // be in — the surface that is reused most and had been photographed
        // least.
        panels: join(SRC, "panels.html"),
        // The instrument, pointed at defects it is supposed to find. Built
        // alongside everything else on purpose: a calibration page that has to
        // be built separately is a calibration step somebody will skip.
        broken: join(SRC, "broken.html"),
      },
    },
  },
  logLevel: "warn",
});

for (const page of [
  "index.html",
  "sidebar.html",
  "labels.html",
  "grid.html",
  "home.html",
  "situation.html",
  "project.html",
  "panels.html",
  "broken.html",
]) {
  const html = join(OUT, page);
  writeFileSync(
    html,
    readFileSync(html, "utf8").replace("<!--APP_CSS-->", `<style>${css}</style>`),
  );
}

// The font files the rewritten @font-face rules now point at.
const media = join(ROOT, ".next/static/media");
if (existsSync(media)) cpSync(media, join(OUT, "media"), { recursive: true });

rmSync(FINAL, { recursive: true, force: true });
renameSync(OUT, FINAL);

console.log(`gallery built → ${join(FINAL, "index.html")}`);
// Said here because this is the last line anybody sees before they go looking
// at pictures by hand. The audit covers every surface at both widths in both
// themes, gates each one against measurements it has just proved it can make,
// and writes ranked findings with native-resolution crops. Looking through a
// directory of PNGs is the thing it replaces.
console.log("audit it:            node scripts/audit.mjs");
