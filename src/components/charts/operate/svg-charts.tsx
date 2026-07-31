"use client";

import { useId } from "react";
import {
  arcPath,
  arcsFor,
  areaPath,
  bandScale,
  compactNumber,
  formatValue,
  labelStride,
  linePath,
  linearScale,
  niceAxis,
  polar,
  roundedRectPath,
  smoothPath,
  squarify,
  stack,
  stepPath,
  toPercent,
  type Point,
} from "@/lib/chart-math";
import {
  barPadding,
  barRadius,
  isStacked,
  seriesColor,
  type ComponentStyle,
} from "@/lib/component-style";
import { cn } from "@/lib/utils";

// The charts.
//
// Hand-rolled SVG over the pure geometry in `lib/chart-math`. Nothing in here
// computes anything: it turns numbers into elements, which is why the file is
// long and shallow rather than short and clever. Every decision about *shape*
// lives in chart-math and every decision about *look* lives in the style
// object, so this is the thin layer that puts one inside the other.
//
// One `<Chart>` entry point, dispatching on `kind`. A component definition
// names a kind and the renderer draws it; there is no per-chart wrapper
// component to keep in agreement with anything.
//
// Charts are drawn in a viewBox with `preserveAspectRatio="none"` deliberately
// avoided: text inside a stretched SVG is unreadable, so the geometry is
// computed against a fixed logical box and the SVG scales as a whole.

export type SvgChartKind =
  | "bar"
  | "column"
  | "line"
  | "area"
  | "donut"
  | "pie"
  | "radial"
  | "scatter"
  | "waterfall"
  | "treemap"
  | "sparkline";

export type ChartSeries = {
  key: string;
  label: string;
  points: { key: string; label: string; value: number; color?: string }[];
};

export type SvgChartProps = {
  kind: SvgChartKind;
  series: ChartSeries[];
  style: ComponentStyle;
  unit: string;
  /** Logical size. The SVG scales; the geometry does not re-derive. */
  width?: number;
  height?: number;
  className?: string;
  /** Announced to screen readers in place of the graphic. */
  label?: string;
};

const AXIS_TEXT = 10;

/** Room for the axes the style asked for, and no more. */
function paddingFor(style: ComponentStyle, kind: SvgChartKind) {
  const wantsY = style.axes === "y" || style.axes === "both";
  const wantsX = style.axes === "x" || style.axes === "both";
  const circular = kind === "donut" || kind === "pie" || kind === "radial";
  if (circular || kind === "treemap" || kind === "sparkline") {
    return { top: 2, right: 2, bottom: 2, left: 2 };
  }
  return {
    top: style.dataLabels === "none" ? 8 : 16,
    right: 6,
    bottom: wantsX ? 18 : 6,
    left: wantsY ? 30 : 6,
  };
}

export function SvgChart({
  kind,
  series,
  style,
  unit,
  width = 320,
  height = 160,
  className,
  label,
}: SvgChartProps) {
  const usable = series.filter((s) => s.points.length > 0);
  if (usable.length === 0) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>
        Nothing to chart yet.
      </p>
    );
  }

  const shared = { series: usable, style, unit, width, height };

  return (
    <div className={cn("w-full", className)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={label ?? "Chart"}
        className="overflow-visible"
      >
        {kind === "donut" || kind === "pie" ? (
          <Arcs {...shared} hole={kind === "pie" ? 0 : style.donutHole} />
        ) : kind === "radial" ? (
          <Radial {...shared} />
        ) : kind === "treemap" ? (
          <Treemap {...shared} />
        ) : kind === "scatter" ? (
          <Scatter {...shared} />
        ) : kind === "waterfall" ? (
          <Waterfall {...shared} />
        ) : kind === "line" || kind === "area" || kind === "sparkline" ? (
          <Lines {...shared} kind={kind} />
        ) : (
          <Bars {...shared} horizontal={kind === "bar"} />
        )}
      </svg>
      {style.legend !== "none" && usable.length > 1 && (
        <Legend series={usable} style={style} />
      )}
    </div>
  );
}

// ── Shared furniture ────────────────────────────────────────────────────

