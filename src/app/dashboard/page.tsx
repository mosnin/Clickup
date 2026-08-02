"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Clock,
  LayoutDashboard,
  ListChecks,
  Plus,
  type LucideIcon,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
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
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { BorderBeam } from "@/components/ui/beam";
import GradientText from "@/components/gradient-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { errorMessage } from "@/lib/errors";
import { wake } from "@/lib/anime";
import {
  EditableGrid,
  TrayTile,
} from "@/components/dashboard/screen/editable-grid";
import { ActorGlyph } from "@/components/appearance/actor-glyph";
import { Panel } from "@/components/dashboard/panel";
import { useOfferMintablePanels } from "@/components/appearance/mintable-panels";
import { builtInPanelQuestion } from "@/lib/built-in-panel";
import {
  describePanel,
  normalizePanel,
  panelIdFromWidgetId,
  panelWidgetId,
} from "@/lib/panel";
import { replaceWidget } from "@/lib/screen-layout";

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

const HEALTH_CHIP: Record<
  NonNullable<Project["projectStatus"]>,
  { label: string; className: string }
> = {
  on_track: {
    label: "On track",
    className: "bg-pastel-green dark:text-neutral-900",
  },
  at_risk: {
    label: "At risk",
    className: "bg-pastel-yellow dark:text-neutral-900",
  },
  off_track: {
    label: "Off track",
    className: "bg-pastel-red dark:text-neutral-900",
  },
  paused: { label: "Paused", className: "bg-muted" },
};

const chartConfig: ChartConfig = {
  completed: { label: "Completed", color: "var(--color-chart-1)" },
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

  const [customizing, setCustomizing] = useState(false);
  // Local optimistic layout: render the just-clicked order immediately;
  // the server round-trip (settings) reconciles behind it.
  const [draft, setDraft] = useState<WidgetId[] | null>(null);
  const [spanDraft, setSpanDraft] = useState<Partial<
    Record<WidgetId, 1 | 2 | 3>
  > | null>(null);
  const [rowDraft, setRowDraft] = useState<Partial<
    Record<WidgetId, 1 | 2 | 3>
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
  const rows: Partial<Record<string, 1 | 2 | 3>> =
    rowDraft ??
    ((settings?.homeWidgetRows ?? {}) as Partial<Record<string, 1 | 2 | 3>>);

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
    nextRows?: Partial<Record<WidgetId, 1 | 2 | 3>> | null,
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
    nextRows?: Partial<Record<WidgetId, 1 | 2 | 3>>,
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

  // totalAgentsOnline counts the whole fleet; overview.agents is a display
  // preview capped at 8 and would undercount larger fleets.
  const agentsOnline =
    overview.totalAgentsOnline ??
    overview.agents.filter((a) => a.online).length;
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
      <span className="mt-0.5 block max-w-[22rem] truncate text-[11px] font-normal text-muted-foreground">
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
    switch (id) {
      case "stats":
        return <StatsCards me={ov.me} agentsOnline={agentsOnline} />;
      case "today":
        return <TodaysTasks rows={myWork ?? undefined} />;
      case "activity":
        return <ActivityChart completions={ov.completions7d} />;
      case "projects":
        return (
          <ProjectsTable
            projects={ov.projects}
            totalProjects={ov.totalProjects}
          />
        );
      case "live":
        return <LiveFeed ticker={ov.ticker} />;
      case "agents":
        return <AgentsCard agents={ov.agents} />;
    }
  }

  return (
    <div className="space-y-6">
      <WelcomeReveal />

      <PageHeader icon={LayoutDashboard} title="Home" />

      <WelcomeSection
        firstName={user?.firstName ?? undefined}
        me={overview.me}
        customizing={customizing}
        onToggleCustomize={() => setCustomizing((v) => !v)}
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
            <BorderBeam size="md" colorVariant="colorful">
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
                  <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-pastel-yellow" />
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
            </BorderBeam>
          </motion.div>
        )}
      </AnimatePresence>

      {/* The blocks, on the same physical grid every screen uses: hold one
          until the grid wobbles (or hit Customize) and move it. Hidden blocks
          wait on a shelf below and are dragged back on. */}
      <EditableGrid
        gridId={HOME_GRID_ID}
        editing={customizing}
        onEditingChange={setCustomizing}
        tiles={order.flatMap((id) => {
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
            ) as Partial<Record<WidgetId, 1 | 2 | 3>>,
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
              Customize your Home
            </button>
          </div>
        }
      >
        {(editing) =>
          editing ? (
            <div className="rounded-2xl panel p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
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
            </div>
          ) : null
        }
      </EditableGrid>
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
            className="inline-block h-8 w-8 rounded-[8px] bg-foreground"
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

function WelcomeSection({
  firstName,
  me,
  customizing,
  onToggleCustomize,
}: {
  firstName?: string;
  me: Overview["me"];
  customizing: boolean;
  onToggleCustomize: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Welcome back{firstName ? `, ${firstName}` : ""}.
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {me.dueToday} Task{me.dueToday === 1 ? "" : "s"} Due Today,{" "}
          {me.overdue} Overdue Task{me.overdue === 1 ? "" : "s"}, {me.open}{" "}
          Open Task{me.open === 1 ? "" : "s"}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggleCustomize}
          className="tap-target text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {customizing ? "Done" : "Customize"}
        </button>
        <Button size="sm" className="h-9 gap-1.5" onClick={openCommandPalette}>
          <Plus className="size-4" />
          New task
        </Button>
      </div>
    </div>
  );
}

