import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The audit that motivated this found 526 `text-[Npx]` literals across 120
// files. The root scales type via `font-size: calc(100% * var(--ui-font-scale))`
// — the type-size preference, an accessibility setting — and px does not
// inherit root font-size, so every one of those literals was a label the
// setting could not reach. They were codemodded onto the named rem scale
// (`text-micro/-tiny/-mini/-compact` in globals.css @theme); this test is what
// stops the population regrowing one "quick label" at a time, because a px
// literal is invisible in review — it renders identically to its rem twin
// right up until someone touches the slider.
//
// Same shape for radius: `rounded-[Npx]` bypasses the radius tokens that a
// space's appearance is allowed to set (a PLACE key), leaving the one
// component nobody restyled. And `window.confirm`/`prompt`/`alert` are the
// Phase 18 contract's named prohibitions — the last one was deleted alongside
// this test.

const root = new URL("..", import.meta.url).pathname;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* sourceFiles(path);
    } else if (/\.(tsx?|css|mjs)$/.test(entry)) {
      yield path;
    }
  }
}

// The canvas pieces on the logged-out site are the one exemption, and only for
// the two SIZE rules — the feedback contract below still applies to them.
//
// Both prohibitions exist for the same reason: a value expressed in px is a
// value the reader's own settings cannot reach. Neither settings layer exists
// here. `--ui-font-scale` is a per-user preference stored against a signed-in
// account, and the radius tokens are a PLACE key a space sets for its members;
// a logged-out visitor has neither, so there is nothing for these numbers to
// fail to follow.
//
// And they are not type or chrome — they are DRAWING. The morphing card sizes
// its shared body by measuring each variant's natural box and animating to that
// number of pixels, then builds its glow as a raster mask from the same box and
// its resolved corner radius. A `14px` in there is a measurement the mask is
// built from, not a label; expressing it in rem would make the geometry move
// under a setting that is meant to change text size, and the mask (a PNG) would
// no longer fit the shape it is masking.
const SIZE_EXEMPT = /^\/src\/(components\/marketing\/(ai-lights|datamosh|design-tiles|cursors|code-trail)\/|app\/\(marketing\)\/sections\/(surfaces-bar|together|work-trail)\.tsx$)/;

function offenders(pattern: RegExp, exempt?: RegExp): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles(join(root, "src"))) {
    const rel = file.slice(root.length - 1);
    if (exempt?.test(rel)) continue;
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      // Prose about the prohibition is not a violation of it.
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      const m = line.match(pattern);
      if (m) hits.push(`${file.slice(root.length)}: ${m[0]}`);
    }
  }
  return hits;
}

describe("the type scale is closed", () => {
  it("has no px font-size literals — px cannot follow --ui-font-scale", () => {
    expect(offenders(/text-\[[0-9.]+px\]/, SIZE_EXEMPT)).toEqual([]);
  });

  it("has no px radius literals — a literal is a corner no theme can reach", () => {
    expect(offenders(/rounded-\[[0-9.]+px\]/, SIZE_EXEMPT)).toEqual([]);
  });

  // The exemption is a named list, not a directory anyone can grow into. A
  // regex that let `src/components/marketing/**` through would quietly exempt
  // every future section, which is how a closed scale stops being closed.
  it("exempts only the canvas pieces, and only where they exist", () => {
    const paths = [
      "src/components/marketing/ai-lights/variants.tsx",
      "src/components/marketing/code-trail/CodeTrailCard.tsx",
      "src/app/(marketing)/sections/surfaces-bar.tsx",
    ];
    for (const p of paths) {
      expect(SIZE_EXEMPT.test(`/${p}`)).toBe(true);
      expect(statSync(join(root, p)).isFile()).toBe(true);
    }
    // Neighbours are not exempt.
    expect(SIZE_EXEMPT.test("/src/components/marketing/footer.tsx")).toBe(false);
    expect(SIZE_EXEMPT.test("/src/app/(marketing)/sections/hero.tsx")).toBe(false);
    expect(SIZE_EXEMPT.test("/src/components/dashboard/sidebar.tsx")).toBe(false);
  });

  it("defines every rung the codemod mapped onto", () => {
    const css = readFileSync(join(root, "src/app/globals.css"), "utf8");
    for (const token of [
      "--text-micro",
      "--text-tiny",
      "--text-mini",
      "--text-compact",
      "--radius-card-lg",
      "--radius-sheet",
    ]) {
      expect(css).toContain(`${token}:`);
    }
  });
});

describe("the feedback contract holds", () => {
  it("has no native confirm/prompt/alert — deletes are undo toasts", () => {
    expect(offenders(/window\.(confirm|prompt|alert)\(/)).toEqual([]);
  });
});
