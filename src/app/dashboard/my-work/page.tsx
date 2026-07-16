"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "convex/react";
import { ShieldAlert } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Stagger, StaggerItem } from "@/components/motion";
import {
  PriorityChip,
  PriorityDot,
  type TaskPriority,
} from "@/components/dashboard/priority";
import { EmptyState } from "@/components/dashboard/empty-state";

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
      <header className="title-rule">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">My work</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {rows === undefined
            ? "Gathering everything assigned to you…"
            : total === 0
              ? "Nothing is assigned to you right now."
              : `${total} open task${total === 1 ? "" : "s"} assigned to you.`}
        </p>
      </header>

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
                <Stagger className="space-y-2">
                  {items.map((r) => (
                    <StaggerItem key={r._id}>
                      <TaskRow row={r} overdue={key === "overdue"} />
                    </StaggerItem>
                  ))}
                </Stagger>
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

function TaskRow({ row, overdue }: { row: Row; overdue: boolean }) {
  const href = `/dashboard/l/${row.listId as Id<"lists">}/t/${row._id}`;
  const needsApproval =
    row.requiresApproval && row.approvedAt === undefined;
  return (
    <Link
      href={href}
      className="lift flex items-center gap-3 rounded-2xl bento px-4 py-3 hover:border-foreground/25"
    >
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
        <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-pastel-yellow px-2 py-0.5 text-[11px] font-medium text-foreground/80">
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
