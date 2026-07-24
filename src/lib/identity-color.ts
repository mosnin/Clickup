// One source of truth for "what color is this teammate?" — used by both the
// Orb (the living gradient sphere) and the Monogram (the initial circle), so
// an agent reads as the same color everywhere it appears.
//
// Colors come from a curated ramp rather than a free 0-359 hue: an unbounded
// hue lands on muddy olives and acid yellows that fight the brand, and white
// text stops being legible on them. Twelve hues, fixed saturation/lightness,
// deterministic per seed.

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

/**
 * Solid fill for an initial circle. Lightness is held at 42% so white text
 * clears WCAG AA on every hue in the ramp — including the yellows, which is
 * exactly where a naive HSL avatar palette fails.
 */
export function identityFill(seed: string): { backgroundColor: string } {
  return { backgroundColor: `hsl(${identityHue(seed)} 52% 42%)` };
}

/**
 * The three stops the .orb gradient spins through.
 *
 * They stay ANALOGOUS (within ~50° of each other) on purpose. The first
 * version swept hue → hue+45 → hue+310, i.e. two thirds of the wheel, and
 * once the conic gradient was blurred every orb averaged out to the same
 * warm smear — a blue agent and a green agent were indistinguishable. A
 * narrow sweep keeps each orb unmistakably one color family while still
 * reading as a lit, dimensional sphere.
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
    };
  }
  const hue = identityHue(seed);
  return {
    "--orb-a": `hsl(${hue} 88% 66%)`,
    "--orb-b": `hsl(${(hue + 26) % 360} 82% 52%)`,
    "--orb-c": `hsl(${(hue + 350) % 360} 90% 72%)`,
  };
}
