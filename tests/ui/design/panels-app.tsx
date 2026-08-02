import { createRoot } from "react-dom/client";
import { ToastProvider } from "@/components/toast";
import { AppearanceProvider } from "@/components/appearance/appearance-provider";
import { CustomizeProvider } from "@/components/appearance/customize-provider";
import { Panel } from "@/components/dashboard/panel";
import { PanelBuilder } from "@/components/dashboard/panel-builder";
import { PanelProposal } from "@/components/dashboard/panel-proposal";
import { EmptyState } from "@/components/dashboard/empty-state";
import { ALL_SHAPES, shapeLabel, type PanelShape } from "@/lib/panel";
import { galleryData } from "./stubs/convex-react";

// Every shape the panel renderer can draw, in every state it can be in.
//
// The gap this closes: the panel renderer is the single most reused surface in
// the product — nineteen shapes, one function — and the harness had photographs
// of exactly the handful that happened to appear on Home. A shape that has
// never been rendered at 390 in dark is a shape that ships whatever it ships.
//
// Three states, not one, because the states are where the defects live:
//
//   - **with data** — the case everybody builds for
//   - **empty** — the case that decides whether an empty screen teaches or
//     apologises (dimension 10 of the rubric), and the case a fixture author
//     has to go out of their way to produce
//   - **truncated** — the panel saying out loud that it only counted what it
//     reached, which is a sentence that has to fit inside the card
//
// The three are told apart by the QUERY, not by a prop: the fixture resolver
// below branches on `from` and `limit`, both of which are real values in the
// closed vocabulary. So every panel here goes through the same path a real one
// does, and a shape that only renders when handed a hand-built envelope is a
// shape this page reports as broken rather than as fine.

const DAY = 24 * 60 * 60 * 1000;
const today = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();

const ROWS = [
  {
    id: "t1",
    title: "Reconcile the September ledger export before the cutover window",
    href: "#",
    meta: {
      status: "In progress",
      assigneeName: "Ada Lovelace",
      due: today - 2 * DAY,
      priority: "Urgent",
      list: "Billing migration",
    },
  },
  {
    id: "t2",
    title: "Write the rollback runbook",
    href: "#",
    meta: {
      status: "Open",
      assigneeName: "Triage",
      due: today,
      priority: "High",
      list: "Billing migration",
    },
  },
  {
    id: "t3",
    title: "Delete the legacy webhook handler",
    href: "#",
    meta: {
      status: "Done",
      assigneeName: "Ada Lovelace",
      priority: "Low",
      list: "Loose ends",
    },
  },
  {
    id: "t4",
    title: "Decide the cutover window with finance",
    href: "#",
    meta: {
      status: "Blocked",
      assigneeName: "Grace Hopper",
      due: today + 4 * DAY,
      priority: "Normal",
      list: "Billing migration",
    },
  },
  {
    id: "t5",
    title: "Q3 pricing experiment: pick the control cohort",
    href: "#",
    meta: {
      status: "Needs review",
      assigneeName: "Katherine Johnson",
      due: today + 9 * DAY,
      priority: "Normal",
      list: "Q3 pricing experiment",
    },
  },
];

/**
 * Categorical series with real words in them.
 *
 * "Mon/Tue/Wed" in a 190px card is the easiest possible case and says nothing
 * about a label reading "Katherine Johnson" in a one-column panel — which is
 * what the axes in this product actually carry.
 */
// The parts sum to the whole on purpose: `scalar`/`total` below is 41 and so
// is this. A donut whose centre reads 62 inside a card whose header reads
// "25 of 41" looks exactly like a real arithmetic bug, and a fixture that
// manufactures one teaches an auditor to discount the very thing the panel is
// for. A zero is kept, because zero is the value most often drawn wrong.
const CATEGORICAL = [
  {
    key: "a",
    label: "Open",
    points: [
      { key: "ada", label: "Ada Lovelace", value: 12 },
      { key: "grace", label: "Grace Hopper", value: 14 },
      { key: "kj", label: "Katherine Johnson", value: 7 },
      { key: "radia", label: "Radia Perlman", value: 0 },
      { key: "barbara", label: "Barbara Liskov", value: 8 },
    ],
  },
];

const TEMPORAL = [
  {
    key: "all",
    label: "Completed",
    points: Array.from({ length: 14 }, (_, i) => ({
      key: String(today - (13 - i) * DAY),
      label: "",
      value: Math.max(0, 3 + Math.round(5 * Math.sin(i / 2.1) + i / 3)),
    })),
  },
];

const FULL = {
  rows: ROWS,
  series: CATEGORICAL,
  scalar: 41,
  total: 41,
  truncated: false,
  meta: { unit: "count", dimensionLabel: "assignee", measureLabel: "Open" },
};

const EMPTY = {
  rows: [],
  series: [],
  scalar: 0,
  total: 0,
  truncated: false,
  meta: { unit: "count", dimensionLabel: "assignee", measureLabel: "Open" },
};

/**
 * One resolver, branching on the query — the same way the real one does.
 *
 * `from: "pages"` is the empty channel and `limit: 3` is the truncated one.
 * Both are legal values in the closed vocabulary, so nothing here needs the
 * renderer to know it is being tested.
 */
