"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "convex/react";
import {
  addDays,
  differenceInCalendarDays,
  eachMonthOfInterval,
  endOfMonth,
  format,
  startOfDay,
  startOfMonth,
} from "date-fns";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/dashboard/empty-state";
import { AnimatedBar, AnimatedNumber, Stagger, StaggerItem } from "@/components/motion";

// Workspace Portfolio: every project (list) the caller can see, laid out
// as a bar on one shared date axis. Read-only — planning happens on the
// list's own Gantt; this is the "how's everything doing" rollup.

const DAY_PX = 7;
const RAIL_PX = 220;
const ROW_PX = 60;
const PAD_DAYS = 14;

type PortfolioData = NonNullable<
  ReturnType<typeof useQuery<typeof api.portfolio.forWorkspace>>
>;
type PortfolioRow = PortfolioData["rows"][number];
type Health = NonNullable<PortfolioRow["health"]>;

const HEALTH_CHIP: Record<Health, { label: string; className: string }> = {
  on_track: { label: "On track", className: "bg-pastel-green" },
  at_risk: { label: "At risk", className: "bg-pastel-yellow" },
  off_track: { label: "Off track", className: "bg-pastel-red" },
  paused: { label: "Paused", className: "bg-muted" },
};

const HEALTH_BAR: Record<Health, { track: string; fill: string }> = {
  on_track: { track: "bg-pastel-green/35", fill: "bg-pastel-green" },
  at_risk: { track: "bg-pastel-yellow/35", fill: "bg-pastel-yellow" },
  off_track: { track: "bg-pastel-red/35", fill: "bg-pastel-red" },
  paused: { track: "bg-muted", fill: "bg-muted-foreground/50" },
};
const DEFAULT_BAR = { track: "bg-muted", fill: "bg-muted-foreground/50" };

type Layout = {
  rangeStart: Date;
  months: Date[];
  totalWidth: number;
  dayOffset: (ts: number) => number;
};

