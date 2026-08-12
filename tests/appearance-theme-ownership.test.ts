import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPEARANCE_PRESETS,
  DEFAULT_APPEARANCE,
  resolveTokens,
} from "../src/lib/appearance";

// An inline custom property cannot lose, so it must never be a colour.
//
// This is the failure it was written after, and it is worth stating plainly
// because nothing in the type system, the linter, the unit suite or a review
// could see it: `resolveTokens` emitted the accent ramp as `--color-brand-*`,
// and in the DEFAULT appearance those six values were a hardcoded copy of the
// stylesheet's LIGHT ink ramp. Inline custom properties on `:root` outrank
// every selector, so `:root[data-theme="dark"]`'s dark ramp — six correct
// values, sitting right there in globals.css — had never once applied.
//
// App-wide, in dark mode, for everybody: `bg-brand-50` painted a white slab,
// `text-brand-700` painted black text on it, and `text-brand-600` painted a
// near-black glyph on a near-black card. Every one of those classes looked
// perfectly correct at the call site.
//
// CLAUDE.md already carries the rule this broke — "a colour the provider
// computes can outrank the stylesheet", written after the same shape of bug in
// `contrast` — so the lesson had been learned once and re-paid anyway. A
// prose rule is not a guard. This is the guard.
//
//   **If globals.css gives a custom property a different value per theme,
//   `resolveTokens` may not write that property at all.**
//
// It is decidable from the two files, it is general (it would have caught the
// `contrast` bug too), and it does not care what the next theme-varying token
// is called.

const css = readFileSync(
  join(new URL("..", import.meta.url).pathname, "src/app/globals.css"),
  "utf8",
);

/** The body of every top-level block whose selector matches. */
function blocks(selector: RegExp): string[] {
  const out: string[] = [];
  const lines = css.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!selector.test(lines[i]) || !lines[i].includes("{")) continue;
    let depth = 1;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && depth > 0; j += 1) {
      depth += (lines[j].match(/\{/g) ?? []).length;
      depth -= (lines[j].match(/\}/g) ?? []).length;
      if (depth > 0) body.push(lines[j]);
    }
    out.push(body.join("\n"));
  }
  return out;
}

/** `--name: value` declarations in a block, last one winning. */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

/**
 * Properties globals.css deliberately gives two values, one per theme.
 *
 * The light side is `@theme` (the base scale) and the dark side is
 * `:root[data-theme="dark"]` — the app is `data-theme`-driven with no
 * `prefers-color-scheme` anywhere, so those two blocks are the whole story.
 * Scoped islands (`.ui-inverted`, `.ui-light-island`) are deliberately
 * excluded: they re-declare tokens for a subtree and a selector always beats
 * inheritance, so they are not what an inline root property competes with.
 */
function themeOwned(): Map<string, [string, string]> {
  const light = new Map<string, string>();
  for (const b of blocks(/^@theme\b/)) {
    for (const [k, v] of declarations(b)) light.set(k, v);
  }
  const dark = new Map<string, string>();
  for (const b of blocks(/^:root\[data-theme="dark"\]\s*\{/)) {
    for (const [k, v] of declarations(b)) dark.set(k, v);
  }
  const owned = new Map<string, [string, string]>();
  for (const [k, v] of light) {
    const d = dark.get(k);
    if (d !== undefined && d !== v) owned.set(k, [v, d]);
  }
  return owned;
}

/** Enough appearances to exercise every branch that emits a colour. */
const APPEARANCES = [
  DEFAULT_APPEARANCE,
  { ...DEFAULT_APPEARANCE, accentMode: "ink" as const },
  {
    ...DEFAULT_APPEARANCE,
    accentMode: "hue" as const,
    accentHue: 258,
    accentSaturation: 72,
  },
  {
    ...DEFAULT_APPEARANCE,
    accentMode: "hue" as const,
    accentHue: 12,
    accentSaturation: 100,
  },
  ...APPEARANCE_PRESETS.map((p) => ({ ...DEFAULT_APPEARANCE, ...p.settings })),
];

describe("the stylesheet stays the authority on the theme", () => {
  it("finds the theme-varying properties — the detector is not vacuous", () => {
    // A gate that has never seen a positive cannot report a negative. The
    // brand ramp is the one this test was written about, so it must be here.
    const owned = themeOwned();
    expect(owned.size).toBeGreaterThan(5);
    expect(owned.has("--color-brand-50")).toBe(true);
    expect(owned.has("--color-background")).toBe(true);
  });

  it("never writes a property globals.css defines per theme", () => {
    const owned = themeOwned();
    const offenders: string[] = [];
    for (const appearance of APPEARANCES) {
      for (const key of Object.keys(resolveTokens(appearance))) {
        if (owned.has(key)) offenders.push(key);
      }
    }
    // Anything listed here is pinned to ONE theme's value in BOTH themes, and
    // it will look completely correct in whichever theme it was copied from.
    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  it("feeds the ramp to the stylesheet instead, both sides", () => {
    // The replacement for writing `--color-brand-*` directly: a pair of
    // per-theme inputs the stylesheet selects between, each with the shipped
    // hex as its fallback so a browser that never runs the provider still
    // renders the shipped design in both themes.
    for (const stop of ["50", "100", "200", "500", "600", "700"]) {
      expect(css).toContain(
        `--color-brand-${stop}: var(--ui-accent-${stop}-light,`,
      );
      expect(css).toContain(
        `--color-brand-${stop}: var(--ui-accent-${stop}-dark,`,
      );
    }
  });

  it("keeps the two fallbacks different, so the theme still changes", () => {
    // A `var()` pair whose fallbacks are the same value is the original bug
    // rewritten in a longer form.
    const owned = themeOwned();
    for (const stop of ["50", "600", "700"]) {
      const [light, dark] = owned.get(`--color-brand-${stop}`)!;
      expect(light).not.toBe(dark);
    }
  });
});
