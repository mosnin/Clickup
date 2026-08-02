// One source of truth for "what color is this teammate?" — used by both the
// Orb (the living gradient sphere) and the Monogram (the initial circle), so
// an agent reads as the same color everywhere it appears.
//
// Colors come from a curated ramp rather than a free 0-359 hue: an unbounded
// hue lands on muddy olives and acid yellows that fight the brand, and the
// mark stops reading as one family. Twelve hues, fixed saturation/lightness,
// deterministic per seed.
//
// **The ink is computed from the fill, never chosen alongside it.** Everything
// here used to pair its fill with a hard-coded white, on the reasoning that
// the ramp was tuned so white would always clear AA. It was not, and it could
// not be: the ramp holds hue fixed and lightness fixed, and equal HSL
// lightness across hues is wildly unequal luminance — `hsl(166 82% 52%)` is a
// mint at 62% luminance and `hsl(238 82% 52%)` is a blue at 8%. White on the
// mint measured **1.56:1**. Picking the ink per hue by hand would fix the
// twelve and break the thirteenth, and it would not survive a space choosing
// its own swatch at all. So `identityInk` measures.

const IDENTITY_HUES = [
  212, // blue
  248, // indigo
  268, // violet
  292, // purple
  322, // fuchsia
  342, // pink
  8, // red
  24, // orange
  44, // amber
  142, // green
  168, // emerald
  190, // teal
] as const;

/** FNV-1a — stable across renders, sessions, and machines. */
export function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function identityHue(seed: string): number {
  return IDENTITY_HUES[hashSeed(seed) % IDENTITY_HUES.length];
}

// ── Ink ─────────────────────────────────────────────────────────────────

type Rgb = readonly [number, number, number];

/** WCAG 2 relative luminance of an sRGB triple in 0–255. */
export function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  );
}

/** WCAG 2 contrast ratio between two sRGB triples. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

/**
 * Parse the colour syntaxes this app actually emits or stores, into sRGB.
 *
 * Deliberately not a general CSS colour parser. It has to cover what
 * `orbVars`/`identityFill` produce (`hsl(h s% l%)`) and what a swatch picker
 * stores (`#rgb`, `#rrggbb`, `rgb(...)`) — anything else is a colour we did
 * not write, and guessing at it would be worse than saying so.
 */
export function parseColor(css: string): Rgb | null {
  const value = css.trim().toLowerCase();

  const hex = /^#([0-9a-f]{3,8})$/.exec(value);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      return [
        parseInt(digits[0] + digits[0], 16),
        parseInt(digits[1] + digits[1], 16),
        parseInt(digits[2] + digits[2], 16),
      ];
    }
    if (digits.length === 6 || digits.length === 8) {
      return [
        parseInt(digits.slice(0, 2), 16),
        parseInt(digits.slice(2, 4), 16),
        parseInt(digits.slice(4, 6), 16),
      ];
    }
    return null;
  }

  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(value);
  if (!fn) return null;
  const parts = fn[2]
    .replace(/\//g, " ")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (parts.length < 3) return null;
  const num = (raw: string, scale: number) => {
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return null;
    return raw.endsWith("%") ? (n / 100) * scale : n;
  };
  const a = num(parts[0], 255);
  const b = num(parts[1], 100);
  const c = num(parts[2], 100);
  if (a === null || b === null || c === null) return null;
  if (fn[1].startsWith("rgb")) {
    const g = num(parts[1], 255);
    const bl = num(parts[2], 255);
    if (g === null || bl === null) return null;
    return [a, g, bl];
  }
  return hslToRgb(a, b / 100, c / 100);
}

/**
 * The ink to write on `fill` — near-black or white, whichever measures better.
 *
 * The threshold is not a taste call and is not tunable. Black on a fill of
 * luminance Y measures `(Y + 0.05) / 0.05`; white measures `1.05 / (Y + 0.05)`.
 * They cross at `Y = sqrt(0.0525) - 0.05 ≈ 0.1791`, and taking the better side
 * of that crossing guarantees **at least 4.58:1 against any colour whatsoever**
 * — above WCAG AA for normal text, with no ramp to keep tuned and no hue that
 * can be added later and quietly fail. Anything other than this crossing is
 * strictly worse somewhere.
 *
 * A colour we cannot parse falls back to white, which is what shipped; it is
 * reachable only from a caller-supplied swatch in a syntax this app never
 * writes.
 */
export function identityInk(fill: string): string {
  const rgb = parseColor(fill);
  if (!rgb) return "#ffffff";
  return relativeLuminance(rgb) >= Math.sqrt(0.0525) - 0.05
    ? "#000000"
    : "#ffffff";
}

/** The halo behind `identityInk(fill)` — its opposite, so it separates. */
export function identityHalo(fill: string): string {
  return identityInk(fill) === "#000000"
    ? "rgb(255 255 255 / 0.5)"
    : "rgb(0 0 0 / 0.45)";
}

/**
 * Solid fill for an initial circle, with the ink that reads on it.
 *
 * The `color` is part of the fill, not a separate decision made at each call
 * site: it is an inline style, so it outranks any `text-white` class the
 * caller had, and every consumer of the ramp gets the measured ink without
 * having to know the ramp exists. The comment this replaced claimed 42%
 * lightness kept white above AA on every hue — `hsl(44 52% 42%)` measures
 * 3.5:1, so it did not, on the yellows, which is exactly where a naive HSL
 * avatar palette fails.
 */
export function identityFill(seed: string): {
  backgroundColor: string;
  color: string;
} {
  const backgroundColor = `hsl(${identityHue(seed)} 52% 42%)`;
  return { backgroundColor, color: identityInk(backgroundColor) };
}

/**
 * The three stops the .orb gradient spins through, plus the ink over them.
 *
 * They stay ANALOGOUS (within ~50° of each other) on purpose. The first
 * version swept hue → hue+45 → hue+310, i.e. two thirds of the wheel, and
 * once the conic gradient was blurred every orb averaged out to the same
 * warm smear — a blue agent and a green agent were indistinguishable. A
 * narrow sweep keeps each orb unmistakably one color family while still
 * reading as a lit, dimensional sphere.
 *
 * `--orb-ink` is measured against `--orb-b`, which is both the element's own
 * `background` (so it is what anything measuring contrast will read) and the
 * darkest of the three stops. The other two are lighter, which is why the
 * label also carries a halo in the ink's opposite — the gradient moves under
 * it and a single flat ink cannot be optimal against all of it at once.
 */
export function orbVars(seed: string, color?: string): Record<string, string> {
  // An explicitly chosen color (a space's swatch) always wins over the
  // derived one — otherwise picking a color in Space settings would appear
  // to do nothing in the sidebar.
  if (color) {
    return {
      "--orb-a": `color-mix(in oklab, ${color} 72%, white)`,
      "--orb-b": color,
      "--orb-c": `color-mix(in oklab, ${color} 82%, black)`,
      "--orb-ink": identityInk(color),
      "--orb-halo": identityHalo(color),
    };
  }
  const hue = identityHue(seed);
  const base = `hsl(${(hue + 26) % 360} 82% 52%)`;
  return {
    "--orb-a": `hsl(${hue} 88% 66%)`,
    "--orb-b": base,
    "--orb-c": `hsl(${(hue + 350) % 360} 90% 72%)`,
    "--orb-ink": identityInk(base),
    "--orb-halo": identityHalo(base),
  };
}
