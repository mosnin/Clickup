"use client";

import Link from "next/link";
import { useMutation } from "convex/react";
import { Check, Trash2 } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { notifySuccess, tapMedium } from "@/lib/haptics";
import { useSwipeable } from "@/lib/use-swipeable";
import { useToast } from "@/components/dashboard/toast";
import { cn } from "@/lib/utils";

const PRIORITY_COLOR: Record<string, string> = {
  urgent: "#ef4444",
  high: "#f97316",
  normal: "#3b82f6",
  low: "#a1a1aa",
};

// Mobile-only stack of swipeable task cards. Replaces the table on
// phones because table columns get hidden one by one at narrow widths
// and the user loses context. A card has room for status, title, and
// due date all at once.
//
// Swipe right → complete (haptic success).
// Swipe left → delete with Undo toast (haptic medium tap).
//
// On desktop the parent renders the existing <table>; this list is
// wrapped in `block sm:hidden`.
export function MobileTaskList({
  listId,
  tasks,
  statuses,
  recentIds,
}: {
  listId: Id<"lists">;
  tasks: Doc<"tasks">[];
  statuses: Doc<"listStatuses">[];
  recentIds?: Set<string>;
}) {
  if (tasks.length === 0) {
    return (
      <div className="rounded-3xl border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        No tasks yet — add one below.
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {tasks.map((task) => (
        <li key={task._id}>
          <SwipeableTaskCard
            task={task}
            listId={listId}
            statuses={statuses}
            isRecent={recentIds?.has(task._id) ?? false}
          />
        </li>
      ))}
    </ul>
  );
}

function SwipeableTaskCard({
  task,
  listId,
  statuses,
  isRecent,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
  statuses: Doc<"listStatuses">[];
  isRecent: boolean;
}) {
  const toggleComplete = useMutation(api.tasks.toggleComplete);
  const remove = useMutation(api.tasks.remove);
  const restore = useMutation(api.tasks.restore);
  const toast = useToast();

  const status = statuses.find((s) => s._id === task.statusId);
  const isDone =
    status?.category === "complete" || status?.category === "closed";

  const { bind, dx, swiping } = useSwipeable({
    onSwipeRight: async () => {
      await toggleComplete({ taskId: task._id });
      notifySuccess();
    },
    onSwipeLeft: async () => {
      await remove({ taskId: task._id });
      tapMedium();
      toast.showUndo({
        label: `Deleted "${truncate(task.title, 32)}"`,
        onUndo: () => restore({ taskId: task._id }),
      });
    },
  });

  const showLeftAction = dx > 8;
  const showRightAction = dx < -8;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-3xl border border-border bg-background transition-colors duration-700",
        isRecent && "bg-brand-50",
      )}
    >
      {/* Action backdrops — visible behind the row as it slides. */}
      <div
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 flex w-32 items-center pl-5 text-sm font-medium text-white transition-opacity",
          showLeftAction
            ? "bg-emerald-600 opacity-100"
            : "bg-emerald-600 opacity-0",
        )}
      >
        <Check className="mr-2 h-4 w-4" />
        {isDone ? "Reopen" : "Complete"}
      </div>
      <div
        aria-hidden
        className={cn(
          "absolute inset-y-0 right-0 flex w-32 items-center justify-end pr-5 text-sm font-medium text-white transition-opacity",
          showRightAction ? "bg-red-600 opacity-100" : "bg-red-600 opacity-0",
        )}
      >
        Delete
        <Trash2 className="ml-2 h-4 w-4" />
      </div>

      <div
        {...bind}
        style={{
          transform: `translateX(${dx}px)`,
          transition: swiping ? "none" : "transform 200ms ease-out",
          touchAction: "pan-y",
        }}
        className={cn(
          "relative flex items-center gap-3 bg-background p-3",
          isDone && "opacity-60",
        )}
      >
        <span
          className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2"
          style={{
            borderColor: status?.color ?? "var(--color-border)",
            backgroundColor: isDone ? status?.color : "transparent",
          }}
        >
          {isDone && (
            <svg viewBox="0 0 16 16" className="h-3 w-3 text-white" aria-hidden>
              <path
                d="M3 8.5l3 3 7-7"
                stroke="currentColor"
                strokeWidth="2.5"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
        <Link
          href={`/dashboard/l/${listId}/t/${task._id}`}
          className="min-w-0 flex-1"
        >
          <p
            className={cn(
              "truncate text-sm",
              isDone && "text-muted-foreground line-through",
            )}
          >
            {task.title}
          </p>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            {status && (
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: status.color }}
                />
                {status.name}
              </span>
            )}
            {task.priority && (
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: PRIORITY_COLOR[task.priority] }}
                />
                {task.priority}
              </span>
            )}
            {task.dueDate && (
              <span>
                {new Date(task.dueDate).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            )}
          </div>
        </Link>
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
