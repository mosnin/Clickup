"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { ArrowLeft, Check, Sparkles } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { CustomFieldInput } from "@/components/dashboard/custom-field-input";
import { Clips } from "@/components/dashboard/clips";
import { Comments } from "@/components/dashboard/comments";
import {
  TaskAssignees,
  TaskBanners,
  TaskBlockedBy,
  TaskChecklist,
  TaskSprintPicker,
} from "@/components/dashboard/task-collab";
import { TimeTracker } from "@/components/dashboard/time-tracker";
import { cn } from "@/lib/utils";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";
import { useToast } from "@/components/toast";
import { motion } from "@/components/motion";

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
      <div className="rounded-2xl border border-border bg-muted/30 p-10 text-center">
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

// Two-column layout on lg: the content the task IS (title, description,
// checklist, clips, comments) on the left; the state it's IN (status,
// priority, dates, assignees, sprint, dependencies, recurrence, custom
// fields, time) in the right rail. Stacks in that order on mobile.
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
  const toggleComplete = useMutation(api.tasks.toggleComplete);
  const setValue = useMutation(api.taskFieldValues.set);
  const clearValue = useMutation(api.taskFieldValues.clear);
  const taskAutofill = useAction(api.ai.taskAutofill);
  const { toast } = useToast();

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [aiPending, setAiPending] = useState(false);

  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setDescription(task.description ?? ""), [task.description]);

  const valuesByField = useMemo(() => {
    const map = new Map<string, Doc<"taskFieldValues">>();
    for (const v of values) map.set(v.fieldId, v);
    return map;
  }, [values]);

  const currentStatus = statuses.find((s) => s._id === task.statusId);
  const isDone =
    currentStatus?.category === "complete" ||
    currentStatus?.category === "closed";

  async function onToggleComplete() {
    try {
      await toggleComplete({ taskId: task._id });
    } catch (err) {
      // Blockers / approval gates refuse completion — surface why.
      const raw = err instanceof Error ? err.message : String(err);
      const msg = raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim();
      toast(msg || "Couldn't complete this task", { kind: "error" });
    }
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/dashboard/l/${listId}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> {listName}
      </Link>

      <div className="flex items-start gap-3">
        {/* The completion moment: a springy check that fills in and
            strikes the title through. */}
        <motion.button
          type="button"
          aria-label={isDone ? "Reopen task" : "Complete task"}
          onClick={onToggleComplete}
          whileTap={{ scale: 0.85 }}
          className={cn(
            "tap-target mt-1 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors sm:mt-1.5",
            isDone
              ? "border-emerald-500 bg-emerald-500 text-white"
              : "border-border text-transparent hover:border-emerald-400 hover:text-emerald-400",
          )}
        >
          <motion.span
            initial={false}
            animate={{ scale: isDone ? 1 : 0.6, opacity: isDone ? 1 : undefined }}
            transition={{ type: "spring", stiffness: 500, damping: 22 }}
            className="inline-flex"
          >
            <Check className="h-4 w-4" strokeWidth={3} />
          </motion.span>
        </motion.button>
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
          className={cn(
            "w-full bg-transparent text-2xl font-bold tracking-tight transition-colors focus:outline-none sm:text-3xl",
            isDone && "text-muted-foreground line-through",
          )}
        />
      </div>

      <TaskBanners task={task} listId={listId} />

      <div className="gap-10 lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
        {/* ── Content column ── */}
        <div className="min-w-0 space-y-8">
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
              className="w-full rounded-2xl border border-border bg-background p-4 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <TaskChecklist task={task} />

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
        </div>

        {/* ── State rail ── */}
        <aside className="mt-8 space-y-5 lg:mt-0 lg:rounded-2xl lg:border lg:border-border lg:bg-muted/20 lg:p-5">
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

          <div className="grid grid-cols-2 gap-3">
            <Field label="Start date">
              <input
                type="date"
                value={task.startDate ? toDateInputValue(task.startDate) : ""}
                onChange={(e) =>
                  update({
                    taskId: task._id,
                    startDate: fromDateInputValue(e.currentTarget.value) ?? null,
                  })
                }
                className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
              />
            </Field>
            <Field label="Due date">
              <input
                type="date"
                value={task.dueDate ? toDateInputValue(task.dueDate) : ""}
                onChange={(e) =>
                  update({
                    taskId: task._id,
                    dueDate: fromDateInputValue(e.currentTarget.value) ?? null,
                  })
                }
                className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
              />
            </Field>
          </div>

          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Assignees
            </h2>
            <TaskAssignees task={task} listId={listId} />
          </section>

          <TaskSprintPicker task={task} listId={listId} />

          <TaskBlockedBy task={task} listId={listId} />

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
                Completing this task creates a new{" "}
                {RECURRENCE_LABEL[task.recurrence].toLowerCase()} instance
                automatically.
              </p>
            )}
          </Field>

          {fields.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Custom fields
              </h2>
              <div className="space-y-3">
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

          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Time
            </h2>
            <TimeTracker taskId={task._id} />
          </section>
        </aside>
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

// Shaped like the loaded page: breadcrumb, check + title, then the
// content/rail split — so nothing jumps when data lands.
function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-4 w-32 animate-pulse rounded-full bg-muted" />
      <div className="flex items-center gap-3">
        <div className="h-7 w-7 animate-pulse rounded-full bg-muted" />
        <div className="h-9 w-2/3 animate-pulse rounded-full bg-muted" />
      </div>
      <div className="gap-10 lg:grid lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-4">
          <div className="h-40 animate-pulse rounded-2xl bg-muted/60" />
          <div className="h-24 animate-pulse rounded-2xl bg-muted/40" />
        </div>
        <div className="mt-4 space-y-3 lg:mt-0">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded-full bg-muted/60" />
          ))}
        </div>
      </div>
    </div>
  );
}
