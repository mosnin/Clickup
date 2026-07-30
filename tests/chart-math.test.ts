import { describe, expect, it } from "vitest";
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
  niceStep,
  polar,
  roundedRectPath,
  smoothPath,
  squarify,
  stack,
  stepPath,
  toPercent,
  type Point,
} from "../src/lib/chart-math";

// Chart geometry, tested where chart bugs actually live.
//
// Not "does it return a string" — the failures that matter are an axis that
// skips a tick, a stacked bar whose top does not meet its total, a donut with
// a hairline gap where the circle failed to close, and a treemap whose areas
// are not proportional to the numbers they claim to show. Every one of those
// renders happily and is wrong.
//
// The degenerate cases get as much attention as the ordinary ones, because a
// dashboard on a Monday morning is all zeroes and one data point.

const TAU = Math.PI * 2;

describe("linear scale", () => {
  it("maps the domain onto the range", () => {
    const s = linearScale(0, 10, 100, 0); // inverted, as a y-axis is
    expect(s(0)).toBe(100);
    expect(s(10)).toBe(0);
    expect(s(5)).toBe(50);
  });

  it("clamps rather than escaping the plot", () => {
    // One bad datum must not draw a bar through the page header.
    const s = linearScale(0, 10, 0, 100);
    expect(s(-50)).toBe(0);
    expect(s(1000)).toBe(100);
  });

  it("survives a flat domain", () => {
    // Every value identical is an ordinary Monday, not an error.
    const s = linearScale(5, 5, 0, 100);
    expect(s(5)).toBe(50);
    expect(s(0)).toBe(50);
    expect(Number.isFinite(s(99))).toBe(true);
  });

  it("never returns NaN", () => {
    const s = linearScale(0, 10, 0, 100);
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(Number.isFinite(s(bad)), String(bad)).toBe(true);
    }
  });
});

describe("band scale", () => {
  it("spaces bands evenly and leaves a proportional gap", () => {
    const b = bandScale(4, 0, 400, 0.2);
    expect(b.step).toBe(100);
    expect(b.bandwidth).toBeCloseTo(80);
    expect(b.start(0)).toBeCloseTo(10);
    expect(b.center(0)).toBeCloseTo(50);
    expect(b.center(3)).toBeCloseTo(350);
  });

  it("keeps every band inside the range", () => {
    const b = bandScale(7, 0, 300, 0.3);
    for (let i = 0; i < 7; i += 1) {
      expect(b.start(i)).toBeGreaterThanOrEqual(0);
      expect(b.start(i) + b.bandwidth).toBeLessThanOrEqual(300 + 1e-9);
    }
  });

  it("handles zero and one band without dividing by zero", () => {
    for (const n of [0, 1]) {
      const b = bandScale(n, 0, 100);
      expect(Number.isFinite(b.bandwidth), String(n)).toBe(true);
      expect(b.bandwidth).toBeGreaterThan(0);
    }
  });

  it("never lets the gap eat the whole band", () => {
    const b = bandScale(5, 0, 500, 5);
    expect(b.bandwidth).toBeGreaterThan(0);
  });
});

describe("nice steps and axes", () => {
  it("snaps to 1, 2, 5 or 10 times a power of ten", () => {
    expect(niceStep(0.8)).toBeCloseTo(1);
    expect(niceStep(1.5)).toBeCloseTo(2);
    expect(niceStep(3)).toBeCloseTo(5);
    expect(niceStep(7)).toBeCloseTo(10);
    expect(niceStep(23)).toBeCloseTo(50);
  });

  it("starts a non-negative axis at zero", () => {
    // An axis starting at 90 exaggerates every difference on it — the most
    // common way a chart misleads without containing a false number.
    const axis = niceAxis(90, 100);
    expect(axis.min).toBe(0);
    expect(axis.ticks[0]).toBe(0);
  });

  it("covers the data it was given", () => {
    for (const [lo, hi] of [
      [0, 7],
      [0, 1],
      [0, 0.4],
      [0, 12345],
      [-30, 80],
    ] as const) {
      const axis = niceAxis(lo, hi);
      expect(axis.min, `${lo}..${hi}`).toBeLessThanOrEqual(lo);
      expect(axis.max, `${lo}..${hi}`).toBeGreaterThanOrEqual(hi);
    }
  });

  it("emits ticks that are ascending, unique and land on round numbers", () => {
    const axis = niceAxis(0, 97);
    expect(axis.ticks.length).toBeGreaterThan(1);
    for (let i = 1; i < axis.ticks.length; i += 1) {
      expect(axis.ticks[i]).toBeGreaterThan(axis.ticks[i - 1]);
    }
    // No 9.999999999999998 anywhere: ticks are re-derived from the index
    // rather than accumulated.
    for (const t of axis.ticks) {
      expect(String(t).length).toBeLessThan(8);
    }
    expect(axis.ticks[0]).toBe(axis.min);
    expect(axis.ticks[axis.ticks.length - 1]).toBe(axis.max);
  });

  it("gives an all-zero dataset somewhere to be", () => {
    const axis = niceAxis(0, 0);
    expect(axis.min).toBe(0);
    expect(axis.max).toBeGreaterThan(0);
    expect(axis.ticks.length).toBeGreaterThan(1);
  });

  it("terminates on any input rather than spinning", () => {
    for (const [lo, hi] of [
      [NaN, NaN],
      [Infinity, -Infinity],
      [1e-12, 2e-12],
      [-1e9, 1e9],
      [5, 5],
      [10, 2],
    ] as const) {
      const axis = niceAxis(lo, hi);
      expect(axis.ticks.length, `${lo}..${hi}`).toBeGreaterThan(0);
      expect(axis.ticks.length, `${lo}..${hi}`).toBeLessThanOrEqual(64);
    }
  });
});

