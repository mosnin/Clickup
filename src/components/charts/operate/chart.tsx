"use client";

import { useMemo } from "react";
import { curveLinear, curveMonotoneX, curveStep } from "@visx/curve";

import { AreaChart } from "../area-chart";
import { Area } from "../area";
import { BarChart } from "../bar-chart";
import { Bar } from "../bar";
import { BarXAxis } from "../bar-x-axis";
import { BarYAxis } from "../bar-y-axis";
import { FunnelChart, type FunnelStage } from "../funnel-chart";
import { Gauge } from "../gauge";
import { Grid } from "../grid";
import { HeatmapChart, HeatmapCells, type HeatmapColumn } from "../heatmap";
import { Legend, LegendItem, LegendLabel, LegendMarker } from "../legend";
import { Line } from "../line";
import { LineChart } from "../line-chart";
import { RadarArea } from "../radar-area";
import { RadarAxis } from "../radar-axis";
import { RadarChart } from "../radar-chart";
import { RadarGrid } from "../radar-grid";
import { RadarLabels } from "../radar-labels";
import { RingChart } from "../ring-chart";
import { Ring } from "../ring";
import { Scatter } from "../scatter";
import { ScatterChart } from "../scatter-chart";
import { XAxis } from "../x-axis";
import { YAxis } from "../y-axis";

import {
  paletteColors,
  seriesColor,
  type ComponentStyle,
} from "@/lib/component-style";
import { cn } from "@/lib/utils";
import { SvgChart, type ChartSeries } from "./svg-charts";

// The one chart.
//
// A panel is a definition — a question, a shape and a look — and this is the
// single component that turns any of them into a picture. That has not
// changed. What changed is what does the drawing: the shapes are now the
// @bklit chart library (vendored beside this file), and the hand-rolled SVG
// that used to draw all of them survives only for the four it has no
// equivalent for.
//
// **The x axis follows the dimension, not the shape.** The library is
// time-series-first: its `XAxis` formats instants, because that is what it is
// for. Our envelope groups by whatever the panel asked for, and half of those
// are categories — status, assignee, priority. Handing a status breakdown to a
// date axis produces a chart that prints yesterday's date under "In progress",
// which is not a cosmetic problem; it is a chart that lies. So a categorical
// dimension gets evenly spaced synthetic instants for geometry and our own
// label strip underneath, and the library's date axis is simply not rendered.
// `xKindOf` decides which case a series is, from the resolver's own
// convention: temporal buckets carry an epoch as their key and a blank label,
// precisely because the label is the renderer's job.
//
// **Style axes map to real props or they are dropped.** Curve, markers, grid,
// axes, palette, stacking and bar geometry all have somewhere to land. Two do
// not — `dataLabels` on the library's shapes, and the `pill` bar cap — and
// they are ignored rather than approximated, because a control that produces
// something other than what it says is worse than a control that is absent.
//
// **Nothing here computes.** Data shaping is a handful of pure functions at
// the bottom of the file; everything else is assembly.

export type ChartKind =
  // Cartesian — the library's time-series and band-scale charts.
  | "bar"
  | "column"
  | "line"
  | "area"
  | "scatter"
  | "sparkline"
  // Circular and shaped — one series each.
  | "donut"
  | "pie"
  | "radial"
  | "rings"
  | "funnel"
  | "radar"
  // Grid.
  | "heatmap"
  // Still hand-rolled: the library has no equivalent.
  | "waterfall"
  | "treemap";

export type { ChartSeries };

export type ChartProps = {
  kind: ChartKind;
  series: ChartSeries[];
  style: ComponentStyle;
  unit: string;
  /**
   * How to read the x axis. Omit and it is inferred from the series — see the
   * note above. Callers that know the dimension should say so.
   */
  xKind?: "time" | "category";
  /** Drawn height in px. Width always fills the container. */
  height?: number;
  className?: string;
  /** Announced to screen readers in place of the graphic. */
  label?: string;
};

