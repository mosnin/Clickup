"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useMeasure from "react-use-measure";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowRight,
  Plus,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { eventLabel } from "@/lib/event-labels";
import { useToast } from "@/components/toast";
import {
  AnimatePresence,
  EASE,
  motion,
  PresenceDot,
  Stagger,
  StaggerItem,
} from "@/components/motion";
import Counter, { placesFor } from "@/components/counter";
import {
  INSTRUMENT_META,
} from "@/components/dashboard/instrument-card";
import { PageHeader } from "@/components/dashboard/page-header";
import { DeelWidgetFooter, DeelWidgetHeader } from "@/components/dashboard/deel-widget";
import { InviteCards } from "@/components/dashboard/invite-cards";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PriorityDot } from "@/components/dashboard/priority";
import { Button } from "@/components/ui/button";
import { DEEL_BADGE, deelLongDate, greetingFor } from "@/lib/deel-chrome";
import { Checkbox } from "@/components/ui/checkbox";
import GradientText from "@/components/gradient-text";
import { errorMessage } from "@/lib/errors";
import { wake } from "@/lib/anime";
import {
  EditableGrid,
  TrayTile,
} from "@/components/dashboard/screen/editable-grid";
import { ActorGlyph } from "@/components/appearance/actor-glyph";
import { Panel } from "@/components/dashboard/panel";
import { StyledSurface } from "@/components/dashboard/styled-surface";
import { GaugeArc } from "@/components/charts/gauge-arc";
import { StackedColumns } from "@/components/charts/stacked-columns";
import { useOfferMintablePanels } from "@/components/appearance/mintable-panels";
import { OnlyWhenList } from "@/components/appearance/only-when";
import { builtInPanelQuestion } from "@/lib/built-in-panel";
import {
  describePanel,
  normalizePanel,
  panelIdFromWidgetId,
  panelWidgetId,
} from "@/lib/panel";
import {
  migrateStoredRows,
  replaceWidget,
  type WidgetRows,
} from "@/lib/screen-layout";

// Home: the Square dashboard-5 shell's page composition (Phase H), wired to
// live Convex data. Two reactive queries drive every tile — homeOverview.get
// (projects w/ rollups+health, my open/overdue/due-today, agents online,
// activity ticker) and myWork.listForCurrent (my open tasks) — so the page
// updates itself the moment a task completes, an agent heartbeats, or
// activity lands. No polling, no refresh button.

type Overview = NonNullable<
  ReturnType<typeof useQuery<typeof api.homeOverview.get>>
>;
type Project = Overview["projects"][number];
type TickerItem = Overview["ticker"][number];
type MyWorkRows = NonNullable<
  ReturnType<typeof useQuery<typeof api.myWork.listForCurrent>>
>;
type MyWorkRow = MyWorkRows[number];

// One chip language everywhere: outlined, with a small solid dot carrying
// the state colour. The pastel FILLS were a third colour system fighting the
// signal palette — a chip that shouts its fill reads as a button, and four
// shouting chips beside a saturated bento is three colour systems on one
// screen.
const HEALTH_CHIP: Record<
  NonNullable<Project["projectStatus"]>,
  { label: string; badge: string }
> = {
  on_track: { label: "On track", badge: DEEL_BADGE.success },
  at_risk: { label: "At risk", badge: DEEL_BADGE.warning },
  off_track: { label: "Off track", badge: DEEL_BADGE.danger },
  paused: { label: "Paused", badge: DEEL_BADGE.neutral },
};


// ── Home widgets ─────────────────────────────────────────────────────────
// Each distinct block on Home has a stable id; the user's saved layout
// (userSettings.homeWidgets) is the ordered list of VISIBLE ids — absence
// means hidden, null/unset means this default. `span` slots widgets into
// the shared lg:grid-cols-3 grid (static classes so Tailwind sees them);
// the default order reproduces the original page composition exactly.
const WIDGETS = [
  { id: "stats", title: "Your work", span: "lg:col-span-3" },
  { id: "today", title: "Your tasks", span: "lg:col-span-2" },
  { id: "activity", title: "Pulse", span: "" },
  { id: "projects", title: "Projects", span: "lg:col-span-3" },
  { id: "live", title: "Activity", span: "lg:col-span-2" },
  { id: "agents", title: "Agents", span: "" },
] as const;
type BuiltInId = (typeof WIDGETS)[number]["id"];
/**
 * A slot on Home: a built-in's id, or `custom:<panel id>`.
 *
 * It used to be the union of the six built-in ids, and that type was the reason
 * choosing a chart shape on Home could not land anywhere — `order` dropped
 * every id the registry did not know, so a panel written for this screen was
 * filtered out of the layout the moment it was read back.
 */
type WidgetId = string;
const DEFAULT_LAYOUT: WidgetId[] = WIDGETS.map((w) => w.id);
const WIDGET_BY_ID = new Map<string, (typeof WIDGETS)[number]>(
  WIDGETS.map((w) => [w.id, w]),
);
const HOME_GRID_ID = "home-grid";
/** What per-screen state calls this screen — see the prop on `EditableGrid`. */
const HOME_SCREEN_KEY = "home";
/** The registry's span strings, as the numbers the shared grid speaks. */
const SPAN_OF: Record<BuiltInId, 1 | 2 | 3> = {
  stats: 3,
  today: 2,
  activity: 1,
  projects: 3,
  live: 2,
  agents: 1,
};
/** A panel someone authored has no designed width; one column is its start. */
function spanOf(id: WidgetId): 1 | 2 | 3 {
  return SPAN_OF[id as BuiltInId] ?? 1;
}

