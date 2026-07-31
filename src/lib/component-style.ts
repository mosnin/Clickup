// How a component looks, as data.
//
// The appearance system answers "what does the app look like". This answers a
// narrower question the same way: what does *a panel* look like — its frame,
// its fill, how its chart draws bars, whether it has axes, which colours its
// series take. Nineteen axes, and because they compose, the reachable space is
// enormous: two people over identical primitives end up with screens that do
// not resemble each other.
//
// Three rules, and they are the same three that hold the appearance model
// together, because the failure modes are the same:
//
//   1. **The defaults reproduce the shipped design exactly.** Someone who
//      never opens the settings must see today's app. `tests/component-style`
//      asserts it, because "personalisation" that changes the look for
//      everyone is a regression wearing a feature's clothes.
//   2. **Everything is a sparse patch.** Absence means "ask the layer beneath
//      me". A stored row holding all nineteen keys is indistinguishable from
//      someone having pinned all nineteen, and a space theme could then never
//      reach anyone who had once opened the panel.
//   3. **The vocabulary is closed.** Agents author component definitions, so
//      `normalizeStyle` drops anything it does not enumerate. A style is a
//      choice among named options, never a colour string, a CSS fragment, or
//      a number the renderer will paste into a stylesheet.
//
// Resolution runs general → specific:
//
//     defaults → your global style → the space's → your override of the space
//               → this component's own override
//
// The component override is last because it is the most specific statement
// anyone made: "this panel, in particular, is a dial".

// ── The axes ────────────────────────────────────────────────────────────

/** The panel's outer treatment. */
export type Frame = "bento" | "flat" | "outlined" | "glass" | "solid" | "none";
/** What the panel's background is made of. */
export type Fill = "surface" | "muted" | "accent" | "gradient" | "inverted";
export type Padding = "tight" | "normal" | "roomy";
/** "inherit" follows the app-wide radius; the rest pin it. */
export type Corner = "inherit" | "square" | "soft" | "round";
export type TitleStyle = "micro" | "plain" | "large" | "hidden";
export type TitleAlign = "left" | "center";
/** A coloured strip marking the panel, as on a KPI card. */
export type AccentEdge = "none" | "top" | "left";

export type Palette =
  | "mono"
  | "pastel"
  | "vivid"
  | "neon"
  | "ocean"
  | "ember"
  | "forest"
  | "grape"
  | "slate"
  | "contrast";

export type ChartFill = "solid" | "gradient" | "soft" | "outline";
export type Curve = "linear" | "smooth" | "step";
export type BarShape = "square" | "rounded" | "pill";
export type BarWidth = "thin" | "normal" | "thick";
export type Axes = "none" | "x" | "y" | "both";
export type Grid = "none" | "horizontal" | "vertical" | "both";
export type DataLabels = "none" | "value" | "percent";
export type Legend = "none" | "bottom" | "right";
export type Markers = "none" | "dot" | "ring";
export type StackMode = "none" | "stacked" | "grouped" | "percent";

export type ComponentStyle = {
  frame: Frame;
  fill: Fill;
  padding: Padding;
  corner: Corner;
  titleStyle: TitleStyle;
  titleAlign: TitleAlign;
  accentEdge: AccentEdge;
  palette: Palette;
  chartFill: ChartFill;
  curve: Curve;
  barShape: BarShape;
  barWidth: BarWidth;
  axes: Axes;
  grid: Grid;
  dataLabels: DataLabels;
  legend: Legend;
  markers: Markers;
  stackMode: StackMode;
  /** Hole size for a donut, as a share of its radius. 0 is a pie. */
  donutHole: number;
};

/**
 * The shipped look.
 *
 * Every value here is what the app already draws. Changing one changes the
 * product for everyone who never opened the settings, which is the one thing
 * this system must not do by accident.
 */
export const DEFAULT_STYLE: ComponentStyle = {
  frame: "bento",
  fill: "surface",
  padding: "normal",
  corner: "inherit",
  titleStyle: "micro",
  titleAlign: "left",
  accentEdge: "none",
  palette: "mono",
  chartFill: "solid",
  curve: "smooth",
  barShape: "rounded",
  barWidth: "normal",
  axes: "x",
  grid: "horizontal",
  dataLabels: "none",
  legend: "none",
  markers: "none",
  stackMode: "none",
  donutHole: 0.62,
};

