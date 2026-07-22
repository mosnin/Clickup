"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import {
  AlertTriangle,
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
  AnimatedNumber,
  AnimatePresence,
  EASE,
  motion,
  PresenceDot,
  Stagger,
  StaggerItem,
} from "@/components/motion";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PriorityDot } from "@/components/dashboard/priority";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
  const overview = useQuery(api.homeOverview.get, {});
  const myWork = useQuery(api.myWork.listForCurrent, {});
  const { user } = useUser();

  if (overview === undefined) {
    return <DashboardSkeleton />;
  }
  if (overview === null) {
    return null;
  }

  const agentsOnline = overview.agents.filter((a) => a.online).length;

  return (
    <div className="space-y-6">
      <PageHeader icon={LayoutDashboard} title="Home" />

      <WelcomeSection firstName={user?.firstName ?? undefined} me={overview.me} />

      <StatsCards me={overview.me} agentsOnline={agentsOnline} />

      <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TodaysTasks rows={myWork ?? undefined} />
        </div>
        <div>
          <ActivityChart ticker={overview.ticker} />
        </div>
      </div>

      <ProjectsTable
        projects={overview.projects}
        totalProjects={overview.totalProjects}
      />

      <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <LiveFeed ticker={overview.ticker} />
        </div>
        <div>
          <AgentsCard agents={overview.agents} />
        </div>
      </div>
    </div>
  );
}

function WelcomeSection({
  firstName,
  me,
}: {
  firstName?: string;
  me: Overview["me"];
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
      <Button size="sm" className="h-9 gap-1.5" onClick={openCommandPalette}>
        <Plus className="size-4" />
        New task
      </Button>
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
function ActivityChart({ ticker }: { ticker: TickerItem[] }) {
  const data = useMemo(() => {
    const days: { key: string; day: string; completed: number }[] = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      days.push({
        key: d.toDateString(),
        day: d.toLocaleDateString(undefined, { weekday: "short" }),
        completed: 0,
      });
    }
    const byKey = new Map(days.map((d) => [d.key, d]));
    for (const e of ticker) {
      if (e.type !== "task.completed") continue;
      const bucket = byKey.get(new Date(e.createdAt).toDateString());
      if (bucket) bucket.completed += 1;
    }
    return days;
  }, [ticker]);

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
                  p.targetDate < Date.now() &&
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
            href="/dashboard/personal"
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
                  <Avatar size="sm">
                    <AvatarFallback>
                      {a.name.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
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
