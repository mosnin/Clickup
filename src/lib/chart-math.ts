// Chart geometry, by hand.
//
// No charting library. That is a deliberate ceiling decision, not thrift: the
// point of this system is dozens of distinct aesthetics over the same data, and
// a charting library's styling surface is exactly the wall you hit when you try
// to do that. Recharts would have got us bars faster and then decided for us
// what a bar is allowed to look like.
//
// So this file is the maths — scales, ticks, stacks, arcs, curves, squarified
// treemaps — and it is pure. No DOM, no React, no SVG strings. Everything
// returns numbers and path data, which means it can be tested exhaustively at
// the level where chart bugs actually live: an axis that skips a tick, a
// stacked bar whose segments do not sum to the total, a donut whose last
// segment does not close the circle.
//
// The invariants worth stating, because they are what the tests enforce:
//
//   - **A scale is total.** Any finite input maps somewhere on the axis, and
//     values outside the domain clamp rather than escape the plot area.
//   - **A degenerate domain is not a crash.** Every value identical, one point,
//     zero points and all-zero values are ordinary cases in a real dashboard
//     on a Monday morning, and each must draw something sane.
//   - **Stacks sum.** The top of the last segment is the total, exactly, with
//     no accumulated floating-point drift visible at the pixel level.
//   - **Arcs close.** A full circle's segments span exactly 2π, so a donut
//     never shows a hairline gap where it wrapped.

export type Point = { x: number; y: number };

/** An inset within a chart's box, leaving room for axes and labels. */
export type Padding = { top: number; right: number; bottom: number; left: number };

export const NO_PADDING: Padding = { top: 0, right: 0, bottom: 0, left: 0 };

// ── Scales ──────────────────────────────────────────────────────────────

/**
 * A linear scale from a value domain to a pixel range.
 *
 * Clamped: a value outside the domain lands on the nearest edge rather than
 * outside the plot. An unclamped scale is how a single bad datum draws a bar
 * through the page header.
 */
export function linearScale(
  domainMin: number,
  domainMax: number,
  rangeMin: number,
  rangeMax: number,
): (value: number) => number {
  const span = domainMax - domainMin;
  // A flat domain has no meaningful position within it; the middle of the
  // range is the only answer that does not privilege one end.
  if (!Number.isFinite(span) || span === 0) {
    const mid = (rangeMin + rangeMax) / 2;
    return () => mid;
  }
  return (value: number) => {
    if (!Number.isFinite(value)) return rangeMin;
    const t = (value - domainMin) / span;
    const clamped = Math.min(1, Math.max(0, t));
    return rangeMin + clamped * (rangeMax - rangeMin);
  };
}

export type BandScale = {
  /** Left edge of band `i`. */
  start: (index: number) => number;
  /** Width of one band, gaps excluded. */
  bandwidth: number;
  /** Centre of band `i` — where a tick label or a point marker goes. */
  center: (index: number) => number;
  /** Distance from one band's start to the next, gap included. */
  step: number;
};

/**
 * Evenly spaced bands across a range, with a proportional gap between them.
 *
 * `padding` is the share of each step given to the gap, so 0.2 means bars
 * occupy 80% of their slot. Expressed as a fraction rather than pixels because
 * a fixed gap looks wrong at both ends: invisible across sixty bars, and
 * enormous across three.
 */
export function bandScale(
  count: number,
  rangeMin: number,
  rangeMax: number,
  padding = 0.2,
): BandScale {
  const width = rangeMax - rangeMin;
  const n = Math.max(1, Math.floor(count));
  const step = width / n;
  const gap = Math.min(0.9, Math.max(0, padding));
  const bandwidth = Math.max(0, step * (1 - gap));
  const offset = (step - bandwidth) / 2;
  return {
    step,
    bandwidth,
    start: (i: number) => rangeMin + i * step + offset,
    center: (i: number) => rangeMin + i * step + step / 2,
  };
}

// ── Ticks ───────────────────────────────────────────────────────────────

/**
 * A "nice" step: 1, 2, 5 or 10 times a power of ten.
 *
 * Axis labels people can read are labels at round numbers. 1/2/5 is the
 * standard set because every one of them divides evenly enough that the
 * intermediate gridlines also land on round numbers.
 */
