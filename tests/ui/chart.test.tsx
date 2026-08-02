import { describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import {
  Chart,
  xKindOf,
  type ChartKind,
  type ChartSeries,
} from "@/components/charts/operate/chart";
import {
  DEFAULT_STYLE,
  STYLE_PRESETS,
  normalizeStylePatch,
  paletteColors,
  type ComponentStyle,
} from "@/lib/component-style";

// The chart renderer.
//
// The shapes are the vendored @bklit library now, so what these tests are for
// has changed. They are not about geometry — that is upstream's, and it has its
// own. They are about the seam: the shaping this repo does on the way in, the
// style axes it claims to map, and the two failure modes that both look like
// "no data yet" to a reader — a chart that renders no marks at all, and a
// chart whose axis labels are not the thing it is grouped by.
//
// Assertions wait, because the library measures its container before drawing
// anything. `tests/ui/setup.ts` gives jsdom a plausible box; without it every
// one of these would pass against an empty SVG, which is precisely the vacuous
// test this file exists to not be.

const KINDS: ChartKind[] = [
  "bar",
  "column",
  "line",
  "area",
  "donut",
  "pie",
  "radial",
  "rings",
  "funnel",
  "radar",
  "heatmap",
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
      { key: "todo", label: "Mon", value: 4 },
      { key: "doing", label: "Tue", value: 7 },
      { key: "review", label: "Wed", value: 2 },
      { key: "done", label: "Thu", value: 9 },
    ],
  },
];

const TWO_SERIES: ChartSeries[] = [
  SERIES[0],
  {
    key: "b",
    label: "Done",
    points: [
      { key: "todo", label: "Mon", value: 2 },
      { key: "doing", label: "Tue", value: 3 },
      { key: "review", label: "Wed", value: 5 },
      { key: "done", label: "Thu", value: 1 },
    ],
  },
];

