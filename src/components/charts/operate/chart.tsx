"use client";

import { useMemo } from "react";
import useMeasure from "react-use-measure";
import { curveLinear, curveMonotoneX, curveStep } from "@visx/curve";

import { AreaChart } from "../area-chart";
import { Area } from "../area";
import { BarChart } from "../bar-chart";
import { Bar } from "../bar";
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
  const labels = useMemo(() => rows.map((r) => String(r.label)), [rows]);
  const stacked =
    style.stackMode === "stacked" || style.stackMode === "percent";
  const axis = style.axes !== "none";

  const plot = (
    <BarChart
      aspectRatio="auto"
      barGap={BAR_GAP[style.barWidth]}
      className="h-full w-full"
      data={rows}
      margin={{ top: 6, right: 4, bottom: 4, left: 4 }}
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
    </BarChart>
  );

  // Horizontal: the names go beside the bars, in a column that is as wide as
  // it needs to be and no wider than a third of the panel.
  if (horizontal) {
    return (
      <div className="flex w-full items-stretch" style={{ height }}>
        {axis && <BandColumn labels={labels} />}
        <div className="min-w-0 flex-1">{plot}</div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col" style={{ height }}>
      <div className="min-h-0 flex-1">{plot}</div>
      {axis && <BandStrip labels={labels} />}
    </div>
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
              // Off. It fades the stroke toward transparent at the edges, and
              // at a panel's width that means most of the line is invisible —
              // a chart that hides its own data to look nice.
              fadeEdges={false}
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
      {!bare && <BandStrip labels={bandLabels(series, x, style.axes)} />}
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
      <BandStrip labels={bandLabels(series, x, style.axes)} />
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
      <BandStrip labels={bandLabels(series, x, style.axes)} />
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
    // Forty hairline notches over a 270° sweep is a car speedometer, which is
    // what this looked like. Fewer, wider, rounded notches over a shallower
    // arc reads as one considered object rather than an instrument cluster —
    // and the notches are what the library IS, so this is a tuning of its
    // own vocabulary rather than a second gauge drawn beside it.
    <Gauge
      activeFill={seriesColor(style.palette, 0)}
      centerValue={unit === "percent" ? Math.round(pct) : total}
      className="mx-auto"
      endAngle={390}
      height={height}
      notchCornerRadius={3}
      spacing={38}
      startAngle={150}
      suffix={unit === "percent" ? "%" : ""}
      totalNotches={26}
      uniformWidth
      value={pct}
    />
  );
}