// ── How tall each block starts ───────────────────────────────────────────
//
// A default that needs scrolling on first load is the bug. Every block used to
// start at one row — 168px — and every block's content is taller than that:
// Today's tasks is 305px, the chart 316px, Projects 458px, Live 469px. Since
// the packer took over, a tile clips and scrolls what does not fit, which is
// the correct behaviour for a box somebody chose and a terrible default for a
// box nobody chose. A brand-new account landed on a stat card sliced through
// its own number and a chart showing one black stub of its tallest bar.
//
// So these are measured, not guessed (scripts/measure-home.mjs frees each
// tile's box and reads what its content actually wants), and they are measured
// at BOTH shapes this screen has. Height cannot be one number: at three
// columns the stat row is 94px of content and at one column the same four
// cards are 424px. The index is the column count the grid is drawing, which is
// also what decides how wide each block is — a block's own span is capped by
// it — so one table answers for a phone, a split window and a desktop without
// a second layout model.
//
// A row is 6rem plus a 1.5rem gap: 1 → 96px, 2 → 216, 3 → 336, 4 → 456,
// 5 → 576, 6 → 696, and 6 is the ceiling the grid enforces. The unit halved
// because the old floor — 168px — was nearly twice the height of the shortest
// thing on this screen, so the stat row shipped with 74px of nothing under
// every number and no drag could take it back. 96 is what the stat row
// actually measures at three columns, which is the point: the floor of the
// ladder is the shortest real tile. Where content exceeds 696 (Projects at
// one and two columns is 749) the tallest honest row is what it gets.
//
// This is a DEFAULT, never a write: it lands in the tile, not in the layout,
// so nothing is persisted and a redesign of a block still reaches everyone who
// never resized it. Anyone who has dragged a corner keeps their own height.
const DEFAULT_ROWS: Record<BuiltInId, [one: WidgetRows, two: WidgetRows, three: WidgetRows]> = {
  //          1 col  2 cols  3 cols   (measured: 365/365/260 · 462/309/309 …)
  //          1 col  2 cols  3 cols — neighbours share heights so the grid's
  //          bottoms LINE UP: today==activity, live==agents at three columns.
  // One row taller at every width than the ladder used to say: the bento is
  // 526px of content at a phone, 477 in a split window and 358 full-width,
  // against boxes of 456/456/336 — the figure and Next up collided inside
  // the scrollbox (scripts/measure-home.mjs flags all three widths). Full
  // width it shares no row, so no bottom-alignment pair moves with it.
  stats: [5, 5, 4],
  today: [5, 4, 4],
  activity: [4, 4, 4],
  // 6 at two columns since the outlined health chips added ~16px per card
  // (measured 592 in a 576 box); the cards stretch (auto-rows-fr), so the
  // extra row distributes into them rather than pooling as a dead band.
  // 5 at one column for the same reason as stats: 490px of cards in a 456
  // box left the second card cut mid-figure.
  projects: [5, 6, 4],
  live: [5, 4, 4],
  agents: [3, 3, 4],
};
/** Mirrors the grid's own thresholds (Tailwind's `@md` 28rem, `@3xl` 48rem). */
function columnsFor(gridWidth: number): 1 | 2 | 3 {
  if (gridWidth >= 48 * 16) return 3;
  if (gridWidth >= 28 * 16) return 2;
  return 1;
}
/**
 * The height a block starts at, before anyone has resized anything.
 *
 * An authored panel gets one row: nothing here knows what it draws, and a
 * panel that arrives too tall is a panel the reader can see and pull taller,
 * while one that arrives with 400px of white under it looks broken.
 */