function StatsCards({
  me,
  agentsOnline,
}: {
  me: Overview["me"];
  agentsOnline: number;
}) {
  const stats: {
    title: string;
    value: number;
    icon: LucideIcon;
    href: string;
    danger?: boolean;
  }[] = [
    {
      title: "My open tasks",
      value: me.open,
      icon: ListChecks,
      href: "/dashboard/my-work",
    },
    {
      title: "Due today",
      value: me.dueToday,
      icon: Clock,
      href: "/dashboard/my-work",
    },
    {
      title: "Overdue",
      value: me.overdue,
      icon: AlertTriangle,
      href: "/dashboard/my-work",
      danger: me.overdue > 0,
    },
    {
      title: "Agents online",
      value: agentsOnline,
      icon: Bot,
      href: "/dashboard/agents",
    },
  ];

  return (
    // Two across on a phone, four when the panel is wide enough for the
    // labels — and measured against the GRID rather than the window, because
    // this panel's width is decided by its span and by whether the nav is
    // open, not by the viewport. Four stacked cards were 424px of content in
    // a 168px box, which is what sliced "Due today" through its own number.
    <Stagger className="grid grid-cols-2 gap-4 @3xl:grid-cols-4">
      {stats.map((stat) => (
        <StaggerItem key={stat.title} className="h-full">
          {/* Fills its cell. The grid stretches its rows to the panel's
              height either way; without this the card kept its content height
              and the slack fell between the rows as a ragged 130px hole. */}
          <Link
            href={stat.href}
            className="block h-full rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted/30"
          >
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">{stat.title}</p>
                <p
                  className={cn(
                    "text-2xl font-medium tabular-nums",
                    stat.danger && "text-destructive",
                  )}
                >
                  <Counter
                    value={stat.value}
                    places={placesFor(stat.value)}
                    fontSize={24}
                    padding={4}
                    fontWeight={500}
                  />
                </p>
              </div>
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
                <stat.icon className="size-5 text-muted-foreground" />
              </div>
            </div>
          </Link>
        </StaggerItem>
      ))}
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
      .slice(0, 8);
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
    <div className="h-full rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
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
                <div className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/20">
                  <Checkbox
                    className="mt-0.5 flex-shrink-0"
                    aria-label={`Mark "${row.title}" complete`}
                    onCheckedChange={() => complete(row)}
                  />
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Link
                      href={`/dashboard/l/${row.listId}/t/${row._id}`}
                      className="min-w-0 flex-1 basis-48 text-sm font-medium hover:underline line-clamp-2"
                    >
                      {row.title}
                    </Link>
                    <span className="flex flex-shrink-0 items-center gap-2">
                      <span className="rounded-lg border border-border bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
                        {row.listName}
                      </span>
                      {row.priority && <PriorityDot priority={row.priority} />}
                      {row.dueDate !== undefined && (
                        <span
                          className={cn(
                            "text-xs font-medium tabular-nums",
                            overdue ? "text-danger" : "text-muted-foreground",
                          )}
                        >
                          Due: {formatDate(row.dueDate)}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              </StaggerItem>
            );
          })}
        </Stagger>
      )}
    </div>
  );
}

