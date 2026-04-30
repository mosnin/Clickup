"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Doc } from "@convex/_generated/dataModel";

// Per-list filter state. Filters are quick-toggle chips; multiple
// active chips AND together. State persists in localStorage so a user
// who hides completed once doesn't have to keep doing it.
//
// Hide-completed defaults ON because the most common surprise is "why
// is my list cluttered with finished work?" Done-by-default plus an
// obvious chip is more honest than silently filtering.

export type TaskFilter = {
  mine: boolean;
  dueThisWeek: boolean;
  highPriorityPlus: boolean;
  hideCompleted: boolean;
};

const DEFAULT_FILTER: TaskFilter = {
  mine: false,
  dueThisWeek: false,
  highPriorityPlus: false,
  hideCompleted: true,
};

const STORAGE_PREFIX = "pace.filter.";

function loadFilter(listId: string): TaskFilter {
  if (typeof window === "undefined") return DEFAULT_FILTER;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + listId);
    if (!raw) return DEFAULT_FILTER;
    const parsed = JSON.parse(raw) as Partial<TaskFilter>;
    return { ...DEFAULT_FILTER, ...parsed };
  } catch {
    return DEFAULT_FILTER;
  }
}

export function useTaskFilter(listId: string) {
  const [filter, setFilterState] = useState<TaskFilter>(DEFAULT_FILTER);

  // Hydrate from localStorage on mount. We start with DEFAULT_FILTER on
  // the server render so the markup matches; the swap on first effect
  // is invisible to anyone who isn't already filtering.
  useEffect(() => {
    setFilterState(loadFilter(listId));
  }, [listId]);

  const setFilter = useCallback(
    (next: TaskFilter | ((prev: TaskFilter) => TaskFilter)) => {
      setFilterState((prev) => {
        const value = typeof next === "function" ? next(prev) : next;
        if (typeof window !== "undefined") {
          window.localStorage.setItem(
            STORAGE_PREFIX + listId,
            JSON.stringify(value),
          );
        }
        return value;
      });
    },
    [listId],
  );

  return { filter, setFilter };
}

export function isFilterActive(filter: TaskFilter): boolean {
  return (
    filter.mine ||
    filter.dueThisWeek ||
    filter.highPriorityPlus ||
    !filter.hideCompleted
  );
}

// Sunday-end-of-week in local time. Tasks due Saturday 11:59pm match;
// Monday next week doesn't.
function endOfWeek(now: Date): number {
  const d = new Date(now);
  const day = d.getDay(); // 0=Sun
  const diff = (7 - day) % 7;
  d.setDate(d.getDate() + diff);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function applyFilter(
  tasks: Doc<"tasks">[],
  filter: TaskFilter,
  statuses: Doc<"listStatuses">[],
  meClerkId: string | null | undefined,
): Doc<"tasks">[] {
  const dueCeiling = filter.dueThisWeek ? endOfWeek(new Date()) : 0;
  const completeStatusIds = new Set(
    statuses
      .filter((s) => s.category === "complete" || s.category === "closed")
      .map((s) => s._id as string),
  );
  return tasks.filter((t) => {
    if (filter.hideCompleted && completeStatusIds.has(t.statusId)) return false;
    if (filter.mine) {
      if (!meClerkId || !t.assigneeClerkIds.includes(meClerkId)) return false;
    }
    if (filter.dueThisWeek) {
      if (!t.dueDate || t.dueDate > dueCeiling) return false;
    }
    if (filter.highPriorityPlus) {
      if (t.priority !== "urgent" && t.priority !== "high") return false;
    }
    return true;
  });
}

export function summarizeFilter(filter: TaskFilter): string[] {
  const parts: string[] = [];
  if (filter.mine) parts.push("Mine");
  if (filter.dueThisWeek) parts.push("Due this week");
  if (filter.highPriorityPlus) parts.push("High+");
  if (!filter.hideCompleted) parts.push("Show completed");
  return parts;
}

export const DEFAULT_TASK_FILTER = DEFAULT_FILTER;

export function useFilteredTasks(
  tasks: Doc<"tasks">[],
  filter: TaskFilter,
  statuses: Doc<"listStatuses">[],
  meClerkId: string | null | undefined,
): Doc<"tasks">[] {
  return useMemo(
    () => applyFilter(tasks, filter, statuses, meClerkId),
    [tasks, filter, statuses, meClerkId],
  );
}
