// The appearance model: one user's UI, as data.
//
// The whole design system already runs on CSS custom properties, so
// personalisation does not need a single component to change — it needs the
// tokens to become per-user. This module is the pure half of that: settings in,
// a flat map of CSS variables out. No DOM, no React, no Convex, so the token
// maths is testable and the same function can run on the server for a
// no-flash first paint.
//
// Two rules hold this together:
//
//   1. **The defaults must reproduce today's design exactly.** Personalisation
//      that changes the look of the app for someone who never opened the
//      settings is a bug, not a feature. `resolveTokens(DEFAULT_APPEARANCE)`
//      is asserted against the shipped values.
//   2. **Every setting is clamped on the way in.** These values arrive from a
//      slider, from a stored row written by an older build, and (eventually)
//      from an agent. A font scale of 40 is not a preference, it is an
//      unusable app.

export type Density = "compact" | "comfortable" | "spacious";
export type SurfaceStyle = "flat" | "soft" | "raised" | "bordered";
/**
 * Where the navigation lives.
 *
 * "dock" is the bottom-edge Apple-style dock: the nav stops being a column of
 * labels and becomes a row of glyphs that magnify under the cursor, with the
 * detail moving into panels that rise from the item you pressed. It is a
 * genuinely different shape rather than the sidebar rotated, which is why it is
 * a position rather than a style.
 */
export type SidebarPosition = "left" | "right" | "floating" | "dock";
export type AccentMode = "ink" | "hue";

/**
 * The body typeface.
 *
 * Every option here is either bundled with the app or already on the reader's
 * machine. Nothing is fetched from a CDN — a preference that costs a
 * third-party request on every page load is not a preference worth having, and
 * the repo forbids it besides. "system" is the reader's own interface font,
 * which on a Mac is San Francisco and on Windows is Segoe: the app looking
 * like the rest of the machine is a legitimate thing to want.
 */
export type FontFamily =
  | "instrument"
  | "system"
  | "serif"
  | "mono"
  | "rounded";

/**
 * The heading typeface, chosen separately.
 *
 * "match" is the interesting value: it means "stop having a display face at
 * all", which is what someone reaching for a plainer app actually wants. A
 * pairing is a decision, and this is where it is made.
 */
export type DisplayFont = "space" | "grotesque" | "match" | "serif" | "mono";

/** How a repeating row of things is drawn. */
export type ListStyle = "rows" | "lines" | "cards" | "condensed";

/** How a single number-over-time or number-against-target is drawn. */
export type ChartStyle = "bar" | "ring" | "line" | "numeric";

/** How a teammate — person or agent — is represented next to their name. */
export type AgentIconStyle = "orb" | "monogram" | "dot" | "glyph";

export type Appearance = {
  /** Where the primary navigation lives. */
  sidebarPosition: SidebarPosition;
  /** Sidebar width in rem, so it scales with the font. */
  sidebarWidth: number;
  /** "ink" keeps the monochrome system; "hue" drives the ramp from a hue. */
  accentMode: AccentMode;
  accentHue: number;
  accentSaturation: number;
  /** Multiplier on every corner radius. 0 is square, 2 is very round. */
  radiusScale: number;
  density: Density;
  surface: SurfaceStyle;
  /** Multiplier on the root font size — the widest-reaching single lever. */
  fontScale: number;
  /**
   * Motion multiplier. 0 disables animation without disabling the app; 1 is
   * the designed timing; 1.5 is deliberately slow and rather nice.
   */
  motionScale: number;
  /** Extra weight on headings, for people who want more or less contrast. */
  headingWeight: number;
  /** The body typeface. */
  fontFamily: FontFamily;
  /** The heading typeface, which may be "the same as the body". */
  displayFont: DisplayFont;
  /**
   * How hard secondary text works.
   *
   * 1 is the shipped grey. Above 1 it walks toward the foreground, which is
   * the single most requested legibility change in any interface with a lot of
   * muted metadata; below 1 it recedes, for people who want the labels quieter
   * than the content.
   */
  contrast: number;
  /** How a repeating row of things is drawn. */
  listStyle: ListStyle;
  /** How a number-against-a-target is drawn. */
  chartStyle: ChartStyle;
  /** How a teammate is represented next to their name. */
  agentIcon: AgentIconStyle;
  /** Stroke width for every line icon in the app. */
  iconStroke: number;
};