function Legend({
  series,
  style,
}: {
  series: ChartSeries[];
  style: ComponentStyle;
}) {
  return (
    <ul
      className={cn(
        "mt-2 flex gap-x-3 gap-y-1 text-[10px] text-muted-foreground",
        style.legend === "right" ? "flex-col" : "flex-wrap",
      )}
    >
      {series.map((s, i) => (
        <li key={s.key} className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className="h-2 w-2 flex-shrink-0 rounded-full"
            style={{ background: seriesColor(style.palette, i) }}
          />
          <span className="truncate">{s.label}</span>
        </li>
      ))}
    </ul>
  );
}

function Gridlines({
  ticks,
  scale,
  x0,
  x1,
  vertical,
}: {
  ticks: number[];
  scale: (v: number) => number;
  x0: number;
  x1: number;
  vertical?: boolean;
}) {
  return (
    <g aria-hidden>
      {ticks.map((t) => {
        const p = scale(t);
        return (
          <line
            key={t}
            x1={vertical ? p : x0}
            x2={vertical ? p : x1}
            y1={vertical ? x0 : p}
            y2={vertical ? x1 : p}
            stroke="var(--color-border)"
            strokeWidth={1}
          />
        );
      })}
    </g>
  );
}

function AxisLabels({
  ticks,
  scale,
  x,
  unit,
}: {
  ticks: number[];
  scale: (v: number) => number;
  x: number;
  unit: string;
}) {
  return (
    <g aria-hidden>
      {ticks.map((t) => (
        <text
          key={t}
          x={x}
          y={scale(t)}
          dy="0.32em"
          textAnchor="end"
          fontSize={AXIS_TEXT}
          fill="var(--color-muted-foreground)"
        >
          {formatValue(t, unit)}
        </text>
      ))}
    </g>
  );
}

/**
 * A category label under a band.
 *
 * Date buckets arrive with an empty label and a timestamp key — formatting
 * them here rather than on the server keeps them in the reader's locale, and
 * keeps the envelope free of presentation.
 */
