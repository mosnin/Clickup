"use client";

import { Chart, type ChartKind, type ChartSeries } from "@/components/charts/operate/chart";
import {
  DEFAULT_STYLE,
  normalizeStylePatch,
  paletteColors,
  type ComponentStyle,
  type StylePatch,
} from "@/lib/component-style";
import { cn } from "@/lib/utils";

// The gallery.
//
// The rule this file exists to enforce: **an option that can be drawn is
// drawn, at the size it will actually be used, with the real renderer.**
//
// The previous version put three grey bars next to the word "Ruled" and
// expected that to communicate a list style. It did not — every option looked
// like a loading skeleton, and nothing on the page resembled the product the
// settings were about to change. A specimen that is a drawing *of* a chart
// rather than a chart cannot tell you what choosing it does, and it drifts the
// moment the real renderer changes.
//
// So every tile below runs `<Chart>` with the same data and a different style.
// If a palette looks wrong here, it looks wrong in the app, because it is the
// same code path.

/** Enough shape to tell palettes and curves apart at thumbnail size. */
const SPECIMEN: ChartSeries[] = [
  {
    key: "a",
    label: "Shipped",
    points: [
      { key: "1", label: "Mon", value: 12 },
      { key: "2", label: "Tue", value: 19 },
      { key: "3", label: "Wed", value: 9 },
      { key: "4", label: "Thu", value: 24 },
      { key: "5", label: "Fri", value: 17 },
      { key: "6", label: "Sat", value: 28 },
    ],
  },
  {
    key: "b",
    label: "Open",
    points: [
      { key: "1", label: "Mon", value: 7 },
      { key: "2", label: "Tue", value: 5 },
      { key: "3", label: "Wed", value: 14 },
      { key: "4", label: "Thu", value: 8 },
      { key: "5", label: "Fri", value: 11 },
      { key: "6", label: "Sat", value: 6 },
    ],
  },
  {
    key: "c",
    label: "Blocked",
    points: [
      { key: "1", label: "Mon", value: 3 },
      { key: "2", label: "Tue", value: 8 },
      { key: "3", label: "Wed", value: 4 },
      { key: "4", label: "Thu", value: 6 },
      { key: "5", label: "Fri", value: 2 },
      { key: "6", label: "Sat", value: 9 },
    ],
  },
];

/** One series, for the shapes that only take one. */
const ONE_SERIES: ChartSeries[] = [SPECIMEN[0]];

export function specimenFor(kind: ChartKind): ChartSeries[] {
  const single: ChartKind[] = ["donut", "pie", "radial", "treemap", "waterfall"];
  return single.includes(kind) ? ONE_SERIES : SPECIMEN;
}

export function styleFrom(patch: StylePatch, base = DEFAULT_STYLE): ComponentStyle {
  return { ...base, ...normalizeStylePatch(patch) };
}

/**
 * A selectable tile holding a live specimen.
 *
 * The selected state is a filled ring plus a change of surface rather than a
 * hairline: on the dark theme a 1px ring in a muted colour is invisible, which
 * is exactly how the previous version ended up with no discernible selection
 * at all.
 */