export const DEFAULT_APPEARANCE: Appearance = {
  sidebarPosition: "left",
  sidebarWidth: 16,
  accentMode: "ink",
  accentHue: 258,
  accentSaturation: 70,
  radiusScale: 1,
  density: "comfortable",
  surface: "soft",
  fontScale: 1,
  motionScale: 1,
  headingWeight: 700,
  fontFamily: "instrument",
  displayFont: "space",
  contrast: 1,
  listStyle: "rows",
  chartStyle: "bar",
  agentIcon: "orb",
  iconStroke: 2,
};

const RANGES = {
  sidebarWidth: [12, 24] as const,
  accentHue: [0, 360] as const,
  accentSaturation: [0, 100] as const,
  radiusScale: [0, 2] as const,
  fontScale: [0.85, 1.25] as const,
  motionScale: [0, 1.5] as const,
  headingWeight: [500, 800] as const,
  contrast: [0.7, 1.5] as const,
  iconStroke: [1, 2.75] as const,
};

export const APPEARANCE_RANGES = RANGES;

function clampNumber(value: unknown, [min, max]: readonly [number, number], fallback: number) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(n, min), max);
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * The allowed values for each choice-shaped key.
 *
 * Declared once and read by both `normalizeAppearance` and `normalizePatch`.
 * They used to keep their own copies of these lists, which is a bug waiting for
 * the next option to be added to one and not the other — a value the full
 * normalizer accepts and the patch normalizer silently drops is a setting that
 * saves and then doesn't.
 */
const ENUM_VALUES = {
  sidebarPosition: ["left", "right", "floating", "dock"],
  accentMode: ["ink", "hue"],
  density: ["compact", "comfortable", "spacious"],
  surface: ["flat", "soft", "raised", "bordered"],
  fontFamily: ["instrument", "system", "serif", "mono", "rounded"],
  displayFont: ["space", "grotesque", "match", "serif", "mono"],
  listStyle: ["rows", "lines", "cards", "condensed"],
  chartStyle: ["bar", "ring", "line", "numeric"],
  agentIcon: ["orb", "monogram", "dot", "glyph"],
} as const;

export const APPEARANCE_ENUMS = ENUM_VALUES;

/**
 * Coerce anything into a usable Appearance.
 *
 * Deliberately total: a row written by an older build, a partial patch from a
 * slider, or a hand-rolled object all resolve to something the UI can render.
 */
export function normalizeAppearance(input: unknown): Appearance {
  const raw = (input ?? {}) as Partial<Appearance>;
  const d = DEFAULT_APPEARANCE;
  return {
    sidebarPosition: pick(
      raw.sidebarPosition,
      ENUM_VALUES.sidebarPosition,
      d.sidebarPosition,
    ),
    sidebarWidth: clampNumber(raw.sidebarWidth, RANGES.sidebarWidth, d.sidebarWidth),
    accentMode: pick(raw.accentMode, ENUM_VALUES.accentMode, d.accentMode),
    accentHue: clampNumber(raw.accentHue, RANGES.accentHue, d.accentHue),
    accentSaturation: clampNumber(
      raw.accentSaturation,
      RANGES.accentSaturation,
      d.accentSaturation,
    ),
    radiusScale: clampNumber(raw.radiusScale, RANGES.radiusScale, d.radiusScale),
    density: pick(raw.density, ENUM_VALUES.density, d.density),
    surface: pick(raw.surface, ENUM_VALUES.surface, d.surface),
    fontScale: clampNumber(raw.fontScale, RANGES.fontScale, d.fontScale),
    motionScale: clampNumber(raw.motionScale, RANGES.motionScale, d.motionScale),
    headingWeight: clampNumber(
      raw.headingWeight,
      RANGES.headingWeight,
      d.headingWeight,
    ),
    fontFamily: pick(raw.fontFamily, ENUM_VALUES.fontFamily, d.fontFamily),
    displayFont: pick(raw.displayFont, ENUM_VALUES.displayFont, d.displayFont),
    contrast: clampNumber(raw.contrast, RANGES.contrast, d.contrast),
    listStyle: pick(raw.listStyle, ENUM_VALUES.listStyle, d.listStyle),
    chartStyle: pick(raw.chartStyle, ENUM_VALUES.chartStyle, d.chartStyle),
    agentIcon: pick(raw.agentIcon, ENUM_VALUES.agentIcon, d.agentIcon),
    iconStroke: clampNumber(raw.iconStroke, RANGES.iconStroke, d.iconStroke),
  };
}