function categoryLabel(point: { key: string; label: string }): string {
  if (point.label) return point.label;
  const n = Number(point.key);
  if (!Number.isFinite(n)) return point.key;
  return new Date(n).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// ── Bars and columns ────────────────────────────────────────────────────

function Bars({
  series,
  style,
  unit,
  width,
  height,
  horizontal,
}: {
  series: ChartSeries[];
  style: ComponentStyle;
  unit: string;
  width: number;
  height: number;
  horizontal: boolean;
}) {
  const pad = paddingFor(style, horizontal ? "bar" : "column");
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const categories = series[0].points;
  const stacked = isStacked(style.stackMode) && series.length > 1;
  const grouped = style.stackMode === "grouped" && series.length > 1;

  // Values at each category, per series, honouring the stack mode.
  const columns = categories.map((_, ci) => {
    const raw = series.map((s) => s.points[ci]?.value ?? 0);
    return style.stackMode === "percent" ? toPercent(raw) : raw;
  });

  const maxima = columns.map((values) =>
    stacked
      ? values.reduce((sum, v) => sum + Math.max(0, v), 0)
      : Math.max(0, ...values),
  );
  const axis = niceAxis(0, Math.max(...maxima, 0));

  // The value axis runs across the plot for a horizontal bar chart and up it
  // for a column chart; everything below is written once against `value`.
  const value = horizontal
    ? linearScale(axis.min, axis.max, pad.left, pad.left + plotW)
    : linearScale(axis.min, axis.max, pad.top + plotH, pad.top);
  const band = bandScale(
    categories.length,
    horizontal ? pad.top : pad.left,
    horizontal ? pad.top + plotH : pad.left + plotW,
    barPadding(style.barWidth),
  );

  const slot = grouped ? band.bandwidth / series.length : band.bandwidth;
  const radius = barRadius(style.barShape, slot);
  const showGrid =
    style.grid === "both" ||
    (horizontal ? style.grid === "vertical" : style.grid === "horizontal");

  const stride = labelStride(
    categories.length,
    horizontal ? plotH : plotW,
    horizontal ? 14 : 34,
  );

  return (
    <>
      {showGrid && (
        <Gridlines
          ticks={axis.ticks}
          scale={value}
          x0={horizontal ? pad.top : pad.left}
          x1={horizontal ? pad.top + plotH : pad.left + plotW}
          vertical={horizontal}
        />
      )}
      {(style.axes === "y" || style.axes === "both") && !horizontal && (
        <AxisLabels ticks={axis.ticks} scale={value} x={pad.left - 4} unit={unit} />
      )}

      {categories.map((cat, ci) => {
        const values = columns[ci];
        const segments = stacked ? stack(values) : null;
        return (
          <g key={cat.key}>
            {values.map((v, si) => {
              const from = segments ? segments[si].from : 0;
              const to = segments ? segments[si].to : v;
              const a = value(from);
              const b = value(to);
              const start =
                band.start(ci) + (grouped ? si * slot : 0);
              const color =
                cat.color && series.length === 1
                  ? cat.color
                  : seriesColor(style.palette, si);

              const x = horizontal ? Math.min(a, b) : start;
              const y = horizontal ? start : Math.min(a, b);
              const w = horizontal ? Math.abs(b - a) : slot;
              const h = horizontal ? slot : Math.abs(b - a);
              // Round only the end the bar grows toward, so a stack's
              // segments meet flush instead of pinching at every join.
              const corners = horizontal
                ? { tr: radius, br: radius }
                : { tl: radius, tr: radius };

              return (
                <path
                  key={`${cat.key}-${si}`}
                  d={roundedRectPath(x, y, w, h, segments && si < values.length - 1 ? {} : corners)}
                  fill={style.chartFill === "outline" ? "none" : color}
                  stroke={style.chartFill === "outline" ? color : "none"}
                  strokeWidth={style.chartFill === "outline" ? 1.5 : 0}
                  opacity={style.chartFill === "soft" ? 0.55 : 1}
                />
              );
            })}

            {style.dataLabels !== "none" && !stacked && (
              <text
                x={horizontal ? value(values[0]) + 3 : band.center(ci)}
                y={horizontal ? band.center(ci) : value(values[0]) - 3}
                dy={horizontal ? "0.32em" : undefined}
                textAnchor={horizontal ? "start" : "middle"}
                fontSize={AXIS_TEXT}
                fill="var(--color-muted-foreground)"
              >
                {style.dataLabels === "percent"
                  ? `${Math.round(toPercent(maxima)[ci] ?? 0)}%`
                  : compactNumber(values[0])}
              </text>
            )}

            {(style.axes === "x" || style.axes === "both") &&
              !horizontal &&
              ci % stride === 0 && (
                <text
                  x={band.center(ci)}
                  y={height - 4}
                  textAnchor="middle"
                  fontSize={AXIS_TEXT}
                  fill="var(--color-muted-foreground)"
                >
                  {categoryLabel(cat)}
                </text>
              )}
          </g>
        );
      })}
    </>
  );
}

// ── Lines and areas ─────────────────────────────────────────────────────

function Lines({
  series,
  style,
  unit,
  width,
  height,
  kind,
}: {
  series: ChartSeries[];
  style: ComponentStyle;
  unit: string;
  width: number;
  height: number;
  kind: "line" | "area" | "sparkline";
}) {
  const spark = kind === "sparkline";
  const pad = spark ? { top: 2, right: 2, bottom: 2, left: 2 } : paddingFor(style, kind);
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const categories = series[0].points;

  const all = series.flatMap((s) => s.points.map((p) => p.value));
  const axis = niceAxis(Math.min(0, ...all), Math.max(...all, 0));
  const y = linearScale(axis.min, axis.max, pad.top + plotH, pad.top);
  // Points sit on the plot edges rather than in band centres: a line's first
  // reading belongs at the start of the axis, not a half-step in.
  const x = (i: number) =>
    categories.length <= 1
      ? pad.left + plotW / 2
      : pad.left + (i / (categories.length - 1)) * plotW;

  const draw =
    style.curve === "linear" ? linePath : style.curve === "step" ? stepPath : smoothPath;
  const gradientId = useId();
  const stride = labelStride(categories.length, plotW);

  return (
    <>
      {!spark && (style.grid === "horizontal" || style.grid === "both") && (
        <Gridlines
          ticks={axis.ticks}
          scale={y}
          x0={pad.left}
          x1={pad.left + plotW}
        />
      )}
      {!spark && (style.axes === "y" || style.axes === "both") && (
        <AxisLabels ticks={axis.ticks} scale={y} x={pad.left - 4} unit={unit} />
      )}

      {series.map((s, si) => {
        const color = seriesColor(style.palette, si);
        const points: Point[] = s.points.map((p, i) => ({ x: x(i), y: y(p.value) }));
        const d = draw(points);
        const filled = kind === "area" || (spark && style.chartFill !== "outline");
        const fillId = `${gradientId}-${si}`;
        return (
          <g key={s.key}>
            {filled && (
              <>
                {style.chartFill === "gradient" && (
                  <defs>
                    <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={color} stopOpacity={0.45} />
                      <stop offset="100%" stopColor={color} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                )}
                <path
                  d={areaPath(d, points, pad.top + plotH)}
                  fill={
                    style.chartFill === "gradient" ? `url(#${fillId})` : color
                  }
                  opacity={style.chartFill === "gradient" ? 1 : 0.18}
                />
              </>
            )}
            <path
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={spark ? 1.5 : 2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {style.markers !== "none" &&
              points.map((p, i) => (
                <circle
                  key={i}
                  cx={p.x}
                  cy={p.y}
                  r={style.markers === "ring" ? 3 : 2.5}
                  fill={style.markers === "ring" ? "var(--color-background)" : color}
                  stroke={color}
                  strokeWidth={style.markers === "ring" ? 1.5 : 0}
                />
              ))}
          </g>
        );
      })}

      {!spark &&
        (style.axes === "x" || style.axes === "both") &&
        categories.map((cat, i) =>
          i % stride === 0 ? (
            <text
              key={cat.key}
              x={x(i)}
              y={height - 4}
              textAnchor="middle"
              fontSize={AXIS_TEXT}
              fill="var(--color-muted-foreground)"
            >
              {categoryLabel(cat)}
            </text>
          ) : null,
        )}
    </>
  );
}

// ── Circular ────────────────────────────────────────────────────────────

function Arcs({
  series,
  style,
  unit,
  width,
  height,
  hole,
}: {
  series: ChartSeries[];
  style: ComponentStyle;
  unit: string;
  width: number;
  height: number;
  hole: number;
}) {
  const cx = width / 2;
  const cy = height / 2;
  const outer = Math.min(width, height) / 2 - 2;
  const inner = outer * Math.min(0.85, Math.max(0, hole));
  const arcs = arcsFor(series[0].points);

  if (arcs.length === 0) {
    return (
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dy="0.32em"
        fontSize={AXIS_TEXT}
        fill="var(--color-muted-foreground)"
      >
        No data
      </text>
    );
  }

  return (
    <>
      {arcs.map((arc, i) => {
        const point = series[0].points.find((p) => p.key === arc.key);
        const color = point?.color ?? seriesColor(style.palette, i);
        return (
          <path
            key={arc.key}
            d={arcPath(cx, cy, inner, outer, arc.startAngle, arc.endAngle)}
            fill={style.chartFill === "outline" ? "none" : color}
            stroke={style.chartFill === "outline" ? color : "var(--color-background)"}
            strokeWidth={style.chartFill === "outline" ? 2 : 1}
            opacity={style.chartFill === "soft" ? 0.6 : 1}
          />
        );
      })}

      {style.dataLabels !== "none" &&
        arcs
          // A sliver's label lands on top of its neighbours' and reads as
          // noise; below about 7% there is nowhere for it to go.
          .filter((a) => a.fraction > 0.07)
          .map((arc) => {
            const at = polar(cx, cy, (inner + outer) / 2, arc.midAngle);
            return (
              <text
                key={arc.key}
                x={at.x}
                y={at.y}
                dy="0.32em"
                textAnchor="middle"
                fontSize={AXIS_TEXT}
                fill="var(--color-background)"
                style={{ paintOrder: "stroke" }}
                stroke="var(--color-foreground)"
                strokeWidth={2.5}
              >
                {style.dataLabels === "percent"
                  ? `${Math.round(arc.fraction * 100)}%`
                  : compactNumber(arc.value)}
              </text>
            );
          })}

      {inner > 12 && (
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          dy="0.32em"
          fontSize={Math.min(20, inner * 0.6)}
          fill="var(--color-foreground)"
          className="tabular-nums"
        >
          {formatValue(
            series[0].points.reduce((s, p) => s + p.value, 0),
            unit,
          )}
        </text>
      )}
    </>
  );
}

/**
 * Concentric progress arcs — one ring per point.
 *
 * Each ring is that point's share of the largest, which is the reading a
 * radial chart can actually support: comparing arc *lengths* at different
 * radii is something people are bad at, so the rings share a scale and the
 * comparison is "how far round did each get".
 */
function Radial({
  series,
  style,
  width,
  height,
}: {
  series: ChartSeries[];
  style: ComponentStyle;
  width: number;
  height: number;
}) {
  const cx = width / 2;
  const cy = height / 2;
  const points = series[0].points.slice(0, 5);
  const max = Math.max(...points.map((p) => p.value), 1);
  const outer = Math.min(width, height) / 2 - 2;
  const band = (outer * 0.7) / Math.max(1, points.length);
  const start = -Math.PI / 2;

  return (
    <>
      {points.map((p, i) => {
        const r1 = outer - i * band;
        const r0 = r1 - band * 0.65;
        const fraction = Math.min(1, Math.max(0, p.value / max));
        const color = p.color ?? seriesColor(style.palette, i);
        return (
          <g key={p.key}>
            <path
              d={arcPath(cx, cy, r0, r1, start, start + Math.PI * 2)}
              fill="var(--color-muted)"
            />
            {fraction > 0 && (
              <path
                d={arcPath(cx, cy, r0, r1, start, start + fraction * Math.PI * 2)}
                fill={color}
              />
            )}
          </g>
        );
      })}
    </>
  );
}

// ── Scatter, waterfall, treemap ─────────────────────────────────────────

function Scatter({
  series,
  style,
  unit,
  width,
  height,
}: {
  series: ChartSeries[];
  style: ComponentStyle;
  unit: string;
  width: number;
  height: number;
}) {
  const pad = paddingFor(style, "scatter");
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const all = series.flatMap((s) => s.points.map((p) => p.value));
  const axis = niceAxis(Math.min(0, ...all), Math.max(...all, 0));
  const y = linearScale(axis.min, axis.max, pad.top + plotH, pad.top);
  const count = series[0].points.length;
  const x = (i: number) =>
    count <= 1 ? pad.left + plotW / 2 : pad.left + (i / (count - 1)) * plotW;

  return (
    <>
      {(style.grid === "horizontal" || style.grid === "both") && (
        <Gridlines ticks={axis.ticks} scale={y} x0={pad.left} x1={pad.left + plotW} />
      )}
      {(style.axes === "y" || style.axes === "both") && (
        <AxisLabels ticks={axis.ticks} scale={y} x={pad.left - 4} unit={unit} />
      )}
      {series.map((s, si) =>
        s.points.map((p, i) => (
          <circle
            key={`${s.key}-${p.key}`}
            cx={x(i)}
            cy={y(p.value)}
            r={4}
            fill={style.chartFill === "outline" ? "none" : seriesColor(style.palette, si)}
            stroke={seriesColor(style.palette, si)}
            strokeWidth={style.chartFill === "outline" ? 1.5 : 0}
            opacity={style.chartFill === "soft" ? 0.6 : 0.85}
          />
        )),
      )}
    </>
  );
}

/**
 * A waterfall: each bar starts where the last one ended.
 *
 * Reads as "what moved the total", which is a genuinely different question
 * from "how big is each" — so the running total is the whole point and the
 * bars are drawn from it rather than from zero.
 */
function Waterfall({
  series,
  style,
  unit,
  width,
  height,
}: {
  series: ChartSeries[];
  style: ComponentStyle;
  unit: string;
  width: number;
  height: number;
}) {
  const pad = paddingFor(style, "waterfall");
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const points = series[0].points;

  let running = 0;
  const steps = points.map((p) => {
    const from = running;
    running += p.value;
    return { point: p, from, to: running };
  });

  const bounds = steps.flatMap((s) => [s.from, s.to]);
  const axis = niceAxis(Math.min(0, ...bounds), Math.max(0, ...bounds));
  const y = linearScale(axis.min, axis.max, pad.top + plotH, pad.top);
  const band = bandScale(points.length, pad.left, pad.left + plotW, barPadding(style.barWidth));
  const radius = barRadius(style.barShape, band.bandwidth);
  const stride = labelStride(points.length, plotW);

  return (
    <>
      {(style.grid === "horizontal" || style.grid === "both") && (
        <Gridlines ticks={axis.ticks} scale={y} x0={pad.left} x1={pad.left + plotW} />
      )}
      {(style.axes === "y" || style.axes === "both") && (
        <AxisLabels ticks={axis.ticks} scale={y} x={pad.left - 4} unit={unit} />
      )}
      {steps.map((s, i) => {
        const a = y(s.from);
        const b = y(s.to);
        // Up and down are the two readings a waterfall exists to separate, so
        // they take the palette's first two entries rather than one colour.
        const color = seriesColor(style.palette, s.point.value >= 0 ? 0 : 1);
        return (
          <g key={s.point.key}>
            <path
              d={roundedRectPath(
                band.start(i),
                Math.min(a, b),
                band.bandwidth,
                Math.max(1, Math.abs(b - a)),
                { tl: radius, tr: radius, bl: radius, br: radius },
              )}
              fill={style.chartFill === "outline" ? "none" : color}
              stroke={style.chartFill === "outline" ? color : "none"}
              strokeWidth={style.chartFill === "outline" ? 1.5 : 0}
            />
            {style.dataLabels !== "none" && (
              <text
                x={band.center(i)}
                y={Math.min(a, b) - 3}
                textAnchor="middle"
                fontSize={AXIS_TEXT}
                fill="var(--color-muted-foreground)"
              >
                {compactNumber(s.point.value)}
              </text>
            )}
            {(style.axes === "x" || style.axes === "both") && i % stride === 0 && (
              <text
                x={band.center(i)}
                y={height - 4}
                textAnchor="middle"
                fontSize={AXIS_TEXT}
                fill="var(--color-muted-foreground)"
              >
                {categoryLabel(s.point)}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
}

function Treemap({
  series,
  style,
  width,
  height,
}: {
  series: ChartSeries[];
  style: ComponentStyle;
  width: number;
  height: number;
}) {
  const tiles = squarify(
    series[0].points.map((p) => ({ key: p.key, label: p.label, value: p.value })),
    0,
    0,
    width,
    height,
  );
  const gap = 1.5;

  return (
    <>
      {tiles.map((tile, i) => {
        const point = series[0].points.find((p) => p.key === tile.key);
        const color = point?.color ?? seriesColor(style.palette, i);
        const w = Math.max(0, tile.width - gap);
        const h = Math.max(0, tile.height - gap);
        return (
          <g key={tile.key}>
            <path
              d={roundedRectPath(tile.x, tile.y, w, h, {
                tl: barRadius(style.barShape, Math.min(w, h)),
                tr: barRadius(style.barShape, Math.min(w, h)),
                bl: barRadius(style.barShape, Math.min(w, h)),
                br: barRadius(style.barShape, Math.min(w, h)),
              })}
              fill={color}
              opacity={style.chartFill === "soft" ? 0.6 : 1}
            />
            {/* A label only where one fits. Clipped text in a treemap reads
                as a rendering fault rather than as a small tile. */}
            {w > 46 && h > 20 && (
              <text
                x={tile.x + 6}
                y={tile.y + 14}
                fontSize={AXIS_TEXT}
                fill="var(--color-background)"
                className="pointer-events-none"
              >
                {categoryLabel({ key: tile.key, label: tile.label })}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
}
