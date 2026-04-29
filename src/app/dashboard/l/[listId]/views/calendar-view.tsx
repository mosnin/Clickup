"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  addMonths,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useMutation } from "convex/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const PRIORITY_COLOR: Record<string, string> = {
  urgent: "#ef4444",
  high: "#f97316",
  normal: "#3b82f6",
  low: "#a1a1aa",
};

export function CalendarView({
  listId,
  tasks,
}: {
  listId: Id<"lists">;
  tasks: Doc<"tasks">[];
}) {
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const update = useMutation(api.tasks.update);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const weeks = useMemo(() => {
    const start = startOfWeek(startOfMonth(cursor), { weekStartsOn: 0 });
    const end = endOfWeek(endOfMonth(cursor), { weekStartsOn: 0 });
    const days: Date[] = [];
    for (let d = start; d <= end; d = new Date(d.getTime() + 86_400_000)) {
      days.push(d);
    }
    const rows: Date[][] = [];
    for (let i = 0; i < days.length; i += 7) rows.push(days.slice(i, i + 7));
    return rows;
  }, [cursor]);

  const tasksByDay = useMemo(() => {
    const map = new Map<string, Doc<"tasks">[]>();
    for (const task of tasks) {
      if (!task.dueDate) continue;
      const key = format(new Date(task.dueDate), "yyyy-MM-dd");
      const arr = map.get(key);
      if (arr) arr.push(task);
      else map.set(key, [task]);
    }
    return map;
  }, [tasks]);

  const undated = tasks.filter((t) => !t.dueDate).slice(0, 6);

  // Drop ids are `day:yyyy-MM-dd` for month cells and `undated` for the
  // backlog row, so the handler can route both directions cleanly.
  function onDragEnd(e: DragEndEvent) {
    const taskId = e.active.id as Id<"tasks">;
    const overId = e.over?.id as string | undefined;
    if (!overId) return;
    if (overId === "undated") {
      update({ taskId, dueDate: null });
      return;
    }
    if (overId.startsWith("day:")) {
      const iso = overId.slice("day:".length);
      const date = new Date(iso + "T00:00:00");
      update({ taskId, dueDate: date.getTime() });
    }
  }

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="space-y-3">
        <header className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">
            {format(cursor, "MMMM yyyy")}
          </h2>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCursor((c) => addMonths(c, -1))}
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCursor(startOfMonth(new Date()))}
            >
              Today
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCursor((c) => addMonths(c, 1))}
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </header>

        {/* Mobile: vertical schedule. A 7-column month grid is unreadable
            on a phone — replace it with a date-grouped list of upcoming
            tasks. Desktop drops back to the grid below. */}
        <MobileSchedule tasks={tasks} listId={listId} />

        <div className="hidden overflow-hidden rounded-3xl border border-border bg-background sm:block">
          <div className="grid grid-cols-7 border-b border-border bg-muted/40 text-center text-xs uppercase tracking-wider text-muted-foreground">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <div key={d} className="py-2">
                {d}
              </div>
            ))}
          </div>
          <div>
            {weeks.map((week, wi) => (
              <div
                key={wi}
                className="grid grid-cols-7 border-b border-border last:border-b-0"
              >
                {week.map((day) => {
                  const key = format(day, "yyyy-MM-dd");
                  const dayTasks = tasksByDay.get(key) ?? [];
                  const inMonth = isSameMonth(day, cursor);
                  const today = isSameDay(day, new Date());
                  return (
                    <DayCell
                      key={key}
                      dayKey={key}
                      day={day}
                      tasks={dayTasks}
                      inMonth={inMonth}
                      today={today}
                      listId={listId}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Desktop-only undated drop zone. On mobile MobileSchedule
            already lists undated tasks and there's no drag-to-clear. */}
        <div className="hidden sm:block">
          <UndatedDrop>
            {undated.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-2">
                {undated.map((t) => (
                  <li key={t._id}>
                    <DraggablePill task={t} listId={listId} />
                  </li>
                ))}
              </ul>
            )}
          </UndatedDrop>
        </div>
      </div>
    </DndContext>
  );
}

function MobileSchedule({
  tasks,
  listId,
}: {
  tasks: Doc<"tasks">[];
  listId: Id<"lists">;
}) {
  // Group dated tasks by yyyy-MM-dd, sorted ascending. Anything past
  // returns near the top so a Monday morning user sees what's overdue.
  const dated = tasks.filter((t) => t.dueDate).sort((a, b) =>
    (a.dueDate ?? 0) - (b.dueDate ?? 0),
  );
  const undated = tasks.filter((t) => !t.dueDate);

  if (dated.length === 0 && undated.length === 0) {
    return (
      <div className="block rounded-3xl border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground sm:hidden">
        No dated tasks. Add a due date in the task editor to see it here.
      </div>
    );
  }

  const groups = new Map<string, Doc<"tasks">[]>();
  for (const t of dated) {
    const d = new Date(t.dueDate!);
    const key = format(d, "yyyy-MM-dd");
    const arr = groups.get(key);
    if (arr) arr.push(t);
    else groups.set(key, [t]);
  }

  const today = new Date();
  const todayKey = format(today, "yyyy-MM-dd");

  return (
    <div className="block space-y-3 sm:hidden">
      {Array.from(groups.entries()).map(([key, taskList]) => {
        const date = new Date(key + "T00:00:00");
        const isPast = key < todayKey;
        const isToday = key === todayKey;
        return (
          <section
            key={key}
            className="rounded-3xl border border-border bg-background p-3"
          >
            <h3
              className={cn(
                "text-xs font-semibold uppercase tracking-wider",
                isPast && "text-red-700",
                isToday && "text-brand-700",
                !isPast && !isToday && "text-muted-foreground",
              )}
            >
              {isToday ? "Today" : format(date, "EEEE, MMM d")}
              {isPast && " · overdue"}
            </h3>
            <ul className="mt-2 space-y-1">
              {taskList.map((t) => (
                <li key={t._id}>
                  <Link
                    href={`/dashboard/l/${listId}/t/${t._id}`}
                    className="flex items-center gap-2 rounded-2xl px-2 py-1.5 text-sm hover:bg-muted"
                  >
                    {t.priority && (
                      <span
                        aria-hidden
                        className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full"
                        style={{
                          backgroundColor: PRIORITY_COLOR[t.priority],
                        }}
                      />
                    )}
                    <span className="truncate">{t.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {undated.length > 0 && (
        <section className="rounded-3xl border border-dashed border-border p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            No due date
          </h3>
          <ul className="mt-2 space-y-1">
            {undated.slice(0, 12).map((t) => (
              <li key={t._id}>
                <Link
                  href={`/dashboard/l/${listId}/t/${t._id}`}
                  className="block truncate rounded-2xl px-2 py-1.5 text-sm hover:bg-muted"
                >
                  {t.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function DayCell({
  dayKey,
  day,
  tasks,
  inMonth,
  today,
  listId,
}: {
  dayKey: string;
  day: Date;
  tasks: Doc<"tasks">[];
  inMonth: boolean;
  today: boolean;
  listId: Id<"lists">;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${dayKey}` });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "min-h-24 border-r border-border p-1.5 last:border-r-0 sm:min-h-28",
        !inMonth && "bg-muted/20 text-muted-foreground",
        isOver && "bg-brand-50/60",
      )}
    >
      <div
        className={cn(
          "mb-1 flex h-5 w-5 items-center justify-center text-[11px]",
          today && "rounded-full bg-brand-600 text-white",
        )}
      >
        {day.getDate()}
      </div>
      <ul className="space-y-1">
        {tasks.slice(0, 3).map((t) => (
          <li key={t._id}>
            <DraggablePill task={t} listId={listId} />
          </li>
        ))}
        {tasks.length > 3 && (
          <li className="text-[11px] text-muted-foreground">
            +{tasks.length - 3} more
          </li>
        )}
      </ul>
    </div>
  );
}

function DraggablePill({
  task,
  listId,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
}) {
  const { setNodeRef, attributes, listeners, isDragging, transform } =
    useDraggable({ id: task._id });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={cn(
        "flex items-center gap-1 truncate rounded-full bg-muted px-1.5 py-0.5 text-[11px] hover:bg-brand-100 hover:text-brand-700",
        isDragging && "opacity-50",
      )}
    >
      {task.priority && (
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full"
          style={{ backgroundColor: PRIORITY_COLOR[task.priority] }}
        />
      )}
      <Link
        href={`/dashboard/l/${listId}/t/${task._id}`}
        className="truncate"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {task.title}
      </Link>
    </div>
  );
}

function UndatedDrop({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: "undated" });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-3xl border border-dashed border-border bg-background p-3",
        isOver && "border-brand-500 bg-brand-50/40",
      )}
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        No due date {isOver && "— drop to clear"}
      </p>
      {children}
    </div>
  );
}
