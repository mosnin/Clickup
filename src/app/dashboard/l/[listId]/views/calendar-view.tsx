"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
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
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { parseQuickAdd } from "@/lib/quick-add";
import { taskPeekHref } from "@/components/dashboard/task-peek";
import { useToast } from "@/components/toast";
import {
  PriorityDot,
  type TaskPriority,
} from "@/components/dashboard/priority";

function errorMessage(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  return (
    raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() || fallback
  );
}

// A calendar you can schedule on: drag a task chip onto a day to reschedule,
// click a day's empty space to create a task due that day, click a chip to
// peek at the task without leaving the month.

export function CalendarView({
  listId,
  tasks,
}: {
  listId: Id<"lists">;
  tasks: Doc<"tasks">[];
}) {
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [composing, setComposing] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const update = useMutation(api.tasks.update);
  const create = useMutation(api.tasks.create);

  // Build a week grid that always covers the entire month + spillover.
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

  const undated = tasks.filter((t) => !t.dueDate);

  function dayTimestamp(day: Date): number {
    // Local midnight, matching the date-input round-trip in lib/dates.
    return new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
    ).getTime();
  }

  function onDrop(day: Date, e: React.DragEvent) {
    e.preventDefault();
    setDragOver(null);
    const taskId = e.dataTransfer.getData("text/task-id");
    if (!taskId) return;
    void update({
      taskId: taskId as Id<"tasks">,
      dueDate: dayTimestamp(day),
    });
  }

  return (
    <div className="space-y-3">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{format(cursor, "MMMM yyyy")}</h2>
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

      {tasks.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Click any day to schedule your first task.
        </p>
      )}

      <div className="overflow-hidden rounded-2xl panel">
        <div className="grid grid-cols-7 text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
            <div key={d} className="py-2.5">
              {d}
            </div>
          ))}
        </div>
        <div>
          {weeks.map((week, wi) => (
            <div key={wi} className="grid grid-cols-7">
              {week.map((day) => {
                const key = format(day, "yyyy-MM-dd");
                const dayTasks = tasksByDay.get(key) ?? [];
                const inMonth = isSameMonth(day, cursor);
                const today = isSameDay(day, new Date());
                const isExpanded = expanded.has(key);
                const shown = isExpanded ? dayTasks : dayTasks.slice(0, 3);
                return (
                  <div
                    key={key}
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      // Only empty-space clicks start a quick add.
                      if (e.target === e.currentTarget) setComposing(key);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(key);
                    }}
                    onDragLeave={() =>
                      setDragOver((cur) => (cur === key ? null : cur))
                    }
                    onDrop={(e) => onDrop(day, e)}
                    className={cn(
                      "min-h-24 cursor-pointer p-1.5 transition-colors sm:min-h-28",
                      !inMonth && "bg-muted/25 text-muted-foreground",
                      dragOver === key && "bg-muted/70",
                    )}
                  >
                    <div
                      className={cn(
                        "pointer-events-none mb-1 flex h-5 w-5 items-center justify-center text-[11px]",
                        today &&
                          "rounded-full bg-foreground font-medium text-background",
                      )}
                    >
                      {day.getDate()}
                    </div>
                    <ul className="space-y-1">
                      {shown.map((t) => (
                        <li key={t._id}>
                          <TaskChip task={t} />
                        </li>
                      ))}
                      {dayTasks.length > 3 && (
                        <li>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpanded((prev) => {
                                const next = new Set(prev);
                                if (next.has(key)) next.delete(key);
                                else next.add(key);
                                return next;
                              });
                            }}
                            className="text-[11px] text-muted-foreground hover:text-foreground"
                          >
                            {isExpanded
                              ? "Show less"
                              : `+${dayTasks.length - 3} more`}
                          </button>
                        </li>
                      )}
                      {composing === key && (
                        <li onClick={(e) => e.stopPropagation()}>
                          <QuickAdd
                            onSubmit={async (title) => {
                              const parsed = parseQuickAdd(title);
                              await create({
                                listId,
                                title: parsed.title || title,
                                // The clicked day owns the date.
                                dueDate: dayTimestamp(day),
                                priority: parsed.priority,
                              });
                            }}
                            onClose={() => setComposing(null)}
                          />
                        </li>
                      )}
                    </ul>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {undated.length > 0 && (
        <div className="rounded-2xl panel p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            No due date · drag onto a day to schedule
          </p>
          <ul className="mt-2.5 flex flex-wrap gap-2">
            {undated.map((t) => (
              <li key={t._id}>
                <TaskChip task={t} pill />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TaskChip({ task, pill }: { task: Doc<"tasks">; pill?: boolean }) {
  const searchParams = useSearchParams();
  return (
    <Link
      href={taskPeekHref(searchParams, task._id)}
      scroll={false}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/task-id", task._id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "flex cursor-grab items-center gap-1 truncate rounded-full bg-muted text-[11px] transition-colors hover:bg-brand-100 hover:text-brand-700 active:cursor-grabbing",
        pill ? "px-2 py-1 text-xs" : "px-1.5 py-0.5",
      )}
    >
      {task.priority && (
        <PriorityDot
          priority={task.priority as TaskPriority}
          className="h-1.5 w-1.5"
        />
      )}
      <span className="truncate">{task.title}</span>
    </Link>
  );
}

function QuickAdd({
  onSubmit,
  onClose,
}: {
  onSubmit: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const { toast } = useToast();
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const t = title.trim();
        if (!t) return onClose();
        try {
          await onSubmit(t);
          setTitle("");
          onClose();
        } catch (err) {
          toast(errorMessage(err, "Couldn't create task"), { kind: "error" });
        }
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        onBlur={onClose}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        placeholder="New task…"
        aria-label="New task title"
        className="soft-field w-full px-1.5 py-1 text-[11px]"
      />
    </form>
  );
}
