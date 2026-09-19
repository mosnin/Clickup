"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Check, Sparkles } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Picker } from "@/components/ui/picker";
import {
  BackLink,
  KvCard,
  KvRow,
  StatusDot,
} from "@/components/dashboard/deel-ui";
import {
  AgentEdge,
  PresenceNote,
  PresenceRail,
  usePresence,
} from "@/components/dashboard/presence-rail";
import { RunTheater } from "@/components/dashboard/run-theater";
import { CustomFieldInput } from "@/components/dashboard/custom-field-input";
import { Clips } from "@/components/dashboard/clips";
import { Attachments } from "@/components/dashboard/attachments";
import { Comments } from "@/components/dashboard/comments";
import { Subtasks } from "@/components/dashboard/subtasks";
import {
  TaskAssignees,
  TaskBanners,
  TaskBlockedBy,
  TaskChecklist,
  TaskSprintPicker,
} from "@/components/dashboard/task-collab";
import { TimeTracker } from "@/components/dashboard/time-tracker";
import { InlineCreate } from "@/components/dashboard/inline-create";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/errors";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";
import { useToast } from "@/components/toast";
import { motion } from "@/components/motion";
import { TaskContext } from "@/components/dashboard/task-context";
import { TaskDecisions } from "@/components/dashboard/task-decisions";
import { TaskContextPanel } from "@/components/dashboard/task-context-panel";
import { RevisionsPanel } from "@/components/dashboard/revisions-panel";
import { AttachedPages } from "@/components/dashboard/attached-pages";

type TaskPriority = NonNullable<Doc<"tasks">["priority"]>;
type TaskRecurrence = NonNullable<Doc<"tasks">["recurrence"]>;

