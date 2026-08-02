import { createRoot } from "react-dom/client";
import { AppearanceProvider } from "@/components/appearance/appearance-provider";
import { ToastProvider } from "@/components/toast";
import { Panel } from "@/components/dashboard/panel";
import { ALL_SHAPES, type PanelShape } from "@/lib/panel";
import { galleryData } from "./stubs/convex-react";

// Every shape the one renderer draws, in every box the packer can hand it.
//
// The two defects this page was built for were both the same mistake — a
// shape laying out at its natural size and letting the box crop the
// difference — and both were invisible in a downscaled full-page shot. They
// were also invisible on Home, because Home only ever holds four of the
// nineteen shapes and only ever at two of the nine sizes. A gate that can only
// see the shapes somebody happened to put on a demo screen is a gate with
// silent holes in its coverage, which is the failure the rubric calls out by
// name.
//
// So: the full cross product. Nineteen shapes × the boxes the grid actually
// produces. The boxes are stated in pixels rather than composed through
// `EditableGrid`, on purpose — the question here is "does a panel survive the
// box it was given", and the grid's own geometry is proven elsewhere
// (`tests/pack.test.ts`, `scripts/verify-resize.mjs`). Rendering through it
// would make a packing regression look like a panel regression.
//
// The numbers are the grid's own: one row is `10.5rem` (168px) and the gap is
// `1.5rem` (24px), so a two-row tile is 360 and a three-row tile is 552. The
// widths are one, two and three columns of a 1180px dashboard inset, plus the
// single column a 390px phone gives — which is the narrowest box that exists
// and therefore the one every clipping bug lives in.

/** `[width, label]` — every column count the grid draws, at both viewports. */
const WIDTHS: [number, string][] = [
  [358, "phone-1col"],
  [276, "desktop-1col"],
  [576, "desktop-2col"],
  [876, "desktop-3col"],
];

/** `[height, label]` — one, two and three grid rows. */
const HEIGHTS: [number, string][] = [
  [168, "1row"],
  [360, "2row"],
  [552, "3row"],
];

const DAY = 86_400_000;
const now = Date.now();

/**
 * Rows, series and a scalar in one envelope — the same object the resolver
 * returns, so the shapes read exactly what they read in the product.
 *
 * Deliberately awkward: eleven buckets (more than a short chart has rows for),
 * long titles, a zero, and a label nobody would call short. Equal-sized tidy
 * fixtures cannot express the bugs that happen.
 */
const ROWS = Array.from({ length: 11 }, (_, i) => ({
  id: `t${i}`,
  title:
    i % 3 === 0
      ? "Reconcile the September ledger against the Stripe payout report"
      : `Task ${i + 1}`,
  href: `/dashboard/l/l1/t/t${i}`,
  meta: {
    status: i % 2 === 0 ? "In progress" : "Needs review",
    assignee: i % 4,
    due: now + (i - 5) * DAY,
    updated: now - i * DAY,
    value: i * 7,
  },
}));

const SERIES = [
  {
    key: "a",
    label: "Katherine Johnson",
    points: Array.from({ length: 11 }, (_, i) => ({
      key: String(Date.UTC(2025, 5, 1) + i * DAY),
      label: "",
      value: i === 4 ? 0 : 3 + Math.round(9 * Math.abs(Math.sin(i / 2))),
    })),
  },
  {
    key: "b",
    label: "Grace Hopper",
    points: Array.from({ length: 11 }, (_, i) => ({
      key: String(Date.UTC(2025, 5, 1) + i * DAY),
      label: "",
      value: 2 + ((i * 5) % 11),
    })),
  },
];

/** The categorical half of the vocabulary — names, not instants. */
const CATEGORIES = [
  {
    key: "a",
    label: "Open",
    points: [
      { key: "todo", label: "To do", value: 12 },
      { key: "wip", label: "In progress", value: 19 },
      { key: "review", label: "Needs review", value: 0 },
      { key: "blocked", label: "Blocked on someone else", value: 6 },
      { key: "done", label: "Complete", value: 24 },
    ],
  },
];

galleryData["dataStream.resolve"] = (args: unknown) => {
  const shape = (args as { query?: { from?: string } })?.query?.from ?? "";
  const series = shape === "categorical" ? CATEGORIES : SERIES;
  return {
    rows: ROWS,
    series,
    scalar: 4917,
    total: 41,
    truncated: false,
    meta: { unit: "count", dimensionLabel: "day", measureLabel: "tasks" },
  };
};
galleryData["calibration.forScope"] = [];
galleryData["appearance.forCurrentUser"] = null;
galleryData["appearance.resolvedForCurrentUser"] = null;
galleryData["uiComponents.forScope"] = [];