export function GalleryTile({
  selected,
  label,
  hint,
  onPick,
  children,
  className,
}: {
  selected: boolean;
  label: string;
  hint?: string;
  onPick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onPick}
      className={cn(
        "group/tile relative flex flex-col overflow-hidden rounded-xl bg-card text-left transition-all duration-150",
        selected
          ? "ring-2 ring-foreground"
          : "ring-1 ring-border hover:ring-muted-foreground/40",
        className,
      )}
    >
      <span
        className={cn(
          "flex min-h-[104px] flex-1 items-center justify-center p-3 transition-colors",
          selected ? "bg-muted/40" : "bg-transparent",
        )}
      >
        {children}
      </span>
      <span className="flex items-baseline justify-between gap-2 border-t border-border px-3 py-2">
        <span className="truncate text-xs font-medium">{label}</span>
        {hint && (
          <span className="flex-shrink-0 text-[10px] text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
    </button>
  );
}

/** A palette, shown as the chart it will actually colour. */
export function PaletteTile({
  palette,
  base,
  selected,
  onPick,
}: {
  palette: ComponentStyle["palette"];
  base: ComponentStyle;
  selected: boolean;
  onPick: () => void;
}) {
  const style = styleFrom({ palette, axes: "none", grid: "none" }, base);
  return (
    <GalleryTile
      selected={selected}
      label={palette === "mono" ? "Ink" : cap(palette)}
      onPick={onPick}
    >
      <span className="w-full">
        <Chart
          kind="column"
          series={SPECIMEN}
          style={{ ...style, stackMode: "stacked" }}
          unit="count"
          height={62}
          label={`${palette} palette`}
        />
        {/* The stops themselves, because a stacked chart only shows three of
            six and someone choosing a palette is choosing all of them. */}
        <span aria-hidden className="mt-2 flex gap-1">
          {paletteColors(palette).map((color, i) => (
            <span
              key={i}
              className="h-1.5 flex-1 rounded-full"
              style={{ background: color }}
            />
          ))}
        </span>
      </span>
    </GalleryTile>
  );
}

/** A chart kind, drawn from the same numbers as every other kind. */
export function ChartKindTile({
  kind,
  base,
  selected,
  onPick,
  label,
}: {
  kind: ChartKind;
  base: ComponentStyle;
  selected: boolean;
  onPick: () => void;
  label: string;
}) {
  return (
    <GalleryTile selected={selected} label={label} onPick={onPick}>
      <Chart
        kind={kind}
        series={specimenFor(kind)}
        style={base}
        unit="count"
        height={72}
        label={label}
      />
    </GalleryTile>
  );
}

/**
 * A full preset, drawn as a panel rather than as a chart.
 *
 * Frames, fills and titles are half of what a preset changes, and a bare chart
 * shows none of them — so this renders the whole card, chrome included.
 */
export function PresetTile({
  name,
  description,
  style,
  selected,
  onPick,
}: {
  name: string;
  description: string;
  style: ComponentStyle;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onPick}
      className={cn(
        "flex flex-col overflow-hidden rounded-xl text-left transition-all duration-150",
        selected ? "ring-2 ring-foreground" : "ring-1 ring-border hover:ring-muted-foreground/40",
      )}
    >
      <span className="block bg-page p-3">
        <PanelPreview style={style} />
      </span>
      <span className="block border-t border-border bg-card px-3 py-2">
        <span className="block text-xs font-medium">{name}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}

/**
 * A panel drawn exactly as the style says — frame, fill, title and all.
 *
 * This is the one place the frame axes become visible, so it is deliberately a
 * miniature of a real panel rather than a swatch. It is also what the builder
 * uses for its preview, which is the point: the preview is the panel.
 */
export function PanelPreview({
  style,
  title = "Throughput",
  kind = "column",
  compact = false,
}: {
  style: ComponentStyle;
  title?: string;
  kind?: ChartKind;
  compact?: boolean;
}) {
  return (
    <span
      className={cn("block", frameClass(style), fillClass(style))}
      style={{
        borderRadius: cornerCss(style),
        padding: compact ? "0.6rem" : padCss(style),
      }}
    >
      {style.titleStyle !== "hidden" && (
        <span
          className={cn(
            "block",
            style.titleAlign === "center" && "text-center",
            style.titleStyle === "micro" &&
              "text-[10px] font-medium uppercase tracking-wider text-muted-foreground",
            style.titleStyle === "plain" && "text-xs",
            style.titleStyle === "large" && "text-sm font-medium",
            style.fill === "inverted" && "text-background",
          )}
        >
          {title}
        </span>
      )}
      <span className="mt-2 block">
        <Chart
          kind={kind}
          series={specimenFor(kind)}
          style={style}
          unit="count"
          height={compact ? 56 : 80}
          label={title}
        />
      </span>
    </span>
  );
}

// ── Style → classes ─────────────────────────────────────────────────────
//
// Kept here rather than in the pure module because they are Tailwind classes,
// which are a fact about this app's stylesheet rather than about the model.

export function frameClass(style: ComponentStyle): string {
  switch (style.frame) {
    case "bento":
      return "bento";
    case "flat":
      return "border border-border";
    case "outlined":
      return "border-2 border-foreground";
    case "glass":
      return "border border-white/15 bg-white/10 backdrop-blur-md";
    case "solid":
      return "shadow-lg";
    case "none":
      return "";
  }
}

export function fillClass(style: ComponentStyle): string {
  // Glass brings its own fill; anything on top of it defeats the point.
  if (style.frame === "glass") return "";
  switch (style.fill) {
    case "surface":
      return "bg-card";
    case "muted":
      return "bg-muted";
    case "accent":
      return "bg-brand-100";
    case "gradient":
      return "bg-gradient-to-br from-card to-muted";
    case "inverted":
      // Not `bg-foreground text-background`. That paints the surface and the
      // inherited ink and stops, so everything inside the card — the quiet
      // register, hairlines, wells, chart furniture — went on being computed
      // for the surrounding theme against a surface that is now its opposite.
      // `.ui-inverted` (globals.css) is the same two colours plus the rest of
      // the token set, so the next thing added inside the card is right by
      // default rather than by being remembered.
      return "ui-inverted";
  }
}

export function cornerCss(style: ComponentStyle): string {
  switch (style.corner) {
    case "inherit":
      return "var(--ui-radius-card)";
    case "square":
      return "0";
    case "soft":
      return "0.5rem";
    case "round":
      return "1.5rem";
  }
}

export function padCss(style: ComponentStyle): string {
  return style.padding === "tight"
    ? "0.75rem"
    : style.padding === "roomy"
      ? "1.75rem"
      : "1.25rem";
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