export function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

export type Axis = {
  min: number;
  max: number;
  ticks: number[];
};

/**
 * An axis that covers [min, max] and lands on round numbers.
 *
 * Always includes zero when the data is non-negative: a bar chart whose axis
 * starts at 90 exaggerates every difference on it, which is the single most
 * common way a chart misleads without containing a false number.
 */
export function niceAxis(
  min: number,
  max: number,
  targetTicks = 4,
): Axis {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : 0;
  if (lo > hi) [lo, hi] = [hi, lo];

  // Non-negative data is measured from zero. Negative data keeps its own
  // floor, because a waterfall that cannot go below zero is not a waterfall.
  if (lo >= 0) lo = 0;
  if (hi <= 0) hi = 0;

  // Everything is zero, or a single flat value: give the axis somewhere to be.
  if (lo === hi) {
    if (lo === 0) return { min: 0, max: 1, ticks: [0, 1] };
    const pad = Math.abs(lo) * 0.5;
    lo -= pad;
    hi += pad;
  }

  const step = niceStep((hi - lo) / Math.max(1, targetTicks));
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;

  const ticks: number[] = [];
  // Guard the loop on a count as well as the bound: floating-point steps can
  // otherwise fail to reach niceMax and spin.
  const maxTicks = 64;
  for (
    let i = 0, v = niceMin;
    v <= niceMax + step * 1e-9 && i < maxTicks;
    i += 1, v = niceMin + i * step
  ) {
    // Re-derive from the index rather than accumulating, so tick 10 is not
    // 9.999999999999998.
    ticks.push(roundTo(v, step));
  }
  return { min: niceMin, max: niceMax, ticks };
}

/** Round to the precision implied by a step, killing accumulated drift. */
function roundTo(value: number, step: number): number {
  const decimals = Math.max(0, Math.min(10, -Math.floor(Math.log10(step)) + 1));
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

// ── Stacking ────────────────────────────────────────────────────────────

export type StackSegment = {
  seriesIndex: number;
  /** Value at the bottom of this segment. */
  from: number;
  /** Value at the top. */
  to: number;
  value: number;
};

/**
 * Stack values at one position.
 *
 * Returns cumulative bounds rather than heights so a renderer never has to
 * accumulate, which is where stacked charts drift: adding heights in the
 * renderer means the top of the last segment is the sum of N roundings, and it
 * visibly fails to meet the axis. Here the top of segment i is the exact
 * running total, and the last one is the exact grand total.
 *
 * Negative values stack downward from zero, so a diverging bar reads correctly
 * rather than folding back over its own positives.
 */
export function stack(values: number[]): StackSegment[] {
  let positive = 0;
  let negative = 0;
  const out: StackSegment[] = [];
  values.forEach((raw, seriesIndex) => {
    const value = Number.isFinite(raw) ? raw : 0;
    if (value >= 0) {
      out.push({ seriesIndex, from: positive, to: positive + value, value });
      positive += value;
    } else {
      out.push({ seriesIndex, from: negative + value, to: negative, value });
      negative += value;
    }
  });
  return out;
}

/** Turn each position's values into shares of its own total, 0..100. */
export function toPercent(values: number[]): number[] {
  const total = values.reduce((s, v) => s + (Number.isFinite(v) ? Math.abs(v) : 0), 0);
  if (total === 0) return values.map(() => 0);
  return values.map((v) => ((Number.isFinite(v) ? v : 0) / total) * 100);
}

// ── Paths ───────────────────────────────────────────────────────────────

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

/** A polyline through the points. */
export function linePath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    // A single reading is a dot, and a zero-length path draws nothing at all
    // in most renderers — so give it length it can actually stroke.
    const p = points[0];
    return `M${fmt(p.x)},${fmt(p.y)}L${fmt(p.x)},${fmt(p.y)}`;
  }
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${fmt(p.x)},${fmt(p.y)}`)
    .join("");
}

/**
 * A smooth path through the points, via Catmull-Rom converted to cubic Bézier.
 *
 * Catmull-Rom rather than a hand-tuned Bézier because it *interpolates* — the
 * curve passes exactly through every data point. A spline that merely
 * approximates its points is a chart that draws a value nobody recorded, which
 * is a correctness bug wearing a smoothing setting.
 *
 * `tension` 0 is the standard uniform Catmull-Rom; higher flattens toward
 * straight lines.
 */
export function smoothPath(points: Point[], tension = 0): string {
  if (points.length < 3) return linePath(points);
  const k = (1 - Math.min(1, Math.max(0, tension))) / 6;
  let d = `M${fmt(points[0].x)},${fmt(points[0].y)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) * k, y: p1.y + (p2.y - p0.y) * k };
    const c2 = { x: p2.x - (p3.x - p1.x) * k, y: p2.y - (p3.y - p1.y) * k };
    d += `C${fmt(c1.x)},${fmt(c1.y)} ${fmt(c2.x)},${fmt(c2.y)} ${fmt(p2.x)},${fmt(p2.y)}`;
  }
  return d;
}

