"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";

type TaskStatus = Doc<"tasks">["status"];
type TaskPriority = NonNullable<Doc<"tasks">["priority"]>;

const STATUS_OPTIONS: TaskStatus[] = [
  "open",
  "in_progress",
  "complete",
  "closed",
];
const PRIORITY_OPTIONS: TaskPriority[] = ["urgent", "high", "normal", "low"];

export function TaskDetail({
  listId,
  taskId,
}: {
  listId: string;
  taskId: string;
}) {
  const list = useQuery(api.lists.get, { listId: listId as Id<"lists"> });
  const task = useQuery(api.tasks.get, { taskId: taskId as Id<"tasks"> });

  if (list === undefined || task === undefined) {
    return <DetailSkeleton />;
  }
  if (!list || !task) {
    return (
      <div className="rounded-3xl border border-border bg-muted/30 p-10 text-center">
        <p className="text-sm text-muted-foreground">
          This task doesn&apos;t exist or you don&apos;t have access.
        </p>
        <Link
          href="/dashboard"
          className="mt-3 inline-block text-sm font-medium text-brand-600 hover:underline"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  return <TaskEditor task={task} listName={list.name} listId={list._id} />;
}

function TaskEditor({
  task,
  listName,
  listId,
}: {
  task: Doc<"tasks">;
  listName: string;
  listId: Id<"lists">;
}) {
  const update = useMutation(api.tasks.update);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");

  // Keep local edits in sync if the task changes elsewhere.
  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setDescription(task.description ?? ""), [task.description]);

  return (
    <div className="space-y-6">
      <Link
        href={`/dashboard/l/${listId}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> {listName}
      </Link>

      <div>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          onBlur={() => {
            if (title.trim() && title !== task.title) {
              update({ taskId: task._id, title: title.trim() });
            } else if (!title.trim()) {
              setTitle(task.title);
            }
          }}
          className="w-full bg-transparent text-2xl font-semibold tracking-tight focus:outline-none sm:text-3xl"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Status">
          <select
            value={task.status}
            onChange={(e) =>
              update({
                taskId: task._id,
                status: e.currentTarget.value as TaskStatus,
              })
            }
            className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Priority">
          <select
            value={task.priority ?? ""}
            onChange={(e) => {
              const v = e.currentTarget.value;
              update({
                taskId: task._id,
                priority: (v || undefined) as TaskPriority | undefined,
              });
            }}
            className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
          >
            <option value="">No priority</option>
            {PRIORITY_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Due date">
          <input
            type="date"
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
            className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
          />
        </Field>
      </div>

      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Description
        </label>
        <textarea
          rows={8}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          onBlur={() => {
            if (description !== (task.description ?? "")) {
              update({ taskId: task._id, description });
            }
          }}
          placeholder="Add more details…"
          className="w-full rounded-3xl border border-border bg-background p-4 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <div className="flex justify-end">
        <Link href={`/dashboard/l/${listId}`}>
          <Button variant="outline" size="sm">
            Done
          </Button>
        </Link>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-4 w-32 animate-pulse rounded-full bg-muted" />
      <div className="h-9 w-2/3 animate-pulse rounded-full bg-muted" />
      <div className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-9 animate-pulse rounded-full bg-muted" />
        ))}
      </div>
      <div className="h-40 animate-pulse rounded-3xl bg-muted" />
    </div>
  );
}
