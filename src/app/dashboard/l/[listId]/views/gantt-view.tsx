"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  addDays,
  differenceInCalendarDays,
  eachDayOfInterval,
  format,
  isSameDay,
  isWeekend,
  startOfDay,
} from "date-fns";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";

// Width of one day column in pixels. Kept on the small side so a typical
// 30-day window fits in view; horizontal scroll for longer ranges.
const DAY_PX = 36;
const ROW_PX = 40;

export function GanttView({
  listId,
  tasks,
  statuses,
}: {
  listId: Id<"lists">;
  tasks: Doc<"tasks">[];
  statuses: Doc<"listStatuses">[];
}) {
  const datedTasks = useMemo(
    () =>
      tasks.filter((t) => t.startDate || t.dueDate).slice().sort((a, b) => {
        const aStart = a.startDate ?? a.dueDate ?? 0;
        const bStart = b.startDate ?? b.dueDate ?? 0;
        return aStart - bStart;
      }),
    [tasks],
  );

  // Pick a 6-week window centered around today, but extend to fit any
  // task's range so nothing renders off-grid.
  const { start, days } = useMemo(() => {
    const today = startOfDay(new Date());
    let start = addDays(today, -7);
    let end = addDays(today, 35);
    for (const t of datedTasks) {
      if (t.startDate) {
        const s = startOfDay(new Date(t.startDate));
        if (s < start) start = s;
      }
      if (t.dueDate) {
        const d = startOfDay(new Date(t.dueDate));
        if (d > end) end = d;
      }
    }
    const days = eachDayOfInterval({ start, end });
    return { start, days };
  }, [datedTasks]);

  const totalWidth = days.length * DAY_PX;

  if (datedTasks.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-10 text-center">
        <p className="text-sm text-muted-foreground">
          No tasks have a start or due date yet. Add dates in a task to see it
          on the Gantt.
        </p>
      </div>
    );
  }

  const today = startOfDay(new Date());

  return (
    <div className="overflow-x-auto rounded-2xl bento">
      <div style={{ minWidth: 240 + totalWidth }}>
        <div className="flex border-b border-border">
          <div className="w-60 flex-shrink-0 border-r border-border bg-muted/40 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Task
          </div>
          <div className="flex-1">
            <div className="flex">
              {days.map((d) => (
                <div
                  key={d.getTime()}
                  className={cn(
                    "flex h-10 flex-col items-center justify-center border-r border-border text-[10px] uppercase tracking-wider text-muted-foreground last:border-r-0",
                    isWeekend(d) && "bg-muted/30",
                    isSameDay(d, today) && "bg-brand-50 text-brand-700",
                  )}
                  style={{ width: DAY_PX }}
                >
                  <span>{format(d, "EEEEEE")}</span>
                  <span className="text-foreground">{d.getDate()}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {datedTasks.map((task) => {
          const status = statuses.find((s) => s._id === task.statusId);
          const startDay = task.startDate
            ? startOfDay(new Date(task.startDate))
            : task.dueDate
              ? startOfDay(new Date(task.dueDate))
              : null;
          const endDay = task.dueDate
            ? startOfDay(new Date(task.dueDate))
            : startDay;
          if (!startDay || !endDay) return null;

          const offset = differenceInCalendarDays(startDay, start);
          const span =
            differenceInCalendarDays(endDay, startDay) + 1; // inclusive

          return (
            <div
              key={task._id}
              className="flex border-b border-border last:border-b-0"
              style={{ height: ROW_PX }}
            >
              <Link
                href={`/dashboard/l/${listId}/t/${task._id}`}
                className="w-60 flex-shrink-0 truncate border-r border-border px-3 py-2 text-sm hover:bg-muted"
                title={task.title}
              >
                {task.title}
              </Link>
              <div
                className="relative flex-1"
                style={{
                  background: `repeating-linear-gradient(to right, transparent 0, transparent ${
                    DAY_PX - 1
                  }px, var(--color-border) ${DAY_PX - 1}px, var(--color-border) ${
                    DAY_PX
                  }px)`,
                }}
              >
                <div
                  className="absolute top-1/2 -translate-y-1/2 rounded-full px-2 text-xs font-medium text-white"
                  style={{
                    left: offset * DAY_PX + 2,
                    width: Math.max(span * DAY_PX - 4, 24),
                    height: 24,
                    backgroundColor: status?.color ?? "#a9c6f2",
                    lineHeight: "24px",
                  }}
                  title={`${format(startDay, "MMM d")} – ${format(endDay, "MMM d")}`}
                >
                  <span className="block truncate">
                    {status?.name ?? "Task"}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