// ── Layers ──────────────────────────────────────────────────────────────
//
// One person's settings are not the only thing that decides what the app looks
// like. A space has a look of its own that everyone in it sees, and a person
// can still diverge from it for themselves. That is three writers for one set
// of tokens, so the model needs a precedence rule — and the rule is not "last
// writer wins", it is **a setting belongs to whoever it is about**.
//
//   - Keys about the *place* — the accent, the corner radius, the surface —
//     are what makes walking into a space feel like a different room. A space
//     sets these for everyone in it.
//   - Keys about the *person* — type size, motion, density, where the sidebar
//     lives — belong to the person and nothing else may set them. A workspace
//     that shrinks your type, or re-enables motion you turned off, is hostile.
//     This is enforced by the allow-list below rather than by convention, so
//     there is no code path that can write a personal key into a space theme.
//
// Resolution runs general → specific: defaults, then the person's preferences,
// then the space's theme, then the person's override for that space. A space
// theme beating your global accent is the entire point of a space theme; the
// last layer exists for when you disagree with it.

export type AppearanceKey = keyof Appearance;

/** Keys a space may set, because they describe the place rather than you. */
export const PLACE_KEYS = [
  "accentMode",
  "accentHue",
  "accentSaturation",
  "radiusScale",
  "surface",
  // How a list of things is drawn, how a number is charted, and how a teammate
  // is pictured are all decisions about the room's visual language. A team that
  // agrees its lists are cards should get cards, the same way it gets its
  // accent — and someone who disagrees still overrides it for themselves.
  "listStyle",
  "chartStyle",
  "agentIcon",
  "iconStroke",
  // The display face is the room's voice. The body face is not: see below.
  "displayFont",
] as const satisfies readonly AppearanceKey[];

/** Keys only the person may set, because they describe how they read. */
export const PERSONAL_KEYS = [
  "sidebarPosition",
  "sidebarWidth",
  "density",
  "fontScale",
  "motionScale",
  "headingWeight",
  // The face you read paragraphs in, and how hard the secondary text works,
  // are accessibility settings wearing a style costume. Someone who switched
  // to a system font because it renders better for them, or raised the
  // contrast because the grey was too light, must not have a workspace put it
  // back — that is the same class of harm as a space shrinking your type.
  "fontFamily",
  "contrast",
] as const satisfies readonly AppearanceKey[];

export const APPEARANCE_KEYS = Object.keys(
  DEFAULT_APPEARANCE,
) as AppearanceKey[];

/**
 * A partial set of settings: only the keys someone explicitly chose.
 *
 * Sparseness is what makes layering work at all. A stored row holding all
 * eleven keys is indistinguishable from someone having deliberately pinned all
 * eleven, so a space theme could never reach anyone who had once opened the
 * settings panel. What is *absent* from a patch is as meaningful as what is in
 * it: absent means "whatever the layer under me says".
 */
export type AppearancePatch = Partial<Appearance>;

/**
 * Coerce anything into a sparse patch, keeping only keys in `allow`.
 *
 * Out-of-range numbers are clamped, because "as large as possible" is a real
 * intention badly expressed. Values of the wrong *kind* — a colour where a
 * number belongs, an enum member this build has never heard of — are dropped
 * rather than coerced to the default: coercing them would silently promote
 * garbage into an explicit override that shadows the layer beneath it.
 */
export function normalizePatch(
  input: unknown,
  allow: readonly AppearanceKey[] = APPEARANCE_KEYS,
): AppearancePatch {
  const raw = (input ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of allow) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (key in ENUM_VALUES) {
      const allowed: readonly string[] =
        ENUM_VALUES[key as keyof typeof ENUM_VALUES];
      if (typeof value !== "string" || !allowed.includes(value)) continue;
    } else {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
    }
    // Clamp in isolation, so one key in gives the same key out and nothing
    // else is invented.
    out[key] = normalizeAppearance({ [key]: value })[key as AppearanceKey];
  }
  return out as AppearancePatch;
}