const ENUMS = {
  frame: ["bento", "flat", "outlined", "glass", "solid", "none"],
  fill: ["surface", "muted", "accent", "gradient", "inverted"],
  padding: ["tight", "normal", "roomy"],
  corner: ["inherit", "square", "soft", "round"],
  titleStyle: ["micro", "plain", "large", "hidden"],
  titleAlign: ["left", "center"],
  accentEdge: ["none", "top", "left"],
  palette: [
    "mono",
    "pastel",
    "vivid",
    "neon",
    "ocean",
    "ember",
    "forest",
    "grape",
    "slate",
    "contrast",
  ],
  chartFill: ["solid", "gradient", "soft", "outline"],
  curve: ["linear", "smooth", "step"],
  barShape: ["square", "rounded", "pill"],
  barWidth: ["thin", "normal", "thick"],
  axes: ["none", "x", "y", "both"],
  grid: ["none", "horizontal", "vertical", "both"],
  dataLabels: ["none", "value", "percent"],
  legend: ["none", "bottom", "right"],
  markers: ["none", "dot", "ring"],
  stackMode: ["none", "stacked", "grouped", "percent"],
} as const;

export const STYLE_ENUMS = ENUMS;

const RANGES = {
  donutHole: [0, 0.85] as const,
};

export const STYLE_RANGES = RANGES;

export type StyleKey = keyof ComponentStyle;

export const STYLE_KEYS = Object.keys(DEFAULT_STYLE) as StyleKey[];

/** Keys that describe the frame rather than the chart inside it. */
export const FRAME_KEYS: readonly StyleKey[] = [
  "frame",
  "fill",
  "padding",
  "corner",
  "titleStyle",
  "titleAlign",
  "accentEdge",
];

/** Keys that describe how data is drawn. */
export const CHART_KEYS: readonly StyleKey[] = [
  "palette",
  "chartFill",
  "curve",
  "barShape",
  "barWidth",
  "axes",
  "grid",
  "dataLabels",
  "legend",
  "markers",
  "stackMode",
  "donutHole",
];

export type StylePatch = Partial<ComponentStyle>;

/**
 * Coerce anything into a sparse patch.
 *
 * Values of the wrong *kind* — an enum member this build has never heard of, a
 * colour where a named option belongs — are dropped rather than coerced to the
 * default, because coercing silently promotes garbage into an explicit
 * override that shadows the layer beneath it. Out-of-range numbers clamp,
 * because "as large as possible" is a real intention badly expressed.
 */
export function normalizeStylePatch(
  input: unknown,
  allow: readonly StyleKey[] = STYLE_KEYS,
): StylePatch {
  const raw = (input ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of allow) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (key in ENUMS) {
      const allowed: readonly string[] = ENUMS[key as keyof typeof ENUMS];
      if (typeof value !== "string" || !allowed.includes(value)) continue;
      out[key] = value;
    } else {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const [lo, hi] = RANGES[key as keyof typeof RANGES];
      out[key] = Math.min(hi, Math.max(lo, value));
    }
  }
  return out as StylePatch;
}

/** Coerce anything into a complete, renderable style. */
export function normalizeStyle(input: unknown): ComponentStyle {
  return { ...DEFAULT_STYLE, ...normalizeStylePatch(input) };
}

export type StyleLayerId =
  | "default"
  | "personal"
  | "space"
  | "personalSpace"
  /** The look the panel's own definition carries. */
  | "definition"
  | "component";

export type ResolvedStyle = {
  style: ComponentStyle;
  /**
   * Which layer each value came from.
   *
   * Not diagnostics: it is what lets a control say "this is the space's value,
   * not yours" and offer to stop overriding it. Without it the customiser is a
   * set of dropdowns whose values arrive from nowhere.
   */
  sources: Record<StyleKey, StyleLayerId>;
};

/**
 * Fold the layers, general → specific.
 *
 * The reader's own patch for this panel is last because it is the most
 * specific statement anyone made about it. Just above it sits the look the
 * definition carries — how its author drew it. That ordering is what lets a
 * panel arrive already looking like itself (an agent writes "spend, as a
 * donut, in red") while still losing to the reader who says "not on my
 * screen". A definition that outranked the reader would make every shared or
 * agent-authored panel a change to somebody else's dashboard.
 *
 * Nothing here is filtered by layer: unlike the appearance model, there is no
 * key a space may not set, because none of these is an accessibility setting —
 * they are all about how one panel draws.
 */