/** Kinds the vendored library draws. Everything else falls through to SVG. */
const LIBRARY_KINDS = new Set<ChartKind>([
  "bar",
  "column",
  "line",
  "area",
  "scatter",
  "sparkline",
  "radial",
  "rings",
  "funnel",
  "radar",
  "heatmap",
]);

export function Chart({
  kind,
  series,
  style,
  unit,
  xKind,
  height = 132,
  className,
  label,
}: ChartProps) {
  const usable = useMemo(
    () => series.filter((s) => s.points.length > 0),
    [series],
  );

  if (usable.length === 0) return <Nothing className={className} />;

  if (!LIBRARY_KINDS.has(kind)) {
    return (
      <SvgChart
        kind={kind as "donut" | "pie" | "waterfall" | "treemap"}
        series={usable}
        style={style}
        unit={unit}
        height={height}
        className={className}
        label={label}
      />
    );
  }

  return (
    <div
      className={cn("w-full", className)}
      role="img"
      aria-label={label ?? "Chart"}
    >
      <Body
        kind={kind}
        series={usable}
        style={style}
        unit={unit}
        height={height}
        x={xKind ?? xKindOf(usable)}
      />
      {style.legend !== "none" && usable.length > 1 && (
        <SeriesLegend
          series={usable}
          style={style}
          stacked={style.legend === "right"}
        />
      )}
    </div>
  );
}

// ── The bodies ──────────────────────────────────────────────────────────

type BodyProps = {
  kind: ChartKind;
  series: ChartSeries[];
  style: ComponentStyle;
  unit: string;
  height: number;
  x: "time" | "category";
};

function Body(props: BodyProps) {
  switch (props.kind) {
    case "bar":
    case "column":
      return <Bars {...props} horizontal={props.kind === "bar"} />;
    case "line":
    case "sparkline":
      return <Lines {...props} bare={props.kind === "sparkline"} />;
    case "area":
      return <Areas {...props} />;
    case "scatter":
      return <Dots {...props} />;
    case "radial":
      return <Dial {...props} />;
    case "rings":
      return <Rings {...props} />;
    case "funnel":
      return <Funnel {...props} />;
    case "radar":
      return <Radar {...props} />;
    case "heatmap":
      return <Heat {...props} />;
    default:
      return null;
  }
}

/**
 * Bars and columns.
 *
 * The only cartesian chart in the library on a band scale, which is why it is
 * also the only one that needs no synthetic instants: its `xDataKey` names a
 * category outright.
 */
function Bars({
  series,
  style,
  height,
  x,
  horizontal,
}: BodyProps & { horizontal: boolean }) {
  const rows = useMemo(() => bandRows(series, x), [series, x]);
  const stacked =
    style.stackMode === "stacked" || style.stackMode === "percent";

  return (
    <Box height={height}>
      <BarChart
        aspectRatio="auto"
        barGap={BAR_GAP[style.barWidth]}
        className="h-full w-full"
        data={rows}
        margin={marginFor(style, horizontal)}
        orientation={horizontal ? "horizontal" : "vertical"}
        stacked={stacked}
        xDataKey="label"
      >
        {style.grid !== "none" && <Grid horizontal vertical={false} />}
        {series.map((s, i) => (
          <Bar
            dataKey={seriesField(i)}
            fill={seriesColor(style.palette, i)}
            key={s.key}
            lineCap={BAR_CAP[style.barShape]}
          />
        ))}
        {/* The library's bar chart has exactly one axis and it is the
            categories — `BarXAxis` and `BarYAxis` are the same labels on
            whichever edge the orientation puts them, not an x and a y. So
            "axes: both" cannot mean two here; asking for either draws the one
            that exists, on the correct edge. */}
        {style.axes !== "none" &&
          (horizontal ? (
            <BarYAxis maxLabels={BAND_LABELS} />
          ) : (
            <BarXAxis maxLabels={BAND_LABELS} />
          ))}
      </BarChart>
    </Box>
  );
}

