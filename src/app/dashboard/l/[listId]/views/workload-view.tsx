"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { useQuery } from "convex/react";
import { Minus } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { EmptyState } from "@/components/dashboard/empty-state";
import { taskPeekHref } from "@/components/dashboard/task-peek";
import {
  PriorityDot,
  type TaskPriority,
} from "@/components/dashboard/priority";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Stagger, StaggerItem } from "@/components/motion";
import { cn } from "@/lib/utils";

const UNASSIGNED_ID = "__unassigned__";
const MAX_CHIPS = 5;

type WorkloadMode = "tasks" | "points";

type Bucket = {
  id: string;
  name: string;
  kind: "user" | "agent";
  openTasks: Doc<"tasks">[];
  doneCount: number;
  overdueCount: number;
  pointsTotal: number;
  unestimatedCount: number;
};

// Per-person capacity view: who is carrying what right now, humans and
// agents alike. Buckets are derived client-side from the task list (a task
// with multiple assignees counts toward every one of them) — there's no
// dedicated backend aggregation for this yet, and the list sizes this
// targets make that fine.
//
// Renders on the vendored Square shell's Card/Progress/Badge primitives
// (Phase H); the bucketing logic underneath is unchanged.
export function WorkloadView({
  listId,
  tasks,
  statuses,
}: {
  listId: Id<"lists">;
  tasks: Doc<"tasks">[];
  statuses: Doc<"listStatuses">[];
}) {
  const people = useQuery(api.agents.listAssignableForList, { listId });
  const router = useRouter();
  const searchParams = useSearchParams();
  const mode: WorkloadMode =
    searchParams.get("wl") === "points" ? "points" : "tasks";

  function setMode(next: WorkloadMode) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "points") params.set("wl", "points");
    else params.delete("wl");
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }

  const doneStatusIds = useMemo(
    () =>
      new Set(
        statuses
          .filter((s) => s.category === "complete" || s.category === "closed")
          .map((s) => s._id),
      ),
    [statuses],
  );

  const buckets = useMemo(() => {
    const map = new Map<string, Bucket>();
    for (const p of people ?? []) {
      map.set(p.id, {
        id: p.id,
        name: p.name,
        kind: p.kind,
        openTasks: [],
        doneCount: 0,
        overdueCount: 0,
        pointsTotal: 0,
        unestimatedCount: 0,
      });
    }
    const unassigned: Bucket = {
      id: UNASSIGNED_ID,
      name: "Unassigned",
      kind: "user",
      openTasks: [],
      doneCount: 0,
      overdueCount: 0,
      pointsTotal: 0,
      unestimatedCount: 0,
    };

    const now = Date.now();
    for (const t of tasks) {
      const done = doneStatusIds.has(t.statusId);
      const overdue = !done && t.dueDate !== undefined && t.dueDate < now;
      const ids = t.assigneeClerkIds.length > 0 ? t.assigneeClerkIds : null;

      if (!ids) {
        if (done) unassigned.doneCount += 1;
        else {
          unassigned.openTasks.push(t);
          if (overdue) unassigned.overdueCount += 1;
          if (t.estimatePoints !== undefined) {
            unassigned.pointsTotal += t.estimatePoints;
          } else {
            unassigned.unestimatedCount += 1;
          }
        }
        continue;
      }

      for (const id of ids) {
        let bucket = map.get(id);
        if (!bucket) {
          // Assigned but no longer resolvable via listAssignableForList
          // (e.g. removed from the space) — still show their workload.
          bucket = {
            id,
            name: id,
            kind: "user",
            openTasks: [],
            doneCount: 0,
            overdueCount: 0,
            pointsTotal: 0,
            unestimatedCount: 0,
          };
          map.set(id, bucket);
        }
        if (done) bucket.doneCount += 1;
        else {
          bucket.openTasks.push(t);
          if (overdue) bucket.overdueCount += 1;
          if (t.estimatePoints !== undefined) {
            bucket.pointsTotal += t.estimatePoints;
          } else {
            bucket.unestimatedCount += 1;
          }
        }
      }
    }

    const rows = [...map.values()].sort(
      (a, b) => b.openTasks.length - a.openTasks.length,
    );
    return { rows, unassigned };
  }, [people, tasks, doneStatusIds]);

  const maxPoints = useMemo(
    () =>
      Math.max(
        1,
        buckets.unassigned.pointsTotal,
        ...buckets.rows.map((b) => b.pointsTotal),
      ),
    [buckets],
  );

  if (tasks.length === 0) {
    return (
      <EmptyState
        title="Nobody has work here yet"
        message="Assign a task to a teammate or agent to see their workload here."
      />
    );
  }

  if (people === undefined) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl bg-muted/50" />
        ))}
      </div>
    );
  }

  const hasUnassigned =
    buckets.unassigned.openTasks.length > 0 || buckets.unassigned.doneCount > 0;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <div className="inline-flex items-center gap-1 text-sm">
          {(["tasks", "points"] as WorkloadMode[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              aria-pressed={mode === key}
              className={cn(
                "rounded-md px-3 py-1.5 capitalize transition-colors",
                mode === key
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {key}
            </button>
          ))}
        </div>
      </div>

      <Stagger className="space-y-3">
        {buckets.rows.map((bucket) => (
          <StaggerItem key={bucket.id}>
            <PersonRow bucket={bucket} mode={mode} maxPoints={maxPoints} />
          </StaggerItem>
        ))}
        {hasUnassigned && (
          <StaggerItem>
            <PersonRow
              bucket={buckets.unassigned}
              unassigned
              mode={mode}
              maxPoints={maxPoints}
            />
          </StaggerItem>
        )}
      </Stagger>
    </div>
  );
}