/** A staircase through the points — the honest shape for a value that jumps. */
export function stepPath(points: Point[]): string {
  if (points.length === 0) return "";
  let d = `M${fmt(points[0].x)},${fmt(points[0].y)}`;
  for (let i = 1; i < points.length; i += 1) {
    d += `H${fmt(points[i].x)}V${fmt(points[i].y)}`;
  }
  return d;
}

/** Close a line down to a baseline, making it fillable as an area. */
export function areaPath(line: string, points: Point[], baselineY: number): string {
  if (points.length === 0 || !line) return "";
  const first = points[0];
  const last = points[points.length - 1];
  return `${line}L${fmt(last.x)},${fmt(baselineY)}L${fmt(first.x)},${fmt(baselineY)}Z`;
}

/** A rectangle with independently rounded corners, as a path. */
export function roundedRectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radii: { tl?: number; tr?: number; br?: number; bl?: number } = {},
): string {
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  // A radius larger than half the box inverts the corner. Clamping is what
  // keeps a "pill" bar a pill when it is one pixel tall.
  const cap = Math.min(w, h) / 2;
  const tl = Math.min(cap, Math.max(0, radii.tl ?? 0));
  const tr = Math.min(cap, Math.max(0, radii.tr ?? 0));
  const br = Math.min(cap, Math.max(0, radii.br ?? 0));
  const bl = Math.min(cap, Math.max(0, radii.bl ?? 0));
  return [
    `M${fmt(x + tl)},${fmt(y)}`,
    `H${fmt(x + w - tr)}`,
    tr ? `A${fmt(tr)},${fmt(tr)} 0 0 1 ${fmt(x + w)},${fmt(y + tr)}` : "",
    `V${fmt(y + h - br)}`,
    br ? `A${fmt(br)},${fmt(br)} 0 0 1 ${fmt(x + w - br)},${fmt(y + h)}` : "",
    `H${fmt(x + bl)}`,
    bl ? `A${fmt(bl)},${fmt(bl)} 0 0 1 ${fmt(x)},${fmt(y + h - bl)}` : "",
    `V${fmt(y + tl)}`,
    tl ? `A${fmt(tl)},${fmt(tl)} 0 0 1 ${fmt(x + tl)},${fmt(y)}` : "",
    "Z",
  ]
    .filter(Boolean)
    .join("");
}

// ── Arcs ────────────────────────────────────────────────────────────────

export type Arc = {
  key: string;
  label: string;
  value: number;
  startAngle: number;
  endAngle: number;
  /** Midpoint angle, for placing a label or exploding the segment outward. */
  midAngle: number;
  /** Share of the whole, 0..1. */
  fraction: number;
};

const TAU = Math.PI * 2;

/**
 * Slice a circle by value.
 *
 * Angles start at twelve o'clock and run clockwise, which is what people read
 * a pie as doing. The last arc's end is set to exactly `startAt + TAU` rather
 * than accumulated, because accumulating N divisions leaves a sub-pixel wedge
 * of background showing where the circle failed to close — visible, and
 * impossible to explain to anyone.
 */
