import { useEffect, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "@/components/toast";
import { AppearanceProvider } from "@/components/appearance/appearance-provider";
import {
  CustomizeProvider,
  useCustomize,
} from "@/components/appearance/customize-provider";
import { MintablePanelsProvider } from "@/components/appearance/mintable-panels";
import { StyleStudio } from "@/components/appearance/style-studio";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
// The shell's classes come from the shell, never retyped — see lib/shell.ts
// for what the drift cost the last time they were written out twice.
import { SHELL_INSET, SHELL_PAGE, SHELL_PROVIDER } from "@/lib/shell";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import DashboardHome from "@/app/dashboard/page";
import { galleryData, galleryMutations } from "./stubs/convex-react";

// Home, in the harness, for the first time.
//
// Every visual claim made about this project was checked against `grid.html` —
// a page of placeholder cards. The screen the person who uses this product
// actually opens had never been rendered by the harness at all, and three
// regressions walked through that gap and were found on a phone: a stat card
// sliced through its own number, a delete control sitting on top of a label,
// and two panels overlapping. All three are things a picture answers in a
// second and no unit test answers at all.
//
// So this renders the REAL page — `src/app/dashboard/page.tsx` itself, inside
// the shell its own layout gives it (sidebar, inset, that inset's padding).
// Not a lookalike: a lookalike is a picture of a design, it drifts the moment
// the real one changes, and it is exactly what stayed green through the
// overlap bug.
//
// The fixtures below are shaped like the queries' real returns and sized like
// real work: long project names, a nine-word status line, a tall list beside a
// short chart. Equal-sized tiles full of "Lorem" cannot express the bugs that
// happen, which is the whole reason the old fixture never caught one.
//
// What the FIRST run of this page found, in both states and at both widths:
// every panel is given a fixed 10.5rem box by the grid and nothing clips it,
// so Projects (458px of table in a 168px box) paints straight over Live, and
// Live paints over Agents. Home has been overlapping itself this whole time.
// The demo fixture could not see it because every tile there declares `rows`,
// which makes the grid a *composed* screen and turns the scroll containers on.
// Home declares none, so it takes the *natural* path — the path nothing had
// ever rendered.

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
/** Local midnight, the same stamp `lib/dates` writes due dates at. */
const todayStart = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();

// ── The shell's own queries ──────────────────────────────────────────────
// Home renders inside the sidebar, and the sidebar's width is what decides
// how wide Home lays out. Stubbing it away would answer the wrong question.

galleryData["sidebar.tree"] = {
  currentClerkId: "u1",
  personal: {
    _id: "sp_personal",
    name: "Personal",
    projects: [],
    lists: [{ _id: "lp1", name: "Someday", position: 0 }],
    pages: [{ _id: "pgp1", title: "Weekly review", pinned: false }],
    scopeType: "user" as const,
    scopeId: "u1",
    whiteboards: [],
  },
  workspaces: [
    {
      _id: "w1",
      name: "Northwind",
      spaces: [
        {
          _id: "s1",
          name: "HQ",
          color: undefined,
          private: false,
          projects: [
            {
              _id: "p1",
              name: "Billing migration",
              position: 0,
              color: undefined,
              projectStatus: "at_risk",
              roadmapId: undefined,
              lists: [
                { _id: "l1", name: "Backlog", position: 0 },
                { _id: "l3", name: "In review", position: 1 },
              ],
            },
            {
              _id: "p2",
              name: "Onboarding revamp",
              position: 1,
              color: undefined,
              projectStatus: "on_track",
              roadmapId: undefined,
              lists: [{ _id: "l4", name: "Research", position: 0 }],
            },
          ],
          lists: [{ _id: "l2", name: "Loose ends", position: 0 }],
          pages: [{ _id: "pg1", title: "How we ship", pinned: true }],
          scopeType: "workspace" as const,
          scopeId: "w1",
          whiteboards: [{ _id: "wb1", title: "Architecture" }],
        },
      ],
    },
  ],
};
galleryData["favorites.listForCurrentUser"] = [];
galleryData["mentions.unreadCountForCurrent"] = 4;
galleryData["notificationCenter.unreadCount"] = 2;
galleryData["chat.scopesForCurrentUser"] = [
  { scopeType: "user", scopeId: "u1", name: "Personal" },
];
galleryData["chat.channels"] = [];
galleryData["timeEntries.runningForCurrent"] = null;
galleryData["users.current"] = { clerkId: "u1", name: "Ada Lovelace" };
galleryData["admin.me"] = null;

// ── Home's own queries ───────────────────────────────────────────────────

galleryData["homeOverview.get"] = {
  // Deliberately uneven: a project whose name wraps, a project with no
  // health chip, one already past its target date, one with nothing done.
  // A table of five identical rows is a table that can't be wrong.
  projects: [
    {
      listId: "l1",
      name: "Billing migration — Stripe to internal ledger",
      place: "Northwind · HQ",
      projectStatus: "at_risk",
      targetDate: todayStart - 3 * DAY,
      total: 48,
      done: 31,
      inProgress: 6,
      overdue: 4,
      dueSoon: 9,
      lastActivityAt: now - 4 * 60 * 1000,
    },
    {
      listId: "l4",
      name: "Onboarding revamp",
      place: "Northwind · HQ",
      projectStatus: "on_track",
      targetDate: todayStart + 12 * DAY,
      total: 23,
      done: 17,
      inProgress: 3,
      overdue: 0,
      dueSoon: 5,
      lastActivityAt: now - 51 * 60 * 1000,
    },
    {
      listId: "l3",
      name: "Q3 pricing experiment",
      place: "Northwind · Growth",
      projectStatus: "off_track",
      targetDate: todayStart + 2 * DAY,
      total: 14,
      done: 2,
      inProgress: 1,
      overdue: 6,
      dueSoon: 3,
      lastActivityAt: now - 3 * 60 * 60 * 1000,
    },
    {
      listId: "l2",
      name: "Loose ends",
      place: "Northwind · HQ",
      projectStatus: undefined,
      targetDate: undefined,
      total: 9,
      done: 9,
      inProgress: 0,
      overdue: 0,
      dueSoon: 0,
      lastActivityAt: now - 2 * DAY,
    },
    {
      listId: "l5",
      name: "Agent governance rollout",
      place: "Northwind · Platform",
      projectStatus: "paused",
      targetDate: todayStart + 30 * DAY,
      total: 31,
      done: 0,
      inProgress: 0,
      overdue: 0,
      dueSoon: 0,
      lastActivityAt: now - 6 * DAY,
    },
    {
      listId: "lp1",
      name: "Someday",
      place: "Personal · Personal",
      projectStatus: "on_track",
      targetDate: undefined,
      total: 121,
      done: 118,
      inProgress: 2,
      overdue: 1,
      dueSoon: 0,
      lastActivityAt: now - 9 * DAY,
    },
  ],
  totalProjects: 11,
  // Four-digit-free but not all single digit: the stat card that sliced
  // through its own number did it at two digits, so the fixture has to
  // carry them.
  me: { open: 37, overdue: 12, dueToday: 5 },
  agents: [
    {
      agentId: "a1",
      name: "Ledger migration runner",
      statusText: "Reconciling invoices 4,100–4,600 against the old ledger",
      online: true,
    },
    { agentId: "a2", name: "Triage", statusText: undefined, online: true },
    {
      agentId: "a3",
      name: "Docs keeper",
      statusText: "Rewriting the onboarding guide",
      online: true,
    },
  ],
  totalAgentsOnline: 3,
  ticker: [
    {
      id: "e1",
      type: "task.completed",
      entityTitle: "Backfill ledger rows for the 2024 fiscal year",
      actorName: "Ledger migration runner",
      actorType: "agent",
      listId: "l1",
      createdAt: now - 4 * 60 * 1000,
    },
    {
      id: "e2",
      type: "comment.created",
      entityTitle: "Pricing page copy",
      actorName: "Ada Lovelace",
      actorType: "user",
      listId: "l3",
      createdAt: now - 22 * 60 * 1000,
    },
    {
      id: "e3",
      type: "task.created",
      entityTitle: "Decide the cutover window with finance",
      actorName: "Grace Hopper",
      actorType: "user",
      listId: "l1",
      createdAt: now - 46 * 60 * 1000,
    },
    {
      id: "e4",
      type: "task.assigned",
      entityTitle: "Write the rollback runbook",
      actorName: "Triage",
      actorType: "agent",
      listId: "l1",
      createdAt: now - 2 * 60 * 60 * 1000,
    },
    {
      id: "e5",
      type: "agent.connected",
      entityTitle: "Docs keeper",
      actorName: "Docs keeper",
      actorType: "agent",
      listId: undefined,
      createdAt: now - 3 * 60 * 60 * 1000,
    },
    {
      id: "e6",
      type: "task.completed",
      entityTitle: "Ship the invite emails",
      actorName: "Ada Lovelace",
      actorType: "user",
      listId: "l4",
      createdAt: now - 5 * 60 * 60 * 1000,
    },
    {
      id: "e7",
      type: "sprint.started",
      entityTitle: "Sprint 14",
      actorName: "Grace Hopper",
      actorType: "user",
      listId: undefined,
      createdAt: now - 26 * 60 * 60 * 1000,
    },
    {
      id: "e8",
      type: "task.completed",
      entityTitle: "Delete the legacy webhook handler",
      actorName: "Triage",
      actorType: "agent",
      listId: "l2",
      createdAt: now - 30 * 60 * 60 * 1000,
    },
  ],
  completions7d: [3, 8, 2, 11, 6, 14, 5],
};

galleryData["myWork.listForCurrent"] = [
  {
    _id: "t1",
    title: "Reconcile the September ledger export before the cutover window",
    listId: "l1",
    listName: "Billing migration",
    dueDate: todayStart - 2 * DAY,
    priority: "urgent",
  },
  {
    _id: "t2",
    title: "Review agent governance limits",
    listId: "l5",
    listName: "Agent governance rollout",
    dueDate: todayStart - DAY,
    priority: "high",
  },
  {
    _id: "t3",
    title: "Pair with Grace on the rollback runbook",
    listId: "l1",
    listName: "Billing migration",
    dueDate: todayStart,
    priority: "normal",
  },
  {
    _id: "t4",
    title: "Answer the pricing questions in #growth",
    listId: "l3",
    listName: "Q3 pricing experiment",
    dueDate: todayStart,
    priority: "low",
  },
  {
    _id: "t5",
    title: "Onboarding revamp: cut the second question",
    listId: "l4",
    listName: "Research",
    dueDate: todayStart,
    priority: undefined,
  },
  {
    _id: "t6",
    title: "File the SOC2 evidence for Q3",
    listId: "l2",
    listName: "Loose ends",
    dueDate: todayStart + 4 * DAY,
    priority: "normal",
  },
];

// One agent that has never checked in, so the "waiting to connect" card —
// a real state of this page, and the only one with a border beam — renders.
galleryData["agents.listForCurrentUser"] = {
  personal: [
    {
      _id: "a4",
      name: "Inbox zero",
      status: "active",
      lastSeenAt: undefined,
    },
  ],
  workspaces: [
    {
      workspaceId: "w1",
      workspaceName: "Northwind",
      canManageAgents: true,
      agents: [
        { _id: "a1", name: "Ledger migration runner", status: "active", lastSeenAt: now - 60 * 1000 },
        { _id: "a2", name: "Triage", status: "active", lastSeenAt: now - 90 * 1000 },
      ],
    },
  ],
};

galleryData["invites.listForCurrentUser"] = [
  {
    _id: "i1",
    workspaceName: "Northwind Platform",
    invitedBy: "grace@northwind.example",
    role: "admin",
  },
];

// Two Homes, because they are two different screens and both ship.
//
// `?plain=1` is the Home of somebody who has never touched the layout — no
// stored rows at all, which is what every account starts as and most stay as.
// The default here is a customised one, with MIXED heights on purpose: the
// bug this fixture exists to catch only appears when neighbouring tiles
// disagree about how tall they are — a two-row task list beside a one-row
// chart, a one-row feed beside a two-row agents card. Six tiles at the same
// height is the arrangement that proved nothing for a year.
const CUSTOMISED = !new URLSearchParams(window.location.search).has("plain");
galleryData["userSettings.current"] = CUSTOMISED
  ? {
      clerkId: "u1",
      homeWidgets: ["stats", "today", "activity", "projects", "live", "agents"],
      homeWidgetSpans: {
        stats: 3,
        today: 2,
        activity: 1,
        projects: 3,
        live: 2,
        agents: 1,
      },
      homeWidgetRows: { today: 2, activity: 1, live: 1, agents: 2 },
    }
  : null;

/**
 * Deliver a new subscription state to the page.
 *
 * The query stub reads `galleryData` during render, so a write is only visible
 * once something re-renders — which is what a Convex subscription does for
 * free and a module-scope handler cannot do for itself. `Page` installs the
 * real one; before it mounts this is a no-op, which is correct: nothing has
 * rendered yet to be stale.
 */
let rerender = () => {};
function refreshAll() {
  rerender();
}

// A backend that remembers what the studio wrote.
//
// It was `null` and had no mutation handler, so every pick in the customiser
// resolved into nothing and the panel behind the sheet never moved — which is
// indistinguishable, from the harness's side, from the studio being broken.
// That is the exact complaint it exists to be able to answer, so the fixture
// has to be able to be wrong about it. `scripts/verify-customize.mjs` walks
// the whole sequence against this.
galleryData["appearance.forCurrentUser"] = {
  personal: null,
  patchVersion: 2,
  spaceOverrides: {},
  componentStyle: null,
  componentStyleBySpace: {},
  panelStyles: {},
  panelMemory: {},
  panelWatches: {},
};
galleryData["appearance.spaceContext"] = null;

/** Mirrors convex/appearance.ts savePanelStyle: empty patch deletes the key. */
galleryMutations["appearance.savePanelStyle"] = (args) => {
  const { panelId, patch } = args as { panelId: string; patch: unknown };
  const row = galleryData["appearance.forCurrentUser"] as {
    panelStyles: Record<string, unknown>;
  };
  const next = { ...row.panelStyles };
  const empty =
    !patch || typeof patch !== "object" || Object.keys(patch).length === 0;
  if (empty) delete next[panelId];
  else next[panelId] = patch;
  galleryData["appearance.forCurrentUser"] = { ...row, panelStyles: next };
  refreshAll();
};
galleryMutations["appearance.saveComponentStyle"] = (args) => {
  const { patch } = args as { patch: unknown };
  const row = galleryData["appearance.forCurrentUser"] as object;
  const empty =
    !patch || typeof patch !== "object" || Object.keys(patch).length === 0;
  galleryData["appearance.forCurrentUser"] = {
    ...row,
    componentStyle: empty ? null : patch,
  };
  refreshAll();
};

// ── The studio, over Home ────────────────────────────────────────────────
//
// `?studio=1` opens customise mode on this page, which is the only place the
// mint path can be looked at: the chart chapter needs a screen OFFERING its
// built-ins, and Home is the screen that does. It had never been rendered — the
// shelf's shots all came from the sidebar page, where nothing offers and the
// chapter correctly says the shape is fixed. So the state that shipped was the
// one state of this control nobody had seen.
//
// Nothing else about the page changes, so the four Home shots stay the Home
// shots and this is a fifth thing rather than a different fixture.

/** Panels this reader has authored: none, which is where everyone starts. */
galleryData["uiComponents.listForScope"] = [];
/** Nothing selected has a stored definition, so the shelf takes the mint path. */
galleryData["uiComponents.get"] = null;
// The candidate cards in the chart chapter draw with the real `<Panel>` over
// real data rather than an invented specimen — see built-in-panel.ts — so the
// resolver has to answer or the shelf is a row of skeletons.
galleryData["dataStream.resolve"] = {
  rows: [
    {
      id: "t1",
      title: "Reconcile the September ledger export",
      href: "#",
      meta: {
        status: "In progress",
        assigneeName: "Ada",
        due: todayStart,
        priority: "High",
      },
    },
    {
      id: "t2",
      title: "Write the rollback runbook",
      href: "#",
      meta: { status: "Open", assigneeName: "Triage", priority: "Normal" },
    },
    {
      id: "t3",
      title: "Delete the legacy webhook handler",
      href: "#",
      meta: { status: "Done", assigneeName: "Ada", priority: "Low" },
    },
  ],
  series: [
    {
      key: "all",
      label: "Completed",
      points: Array.from({ length: 14 }, (_, i) => ({
        key: String(todayStart - (13 - i) * DAY),
        label: "",
        value: 3 + Math.round(5 * Math.sin(i / 2.1) + i / 3),
      })),
    },
  ],
  scalar: 41,
  total: 41,
  truncated: false,
  meta: { unit: "count", dimensionLabel: "day", measureLabel: "Completed" },
};

// ── Panels that are only here sometimes ──────────────────────────────────
//
// `?situations=1` gives this reader two conditions on Home, which is the only
// way to look at the list that turns them off. It has to be behind a flag: the
// list is correctly absent when nobody has set one, and that absence is what
// every other Home shot should keep showing.
//
// This is the surface with the strongest claim on being photographed, because
// it is the one you go looking for when nothing is on screen — a panel governed
// by a condition is invisible exactly when the condition is false, so a list
// that renders badly here is a setting nobody can unset.
galleryData["situations.forScreen"] = new URLSearchParams(
  window.location.search,
).has("situations")
  ? [
      {
        subscriptionId: "ps1",
        panelId: "activity",
        description: "Overdue tasks reached 6",
        isTrue: true,
        value: 7,
        becameTrueAt: todayStart,
        becameFalseAt: null,
        acknowledgedAt: todayStart,
        resolution: "kept",
        lastCheckedAt: todayStart,
      },
      {
        subscriptionId: "ps2",
        panelId: "agents",
        description: "Tasks waiting on approval reached 3",
        isTrue: false,
        value: 0,
        becameTrueAt: null,
        becameFalseAt: null,
        acknowledgedAt: null,
        resolution: null,
        lastCheckedAt: todayStart,
      },
    ]
  : [];

// ── A panel ARRIVING, because a condition just became true ───────────────
//
// The list above is the half you go looking for; this is the half that comes to
// you, and it had never been rendered on the surface most people actually open.
// `?arrival=1` is a reader with one block off their Home and a condition that
// has just become true about it — the only state in which the offer appears.
//
// Home is the right place to prove it and the demo grid is not: this page has
// six blocks at four different heights inside a real shell with a real sidebar,
// which is exactly the arrangement a placement bug needs in order to show. A
// panel that arrives must land in a slot the packer chose and displace nothing,
// and that claim is worth nothing measured against four identical cards.
const ARRIVAL = new URLSearchParams(window.location.search).has("arrival");

/** The condition, before it lapses. Exported so the lapse can restate it. */
const ARRIVING_ROW = {
  subscriptionId: "ps-arrive",
  panelId: "agents",
  description: "Blocked tasks reached 3",
  isTrue: true,
  value: 3,
  becameTrueAt: todayStart,
  becameFalseAt: null,
  acknowledgedAt: null,
  resolution: null,
  lastCheckedAt: todayStart,
};

if (ARRIVAL) {
  // One block off the screen, so there is something for a condition to offer.
  galleryData["userSettings.current"] = {
    clerkId: "u1",
    homeWidgets: ["stats", "today", "activity", "projects", "live"],
    homeWidgetSpans: { stats: 3, today: 2, activity: 1, projects: 3, live: 2 },
    homeWidgetRows: { today: 2, activity: 1, live: 1 },
  };
  galleryData["situations.forScreen"] = [ARRIVING_ROW];

  // A backend that remembers, for this one write.
  //
  // Home saves its arrangement optimistically and drops the draft the instant
  // the mutation resolves, trusting the subscription to have caught up. Against
  // a stub that resolves and forgets, every layout change on this page snaps
  // back a beat later — so a harness driving Home would report the product
  // broken when it is the harness with no memory. Writing the settings row back
  // is what makes the walk a walk.
  galleryMutations["userSettings.setHomeWidgets"] = (args) => {
    const a = args as {
      homeWidgets: string[] | null;
      spans?: Record<string, number> | null;
      rows?: Record<string, number> | null;
    };
    galleryData["userSettings.current"] = {
      clerkId: "u1",
      homeWidgets: a.homeWidgets ?? undefined,
      homeWidgetSpans: a.spans ?? {},
      homeWidgetRows: a.rows ?? {},
    };
  };
}

/**
 * The condition lapsing, which is the departure case.
 *
 * A button rather than a second page load, because what is being proven spans
 * one session: a panel the reader KEPT has to still be there afterwards, and a
 * reload would lose the keeping along with the thing being tested. Rendered
 * only under `?arrival=1`, so no other shot of this page grows a control.
 */
function LapseControl({ onLapse }: { onLapse: () => void }) {
  return (
    <button id="end-condition" onClick={onLapse} type="button">
      end the condition
    </button>
  );
}

const STUDIO = new URLSearchParams(window.location.search).has("studio");

/** Customise mode, turned on the app's own way. */
function StudioOpen() {
  const { setActive } = useCustomize();
  useEffect(() => setActive(true), [setActive]);
  return null;
}

function Page() {
  // The gallery's stub reads `galleryData` during render, so re-rendering is
  // how this page delivers a new subscription state — what a Convex
  // subscription does, minus the socket.
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  // Module-scope mutation handlers write into `galleryData` and then need the
  // tree to read it again. This is the only place that can be arranged.
  rerender = refresh;
  // The dashboard layout's own composition, in its own order: toasts wrap
  // appearance (the appearance writer has to be able to say a save failed),
  // appearance wraps everything that reads a token, and there is exactly one
  // SidebarProvider. The `h-svh overflow-hidden` is what makes the inset —
  // not the document — the scroll container, which is what PageHeader's
  // `sticky top-0` is positioned against. A harness that let the document
  // scroll instead would be testing a shell nobody ships.
  return (
    <ToastProvider>
      <AppearanceProvider>
        <CustomizeProvider>
          {/* The backdrop the app window floats on — the dashboard layout's
              own, so the harness frames the app the way the app does. */}
          <div aria-hidden className="app-backdrop fixed inset-0 -z-10" />
          {/* Up here rather than around Home, exactly as the dashboard layout
              has it: the studio is a sibling of the page, so a provider
              rendered by the page could never reach it. */}
          <MintablePanelsProvider>
            <SidebarProvider className={SHELL_PROVIDER}>
              <DashboardSidebar />
              <SidebarInset className={SHELL_INSET}>
                <div className={SHELL_PAGE}>
                  <DashboardHome />
                  {ARRIVAL && (
                    <LapseControl
                      onLapse={() => {
                        galleryData["situations.forScreen"] = [
                          {
                            ...ARRIVING_ROW,
                            isTrue: false,
                            becameFalseAt: todayStart + 1,
                            acknowledgedAt: todayStart,
                            resolution: "kept",
                          },
                        ];
                        refresh();
                      }}
                    />
                  )}
                </div>
              </SidebarInset>
            </SidebarProvider>
            {STUDIO && <StudioOpen />}
            <StyleStudio />
          </MintablePanelsProvider>
        </CustomizeProvider>
      </AppearanceProvider>
    </ToastProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
