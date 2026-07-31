import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Chart, type ChartKind } from "@/components/charts/chart";
import {
  DEFAULT_STYLE,
  STYLE_PRESETS,
  normalizeStyle,
  normalizeStylePatch,
  type Palette,
  STYLE_ENUMS,
} from "@/lib/component-style";

// A gallery I can actually look at.
//
// This exists because of a failure in how this project has been worked on: for
// weeks the charts and panels were verified by tests and never once seen. jsdom
// can tell you an `<svg>` has eleven `<rect>`s. It cannot tell you the bars are
// too thin, the labels collide, the palette is muddy, or the whole thing looks
// cheap — and those are the only questions that matter about a chart.
//
// So this renders the real components to static HTML with the app's real
// compiled CSS, and a Playwright script screenshots it. Not a test of
// behaviour: a way to get eyes on the output. `npm run gallery`.

const OUT = "/tmp/design-gallery";

const SERIES = [
  {
    key: "a",
    label: "Ada",
    points: [
      { key: "1", label: "Mon", value: 12 },
      { key: "2", label: "Tue", value: 19 },
      { key: "3", label: "Wed", value: 7 },
      { key: "4", label: "Thu", value: 24 },
      { key: "5", label: "Fri", value: 16 },
      { key: "6", label: "Sat", value: 4 },
    ],
  },
  {
    key: "b",
    label: "Grace",
    points: [
      { key: "1", label: "Mon", value: 8 },
      { key: "2", label: "Tue", value: 11 },
      { key: "3", label: "Wed", value: 15 },
      { key: "4", label: "Thu", value: 9 },
      { key: "5", label: "Fri", value: 21 },
      { key: "6", label: "Sat", value: 13 },
    ],
  },
];

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

/** The app's compiled stylesheet, so what renders is what ships. */
function appCss(): string {
  const dir = join(process.cwd(), ".next/static/css");
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
  } catch {
    return "";
  }
}

function page(title: string, body: string, dark = false): string {
  return `<!doctype html>
<html lang="en"${dark ? ' class="dark"' : ""}>
<head><meta charset="utf-8"><title>${title}</title>
<style>${appCss()}</style>
<style>
  body { margin:0; padding:32px; background:var(--color-page,#f6f6f7); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:20px; }
  .cell { background:var(--color-card,#fff); border-radius:16px; padding:16px; }
  .cap { font-size:11px; letter-spacing:.06em; text-transform:uppercase; opacity:.5; margin-bottom:10px; }
  h2 { font-size:13px; letter-spacing:.08em; text-transform:uppercase; opacity:.45; margin:36px 0 14px; }
  h1 { font-size:20px; margin:0 0 4px; }
</style></head>
<body>${body}</body></html>`;
}

function section(title: string, cells: string[]): string {
  return `<h2>${title}</h2><div class="grid">${cells.join("")}</div>`;
}

function cell(caption: string, inner: string): string {
  return `<div class="cell"><div class="cap">${caption}</div>${inner}</div>`;
}

describe("design gallery", () => {
  it("writes every chart, palette and preset to HTML for a human to look at", () => {
    mkdirSync(OUT, { recursive: true });

    const kinds = KINDS.map((kind) =>
      cell(
        kind,
        renderToStaticMarkup(
          <Chart
            kind={kind}
            series={SERIES}
            style={DEFAULT_STYLE}
            unit="count"
            width={260}
            height={150}
            label={kind}
          />,
        ),
      ),
    );

    const palettes = (STYLE_ENUMS.palette as readonly Palette[]).map((palette) =>
      cell(
        palette,
        renderToStaticMarkup(
          <Chart
            kind="column"
            series={SERIES}
            style={normalizeStyle({ palette, stackMode: "grouped" })}
            unit="count"
            width={260}
            height={140}
            label={palette}
          />,
        ),
      ),
    );

    const presets = STYLE_PRESETS.map((preset) =>
      cell(
        preset.name,
        renderToStaticMarkup(
          <Chart
            kind="column"
            series={SERIES}
            style={{ ...DEFAULT_STYLE, ...normalizeStylePatch(preset.patch) }}
            unit="count"
            width={260}
            height={140}
            label={preset.name}
          />,
        ),
      ),
    );

    const body =
      `<h1>Charts</h1>` +
      section("Every kind, default style", kinds) +
      section("Every palette, grouped columns", palettes) +
      section("Every preset", presets);

    writeFileSync(join(OUT, "charts.html"), page("Charts", body));
    writeFileSync(join(OUT, "charts-dark.html"), page("Charts", body, true));

    // The assertion is thin on purpose. The value is the file; this only
    // guards against the generator silently producing nothing.
    expect(kinds.length).toBe(KINDS.length);
    expect(body.length).toBeGreaterThan(5000);
  });
});