function Lines({
  series,
  style,
  height,
  x,
  bare,
}: BodyProps & { bare: boolean }) {
  const rows = useMemo(() => instantRows(series, x), [series, x]);

  return (
    <>
      <Box height={height}>
        <LineChart
          aspectRatio="auto"
          className="h-full w-full"
          data={rows}
          margin={marginFor(style, false, bare)}
        >
          {!bare && style.grid !== "none" && (
            <Grid
              horizontal={style.grid === "horizontal" || style.grid === "both"}
              vertical={style.grid === "vertical" || style.grid === "both"}
            />
          )}
          {series.map((s, i) => (
            <Line
              curve={CURVE[style.curve]}
              dataKey={seriesField(i)}
              key={s.key}
              markers={{ fill: seriesColor(style.palette, i) }}
              showMarkers={style.markers !== "none"}
              stroke={seriesColor(style.palette, i)}
              strokeWidth={bare ? 1.75 : 2.5}
            />
          ))}
          {!bare &&
            x === "time" &&
            (style.axes === "x" || style.axes === "both") && <XAxis />}
          {!bare && (style.axes === "y" || style.axes === "both") && <YAxis />}
        </LineChart>
      </Box>
      {!bare && <CategoryStrip axes={style.axes} series={series} x={x} />}
    </>
  );
}

function Areas({ series, style, height, x }: BodyProps) {
  const rows = useMemo(() => instantRows(series, x), [series, x]);
  const outline = style.chartFill === "outline";

  return (
    <>
      <Box height={height}>
        <AreaChart
          aspectRatio="auto"
          className="h-full w-full"
          data={rows}
          margin={marginFor(style, false)}
        >
          {style.grid !== "none" && (
            <Grid
              horizontal={style.grid === "horizontal" || style.grid === "both"}
              vertical={style.grid === "vertical" || style.grid === "both"}
            />
          )}
          {series.map((s, i) => (
            <Area
              curve={CURVE[style.curve]}
              dataKey={seriesField(i)}
              fill={seriesColor(style.palette, i)}
              fillOpacity={outline ? 0 : FILL_OPACITY[style.chartFill]}
              key={s.key}
              markers={{ fill: seriesColor(style.palette, i) }}
              showMarkers={style.markers !== "none"}
              stroke={seriesColor(style.palette, i)}
            />
          ))}
          {x === "time" && (style.axes === "x" || style.axes === "both") && (
            <XAxis />
          )}
          {(style.axes === "y" || style.axes === "both") && <YAxis />}
        </AreaChart>
      </Box>
      <CategoryStrip axes={style.axes} series={series} x={x} />
    </>
  );
}

function Dots({ series, style, height, x }: BodyProps) {
  const rows = useMemo(() => instantRows(series, x), [series, x]);

  return (
    <>
      <Box height={height}>
        <ScatterChart
          aspectRatio="auto"
          className="h-full w-full"
          data={rows}
          margin={marginFor(style, false)}
        >
          {style.grid !== "none" && (
            <Grid
              horizontal={style.grid === "horizontal" || style.grid === "both"}
              vertical={style.grid === "vertical" || style.grid === "both"}
            />
          )}
          {series.map((s, i) => (
            <Scatter
              dataKey={seriesField(i)}
              fill={seriesColor(style.palette, i)}
              key={s.key}
              radius={style.markers === "ring" ? 6 : 4.5}
            />
          ))}
          {x === "time" && (style.axes === "x" || style.axes === "both") && (
            <XAxis />
          )}
          {(style.axes === "y" || style.axes === "both") && <YAxis />}
        </ScatterChart>
      </Box>
      <CategoryStrip axes={style.axes} series={series} x={x} />
    </>
  );
}

/**
 * A dial: one number against its own maximum.
 *
 * The first series' points are summed against their own largest, because "how
 * far through are we" is the only question a single arc can answer honestly.
 */
function Dial({ series, style, height, unit }: BodyProps) {
  const points = series[0]?.points ?? [];
  const total = points.reduce((sum, p) => sum + p.value, 0);
  const ceiling =
    Math.max(...points.map((p) => p.value), 1) * points.length || 1;
  const pct = clampPercent((total / ceiling) * 100);

  return (
    <Gauge
      activeFill={seriesColor(style.palette, 0)}
      centerValue={unit === "percent" ? Math.round(pct) : total}
      className="mx-auto"
      height={height}
      suffix={unit === "percent" ? "%" : ""}
      value={pct}
    />
  );
}