export function resolveStyle(input: {
  personal?: unknown;
  space?: unknown;
  personalSpace?: unknown;
  definition?: unknown;
  component?: unknown;
}): ResolvedStyle {
  const layers: { id: StyleLayerId; patch: StylePatch }[] = [
    { id: "personal", patch: normalizeStylePatch(input.personal) },
    { id: "space", patch: normalizeStylePatch(input.space) },
    { id: "personalSpace", patch: normalizeStylePatch(input.personalSpace) },
    { id: "definition", patch: normalizeStylePatch(input.definition) },
    { id: "component", patch: normalizeStylePatch(input.component) },
  ];

  const style = { ...DEFAULT_STYLE };
  const sources = {} as Record<StyleKey, StyleLayerId>;
  for (const key of STYLE_KEYS) sources[key] = "default";

  for (const layer of layers) {
    for (const key of STYLE_KEYS) {
      const value = layer.patch[key];
      if (value === undefined) continue;
      (style[key] as unknown) = value;
      sources[key] = layer.id;
    }
  }
  return { style, sources };
}

/**
 * Stop overriding these keys at this layer.
 *
 * Deleting rather than copying down the parent's current value: copying looks
 * identical today and stops tracking tomorrow, so a space that gets re-themed
 * would leave everyone who had "matched the space" frozen on the old look.
 */
export function clearStyleKeys(
  patch: StylePatch,
  keys: readonly StyleKey[],
): StylePatch {
  const out: StylePatch = { ...patch };
  for (const key of keys) delete out[key];
  return out;
}

/** Drop keys equal to the shipped default, recovering sparse intent. */
export function pruneStylePatch(input: unknown): StylePatch {
  const patch = normalizeStylePatch(input);
  const out: StylePatch = {};
  for (const key of STYLE_KEYS) {
    const value = patch[key];
    if (value === undefined || value === DEFAULT_STYLE[key]) continue;
    (out[key] as unknown) = value;
  }
  return out;
}

// ── Palettes ────────────────────────────────────────────────────────────
//
// The series colours. Two kinds, deliberately:
//
// **`mono` is computed from the theme's own tokens** via `color-mix`, so it is
// correct in light and dark without maintaining two lists — a hard-coded grey
// ramp would be invisible on one of them. It is also the default, which is how
// the shipped monochrome design survives this feature: a chart drawn by
// someone who never opened the settings is drawn in ink.
//
// **The rest are fixed hues**, because a palette called "vivid" that adapted
// itself to the theme would not be vivid. They are opt-in.
//
// Six stops each: past six series a chart needs a different shape, not more
// colours, and cycling produces two identical series in one legend.

const MIX = (percent: number) =>
  `color-mix(in srgb, var(--color-foreground) ${percent}%, var(--color-background))`;

const PALETTES: Record<Palette, string[]> = {
  // Ink, stepped so neighbouring series stay distinguishable at small sizes.
  mono: [MIX(92), MIX(70), MIX(52), MIX(38), MIX(26), MIX(16)],
  // The product's own chip colours.
  pastel: ["#a8c7ea", "#f0b6ab", "#f2ddA0", "#a9dcc2", "#c4b3ec", "#efb9e2"],
  vivid: ["#2563eb", "#e11d48", "#f59e0b", "#10b981", "#8b5cf6", "#ec4899"],
  neon: ["#22d3ee", "#a3e635", "#f472b6", "#facc15", "#818cf8", "#fb7185"],
  ocean: ["#0e7490", "#0891b2", "#22d3ee", "#67e8f9", "#155e75", "#a5f3fc"],
  ember: ["#7c2d12", "#c2410c", "#ea580c", "#f97316", "#fb923c", "#fdba74"],
  forest: ["#14532d", "#166534", "#15803d", "#22c55e", "#4ade80", "#86efac"],
  grape: ["#4c1d95", "#6d28d9", "#8b5cf6", "#a78bfa", "#c4b5fd", "#ddd6fe"],
  slate: ["#0f172a", "#334155", "#475569", "#64748b", "#94a3b8", "#cbd5e1"],
  // Deliberately maximally separable, for anyone who needs it to be.
  contrast: ["#000000", "#e11d48", "#2563eb", "#f59e0b", "#10b981", "#8b5cf6"],
};