function defaultRowsOf(id: WidgetId, columns: 1 | 2 | 3): WidgetRows {
  const row = DEFAULT_ROWS[id as BuiltInId];
  return row ? row[columns - 1] : 1;
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// The one "New task" affordance across the shell: opens the ⌘K command
// palette, which already knows how to create a task (sidebar's + menu and
// search button do the same).
function openCommandPalette() {
  window.dispatchEvent(new CustomEvent("open-command-palette"));
}

export default function DashboardHome() {
  // Due dates are local-midnight stamps; the server needs OUR day boundary
  // to bucket overdue/due-today/completions correctly.
  const overview = useQuery(api.homeOverview.get, { todayStart: startOfToday() });
  const myWork = useQuery(api.myWork.listForCurrent, {});
  // Kept solely for the "waiting to connect" card — homeOverview doesn't
  // expose lastSeenAt, and "never connected" is the one signal that query
  // doesn't carry.
  const agents = useQuery(api.agents.listForCurrentUser, {});
  const settings = useQuery(api.userSettings.current, {});
  const setHomeWidgets = useMutation(api.userSettings.setHomeWidgets);
  const { user } = useUser();
  const { toast } = useToast();

  // Home stands in no space, so a panel here belongs to the reader themselves.
  // The same scope `useBuilderScope` falls back to, so a card built from the
  // studio anywhere with no active space lands where these do.
  const scope = useMemo(
    () =>
      user?.id ? { scopeType: "user" as const, scopeId: user.id } : null,
    [user?.id],
  );
  const panelRows = useQuery(
    api.uiComponents.listForScope,
    scope ? scope : "skip",
  );
  const panelsById = useMemo(
    () => new Map((panelRows ?? []).map((r) => [r.componentId as string, r])),
    [panelRows],
  );

  // What shape the grid is in right now. Measured from the grid's own box
  // rather than the window's, for the reason the grid itself measures: the
  // shell's nav can be open, collapsed, floating or docked, so the same window
  // draws a different number of columns and the default heights have to follow
  // the space a block actually has. 1024 until the first measurement lands, so
  // a desktop never flashes a phone's heights on its way to the real answer.
  const [gridBoxRef, { width: gridWidth }] = useMeasure();
  const gridColumns = columnsFor(gridWidth || 1024);

  const [customizing, setCustomizing] = useState(false);
  // Local optimistic layout: render the just-clicked order immediately;
  // the server round-trip (settings) reconciles behind it.
  const [draft, setDraft] = useState<WidgetId[] | null>(null);
  const [spanDraft, setSpanDraft] = useState<Partial<
    Record<WidgetId, 1 | 2 | 3>
  > | null>(null);
  const [rowDraft, setRowDraft] = useState<Partial<
    Record<WidgetId, WidgetRows>
  > | null>(null);

  const order = useMemo<WidgetId[]>(() => {
    const source = draft ?? settings?.homeWidgets ?? null;
    if (!source) return DEFAULT_LAYOUT;
    // Drop unknown ids (future/renamed widgets) and dupes defensively.
    const seen = new Set<string>();
    const out: WidgetId[] = [];
    for (const id of source) {
      if (seen.has(id)) continue;
      const panelId = panelIdFromWidgetId(id);
      if (panelId) {
        // Panels are dropped only once we KNOW they are gone. While the list
        // is still loading every authored panel would look unknown, and a save
        // in that window — a drag, a resize — would write the pruned order
        // back and delete them from the screen for good.
        if (panelRows !== undefined && !panelsById.has(panelId)) continue;
      } else if (!WIDGET_BY_ID.has(id)) {
        continue;
      }
      out.push(id);
      seen.add(id);
    }
    return out;
  }, [draft, settings, panelRows, panelsById]);

  const spans: Partial<Record<string, 1 | 2 | 3>> =
    spanDraft ??
    ((settings?.homeWidgetSpans ?? {}) as Partial<Record<string, 1 | 2 | 3>>);
  // How tall each block is. Absent means "whatever it was designed at", which
  // is what keeps a layout sparse and lets a redesign of a block still reach
  // someone who never resized it.
  const rows: Partial<Record<string, WidgetRows>> =
    rowDraft ??
    // Through the unit migration: rows saved before the 6rem row unit are in
    // 10.5rem units and would otherwise render every resized panel at ~60%
    // of the height its owner chose.
    migrateStoredRows(settings?.homeWidgetRows);

  /** This screen's arrangement in the shared layout vocabulary. */
  const layout = {
    widgets: order.map((id) => ({
      id,
      span: spans[id] ?? spanOf(id),
      ...(rows[id] ? { rows: rows[id] } : {}),
    })),
  };

  // Offer the built-ins the studio can mint from. Every hook runs before the
  // skeleton returns below; the closures read `order`/`spans`/`rows` from this
  // render and are only *called* later, through the registry's ref.
  useOfferMintablePanels(
    scope
      ? {
          gridId: HOME_GRID_ID,
          scope,
          questionFor: builtInPanelQuestion,
          replace: (widgetId, componentId) => {
            const next = replaceWidget(
              layout,
              widgetId,
              panelWidgetId(componentId),
            );
            applyLayout(
              next.widgets.map((w) => w.id),
              Object.fromEntries(next.widgets.map((w) => [w.id, w.span])),
              Object.fromEntries(
                next.widgets.flatMap((w) => (w.rows ? [[w.id, w.rows]] : [])),
              ),
            );
          },
        }
      : null,
  );

  // Wait for settings too, so a saved custom layout never flashes the
  // default order on first paint.
  //
  // Deliberately NOT waiting on the authored panels as well. They arrive over
  // the same subscription as `settings` and land with it in practice, so the
  // wait would buy a frame — and it would make the whole screen depend on one
  // more query answering, which is how a surface ends up permanently blank in
  // a harness (or for anyone whose scope resolves late). The case that
  // actually matters is destructive rather than cosmetic — a save landing
  // while the list is still loading — and `order` above handles it by keeping
  // unresolved panel ids until it KNOWS they are gone.
  if (overview === undefined || settings === undefined) {
    return <DashboardSkeleton />;
  }
  if (overview === null) {
    return null;
  }

  function persist(
    next: WidgetId[] | null,
    nextSpans?: Partial<Record<WidgetId, 1 | 2 | 3>> | null,
    nextRows?: Partial<Record<WidgetId, WidgetRows>> | null,
  ) {
    void setHomeWidgets({ homeWidgets: next, spans: nextSpans, rows: nextRows })
      .then(() => {
        // The mutation result is reflected in `settings` by the time this
        // resolves — dropping the draft lets layout changes from other
        // tabs/devices show up instead of being masked forever. Only clear
        // if no newer edit superseded this one mid-flight.
        setDraft((cur) => (cur === next ? null : cur));
        setSpanDraft((cur) => (cur === nextSpans ? null : cur));
        setRowDraft((cur) => (cur === nextRows ? null : cur));
      })
      .catch((e) => {
        setDraft(null); // fall back to the server's layout
        setSpanDraft(null);
        setRowDraft(null);
        toast(errorMessage(e, "Couldn't save your Home layout"), {
          kind: "error",
        });
      });
  }
  function applyLayout(
    next: WidgetId[],
    nextSpans?: Partial<Record<WidgetId, 1 | 2 | 3>>,
    nextRows?: Partial<Record<WidgetId, WidgetRows>>,
  ) {
    setDraft(next);
    if (nextSpans) setSpanDraft(nextSpans);
    if (nextRows) setRowDraft(nextRows);
    persist(next, nextSpans, nextRows);
  }
  function resetLayout() {
    setDraft([...DEFAULT_LAYOUT]);
    setSpanDraft(null);
    setRowDraft(null);
    persist(null, null, null);
  }

  // The shelf: built-ins that are off the screen, then panels this reader owns
  // that aren't on it. A swapped-out built-in has to be recoverable, and so
  // does a panel they removed — otherwise choosing a shape is a one-way door.
  const hidden = [
    ...DEFAULT_LAYOUT.filter((id) => !order.includes(id)),
    ...(panelRows ?? [])
      .map((r) => panelWidgetId(r.componentId as string))
      .filter((id) => !order.includes(id)),
  ];

  const waiting = agents
    ? [...agents.personal, ...agents.workspaces.flatMap((w) => w.agents)].filter(
        (a) => a.status === "active" && a.lastSeenAt === undefined,
      )
    : [];

  // Re-alias so the non-null narrowing survives into the closure below.
  const ov = overview;
  const sc = scope;
  /** What a slot is called, or null if nothing here can draw it. */
  function titleOf(id: WidgetId): string | null {
    const panelId = panelIdFromWidgetId(id);
    if (panelId) {
      const row = panelsById.get(panelId);
      // The definition's own title, read through the panel model — the same
      // one the renderer uses, so the tile's heading and its contents can
      // never disagree about what the panel is called.
      return row ? normalizePanel(row.definition).title : null;
    }
    return WIDGET_BY_ID.get(id)?.title ?? null;
  }
  /** The one-line reading of an authored panel, for the shelf. */
  function describeShelfPanel(id: WidgetId): React.ReactNode {
    const panelId = panelIdFromWidgetId(id);
    const row = panelId ? panelsById.get(panelId) : undefined;
    if (!row) return null;
    return (
      <span className="mt-0.5 block max-w-[22rem] truncate text-tiny font-normal text-muted-foreground">
        {describePanel(normalizePanel(row.definition))}
      </span>
    );
  }
  function widgetContent(id: WidgetId): React.ReactNode {
    const panelId = panelIdFromWidgetId(id);
    if (panelId) {
      const row = panelsById.get(panelId);
      if (!row || !sc) return null;
      return (
        <Panel
          definition={row.definition}
          scopeType={sc.scopeType}
          scopeId={sc.scopeId}
          // Scoped to the screen as well as the panel, the same way the project
          // screen does it: the same panel on two screens is two places you
          // look, and "since I last looked" is a fact about the looking.
          panelId={`${HOME_GRID_ID}:${id}`}
        />
      );
    }
    // A built-in block is drawn on the SAME surface an authored panel is.
    //
    // Each of these used to write its own `bento rounded-2xl bg-card` and read
    // nothing, so on the one screen everybody opens you could press Customise,
    // click "Today's tasks", watch the sheet correctly title itself "Style
    // Today's tasks", pick a card — and see nothing happen. The studio worked;
    // there was simply nowhere on this screen for a pick to land. See
    // `StyledSurface`.
    //
    // `pad={false}` throughout: every one of these draws a header band and
    // rows that run to the card's edge, and the style's padding would inset
    // their own dividers off it.
    const surfaced = (node: React.ReactNode) => (
      <StyledSurface pad={false} panelId={`${HOME_GRID_ID}:${id}`}>
        {node}
      </StyledSurface>
    );
    switch (id) {
      case "stats":
        return surfaced(
          <StatsCards
            completions7d={ov.completions7d}
            me={ov.me}
            nextTask={
              myWork && myWork.length > 0
                ? {
                    title: myWork[0].title,
                    href: `/dashboard/l/${myWork[0].listId}/t/${myWork[0]._id}`,
                  }
                : null
            }
          />,
        );
      case "today":
        return surfaced(<TodaysTasks rows={myWork ?? undefined} />);
      case "activity":
        return surfaced(
          <PulsePanel
            completions7d={ov.completions7d}
            me={ov.me}
            projects={ov.projects}
          />,
        );
      case "projects":
        return surfaced(
          <ProjectCards projects={ov.projects} totalProjects={ov.totalProjects} />,
        );
      case "live":
        return surfaced(<LiveFeed ticker={ov.ticker} />);
      case "agents":
        return surfaced(<AgentsCard agents={ov.agents} />);
    }
  }

  return (
    <div className="space-y-6">
      <Suspense fallback={null}>
        <WelcomeReveal />
      </Suspense>

      {/* The greeting IS the capsule — the reference's welcome bar says
          "Welcome!" in the chrome, not in a section below it. The two page
          actions ride the capsule for the same reason: one bar owns the top. */}
      <PageHeader headline={false} hideTitle title="Home" />

      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-balance text-[1.75rem] font-semibold leading-tight tracking-tight text-foreground">
            {greetingFor(user?.firstName)}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {deelLongDate()}
            {overview?.me ? (
              <span className="hidden @xl:inline">
                {" · "}
                {overview.me.dueToday} due today
                {overview.me.overdue > 0
                  ? ` · ${overview.me.overdue} overdue`
                  : ""}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setCustomizing((v) => !v)}
            className="tap-target hidden h-9 items-center rounded-[var(--ui-radius-control)] px-3 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground sm:inline-flex"
          >
            {customizing ? "Done" : "Customize homepage"}
          </button>
          <Button size="sm" className="h-9 gap-1.5" onClick={openCommandPalette}>
            <Plus className="size-4" />
            <span className="hidden sm:inline">New task</span>
          </Button>
        </div>
      </div>

      <InviteCards />

      {/* AnimatePresence so the card resolves with a satisfying collapse
          the moment the agent's first heartbeat lands (live via Convex). */}
      <AnimatePresence initial={false}>
        {waiting.length > 0 && (
          <motion.div
            key="waiting-card"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, height: 0, marginTop: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
            className="overflow-hidden"
          >
            <Link
              href="/dashboard/agents"
              className="lift relative flex items-center gap-4 rounded-2xl panel p-5"
            >
              <span className="relative inline-flex h-12 w-12 flex-shrink-0" aria-hidden>
                <ActorGlyph seed={waiting[0]._id} name={waiting[0].name} size="lg" isAgent />
                {/* Small pending dot — the "dot" the copy references, which
                    turns green on first heartbeat. A gentle pulse signals
                    waiting without the whole avatar strobing. */}
                <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-card">
                  <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-signal-yellow" />
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">
                  {waiting[0].name} is waiting to connect
                </span>
                <span className="block text-sm text-muted-foreground">
                  Copy its ready-made setup from the Agents page. The dot turns
                  green the moment it checks in.
                </span>
              </span>
              <ArrowRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            </Link>
          </motion.div>
        )}
      </AnimatePresence>

      {/* The blocks, on the same physical grid every screen uses: hold one
          until the grid wobbles (or hit Customize) and move it. Hidden blocks
          wait on a shelf below and are dragged back on. */}
      {/* The box the defaults are measured against. It is the grid's own
          width — the grid is `w-full` inside it — so "how many columns is
          this drawing" is answered once, the same way the grid answers it. */}
      <div ref={gridBoxRef}>
      <EditableGrid
        gridId={HOME_GRID_ID}
        // There is exactly one Home per person and its arrangement lives in
        // `userSettings`, so it has no `screenLayouts` key to borrow. The word
        // is the key: per-screen rows are already keyed by owner, so "home"
        // cannot collide with anybody else's.
        screenKey={HOME_SCREEN_KEY}
        editing={customizing}
        onEditingChange={setCustomizing}
        // Everything this screen can draw, placed or not — see the prop.
        // Hidden blocks are already resolvable by title and content, so the
        // whole set costs an element that is never mounted, and it is what lets
        // a condition preview the panel it governs before it is placed.
        tiles={[...order, ...hidden].flatMap((id) => {
          const title = titleOf(id);
          if (title === null) return [];
          const span = spans[id] ?? spanOf(id);
          return [
            {
              id,
              span,
              title,
              // Every block can be narrowed to one column or run the full
              // width. The designed span is only where it starts.
              minSpan: 1 as const,
              maxSpan: 3 as const,
              // Tall enough for what it draws, at the width it is being drawn
              // at. Overridden by anything the reader saved (`layout.widgets`
              // carries their rows); this is only where it starts.
              rows: defaultRowsOf(id, gridColumns),
              content: widgetContent(id),
            },
          ];
        })}
        layout={layout}
        onChange={(next, opts) => {
          applyLayout(
            next.widgets.map((w) => w.id),
            Object.fromEntries(
              next.widgets.map((w) => [w.id, w.span]),
            ) as Partial<Record<WidgetId, 1 | 2 | 3>>,
            // Heights travel with widths, or dragging a block taller is
            // dropped on the way to the server and snaps back on the next
            // subscription update.
            Object.fromEntries(
              next.widgets.flatMap((w) => (w.rows ? [[w.id, w.rows]] : [])),
            ) as Partial<Record<WidgetId, WidgetRows>>,
          );
          if (opts?.droppedAt !== undefined) {
            const grid = document.getElementById(HOME_GRID_ID);
            if (grid) {
              wake(
                Array.from(grid.querySelectorAll("[data-tile]")),
                opts.droppedAt,
              );
            }
          }
        }}
        emptyMessage={
          <div className="rounded-2xl panel px-6 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              Every Home block is hidden.
            </p>
            <button
              type="button"
              onClick={() => setCustomizing(true)}
              className="mt-2 text-sm font-medium underline-offset-2 hover:underline"
            >
              Customise your Home
            </button>
          </div>
        }
      >
        {(editing) =>
          editing ? (
            <div className="rounded-2xl panel p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 text-tiny font-medium uppercase tracking-wider text-muted-foreground">
                  {hidden.length > 0
                    ? "Drag a block back onto your Home"
                    : "Everything is on your Home"}
                </span>
                <button
                  type="button"
                  onClick={resetLayout}
                  className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Reset layout
                </button>
              </div>
              {hidden.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {hidden.map((id) => (
                    <TrayTile
                      key={id}
                      gridId={HOME_GRID_ID}
                      onDrop={(slot) => {
                        const next = [...order];
                        next.splice(slot, 0, id);
                        applyLayout(next);
                      }}
                      onClick={() => applyLayout([...order, id])}
                      className="bento-tile cursor-grab px-3 py-2 text-left text-sm active:cursor-grabbing"
                    >
                      + {titleOf(id) ?? "Panel"}
                      {/* An authored panel says what it asks. Two of them
                          called "Recent activity" are otherwise
                          indistinguishable on a shelf. */}
                      {describeShelfPanel(id)}
                    </TrayTile>
                  ))}
                </div>
              )}
              {/* The blocks that are only here sometimes, and the way out of
                  each — beside the hidden ones, because they answer the same
                  question. A condition is the one setting you cannot reach by
                  pointing at what it governs: when it is false there is
                  nothing on screen to point at. */}
              <OnlyWhenList screenKey={HOME_SCREEN_KEY} />
            </div>
          ) : null
        }
      </EditableGrid>
      </div>
    </div>
  );
}

// One-time reveal after onboarding (?welcome=1): the mark breathes in, one
// line lands, then the curtain lifts to the greeting. Click anywhere to skip.
function WelcomeReveal() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const arrived = searchParams.get("welcome") === "1";
  const [show, setShow] = useState(arrived);

  const dismiss = useMemo(
    () => () => {
      setShow(false);
      router.replace("/dashboard");
    },
    [router],
  );

  useEffect(() => {
    if (!arrived) return;
    const t = setTimeout(dismiss, 2600);
    return () => clearTimeout(t);
  }, [arrived, dismiss]);

  return (
    <AnimatePresence>
      {show && (
        <motion.button
          type="button"
          aria-label="Continue"
          onClick={dismiss}
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, filter: "blur(6px)" }}
          transition={{ duration: 0.6, ease: EASE }}
          className="fixed inset-0 z-[60] flex cursor-default flex-col items-center justify-center gap-6 bg-background"
        >
          <motion.span
            aria-hidden
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 200, damping: 18 }}
            className="inline-block h-8 w-8 rounded-lg bg-foreground"
          />
          <motion.p
            initial={{ opacity: 0, y: 12, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.6, ease: EASE, delay: 0.35 }}
            className="text-2xl font-bold tracking-tight sm:text-3xl"
          >
            Your <GradientText>mission control</GradientText> is ready.
          </motion.p>
        </motion.button>
      )}
    </AnimatePresence>
  );
}