/** Concentric progress rings — one per point, each against the largest. */
function Rings({ series, style, height }: BodyProps) {
  const points = series[0]?.points ?? [];
  const max = Math.max(...points.map((p) => p.value), 1);
  const data = points.slice(0, 6).map((p, i) => ({
    label: p.label || p.key,
    value: p.value,
    maxValue: max,
    color: p.color ?? seriesColor(style.palette, i),
  }));

  return (
    <div className="flex items-center justify-center" style={{ height }}>
      <RingChart data={data} size={height}>
        {data.map((d, i) => (
          <Ring index={i} key={d.label} />
        ))}
      </RingChart>
    </div>
  );
}

/** Stages, largest first — the shape only reads as a funnel if it narrows. */
function Funnel({ series, style, height }: BodyProps) {
  const stages: FunnelStage[] = useMemo(() => {
    const points = series[0]?.points ?? [];
    return [...points]
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
      .map((p, i) => ({
        label: p.label || p.key,
        value: p.value,
        color: p.color ?? seriesColor(style.palette, i),
      }));
  }, [series, style.palette]);

  // A funnel is proportions, so a set of zeroes divides by its own total and
  // the library emits `NaN` into the path — which renders as nothing at all
  // rather than as an error. Saying there is no shape yet is the true answer;
  // flooring the values would draw a funnel out of nothing.
  if ((stages[0]?.value ?? 0) <= 0) return <Nothing />;

  return (
    <FunnelChart
      data={stages}
      edges="straight"
      layers={1}
      showLabels={style.dataLabels !== "none" || stages.length <= 5}
      showPercentage={style.dataLabels === "percent"}
      showValues={style.dataLabels === "value"}
      style={{ height }}
    />
  );
}

/**
 * A radar over the points as axes, one polygon per series.
 *
 * The library wants 0–100, so values are normalised per axis rather than
 * globally: an axis whose biggest value is 3 would otherwise be a dot at the
 * centre next to one whose biggest is 300.
 */
function Radar({ series, style, height }: BodyProps) {
  const { metrics, data } = useMemo(
    () => radarShape(series, style),
    [series, style],
  );
  if (metrics.length < 3) {
    return (
      <Bars
        height={height}
        horizontal={false}
        kind="column"
        series={series}
        style={style}
        unit=""
        x="category"
      />
    );
  }
  return (
    <div className="flex items-center justify-center" style={{ height }}>
      <RadarChart data={data} margin={26} metrics={metrics} size={height}>
        <RadarGrid showLabels={false} />
        <RadarAxis />
        <RadarLabels />
        {data.map((d, i) => (
          <RadarArea
            index={i}
            key={d.label}
            showPoints={style.markers !== "none"}
          />
        ))}
      </RadarChart>
    </div>
  );
}

/**
 * Points across, series down — the two dimensions the envelope already has.
 *
 * That way round because the columns are the axis that grows: a fortnight of
 * days is fourteen columns and two series, which reads as a calendar. The
 * other way round is two columns and fourteen rows, which reads as a bookmark.
 */
function Heat({ series, style, height }: BodyProps) {
  const columns = useMemo(() => heatColumns(series), [series]);
  const levels = useMemo(() => heatLevels(style), [style]);
  return (
    <Box height={height}>
      <HeatmapChart
        className="h-full w-full"
        data={columns}
        layout="fill"
        levelColors={levels}
      >
        <HeatmapCells />
      </HeatmapChart>
    </Box>
  );
}

// ── Furniture ───────────────────────────────────────────────────────────

/** The one thing a chart says when it has nothing to say. */
function Nothing({ className }: { className?: string }) {
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      Nothing to chart yet.
    </p>
  );
}

/**
 * The category labels, when the x axis is not time.
 *
 * Evenly spaced because the geometry above is: the synthetic instants are one
 * day apart, so a flex row with the same margins lands each label under its
 * point. Stride keeps it readable rather than clipping — six labels is the
 * most a panel-sized chart can carry.
 */