export function PortfolioTimeline({
  workspaceId,
}: {
  workspaceId: Id<"workspaces">;
}) {
  const data = useQuery(api.portfolio.forWorkspace, { workspaceId });

  const layout = useMemo<Layout | null>(() => {
    if (!data || data.rows.length === 0) return null;
    const rangeStart = startOfDay(addDays(data.minDate, -PAD_DAYS));
    const rangeEnd = startOfDay(addDays(data.maxDate, PAD_DAYS));
    const months = eachMonthOfInterval({
      start: startOfMonth(rangeStart),
      end: endOfMonth(rangeEnd),
    });
    const totalDays = Math.max(differenceInCalendarDays(rangeEnd, rangeStart), 1);
    const totalWidth = totalDays * DAY_PX;
    const dayOffset = (ts: number) =>
      differenceInCalendarDays(startOfDay(ts), rangeStart) * DAY_PX;
    return { rangeStart, months, totalWidth, dayOffset };
  }, [data]);

  if (data === undefined) {
    return (
      <div className="space-y-3">
        <div className="h-6 w-64 animate-pulse rounded-full bg-muted/40" />
        <Card className="h-72 animate-pulse bg-muted/30" />
      </div>
    );
  }

  if (!data || data.rows.length === 0 || !layout) {
    return (
      <Card className="p-0">
        <EmptyState
          title="No projects yet in this workspace"
          message="Give a list a start date, due date, or target date and it will appear here as a bar on the shared timeline."
        />
      </Card>
    );
  }

  const { rows } = data;
  const counts = {
    on_track: rows.filter((r) => r.health === "on_track").length,
    at_risk: rows.filter((r) => r.health === "at_risk").length,
    off_track: rows.filter((r) => r.health === "off_track").length,
  };
  const today = Date.now();
  const todayLeft = RAIL_PX + layout.dayOffset(today);

  return (
    <div className="space-y-4">
      <SummaryStrip total={rows.length} counts={counts} />

      <Card className="gap-0 overflow-x-auto p-0">
        <div className="relative" style={{ minWidth: RAIL_PX + layout.totalWidth }}>
          {/* Today line spans header + every row. */}
          <div
            className="pointer-events-none absolute inset-y-0 z-20"
            style={{ left: todayLeft }}
          >
            <div className="h-full w-px bg-foreground/25" />
            <span className="absolute left-1.5 top-1 whitespace-nowrap text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Today
            </span>
          </div>

          {/* Month axis header */}
          <div className="relative flex h-10 border-b border-border">
            <div className="sticky left-0 z-30 w-[220px] flex-shrink-0 bg-card px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Project
            </div>
            <div className="relative" style={{ width: layout.totalWidth }}>
              {layout.months.map((m) => {
                const isJan = m.getMonth() === 0;
                return (
                  <div
                    key={m.getTime()}
                    className="absolute top-0 flex h-10 items-center whitespace-nowrap border-l border-border/60 pl-2 text-[10px] uppercase tracking-wider text-muted-foreground"
                    style={{ left: layout.dayOffset(m.getTime()) }}
                  >
                    {format(m, "MMM")}
                    {isJan && (
                      <span className="ml-1 text-foreground/60">
                        {format(m, "yyyy")}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <Stagger>
            {rows.map((row) => (
              <StaggerItem key={row.listId}>
                <ProjectRow row={row} layout={layout} />
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </Card>
    </div>
  );
}

function SummaryStrip({
  total,
  counts,
}: {
  total: number;
  counts: { on_track: number; at_risk: number; off_track: number };
}) {
  const chips = (
    [
      { key: "on_track", label: "on track", count: counts.on_track, className: "bg-pastel-green" },
      { key: "at_risk", label: "at risk", count: counts.at_risk, className: "bg-pastel-yellow" },
      { key: "off_track", label: "off track", count: counts.off_track, className: "bg-pastel-red" },
    ] as const
  ).filter((c) => c.count > 0);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-semibold">
        <AnimatedNumber value={total} /> project{total === 1 ? "" : "s"}
      </span>
      {chips.map((c) => (
        <Badge
          key={c.key}
          className={cn("border-transparent text-foreground", c.className)}
        >
          {c.count} {c.label}
        </Badge>
      ))}
    </div>
  );
}

function ProjectRow({ row, layout }: { row: PortfolioRow; layout: Layout }) {
  const chip = row.health ? HEALTH_CHIP[row.health] : null;
  const bar = row.health ? HEALTH_BAR[row.health] : DEFAULT_BAR;
  const pct = row.total > 0 ? Math.round((row.done / row.total) * 100) : 0;
  const left = layout.dayOffset(row.start);
  const width = Math.max(layout.dayOffset(row.end) - left, 10);
  const isOpen = row.done < row.total;
  const isOverdue =
    row.targetDate !== undefined && row.targetDate < Date.now() && isOpen;

  return (
    <div
      className="flex border-t border-border/60"
      style={{ minHeight: ROW_PX }}
    >
      <div className="sticky left-0 z-10 w-[220px] flex-shrink-0 bg-card px-4 py-3">
        <Link
          href={`/dashboard/l/${row.listId}`}
          className="block truncate text-sm font-medium hover:underline"
          title={row.name}
        >
          {row.name}
        </Link>
        <p className="truncate text-[11px] uppercase tracking-wider text-muted-foreground">
          {row.spaceName}
        </p>
        {chip && (
          <Badge
            className={cn(
              "mt-1.5 border-transparent text-[10px] text-foreground",
              chip.className,
            )}
          >
            {chip.label}
          </Badge>
        )}
      </div>

      <div
        className="relative flex-shrink-0"
        style={{ width: layout.totalWidth }}
      >
        <div
          className="absolute top-1/2 -translate-y-1/2"
          style={{ left, width }}
        >
          <AnimatedBar
            pct={pct}
            className={cn("h-2.5 w-full overflow-hidden rounded-full", bar.track)}
            barClassName={cn("h-full rounded-full", bar.fill)}
          />
        </div>

        <div
          className="absolute top-1/2 flex -translate-y-1/2 items-center gap-1.5 whitespace-nowrap pl-2 text-xs text-muted-foreground"
          style={{ left: left + width }}
        >
          <span>{pct}%</span>
          <span className={cn(isOverdue && "font-medium text-danger")}>
            {format(row.end, "MMM d")}
          </span>
        </div>

        {row.milestones.map((m) => (
          <div
            key={m.taskId}
            title={`${m.title} — ${format(m.dueDate, "MMM d, yyyy")}`}
            className={cn(
              "absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45",
              m.done
                ? "bg-foreground"
                : "border border-foreground bg-background",
            )}
            style={{ left: layout.dayOffset(m.dueDate) }}
          />
        ))}
      </div>
    </div>
  );
}
