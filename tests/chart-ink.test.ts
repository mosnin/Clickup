import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  identityFill,
  identityHue,
  identityInk,
  orbVars,
  parseColor,
  relativeLuminance,
} from "../src/lib/identity-color";

// Two colour caps, both of which shipped because a value that paints was
// decided once and never measured against what it lands on.
//
// The first is the chart layer's furniture. Four separate times a mark in
// these charts has been the same colour as the card underneath it — the
// undefined `--border`, the metric sparkline, the radar grid, and now a ring's
// track and a funnel's halo at 1.18:1 in dark. Every previous fix made the
// value theme-AWARE and stopped there, which is why this one comes with a
// test: the property is not "the token has two values", it is "each of those
// two values is far enough from the card in ITS OWN theme", and only the
// second one is checkable by looking.
//
// The second is the identity ramp's ink. A hue ramp holds HSL lightness fixed;
// luminance at fixed HSL lightness varies by a factor of eight across the
// wheel, so any single ink is guaranteed to be wrong at one end. The fix has
// to be a computation, and a computation can be fuzzed.

const css = readFileSync(
  new URL("../src/app/globals.css", import.meta.url),
  "utf8",
);

/** The `:root { … }` block, and the `:root[data-theme="dark"] { … }` block. */
function themeBlocks(): { light: string; dark: string } {
  const dark = css.split(':root[data-theme="dark"]').slice(1).join("\n");
  // Everything before the first dark override is the light declaration set.
  const light = css.split(':root[data-theme="dark"]')[0];
  return { light, dark };
}

function declaration(block: string, name: string): string | null {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
  return m ? m[1].trim() : null;
}

/**
 * sRGB for an ACHROMATIC `oklch(L 0 0)`.
 *
 * Restricted to zero chroma on purpose: greys are the whole of the furniture
 * vocabulary, and a full Oklch→sRGB matrix in a test file is a second
 * implementation of a colour space that nothing else here needs. A chromatic
 * furniture token would fail this assertion rather than be waved through.
 */
function achromaticOklch(value: string): readonly [number, number, number] {
  const m = /^oklch\(\s*([0-9.]+)\s+0\s+(?:0|none)\s*\)$/.exec(value);
  expect(m, `not an achromatic oklch: ${value}`).toBeTruthy();
  const l = Number(m![1]);
  // For a grey, Oklab's L is the cube root of the linear luminance.
  const y = l ** 3;
  const c = y <= 0.0031308 ? y * 12.92 : 1.055 * y ** (1 / 2.4) - 0.055;
  const b = Math.round(Math.min(1, Math.max(0, c)) * 255);
  return [b, b, b];
}