function StatsCards({
  me,
  completions7d,
  nextTask,
}: {
  me: Overview["me"];
  completions7d?: number[];
  nextTask?: { title: string; href: string } | null;
}) {
  const week = completions7d ?? [];
  const doneThisWeek = week.reduce((a, b) => a + b, 0);
  const activeDays = week.filter((v) => v > 0).length;

  // Armed = the cards have scrolled into view. Figures mount at zero and
  // ROLL UP to their real values on arrival (the odometer's spring carries
  // it; reduced motion jumps straight there), and each card fires one
  // staggered shine sweep — the entrance performs where somebody is
  // looking, never three viewports above them.
  const [armed, setArmed] = useState(false);
  const armRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = armRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setArmed(true);
          io.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const shown = (n: number) => (armed ? n : 0);

  const metrics = [
    { label: "Open", value: me.open, hint: me.open === 1 ? "task" : "tasks" },
    { label: "Due today", value: me.dueToday, hint: "assigned to you" },
    {
      label: "Overdue",
      value: me.overdue,
      hint: me.overdue === 1 ? "needs you" : "need you",
      warn: me.overdue > 0,
    },
    {
      label: "Done · 7 days",
      value: doneThisWeek,
      hint: `${activeDays} ${activeDays === 1 ? "day" : "days"}`,
    },
  ] as const;

  return (
    <div ref={armRef} className="flex h-full min-w-0 flex-col">
      <DeelWidgetHeader
        title="Your work"
        subtitle={
          nextTask ? `Next up: ${nextTask.title}` : "Nothing is waiting on you"
        }
        href="/dashboard/my-work"
      />
      <div className="grid flex-1 grid-cols-2 divide-x divide-y divide-border border-t border-border @xl:grid-cols-4 @xl:divide-y-0">
        {metrics.map((m) => (
          <Link
            key={m.label}
            href="/dashboard/my-work"
            className="flex min-h-0 flex-col justify-center px-5 py-4 hover:bg-muted/40"
          >
            <p className="text-xs font-medium text-muted-foreground">{m.label}</p>
            <p
              className={cn(
                "mt-1 text-[1.75rem] font-semibold leading-none tracking-tight",
                "warn" in m && m.warn && "text-[var(--badge-danger-fg)]",
              )}
            >
              <Counter
                value={shown(m.value)}
                places={placesFor(m.value)}
                fontSize={28}
                padding={2}
                fontWeight={600}
              />
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">{m.hint}</p>
          </Link>
        ))}
      </div>
      <DeelWidgetFooter href="/dashboard/my-work">View my work</DeelWidgetFooter>
    </div>
  );
}