const PRIORITY_OPTIONS: TaskPriority[] = ["urgent", "high", "normal", "low"];
const RECURRENCE_LABEL: Record<TaskRecurrence, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};
const ESTIMATE_CHIPS = [1, 2, 3, 5, 8, 13];

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
  // Being on a task is worth announcing even while only reading it: two people
  // about to edit the same task is the collision this prevents.
  usePresence("task", taskId);
  const statuses = useQuery(api.listStatuses.listForList, { listId: lid });
  const fields = useQuery(api.customFields.listForList, { listId: lid });
  const values = useQuery(api.taskFieldValues.listForTask, { taskId: tid });
  // Rollups, formulas, and vote counts have no stored row — they're derived
  // per read and merged into the editors by fieldId.
  const computed = useQuery(api.taskFieldValues.computedForTask, {
    taskId: tid,
  });

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
      <div className="rounded-2xl bg-muted/30 p-10 text-center">
        <p className="text-sm text-muted-foreground">
          This task doesn&apos;t exist or you don&apos;t have access.
        </p>
        <Link
          href="/dashboard"
          className="mt-3 inline-block text-sm font-medium text-[var(--color-link)] hover:underline"
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
      computed={computed ?? []}
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
  computed,
}: {
  task: Doc<"tasks">;
  listName: string;
  listId: Id<"lists">;
  statuses: Doc<"listStatuses">[];
  fields: Doc<"customFields">[];
  values: Doc<"taskFieldValues">[];
  computed: { fieldId: Id<"customFields">; value: number | null }[];
}) {
  const update = useMutation(api.tasks.update);
  const toggleComplete = useMutation(api.tasks.toggleComplete);
  // Voting fields need to know whether *you* have voted.
  const currentUser = useQuery(api.users.current, {});
  const setValue = useMutation(api.taskFieldValues.set);
  const clearValue = useMutation(api.taskFieldValues.clear);
  const taskAutofill = useAction(api.ai.taskAutofill);
  const { toast } = useToast();

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [aiPending, setAiPending] = useState(false);
  const [estimateDraft, setEstimateDraft] = useState(
    task.estimatePoints !== undefined ? String(task.estimatePoints) : "",
  );
  const [capabilitiesDraft, setCapabilitiesDraft] = useState(
    (task.requiredCapabilities ?? []).join(", "),
  );

  const parentTask = useQuery(
    api.tasks.get,
    task.parentTaskId ? { taskId: task.parentTaskId } : "skip",
  );

  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setDescription(task.description ?? ""), [task.description]);
  useEffect(
    () =>
      setEstimateDraft(
        task.estimatePoints !== undefined ? String(task.estimatePoints) : "",
      ),
    [task.estimatePoints],
  );
  useEffect(
    () =>
      setCapabilitiesDraft((task.requiredCapabilities ?? []).join(", ")),
    [task.requiredCapabilities],
  );

  async function saveEstimate(value: number | null) {
    const current = task.estimatePoints ?? null;
    if (value === current) return;
    try {
      await update({ taskId: task._id, estimatePoints: value });
      toast(value === null ? "Estimate cleared" : "Saved");
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const msg = raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim();
      toast(msg || "Couldn't update estimate", { kind: "error" });
    }
  }

  async function saveMilestone(value: boolean) {
    try {
      await update({ taskId: task._id, milestone: value });
      toast("Saved");
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const msg = raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim();
      toast(msg || "Couldn't update milestone", { kind: "error" });
    }
  }

  const valuesByField = useMemo(() => {
    const map = new Map<string, Doc<"taskFieldValues">>();
    for (const v of values) map.set(v.fieldId, v);
    return map;
  }, [values]);
  const computedByField = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const c of computed) map.set(c.fieldId, c.value);
    return map;
  }, [computed]);

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
      <div>
        <BackLink href={`/dashboard/l/${listId}`}>Back to {listName}</BackLink>
        <div className="mt-3 flex items-start gap-3">
          <motion.button
            type="button"
            aria-label={isDone ? "Reopen task" : "Complete task"}
            onClick={onToggleComplete}
            whileTap={{ scale: 0.85 }}
            className={cn(
              "tap-target mt-1 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors",
              isDone ? "text-white" : "text-transparent",
            )}
            style={{
              borderColor: currentStatus?.color ?? "var(--color-border)",
              backgroundColor: isDone ? currentStatus?.color : "transparent",
            }}
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
          <div className="min-w-0 flex-1">
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
                "w-full bg-transparent text-[1.75rem] font-semibold leading-tight tracking-tight transition-colors focus:outline-none",
                isDone && "text-muted-foreground line-through",
              )}
            />
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              {currentStatus ? (
                <StatusDot color={currentStatus.color} label={currentStatus.name} />
              ) : null}
              <PresenceRail surfaceType="task" surfaceId={task._id} />
            </div>
          </div>
        </div>
      </div>

      <PresenceNote surfaceType="task" surfaceId={task._id} />

      {/* The run unfolding, when one is: chapters, the agent's current
          sentence, and live numbers — instead of a pulsing dot and silence. */}
      <RunTheater taskId={task._id} />

      {parentTask && (
        <Link
          href={`/dashboard/l/${listId}/t/${parentTask._id}`}
          className="inline-block text-sm text-muted-foreground hover:text-foreground hover:underline"
        >
          Subtask of {parentTask.title}
        </Link>
      )}

      <TaskBanners task={task} listId={listId} />

      <div className="relative gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        {/* The machine's edge: a stroke travels this container's perimeter
            while an agent is writing to the task, so "something is changing
            this" is visible from across the room. */}
        <AgentEdge surfaceType="task" surfaceId={task._id} />
        {/* ── Content column ── */}
        <div className="min-w-0 space-y-6">
          <KvCard
            title="Description"
            action={
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
                    } else {
                      toast(
                        "AI didn't return a draft — is OPENAI_API_KEY configured?",
                        { kind: "error" },
                      );
                    }
                  } catch (err) {
                    const raw = err instanceof Error ? err.message : String(err);
                    const msg = raw
                      .split("Uncaught Error:")
                      .pop()
                      ?.split("\n")[0]
                      ?.trim();
                    toast(msg || "Couldn't draft a description", {
                      kind: "error",
                    });
                  } finally {
                    setAiPending(false);
                  }
                }}
              >
                <Sparkles className="h-3.5 w-3.5" />
                {aiPending ? "Drafting…" : "Draft with AI"}
              </Button>
            }
          >
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
              className="w-full resize-y border-0 bg-transparent px-5 py-4 text-sm focus:outline-none"
            />
          </KvCard>

          <TaskChecklist task={task} />

          {/* Two kinds of context sit next to each other on purpose. Packets
              are per-task and versioned; the panel below is the project's
              standing brief, the same pinned docs get_task hands an agent. */}
          <TaskContext taskId={task._id} listId={listId} />
          <TaskContextPanel listId={listId} />
          <TaskDecisions taskId={task._id} listId={listId} />
          <AttachedPages targetType="task" targetId={task._id} />
          <RevisionsPanel parentType="task" parentId={task._id} />

          <Subtasks taskId={task._id} listId={listId} />

          <KvCard title="Attachments">
            <div className="px-5 py-4">
              <Attachments taskId={task._id} />
            </div>
          </KvCard>

          <KvCard title="Clips">
            <div className="px-5 py-4">
              <Clips taskId={task._id} />
            </div>
          </KvCard>

          <KvCard title="Comments">
            <div className="px-5 py-4">
              <Comments parentType="task" parentId={task._id} />
            </div>
          </KvCard>
        </div>

        {/* ── State rail — Deel worker/contract KV card ── */}
        <aside className="mt-8 space-y-4 lg:mt-0">
          <KvCard title="Details">
          <Field label="Status">
            <select
              value={task.statusId}
              onChange={async (e) => {
                const nextStatusId = e.currentTarget
                  .value as Id<"listStatuses">;
                try {
                  await update({ taskId: task._id, statusId: nextStatusId });
                } catch (err) {
                  // Blockers / approval gates refuse complete-category
                  // statuses — surface why, same as onToggleComplete.
                  const raw = err instanceof Error ? err.message : String(err);
                  const msg = raw
                    .split("Uncaught Error:")
                    .pop()
                    ?.split("\n")[0]
                    ?.trim();
                  toast(msg || "Couldn't update status", { kind: "error" });
                }
              }}
              className="w-full rounded-full bg-background px-3 py-1.5 text-sm"
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
                // Explicit null clears the priority — undefined would be
                // dropped from the wire and the clear silently ignored.
                update({
                  taskId: task._id,
                  priority: (v || null) as TaskPriority | null,
                });
              }}
              className="w-full rounded-full bg-background px-3 py-1.5 text-sm"
            >
              <option value="">No priority</option>
              {PRIORITY_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Estimate">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap items-center gap-1">
                {ESTIMATE_CHIPS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={task.estimatePoints === p}
                    onClick={() => saveEstimate(p)}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                      task.estimatePoints === p
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                aria-label="Custom estimate"
                placeholder="Custom"
                value={estimateDraft}
                onChange={(e) => setEstimateDraft(e.currentTarget.value)}
                onBlur={() => {
                  const trimmed = estimateDraft.trim();
                  if (trimmed === "") {
                    if (task.estimatePoints !== undefined) saveEstimate(null);
                    return;
                  }
                  const n = Number(trimmed);
                  if (!Number.isFinite(n) || n < 0) {
                    setEstimateDraft(
                      task.estimatePoints !== undefined
                        ? String(task.estimatePoints)
                        : "",
                    );
                    return;
                  }
                  saveEstimate(n);
                }}
                className="soft-field w-16 px-2 py-1 text-xs focus:outline-none"
              />
              {task.estimatePoints !== undefined && (
                <button
                  type="button"
                  onClick={() => saveEstimate(null)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Clear
                </button>
              )}
            </div>
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
                className="w-full rounded-full bg-background px-3 py-1.5 text-sm"
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
                className="w-full rounded-full bg-background px-3 py-1.5 text-sm"
              />
            </Field>
          </div>

          <Field label="Milestone">
            <button
              type="button"
              role="switch"
              aria-checked={!!task.milestone}
              onClick={() => saveMilestone(!task.milestone)}
              className={cn(
                "relative h-6 w-11 flex-shrink-0 rounded-full transition-colors",
                task.milestone ? "bg-foreground" : "bg-border",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-5 w-5 rounded-full bg-background shadow-sm transition-transform",
                  task.milestone ? "translate-x-[1.375rem]" : "translate-x-0.5",
                )}
              />
            </button>
          </Field>

          <TaskMilestonePicker task={task} listId={listId} />

          <Field label="Required capabilities">
            <input
              value={capabilitiesDraft}
              onChange={(e) =>
                setCapabilitiesDraft(e.currentTarget.value)
              }
              onBlur={() => {
                const next = capabilitiesDraft
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean);
                if (
                  next.join(",") !==
                  (task.requiredCapabilities ?? []).join(",")
                ) {
                  update({
                    taskId: task._id,
                    requiredCapabilities: next,
                  }).catch((e) =>
                    toast(
                      errorMessage(
                        e,
                        "Couldn't save required capabilities",
                      ),
                      { kind: "error" },
                    ),
                  );
                }
              }}
              placeholder="typescript, backend"
              className="w-full rounded-full bg-background px-3 py-1.5 text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Agents missing any capability cannot be assigned or claim this
              task.
            </p>
          </Field>

          <section>
            <h2 className="mb-2 px-5 pt-4 text-sm font-semibold text-foreground">
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
              className="w-full rounded-full bg-background px-3 py-1.5 text-sm"
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

          <section>
            <h2 className="mb-2 px-5 pt-4 text-sm font-semibold text-foreground">
              Custom fields
            </h2>
            {fields.length === 0 ? (
              <Link
                href={`/dashboard/l/${listId}/settings`}
                className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Add a custom field
              </Link>
            ) : (
              <div className="space-y-3">
                {fields.map((field) => (
                  <Field key={field._id} label={field.name}>
                    <CustomFieldInput
                      field={field}
                      value={valuesByField.get(field._id)}
                      size="md"
                      taskId={task._id}
                      computed={computedByField.get(field._id)}
                      currentActorId={currentUser?.clerkId}
                      onCommit={(value) => {
                        const op =
                          value === null
                            ? clearValue({
                                taskId: task._id,
                                fieldId: field._id,
                              })
                            : setValue({
                                taskId: task._id,
                                fieldId: field._id,
                                ...value,
                              });
                        op.catch((err) => {
                          const raw =
                            err instanceof Error ? err.message : String(err);
                          const msg = raw
                            .split("Uncaught Error:")
                            .pop()
                            ?.split("\n")[0]
                            ?.trim();
                          toast(msg || "Couldn't update field", {
                            kind: "error",
                          });
                        });
                      }}
                    />
                  </Field>
                ))}
              </div>
            )}
          </section>

          <div className="px-5 py-4">
            <p className="mb-2 text-sm text-muted-foreground">Time</p>
            <TimeTracker taskId={task._id} />
          </div>

          <div className="border-t border-border px-5 py-4">
            <SaveAsBlueprint taskId={task._id} />
          </div>
          </KvCard>
        </aside>
      </div>
    </div>
  );
}

