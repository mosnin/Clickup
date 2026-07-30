import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Chart, type ChartKind, type ChartSeries } from "@/components/charts/chart";
import {
  DEFAULT_STYLE,
  STYLE_PRESETS,
  normalizeStylePatch,
  type ComponentStyle,
} from "@/lib/component-style";

// The chart components.
//
// The geometry is tested exhaustively in tests/chart-math. What is left to go
// wrong here is assembly: a chart that renders no marks at all, one that
// crashes on the shapes a real dashboard produces (one point, all zeroes,
// nothing), or a style option that silently does nothing. Every one of those
// looks like an empty panel, which looks like "no data yet".

const KINDS: ChartKind[] = [
  "bar",
  "column",
  "line",
  "area",
  "donut",
  "pie",
  "radial",
  "scatter",
  "waterfall",
  "treemap",
  "sparkline",
];

const SERIES: ChartSeries[] = [
  {
    key: "a",
    label: "Open",
    points: [
      { key: "1", label: "Mon", value: 4 },
      { key: "2", label: "Tue", value: 7 },
      { key: "3", label: "Wed", value: 2 },
      { key: "4", label: "Thu", value: 9 },
    ],
  },
];

const TWO_SERIES: ChartSeries[] = [
  SERIES[0],
  {
    key: "b",
    label: "Done",
    points: [
      { key: "1", label: "Mon", value: 2 },
      { key: "2", label: "Tue", value: 3 },
      { key: "3", label: "Wed", value: 5 },
      { key: "4", label: "Thu", value: 1 },
    ],
  },
];

function draw(
  kind: ChartKind,
  series = SERIES,
  style: ComponentStyle = DEFAULT_STYLE,
) {
  const { container } = render(
    <Chart kind={kind} series={series} style={style} unit="count" label="Test" />,
  );
  return container;
}

/** Anything that actually puts ink on the chart. */
function markCount(container: HTMLElement): number {
  return container.querySelectorAll("path, circle, rect, line").length;
}

describe("every kind draws something", () => {
  it("renders marks for real data", () => {
    for (const kind of KINDS) {
      const container = draw(kind);
      expect(container.querySelector("svg"), kind).not.toBeNull();
      expect(markCount(container), kind).toBeGreaterThan(0);
    }
  });

  it("never emits NaN into path data", () => {
    // An SVG path containing NaN renders as nothing at all, silently.
    for (const kind of KINDS) {
      const container = draw(kind);
      for (const path of container.querySelectorAll("path")) {
        expect(path.getAttribute("d") ?? "", kind).not.toContain("NaN");
      }
      for (const el of container.querySelectorAll("circle, rect, line")) {
        for (const attr of ["cx", "cy", "r", "x", "y", "x1", "y1", "x2", "y2"]) {
          const value = el.getAttribute(attr);
          if (value !== null) expect(value, `${kind} ${attr}`).not.toBe("NaN");
        }
      }
    }
  });

  it("carries an accessible name in place of the graphic", () => {
    for (const kind of KINDS) {
      const svg = draw(kind).querySelector("svg")!;
      expect(svg.getAttribute("role"), kind).toBe("img");
      expect(svg.getAttribute("aria-label"), kind).toBe("Test");
    }
  });
});

describe("the shapes a real dashboard produces", () => {
  it("says so rather than drawing an empty box when there is nothing", () => {
    for (const kind of KINDS) {
      const { container } = render(
        <Chart kind={kind} series={[]} style={DEFAULT_STYLE} unit="count" />,
      );
      expect(container.textContent, kind).toContain("Nothing to chart");
    }
  });

  it("survives a single reading", () => {
    // A line through one point, a band scale over one band, a pie with one
    // slice — each is a division-by-zero waiting to happen.
    const one: ChartSeries[] = [
      { key: "a", label: "Open", points: [{ key: "1", label: "Mon", value: 3 }] },
    ];
    for (const kind of KINDS) {
      const container = draw(kind, one);
      expect(markCount(container), kind).toBeGreaterThan(0);
      for (const path of container.querySelectorAll("path")) {
        expect(path.getAttribute("d") ?? "", kind).not.toContain("NaN");
      }
    }
  });

  it("survives a Monday morning of all zeroes", () => {
    const zeroes: ChartSeries[] = [
      {
        key: "a",
        label: "Open",
        points: [
          { key: "1", label: "Mon", value: 0 },
          { key: "2", label: "Tue", value: 0 },
        ],
      },
    ];
    for (const kind of KINDS) {
      const container = draw(kind, zeroes);
      expect(() => container.querySelectorAll("path"), kind).not.toThrow();
      for (const path of container.querySelectorAll("path")) {
        expect(path.getAttribute("d") ?? "", kind).not.toContain("NaN");
      }
    }
  });

  it("survives negative values", () => {
    const mixed: ChartSeries[] = [
      {
        key: "a",
        label: "Delta",
        points: [
          { key: "1", label: "Mon", value: 5 },
          { key: "2", label: "Tue", value: -3 },
          { key: "3", label: "Wed", value: 2 },
        ],
      },
    ];
    for (const kind of KINDS) {
      const container = draw(kind, mixed);
      for (const path of container.querySelectorAll("path")) {
        expect(path.getAttribute("d") ?? "", kind).not.toContain("NaN");
      }
    }
  });
});