function CategoryStrip({
  series,
  x,
  axes,
}: {
  series: ChartSeries[];
  x: "time" | "category";
  axes: ComponentStyle["axes"];
}) {
  // One place decides this for every cartesian shape. Three copies of the
  // condition is three chances for one of them to keep printing dates under a
  // status breakdown after the other two are fixed.
  if (x !== "category" || axes === "none" || axes === "y") return null;
  const points = series[0]?.points ?? [];
  const stride = Math.max(1, Math.ceil(points.length / 6));
  return (
    <div className="mt-1 flex justify-between px-1 text-[10px] text-muted-foreground">
      {points.map((p, i) => (
        <span className="min-w-0 truncate" key={p.key}>
          {i % stride === 0 ? p.label || p.key : ""}
        </span>
      ))}
    </div>
  );
}

function SeriesLegend({
  series,
  style,
  stacked,
}: {
  series: ChartSeries[];
  style: ComponentStyle;
  stacked: boolean;
}) {
  const items = series.map((s, i) => ({
    label: s.label,
    value: s.points.reduce((sum, p) => sum + p.value, 0),
    color: seriesColor(style.palette, i),
  }));

  return (
    <Legend
      className={cn("mt-1 flex gap-1", stacked ? "flex-col" : "flex-wrap")}
      items={items}
    >
      <LegendItem className="flex items-center gap-1.5 px-1.5 py-0.5">
        <LegendMarker className="h-2 w-2" />
        <LegendLabel className="text-[10px] text-muted-foreground" />
      </LegendItem>
    </Legend>
  );
}

// ── Style → props ───────────────────────────────────────────────────────

const CURVE = {
  linear: curveLinear,
  smooth: curveMonotoneX,
  step: curveStep,
} as const;

/**
 * How many band labels to print.
 *
 * The library thins by count, not by width, and a panel is narrow — fourteen
 * dates in three hundred pixels is a smear rather than an axis. Seven is the
 * most that stays legible at the smallest size a panel is allowed to be.
 */
const BAND_LABELS = 7;

/** Band padding: a thicker bar is a smaller gap. */
const BAR_GAP = { thin: 0.55, normal: 0.35, thick: 0.15 } as const;

/**
 * Bar ends. `pill` has nowhere to land — the library caps a bar, it does not
 * capsule it — so it draws as rounded rather than as something else.
 */
const BAR_CAP = { square: "butt", rounded: 6, pill: "round" } as const;

const FILL_OPACITY = {
  solid: 0.45,
  gradient: 0.55,
  soft: 0.22,
  outline: 0,
} as const;

/** Room for the axes the style asked for, and no more. */
function marginFor(style: ComponentStyle, horizontal: boolean, bare = false) {
  if (bare) return { top: 4, right: 2, bottom: 4, left: 2 };
  const wantsY = style.axes === "y" || style.axes === "both";
  const wantsX = style.axes === "x" || style.axes === "both";
  return {
    top: 10,
    right: 8,
    bottom: wantsX ? 22 : 8,
    left: wantsY || horizontal ? 34 : 8,
  };
}

/**
 * A fixed-height box for a chart that otherwise fills its parent.
 *
 * The library sizes itself from its container, and a panel says how tall it
 * wants to be in pixels. Tailwind cannot see a computed arbitrary value, so
 * the height is an inline style on a wrapper and the chart is told to fill it.
 */
function Box({
  height,
  children,
}: {
  height: number;
  children: React.ReactNode;
}) {
  return (
    <div className="w-full" style={{ height }}>
      {children}
    </div>
  );
}

// ── Data shaping ────────────────────────────────────────────────────────

/** Series `i` becomes this column in the row objects. */
function seriesField(i: number): string {
  return `s${i}`;
}

/**
 * Is this series grouped by time or by category?
 *
 * Read from the resolver's own convention rather than guessed: a temporal
 * bucket carries the epoch as its key and deliberately leaves the label blank,
 * because formatting an instant is the renderer's job. Anything else is a
 * category — including a numeric-looking one, which is why the label is part
 * of the test rather than the key alone.
 */