describe("stacking", () => {
  it("returns cumulative bounds so the renderer never accumulates", () => {
    const s = stack([3, 2, 5]);
    expect(s.map((x) => [x.from, x.to])).toEqual([
      [0, 3],
      [3, 5],
      [5, 10],
    ]);
  });

  it("makes the top of the last segment exactly the total", () => {
    // Adding heights in the renderer means the top is the sum of N roundings,
    // and it visibly fails to meet the axis.
    const values = [0.1, 0.2, 0.3, 0.15, 0.25];
    const s = stack(values);
    const total = values.reduce((a, b) => a + b, 0);
    expect(s[s.length - 1].to).toBeCloseTo(total, 10);
  });

  it("stacks negatives downward from zero", () => {
    const s = stack([5, -3, 2]);
    expect(s[0]).toMatchObject({ from: 0, to: 5 });
    expect(s[1]).toMatchObject({ from: -3, to: 0 });
    expect(s[2]).toMatchObject({ from: 5, to: 7 });
  });

  it("treats a non-number as zero rather than poisoning the stack", () => {
    const s = stack([1, NaN, 2]);
    expect(s[2].to).toBe(3);
    expect(s.every((x) => Number.isFinite(x.from) && Number.isFinite(x.to))).toBe(true);
  });

  it("does nothing with nothing", () => {
    expect(stack([])).toEqual([]);
  });
});

describe("percent stacking", () => {
  it("turns values into shares of their own total", () => {
    expect(toPercent([1, 1, 2])).toEqual([25, 25, 50]);
  });

  it("sums to a hundred", () => {
    const p = toPercent([7, 13, 3, 41]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 9);
  });

  it("returns zeroes for an empty total rather than NaN", () => {
    expect(toPercent([0, 0, 0])).toEqual([0, 0, 0]);
    expect(toPercent([])).toEqual([]);
  });
});

