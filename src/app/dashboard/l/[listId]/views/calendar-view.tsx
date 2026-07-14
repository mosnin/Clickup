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
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const PRIORITY_COLOR: Record<string, string> = {
  urgent: "#f2b3ab",
  high: "#f2c291",
  normal: "#a9c6f2",
  low: "#c9ccd4",
};

export function CalendarView({
  listId,
  tasks,
}: {
  listId: Id<"lists">;
  tasks: Doc<"tasks">[];
}) {
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));

  // Build a 6-row week grid that always covers the entire month + spillover.
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

      <div className="overflow-hidden rounded-2xl border border-border bg-background">
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
                  <div
                    key={key}
                    className={cn(
                      "min-h-24 border-r border-border p-1.5 last:border-r-0 sm:min-h-28",
                      !inMonth && "bg-muted/20 text-muted-foreground",
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
                      {dayTasks.slice(0, 3).map((t) => (
                        <li key={t._id}>
                          <Link
                            href={`/dashboard/l/${listId}/t/${t._id}`}
                            className="flex items-center gap-1 truncate rounded-full bg-muted px-1.5 py-0.5 text-[11px] hover:bg-brand-100 hover:text-brand-700"
                          >
                            {t.priority && (
                              <span
                                aria-hidden
                                className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full"
                                style={{
                                  backgroundColor:
                                    PRIORITY_COLOR[t.priority],
                                }}
                              />
                            )}
                            <span className="truncate">{t.title}</span>
                          </Link>
                        </li>
                      ))}
                      {dayTasks.length > 3 && (
                        <li className="text-[11px] text-muted-foreground">
                          +{dayTasks.length - 3} more
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
        <div className="rounded-2xl border border-dashed border-border bg-background p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            No due date
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {undated.map((t) => (
              <li key={t._id}>
                <Link
                  href={`/dashboard/l/${listId}/t/${t._id}`}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs hover:bg-brand-100 hover:text-brand-700"
                >
                  {t.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