/**
 * One shape in one box.
 *
 * `data-fit-tile` is what the gate measures against: everything the panel
 * paints has to stay inside it, exactly as everything a real tile holds has to
 * stay inside the tile.
 *
 * `overflow: auto` because that is what a real tile is (`[data-tile-inner]` in
 * `screen/editable-grid`), and the harness has to be the shell that ships
 * rather than a stricter one. The difference matters in both directions: with
 * `visible` a defect would paint over its neighbour instead of being cut, and
 * the gate would be reading a different failure; with `hidden` every list of
 * eleven rows in a one-row tile would report as clipped, when scrolling is
 * exactly how a list is meant to work there.
 */
function Tile({
  shape,
  width,
  height,
  id,
}: {
  shape: PanelShape;
  width: number;
  height: number;
  id: string;
}) {
  return (
    <div
      data-fit-tile={id}
      data-shape={shape}
      style={{ width, height, flex: "0 0 auto", overflow: "auto" }}
    >
      <Panel
        definition={{
          title: `${shape} — a title long enough to need the room`,
          shape,
          query: { from: shape === "bar" ? "categorical" : "tasks", limit: 11 },
          fields: ["status", "assignee", "due"],
          caption: "",
          style: {},
        }}
        scopeType="user"
        scopeId="u1"
        panelId={id}
      />
    </div>
  );
}

/**
 * The three defects, on purpose, so the instrument can be shown catching them.
 *
 * A gate that has never fired on a known defect cannot report its absence —
 * and this project has already had an auditor return a clean result on a
 * surface with a defect documented twice. The calibration is therefore part of
 * the page rather than a fixture kept somewhere else: a broken copy that has
 * to be maintained separately drifts away from the real one, and the day it
 * does, the calibration passes while testing nothing.
 *
 *   `?break=clip` — a chart at a constant height inside a smaller box, in a
 *   tile that SCROLLS, which is exactly the shape of the shipped defect: the
 *   holder could technically be scrolled and nobody ever did. The first
 *   version of the gate forgave this and reported the page clean.
 *
 *   `?break=cut` — text past a boundary that cannot be scrolled at all, which
 *   is the table losing its last column.
 *
 *   `?break=ink` — a mark filled from a custom property nothing defines. Not a
 *   hardcoded black: the point is that an undefined property is not a
 *   fallback, it is an invalid value that resolves to SVG's initial black, and
 *   the gate has to catch the real mechanism rather than a stand-in for it.
 */
const BREAK = new URLSearchParams(location.search).get("break");

function Broken() {
  if (BREAK === "clip") {
    return (
      <div className="row">
        <div
          data-fit-tile="broken/clip"
          style={{ width: 276, height: 90, flex: "0 0 auto", overflow: "auto" }}
        >
          <div className="bento rounded-2xl bg-card p-3">
            <p className="text-sm">Recent activity</p>
            <p className="text-4xl">4917</p>
            {/* A chart that laid itself out at a constant, the way `Panel`
                asked for 132px of chart in whatever room was left. */}
            <div aria-label="Completions over time" role="img" style={{ height: 132 }}>
              <svg height={132} width={240}>
                <rect fill="#555" height={100} width={30} x={10} y={20} />
              </svg>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (BREAK === "cut") {
    return (
      <div className="row">
        <div
          data-fit-tile="broken/cut"
          style={{ width: 200, height: 90, flex: "0 0 auto", overflow: "hidden" }}
        >
          <div className="bento h-full rounded-2xl bg-card p-3">
            <table style={{ width: 420 }}>
              <tbody>
                <tr>
                  <td style={{ width: 340 }}>Billing migration</td>
                  <td>At risk</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }
  if (BREAK === "ink") {
    return (
      <div className="row">
        <div
          data-fit-tile="broken/ink"
          style={{ width: 276, height: 168, flex: "0 0 auto", overflow: "hidden" }}
        >
          <div className="bento h-full rounded-2xl bg-card p-3">
            <svg height={120} width={240}>
              <rect fill="var(--a-token-nothing-defines)" height={80} width={40} x={10} y={20} />
              <rect fill="var(--a-token-nothing-defines)" height={60} width={40} x={70} y={40} />
            </svg>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

function Page() {
  return (
    <ToastProvider>
      <AppearanceProvider>
        <Broken />
        {ALL_SHAPES.map((shape) => (
          <section key={shape}>
            <p className="cap">{shape}</p>
            {HEIGHTS.map(([height, hLabel]) => (
              <div className="row" key={hLabel}>
                {WIDTHS.map(([width, wLabel]) => (
                  <Tile
                    height={height}
                    id={`${shape}/${wLabel}/${hLabel}`}
                    key={wLabel}
                    shape={shape}
                    width={width}
                  />
                ))}
              </div>
            ))}
          </section>
        ))}
      </AppearanceProvider>
    </ToastProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