describe("line paths", () => {
  const pts: Point[] = [
    { x: 0, y: 10 },
    { x: 10, y: 0 },
    { x: 20, y: 5 },
    { x: 30, y: 2 },
  ];

  it("draws a polyline", () => {
    expect(linePath(pts)).toBe("M0,10L10,0L20,5L30,2");
  });

  it("gives a single reading something strokeable", () => {
    // A zero-length path draws nothing at all in most renderers.
    expect(linePath([{ x: 5, y: 5 }])).toBe("M5,5L5,5");
    expect(linePath([])).toBe("");
  });

  it("passes a smooth curve exactly through every point", () => {
    // Catmull-Rom interpolates. A spline that merely approximates its points
    // draws a value nobody recorded — a correctness bug wearing a setting.
    const d = smoothPath(pts);
    expect(d.startsWith("M0,10")).toBe(true);
    for (const p of pts.slice(1)) {
      expect(d).toContain(`${p.x},${p.y}`);
    }
  });

  it("falls back to a line when there is not enough to curve", () => {
    expect(smoothPath([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe("M0,0L1,1");
  });

  it("draws a staircase for a value that jumps", () => {
    expect(stepPath(pts)).toBe("M0,10H10V0H20V5H30V2");
  });

  it("closes an area down to its baseline", () => {
    const area = areaPath(linePath(pts), pts, 100);
    expect(area.endsWith("Z")).toBe(true);
    expect(area).toContain("L30,100");
    expect(area).toContain("L0,100");
  });

  it("returns nothing for an area with no line", () => {
    expect(areaPath("", [], 100)).toBe("");
  });
});

describe("rounded rectangles", () => {
  it("closes, and starts at the top-left plus its radius", () => {
    const d = roundedRectPath(10, 20, 100, 50, { tl: 4, tr: 4 });
    expect(d.startsWith("M14,20")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
  });

  it("clamps a radius that would invert the corner", () => {
    // A "pill" bar one pixel tall must stay a pill, not turn inside out.
    const d = roundedRectPath(0, 0, 100, 2, { tl: 999, tr: 999 });
    expect(d).not.toContain("NaN");
    expect(d).toContain("A1,1");
  });

  it("survives a zero-size bar", () => {
    const d = roundedRectPath(0, 0, 0, 0, { tl: 4 });
    expect(d).not.toContain("NaN");
  });

  it("omits the arc for a square corner", () => {
    const d = roundedRectPath(0, 0, 10, 10);
    expect(d).not.toContain("A");
  });
});

describe("arcs", () => {
  it("divides the circle in proportion to value", () => {
    const arcs = arcsFor([
      { key: "a", label: "A", value: 1 },
      { key: "b", label: "B", value: 3 },
    ]);
    expect(arcs[0].fraction).toBeCloseTo(0.25);
    expect(arcs[1].fraction).toBeCloseTo(0.75);
  });

  it("closes the circle exactly", () => {
    // Accumulating N divisions leaves a sub-pixel wedge of background showing
    // where the circle failed to close — visible, and impossible to explain.
    const arcs = arcsFor(
      Array.from({ length: 7 }, (_, i) => ({
        key: String(i),
        label: "",
        value: 1 / 3,
      })),
    );
    const start = arcs[0].startAngle;
    const end = arcs[arcs.length - 1].endAngle;
    expect(end - start).toBe(TAU);
  });

  it("is contiguous — no gaps between neighbours", () => {
    const arcs = arcsFor([
      { key: "a", label: "", value: 5 },
      { key: "b", label: "", value: 2 },
      { key: "c", label: "", value: 8 },
    ]);
    for (let i = 1; i < arcs.length; i += 1) {
      expect(arcs[i].startAngle).toBeCloseTo(arcs[i - 1].endAngle, 12);
    }
  });

  it("ignores negative and non-finite values rather than reversing a wedge", () => {
    const arcs = arcsFor([
      { key: "a", label: "", value: 4 },
      { key: "b", label: "", value: -3 },
      { key: "c", label: "", value: NaN },
    ]);
    expect(arcs.every((a) => a.endAngle >= a.startAngle)).toBe(true);
    expect(arcs[0].fraction).toBe(1);
  });

  it("returns nothing when there is nothing to divide", () => {
    expect(arcsFor([])).toEqual([]);
    expect(arcsFor([{ key: "a", label: "", value: 0 }])).toEqual([]);
  });

  it("puts the midpoint between the ends, for labels", () => {
    const [arc] = arcsFor([{ key: "a", label: "", value: 1 }]);
    expect(arc.midAngle).toBeCloseTo((arc.startAngle + arc.endAngle) / 2);
  });
});

describe("arc paths", () => {
  it("draws a wedge for a pie and a band for a donut", () => {
    const wedge = arcPath(50, 50, 0, 40, 0, Math.PI / 2);
    expect(wedge.startsWith("M50,50")).toBe(true); // through the centre
    const band = arcPath(50, 50, 20, 40, 0, Math.PI / 2);
    expect(band.startsWith("M50,50")).toBe(false);
    expect(band).toContain("A20,20");
  });

  it("draws a full circle as two half-arcs", () => {
    // A single arc from a point back to itself is zero-length and renders as
    // nothing — the "one status, 100%" case a new workspace hits first.
    const full = arcPath(50, 50, 20, 40, -Math.PI / 2, -Math.PI / 2 + TAU);
    expect(full.length).toBeGreaterThan(0);
    expect(full).not.toContain("NaN");
    // Two rings, each two arcs.
    expect(full.match(/A/g)!.length).toBe(4);
  });

  it("sets the large-arc flag past a half turn", () => {
    expect(arcPath(0, 0, 0, 10, 0, Math.PI * 1.5)).toMatch(/0 1 1/);
    expect(arcPath(0, 0, 0, 10, 0, Math.PI * 0.5)).toMatch(/0 0 1/);
  });

  it("returns nothing rather than NaN for a zero radius", () => {
    expect(arcPath(0, 0, 0, 0, 0, 1)).toBe("");
  });

  it("places points on the circle", () => {
    const p = polar(10, 10, 5, 0);
    expect(p.x).toBeCloseTo(15);
    expect(p.y).toBeCloseTo(10);
  });
});

describe("treemap", () => {
  const values = [
    { key: "a", label: "A", value: 6 },
    { key: "b", label: "B", value: 6 },
    { key: "c", label: "C", value: 4 },
    { key: "d", label: "D", value: 3 },
    { key: "e", label: "E", value: 2 },
    { key: "f", label: "F", value: 1 },
  ];

  it("makes area proportional to value", () => {
    // The entire point of the chart: twice the area means twice the number.
    const tiles = squarify(values, 0, 0, 600, 400);
    const total = values.reduce((s, v) => s + v.value, 0);
    const box = 600 * 400;
    for (const tile of tiles) {
      const expected = (tile.value / total) * box;
      expect(tile.width * tile.height, tile.key).toBeCloseTo(expected, 4);
    }
  });

  it("fills the box exactly once — no overlap, no gaps", () => {
    const tiles = squarify(values, 0, 0, 600, 400);
    const area = tiles.reduce((s, t) => s + t.width * t.height, 0);
    expect(area).toBeCloseTo(600 * 400, 3);
    for (const tile of tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(-1e-6);
      expect(tile.y).toBeGreaterThanOrEqual(-1e-6);
      expect(tile.x + tile.width).toBeLessThanOrEqual(600 + 1e-6);
      expect(tile.y + tile.height).toBeLessThanOrEqual(400 + 1e-6);
    }
  });

  it("keeps tiles near-square rather than producing slivers", () => {
    // Slivers are what makes a naive slice-and-dice treemap useless: areas you
    // cannot compare defeat the whole chart.
    const tiles = squarify(values, 0, 0, 600, 400);
    for (const tile of tiles) {
      const ratio = Math.max(tile.width / tile.height, tile.height / tile.width);
      expect(ratio, tile.key).toBeLessThan(6);
    }
  });

  it("drops zero and negative values instead of drawing empty tiles", () => {
    const tiles = squarify(
      [
        { key: "a", label: "", value: 5 },
        { key: "b", label: "", value: 0 },
        { key: "c", label: "", value: -2 },
      ],
      0,
      0,
      100,
      100,
    );
    expect(tiles).toHaveLength(1);
    expect(tiles[0].key).toBe("a");
  });

  it("terminates on degenerate boxes", () => {
    expect(squarify(values, 0, 0, 0, 100)).toEqual([]);
    expect(squarify(values, 0, 0, 100, 0)).toEqual([]);
    expect(squarify([], 0, 0, 100, 100)).toEqual([]);
  });

  it("handles a single tile by filling the box", () => {
    const [tile] = squarify([{ key: "a", label: "", value: 1 }], 0, 0, 100, 50);
    expect(tile.width).toBeCloseTo(100);
    expect(tile.height).toBeCloseTo(50);
  });
});

describe("formatting", () => {
  it("only compacts once the digits stop fitting", () => {
    // "1.2k" is less legible than "1200" at four digits.
    expect(compactNumber(1200)).toBe("1200");
    expect(compactNumber(12_000)).toBe("12k");
    expect(compactNumber(2_400_000)).toBe("2.4M");
    expect(compactNumber(7)).toBe("7");
    expect(compactNumber(7.25)).toBe("7.3");
  });

  it("says so when there is no number", () => {
    expect(compactNumber(NaN)).toBe("—");
    expect(formatValue(Infinity, "count")).toBe("—");
  });

  it("carries the unit", () => {
    expect(formatValue(62.4, "percent")).toBe("62%");
    expect(formatValue(3.25, "hours")).toBe("3.3h");
    expect(formatValue(13, "points")).toBe("13 pts");
    expect(formatValue(12_000, "currency")).toBe("$12k");
    expect(formatValue(9, "count")).toBe("9");
  });
});

describe("label stride", () => {
  it("thins labels so sixty buckets do not smear", () => {
    expect(labelStride(60, 300)).toBeGreaterThan(1);
    expect(labelStride(6, 300)).toBe(1);
  });

  it("shows every label when there is room, whatever the count", () => {
    // The same sixty buckets are perfectly readable on a wide panel.
    expect(labelStride(60, 3000)).toBe(1);
  });

  it("never returns zero or a negative stride", () => {
    for (const [n, w] of [
      [0, 0],
      [10, 0],
      [0, 100],
      [-5, -5],
    ] as const) {
      expect(labelStride(n, w)).toBeGreaterThanOrEqual(1);
    }
  });
});