/** The colours for a palette, in order. */
export function paletteColors(palette: Palette): string[] {
  return PALETTES[palette] ?? PALETTES.mono;
}

/**
 * The colour for series `index`.
 *
 * Wraps rather than running out, but see the note above: a chart needing more
 * than six is a chart that needs a different shape.
 */
export function seriesColor(palette: Palette, index: number): string {
  const colors = paletteColors(palette);
  return colors[((index % colors.length) + colors.length) % colors.length];
}

// ── Style → concrete values ─────────────────────────────────────────────

/** Corner radius for a panel, in rem, or null to inherit the app's. */
export function cornerRadius(corner: Corner): string | null {
  switch (corner) {
    case "inherit":
      return null;
    case "square":
      return "0rem";
    case "soft":
      return "0.5rem";
    case "round":
      return "1.5rem";
  }
}

export function paddingRem(padding: Padding): string {
  return padding === "tight" ? "0.75rem" : padding === "roomy" ? "1.75rem" : "1.25rem";
}

/** Bar width as a share of its slot — the gap is what is left over. */
export function barPadding(width: BarWidth): number {
  return width === "thin" ? 0.55 : width === "thick" ? 0.08 : 0.28;
}

/** Corner radius for one bar, given its drawn width. */
export function barRadius(shape: BarShape, bandwidth: number): number {
  if (shape === "square") return 0;
  if (shape === "pill") return bandwidth / 2;
  return Math.min(4, bandwidth / 4);
}

/** Should this chart stack, group, or neither? */
export function isStacked(mode: StackMode): boolean {
  return mode === "stacked" || mode === "percent";
}

// ── Presets ─────────────────────────────────────────────────────────────
//
// Nineteen dropdowns with no starting point is a surface nobody touches.
// "Pick one of these, then adjust" is one people use — and the presets are
// where the range actually becomes visible, because a name plus a drawing
// communicates a look that a list of enum values never will.

export type StylePreset = {
  id: string;
  name: string;
  description: string;
  patch: StylePatch;
};

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: "editorial",
    name: "Editorial",
    description: "The shipped look. Ink on a soft card, one hairline of grid.",
    patch: {},
  },
  {
    id: "report",
    name: "Report",
    description: "Both axes, full grid, values on the marks. Built to be read closely.",
    patch: {
      frame: "outlined",
      axes: "both",
      grid: "both",
      dataLabels: "value",
      legend: "bottom",
      barShape: "square",
      curve: "linear",
      markers: "dot",
    },
  },
  {
    id: "deck",
    name: "Deck",
    description: "Pastel series on tiles, no chrome. For a screen you glance at.",
    patch: {
      frame: "bento",
      palette: "pastel",
      axes: "none",
      grid: "none",
      barShape: "pill",
      chartFill: "soft",
      titleStyle: "plain",
      padding: "roomy",
    },
  },
  {
    id: "console",
    name: "Console",
    description: "Vivid on dark panels, thin bars, a legend on the right.",
    patch: {
      frame: "solid",
      fill: "inverted",
      palette: "vivid",
      barWidth: "thin",
      barShape: "square",
      grid: "horizontal",
      legend: "right",
      corner: "soft",
    },
  },
  {
    id: "glass",
    name: "Glass",
    description: "Translucent, round, gradient fills. Sits over whatever is behind it.",
    patch: {
      frame: "glass",
      corner: "round",
      chartFill: "gradient",
      palette: "ocean",
      curve: "smooth",
      grid: "none",
      axes: "x",
      markers: "ring",
    },
  },
  {
    id: "ledger",
    name: "Ledger",
    description: "Square, flat, grey, dense. Numbers first and nothing else.",
    patch: {
      frame: "flat",
      corner: "square",
      padding: "tight",
      palette: "slate",
      barShape: "square",
      barWidth: "thick",
      curve: "step",
      axes: "both",
      grid: "horizontal",
      dataLabels: "value",
      titleStyle: "plain",
    },
  },
  {
    id: "neon",
    name: "Neon",
    description: "High-contrast hues on an inverted card, no grid.",
    patch: {
      frame: "solid",
      fill: "inverted",
      palette: "neon",
      chartFill: "gradient",
      grid: "none",
      axes: "none",
      corner: "round",
      barShape: "pill",
      markers: "dot",
      titleStyle: "large",
    },
  },
  {
    id: "accessible",
    name: "High contrast",
    description: "Maximally separable colours, labelled marks, both axes.",
    patch: {
      frame: "outlined",
      palette: "contrast",
      axes: "both",
      grid: "both",
      dataLabels: "value",
      legend: "bottom",
      markers: "ring",
      barShape: "square",
    },
  },
];

