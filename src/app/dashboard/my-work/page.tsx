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
                <div className="mb-3 flex items-baseline justify-between">
                  <h2
                    className={cn(
                      "text-sm font-semibold uppercase tracking-wider",
                      key === "overdue"
                        ? "text-danger"
                        : "text-muted-foreground",
                    )}
                  >
                    {label}
                    <span className="ml-2 font-normal normal-case tracking-normal text-muted-foreground">
                      {items.length}
                    </span>
                  </h2>
                  <span className="text-xs text-muted-foreground">{hint}</span>
                </div>
                <Card className="gap-0 overflow-hidden rounded-2xl py-0">
                  <Stagger>
                    {items.map((r, i) => (
                      <StaggerItem key={r._id}>
                        <TaskRow
                          row={r}
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
  overdue,
  isLast,
}: {
  row: Row;
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
      <Link href={href} className="flex min-w-0 flex-1 items-center gap-3">
        <span
          aria-hidden
          className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
          style={{ backgroundColor: row.statusColor }}
          title={row.statusName}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{row.title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {row.listName} · {row.statusName}
          </p>
        </div>

        {needsApproval && (
          <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-pastel-yellow px-2 py-0.5 text-[11px] font-medium text-foreground/80 dark:text-neutral-900/80">
            <ShieldAlert className="h-3 w-3" aria-hidden /> Approval
          </span>
        )}

        {row.priority && (
          <>
            <PriorityChip
              priority={row.priority}
              className="hidden sm:inline-flex"
            />
            <PriorityDot priority={row.priority} className="sm:hidden" />
          </>
        )}

        {row.dueDate !== undefined && (
          <span
            className={cn(
              "flex-shrink-0 text-xs font-medium tabular-nums",
              overdue ? "text-danger" : "text-muted-foreground",
            )}
          >
            {formatDue(row.dueDate)}
          </span>
        )}
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
