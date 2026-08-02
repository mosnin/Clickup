import { useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "@/components/toast";
import { AppearanceProvider } from "@/components/appearance/appearance-provider";
import { CustomizeProvider } from "@/components/appearance/customize-provider";
import { EditableGrid } from "@/components/dashboard/screen/editable-grid";
import { type ScreenLayout } from "@/lib/screen-layout";
import { galleryData } from "./stubs/convex-react";

// A panel arriving on a real canvas, in a real browser.
//
// The claim that has to be proven here and cannot be proven anywhere else: a
// panel that arrives must never displace or overlap what is already on the
// screen. jsdom has no layout, so every unit test of this feature is silent on
// the one failure that would actually be visible — and this codebase has
// already shipped overlapping panels once behind green tests, twice if you
// count the content spilling out of a box whose geometry was correct.
//
// So this is the real hook, the real banner and the real `EditableGrid`, with
// only the wire stubbed. Placement goes through `pack` because it goes through
// the ordinary layout: an arriving panel is an entry in `layout.widgets` like
// any other, and nothing here is allowed to know a pixel.
//
// The tiles are deliberately mixed heights, and the arriving one is the tallest
// thing on the page. Four identically sized cards is the fixture that stayed
// green through the entire overlapping-panels bug, because the two layout
// models only disagreed when heights DIFFERED.

const GRID = "situation-grid";
const ARRIVING = "custom:blocked-now";
const SCREEN_KEY = "project:demo";

function DemoCard({ title, lines }: { title: string; lines: number }) {
  return (
    <div className="bento h-full min-h-0 rounded-2xl bg-card p-5">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <ul className="mt-3 space-y-2">
        {Array.from({ length: lines }, (_, i) => (
          <li className="h-3 rounded bg-muted" key={i} />
        ))}
      </ul>
    </div>
  );
}

const TILES = [
  { id: "a", span: 2 as const, rows: 1 as const, title: "Today", minSpan: 1 as const, maxSpan: 3 as const, content: <DemoCard lines={3} title="Today" /> },
  { id: "b", span: 1 as const, rows: 3 as const, title: "Goals", minSpan: 1 as const, maxSpan: 3 as const, content: <DemoCard lines={14} title="Goals" /> },
  { id: "c", span: 1 as const, rows: 1 as const, title: "Agents", minSpan: 1 as const, maxSpan: 3 as const, content: <DemoCard lines={2} title="Agents" /> },
  { id: "d", span: 2 as const, rows: 2 as const, title: "Activity", minSpan: 1 as const, maxSpan: 3 as const, content: <DemoCard lines={9} title="Activity" /> },
  { id: "f", span: 3 as const, rows: 1 as const, title: "Projects", minSpan: 1 as const, maxSpan: 3 as const, content: <DemoCard lines={4} title="Projects" /> },
  // The arriving one. Taller than its box would be if anything mis-sized it,
  // which is what makes the spill measurement meaningful rather than decorative.
  { id: ARRIVING, span: 2 as const, rows: 2 as const, title: "Blocked right now", minSpan: 1 as const, maxSpan: 3 as const, content: <DemoCard lines={16} title="Blocked right now" /> },
];

const AVAILABLE = TILES.map((t) => t.id);

const BASE: ScreenLayout = {
  widgets: [
    { id: "a", span: 2 },
    { id: "b", span: 1 },
    { id: "c", span: 1 },
    { id: "d", span: 2 },
    { id: "f", span: 3 },
  ],
};

/** One `situations.forScreen` row, in the shape the query returns. */
function row(over: Record<string, unknown>) {
  return {
    subscriptionId: "sub1",
    panelId: ARRIVING,
    scopeType: "workspace",
    scopeId: "w1",
    situation: {
      id: "blocked",
      label: "Blocked tasks",
      query: {},
      compare: "at_least",
      threshold: 3,
    },
    description: "Blocked tasks reached 3",
    isTrue: true,
    value: 3,
    becameTrueAt: 1_000,
    becameFalseAt: null,
    acknowledgedAt: null,
    resolution: null,
    lastCheckedAt: 1_000,
    ...over,
  };
}

galleryData["situations.forScreen"] = [row({})];

/**
 * The screen itself, INSIDE the providers.
 *
 * `useScreenSituations` reaches for the toast context, so a component that
 * renders `ToastProvider` in its own tree cannot also call the hook — the
 * provider is below it. Same reason the dashboard mounts its providers in the
 * layout rather than in a page.
 */
function Screen() {
  const [layout, setLayout] = useState<ScreenLayout>(BASE);
  const [writes, setWrites] = useState(0);
  // The stub reads `galleryData` during render, so re-rendering is how this
  // page delivers a new subscription state — the same thing a Convex
  // subscription does, minus the socket.
  const [, refresh] = useReducer((n: number) => n + 1, 0);

  return (
    <>
      <h1>A panel arriving, for real</h1>
      <p className="note">
        The harness previews it, keeps it, and measures every box on the page at
        two widths.
      </p>
      <div style={{ maxWidth: 1100, minWidth: 0 }}>
        {/* Nothing here mentions situations. The grid owns the offer — it has
            the screen key, the tiles, the layout and the way to save, which is
            everything an offer needs — so a surface gets arrivals by rendering
            a grid and this fixture proves exactly that. */}
        <EditableGrid
          gridId={GRID}
          screenKey={SCREEN_KEY}
          layout={layout}
          onChange={(next) => {
            setWrites((n) => n + 1);
            setLayout(next);
          }}
          tiles={TILES}
        />
      </div>
      {/* The condition lapsing, which is the departure case. A kept panel must
          still be here afterwards. */}
      <button
        id="end-condition"
        type="button"
        onClick={() => {
          galleryData["situations.forScreen"] = [
            row({
              isTrue: false,
              becameFalseAt: 2_000,
              acknowledgedAt: 1_000,
              resolution: "kept",
            }),
          ];
          refresh();
        }}
      >
        end the condition
      </button>
      <pre
        id="layout-json"
        style={{ fontSize: 11, opacity: 0.6, whiteSpace: "pre-wrap", wordBreak: "break-all" }}
      >
        {JSON.stringify(layout)}
      </pre>
      <pre id="write-count" style={{ fontSize: 11, opacity: 0.6 }}>
        {writes}
      </pre>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <AppearanceProvider>
      <CustomizeProvider>
        <Screen />
      </CustomizeProvider>
    </AppearanceProvider>
  </ToastProvider>,
);