describe("style options change what is drawn", () => {
  const withStyle = (patch: Partial<ComponentStyle>): ComponentStyle => ({
    ...DEFAULT_STYLE,
    ...normalizeStylePatch(patch),
  });

  it("draws axis labels only when axes are asked for", () => {
    const none = draw("column", SERIES, withStyle({ axes: "none" }));
    const both = draw("column", SERIES, withStyle({ axes: "both" }));
    expect(none.querySelectorAll("text").length).toBeLessThan(
      both.querySelectorAll("text").length,
    );
  });

  it("draws gridlines only when the grid is asked for", () => {
    const off = draw("column", SERIES, withStyle({ grid: "none" }));
    const on = draw("column", SERIES, withStyle({ grid: "horizontal" }));
    expect(on.querySelectorAll("line").length).toBeGreaterThan(
      off.querySelectorAll("line").length,
    );
  });

  it("draws data labels only when asked", () => {
    const off = draw("column", SERIES, withStyle({ dataLabels: "none", axes: "none" }));
    const on = draw("column", SERIES, withStyle({ dataLabels: "value", axes: "none" }));
    expect(on.querySelectorAll("text").length).toBeGreaterThan(
      off.querySelectorAll("text").length,
    );
  });

  it("draws markers on a line only when asked", () => {
    const off = draw("line", SERIES, withStyle({ markers: "none" }));
    const on = draw("line", SERIES, withStyle({ markers: "dot" }));
    expect(on.querySelectorAll("circle").length).toBeGreaterThan(
      off.querySelectorAll("circle").length,
    );
  });

  it("strokes rather than fills in outline mode", () => {
    const solid = draw("column", SERIES, withStyle({ chartFill: "solid" }));
    const outline = draw("column", SERIES, withStyle({ chartFill: "outline" }));
    const filled = [...solid.querySelectorAll("path")].filter(
      (p) => p.getAttribute("fill") !== "none",
    );
    const stroked = [...outline.querySelectorAll("path")].filter(
      (p) => p.getAttribute("fill") === "none",
    );
    expect(filled.length).toBeGreaterThan(0);
    expect(stroked.length).toBeGreaterThan(0);
  });

  it("changes the curve a line takes", () => {
    const d = (curve: "linear" | "smooth" | "step") =>
      draw("line", SERIES, withStyle({ curve }))
        .querySelector("path[fill='none']")!
        .getAttribute("d")!;
    expect(d("linear")).toContain("L");
    expect(d("smooth")).toContain("C");
    expect(d("step")).toContain("H");
    expect(d("linear")).not.toBe(d("smooth"));
  });

  it("shows a legend only for more than one series", () => {
    const one = draw("column", SERIES, withStyle({ legend: "bottom" }));
    const two = draw("column", TWO_SERIES, withStyle({ legend: "bottom" }));
    expect(one.querySelectorAll("li")).toHaveLength(0);
    expect(two.querySelectorAll("li")).toHaveLength(2);
  });

  it("hollows a donut and fills a pie", () => {
    const pie = draw("pie", SERIES);
    const donut = draw("donut", SERIES);
    // A pie's wedges pass through the centre; a donut's do not.
    const pieFirst = pie.querySelector("path")!.getAttribute("d")!;
    const donutFirst = donut.querySelector("path")!.getAttribute("d")!;
    expect(pieFirst).not.toBe(donutFirst);
  });

  it("renders every preset without throwing or producing NaN", () => {
    // The presets are the range this system claims to have. If one of them
    // cannot draw, the claim is false.
    for (const preset of STYLE_PRESETS) {
      const style = withStyle(preset.patch);
      for (const kind of KINDS) {
        const container = draw(kind, TWO_SERIES, style);
        expect(markCount(container), `${preset.id}/${kind}`).toBeGreaterThan(0);
        for (const path of container.querySelectorAll("path")) {
          expect(path.getAttribute("d") ?? "", `${preset.id}/${kind}`).not.toContain(
            "NaN",
          );
        }
      }
    }
  });
});

describe("stacking", () => {
  const stacked: ComponentStyle = { ...DEFAULT_STYLE, stackMode: "stacked" };
  const grouped: ComponentStyle = { ...DEFAULT_STYLE, stackMode: "grouped" };

  it("draws one mark per series per category either way", () => {
    for (const style of [stacked, grouped]) {
      const container = draw("column", TWO_SERIES, style);
      // 2 series x 4 categories.
      expect(container.querySelectorAll("g > path").length).toBeGreaterThanOrEqual(8);
    }
  });

  it("places grouped bars side by side and stacked bars in a column", () => {
    // Square corners, so a path's start point is exactly the bar's left edge.
    // With rounded ones it is inset by the radius, and the comparison would be
    // measuring the corner rather than the layout.
    const square = (mode: "stacked" | "grouped"): ComponentStyle => ({
      ...DEFAULT_STYLE,
      stackMode: mode,
      barShape: "square",
    });
    const xs = (style: ComponentStyle) =>
      [...draw("column", TWO_SERIES, style).querySelectorAll("path")]
        .map((p) => /M([\d.]+),/.exec(p.getAttribute("d") ?? "")?.[1])
        .filter(Boolean);

    // Two series over four categories: stacked shares an x per category (4
    // distinct), grouped puts them side by side (8 distinct).
    expect(new Set(xs(square("stacked"))).size).toBe(4);
    expect(new Set(xs(square("grouped"))).size).toBe(8);
  });
});
