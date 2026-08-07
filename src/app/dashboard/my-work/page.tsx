"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { ListChecks, ShieldAlert } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Stagger, StaggerItem } from "@/components/motion";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader } from "@/components/dashboard/page-header";
import {
  PriorityChip,
  PriorityDot,
  type TaskPriority,
} from "@/components/dashboard/priority";
import { EmptyState } from "@/components/dashboard/empty-state";
import { useToast } from "@/components/toast";

// "My Work": every open task assigned to me across my personal space and
// every workspace I belong to, grouped by urgency — Overdue, Today, This week,
// Later, No date. One screen to answer "what's on my plate right now."

type Row = {
  _id: Id<"tasks">;
  title: string;
  listId: Id<"lists">;
  listName: string;
  dueDate?: number;
  priority?: TaskPriority;
  statusId: Id<"listStatuses">;
  statusName: string;
  statusColor: string;
  requiresApproval?: boolean;
  approvedAt?: number;
};

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

type Bucket = "overdue" | "today" | "week" | "later" | "none";

const BUCKET_META: { key: Bucket; label: string; hint: string }[] = [
  { key: "overdue", label: "Overdue", hint: "Past due, needs attention" },
  { key: "today", label: "Today", hint: "Due today" },
  { key: "week", label: "This week", hint: "Due in the next 7 days" },
  { key: "later", label: "Later", hint: "Further out" },
  { key: "none", label: "No date", hint: "Unscheduled" },
];