describe("chart furniture is legible in the theme it is drawn in", () => {
  const { light, dark } = themeBlocks();

  it("defines --chart-track in both themes", () => {
    expect(declaration(light, "--chart-track")).toBeTruthy();
    expect(declaration(dark, "--chart-track")).toBeTruthy();
  });

  // The ink gate's floor is 1.2:1 — deliberately far below any readability
  // bar, because it asks "is this mark present at all" rather than "is this
  // pleasant". A track that only just clears it clears it by accident, so the
  // bar here is 1.35, which is what the light value has always measured and
  // what a person can plainly see in a crop.
  it.each([
    ["light", "#ffffff"],
    ["dark", "#121212"],
  ])("track reads against the %s card", (theme, card) => {
    const block = theme === "light" ? light : dark;
    const track = achromaticOklch(declaration(block, "--chart-track")!);
    const cardRgb = parseColor(card)!;
    expect(contrastRatio(track, cardRgb)).toBeGreaterThanOrEqual(1.35);
  });

  it("the two themes' tracks read at the same weight", () => {
    // The bug this replaces was a token mirrored by LIGHTNESS: white minus
    // 0.1 and near-black plus 0.1, which measures 1.35:1 one way and 1.18:1
    // the other because sRGB is not linear near black. Symmetry has to be
    // asserted in the units that matter.
    const l = contrastRatio(
      achromaticOklch(declaration(light, "--chart-track")!),
      parseColor("#ffffff")!,
    );
    const d = contrastRatio(
      achromaticOklch(declaration(dark, "--chart-track")!),
      parseColor("#121212")!,
    );
    expect(Math.abs(l - d)).toBeLessThan(0.15);
  });

  it("keeps the hairline register separate from the track register", () => {
    // Collapsing them is how a gridline value ended up as a fill. A gridline
    // is meant to be nearly invisible; a track is meant to be a shape.
    expect(declaration(light, "--chart-track")).not.toBe(
      declaration(light, "--chart-grid"),
    );
    expect(declaration(dark, "--chart-track")).not.toBe(
      declaration(dark, "--chart-grid"),
    );
  });

  it("routes the chart library's furniture token at the track", () => {
    const chart = readFileSync(
      new URL("../src/components/charts/operate/chart.tsx", import.meta.url),
      "utf8",
    );
    expect(chart).toContain('"--border": "var(--chart-track)"');
  });

  it("paints no NEUTRAL colour literal anywhere in the chart layer", () => {
    // The sweep, stated as the property rather than as a list of files.
    //
    // A saturated literal is a hue, and a hue is what a palette IS — the three
    // that survive this sweep (`#e879f9` on the accent pattern, `#bef264` and
    // `#10b981` on the notch gauge's default gradient) are library defaults
    // this app never reaches, and they are mid-luminance, so they read on
    // either card. A NEUTRAL literal is the bug: a grey has no identity of its
    // own, it was picked to sit a certain distance from one card, and the
    // other card is somewhere else entirely. Every one of the four failures in
    // this file's history was a neutral.
    //
    // `white`/`black` inside a `<mask>` are not paint — in a luminance mask
    // white means "keep" — so the keyword check is scoped to `color-mix`,
    // which is the only place they are a colour here.
    const files = readdirSync(
      new URL("../src/components/charts", import.meta.url),
      { recursive: true, encoding: "utf8" },
    ).filter((f) => /\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(
        new URL(`../src/components/charts/${file}`, import.meta.url),
        "utf8",
      );
      for (const [, hex] of src.matchAll(/["'](#[0-9a-fA-F]{6})["']/g)) {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        const spread = Math.max(r, g, b) - Math.min(r, g, b);
        if (spread <= 24) offenders.push(`${file}: ${hex}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never mixes a chart colour toward a literal black or white", () => {
    // `color-mix(… , white)` is the same bug one indirection down: "lighter"
    // is only "quieter" in a light theme. This is what the heatmap's pattern
    // stroke was doing.
    const files = readdirSync(
      new URL("../src/components/charts", import.meta.url),
      { recursive: true, encoding: "utf8" },
    ).filter((f) => /\.tsx?$/.test(f));
    for (const file of files) {
      const src = readFileSync(
        new URL(`../src/components/charts/${file}`, import.meta.url),
        "utf8",
      );
      expect(src, file).not.toMatch(/color-mix\([^)]*,\s*(white|black)\s*\)/);
    }
  });
});

describe("identity ink is measured, not chosen", () => {
  it("parses the colour syntaxes the ramp emits", () => {
    expect(parseColor("hsl(0 100% 50%)")).toEqual([255, 0, 0]);
    expect(parseColor("hsl(120, 100%, 50%)")).toEqual([0, 255, 0]);
    expect(parseColor("#fff")).toEqual([255, 255, 255]);
    expect(parseColor("#102030")).toEqual([16, 32, 48]);
    expect(parseColor("rgb(1 2 3)")).toEqual([1, 2, 3]);
    expect(parseColor("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3]);
    expect(parseColor("oklch(0.5 0.1 200)")).toBeNull();
  });

  it("clears AA on every hue the ramp can produce", () => {
    // The two the audit caught, by name: white on the mint measured 1.56:1 and
    // white on the amber 1.65:1. Both are orb fills, both are in this loop.
    for (let i = 0; i < 64; i++) {
      const seed = `seed-${i}`;
      const fill = identityFill(seed);
      expect(
        contrastRatio(parseColor(fill.backgroundColor)!, parseColor(fill.color)!),
        `monogram ${seed} (hue ${identityHue(seed)})`,
      ).toBeGreaterThanOrEqual(4.5);

      // `--orb-b` and not all three stops: it is the element's own
      // `background`, so it is what anything measuring this reads, and it is
      // the darkest of the three. The other two are lighter by construction,
      // which is what the halo in `.orb-label` is for — a flat ink over a
      // moving gradient cannot be optimal against all of it at once.
      const orb = orbVars(seed);
      expect(
        contrastRatio(
          parseColor(orb["--orb-b"])!,
          parseColor(orb["--orb-ink"])!,
        ),
        `orb ${seed} (hue ${identityHue(seed)})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("cannot be beaten by any colour at all", () => {
    // The threshold is the crossing of the two contrast curves, so the worst
    // case over the entire sRGB cube is 4.58:1 — there is no colour, in the
    // ramp or out of it or supplied by a space's own swatch, on which this
    // returns an ink below AA. That is the property; a hand-tuned ramp cannot
    // have it, which is the whole argument for computing.
    let worst = Infinity;
    let worstAt = "";
    let state = 20260802;
    const next = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % 256;
    };
    for (let i = 0; i < 20000; i++) {
      const rgb = [next(), next(), next()] as const;
      const hex =
        "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
      const got = contrastRatio(rgb, parseColor(identityInk(hex))!);
      if (got < worst) {
        worst = got;
        worstAt = hex;
      }
    }
    expect(worst, `worst at ${worstAt}`).toBeGreaterThanOrEqual(4.5);
  });

  it("agrees with the luminance crossing rather than a lightness guess", () => {
    // Grey at the crossing: below it white wins, above it black does.
    const cross = Math.sqrt(0.0525) - 0.05;
    expect(relativeLuminance(parseColor("#767676")!)).toBeGreaterThan(cross);
    expect(identityInk("#767676")).toBe("#000000");
    expect(identityInk("#747474")).toBe("#ffffff");
  });

  it("falls back to white for a colour it cannot read", () => {
    expect(identityInk("color-mix(in oklab, red 50%, blue)")).toBe("#ffffff");
  });
});