export function arcsFor(
  values: { key: string; label: string; value: number }[],
  startAt = -Math.PI / 2,
): Arc[] {
  const usable = values.map((v) => ({
    ...v,
    value: Number.isFinite(v.value) && v.value > 0 ? v.value : 0,
  }));
  const total = usable.reduce((s, v) => s + v.value, 0);
  if (total === 0) return [];

  const out: Arc[] = [];
  let angle = startAt;
  usable.forEach((v, i) => {
    const fraction = v.value / total;
    const isLast = i === usable.length - 1;
    const end = isLast ? startAt + TAU : angle + fraction * TAU;
    out.push({
      key: v.key,
      label: v.label,
      value: v.value,
      startAngle: angle,
      endAngle: end,
      midAngle: (angle + end) / 2,
      fraction,
    });
    angle = end;
  });
  return out;
}

/**
 * The path for one annular segment.
 *
 * `innerRadius` of 0 gives a pie wedge; anything larger gives a donut. A
 * segment covering the whole circle is drawn as two half-arcs, because a
 * single arc from a point back to itself is a zero-length arc and renders as
 * nothing — the "one status, 100%" case, which is exactly the case a new
 * workspace hits first.
 */
export function arcPath(
  cx: number,
  cy: number,
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number,
): string {
  const r0 = Math.max(0, Math.min(innerRadius, outerRadius));
  const r1 = Math.max(0, Math.max(innerRadius, outerRadius));
  if (r1 === 0) return "";

  const sweep = endAngle - startAngle;
  if (Math.abs(sweep) >= TAU - 1e-9) {
    const half = startAngle + Math.PI;
    const ring = (r: number, dir: 0 | 1) =>
      `M${fmt(cx + r * Math.cos(startAngle))},${fmt(cy + r * Math.sin(startAngle))}` +
      `A${fmt(r)},${fmt(r)} 0 1 ${dir} ${fmt(cx + r * Math.cos(half))},${fmt(cy + r * Math.sin(half))}` +
      `A${fmt(r)},${fmt(r)} 0 1 ${dir} ${fmt(cx + r * Math.cos(startAngle))},${fmt(cy + r * Math.sin(startAngle))}Z`;
    return r0 > 0 ? `${ring(r1, 1)}${ring(r0, 0)}` : ring(r1, 1);
  }

  const large = Math.abs(sweep) > Math.PI ? 1 : 0;
  const dir = sweep >= 0 ? 1 : 0;
  const p = (r: number, a: number) => ({
    x: cx + r * Math.cos(a),
    y: cy + r * Math.sin(a),
  });
  const o0 = p(r1, startAngle);
  const o1 = p(r1, endAngle);

  if (r0 === 0) {
    return (
      `M${fmt(cx)},${fmt(cy)}L${fmt(o0.x)},${fmt(o0.y)}` +
      `A${fmt(r1)},${fmt(r1)} 0 ${large} ${dir} ${fmt(o1.x)},${fmt(o1.y)}Z`
    );
  }
  const i1 = p(r0, endAngle);
  const i0 = p(r0, startAngle);
  return (
    `M${fmt(o0.x)},${fmt(o0.y)}` +
    `A${fmt(r1)},${fmt(r1)} 0 ${large} ${dir} ${fmt(o1.x)},${fmt(o1.y)}` +
    `L${fmt(i1.x)},${fmt(i1.y)}` +
    `A${fmt(r0)},${fmt(r0)} 0 ${large} ${dir ? 0 : 1} ${fmt(i0.x)},${fmt(i0.y)}Z`
  );
}

/** A point on a circle, for placing labels and markers around a dial. */
export function polar(cx: number, cy: number, radius: number, angle: number): Point {
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
}

// ── Treemap ─────────────────────────────────────────────────────────────

