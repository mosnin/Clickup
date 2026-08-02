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
 * stay inside the tile. `overflow: hidden` because a real tile clips too —
 * without it a defect would paint over the neighbour instead of being cut, and
 * the gate would be reading a different failure than the one that ships.
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
      style={{ width, height, flex: "0 0 auto", overflow: "hidden" }}
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

function Page() {
  return (
    <ToastProvider>
      <AppearanceProvider>
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