/** Which preset a style currently matches exactly, if any. */
export function matchingStylePresetId(style: ComponentStyle): string | null {
  const found = STYLE_PRESETS.find((preset) => {
    const resolved = { ...DEFAULT_STYLE, ...normalizeStylePatch(preset.patch) };
    return STYLE_KEYS.every((k) => resolved[k] === style[k]);
  });
  return found?.id ?? null;
}

/** A style in words, for a preview caption or an agent's proposal. */
export function describeStyle(style: ComponentStyle): string {
  const bits: string[] = [];
  bits.push(style.palette === "mono" ? "ink" : style.palette);
  if (style.frame !== "bento") bits.push(`${style.frame} frame`);
  if (style.axes === "none" && style.grid === "none") bits.push("no chrome");
  if (style.stackMode !== "none") bits.push(style.stackMode);
  if (style.dataLabels !== "none") bits.push(`${style.dataLabels} labels`);
  if (style.legend !== "none") bits.push(`legend ${style.legend}`);
  return bits.join(", ");
}

// ── The two things anyone actually picks ────────────────────────────────
//
// A style axis is not a choice a person wants to make. "Bar shape: square /
// rounded / pill" asks somebody to hold a stylesheet in their head and then
// judge the result on data they can't see. What people ask for is a *look*,
// already made, that they can recognise and switch to.
//
// So there are exactly two galleries, split along the line that is already in
// this file: `CARD_PRESETS` set the surface a panel sits on (FRAME_KEYS) and
// `CHART_PRESETS` set how the data inside is drawn (CHART_KEYS). Split rather
// than combined because they are independent choices — a soft card with a
// dense report chart is a reasonable thing to want, and one merged gallery
// would make it unreachable.
//
// Each preset is narrowed to its own half, so picking a card look cannot
// silently change the chart and vice versa. That is what makes the two
// galleries composable instead of last-one-wins.

/** The surface a panel sits on. */
export const CARD_PRESETS: StylePreset[] = [
  {
    id: "soft",
    name: "Soft",
    description: "The shipped card. A floating shadow, no border.",
    patch: {},
  },
  {
    id: "bordered",
    name: "Bordered",
    description: "One hairline, square corners. Reads as a document.",
    patch: { frame: "flat", corner: "soft", padding: "normal" },
  },
  {
    id: "outlined",
    name: "Outlined",
    description: "A heavy ink rule. Loud on purpose.",
    patch: { frame: "outlined", corner: "square", titleStyle: "plain" },
  },
  {
    id: "glass",
    name: "Glass",
    description: "Frosted, for a card over something.",
    patch: { frame: "glass", corner: "round", padding: "roomy" },
  },
  {
    id: "raised",
    name: "Raised",
    description: "Lifted off the page.",
    patch: { frame: "solid", corner: "round", titleStyle: "large" },
  },
  {
    id: "bare",
    name: "Bare",
    description: "No card at all. The numbers sit on the page.",
    patch: { frame: "none", fill: "surface", padding: "tight" },
  },
  {
    id: "inverted",
    name: "Inverted",
    description: "Ink card, light type. One of these on a screen, not six.",
    patch: { fill: "inverted", corner: "round", titleStyle: "large" },
  },
  {
    id: "banded",
    name: "Banded",
    description: "A rule of colour along the top edge.",
    patch: { accentEdge: "top", frame: "flat", titleAlign: "center" },
  },
];

/**
 * How the data inside is drawn.
 *
 * The same named looks the studio has always offered, narrowed to the chart
 * half so choosing one leaves the card alone.
 */
export const CHART_PRESETS: StylePreset[] = STYLE_PRESETS.map((preset) => ({
  ...preset,
  patch: normalizeStylePatch(preset.patch, CHART_KEYS),
}));
