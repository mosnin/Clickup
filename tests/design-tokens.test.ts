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

function offenders(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles(join(root, "src"))) {
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
    expect(offenders(/text-\[[0-9.]+px\]/)).toEqual([]);
  });

  it("has no px radius literals — a literal is a corner no theme can reach", () => {
    expect(offenders(/rounded-\[[0-9.]+px\]/)).toEqual([]);
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
