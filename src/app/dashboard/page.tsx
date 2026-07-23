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
  ChevronDown,
  ChevronUp,
  Clock,
  LayoutDashboard,
  ListChecks,
  Plus,
  X,
  type LucideIcon,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { api } from "@convex/_generated/api";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { eventLabel } from "@/lib/event-labels";
import { useToast } from "@/components/toast";
import {
  AnimatedNumber,
  AnimatePresence,
  EASE,
  motion,
  PresenceDot,
  Stagger,
  StaggerItem,
} from "@/components/motion";
import { PageHeader } from "@/components/dashboard/page-header";
import { InviteCards } from "@/components/dashboard/invite-cards";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PriorityDot } from "@/components/dashboard/priority";
import { Orb } from "@/components/dashboard/orb";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { BorderBeam } from "@/components/ui/border-beam";
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
type WidgetId = (typeof WIDGETS)[number]["id"];
const DEFAULT_LAYOUT: WidgetId[] = WIDGETS.map((w) => w.id);
const WIDGET_BY_ID = new Map<WidgetId, (typeof WIDGETS)[number]>(
  WIDGETS.map((w) => [w.id, w]),
);

function errorMessage(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  return (
    raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() || fallback
  );
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

  const [customizing, setCustomizing] = useState(false);
  // Local optimistic layout: render the just-clicked order immediately;
  // the server round-trip (settings) reconciles behind it.
  const [draft, setDraft] = useState<WidgetId[] | null>(null);

  const order = useMemo<WidgetId[]>(() => {
    const source = draft ?? settings?.homeWidgets ?? null;
    if (!source) return DEFAULT_LAYOUT;
    // Drop unknown ids (future/renamed widgets) and dupes defensively.
    const seen = new Set<string>();
    const out: WidgetId[] = [];
    for (const id of source) {
      if (WIDGET_BY_ID.has(id as WidgetId) && !seen.has(id)) {
        out.push(id as WidgetId);
        seen.add(id);
      }
    }
    return out;
  }, [draft, settings]);

  // Wait for settings too, so a saved custom layout never flashes the
  // default order on first paint.
  if (overview === undefined || settings === undefined) {
    return <DashboardSkeleton />;
  }
  if (overview === null) {
    return null;
  }

  function persist(next: WidgetId[] | null) {
    void setHomeWidgets({ homeWidgets: next }).catch((e) => {
      setDraft(null); // fall back to the server's layout
      toast(errorMessage(e, "Couldn't save your Home layout"), {
        kind: "error",
      });
    });
  }
  function applyLayout(next: WidgetId[]) {
    setDraft(next);
    persist(next);
  }
  function hideWidget(id: WidgetId) {
    applyLayout(order.filter((w) => w !== id));
  }
  function showWidget(id: WidgetId) {
    applyLayout([...order, id]);
  }
  function moveWidget(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[index], next[j]] = [next[j], next[index]];
    applyLayout(next);
  }
  function resetLayout() {
    setDraft([...DEFAULT_LAYOUT]);
    persist(null);
  }

  const hidden = DEFAULT_LAYOUT.filter((id) => !order.includes(id));

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
  function widgetContent(id: WidgetId): React.ReactNode {
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
            <Link
              href="/dashboard/agents"
              className="lift relative flex items-center gap-4 rounded-2xl panel p-5"
            >
              <span className="relative inline-flex h-12 w-12 flex-shrink-0" aria-hidden>
                <Orb seed={waiting[0]._id} size="lg" />
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
              {/* The beam says "listening" while we wait for the first
                  heartbeat — it's the one live moment on an idle Home. */}
              <BorderBeam size={72} duration={6} />
            </Link>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Customize bar: reorder/hide happens on the widgets themselves;
          this strip holds the hidden-widget shelf + reset/done. */}
      <AnimatePresence initial={false}>
        {customizing && (
          <motion.div
            key="customize-bar"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="rounded-2xl panel p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                Reorder or hide the blocks on your Home. Changes save as you
                go.
              </p>
              <button
                type="button"
                onClick={resetLayout}
                className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Reset layout
              </button>
              <Button size="sm" onClick={() => setCustomizing(false)}>
                Done
              </Button>
            </div>
            {hidden.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Hidden
                </span>
                {hidden.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => showWidget(id)}
                    className="rounded-full border border-dashed border-border px-3 py-1 text-sm text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                  >
                    + {WIDGET_BY_ID.get(id)?.title}
                  </button>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {order.length === 0 && !customizing ? (
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
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-3">
          <AnimatePresence initial={false}>
            {order.map((id, i) => {
              const def = WIDGET_BY_ID.get(id);
              if (!def) return null;
              return (
                <motion.section
                  key={id}
                  layout
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.3, ease: EASE }}
                  className={cn(
                    def.span,
                    customizing &&
                      "rounded-2xl border border-dashed border-border p-2",
                  )}
                >
                  {customizing && (
                    <div className="mb-2 flex items-center gap-0.5 px-1">
                      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {def.title}
                      </span>
                      <button
                        type="button"
                        aria-label={`Move ${def.title} up`}
                        disabled={i === 0}
                        onClick={() => moveWidget(i, -1)}
                        className="tap-target inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${def.title} down`}
                        disabled={i === order.length - 1}
                        onClick={() => moveWidget(i, 1)}
                        className="tap-target inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Hide ${def.title}`}
                        onClick={() => hideWidget(id)}
                        className="tap-target inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                  {widgetContent(id)}
                </motion.section>
              );
            })}
          </AnimatePresence>
        </div>
      )}
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
            Your mission control is ready.
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
    <Stagger className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map((stat) => (
        <StaggerItem key={stat.title}>
          <Link
            href={stat.href}
            className="block rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted/30"
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
                  <AnimatedNumber value={stat.value} />
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
                <div className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/20">
                  <Checkbox
                    aria-label={`Mark "${row.title}" complete`}
                    onCheckedChange={() => complete(row)}
                  />
                  <Link
                    href={`/dashboard/l/${row.listId}/t/${row._id}`}
                    className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
                  >
                    {row.title}
                  </Link>
                  <span className="flex-shrink-0 rounded-lg border border-border bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
                    {row.listName}
                  </span>
                  {row.priority && <PriorityDot priority={row.priority} />}
                  {row.dueDate !== undefined && (
                    <span
                      className={cn(
                        "ml-auto flex-shrink-0 text-xs font-medium tabular-nums",
                        overdue ? "text-danger" : "text-muted-foreground",
                      )}
                    >
                      Due: {formatDate(row.dueDate)}
                    </span>
                  )}
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
            <AnimatedNumber value={total} />
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
  return (
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
                  <Orb seed={a.agentId} size="sm" />
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
