"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { CustomFieldInput } from "@/components/dashboard/custom-field-input";
import { Comments } from "@/components/dashboard/comments";
import { TimeTracker } from "@/components/dashboard/time-tracker";

type TaskPriority = NonNullable<Doc<"tasks">["priority"]>;

const PRIORITY_OPTIONS: TaskPriority[] = ["urgent", "high", "normal", "low"];

export function TaskDetail({
  listId,
  taskId,
}: {
  listId: string;
  taskId: string;
}) {
  const lid = listId as Id<"lists">;
  const tid = taskId as Id<"tasks">;
  const list = useQuery(api.lists.get, { listId: lid });
  const task = useQuery(api.tasks.get, { taskId: tid });
  const statuses = useQuery(api.listStatuses.listForList, { listId: lid });
  const fields = useQuery(api.customFields.listForList, { listId: lid });
  const values = useQuery(api.taskFieldValues.listForTask, { taskId: tid });

  if (
    list === undefined ||
    task === undefined ||
    statuses === undefined ||
    fields === undefined ||
    values === undefined
  ) {
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

  return (
    <TaskEditor
      task={task}
      listName={list.name}
      listId={list._id}
      statuses={statuses}
      fields={fields}
      values={values}
    />
  );
}

function TaskEditor({
  task,
  listName,
  listId,
  statuses,
  fields,
  values,
}: {
  task: Doc<"tasks">;
  listName: string;
  listId: Id<"lists">;
  statuses: Doc<"listStatuses">[];
  fields: Doc<"customFields">[];
  values: Doc<"taskFieldValues">[];
}) {
  const update = useMutation(api.tasks.update);
  const setValue = useMutation(api.taskFieldValues.set);
  const clearValue = useMutation(api.taskFieldValues.clear);

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");

  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setDescription(task.description ?? ""), [task.description]);

  const valuesByField = useMemo(() => {
    const map = new Map<string, Doc<"taskFieldValues">>();
    for (const v of values) map.set(v.fieldId, v);
    return map;
  }, [values]);

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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Status">
          <select
            value={task.statusId}
            onChange={(e) =>
              update({
                taskId: task._id,
                statusId: e.currentTarget.value as Id<"listStatuses">,
              })
            }
            className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
          >
            {statuses.map((s) => (
              <option key={s._id} value={s._id}>
                {s.name}
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

        <Field label="Start date">
          <input
            type="date"
            value={
              task.startDate
                ? new Date(task.startDate).toISOString().slice(0, 10)
                : ""
            }
            onChange={(e) => {
              const v = e.currentTarget.value;
              update({
                taskId: task._id,
                startDate: v ? new Date(v).getTime() : null,
              });
            }}
            className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
          />
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

      {fields.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Custom fields
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((field) => (
              <Field key={field._id} label={field.name}>
                <CustomFieldInput
                  field={field}
                  value={valuesByField.get(field._id)}
                  size="md"
                  onCommit={(value) => {
                    if (value === null) {
                      clearValue({ taskId: task._id, fieldId: field._id });
                    } else {
                      setValue({
                        taskId: task._id,
                        fieldId: field._id,
                        ...value,
                      });
                    }
                  }}
                />
              </Field>
            ))}
          </div>
        </section>
      )}

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

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Time
        </h2>
        <TimeTracker taskId={task._id} />
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Comments
        </h2>
        <Comments parentType="task" parentId={task._id} />
      </section>

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