export type Tile = {
  key: string;
  label: string;
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Squarified treemap.
 *
 * The naive slice-and-dice treemap produces long thin slivers whose areas are
 * impossible to compare, which defeats the entire purpose of a treemap. The
 * squarified algorithm (Bruls, Huizing, van Wijk) instead greedily packs each
 * row until adding another tile would make the worst aspect ratio worse — so
 * tiles stay near-square and their areas stay comparable.
 *
 * Areas are exactly proportional to values: the point of the chart is that a
 * tile twice the area means twice the number.
 */
export function squarify(
  values: { key: string; label: string; value: number }[],
  x: number,
  y: number,
  width: number,
  height: number,
): Tile[] {
  const items = values
    .map((v) => ({ ...v, value: Number.isFinite(v.value) ? Math.max(0, v.value) : 0 }))
    .filter((v) => v.value > 0)
    .sort((a, b) => b.value - a.value);

  if (items.length === 0 || width <= 0 || height <= 0) return [];

  const total = items.reduce((s, v) => s + v.value, 0);
  const area = width * height;
  const scaled = items.map((v) => ({ ...v, area: (v.value / total) * area }));

  const out: Tile[] = [];
  let cx = x;
  let cy = y;
  let cw = width;
  let ch = height;
  let index = 0;

  const worst = (row: number[], side: number): number => {
    if (row.length === 0 || side === 0) return Infinity;
    const sum = row.reduce((s, v) => s + v, 0);
    if (sum === 0) return Infinity;
    const max = Math.max(...row);
    const min = Math.min(...row);
    const side2 = side * side;
    const sum2 = sum * sum;
    return Math.max((side2 * max) / sum2, sum2 / (side2 * min));
  };

  while (index < scaled.length) {
    const vertical = cw >= ch;
    const side = vertical ? ch : cw;
    const row: number[] = [];
    let end = index;

    while (end < scaled.length) {
      const next = [...row, scaled[end].area];
      if (row.length > 0 && worst(next, side) > worst(row, side)) break;
      row.push(scaled[end].area);
      end += 1;
    }

    const rowSum = row.reduce((s, v) => s + v, 0);
    const thickness = side === 0 ? 0 : rowSum / side;
    let offset = 0;
    for (let i = 0; i < row.length; i += 1) {
      const item = scaled[index + i];
      const length = rowSum === 0 ? 0 : (row[i] / rowSum) * side;
      out.push({
        key: item.key,
        label: item.label,
        value: item.value,
        x: vertical ? cx : cx + offset,
        y: vertical ? cy + offset : cy,
        width: vertical ? thickness : length,
        height: vertical ? length : thickness,
      });
      offset += length;
    }

    if (vertical) {
      cx += thickness;
      cw -= thickness;
    } else {
      cy += thickness;
      ch -= thickness;
    }
    index = end;
    // A row that consumed nothing would loop forever; a zero-area remainder is
    // the honest place to stop.
    if (thickness === 0) break;
  }
  return out;
}

// ── Formatting ──────────────────────────────────────────────────────────

/**
 * A number, at the width an axis label can afford.
 *
 * Charts are small and their labels are smaller, so 1200 is "1.2k". The
 * threshold is 10_000 rather than 1_000 because "1.2k" is *less* legible than
 * "1200" at four digits, and only becomes worth it once the digits do not fit.
 */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 10_000) return `${trim(value / 1_000)}k`;
  if (Number.isInteger(value)) return String(value);
  return trim(value);
}

function trim(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/** A value with its unit, for axis labels and tooltips. */
export function formatValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "—";
  switch (unit) {
    case "percent":
      return `${Math.round(value)}%`;
    case "hours":
      return `${trim(value)}h`;
    case "points":
      return `${compactNumber(value)} pts`;
    case "currency":
      return `$${compactNumber(value)}`;
    default:
      return compactNumber(value);
  }
}

/**
 * How many labels an axis can show before they collide.
 *
 * Returns the stride to take, so sixty daily buckets across 300px shows every
 * fifth label rather than an unreadable smear. Chosen by available width per
 * label rather than by count, because the same sixty buckets are perfectly
 * readable on a wide panel.
 */
export function labelStride(
  count: number,
  available: number,
  labelWidth = 34,
): number {
  if (count <= 0 || available <= 0) return 1;
  const fits = Math.max(1, Math.floor(available / labelWidth));
  return Math.max(1, Math.ceil(count / fits));
}