// Today's tasks: my open tasks due today or overdue (from myWork, the same
// query "My work" uses), capped to 8 with working complete-checkboxes.
function TodaysTasks({ rows }: { rows: MyWorkRows | undefined }) {
  const { toast } = useToast();
  const toggleComplete = useMutation(
    api.tasks.toggleComplete,
  ).withOptimisticUpdate((localStore, args) => {
    // My-work only ever lists open tasks, so completing one just drops it
    // from the local list instantly; the server reconciles (and reverts on
    // a refused completion — blocked/needs-approval).
    const current = localStore.getQuery(api.myWork.listForCurrent, {});
    if (!current) return;
    localStore.setQuery(
      api.myWork.listForCurrent,
      {},
      current.filter((t) => t._id !== args.taskId),
    );
  });

  const dueTasks = useMemo(() => {
    if (!rows) return [];
    const tomorrowStart = startOfToday() + 24 * 60 * 60 * 1000;
    return rows
      .filter((r) => r.dueDate !== undefined && r.dueDate < tomorrowStart)
      .slice(0, 7);
  }, [rows]);

  async function complete(row: MyWorkRow) {
    try {
      await toggleComplete({ taskId: row._id });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      toast(
        raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() ||
          "Couldn't complete this task",
        { kind: "error" },
      );
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <DeelWidgetHeader
        title="Your tasks"
        subtitle={
          dueTasks.length > 0
            ? `${dueTasks.length} due today`
            : "Nothing due today"
        }
        href="/dashboard/my-work"
      />
      {rows === undefined ? (
        <div className="divide-y divide-border">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse bg-muted/20" />
          ))}
        </div>
      ) : dueTasks.length === 0 ? (
        <EmptyState
          compact
          title="Nothing due"
          message="No open tasks are due today or overdue. Enjoy the calm."
        />
      ) : (
        <Stagger className="divide-y divide-border">
          {dueTasks.map((row) => {
            const overdue =
              row.dueDate !== undefined && row.dueDate < startOfToday();
            return (
              <StaggerItem key={row._id}>
                {/* The title wins the row.
                    Every part of this row used to be flex-shrink-0 except the
                    title, so on a phone the chip and the date took their full
                    width first and left the title 15px — one row rendered as
                    literally "R.". Nothing is hidden to fix it: the title
                    carries a 12rem basis, so when the panel is a phone wide
                    the meta drops to its own line underneath and the title
                    gets the whole width, and when there is room they sit on
                    one line exactly as before. */}
                <div className="flex items-start gap-3 px-5 py-2.5 transition-colors hover:bg-muted/20">
                  <Checkbox
                    className="mt-0.5 flex-shrink-0"
                    aria-label={`Mark "${row.title}" complete`}
                    onCheckedChange={() => complete(row)}
                  />
                  {/* The whole row is one target.
                      The link used to wrap the TITLE alone, so the list, the
                      priority and the due date — same row, same task, sitting
                      right next to it — did nothing at all, and the part that
                      did was a 20px band inside a 39px row. `.tap-row` takes
                      the rest of the way to the 44px floor by making the row
                      taller on touch rather than by hanging a halo off it,
                      which would reach into the task above and below. The
                      underline moves to `group-hover` so hovering still marks
                      the title as the link rather than underlining the meta
                      along with it. */}
                  <Link
                    href={`/dashboard/l/${row.listId}/t/${row._id}`}
                    className="tap-row group flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5"
                  >
                    <span className="min-w-0 flex-1 basis-48 text-sm font-medium line-clamp-2 group-hover:underline">
                      {row.title}
                    </span>
                    {/* Outlined tags, the same register the panel renderer's
                        rows use — `ui-chip` so the reader's chip-shape choice
                        reaches them too. The list name used to be a filled
                        grey box and the date bare text, which made two facts
                        of the same importance look like two different kinds
                        of thing. */}
                    <span className="flex flex-shrink-0 items-center gap-1.5">
                      <span className="ui-chip whitespace-nowrap px-2 py-0.5 text-tiny text-muted-foreground">
                        {row.listName}
                      </span>
                      {row.priority && <PriorityDot priority={row.priority} />}
                      {row.dueDate !== undefined && (
                        <span
                          className={cn(
                            "ui-chip ui-figure whitespace-nowrap px-2 py-0.5 text-tiny font-medium",
                            overdue
                              ? "border-danger/40 text-danger"
                              : "text-muted-foreground",
                          )}
                        >
                          {formatDate(row.dueDate)}
                        </span>
                      )}
                    </span>
                  </Link>
                </div>
              </StaggerItem>
            );
          })}
        </Stagger>
      )}
      <DeelWidgetFooter href="/dashboard/my-work">View all tasks</DeelWidgetFooter>
    </div>
  );
}

