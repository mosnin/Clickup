"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { CustomFieldInput } from "@/components/dashboard/custom-field-input";
import { TaskBadges } from "@/components/dashboard/task-badges";
import { cn } from "@/lib/utils";
import { EASE, motion } from "@/components/motion";

type TaskPriority = NonNullable<Doc<"tasks">["priority"]>;

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

export function ListView({
  listId,
  tasks,
  statuses,
  fields,
}: {
  listId: Id<"lists">;
  tasks: Doc<"tasks">[];
  statuses: Doc<"listStatuses">[];
  fields: Doc<"customFields">[];
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-background">
      <table className="w-full text-sm">
        <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <th scope="col" className="w-10 px-3 py-2"></th>
            <th scope="col" className="px-3 py-2">Title</th>
            <th scope="col" className="hidden px-3 py-2 sm:table-cell">Status</th>
            <th scope="col" className="hidden px-3 py-2 sm:table-cell">Priority</th>
            <th scope="col" className="hidden px-3 py-2 md:table-cell">Due</th>
            {fields.map((f) => (
              <th
                key={f._id}
                scope="col"
                className="hidden px-3 py-2 md:table-cell"
              >
                {f.name}
              </th>
            ))}
            <th scope="col" className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {tasks.length === 0 && (
            <tr>
              <td
                colSpan={6 + fields.length}
                className="px-3 py-6 text-center text-sm text-muted-foreground"
              >
                No tasks yet — add one below.
              </td>
            </tr>
          )}
          {tasks.map((task, i) => (
            <TaskRow
              key={task._id}
              task={task}
              listId={listId}
              statuses={statuses}
              fields={fields}
              index={i}
            />
          ))}
        </tbody>
      </table>
      <NewTaskRow listId={listId} />
    </div>
  );
}

function TaskRow({
  task,
  listId,
  statuses,
  fields,
  index,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
  statuses: Doc<"listStatuses">[];
  fields: Doc<"customFields">[];
  index: number;
}) {
  const update = useMutation(api.tasks.update);
  const toggleComplete = useMutation(api.tasks.toggleComplete);
  const remove = useMutation(api.tasks.remove);
  const setValue = useMutation(api.taskFieldValues.set);
  const clearValue = useMutation(api.taskFieldValues.clear);

  const values = useQuery(api.taskFieldValues.listForTask, {
    taskId: task._id,
  });
  const valuesByField = useMemo(() => {
    const map = new Map<string, Doc<"taskFieldValues">>();
    for (const v of values ?? []) map.set(v.fieldId, v);
    return map;
  }, [values]);

  const status = statuses.find((s) => s._id === task.statusId);
  const isDone =
    status?.category === "complete" || status?.category === "closed";

  return (
    <motion.tr
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.4,
        ease: EASE,
        delay: Math.min(index * 0.03, 0.3),
      }}
      className="border-b border-border last:border-0 align-middle"
    >
      <td className="px-3 py-2">
        <button
          type="button"
          aria-label={isDone ? "Mark task open" : "Mark task complete"}
          onClick={() => toggleComplete({ taskId: task._id })}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border-2"
          style={{
            borderColor: status?.color ?? "var(--color-border)",
            backgroundColor: isDone ? status?.color : "transparent",
          }}
        >
          {isDone && (
            <svg
              viewBox="0 0 16 16"
              className="h-3 w-3 text-white"
              aria-hidden
            >
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
      </td>
      <td className="px-3 py-2">
        <span className="flex items-center">
          <Link
            href={`/dashboard/l/${listId}/t/${task._id}`}
            className={cn(
              "truncate hover:underline",
              isDone && "text-muted-foreground line-through",
            )}
          >
            {task.title}
          </Link>
          <TaskBadges task={task} />
        </span>
      </td>
      <td className="hidden px-3 py-2 sm:table-cell">
        <select
          aria-label="Status"
          value={task.statusId}
          onChange={(e) =>
            update({
              taskId: task._id,
              statusId: e.currentTarget.value as Id<"listStatuses">,
            })
          }
          className="rounded-full border border-border bg-background px-2 py-1 text-xs"
          style={{ borderColor: status?.color }}
        >
          {statuses.map((s) => (
            <option key={s._id} value={s._id}>
              {s.name}
            </option>
          ))}
        </select>
      </td>
      <td className="hidden px-3 py-2 sm:table-cell">
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
      <td className="hidden px-3 py-2 md:table-cell">
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
      {fields.map((f) => (
        <td key={f._id} className="hidden px-3 py-2 md:table-cell">
          <CustomFieldInput
            field={f}
            value={valuesByField.get(f._id)}
            onCommit={(value) => {
              if (value === null) {
                clearValue({ taskId: task._id, fieldId: f._id });
              } else {
                setValue({ taskId: task._id, fieldId: f._id, ...value });
              }
            }}
          />
        </td>
      ))}
      <td className="px-3 py-2 text-right">
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
    </motion.tr>
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