export function xKindOf(series: ChartSeries[]): "time" | "category" {
  const points = series[0]?.points ?? [];
  if (points.length === 0) return "category";
  return points.every(
    (p) =>
      p.label === "" &&
      /^\d{10,}$/.test(p.key) &&
      Number.isFinite(Number(p.key)),
  )
    ? "time"
    : "category";
}

const DAY = 86_400_000;
/** A stable anchor for synthetic instants. Never displayed — see `xKindOf`. */
const ANCHOR = Date.UTC(2000, 0, 1);

/** Rows for the time-scaled charts: one row per point, series as columns. */
function instantRows(
  series: ChartSeries[],
  x: "time" | "category",
): Record<string, unknown>[] {
  const length = Math.max(...series.map((s) => s.points.length));
  return Array.from({ length }, (_, i) => {
    const row: Record<string, unknown> = {
      date:
        x === "time"
          ? new Date(Number(series[0]?.points[i]?.key ?? ANCHOR + i * DAY))
          : new Date(ANCHOR + i * DAY),
    };
    series.forEach((s, sIndex) => {
      row[seriesField(sIndex)] = s.points[i]?.value ?? 0;
    });
    return row;
  });
}

const SHORT_DATE = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

/**
 * The name of one band.
 *
 * A temporal bucket has no label — the resolver leaves it blank because
 * formatting an instant is the renderer's job, and the time-scaled charts have
 * their own axis to do it. The band scale does not, so falling through to the
 * key would print `1748736000000` under a column.
 */
function bandLabel(
  point: { key: string; label: string },
  x: "time" | "category",
): string {
  if (point.label) return point.label;
  if (x === "time") return SHORT_DATE.format(new Date(Number(point.key)));
  return point.key;
}

/** Rows for the band-scaled bar chart: the category is a column of its own. */
function bandRows(
  series: ChartSeries[],
  x: "time" | "category",
): Record<string, unknown>[] {
  const first = series[0]?.points ?? [];
  return first.map((p, i) => {
    const row: Record<string, unknown> = {
      label: bandLabel(p, x),
      date: new Date(ANCHOR + i * DAY),
    };
    series.forEach((s, sIndex) => {
      row[seriesField(sIndex)] = s.points[i]?.value ?? 0;
    });
    return row;
  });
}

/** Points become axes, series become polygons, values normalise per axis. */
function radarShape(series: ChartSeries[], style: ComponentStyle) {
  const points = series[0]?.points.slice(0, 8) ?? [];
  const metrics = points.map((p, i) => ({
    key: `m${i}`,
    label: p.label || p.key,
  }));
  const ceilings = points.map((_, i) =>
    Math.max(...series.map((s) => s.points[i]?.value ?? 0), 1),
  );
  const data = series.slice(0, 5).map((s, si) => ({
    label: s.label,
    color: seriesColor(style.palette, si),
    values: Object.fromEntries(
      metrics.map((m, i) => [
        m.key,
        clampPercent(((s.points[i]?.value ?? 0) / ceilings[i]) * 100),
      ]),
    ),
  }));
  return { metrics, data };
}

/** One column per point, one bin per series. */
function heatColumns(series: ChartSeries[]): HeatmapColumn[] {
  const length = Math.max(...series.map((s) => s.points.length));
  return Array.from({ length }, (_, pi) => ({
    bin: pi,
    bins: series.map((s, si) => ({
      bin: si,
      count: s.points[pi]?.value ?? 0,
      date: new Date(ANCHOR + pi * DAY),
    })),
  }));
}

/**
 * The five heat levels, from the app's own palette.
 *
 * The library ships GitHub's greens, which is a saturated fill in a design
 * system that has one rule about saturated fills. Lightest to darkest, taken
 * from the palette's own stops so `mono` stays ink and a chosen palette is
 * actually chosen.
 */
function heatLevels(style: ComponentStyle) {
  const c = paletteColors(style.palette);
  return [c[5], c[4], c[3], c[1], c[0]] as [
    string,
    string,
    string,
    string,
    string,
  ];
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}