/** Which layer a resolved value came from. */
export type AppearanceLayerId =
  | "default"
  | "personal"
  | "space"
  | "personalSpace";

export type AppearanceLayer = {
  id: AppearanceLayerId;
  patch: AppearancePatch;
};

export type ResolvedAppearance = {
  appearance: Appearance;
  /**
   * Where each value came from.
   *
   * This is not diagnostics — it is what lets a control say "this is the
   * space's value, not yours" and offer to stop overriding it. Without it the
   * customiser is a set of sliders whose numbers arrive from nowhere.
   */
  sources: Record<AppearanceKey, AppearanceLayerId>;
};

/** Fold layers in order — later layers win, key by key. */
export function resolveAppearance(
  layers: readonly AppearanceLayer[],
): ResolvedAppearance {
  const appearance = { ...DEFAULT_APPEARANCE };
  const sources = {} as Record<AppearanceKey, AppearanceLayerId>;
  for (const key of APPEARANCE_KEYS) sources[key] = "default";

  for (const layer of layers) {
    for (const key of APPEARANCE_KEYS) {
      const value = layer.patch[key];
      if (value === undefined) continue;
      // The cast is the one place this file gives up on the key-by-key type
      // relation; the patch is already normalized against the same key.
      (appearance[key] as unknown) = value;
      sources[key] = layer.id;
    }
  }
  return { appearance, sources };
}

/**
 * The canonical layer stack, with each source held to what it may set.
 *
 * Everything that resolves appearance goes through here rather than assembling
 * its own order, so "can a space change my font size" has exactly one answer
 * in exactly one place.
 */
export function appearanceLayers(input: {
  /** The person's preferences, everywhere. */
  personal?: unknown;
  /** The space's own look, shared by everyone in it. */
  space?: unknown;
  /** The person's divergence from that space's look. */
  personalSpace?: unknown;
}): AppearanceLayer[] {
  return [
    { id: "personal", patch: normalizePatch(input.personal) },
    { id: "space", patch: normalizePatch(input.space, PLACE_KEYS) },
    { id: "personalSpace", patch: normalizePatch(input.personalSpace, PLACE_KEYS) },
  ];
}

/** Resolve straight from stored rows — the shape the provider holds. */
export function resolveLayered(input: {
  personal?: unknown;
  space?: unknown;
  personalSpace?: unknown;
}): ResolvedAppearance {
  return resolveAppearance(appearanceLayers(input));
}

/**
 * Stop overriding these keys at this layer.
 *
 * Deleting the key rather than writing the parent's current value is the whole
 * point: copying the parent's value looks identical today and stops tracking
 * it tomorrow, so a space that gets re-themed would leave everyone who had
 * ever "matched the space" frozen on the old accent.
 */
export function clearKeys(
  patch: AppearancePatch,
  keys: readonly AppearanceKey[],
): AppearancePatch {
  const out: AppearancePatch = { ...patch };
  for (const key of keys) delete out[key];
  return out;
}

/**
 * Read a legacy row — a full eleven-key snapshot — as a patch.
 *
 * Before layering existed, saving wrote every key whether or not the person
 * had chosen it. Interpreted as a patch that pins everything, which would make
 * space themes invisible to every existing user. A key equal to the default is
 * indistinguishable from one that was never set, so dropping those recovers
 * the sparse intent without a migration.
 */
export function prunePatch(input: unknown): AppearancePatch {
  const patch = normalizePatch(input);
  const out: AppearancePatch = {};
  for (const key of APPEARANCE_KEYS) {
    const value = patch[key];
    if (value === undefined || value === DEFAULT_APPEARANCE[key]) continue;
    (out[key] as unknown) = value;
  }
  return out;
}

// ── Colour ──────────────────────────────────────────────────────────────

/**
 * HSL → hex, so the accent ramp can be generated from one hue.
 *
 * HSL rather than a perceptual space on purpose: the ramp is generated live
 * while someone drags a slider, and every step has to be cheap and monotonic.
 * The lightness stops below are chosen so any hue keeps enough contrast
 * against white text at the dark end and black text at the light end.
 */
