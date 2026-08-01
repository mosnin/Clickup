import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "@/components/toast";
import { AppearanceProvider } from "@/components/appearance/appearance-provider";
import { CustomizeProvider } from "@/components/appearance/customize-provider";
import { EditableGrid } from "@/components/dashboard/screen/editable-grid";
import type { ScreenLayout } from "@/lib/screen-layout";

// The editable grid, under a real pointer.
//
// The vertical resize was "fixed" twice with jsdom tests and reported broken
// twice by the person actually dragging it. jsdom cannot drag: it has no
// layout, no pointer capture, no frames. This page exists so the harness can
// put a REAL cursor on the grip, pull it down, and measure what happened —
// the only test of a drag that is a test of the drag.

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

// Deliberately mixed. The fixture this replaces was four identically sized
// cards, which is why it stayed green through the entire overlapping-panels
// bug: the two layout models only disagreed when heights DIFFERED, and four
// equal cards cannot express that. A short stat tile beside a tall table is
// the arrangement that actually broke on the real Home.
const TILES = [
  { id: "a", span: 2 as const, rows: 1 as const, title: "Today", minSpan: 1 as const, maxSpan: 3 as const, content: <DemoCard lines={3} title="Today" /> },
  { id: "b", span: 1 as const, rows: 3 as const, title: "Goals", minSpan: 1 as const, maxSpan: 3 as const, content: <DemoCard lines={14} title="Goals" /> },
  { id: "c", span: 1 as const, rows: 1 as const, title: "Agents", minSpan: 1 as const, maxSpan: 3 as const, content: <DemoCard lines={2} title="Agents" /> },
  { id: "d", span: 2 as const, rows: 2 as const, title: "Activity", minSpan: 1 as const, maxSpan: 3 as const, content: <DemoCard lines={9} title="Activity" /> },
  { id: "e", span: 1 as const, rows: 2 as const, title: "Spend", minSpan: 1 as const, maxSpan: 3 as const, content: <DemoCard lines={6} title="Spend" /> },
  { id: "f", span: 3 as const, rows: 1 as const, title: "Projects", minSpan: 1 as const, maxSpan: 3 as const, content: <DemoCard lines={4} title="Projects" /> },
];

function Page() {
  const [layout, setLayout] = useState<ScreenLayout>({
    widgets: TILES.map((t) => ({ id: t.id, span: t.span })),
  });
  // How many times the grid asked to SAVE. The reorder used to write on every
  // slot crossing, and those racing writes are what made a drop land in the
  // wrong place and then jump. "One gesture is one intention, so it is one
  // write" is only a rule if something counts.
  const [writes, setWrites] = useState(0);

  return (
    <ToastProvider>
      <AppearanceProvider>
        <CustomizeProvider>
          <h1>Grid, draggable for real</h1>
          <p className="note">
            Editing is on. The harness drags tile A&apos;s corner down and
            measures.
          </p>
          <div style={{ maxWidth: 1100, minWidth: 0 }}>
            <EditableGrid
              editing
              gridId="demo-grid"
              layout={layout}
              onChange={(next) => {
                setWrites((n) => n + 1);
                setLayout(next);
              }}
              onEditingChange={() => {}}
              tiles={TILES}
            />
          </div>
          {/* The committed layout, readable by the harness. */}
          <pre
            id="layout-json"
            style={{
              fontSize: 11,
              opacity: 0.6,
              // Wrapped, because an unwrapped line of JSON is wider than a
              // phone and drags the whole page out with it — which is how
              // every "390px" shot in this harness was really 646px wide.
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {JSON.stringify(layout)}
          </pre>
          <pre id="write-count" style={{ fontSize: 11, opacity: 0.6, whiteSpace: "pre-wrap" }}>
            {writes}
          </pre>
        </CustomizeProvider>
      </AppearanceProvider>
    </ToastProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
