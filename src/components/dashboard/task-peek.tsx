"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowUpRight, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";
import { useToast } from "@/components/toast";
import { AnimatePresence, EASE, motion } from "@/components/motion";
import {
  PRIORITY_ORDER,
  PriorityChip,
  type TaskPriority,
} from "@/components/dashboard/priority";
import { Monogram } from "@/components/dashboard/monogram";
import { TaskBadges } from "@/components/dashboard/task-badges";

// The task side-peek: a right slide-over for glancing at and quick-editing a
// task without leaving the current view. Driven by the `?task=` search param
// so it works identically from List, Board, Calendar, and Gantt, survives
// reload, and is shareable. The full task page remains one click away.

/** Build an href that opens this task as a peek over the current view. */
export function taskPeekHref(
  searchParams: URLSearchParams,
  taskId: string,
): string {
  const params = new URLSearchParams(searchParams.toString());
  params.set("task", taskId);
  return `?${params.toString()}`;
}

export function TaskPeekPortal({ listId }: { listId: Id<"lists"> }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const taskParam = searchParams.get("task");

  function close() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("task");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  // Escape closes, matching every other overlay.
  useEffect(() => {
    if (!taskParam) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskParam]);

  return (
    <AnimatePresence>
      {taskParam && (
        <>
          <motion.div
            key="peek-scrim"
            aria-hidden
            onClick={close}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[2px]"
          />
          <motion.aside
            key="peek-panel"
            role="dialog"
            aria-label="Task"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.35, ease: EASE }}
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col overflow-y-auto border-l border-border bg-card shadow-lg"
          >
            <TaskPeekBody
              taskId={taskParam as Id<"tasks">}
              listId={listId}
              onClose={close}
            />
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function TaskPeekBody({
  taskId,
  listId,
  onClose,
}: {
  taskId: Id<"tasks">;
  listId: Id<"lists">;
  onClose: () => void;
}) {
  const task = useQuery(api.tasks.get, { taskId });
  const statuses = useQuery(api.listStatuses.listForList, { listId });
  const assignable = useQuery(api.agents.listAssignableForList, { listId });
  const update = useMutation(api.tasks.update);
  const toggleComplete = useMutation(api.tasks.toggleComplete);
  const { toast } = useToast();

  const [title, setTitle] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);

  const assigneeById = useMemo(
    () => new Map((assignable ?? []).map((a) => [a.id, a])),
    [assignable],
  );

  if (task === undefined || statuses === undefined) {
    return (
      <div className="space-y-4 p-6">
        <div className="h-6 w-2/3 animate-pulse rounded-full bg-muted" />
        <div className="h-4 w-1/3 animate-pulse rounded-full bg-muted/70" />
        <div className="h-24 animate-pulse rounded-xl bg-muted/50" />
      </div>
    );
  }
  if (task === null) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        This task is gone or you don&apos;t have access to it.
      </div>
    );
  }

  const status = statuses.find((s) => s._id === task.statusId);
  const isDone =
    status?.category === "complete" || status?.category === "closed";

  async function onStatusChange(statusId: Id<"listStatuses">) {
    try {
      await update({ taskId, statusId });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      toast(
        raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() ||
          "Couldn't update status",
        { kind: "error" },
      );
    }
  }

  async function onToggle() {
    try {
      await toggleComplete({ taskId });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      toast(
        raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() ||
          "Couldn't complete this task",
        { kind: "error" },
      );
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center gap-2 px-5 pt-4">
        <button
          type="button"
          onClick={onToggle}
          aria-label={isDone ? "Mark task open" : "Mark task complete"}
          className="tap-target inline-flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors"
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
        </button>
        <div className="ml-auto flex items-center gap-1">
          <Link
            href={`/dashboard/l/${listId}/t/${taskId}`}
            className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Open full task page"
            title="Open full task page"
          >
            <ArrowUpRight className="h-4 w-4" />
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-6 px-5 pb-6 pt-3">
        <div className="flex items-center gap-1">
          <input
            value={title ?? task.title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            onBlur={() => {
              const next = (title ?? task.title).trim();
              if (next && next !== task.title) {
                void update({ taskId, title: next });
              }
              setTitle(null);
            }}
            aria-label="Task title"
            className={cn(
              "w-full bg-transparent text-lg font-semibold tracking-tight focus:outline-none",
              isDone && "text-muted-foreground line-through",
            )}
          />
          <TaskBadges task={task} />
        </div>

        <div className="space-y-4">
          <PeekField label="Assignees">
            {task.assigneeClerkIds.length === 0 ? (
              <p className="text-sm text-muted-foreground">Unassigned</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {task.assigneeClerkIds.map((id) => {
                  const person = assigneeById.get(id);
                  return (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-1 text-xs"
                    >
                      <Monogram name={person?.name ?? "?"} size="sm" />
                      {person?.name ?? "Someone"}
                    </span>
                  );
                })}
              </div>
            )}
          </PeekField>

          <PeekField label="Status">
            <div className="flex flex-wrap gap-1.5">
              {statuses
                .slice()
                .sort((a, b) => a.position - b.position)
                .map((s) => (
                  <button
                    key={s._id}
                    type="button"
                    onClick={() => void onStatusChange(s._id)}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                      s._id === task.statusId
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    style={{
                      backgroundColor:
                        s._id === task.statusId
                          ? `${s.color}55`
                          : "var(--color-muted)",
                    }}
                  >
                    {s.name}
                  </button>
                ))}
            </div>
          </PeekField>

          <PeekField label="Priority">
            <div className="flex flex-wrap items-center gap-1.5">
              {PRIORITY_ORDER.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={task.priority === p}
                  onClick={() =>
                    // Clicking the active pill clears the priority; null (not
                    // undefined) survives the wire so the clear actually lands.
                    void update({
                      taskId,
                      priority: task.priority === p ? null : p,
                    })
                  }
                  className={cn(
                    "transition-opacity",
                    task.priority && task.priority !== p
                      ? "opacity-40 hover:opacity-100"
                      : "opacity-100",
                  )}
                >
                  <PriorityChip priority={p as TaskPriority} />
                </button>
              ))}
            </div>
          </PeekField>

          <PeekField label="Due">
            <input
              type="date"
              value={task.dueDate ? toDateInputValue(task.dueDate) : ""}
              onChange={(e) =>
                void update({
                  taskId,
                  dueDate: fromDateInputValue(e.currentTarget.value) ?? null,
                })
              }
              className="soft-field px-3 py-1.5 text-sm"
              aria-label="Due date"
            />
          </PeekField>
        </div>

        <PeekField label="Description">
          <textarea
            value={description ?? task.description ?? ""}
            onChange={(e) => setDescription(e.currentTarget.value)}
            onBlur={() => {
              const next = description ?? "";
              if (description !== null && next !== (task.description ?? "")) {
                void update({ taskId, description: next });
              }
              setDescription(null);
            }}
            placeholder="Add details…"
            rows={5}
            className="soft-field w-full resize-none px-3 py-2.5 text-sm leading-relaxed"
          />
        </PeekField>

        <p className="text-xs text-muted-foreground">
          Comments, checklist, attachments, clips, sprint, and blocked-by
          details live on the{" "}
          <Link
            href={`/dashboard/l/${listId}/t/${taskId}`}
            className="font-medium text-foreground hover:underline"
          >
            full task page
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

function PeekField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}