export function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) =>
    lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/** The lightness stops for the accent ramp, matched to the ink defaults. */
const RAMP: { key: string; l: number; s: number }[] = [
  { key: "50", l: 97, s: 0.35 },
  { key: "100", l: 93, s: 0.45 },
  { key: "200", l: 86, s: 0.55 },
  { key: "500", l: 46, s: 1 },
  { key: "600", l: 34, s: 1 },
  { key: "700", l: 22, s: 1 },
];

/** The shipped monochrome ramp — what "ink" mode means. */
const INK_RAMP: Record<string, string> = {
  "50": "#f5f5f6",
  "100": "#e9e9ec",
  "200": "#d9d9de",
  "500": "#3f3f46",
  "600": "#131316",
  "700": "#000000",
};

/**
 * The font stacks.
 *
 * `--font-instrument` and `--font-darker-grotesque` are the two faces the app
 * actually ships (next/font/local, in `src/app/fonts`). Everything else is a
 * generic family plus the names of faces that are already installed on the
 * reader's machine, so switching typeface costs zero bytes and works offline.
 * `ui-serif`/`ui-monospace`/`ui-rounded` lead each stack because they resolve
 * to whatever the platform considers its own, which is the point of asking.
 */
const FONT_STACKS: Record<FontFamily, string> = {
  instrument:
    'var(--font-instrument), "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  system:
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  rounded:
    'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", Quicksand, system-ui, sans-serif',
};

/** "match" resolves against the body face, so it is applied separately. */
const DISPLAY_STACKS: Record<Exclude<DisplayFont, "match">, string> = {
  // The shipped face. Proportional geometric grotesque with distinctive
  // numerals — see the note in app/layout.tsx for why it replaced the
  // condensed one as the default.
  space:
    'var(--font-space-grotesk), var(--font-instrument), "Inter", sans-serif',
  // Still offered, still bundled: a face somebody chose has to keep working.
  grotesque:
    'var(--font-darker-grotesque), var(--font-instrument), "Inter", sans-serif',
  serif: FONT_STACKS.serif,
  mono: FONT_STACKS.mono,
};

/** The CSS stack for a body face — so a specimen can render in it. */
export function fontStackFor(family: FontFamily): string {
  return FONT_STACKS[family];
}

/** The CSS stack for a heading face, resolving "match" against the body. */
export function displayStackFor(
  display: DisplayFont,
  family: FontFamily,
): string {
  return display === "match" ? FONT_STACKS[family] : DISPLAY_STACKS[display];
}

const DENSITY_TOKENS: Record<Density, { gap: string; row: string; pad: string }> = {
  compact: { gap: "0.5rem", row: "1.75rem", pad: "0.75rem" },
  comfortable: { gap: "0.75rem", row: "2.25rem", pad: "1.25rem" },
  spacious: { gap: "1.125rem", row: "2.75rem", pad: "1.75rem" },
};

// Written out rather than generated: these are design decisions, and a loop
// that produced them would be a loop nobody could read.
/**
 * The surface treatments.
 *
 * Shadows are expressed against two tokens the *stylesheet* owns —
 * `--ui-shade` (the dark side) and `--ui-glint` (the lit side) — rather than
 * hard-coded rgb. That is the fix for "raised does nothing in dark mode": a
 * near-black shadow on a near-black surface is invisible, and this file cannot
 * know which theme is on because it runs once and writes inline tokens that
 * would outrank the theme rule anyway. globals.css sets the two per theme.
 *
 * `raised` is genuinely neomorphic — light from the top-left, shade to the
 * bottom-right — rather than a drop shadow with more blur. That is what makes
 * it read as extruded from the canvas instead of floating above it, and it is
 * the one treatment that needs both sides to exist.
 */
