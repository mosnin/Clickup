"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { InlineCreate } from "@/components/dashboard/inline-create";
import { EmptyState } from "@/components/dashboard/empty-state";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { AnimatePresence, EASE, motion } from "@/components/motion";

function errorMessage(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  return (
    raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() || fallback
  );
}

// Breaking a task down into smaller steps. Subtasks are ordinary tasks on
// the same list (tasks.parentTaskId), so they get their own task page,
// status, assignees, etc. — this section is just a focused, inline view
// of "children of this task" with quick complete/add/delete.
//
// There's no dedicated children query yet, so this filters the same
// tasks.listForList({listId}) subscription the list page already loads —
// Convex dedupes the subscription, and list sizes are small enough that
// a client-side filter is cheap.
export function Subtasks({
  taskId,
  listId,
}: {
  taskId: Id<"tasks">;
  listId: Id<"lists">;
}) {
  const allTasks = useQuery(api.tasks.listForList, { listId });
  const statuses = useQuery(api.listStatuses.listForList, { listId });
  const create = useMutation(api.tasks.create);
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Set<string>>(new Set());

  const subtasks = useMemo(
    () =>
      (allTasks ?? [])
        .filter((t) => t.parentTaskId === taskId && !pendingDelete.has(t._id))
        .sort((a, b) => a.position - b.position),
    [allTasks, taskId, pendingDelete],
  );

  if (allTasks === undefined || statuses === undefined) {
    return (
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Subtasks
        </h2>
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-9 animate-pulse rounded-xl bg-muted/40"
            />
          ))}
        </div>
      </section>
    );
  }

  const doneCount = subtasks.filter((t) => {
    const s = statuses.find((st) => st._id === t.statusId);
    return s?.category === "complete" || s?.category === "closed";
  }).length;

  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Subtasks
        {subtasks.length > 0 && ` · ${doneCount} of ${subtasks.length} done`}
      </h2>

      {subtasks.length === 0 && !adding ? (
        <EmptyState
          compact
          title="No subtasks yet"
          message="Break this task down into smaller steps."
        />
      ) : (
        <ul className="space-y-1.5">
          <AnimatePresence initial={false}>
            {subtasks.map((t) => (
              <SubtaskRow
                key={t._id}
                task={t}
                listId={listId}
                statuses={statuses}
                onDelete={() =>
                  setPendingDelete((prev) => new Set([...prev, t._id]))
                }
                onUndelete={() =>
                  setPendingDelete((prev) => {
                    const next = new Set(prev);
                    next.delete(t._id);
                    return next;
                  })
                }
              />
            ))}
          </AnimatePresence>
        </ul>
      )}

      {adding ? (
        <div className="mt-2">
          <InlineCreate
            placeholder="Add a subtask…"
            onCancel={() => setAdding(false)}
            onSubmit={async (title) => {
              try {
                await create({ listId, title, parentTaskId: taskId });
                setAdding(false);
              } catch (e) {
                toast(errorMessage(e, "Couldn't add subtask"), {
                  kind: "error",
                });
              }
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          + Add a subtask…
        </button>
      )}
    </section>
  );
}

function SubtaskRow({
  task,
  listId,
  statuses,
  onDelete,
  onUndelete,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
  statuses: Doc<"listStatuses">[];
  onDelete: () => void;
  onUndelete: () => void;
}) {
  // Same optimistic-toggle pattern as the list view's TaskRow: flip the
  // status locally before the round-trip, then let the server reconcile
  // (or revert, if a blocker/approval gate refuses it).
  const toggleComplete = useMutation(
    api.tasks.toggleComplete,
  ).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.tasks.listForList, { listId });
    if (!current) return;
    const sorted = [...statuses].sort((a, b) => a.position - b.position);
    localStore.setQuery(
      api.tasks.listForList,
      { listId },
      current.map((t) => {
        if (t._id !== args.taskId) return t;
        const cur = statuses.find((s) => s._id === t.statusId);
        const done =
          cur?.category === "complete" || cur?.category === "closed";
        const next = done
          ? (sorted.find((s) => s.category === "open") ?? sorted[0])
          : (sorted.find((s) => s.category === "complete") ?? sorted[0]);
        return next ? { ...t, statusId: next._id } : t;
      }),
    );
  });
  const remove = useMutation(api.tasks.remove);
  const { toast } = useToast();

  const status = statuses.find((s) => s._id === task.statusId);
  const isDone =
    status?.category === "complete" || status?.category === "closed";

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.3, ease: EASE }}
      className="flex items-center gap-2 overflow-hidden rounded-xl bento-tile px-3 py-2"
    >
      <motion.button
        type="button"
        aria-label={isDone ? "Mark subtask open" : "Mark subtask complete"}
        onClick={async () => {
          try {
            await toggleComplete({ taskId: task._id });
          } catch (err) {
            const raw = err instanceof Error ? err.message : String(err);
            const msg = raw
              .split("Uncaught Error:")
              .pop()
              ?.split("\n")[0]
              ?.trim();
            toast(msg || "Couldn't complete this subtask", { kind: "error" });
          }
        }}
        whileTap={{ scale: 0.8 }}
        className="tap-target inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors"
        style={{
          borderColor: status?.color ?? "var(--color-border)",
          backgroundColor: isDone ? status?.color : "transparent",
        }}
      >
        <motion.svg
          viewBox="0 0 16 16"
          className="h-3 w-3 text-white"
          aria-hidden
          initial={false}
          animate={{ scale: isDone ? 1 : 0, opacity: isDone ? 1 : 0 }}
          transition={{ type: "spring", stiffness: 500, damping: 22 }}
        >
          <path
            d="M3 8.5l3 3 7-7"
            stroke="currentColor"
            strokeWidth="2.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </motion.svg>
      </motion.button>
      <Link
        href={`/dashboard/l/${listId}/t/${task._id}`}
        className={cn(
          "flex-1 truncate text-sm hover:underline",
          isDone && "text-muted-foreground line-through",
        )}
      >
        {task.title}
      </Link>
      <button
        type="button"
        aria-label="Delete subtask"
        onClick={() => {
          onDelete();
          toast(`"${task.title}" deleted`, {
            action: { label: "Undo", onClick: onUndelete },
            onExpire: () => remove({ taskId: task._id }),
          });
        }}
        className="tap-target inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </motion.li>
  );
}