/** What the resolver emits for a temporal dimension: epoch key, blank label. */
const TEMPORAL: ChartSeries[] = [
  {
    key: "a",
    label: "Tasks",
    points: [0, 1, 2, 3].map((i) => ({
      key: String(Date.UTC(2025, 0, 1) + i * 86_400_000),
      label: "",
      value: i + 2,
    })),
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
  return container.querySelectorAll("path, circle, rect, line, polygon").length;
}

/** Wait until the container has drawn, then hand it back. */
async function drawn(container: HTMLElement, kind: string) {
  await waitFor(
    () => {
      expect(markCount(container), kind).toBeGreaterThan(0);
    },
    { timeout: 3000 },
  );
  return container;
}

/**
 * The words in the axis strip, once they have arrived.
 *
 * A tick's position comes from the chart's own scale, which means it is
 * reported out of an effect — one commit after the marks appear. Imperceptible
 * in a browser (the effect runs before paint); worth waiting for here.
 */
async function axisLabels(container: HTMLElement, kind: string) {
  await waitFor(() => {
    expect(container.querySelectorAll("div.mt-1 > span").length, kind).toBeGreaterThan(0);
  });
  return [...container.querySelectorAll("div.mt-1 > span")].map(
    (el) => el.textContent ?? "",
  );
}

/** No coordinate may be NaN — an SVG with one renders nothing, silently. */
function expectNoNaN(container: HTMLElement, kind: string) {
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

describe("every kind draws something", () => {
  it("renders marks for real data", async () => {
    for (const kind of KINDS) {
      await drawn(draw(kind), kind);
    }
  });

  it("never emits NaN into a coordinate", async () => {
    for (const kind of KINDS) {
      expectNoNaN(await drawn(draw(kind), kind), kind);
    }
  });

  it("carries an accessible name in place of the graphic", () => {
    for (const kind of KINDS) {
      const named = draw(kind).querySelector('[role="img"]');
      expect(named, kind).not.toBeNull();
      expect(named!.getAttribute("aria-label"), kind).toBe("Test");
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

  it("says so when the series exist but hold no points", () => {
    // Distinct from no series at all: a query that matched nothing still
    // returns the series it would have filled.
    const { container } = render(
      <Chart
        kind="column"
        series={[{ key: "a", label: "Open", points: [] }]}
        style={DEFAULT_STYLE}
        unit="count"
      />,
    );
    expect(container.textContent).toContain("Nothing to chart");
  });

  it("survives a single reading", async () => {
    // A line through one point, a band over one band, a funnel of one stage —
    // each is a division by zero waiting to happen.
    const one: ChartSeries[] = [
      { key: "a", label: "Open", points: [{ key: "1", label: "Mon", value: 3 }] },
    ];
    for (const kind of KINDS) {
      expectNoNaN(await drawn(draw(kind, one), kind), kind);
    }
  });

  it("survives a Monday morning of all zeroes", async () => {
    // The most common shape on a fresh account, and where a divide-by-total
    // silently produces NaN.
    const zeroes: ChartSeries[] = [
      {
        key: "a",
        label: "Open",
        points: SERIES[0].points.map((p) => ({ ...p, value: 0 })),
      },
    ];
    for (const kind of KINDS) {
      expectNoNaN(draw(kind, zeroes), kind);
    }
  });

  it("survives negative values", async () => {
    const mixed: ChartSeries[] = [
      {
        key: "a",
        label: "Delta",
        points: [
          { key: "1", label: "Mon", value: -4 },
          { key: "2", label: "Tue", value: 6 },
          { key: "3", label: "Wed", value: -2 },
        ],
      },
    ];
    for (const kind of KINDS) {
      expectNoNaN(draw(kind, mixed), kind);
    }
  });

  it("survives a breakdown series shorter than the first", async () => {
    // Breakdowns are sparse: a status nobody used produces fewer points.
    const ragged: ChartSeries[] = [
      SERIES[0],
      { key: "b", label: "Done", points: [SERIES[0].points[0]] },
    ];
    for (const kind of KINDS) {
      expectNoNaN(draw(kind, ragged), kind);
    }
  });
});

describe("what the x axis says", () => {
  it("labels a categorical chart with its categories", async () => {
    // The failure this exists for: the library's own axis formats instants, so
    // a status breakdown handed to it prints dates under "In progress".
    for (const kind of ["column", "bar", "line", "area"] as ChartKind[]) {
      const container = await drawn(draw(kind), kind);
      await waitFor(() => expect(container.textContent, kind).toContain("Mon"));
      expect(container.textContent, kind).not.toMatch(/\b(Jan|Feb|Dec)\b/);
    }
  });

  it("reads epoch-keyed, label-less points as time", () => {
    expect(xKindOf(TEMPORAL)).toBe("time");
  });

  it("reads anything carrying a label as a category", () => {
    expect(xKindOf(SERIES)).toBe("category");
    // Including one whose key happens to look numeric — the label is part of
    // the test precisely so a list named "2025" is not mistaken for a date.
    expect(
      xKindOf([
        {
          key: "a",
          label: "x",
          points: [{ key: "1735689600000", label: "2025", value: 1 }],
        },
      ]),
    ).toBe("category");
  });

  it("reads an empty series as a category rather than throwing", () => {
    expect(xKindOf([])).toBe("category");
  });

  it("labels a temporal chart from the same strip as a categorical one", async () => {
    // The resolver blanks temporal labels on purpose, because formatting an
    // instant is the renderer's job — so the strip has to do that job rather
    // than print nothing. It used to hand temporal charts to the vendored
    // `XAxis` instead, which is a second typography in a second place: the
    // labels sat on top of the marks, and two cards in one row looked like two
    // products.
    const container = await drawn(draw("line", TEMPORAL), "line");
    const labels = await axisLabels(container, "line");
    for (const label of labels) {
      expect(label.trim()).not.toBe("");
      // A formatted instant, never the epoch it was stored as.
      expect(label).not.toMatch(/^\d{10,}$/);
    }
    // And the strip IS there for a categorical one, so the assertion above is
    // about the dimension rather than about the shape never having a strip.
    const categorical = await drawn(draw("line", SERIES), "line");
    expect((await axisLabels(categorical, "line")).length).toBeGreaterThan(0);
  });

  it("draws exactly one axis, so no chart carries two sets of labels", async () => {
    // `text-chart-label` is the vendored `XAxis`'s own class. Its presence
    // anywhere means a second row of dates has been portaled into the plot,
    // which is how the scatter ended up with its dots and its dates on the
    // same pixels.
    for (const kind of ["line", "area", "scatter", "column"] as ChartKind[]) {
      const container = await drawn(draw(kind, TEMPORAL), kind);
      expect((await axisLabels(container, kind)).length).toBeGreaterThan(0);
      expect(
        container.querySelectorAll(".text-chart-label").length,
        kind,
      ).toBe(0);
    }
  });
});

describe("zero is a value, not an absence", () => {
  /** A week with three quiet days — the shape that used to punch holes. */
  const WITH_ZEROS: ChartSeries[] = [
    {
      key: "a",
      label: "Done",
      points: [
        { key: "mon", label: "Mon", value: 12 },
        { key: "tue", label: "Tue", value: 0 },
        { key: "wed", label: "Wed", value: 7 },
        { key: "thu", label: "Thu", value: 0 },
      ],
    },
  ];

  /** Marks painted in the series' own colour — the bars and nothing else. */
  function inkedRects(container: HTMLElement): Element[] {
    const fill = paletteColors("mono")[0];
    return [...container.querySelectorAll("rect")].filter(
      (el) => el.getAttribute("fill") === fill,
    );
  }

  it("draws a column for a zero bucket", async () => {
    // A hole between two columns reads as a chart that failed to load, not as
    // a day when nothing happened — and the reader's next move is to distrust
    // the whole panel rather than to learn something from it.
    const container = await drawn(draw("column", WITH_ZEROS), "column");
    expect(inkedRects(container).length).toBe(WITH_ZEROS[0].points.length);
  });

  it("draws a mark for a zero bar, which the library will not", async () => {
    // The library's own floor (`<Bar minBarHeight>`) lives in the vertical
    // branch of its geometry only, so bars that run across need ours.
    const container = await drawn(draw("bar", WITH_ZEROS), "bar");
    expect(
      container.querySelectorAll("g.operate-zero-marks rect").length,
    ).toBe(2);
  });
});

describe("two charts on one page are two charts", () => {
  it("gives every reveal clip its own id", async () => {
    // SVG `url(#…)` resolves against the document, so a clip id that is a
    // constant is shared by every chart of that kind on the page — and the
    // first in document order wins. Two panels side by side clipped the wider
    // one to the narrower one's plot: a six-status line stopped after four
    // statuses with nothing on screen to say the rest existed. Nothing looks
    // more like working software than a chart that is quietly missing its end.
    const { container } = render(
      <>
        <div style={{ width: 300 }}>
          <Chart kind="line" series={SERIES} style={DEFAULT_STYLE} unit="count" />
          <Chart kind="area" series={SERIES} style={DEFAULT_STYLE} unit="count" />
        </div>
        <div style={{ width: 900 }}>
          <Chart kind="line" series={SERIES} style={DEFAULT_STYLE} unit="count" />
          <Chart kind="area" series={SERIES} style={DEFAULT_STYLE} unit="count" />
        </div>
      </>,
    );
    await waitFor(() => {
      expect(container.querySelectorAll("clipPath").length).toBeGreaterThan(1);
    });
    const ids = [...container.querySelectorAll("clipPath")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the style axes reach the marks", () => {
  it("draws series in the chosen palette", async () => {
    for (const palette of ["mono", "pastel", "ocean"] as const) {
      const style = { ...DEFAULT_STYLE, palette };
      const container = await drawn(draw("column", SERIES, style), palette);
      const fills = [...container.querySelectorAll("[fill]")]
        .map((el) => el.getAttribute("fill"))
        .join(" ");
      expect(fills, palette).toContain(paletteColors(palette)[0]);
    }
  });

  it("gives a second series a different colour from the first", async () => {
    const style = { ...DEFAULT_STYLE, palette: "ocean" as const };
    const container = await drawn(draw("column", TWO_SERIES, style), "two");
    const fills = [...container.querySelectorAll("[fill]")]
      .map((el) => el.getAttribute("fill"))
      .join(" ");
    expect(fills).toContain(paletteColors("ocean")[0]);
    expect(fills).toContain(paletteColors("ocean")[1]);
  });

  it("shows a legend only when asked, and only past one series", async () => {
    const withLegend = { ...DEFAULT_STYLE, legend: "bottom" as const };
    expect(draw("column", SERIES, withLegend).textContent).not.toContain("Done");

    const two = draw("column", TWO_SERIES, withLegend);
    await waitFor(() => expect(two.textContent).toContain("Done"));

    expect(draw("column", TWO_SERIES, DEFAULT_STYLE).textContent).not.toContain(
      "Done",
    );
  });

  it("drops the grid when the style says no chrome", async () => {
    const bare = {
      ...DEFAULT_STYLE,
      grid: "none" as const,
      axes: "none" as const,
    };
    const container = await drawn(draw("column", SERIES, bare), "bare");
    expect(container.querySelector(".chart-grid")).toBeNull();
  });

  it("draws the grid when the style asks for it", async () => {
    const ruled = { ...DEFAULT_STYLE, grid: "horizontal" as const };
    const container = await drawn(draw("column", SERIES, ruled), "ruled");
    await waitFor(() =>
      expect(container.querySelector(".chart-grid")).not.toBeNull(),
    );
  });

  it("stacks when told to and lines them up side by side otherwise", async () => {
    const xs = async (stackMode: "stacked" | "grouped") => {
      const style = { ...DEFAULT_STYLE, stackMode };
      const container = await drawn(draw("column", TWO_SERIES, style), stackMode);
      return [...container.querySelectorAll("g[class^='bar-series'] rect")].map(
        (el) =>
          (el.getAttribute("style") ?? "").match(/translateX\(([\d.]+)/)?.[1],
      );
    };
    // Two series over four categories: stacked shares an x per category (4
    // distinct), grouped puts them beside each other (8 distinct).
    expect(new Set(await xs("stacked")).size).toBe(4);
    expect(new Set(await xs("grouped")).size).toBe(8);
  });
});

describe("the style presets", () => {
  it("draws every kind without throwing", () => {
    for (const preset of STYLE_PRESETS) {
      const style = {
        ...DEFAULT_STYLE,
        ...normalizeStylePatch(preset.patch),
      } as ComponentStyle;
      for (const kind of KINDS) {
        expect(
          () => draw(kind, TWO_SERIES, style),
          `${preset.id} ${kind}`,
        ).not.toThrow();
      }
    }
  });
});