/** Concentric progress rings — one per point, each against the largest. */
function Rings({ series, style, height }: BodyProps) {
  const points = series[0]?.points ?? [];
  const max = Math.max(...points.map((p) => p.value), 1);
  // Four, not six. Six concentric hairlines is a spirograph — the rings stop
  // reading as separate quantities and start reading as texture, which is the
  // opposite of what a chart is for. Fewer and thicker is legible at panel
  // size; past four, this shape is the wrong shape for the data.
  const data = points.slice(0, 4).map((p, i) => ({
    label: p.label || p.key,
    value: p.value,
    maxValue: max,
    color: p.color ?? seriesColor(style.palette, i),
  }));

  return (
    <div className="flex items-center justify-center" style={{ height }}>
      <RingChart data={data} ringGap={7} size={height} strokeWidth={13}>
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
    // Always labelled, and always carrying its numbers. A funnel is a
    // comparison between named stages; unlabelled it is a grey wedge, which
    // is exactly what shipped — six stages, no names, no values, nothing on
    // screen to say what narrowed or by how much. The `dataLabels` style
    // still chooses between the count and the share, but "neither" is not a
    // legible funnel and is not offered.
    <FunnelChart
      data={stages}
      edges="straight"
      layers={1}
      showLabels
      showPercentage={style.dataLabels === "percent"}
      showValues={style.dataLabels !== "percent"}
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
 * The band labels for a cartesian chart.
 *
 * The vendored axes could not do this job. `BarXAxis` thins by label *count*
 * rather than by available width, so six statuses in a one-column panel come
 * out as one smear; `BarYAxis` hardcodes a 70px cap, so anybody called
 * Katherine is "Katherine…" on a 1100px screen. Both are absolutely
 * positioned inside the plot box, so the labels sit on top of the bars.
 *
 * This is the whole fix, and it is three rules:
 *
 * **A label may never overlap its neighbour**, because two words pretending to
 * be one is worse than one word. An ellipsis is an honest "there is more
 * here"; a smear is a lie.
 *
 * **Labels thin by measured width, not by count.** Below the width a short
 * word needs, every other band is labelled.
 *
 * **A thinned label inherits the room the skipped bands freed.** This is the
 * rule the first version was missing, and it is why a fortnight of days came
 * out as `J… J… J…`: it correctly dropped three labels in four, then left the
 * survivor in its own 16px cell, so what it had made room for it refused to
 * use. Each drawn label now sits over its own band and may spread across the
 * silent ones on either side — which is exactly the space nothing else is
 * allowed to occupy.
 *
 * **It lives outside the plot.** The chart is given the remaining height, so
 * the row is space the bars were never drawn into.
 */

/** Below this, a label cannot say anything, so fewer of them say more. */
const MIN_BAND_LABEL_PX = 54;

function BandStrip({ labels }: { labels: string[] }) {
  const [ref, { width }] = useMeasure();
  if (labels.length === 0) return null;

  // Before the first measurement, show them all: a strip that starts thinned
  // and fills in reads as a glitch, and one frame of slightly tight labels
  // does not.
  const per = width > 0 ? width / labels.length : Infinity;
  const stride = per >= MIN_BAND_LABEL_PX ? 1 : Math.ceil(MIN_BAND_LABEL_PX / per);
  const room = Number.isFinite(per) ? per * stride : undefined;

  return (
    <div className="relative mt-1 h-4 w-full shrink-0" ref={ref}>
      {labels.map((label, i) => {
        if (i % stride !== 0) return null;
        const centre = ((i + 0.5) / labels.length) * 100;
        // The first and last drawn labels align to the strip's edges instead
        // of centring on their band: half of "Jun 1" hanging off the left of
        // the panel is the same clipping bug in a different place.
        const first = i === 0;
        const last = i + stride >= labels.length;
        return (
          <span
            className="absolute top-0 truncate text-[10px] leading-4 text-muted-foreground"
            key={`${label}-${i}`}
            style={{
              left: first ? 0 : last ? undefined : `${centre}%`,
              right: last && !first ? 0 : undefined,
              transform: first || last ? undefined : "translateX(-50%)",
              maxWidth: room,
            }}
            title={label}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}

/** The same labels down the side, for a horizontal bar chart. */
function BandColumn({ labels }: { labels: string[] }) {
  return (
    <div className="flex max-w-[38%] shrink-0 flex-col justify-around py-1 pr-2">
      {labels.map((label, i) => (
        <span
          className="truncate text-right text-[10px] leading-4 text-muted-foreground"
          key={`${label}-${i}`}
          title={label}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

/**
 * What to write under each band, or nothing when the axis is off or the x is
 * time — a time-scaled chart has the library's own date axis and a second row
 * of labels under it is two answers to one question.
 */
function bandLabels(
  series: ChartSeries[],
  x: "time" | "category",
  axes: ComponentStyle["axes"],
): string[] {
  if (x !== "category" || axes === "none" || axes === "y") return [];
  return (series[0]?.points ?? []).map((p) => p.label || p.key);
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
/**
 * Columns of cells, with every value rescaled into the library's five levels.
 *
 * The rescale is not decoration. `getHeatmapContributionLevel` is GitHub's
 * scale hard-coded — 0, 1, 2, 3, 4-or-more — so any measure that isn't a
 * commit count saturates instantly: eleven open tasks and ninety are both
 * "4", and the chart draws one flat rectangle of the darkest ink. It looked
 * like a styling bug and was actually a chart with no scale at all.
 *
 * Levelled against the data's own maximum, so the darkest cell is the busiest
 * one *here* rather than the busiest one at GitHub. Zero keeps level 0 — an
 * empty day should read as empty, not as "the quietest of the busy ones".
 */
function heatColumns(series: ChartSeries[]): HeatmapColumn[] {
  const length = Math.max(...series.map((s) => s.points.length));
  const max = Math.max(
    0,
    ...series.flatMap((s) => s.points.map((p) => p.value)),
  );
  const level = (value: number) => {
    if (!(value > 0) || max <= 0) return 0;
    return Math.max(1, Math.ceil((value / max) * 4));
  };
  return Array.from({ length }, (_, pi) => ({
    bin: pi,
    bins: series.map((s, si) => ({
      bin: si,
      count: level(s.points[pi]?.value ?? 0),
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