function PersonRow({
  bucket,
  unassigned = false,
  mode,
  maxPoints,
}: {
  bucket: Bucket;
  unassigned?: boolean;
  mode: WorkloadMode;
  maxPoints: number;
}) {
  const searchParams = useSearchParams();
  const openCount = bucket.openTasks.length;
  const total = openCount + bucket.doneCount;
  const pct =
    mode === "points"
      ? (bucket.pointsTotal / maxPoints) * 100
      : total > 0
        ? (bucket.doneCount / total) * 100
        : 0;
  const clampedPct = Math.min(100, Math.max(0, pct));
  const shown = bucket.openTasks.slice(0, MAX_CHIPS);
  const extra = openCount - shown.length;
  const initial = bucket.name.trim().charAt(0).toUpperCase() || "?";

  return (
    <Card className="gap-3 rounded-2xl p-4">
      <div className="flex items-center gap-3">
        {unassigned ? (
          <span
            aria-hidden
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
          >
            <Minus className="h-4 w-4" />
          </span>
        ) : (
          <span
            aria-hidden
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-medium text-white"
          >
            {initial}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium">{bucket.name}</p>
            {bucket.kind === "agent" && (
              <Badge variant="secondary" className="uppercase tracking-wider text-[10px]">
                Agent
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {openCount} open
            {bucket.overdueCount > 0 && (
              <>
                {" · "}
                <span className="text-danger">
                  {bucket.overdueCount} overdue
                </span>
              </>
            )}
            {" · "}
            {bucket.doneCount} done
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Progress value={clampedPct} className="h-1.5 flex-1" />
        {mode === "points" && bucket.unestimatedCount > 0 && (
          <Badge variant="secondary" className="flex-shrink-0 text-[10px]">
            {bucket.unestimatedCount} unestimated
          </Badge>
        )}
      </div>

      {shown.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {shown.map((task) => (
            <Link
              key={task._id}
              href={taskPeekHref(searchParams, task._id)}
              scroll={false}
              className="inline-flex max-w-[13rem] items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-foreground/80 hover:bg-muted/70"
            >
              {task.priority && (
                <PriorityDot priority={task.priority as TaskPriority} />
              )}
              <span className="truncate">{task.title}</span>
              {mode === "points" && task.estimatePoints !== undefined && (
                <span className="flex-shrink-0 rounded-full bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {task.estimatePoints}
                </span>
              )}
            </Link>
          ))}
          {extra > 0 && (
            <span className="text-xs text-muted-foreground">
              +{extra} more
            </span>
          )}
        </div>
      )}
    </Card>
  );
}