// Which of the project's dated checkpoints this task belongs to. Attaching
// it moves that milestone's derived progress bar on the project Overview;
// "No milestone" detaches. Hidden entirely until the project has one, so
// the rail doesn't grow a dead control.
function TaskMilestonePicker({
  task,
  listId,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
}) {
  const milestones = useQuery(api.milestones.listForList, { listId }) as
    | { _id: Id<"milestones">; name: string; status: "open" | "complete" }[]
    | undefined;
  const update = useMutation(api.tasks.update);
  const { toast } = useToast();

  if (milestones === undefined || milestones.length === 0) return null;

  const current = milestones.find((m) => m._id === task.milestoneId);

  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Milestone
      </h2>
      <Picker
        label={current ? current.name : "No milestone"}
        selectedId={task.milestoneId ?? "none"}
        options={[
          { id: "none", label: "No milestone" },
          ...milestones.map((m) => ({
            id: m._id as string,
            label: m.name,
            hint: m.status === "complete" ? "complete" : undefined,
          })),
        ]}
        onSelect={(id) => {
          update({
            taskId: task._id,
            milestoneId: id === "none" ? null : (id as Id<"milestones">),
          }).catch((err) =>
            toast(errorMessage(err, "Couldn't update the milestone"), {
              kind: "error",
            }),
          );
        }}
      />
      <Link
        href={`/dashboard/l/${listId}?view=overview`}
        className="mt-1.5 inline-block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Manage milestones
      </Link>
    </section>
  );
}

