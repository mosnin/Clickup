"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useMeasure from "react-use-measure";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowRight,
  ArrowUpRight,
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
import { PageHeader } from "@/components/dashboard/page-header";
import { InviteCards } from "@/components/dashboard/invite-cards";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PriorityDot } from "@/components/dashboard/priority";
import { Button } from "@/components/ui/button";
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
import { NotchCard } from "@/components/dashboard/notch-card";
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
  { label: string; dot: string }
> = {
  on_track: { label: "On track", dot: "bg-signal-lime" },
  at_risk: { label: "At risk", dot: "bg-signal-yellow" },
  off_track: { label: "Off track", dot: "bg-danger" },
  paused: { label: "Paused", dot: "bg-muted-foreground/50" },
};


// ── Home widgets ─────────────────────────────────────────────────────────
// Each distinct block on Home has a stable id; the user's saved layout
// (userSettings.homeWidgets) is the ordered list of VISIBLE ids — absence
// means hidden, null/unset means this default. `span` slots widgets into
// the shared lg:grid-cols-3 grid (static classes so Tailwind sees them);
// the default order reproduces the original page composition exactly.
const WIDGETS = [
  { id: "stats", title: "Overview stats", span: "lg:col-span-3" },
  { id: "today", title: "Today's tasks", span: "lg:col-span-2" },
  { id: "activity", title: "Recent activity", span: "" },
  { id: "projects", title: "Projects", span: "lg:col-span-3" },
  { id: "live", title: "Live feed", span: "lg:col-span-2" },
  { id: "agents", title: "Agents online", span: "" },
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
  stats: [4, 4, 3],
  today: [5, 4, 4],
  activity: [4, 4, 4],
  // 6 at two columns since the outlined health chips added ~16px per card
  // (measured 592 in a 576 box); the cards stretch (auto-rows-fr), so the
  // extra row distributes into them rather than pooling as a dead band.
  projects: [4, 6, 4],
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
        // Not surfaced, and the exception is the honest one: this widget is a
        // ROW of four cards rather than a card, so a frame around it would be
        // a card containing cards. Its members are already the surface.
        return (
          <StatsCards
            completions7d={ov.completions7d}
            me={ov.me}
            // The one thing on the whole screen that says what to do NEXT
            // rather than how much there is. Same source as Today's tasks —
            // the soonest-due open task assigned to you.
            nextTask={
              myWork && myWork.length > 0
                ? {
                    title: myWork[0].title,
                    href: `/dashboard/l/${myWork[0].listId}/t/${myWork[0]._id}`,
                  }
                : null
            }
          />
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
        // NOT surfaced: the reference's campaign grid is cards ON the slab
        // under a section heading, not cards inside a card.
        return (
          <ProjectCards projects={ov.projects} totalProjects={ov.totalProjects} />
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
      <PageHeader
        headline={false}
        title={
          user?.firstName ? `Welcome back, ${user.firstName}.` : "Welcome back."
        }
        context={
          overview?.me ? (
            <span className="hidden truncate @2xl:inline">
              {overview.me.dueToday} due today · {overview.me.overdue} overdue
            </span>
          ) : undefined
        }
        actions={
          <>
            {/* Hidden on phones: the sidebar footer carries the same
                control, and a 390px capsule cannot afford a text link — it
                was what folded the bar into a two-row blob. */}
            <button
              type="button"
              onClick={() => setCustomizing((v) => !v)}
              className="tap-target hidden text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline sm:block"
            >
              {customizing ? "Done" : "Customise"}
            </button>
            <Button size="sm" className="h-9 gap-1.5" onClick={openCommandPalette}>
              <Plus className="size-4" />
              <span className="hidden sm:inline">New task</span>
            </Button>
          </>
        }
      />

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
  const doneThisWeek = (completions7d ?? []).reduce((a, b) => a + b, 0);

  return (
    // THREE columns above @3xl, matching the outer grid's own thirds, with
    // the SAME 24px gap the grid uses between tiles (gap-6 = ROW_GAP). This
    // is what makes the hero's internal seams land exactly on the seams of
    // the panels below it — "the cards don't line up" was this block running
    // its own four-column, 12px world inside a three-column, 24px page.
    <Stagger className="grid h-full grid-cols-2 grid-rows-2 gap-6 @3xl:grid-cols-3">
      {/* ── The headline block ─────────────────────────────────────────── */}
      <StaggerItem lift className="col-span-2 row-span-2 min-h-0">
        <Link
          href="/dashboard/my-work"
          className="relative flex h-full min-h-0 flex-col justify-between overflow-hidden rounded-2xl bg-signal-yellow p-5 text-signal-ink"
        >
          {/* No art mark — the founder cut the rings ("weird symbol"). The
              block carries its figure and nothing else; the type IS the
              poster. */}
          <span className="relative text-tiny font-semibold uppercase tracking-[0.14em] opacity-60">
            My work
          </span>
          {/* A headline, the way the reference's tall block is a headline —
              the figure IS the sentence, at display size, and the line under
              it says what to do next rather than restating the number. */}
          <span className="relative mt-3 min-w-0">
            <span className="font-title block text-[3.5rem] font-bold leading-[0.85] tracking-tight">
              <Counter
                value={me.open}
                places={placesFor(me.open)}
                fontSize={56}
                padding={2}
                fontWeight={700}
              />
            </span>
            <span className="mt-1.5 block text-sm font-medium opacity-70">
              open {me.open === 1 ? "task" : "tasks"} assigned to you
            </span>
          </span>
          <span className="relative mt-4 min-w-0 border-t border-current/20 pt-2.5">
            {nextTask ? (
              <>
                <span className="block text-tiny font-semibold uppercase tracking-[0.14em] opacity-55">
                  Next up
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span className="line-clamp-1 min-w-0 flex-1 text-sm font-semibold">
                    {nextTask.title}
                  </span>
                  <ArrowRight aria-hidden className="size-3.5 shrink-0" />
                </span>
              </>
            ) : (
              <span className="flex items-center justify-between gap-2 text-xs font-medium">
                <span className="opacity-70">Nothing is waiting on you</span>
                <ArrowRight aria-hidden className="size-3.5" />
              </span>
            )}
          </span>
        </Link>
      </StaggerItem>

      {/* ── The two that move, stacked in one column ───────────────────── */}
      <StaggerItem lift className="min-h-0 @3xl:col-start-3 @3xl:row-start-1">
        <Link
          href="/dashboard/my-work"
          className="flex h-full min-h-0 flex-col justify-between overflow-hidden rounded-2xl bg-signal-teal p-4 text-signal-ink"
        >
          {/* The figure IS the card — no glyph chip. A clock beside a
              number was decoration wearing an indicator's clothes (founder
              call), and the label under the rule already says what the
              number is. */}
          <span className="flex items-center gap-3">
            <span className="font-title block text-[2.25rem] font-bold leading-[0.85] tracking-tight">
              <Counter
                value={me.dueToday}
                places={placesFor(me.dueToday)}
                fontSize={36}
                padding={2}
                fontWeight={700}
              />
            </span>
          </span>
          <span className="mt-auto border-t border-current/20 pt-2">
            <span className="block text-tiny font-semibold uppercase tracking-[0.14em] opacity-60">
              Due today
            </span>
            <span className="mt-0.5 block text-tiny font-medium opacity-70">
              {me.overdue > 0
                ? `${me.overdue} also past their date`
                : "nothing is late"}
            </span>
          </span>
        </Link>
      </StaggerItem>

      <StaggerItem lift className="min-h-0 @3xl:col-start-3 @3xl:row-start-2">
        <Link
          href="/dashboard/my-work"
          className="flex h-full min-h-0 flex-col justify-between overflow-hidden rounded-2xl bg-signal-pink p-4 text-signal-ink"
        >
          <span className="flex items-center gap-3">
            <span className="font-title block text-[2.25rem] font-bold leading-[0.85] tracking-tight">
              <Counter
                value={doneThisWeek}
                places={placesFor(doneThisWeek)}
                fontSize={36}
                padding={2}
                fontWeight={700}
              />
            </span>
          </span>
          <span className="mt-auto border-t border-current/20 pt-2">
            <span className="block text-tiny font-semibold uppercase tracking-[0.14em] opacity-60">
              Done this week
            </span>
            <span className="mt-0.5 block text-tiny font-medium opacity-70">
              completed · last 7 days
            </span>
          </span>
        </Link>
      </StaggerItem>

    </Stagger>
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
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <h3 className="text-base font-medium">Today&apos;s tasks</h3>
        {dueTasks.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {dueTasks.length} of {rows?.length ?? 0} open
          </span>
        )}
      </div>
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
      <Link
        href="/dashboard/my-work"
        className="mt-auto flex items-center justify-between gap-2 border-t border-border px-5 py-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        Open my work
        <ArrowRight aria-hidden className="size-3.5" />
      </Link>
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
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <h3 className="text-base font-medium">Pulse</h3>
        <span className="text-xs text-muted-foreground">last 7 days</span>
      </div>
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
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-micro text-muted-foreground @md:flex @md:flex-wrap @md:items-center">
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
  return (
    <span className="ui-chip inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-tiny font-medium">
      <span aria-hidden className={cn("size-1.5 rounded-full", chip.dot)} />
      {chip.label}
    </span>
  );
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
  // The lime card is the project that needs attention soonest: most overdue
  // work, then nearest target date. Never "the first one" — a highlight that
  // never moves is decoration. Chosen BEFORE the responsive slice and sorted
  // to the front of it: cards 3 and 4 hide on narrow containers, and an
  // urgent project hidden by the container width was the section silently
  // dropping its one defining rule exactly where it matters most (a phone).
  const pool = projects.slice(0, 4);
  const urgent = [...pool].sort(
    (a, b) =>
      b.overdue - a.overdue ||
      (a.targetDate ?? Infinity) - (b.targetDate ?? Infinity),
  )[0];
  const shown =
    urgent === undefined
      ? pool
      : [urgent, ...pool.filter((p) => p !== urgent)];
  return (
    <section className="flex h-full min-w-0 flex-col">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-title text-xl font-bold tracking-tight">Projects</h2>
        <Link
          href="/dashboard/projects"
          className="ui-chip rounded-full px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          View all {totalProjects}
        </Link>
      </div>
      {/* `flex-1 auto-rows-fr`: the card rows absorb the tile's slack instead
          of leaving a dead strip under the grid — a taller tile means taller
          cards (each has a bottom action band, so stretching reads composed),
          never emptiness with a resize grip floating in it. */}
      <Stagger className="grid flex-1 auto-rows-fr grid-cols-1 gap-3 @2xl:grid-cols-2">
        {shown.map((project, index) => {
          const lime = project === urgent;
          return (
            <StaggerItem
              key={project.listId}
              lift
              className={cn(
                "h-full min-w-0",
                // The fourth card exists only where the grid is two-across.
                // Stacked single-file it pushed the section past the tallest
                // tile the screen allows, and a section that scrolls its own
                // cards is a hole wearing a scrollbar.
                index === 3 && "hidden @2xl:block",
                // And the third only where there is at least a phablet of
                // room — two cards on a phone, three on a tablet, four on a
                // desktop. The count follows the container, like everything
                // else in a panel.
                index === 2 && "hidden @sm:block",
              )}
            >
              <NotchCard
                tone={lime ? "lime" : "panel"}
                corner={
                  <Link
                    href={`/dashboard/l/${project.listId}`}
                    aria-label={`Open ${project.name}`}
                    className="flex size-9 items-center justify-center rounded-full bg-card text-foreground transition-colors hover:bg-muted"
                  >
                    <ArrowUpRight aria-hidden className="size-4" />
                  </Link>
                }
                className="h-full"
              >
                <div className="grid grid-cols-[1fr_auto]">
                  <div className="min-w-0 p-4 pr-2">
                    {/* Clears the notch: the title starts below the scoop's
                        reach so a long name never runs under the control. */}
                    <p className="line-clamp-2 pr-10 font-title text-base font-bold leading-snug">
                      {project.name}
                    </p>
                    <p className={cn("mt-1 truncate text-xs", lime ? "opacity-60" : "text-muted-foreground")}>
                      {project.place}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      {project.projectStatus && (
                        <HealthChip status={project.projectStatus} />
                      )}
                      {project.overdue > 0 && (
                        <span className="ui-chip px-2 py-0.5 text-tiny font-medium">
                          {project.overdue} overdue
                        </span>
                      )}
                      {project.targetDate !== undefined && (
                        <span className={cn("ui-chip ui-figure px-2 py-0.5 text-tiny", !lime && "text-muted-foreground")}>
                          {formatDate(project.targetDate)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className={cn(
                      // `pt-14`, not centred: the scoop owns the cell's top
                      // 56px, and a centred figure on a short card lands
                      // exactly under it — "31/48" rendered as "3…" behind
                      // the notch until this cleared it.
                      "flex min-w-[6.5rem] flex-col items-center justify-start border-l px-3 pb-4 pt-14",
                      lime ? "border-current/15" : "border-border",
                    )}>
                    <span className="font-title whitespace-nowrap text-2xl font-bold leading-none tracking-tight">
                      {project.done}
                      <span className="text-sm font-semibold opacity-50">
                        /{project.total}
                      </span>
                    </span>
                    <span className={cn("mt-1 text-micro font-medium uppercase tracking-wider", lime ? "opacity-60" : "text-muted-foreground")}>
                      done
                    </span>
                  </div>
                </div>
                <div className={cn("flex items-center justify-between gap-3 border-t px-4 py-2.5", lime ? "border-current/15" : "border-border")}>
                  <span className={cn("text-tiny", lime ? "opacity-60" : "text-muted-foreground")}>
                    active {timeAgo(project.lastActivityAt)}
                  </span>
                  <Link
                    href={`/dashboard/l/${project.listId}`}
                    className={cn(
                      "rounded-full px-3.5 py-1.5 text-xs font-semibold transition-transform hover:scale-[1.03]",
                      lime
                        ? "bg-signal-ink text-signal-lime"
                        : "bg-primary text-primary-foreground",
                    )}
                  >
                    Open board
                  </Link>
                </div>
              </NotchCard>
            </StaggerItem>
          );
        })}
      </Stagger>
    </section>
  );
}
function LiveFeed({ ticker }: { ticker: TickerItem[] }) {
  const visible = ticker.slice(0, 7);
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-5 py-3.5">
        <h3 className="text-base font-medium">Live</h3>
      </div>
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
                        <span className="block text-xs text-muted-foreground">
                          {timeAgo(e.createdAt)}
                        </span>
                      </Link>
                    ) : (
                      <>
                        <span>{body}</span>
                        <span className="block text-xs text-muted-foreground">
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
  const card = (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-5 py-3.5">
        <h3 className="text-base font-medium">Agents online</h3>
      </div>
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
    </div>
  );
  // Presence dots already say "live" — a rainbow border around the card was
  // a fourth colour system announcing what the rows announce quietly.
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