galleryData["dataStream.resolve"] = (args: unknown) => {
  const query = (
    args as {
      query?: { from?: string; limit?: number; dimension?: string };
    }
  )?.query;
  if (query?.from === "pages") return EMPTY;
  if (query?.limit === 3) {
    return {
      ...FULL,
      rows: ROWS.slice(0, 3),
      series: TEMPORAL,
      total: 412,
      truncated: true,
    };
  }
  if (query?.dimension === "completed_day") {
    return { ...FULL, series: TEMPORAL, meta: { ...FULL.meta, dimensionLabel: "day" } };
  }
  return FULL;
};

galleryData["calibration.forScope"] = [];
galleryData["appearance.forCurrentUser"] = null;
galleryData["appearance.spaceContext"] = null;
galleryData["componentStyle.forScope"] = null;
galleryData["users.current"] = { clerkId: "u1", name: "Ada Lovelace" };
galleryData["panelMemory.forScope"] = [];

/** The suggestion banner: an agent proposing a panel this screen doesn't have. */
galleryData["uiComponents.proposalsFor"] = [
  {
    proposalId: "pp1",
    agentName: "Ledger migration runner",
    reason:
      "Four of the last six things I finished were blocked on somebody else " +
      "first. Nothing on this screen shows what is waiting on you.",
    definition: {
      title: "Waiting on you",
      query: {
        from: "tasks",
        dimension: "assignee",
        measure: "open",
        filter: { status: "open", due: "overdue" },
      },
      shape: "bar",
      fields: ["status", "due"],
      style: {},
      caption: "Open work with an overdue blocker",
    },
    createdAt: Date.now() - 20 * 60 * 1000,
  },
];

const SCOPE = { scopeType: "user" as const, scopeId: "u1" };

function shapeQuery(shape: PanelShape, channel: "full" | "empty" | "truncated") {
  const base = {
    from: channel === "empty" ? ("pages" as const) : ("tasks" as const),
    dimension:
      shape === "line" || shape === "area" || shape === "scatter"
        ? ("completed_day" as const)
        : ("assignee" as const),
    measure: "open" as const,
    limit: channel === "truncated" ? 3 : 25,
  };
  return base;
}

function ShapeCase({
  shape,
  channel,
}: {
  shape: PanelShape;
  channel: "full" | "empty" | "truncated";
}) {
  return (
    // `data-audit-panel` is the audit's handle on a panel, the way
    // `data-tile` is its handle on a grid cell. The overlap gate reads it, so
    // a page of panels laid out badly is a page the instrument can fail.
    <div
      className="cell"
      data-audit-panel
      data-shape={shape}
      style={{ minWidth: 0 }}
    >
      <div className="cap">
        {shapeLabel(shape)} · {channel}
      </div>
      <div style={{ height: 210 }}>
        <Panel
          definition={{
            title: shapeLabel(shape),
            query: shapeQuery(shape, channel),
            shape,
            fields: ["status", "assigneeName", "due", "priority"],
            style: {},
            caption:
              channel === "truncated" ? "Only what the walk reached" : "",
          }}
          scopeId={SCOPE.scopeId}
          scopeType={SCOPE.scopeType}
        />
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <h2>{title}</h2>
      <div className="grid">{children}</div>
    </>
  );
}

function Page() {
  return (
    <ToastProvider>
      <AppearanceProvider>
        <CustomizeProvider>
          <h1>Panels</h1>

          <Section title="Every shape · with data">
            {ALL_SHAPES.map((shape) => (
              <ShapeCase channel="full" key={shape} shape={shape} />
            ))}
          </Section>

          <Section title="Every shape · nothing to show">
            {ALL_SHAPES.map((shape) => (
              <ShapeCase channel="empty" key={shape} shape={shape} />
            ))}
          </Section>

          <Section title="Every shape · capped, and saying so">
            {ALL_SHAPES.map((shape) => (
              <ShapeCase channel="truncated" key={shape} shape={shape} />
            ))}
          </Section>

          <Section title="A panel proposed by an agent">
            <div
              className="cell"
              data-audit-panel
              style={{ gridColumn: "1 / -1" }}
            >
              <div className="cap">panel proposal · pending</div>
              <PanelProposal
                onAccept={() => {}}
                scopeId={SCOPE.scopeId}
                scopeType={SCOPE.scopeType}
                screenKey="project:p1"
              />
            </div>
          </Section>

          <Section title="Nothing here yet">
            <div className="cell" data-audit-panel>
              <div className="cap">empty state · compact</div>
              <EmptyState
                compact
                message="Panels you build land here, and every project screen offers them."
                title="No panels yet"
              />
            </div>
            <div className="cell" data-audit-panel style={{ gridColumn: "span 2" }}>
              <div className="cap">empty state · standalone, with an action</div>
              {/* The action is the REAL builder, not a button shaped like one.
                  It used to be `<Button size="sm">Build a panel</Button>` — no
                  handler, no ancestor handler, no destination — and the gallery
                  is where a person goes to find out what this product does, so
                  a control here that produces nothing is the product claiming
                  something it does not do. Under the rubric that is worse than
                  having no control at all, because absence is honest.

                  Wiring it to the thing it names costs one component: pressing
                  it opens the same builder a blank project screen offers, with
                  the same vocabulary and the same live preview. */}
              <EmptyState
                action={
                  <div className="w-full text-left">
                    <PanelBuilder
                      onCreated={() => {}}
                      scopeId={SCOPE.scopeId}
                      scopeType={SCOPE.scopeType}
                    />
                  </div>
                }
                message="A panel is a question about your work. Pick something to watch and how it should be drawn."
                title="This screen is blank"
              />
            </div>
          </Section>
        </CustomizeProvider>
      </AppearanceProvider>
    </ToastProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