const SURFACES: Record<SurfaceStyle, { shadow: string; tile: string; border: string }> = {
  flat: {
    shadow: "none",
    tile: "none",
    border: "1px solid var(--color-border)",
  },
  soft: {
    // NO hairline, and that is the shipped default. The canvas sits one
    // value-step below the cards (light #f7f7f8 under #fff, dark #131316
    // under #1e1e22), so the step + the shadow draw the card and a rim
    // around every surface — "obnoxious white borders" in the founder's
    // words — is exactly what this used to be. `--ui-surface-edge` is the
    // per-theme stabilizer globals.css declares (transparent in light, 4%
    // white in dark), so the token stays theme-correct without this module
    // knowing which theme is on.
    shadow: "0 1px 2px var(--ui-shade-weak), 0 8px 24px -14px var(--ui-shade)",
    tile: "inset 0 1px 0 var(--ui-glint)",
    border: "var(--ui-surface-edge)",
  },
  raised: {
    shadow:
      "7px 7px 16px var(--ui-shade), -7px -7px 16px var(--ui-glint-strong), inset 0 1px 0 var(--ui-glint)",
    tile: "inset 2px 2px 5px var(--ui-shade-weak), inset -2px -2px 5px var(--ui-glint)",
    border: "1px solid transparent",
  },
  bordered: {
    shadow: "none",
    tile: "none",
    border: "1px solid var(--color-foreground)",
  },
};

/**
 * Settings → CSS custom properties.
 *
 * The keys are the contract with globals.css. Every one of them has a
 * fallback baked into the stylesheet, so a browser that never runs the
 * provider still renders the shipped design.
 */
export function resolveTokens(input: Appearance): Record<string, string> {
  const a = normalizeAppearance(input);
  const tokens: Record<string, string> = {};

  // Accent ramp.
  if (a.accentMode === "ink") {
    for (const [key, hex] of Object.entries(INK_RAMP)) {
      tokens[`--color-brand-${key}`] = hex;
    }
  } else {
    for (const stop of RAMP) {
      tokens[`--color-brand-${stop.key}`] = hslToHex(
        a.accentHue,
        a.accentSaturation * stop.s,
        stop.l,
      );
    }
  }

  // Radius. One scale, three derived corners, so a card and its inner well
  // stay in proportion instead of drifting apart at the extremes.
  const r = a.radiusScale;
  tokens["--ui-radius-card"] = `${(1 * r).toFixed(3)}rem`;
  tokens["--ui-radius-control"] = `${(0.75 * r).toFixed(3)}rem`;
  tokens["--ui-radius-tile"] = `${(0.75 * r).toFixed(3)}rem`;
  // Pills stay pills until the scale is genuinely square, where a "pill" that
  // is still round next to square cards looks like a mistake.
  tokens["--ui-radius-pill"] = r < 0.15 ? `${(0.25 * r).toFixed(3)}rem` : "9999px";

  const density = DENSITY_TOKENS[a.density];
  tokens["--ui-gap"] = density.gap;
  tokens["--ui-row-height"] = density.row;
  tokens["--ui-pad"] = density.pad;

  const surface = SURFACES[a.surface];
  tokens["--ui-surface-shadow"] = surface.shadow;
  tokens["--ui-surface-tile-shadow"] = surface.tile;
  tokens["--ui-surface-border"] = surface.border;

  tokens["--ui-font-scale"] = a.fontScale.toFixed(3);
  tokens["--ui-motion-scale"] = a.motionScale.toFixed(3);
  tokens["--ui-heading-weight"] = String(Math.round(a.headingWeight));
  tokens["--ui-sidebar-width"] = `${a.sidebarWidth.toFixed(2)}rem`;

  const body = FONT_STACKS[a.fontFamily];
  tokens["--ui-font-body"] = body;
  tokens["--ui-font-display"] =
    a.displayFont === "match" ? body : DISPLAY_STACKS[a.displayFont];
  // Darker Grotesque is condensed with a small x-height, so headings set in it
  // carry a font-size-adjust to restore their optical size. Every other face
  // has an ordinary x-height and would be rendered a third too large by that
  // same number — the correction belongs to the face, not to the heading.
  // Space Grotesk, the default, needs none, which is half the reason it is the
  // default: a display face that requires a correction to sit level with body
  // copy is a display face fighting the layout.
  tokens["--ui-display-size-adjust"] =
    a.displayFont === "grotesque" ? "0.5" : "none";

  // Contrast is expressed as two mix percentages rather than a finished
  // colour, because `applyTokens` writes inline on the root element and an
  // inline `--color-muted-foreground` would outrank the dark-theme rule that
  // sets it — the setting would look right in light mode and break dark mode.
  // The stylesheet owns the base colour per theme; this only says how far to
  // push it and in which direction. Exactly one of these is ever non-zero.
  const shift = a.contrast - 1;
  tokens["--ui-muted-toward-fg"] = `${(Math.max(0, shift) * 100).toFixed(1)}%`;
  tokens["--ui-muted-toward-bg"] = `${(Math.max(0, -shift) * 100).toFixed(1)}%`;

  tokens["--ui-icon-stroke"] = a.iconStroke.toFixed(2);

  return tokens;
}