// Capture this task as a reusable blueprint (title, description, checklist,
// priority, estimate, approval gate) in the list's scope — instantiable
// later from any project header via "New from blueprint".
function SaveAsBlueprint({ taskId }: { taskId: Id<"tasks"> }) {
  const saveFromTask = useMutation(api.taskBlueprints.saveFromTask);
  const { toast } = useToast();
  const [naming, setNaming] = useState(false);

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-foreground">
        Blueprint
      </h2>
      {naming ? (
        <InlineCreate
          placeholder="Blueprint name…"
          onCancel={() => setNaming(false)}
          onSubmit={async (name) => {
            try {
              await saveFromTask({ taskId, name });
              toast("Blueprint saved");
            } catch (err) {
              const raw = err instanceof Error ? err.message : String(err);
              const msg = raw
                .split("Uncaught Error:")
                .pop()
                ?.split("\n")[0]
                ?.trim();
              toast(msg || "Couldn't save the blueprint", { kind: "error" });
            }
            setNaming(false);
          }}
        />
      ) : (
        <>
          <button
            type="button"
            onClick={() => setNaming(true)}
            className="tap-target rounded-full border border-dashed border-border px-3 py-1 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            Save as blueprint…
          </button>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Reuse this task&apos;s setup for future work.
          </p>
        </>
      )}
    </section>
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
    <KvRow label={label}>
      <div className="text-left sm:text-right">{children}</div>
    </KvRow>
  );
}

// Shaped like the loaded page: sticky header bar, check + title, then the
// content/rail split — so nothing jumps when data lands.
function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-4 w-28 animate-pulse rounded-full bg-muted" />
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 animate-pulse rounded-full bg-muted" />
        <div className="h-9 w-2/3 animate-pulse rounded-full bg-muted" />
      </div>
      <div className="gap-10 lg:grid lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-4">
          <div className="h-40 animate-pulse rounded-xl bg-muted/60" />
          <div className="h-24 animate-pulse rounded-xl bg-muted/40" />
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