// Recent activity: task.completed events per day over the last 7 days,
// derived client-side from the (capped) home ticker — no new server query.
// Honestly labeled "Recent activity" rather than "Performance" since the
// ticker only carries the newest ~10 events across every scope.
/**
 * The pulse panel — the reference's top module, with our numbers in it.
 *
 * Cyberlock opens its content with ONE wide panel holding a semicircular
 * gauge, a short list, and a multicoloured stacked chart. This is that panel:
 * the gauge reads the week (done against done-plus-open, which is the honest
 * "how is it going" a score implies), and the stacked columns are the
 * portfolio — one column per project, its tasks stacked by state in the four
 * signal colours. Multicoloured because the STATES are four real categories,
 * not because the reference was; the reference is why they are lozenges.
 */
function PulsePanel({
  completions7d,
  me,
  projects,
}: {
  completions7d?: number[];
  me: Overview["me"];
  projects: Project[];
}) {
  const done = (completions7d ?? []).reduce((a, b) => a + b, 0);
  // Six columns, and a label is abbreviated DELIBERATELY (first three
  // letters) rather than ellipsised mid-word by CSS — "Onb…" is not a label,
  // "Onb" at least admits to being an abbreviation.
  const columns = projects.slice(0, 6).map((project) => {
    const word = project.name.split(/[ —–-]/)[0] || project.name;
    return {
      label: word.length > 7 ? word.slice(0, 3) : word,
      segments: [
        { value: project.done, color: "var(--color-signal-lime)" },
        { value: project.inProgress, color: "var(--color-signal-teal)" },
        { value: project.dueSoon, color: "var(--color-signal-yellow)" },
        { value: project.overdue, color: "var(--color-danger)" },
      ],
    };
  });
  return (
    <div className="flex h-full min-w-0 flex-col">
      <DeelWidgetHeader title="Pulse" subtitle="Last 7 days" />
      <div className="grid min-h-0 flex-1 items-center gap-6 p-4 @xl:grid-cols-[minmax(10rem,1fr)_2fr]">
        <GaugeArc
          value={done}
          max={done + me.open}
          caption={`done · ${me.open} still open`}
          className="mx-auto w-full max-w-[13rem]"
        />
        <div className="min-w-0">
          <StackedColumns items={columns} height={116} />
          {/* The key, in the same four colours. A multicolour chart with no
              key is a mood; with one it is a reading. */}
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-micro uppercase tracking-[0.08em] text-muted-foreground @md:flex @md:flex-wrap @md:items-center">
            {(
              [
                ["done", "var(--color-signal-lime)"],
                ["in progress", "var(--color-signal-teal)"],
                ["due soon", "var(--color-signal-yellow)"],
                ["overdue", "var(--color-danger)"],
              ] as const
            ).map(([label, color]) => (
              <span key={label} className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="size-2 rounded-full"
                  style={{ backgroundColor: color }}
                />
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
function HealthChip({ status }: { status: Project["projectStatus"] }) {
  const chip = status ? HEALTH_CHIP[status] : null;
  if (!chip) return <span className="text-sm text-muted-foreground">—</span>;
  return <span className={chip.badge}>{chip.label}</span>;
}


/**
 * How many project rows fit the tallest box the grid will ever give this panel.
 *
 * The row ladder tops out at 3 rows = 552px, and `scripts/measure-home.mjs`
 * measured this block wanting 749px with TWELVE rows in it — so at every
 * viewport it reported SCROLLS, meaning "a block whose default is a lie". A
 * panel that cannot fit any legal height is not a sizing mistake, it is an
 * unbounded list in a bounded box, and no default can rescue it.
 *
 * Six is what fits: 552px less the header, the count and the "View all" strip
 * leaves ~456px, and a row (title, place, progress, timestamp) is ~76px.
 * The server still sends twelve; the extra ones were never visible, they were
 * painting over the panel underneath.
 *
 * Re-run `npm run gallery && node scripts/measure-home.mjs` after touching the
 * row's contents — if this block reports SCROLLS again, this number is wrong.
 */

/**
 * The project grid — the reference's campaign cards, carrying our projects.
 *
 * Everything structural about the reference card is here: the section heading
 * sits ON the slab (cards under a heading, never a table inside a card); each
 * card splits into a content cell and a figure cell with a hairline between
 * them; a footer band holds the action; the top-right corner is SCOOPED and
 * the control sits in the notch; and exactly one card — the one that needs
 * you soonest — is the lime one. The corner control is an open-link rather
 * than the reference's ⋮, because a menu button with no menu is a lie.
 */
function ProjectCards({
  projects,
  totalProjects,
}: {
  projects: Project[];
  totalProjects: number;
}) {
  const shown = projects.slice(0, 8);
  return (
    <div className="flex h-full min-w-0 flex-col">
      <DeelWidgetHeader
        title="Projects"
        subtitle={totalProjects === 1 ? "1 project" : `${totalProjects} projects`}
        href="/dashboard/projects"
      />
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto">
        {shown.length === 0 ? (
          <EmptyState
            compact
            title="No projects yet"
            message="Create a project and it will land in this table."
          />
        ) : (
          <table className="w-full min-w-[36rem] border-t border-border text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs font-medium text-muted-foreground">
                <th className="px-5 py-2.5 font-medium">Name</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Progress</th>
                <th className="px-3 py-2.5 font-medium">Due</th>
                <th className="px-5 py-2.5 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((project) => (
                <tr
                  key={project.listId}
                  className="border-b border-border last:border-b-0 hover:bg-muted/40"
                >
                  <td className="px-5 py-3">
                    <Link
                      href={`/dashboard/l/${project.listId}`}
                      className="block min-w-0"
                    >
                      <span className="block truncate font-medium text-foreground hover:underline">
                        {project.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {project.place}
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <HealthChip status={project.projectStatus} />
                      {project.overdue > 0 && (
                        <span className={DEEL_BADGE.danger}>
                          {project.overdue} overdue
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3 tabular-nums text-muted-foreground">
                    {project.done}/{project.total}
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">
                    {project.targetDate !== undefined
                      ? formatDate(project.targetDate)
                      : "—"}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {timeAgo(project.lastActivityAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <DeelWidgetFooter href="/dashboard/projects">
        View all projects
      </DeelWidgetFooter>
    </div>
  );
}
function LiveFeed({ ticker }: { ticker: TickerItem[] }) {
  const visible = ticker.slice(0, 7);
  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* The LED earns its light here the way it does on Due today: it
          pulses only while there is actually activity to read. */}
      <DeelWidgetHeader
        title="Activity"
        subtitle={visible.length > 0 ? "Live across your work" : "Quiet right now"}
      />
      {/* Fills the tile and scrolls when shrunk — the same contract as every
          other block, so a resized tile never shows a dead band below rows. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {visible.length === 0 ? (
          <EmptyState
            compact
            title="It's quiet"
            message="Activity across your projects will land here the moment it happens."
          />
        ) : (
          <ul className="space-y-3">
            <AnimatePresence initial={false}>
              {visible.map((e) => {
                const body = (
                  <>
                    <span className="font-medium">{e.actorName}</span>{" "}
                    {eventLabel(e.type)}
                    {e.entityTitle ? (
                      <>
                        {" "}
                        <span className="font-medium">{e.entityTitle}</span>
                      </>
                    ) : null}
                  </>
                );
                return (
                  <motion.li
                    key={e.id}
                    layout
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.4, ease: EASE }}
                    className="text-sm leading-snug"
                  >
                    {/* The timestamp is part of the entry, so it is part of
                        the target: the link used to stop at the sentence and
                        the line under it — same event, same destination — did
                        nothing. */}
                    {e.listId ? (
                      <Link
                        href={`/dashboard/l/${e.listId}`}
                        className="tap-row group block"
                      >
                        <span className="block group-hover:underline">
                          {body}
                        </span>
                        <span
                          className={cn(
                            INSTRUMENT_META,
                            "mt-1 block text-muted-foreground",
                          )}
                        >
                          {timeAgo(e.createdAt)}
                        </span>
                      </Link>
                    ) : (
                      <>
                        <span>{body}</span>
                        <span
                          className={cn(
                            INSTRUMENT_META,
                            "mt-1 block text-muted-foreground",
                          )}
                        >
                          {timeAgo(e.createdAt)}
                        </span>
                      </>
                    )}
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </div>
  );
}

function AgentsCard({ agents }: { agents: Overview["agents"] }) {
  const online = agents.filter((a) => a.online).length;
  const card = (
    <div className="flex h-full min-w-0 flex-col">
      <DeelWidgetHeader
        title="Agents"
        subtitle={
          agents.length > 0 ? `${online} online` : "No agents yet"
        }
        href="/dashboard/agents"
      />
      {/* Own scroll region + bottom padding clearing the resize grip's
          corner, so the last row is read, not bisected. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-8">
        {agents.length === 0 ? (
          <EmptyState
            compact
            title="No agents yet"
            message="Bring an agent online to see live presence here."
            action={
              <Link
                href="/dashboard/agents"
                className="text-sm font-medium hover:underline"
              >
                Go to Agents
              </Link>
            }
          />
        ) : (
          <Stagger className="space-y-1">
            {agents.map((a) => (
              <StaggerItem key={a.agentId}>
                <Link
                  href={`/dashboard/agents/${a.agentId}`}
                  className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted"
                >
                  <ActorGlyph seed={a.agentId} name={a.name} size="sm" isAgent />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">
                        {a.name}
                      </span>
                      <PresenceDot online={a.online} />
                    </span>
                    {a.statusText && (
                      <span className="block truncate text-xs italic text-muted-foreground">
                        {a.statusText}
                      </span>
                    )}
                  </span>
                </Link>
              </StaggerItem>
            ))}
          </Stagger>
        )}
      </div>
      <DeelWidgetFooter href="/dashboard/agents">View all agents</DeelWidgetFooter>
    </div>
  );
  return card;
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-6 w-32 animate-pulse rounded-full bg-muted" />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <div className="h-7 w-64 animate-pulse rounded-full bg-muted" />
          <div className="h-4 w-80 animate-pulse rounded-full bg-muted" />
        </div>
        <div className="h-9 w-28 animate-pulse rounded-md bg-muted" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-xl bg-muted/20"
          />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-3">
        <div className="h-72 animate-pulse rounded-xl bg-muted/20 lg:col-span-2" />
        <div className="h-72 animate-pulse rounded-xl bg-muted/20" />
      </div>
      <div className="h-64 animate-pulse rounded-xl bg-muted/20" />
    </div>
  );
}