/** The numeric tokens anime.js can interpolate; the rest are swapped. */
export const ANIMATABLE_TOKENS = [
  "--ui-radius-card",
  "--ui-radius-control",
  "--ui-radius-tile",
  "--ui-font-scale",
  "--ui-sidebar-width",
  "--ui-gap",
  "--ui-pad",
  "--ui-row-height",
  "--ui-icon-stroke",
  "--ui-muted-toward-fg",
  "--ui-muted-toward-bg",
] as const;

// ── Presets ─────────────────────────────────────────────────────────────
//
// Presets are the answer to a blank slate. Nine sliders with no starting point
// is a customisation surface nobody touches; "pick one of these, then adjust"
// is one people actually use.

export type AppearancePreset = {
  id: string;
  name: string;
  description: string;
  settings: Appearance;
};

const preset = (
  id: string,
  name: string,
  description: string,
  overrides: Partial<Appearance>,
): AppearancePreset => ({
  id,
  name,
  description,
  settings: normalizeAppearance({ ...DEFAULT_APPEARANCE, ...overrides }),
});

export const APPEARANCE_PRESETS: AppearancePreset[] = [
  preset("editorial", "Editorial", "The shipped look: monochrome, soft surfaces.", {}),
  preset("compact", "Compact", "More on screen. Tighter rows, smaller type.", {
    density: "compact",
    fontScale: 0.92,
    radiusScale: 0.75,
    surface: "flat",
    listStyle: "condensed",
    chartStyle: "numeric",
    agentIcon: "dot",
    iconStroke: 1.75,
  }),
  preset("focus", "Focus", "Roomy and quiet, with the sidebar out of the way.", {
    density: "spacious",
    fontScale: 1.05,
    sidebarPosition: "floating",
    surface: "flat",
    motionScale: 0.75,
    listStyle: "lines",
    chartStyle: "line",
    contrast: 1.15,
  }),
  preset("vivid", "Vivid", "A coloured accent and stronger surfaces.", {
    accentMode: "hue",
    accentHue: 258,
    accentSaturation: 72,
    surface: "raised",
    radiusScale: 1.25,
    listStyle: "cards",
    chartStyle: "ring",
    agentIcon: "orb",
  }),
  preset("terminal", "Terminal", "Square, bordered, no shadows, no motion.", {
    radiusScale: 0,
    surface: "bordered",
    density: "compact",
    motionScale: 0,
    fontScale: 0.95,
    fontFamily: "mono",
    displayFont: "mono",
    listStyle: "condensed",
    chartStyle: "numeric",
    agentIcon: "glyph",
    iconStroke: 1.5,
    contrast: 1.2,
  }),
  preset("calm", "Calm", "Slow, round, generous.", {
    radiusScale: 1.6,
    density: "spacious",
    motionScale: 1.35,
    surface: "soft",
    fontScale: 1.08,
    fontFamily: "rounded",
    displayFont: "match",
    listStyle: "cards",
    iconStroke: 1.6,
  }),
  preset("broadsheet", "Broadsheet", "Serif throughout, ruled lists, quiet marks.", {
    fontFamily: "serif",
    displayFont: "serif",
    listStyle: "lines",
    chartStyle: "line",
    agentIcon: "monogram",
    surface: "flat",
    radiusScale: 0.4,
    headingWeight: 600,
    contrast: 1.1,
  }),
];

/** Which preset (if any) a settings object currently matches exactly. */
export function matchingPresetId(settings: Appearance): string | null {
  const a = normalizeAppearance(settings);
  const found = APPEARANCE_PRESETS.find((p) =>
    (Object.keys(a) as (keyof Appearance)[]).every((k) => p.settings[k] === a[k]),
  );
  return found?.id ?? null;
}