// Recent activity: task.completed events per day over the last 7 days,
// derived client-side from the (capped) home ticker — no new server query.
// Honestly labeled "Recent activity" rather than "Performance" since the
// ticker only carries the newest ~10 events across every scope.
function ActivityChart({ completions }: { completions?: number[] }) {
  // Server-bucketed 7-day completion counts (index 0 = six days ago,
  // 6 = today), computed over a real event window rather than the
  // 10-item ticker that used to undercount busy scopes.
  const data = useMemo(() => {
    const days: { day: string; completed: number }[] = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      days.push({
        day: d.toLocaleDateString(undefined, { weekday: "short" }),
        completed: completions?.[6 - i] ?? 0,
      });
    }
    return days;
  }, [completions]);

  const total = data.reduce((sum, d) => sum + d.completed, 0);

  return (
    <div className="h-full rounded-xl border border-border bg-card overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-base font-medium">Recent activity</h3>
      </div>
      <div className="p-4">
        <div className="mb-4 flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums">
            <Counter
              value={total}
              places={placesFor(total)}
              fontSize={30}
              padding={4}
              fontWeight={600}
            />
          </span>
          <span className="text-sm text-muted-foreground">
            completed · last 7 days
          </span>
        </div>
        <ChartContainer config={chartConfig} className="h-[175px] w-full">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--color-border)"
              vertical={false}
            />
            <XAxis
              dataKey="day"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11 }}
            />
            <YAxis hide allowDecimals={false} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar
              dataKey="completed"
              radius={[4, 4, 0, 0]}
              fill="var(--color-completed)"
            />
          </BarChart>
        </ChartContainer>
        {total === 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            No completions in the last few events yet — this fills in as work
            wraps up.
          </p>
        )}
      </div>
    </div>
  );
}

function ProjectsTable({
  projects,
  totalProjects,
}: {
  projects: Project[];
  totalProjects: number;
}) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h3 className="text-base font-medium">Projects</h3>
        <span className="text-xs text-muted-foreground">
          {projects.length === totalProjects
            ? `${totalProjects} project${totalProjects === 1 ? "" : "s"}`
            : `Showing ${projects.length} of ${totalProjects}`}
        </span>
      </div>
      {projects.length === 0 ? (
        <EmptyState
          compact
          title="No projects yet"
          message="Create a list inside your personal space or a workspace and it'll show up here, live."
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Project</TableHead>
                <TableHead>Health</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Target date</TableHead>
                <TableHead>Last activity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((p) => {
                const pct = p.total > 0 ? (p.done / p.total) * 100 : 0;
                const chip = p.projectStatus
                  ? HEALTH_CHIP[p.projectStatus]
                  : null;
                const targetOverdue =
                  p.targetDate !== undefined &&
                  p.targetDate < startOfToday() &&
                  p.done < p.total;
                return (
                  <TableRow key={p.listId}>
                    <TableCell>
                      <Link
                        href={`/dashboard/l/${p.listId}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {p.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">{p.place}</p>
                    </TableCell>
                    <TableCell>
                      {chip ? (
                        <Badge
                          variant="outline"
                          className={cn(
                            "border-transparent text-foreground",
                            chip.className,
                          )}
                        >
                          {chip.label}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-[140px] items-center gap-2">
                        <Progress value={pct} className="h-2 flex-1" />
                        <span className="w-12 flex-shrink-0 text-sm tabular-nums text-muted-foreground">
                          {p.done}/{p.total}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {p.targetDate !== undefined ? (
                        <span
                          className={cn(
                            "text-sm",
                            targetOverdue ? "text-danger" : "text-muted-foreground",
                          )}
                        >
                          {formatDate(p.targetDate)}
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">
                        {timeAgo(p.lastActivityAt)}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {projects.length < totalProjects && (
        <div className="border-t border-border px-4 py-3">
          <Link
            href="/dashboard/projects"
            className="text-sm font-medium hover:underline"
          >
            View all projects
          </Link>
        </div>
      )}
    </div>
  );
}

function LiveFeed({ ticker }: { ticker: TickerItem[] }) {
  const visible = ticker.slice(0, 8);
  return (
    <div className="h-full rounded-xl border border-border bg-card overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-base font-medium">Live</h3>
      </div>
      <div className="p-4">
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
                    {e.listId ? (
                      <Link
                        href={`/dashboard/l/${e.listId}`}
                        className="hover:underline"
                      >
                        {body}
                      </Link>
                    ) : (
                      <span>{body}</span>
                    )}
                    <span className="block text-xs text-muted-foreground">
                      {timeAgo(e.createdAt)}
                    </span>
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
    <div className="h-full rounded-xl border border-border bg-card overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-base font-medium">Agents online</h3>
      </div>
      <div className="p-4">
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
  // Someone's actually online → the beam marks the card as live.
  return agents.length > 0 ? (
    <BorderBeam size="md" colorVariant="colorful" className="h-full">
      {card}
    </BorderBeam>
  ) : (
    card
  );
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
            className="h-24 animate-pulse rounded-xl border border-border bg-muted/20"
          />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-3">
        <div className="h-72 animate-pulse rounded-xl border border-border bg-muted/20 lg:col-span-2" />
        <div className="h-72 animate-pulse rounded-xl border border-border bg-muted/20" />
      </div>
      <div className="h-64 animate-pulse rounded-xl border border-border bg-muted/20" />
    </div>
  );
}
