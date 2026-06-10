"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { ArrowLeft, Lock, Sparkles, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { CustomFieldInput } from "@/components/dashboard/custom-field-input";
import { Clips } from "@/components/dashboard/clips";
import { Comments } from "@/components/dashboard/comments";
import { PresenceStack } from "@/components/dashboard/presence-stack";
import { TimeTracker } from "@/components/dashboard/time-tracker";
import { usePresence } from "@/lib/use-presence";

type TaskPriority = NonNullable<Doc<"tasks">["priority"]>;
type TaskRecurrence = NonNullable<Doc<"tasks">["recurrence"]>;

const PRIORITY_OPTIONS: TaskPriority[] = ["urgent", "high", "normal", "low"];
const RECURRENCE_LABEL: Record<TaskRecurrence, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

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
  const taskAutofill = useAction(api.ai.taskAutofill);

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [aiPending, setAiPending] = useState(false);

  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setDescription(task.description ?? ""), [task.description]);

  const viewers = usePresence({
    focusType: "task",
    focusId: task._id,
  });

  const valuesByField = useMemo(() => {
    const map = new Map<string, Doc<"taskFieldValues">>();
    for (const v of values) map.set(v.fieldId, v);
    return map;
  }, [values]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Link
          href={`/dashboard/l/${listId}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> {listName}
        </Link>
        <PresenceStack viewers={viewers} />
      </div>
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

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Recurrence">
          <select
            value={task.recurrence ?? ""}
            onChange={(e) => {
              const v = e.currentTarget.value;
              update({
                taskId: task._id,
                recurrence: (v || null) as TaskRecurrence | null,
              });
            }}
            className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
          >
            <option value="">No recurrence</option>
            {(Object.keys(RECURRENCE_LABEL) as TaskRecurrence[]).map((r) => (
              <option key={r} value={r}>
                {RECURRENCE_LABEL[r]}
              </option>
            ))}
          </select>
          {task.recurrence && (
            <p className="mt-1 text-xs text-muted-foreground">
              When you complete this task, a new {RECURRENCE_LABEL[task.recurrence].toLowerCase()} instance is created automatically.
            </p>
          )}
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
        <div className="mb-1 flex items-center justify-between">
          <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Description
          </label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={aiPending || !task.title.trim()}
            onClick={async () => {
              setAiPending(true);
              try {
                const res = await taskAutofill({ title: task.title });
                if (res.description) {
                  const next = description
                    ? description + "\n\n" + res.description
                    : res.description;
                  setDescription(next);
                  await update({ taskId: task._id, description: next });
                }
              } finally {
                setAiPending(false);
              }
            }}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {aiPending ? "Drafting…" : "Draft with AI"}
          </Button>
        </div>
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

      <BlockerSection taskId={task._id} listId={listId} />

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Time
        </h2>
        <TimeTracker taskId={task._id} />
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Clips
        </h2>
        <Clips taskId={task._id} />
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

function BlockerSection({
  taskId,
  listId,
}: {
  taskId: Id<"tasks">;
  listId: Id<"lists">;
}) {
  const status = useQuery(api.tasks.blockerStatusFor, { taskId });
  const addBlocker = useMutation(api.tasks.addBlocker);
  const removeBlocker = useMutation(api.tasks.removeBlocker);
  const siblings = useQuery(api.tasks.listForList, { listId });
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!status) return null;

  const blockedIds = new Set(status.blockers.map((b) => b._id));
  const candidates = (siblings ?? [])
    .filter(
      (s) =>
        s._id !== taskId &&
        !blockedIds.has(s._id) &&
        s.title.toLowerCase().includes(query.toLowerCase()),
    )
    .slice(0, 8);

  async function add(blockerId: Id<"tasks">) {
    setError(null);
    try {
      await addBlocker({ taskId, blockerTaskId: blockerId });
      setPicking(false);
      setQuery("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add blocker");
    }
  }

  return (
    <section className="rounded-3xl border border-border bg-background p-5">
      <header className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Blocked by</span>
          {status.isBlocked && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
              <Lock className="h-2.5 w-2.5" aria-hidden />
              Blocked
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {picking ? "Cancel" : "+ Add"}
        </button>
      </header>

      {status.blockers.length === 0 && !picking && (
        <p className="text-xs text-muted-foreground">
          Nothing yet. Add a task that must finish first.
        </p>
      )}

      {status.blockers.length > 0 && (
        <ul className="space-y-1.5">
          {status.blockers.map((b) => (
            <li
              key={b._id}
              className="flex items-center justify-between gap-2 rounded-2xl border border-border px-3 py-1.5 text-sm"
            >
              <Link
                href={`/dashboard/l/${listId}/t/${b._id}`}
                className="truncate hover:underline"
              >
                {b.title}
              </Link>
              <button
                type="button"
                aria-label="Remove blocker"
                onClick={() =>
                  removeBlocker({ taskId, blockerTaskId: b._id })
                }
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {picking && (
        <div className="mt-3 space-y-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search tasks in this list…"
            autoFocus
            className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          {error && <p className="text-xs text-red-700">{error}</p>}
          <ul className="max-h-48 overflow-y-auto rounded-2xl border border-border">
            {candidates.length === 0 ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">
                No matches.
              </li>
            ) : (
              candidates.map((c) => (
                <li key={c._id}>
                  <button
                    type="button"
                    onClick={() => add(c._id)}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    {c.title}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}

      {status.blocking.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            This blocks
          </p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {status.blocking.map((b) => (
              <li key={b._id}>
                <Link
                  href={`/dashboard/l/${listId}/t/${b._id}`}
                  className="inline-flex items-center rounded-full border border-border bg-muted/30 px-2 py-0.5 text-xs hover:bg-muted"
                >
                  {b.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
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
