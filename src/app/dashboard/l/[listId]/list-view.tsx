"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type TaskStatus = Doc<"tasks">["status"];
type TaskPriority = NonNullable<Doc<"tasks">["priority"]>;

const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  complete: "Complete",
  closed: "Closed",
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

export function ListView({ listId }: { listId: string }) {
  const list = useQuery(api.lists.get, {
    listId: listId as Id<"lists">,
  });
  const tasks = useQuery(api.tasks.listForList, {
    listId: listId as Id<"lists">,
  });

  if (list === undefined || tasks === undefined) {
    return <ListSkeleton />;
  }

  if (list === null) {
    return (
      <div className="rounded-3xl border border-border bg-muted/30 p-10 text-center">
        <p className="text-sm text-muted-foreground">
          This list doesn&apos;t exist or you don&apos;t have access to it.
        </p>
        <Link href="/dashboard" className="mt-3 inline-block text-sm font-medium text-brand-600 hover:underline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  const topLevelTasks = tasks
    .filter((t) => !t.parentTaskId)
    .sort((a, b) => a.position - b.position);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {list.name}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {topLevelTasks.length} task{topLevelTasks.length === 1 ? "" : "s"}
        </p>
      </header>

      <div className="overflow-hidden rounded-3xl border border-border bg-background">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th scope="col" className="w-10 px-3 py-2"></th>
              <th scope="col" className="px-3 py-2">Title</th>
              <th scope="col" className="hidden px-3 py-2 sm:table-cell">Status</th>
              <th scope="col" className="hidden px-3 py-2 sm:table-cell">Priority</th>
              <th scope="col" className="hidden px-3 py-2 md:table-cell">Due</th>
              <th scope="col" className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {topLevelTasks.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-6 text-center text-sm text-muted-foreground"
                >
                  No tasks yet — add one below.
                </td>
              </tr>
            )}
            {topLevelTasks.map((task) => (
              <TaskRow key={task._id} task={task} listId={list._id} />
            ))}
          </tbody>
        </table>
        <NewTaskRow listId={list._id} />
      </div>
    </div>
  );
}

function TaskRow({
  task,
  listId,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
}) {
  const update = useMutation(api.tasks.update);
  const remove = useMutation(api.tasks.remove);
  const isDone = task.status === "complete" || task.status === "closed";

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-3 py-2 align-middle">
        <input
          type="checkbox"
          aria-label={isDone ? "Mark task open" : "Mark task complete"}
          checked={isDone}
          onChange={(e) =>
            update({
              taskId: task._id,
              status: e.currentTarget.checked ? "complete" : "open",
            })
          }
          className="h-4 w-4 rounded-full border-border"
        />
      </td>
      <td className="px-3 py-2 align-middle">
        <Link
          href={`/dashboard/l/${listId}/t/${task._id}`}
          className={cn(
            "block truncate hover:underline",
            isDone && "text-muted-foreground line-through",
          )}
        >
          {task.title}
        </Link>
      </td>
      <td className="hidden px-3 py-2 align-middle sm:table-cell">
        <select
          aria-label="Status"
          value={task.status}
          onChange={(e) =>
            update({ taskId: task._id, status: e.currentTarget.value as TaskStatus })
          }
          className="rounded-full border border-border bg-background px-2 py-1 text-xs"
        >
          {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </td>
      <td className="hidden px-3 py-2 align-middle sm:table-cell">
        <select
          aria-label="Priority"
          value={task.priority ?? ""}
          onChange={(e) => {
            const value = e.currentTarget.value;
            update({
              taskId: task._id,
              priority: (value || undefined) as TaskPriority | undefined,
            });
          }}
          className="rounded-full border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="">—</option>
          {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
      </td>
      <td className="hidden px-3 py-2 align-middle md:table-cell">
        <input
          type="date"
          aria-label="Due date"
          value={
            task.dueDate
              ? new Date(task.dueDate).toISOString().slice(0, 10)
              : ""
          }
          onChange={(e) => {
            const v = e.currentTarget.value;
            update({
              taskId: task._id,
              dueDate: v ? new Date(v).getTime() : null,
            });
          }}
          className="rounded-full border border-border bg-background px-2 py-1 text-xs"
        />
      </td>
      <td className="px-3 py-2 text-right align-middle">
        <button
          type="button"
          aria-label="Delete task"
          onClick={() => {
            if (window.confirm("Delete this task?")) {
              remove({ taskId: task._id });
            }
          }}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      </td>
    </tr>
  );
}

function NewTaskRow({ listId }: { listId: Id<"lists"> }) {
  const [title, setTitle] = useState("");
  const create = useMutation(api.tasks.create);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!title.trim()) return;
    setPending(true);
    try {
      await create({ listId, title: title.trim() });
      setTitle("");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex items-center gap-2 border-t border-border p-3"
    >
      <Plus className="h-4 w-4 text-muted-foreground" aria-hidden />
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Add a task and press Enter"
        disabled={pending}
        className="flex-1 bg-transparent text-sm focus:outline-none disabled:opacity-50"
      />
      <Button
        type="submit"
        size="sm"
        variant="ghost"
        disabled={!title.trim() || pending}
      >
        Add
      </Button>
    </form>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-1/3 animate-pulse rounded-full bg-muted" />
      <div className="overflow-hidden rounded-3xl border border-border bg-background">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-12 animate-pulse border-b border-border last:border-0"
          />
        ))}
      </div>
    </div>
  );
}