export default function MyWorkPage() {
  const rows = useQuery(api.myWork.listForCurrent, {});

  const grouped = useMemo(() => {
    const out: Record<Bucket, Row[]> = {
      overdue: [],
      today: [],
      week: [],
      later: [],
      none: [],
    };
    if (!rows) return out;
    const now = Date.now();
    const todayStart = startOfDay(now);
    const tomorrowStart = todayStart + 24 * 60 * 60 * 1000;
    const weekEnd = todayStart + 7 * 24 * 60 * 60 * 1000;
    for (const r of rows) {
      if (r.dueDate === undefined) out.none.push(r);
      else if (r.dueDate < todayStart) out.overdue.push(r);
      else if (r.dueDate < tomorrowStart) out.today.push(r);
      else if (r.dueDate < weekEnd) out.week.push(r);
      else out.later.push(r);
    }
    return out;
  }, [rows]);

  const total = rows?.length ?? 0;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Everything on you"
        description="Every task assigned to you across every space, with the ones that need moving first."
        icon={ListChecks}
        title="My work"
        context={
          rows === undefined
            ? undefined
            : total === 0
              ? "Nothing assigned"
              : `${total} open task${total === 1 ? "" : "s"}`
        }
      />



      {rows === undefined ? (
        <MyWorkSkeleton />
      ) : total === 0 ? (
        <EmptyState
          title="A clear plate"
          message="Tasks assigned to you, from every space and workspace, show up here grouped by when they're due."
        />
      ) : (
        <div className="space-y-8">
          {BUCKET_META.map(({ key, label, hint }) => {
            const items = grouped[key];
            if (items.length === 0) return null;
            return (
              <section key={key}>
                {/* Group headings sit ON the slab, like every other section
                    heading in the app — a count chip beside the title rather
                    than the old uppercase micro-label. Overdue gets no red
                    wash here: the group itself is never painted, only the
                    date chip on each overdue row earns the alarm colour. */}
                <div className="mb-3 flex items-baseline justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <h2 className="font-title text-xl font-bold tracking-tight">
                      {label}
                    </h2>
                    <span className="ui-chip rounded-full px-3 py-1 text-xs font-medium text-muted-foreground">
                      {items.length}
                    </span>
                  </div>
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    {hint}
                  </span>
                </div>
                {/* @container so each row can stack its chips under the title
                    when the panel itself is narrow — never a viewport
                    breakpoint, since a group card can be narrow on a wide
                    screen (split view, a docked sidebar) and vice versa. */}
                <Card className="@container gap-0 overflow-hidden rounded-2xl py-0">
                  <Stagger>
                    {items.map((r, i) => (
                      <StaggerItem key={r._id}>
                        <TaskRow
                          row={r}
                          index={i}
                          overdue={key === "overdue"}
                          isLast={i === items.length - 1}
                        />
                      </StaggerItem>
                    ))}
                  </Stagger>
                </Card>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatDue(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function TaskRow({
  row,
  index,
  overdue,
  isLast,
}: {
  row: Row;
  index: number;
  overdue: boolean;
  isLast: boolean;
}) {
  const { toast } = useToast();
  // Same optimistic pattern as Home's TodaysTasks: my-work only ever lists
  // open tasks, so completing one just drops it from the local list
  // instantly; the server reconciles (and reverts on a refused completion —
  // blocked/needs-approval).
  const toggleComplete = useMutation(
    api.tasks.toggleComplete,
  ).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.myWork.listForCurrent, {});
    if (!current) return;
    localStore.setQuery(
      api.myWork.listForCurrent,
      {},
      current.filter((t) => t._id !== args.taskId),
    );
  });

  async function complete() {
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

  const href = `/dashboard/l/${row.listId as Id<"lists">}/t/${row._id}`;
  const needsApproval =
    row.requiresApproval && row.approvedAt === undefined;
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50",
        !isLast && "border-b border-border",
      )}
    >
      <Checkbox
        aria-label={`Mark "${row.title}" complete`}
        onCheckedChange={() => complete()}
      />
      {/* Zero-padded index down the left margin — the row language's
          catalogue number, muted and out of the tab/reading flow. Hidden
          below the panel's own @sm width rather than the viewport's, so a
          narrow group card on a wide screen behaves the same as a phone. */}
      <span
        aria-hidden
        className="hidden w-5 flex-shrink-0 text-right font-title text-xs tabular-nums text-muted-foreground @sm:inline-block"
      >
        {String(index + 1).padStart(2, "0")}
      </span>
      <Link
        href={href}
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5"
      >
        {/* The glyph: the list's own status colour, already rendered here
            before the restyle — kept as the row's small circular monogram. */}
        <span
          aria-hidden
          className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
          style={{ backgroundColor: row.statusColor }}
          title={row.statusName}
        />
        <span className="min-w-0 flex-1 basis-48 truncate text-sm font-semibold">
          {row.title}
        </span>

        {/* Metadata as outlined chips, pushed right and wrapping under the
            title once the row runs out of room — driven by flex-wrap against
            the row's own width, not a viewport breakpoint. */}
        <span className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
          {needsApproval && (
            <span className="ui-chip inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-tiny font-medium">
              <ShieldAlert className="h-3 w-3" aria-hidden /> Approval
            </span>
          )}

          {row.priority && (
            <>
              <PriorityChip
                priority={row.priority}
                className="hidden @sm:inline-flex"
              />
              <PriorityDot priority={row.priority} className="@sm:hidden" />
            </>
          )}

          <span className="ui-chip whitespace-nowrap px-2 py-0.5 text-tiny text-muted-foreground">
            {row.listName}
          </span>

          {row.dueDate !== undefined && (
            <span
              className={cn(
                "ui-chip ui-figure whitespace-nowrap px-2 py-0.5 text-tiny font-medium",
                overdue ? "border-danger/40 text-danger" : "text-muted-foreground",
              )}
            >
              {formatDue(row.dueDate)}
            </span>
          )}
        </span>
      </Link>
    </div>
  );
}

function MyWorkSkeleton() {
  return (
    <div className="space-y-6">
      {[0, 1].map((s) => (
        <div key={s} className="space-y-2">
          <div className="h-4 w-24 animate-pulse rounded-full bg-muted" />
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-14 animate-pulse rounded-2xl bg-muted/50"
            />
          ))}
        </div>
      ))}
    </div>
  );
}
