import { createRoot } from "react-dom/client";
import { Chart, type ChartKind } from "@/components/charts/operate/chart";
import { DEFAULT_STYLE, normalizeStyle } from "@/lib/component-style";

// Axis labels, at the sizes and with the words that actually ship.
//
// The charts gallery used "Mon/Tue/Wed" in a 190px card, which is the easiest
// possible case and told me nothing. Real dimensions are statuses, people and
// lists — "In progress", "Needs review", "Ada Lovelace" — and real panels are
// one, two or three columns of a dashboard grid. This page is those two facts
// crossed, because a label that fits at 1100px and smears at 340px is a label
// that is broken on most screens.

const WIDTHS = [
  { label: "1 column · 340px", width: 340 },
  { label: "2 columns · 540px", width: 540 },
  { label: "3 columns · 1100px", width: 1100 },
];

const STATUSES = [
  "To do",
  "In progress",
  "Needs review",
  "Blocked",
  "Complete",
  "Closed",
];

const PEOPLE = [
  "Ada Lovelace",
  "Grace Hopper",
  "Katherine Johnson",
  "Radia Perlman",
  "Barbara Liskov",
];

function series(labels: string[], key = "a", label = "Tasks") {
  return [
    {
      key,
      label,
      points: labels.map((l, i) => ({
        key: l.toLowerCase().replace(/\s+/g, "_"),
        label: l,
        value: 4 + ((i * 7) % 19),
      })),
    },
  ];
}

/** Fourteen days of buckets, the way the resolver emits them. */
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

const CASES: { name: string; kind: ChartKind; data: ReturnType<typeof series> }[] =
  [
    { name: "by status", kind: "column", data: series(STATUSES) },
    { name: "by assignee", kind: "bar", data: series(PEOPLE) },
    { name: "by status · line", kind: "line", data: series(STATUSES) },
    { name: "by day · 14", kind: "column", data: TEMPORAL },
    { name: "by day · line", kind: "line", data: TEMPORAL },
  ];

function Page() {
  return (
    <>
      <h1>Axis labels</h1>
      <p className="note">
        Real dimension values at real panel widths. Anything cut off, smeared
        or overlapping here is broken in the product.
      </p>
      {WIDTHS.map((w) => (
        <section key={w.width}>
          <h2>{w.label}</h2>
          <div className="row">
            {CASES.map((c) => (
              <div className="cell" key={c.name} style={{ width: w.width }}>
                <div className="cap">{c.name}</div>
                <Chart
                  height={150}
                  kind={c.kind}
                  label={c.name}
                  series={c.data}
                  style={normalizeStyle({ ...DEFAULT_STYLE, axes: "x" })}
                  unit="count"
                />
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
