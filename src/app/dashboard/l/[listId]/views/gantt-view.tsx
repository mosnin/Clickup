"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import {
  addDays,
  differenceInCalendarDays,
  eachDayOfInterval,
  format,
  isSameDay,
  isWeekend,
  startOfDay,
} from "date-fns";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { taskPeekHref } from "@/components/dashboard/task-peek";
import { EmptyState } from "@/components/dashboard/empty-state";

// A Gantt you can actually plan on: drag a bar to move the whole task in
// time, drag either edge to change its start or due date. Changes commit on
// release; the bar follows the pointer optimistically while dragging.

const DAY_PX = 36;
const ROW_PX = 44;

type DragState = {
  taskId: Id<"tasks">;
  mode: "move" | "start" | "end";
  originX: number;
  /** Day offsets at drag start. */
  startOffset: number;
  endOffset: number;
  /** Live day delta while dragging. */
  delta: number;
};

export function GanttView({
  tasks,
  statuses,
}: {
  listId: Id<"lists">;
  tasks: Doc<"tasks">[];
  statuses: Doc<"listStatuses">[];
}) {
  const searchParams = useSearchParams();
  const update = useMutation(api.tasks.update);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const datedTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.startDate || t.dueDate)
        .slice()
        .sort((a, b) => {
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
      <div className="rounded-2xl bento">
        <EmptyState
          title="Nothing on the timeline yet"
          message="Give a task a start or due date and it appears here as a bar you can drag to plan."
        />
      </div>
    );
  }

  const today = startOfDay(new Date());

  function beginDrag(
    e: React.PointerEvent,
    task: Doc<"tasks">,
    mode: DragState["mode"],
    startOffset: number,
    endOffset: number,
  ) {
    e.preventDefault();
    e.stopPropagation();
    const state: DragState = {
      taskId: task._id,
      mode,
      originX: e.clientX,
      startOffset,
      endOffset,
      delta: 0,
    };
    dragRef.current = state;
    setDrag(state);

    function onMove(ev: PointerEvent) {
      const cur = dragRef.current;
      if (!cur) return;
      const delta = Math.round((ev.clientX - cur.originX) / DAY_PX);
      if (delta !== cur.delta) {
        const next = { ...cur, delta };
        dragRef.current = next;
        setDrag(next);
      }
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const cur = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!cur || cur.delta === 0) return;

      let newStart = cur.startOffset;
      let newEnd = cur.endOffset;
      if (cur.mode === "move") {
        newStart += cur.delta;
        newEnd += cur.delta;
      } else if (cur.mode === "start") {
        newStart = Math.min(cur.startOffset + cur.delta, newEnd);
      } else {
        newEnd = Math.max(cur.endOffset + cur.delta, newStart);
      }
      const toTs = (offset: number) =>
        addDays(start, offset).getTime();
      const patch: {
        taskId: Id<"tasks">;
        startDate?: number;
        dueDate?: number;
      } = { taskId: cur.taskId };
      const task = datedTasks.find((t) => t._id === cur.taskId);
      if (!task) return;
      // Only write fields the task actually uses: a due-only task dragged
      // around stays due-only.
      if (task.startDate !== undefined || cur.mode === "start") {
        patch.startDate = toTs(newStart);
      }
      if (task.dueDate !== undefined || cur.mode === "end") {
        patch.dueDate = toTs(newEnd);
      }
      void update(patch);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div className="overflow-x-auto rounded-2xl bento">
      <div style={{ minWidth: 240 + totalWidth }}>
        <div className="flex">
          <div className="w-60 flex-shrink-0 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Task
          </div>
          <div className="flex-1">
            <div className="flex">
              {days.map((d) => (
                <div
                  key={d.getTime()}
                  className={cn(
                    "flex h-10 flex-col items-center justify-center text-[10px] uppercase tracking-wider text-muted-foreground",
                    isWeekend(d) && "bg-muted/40",
                    isSameDay(d, today) && "bg-muted font-semibold text-foreground",
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

          let offset = differenceInCalendarDays(startDay, start);
          let endOffset = differenceInCalendarDays(endDay, start);

          // Follow the pointer while this bar is being dragged.
          if (drag?.taskId === task._id) {
            if (drag.mode === "move") {
              offset = drag.startOffset + drag.delta;
              endOffset = drag.endOffset + drag.delta;
            } else if (drag.mode === "start") {
              offset = Math.min(drag.startOffset + drag.delta, endOffset);
            } else {
              endOffset = Math.max(drag.endOffset + drag.delta, offset);
            }
          }
          const span = endOffset - offset + 1; // inclusive

          const baseStart = differenceInCalendarDays(startDay, start);
          const baseEnd = differenceInCalendarDays(endDay, start);

          return (
            <div
              key={task._id}
              className="group flex"
              style={{ height: ROW_PX }}
            >
              <Link
                href={taskPeekHref(searchParams, task._id)}
                scroll={false}
                className="w-60 flex-shrink-0 truncate px-4 py-2.5 text-sm transition-colors hover:bg-muted"
                title={task.title}
              >
                {task.title}
              </Link>
              <div
                className="relative flex-1"
                style={{
                  background: `repeating-linear-gradient(to right, transparent 0, transparent ${
                    DAY_PX - 1
                  }px, color-mix(in srgb, var(--color-border) 45%, transparent) ${DAY_PX - 1}px, color-mix(in srgb, var(--color-border) 45%, transparent) ${
                    DAY_PX
                  }px)`,
                }}
              >
                <div
                  className={cn(
                    "absolute top-1/2 flex -translate-y-1/2 cursor-grab items-center rounded-full px-2 text-xs font-medium text-foreground/80 shadow-sm transition-shadow",
                    drag?.taskId === task._id
                      ? "cursor-grabbing shadow-md"
                      : "hover:shadow-md",
                  )}
                  style={{
                    left: offset * DAY_PX + 2,
                    width: Math.max(span * DAY_PX - 4, 24),
                    height: 26,
                    backgroundColor: status?.color ?? "#a9c6f2",
                  }}
                  title={`${format(addDays(start, offset), "MMM d")} to ${format(addDays(start, endOffset), "MMM d")} · drag to move, edges to resize`}
                  onPointerDown={(e) =>
                    beginDrag(e, task, "move", baseStart, baseEnd)
                  }
                >
                  <span
                    role="presentation"
                    className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-full"
                    onPointerDown={(e) =>
                      beginDrag(e, task, "start", baseStart, baseEnd)
                    }
                  />
                  <span className="pointer-events-none block truncate">
                    {task.title}
                  </span>
                  <span
                    role="presentation"
                    className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-full"
                    onPointerDown={(e) =>
                      beginDrag(e, task, "end", baseStart, baseEnd)
                    }
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
