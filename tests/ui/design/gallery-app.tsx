import { createRoot } from "react-dom/client";
import { Chart, type ChartKind } from "@/components/charts/operate/chart";
import {
  DEFAULT_STYLE,
  STYLE_PRESETS,
  normalizeStyle,
  normalizeStylePatch,
  STYLE_ENUMS,
  type Palette,
} from "@/lib/component-style";

// A gallery I can actually look at.
//
// This exists because of a failure in how this project was worked on: for
// weeks the charts were verified by tests and never once seen. jsdom can tell
// you an `<svg>` has eleven `<rect>`s. It cannot tell you the bars overlap,
// the palette is garish, or the whole thing looks cheap — which are the only
// questions that matter about a chart.
//
// **It is a real page, not a snapshot.** The charts measure their container
// before they draw anything, so a server-rendered string of them is a string
// of empty boxes — a harness that would have reported everything fine no
// matter what shipped. So this mounts and hydrates in a real browser, which
// also means the entrance animations, the hover states and the dark theme are
// all reachable. `npm run gallery`.

const SERIES = [
  {
    key: "a",
    label: "Ada",
    points: [
      { key: "mon", label: "Mon", value: 12 },
      { key: "tue", label: "Tue", value: 19 },
      { key: "wed", label: "Wed", value: 7 },
      { key: "thu", label: "Thu", value: 24 },
      { key: "fri", label: "Fri", value: 16 },
      { key: "sat", label: "Sat", value: 4 },
    ],
  },
  {
    key: "b",
    label: "Grace",
    points: [
      { key: "mon", label: "Mon", value: 8 },
      { key: "tue", label: "Tue", value: 11 },
      { key: "wed", label: "Wed", value: 15 },
      { key: "thu", label: "Thu", value: 9 },
      { key: "fri", label: "Fri", value: 21 },
      { key: "sat", label: "Sat", value: 13 },
    ],
  },
];

/** The other half of the vocabulary: buckets keyed by instant, label-less. */
const TEMPORAL = [
  {
    key: "a",
    label: "Created",
    points: Array.from({ length: 14 }, (_, i) => ({
      key: String(Date.UTC(2025, 5, 1) + i * 86_400_000),
      label: "",
      value: 4 + Math.round(8 * Math.sin(i / 2.2) + i / 3),
    })),
  },
];

const KINDS: ChartKind[] = [
  "bar",
  "column",
  "line",
  "area",
  "scatter",
  "sparkline",
  "donut",
  "pie",
  "radial",
  "rings",
  "funnel",
  "radar",
  "heatmap",
  "waterfall",
  "treemap",
];

function Cell({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div className="cell">
      <div className="cap">{caption}</div>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <h2>{title}</h2>
      <div className="grid">{children}</div>
    </>
  );
}

function Gallery() {
  return (
    <>
      <h1>Charts</h1>

      <Section title="Every kind, default style, categorical">
        {KINDS.map((kind) => (
          <Cell caption={kind} key={kind}>
            <Chart
              height={150}
              kind={kind}
              label={kind}
              series={SERIES}
              style={DEFAULT_STYLE}
              unit="count"
            />
          </Cell>
        ))}
      </Section>

      <Section title="Over time — the library's own date axis">
        {(["line", "area", "column", "scatter"] as ChartKind[]).map((kind) => (
          <Cell caption={`${kind} · 14 days`} key={kind}>
            <Chart
              height={150}
              kind={kind}
              label={kind}
              series={TEMPORAL}
              style={DEFAULT_STYLE}
              unit="count"
            />
          </Cell>
        ))}
      </Section>

      <Section title="Every palette, grouped columns">
        {(STYLE_ENUMS.palette as readonly Palette[]).map((palette) => (
          <Cell caption={palette} key={palette}>
            <Chart
              height={140}
              kind="column"
              label={palette}
              series={SERIES}
              style={normalizeStyle({ palette, stackMode: "grouped", legend: "bottom" })}
              unit="count"
            />
          </Cell>
        ))}
      </Section>

      <Section title="Every preset">
        {STYLE_PRESETS.map((preset) => (
          <Cell caption={preset.name} key={preset.id}>
            <Chart
              height={140}
              kind="column"
              label={preset.name}
              series={SERIES}
              style={{ ...DEFAULT_STYLE, ...normalizeStylePatch(preset.patch) }}
              unit="count"
            />
          </Cell>
        ))}
      </Section>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Gallery />);
