"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Sprints tab on the workspace page: create timeboxes, watch progress,
// and drill into the per-task rollup. Tasks join a sprint from the task
// detail page (Sprint select) or when an agent sets sprintId over MCP.

const STATUS_STYLE: Record<string, string> = {
  planned: "bg-muted text-muted-foreground",
  active: "bg-emerald-100 text-emerald-700",
  complete: "bg-brand-50 text-brand-700",
};

export function SprintsPanel({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const sprints = useQuery(api.sprints.listForWorkspace, { workspaceId });
  const [creating, setCreating] = useState(false);

  if (sprints === undefined) {
    return <div className="h-40 animate-pulse rounded-3xl bg-muted/40" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Timebox work across every list in this workspace. Agents can plan
          and run sprints too (see the &quot;Sprint planner&quot; skill).
        </p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New sprint
        </Button>
      </div>

      {creating && (
        <CreateSprintForm
          workspaceId={workspaceId}
          onDone={() => setCreating(false)}
        />
      )}

      {sprints.length === 0 && !creating && (
        <div className="rounded-3xl border border-dashed border-border bg-muted/30 p-10 text-center text-sm text-muted-foreground">
          No sprints yet.
        </div>
      )}

      <ul className="space-y-3">
        {sprints.map((s) => (
          <li key={s._id}>
            <SprintCard sprint={s} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CreateSprintForm({
  workspaceId,
  onDone,
}: {
  workspaceId: Id<"workspaces">;
  onDone: () => void;
}) {
  const create = useMutation(api.sprints.create);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [start, setStart] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [end, setEnd] = useState(() =>
    new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
  );

  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-3xl border border-border bg-background p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        await create({
          workspaceId,
          name: name.trim(),
          goal: goal.trim() || undefined,
          startDate: new Date(start).getTime(),
          endDate: new Date(end).getTime(),
        });
        onDone();
      }}
    >
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Name
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Sprint 12"
          autoFocus
          className="rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
      </label>
      <label className="block min-w-40 flex-1">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Goal (optional)
        </span>
        <input
          value={goal}
          onChange={(e) => setGoal(e.currentTarget.value)}
          placeholder="Ship the onboarding revamp"
          className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Start
        </span>
        <input
          type="date"
          value={start}
          onChange={(e) => setStart(e.currentTarget.value)}
          className="rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          End
        </span>
        <input
          type="date"
          value={end}
          onChange={(e) => setEnd(e.currentTarget.value)}
          className="rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
      </label>
      <div className="flex gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!name.trim()}>
          Create
        </Button>
      </div>
    </form>
  );
}

function SprintCard({
  sprint,
}: {
  sprint: {
    _id: Id<"sprints">;
    name: string;
    goal?: string;
    startDate: number;
    endDate: number;
    status: "planned" | "active" | "complete";
    taskCount: number;
    doneCount: number;
  };
}) {
  const [open, setOpen] = useState(false);
  const update = useMutation(api.sprints.update);
  const remove = useMutation(api.sprints.remove);
  const updateTask = useMutation(api.tasks.update);
  const summary = useQuery(
    api.sprints.summary,
    open ? { sprintId: sprint._id } : "skip",
  );
  const addable = useQuery(
    api.sprints.addableTasks,
    open && sprint.status !== "complete" ? { sprintId: sprint._id } : "skip",
  );

  const pct =
    sprint.taskCount === 0
      ? 0
      : Math.round((sprint.doneCount / sprint.taskCount) * 100);
  const fmt = (ts: number) =>
    new Date(ts).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });

  return (
    <div className="rounded-3xl border border-border bg-background p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Collapse" : "Expand"}
          className="inline-flex h-5 w-5 items-center justify-center text-muted-foreground"
        >
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>
        <span className="font-medium">{sprint.name}</span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider",
            STATUS_STYLE[sprint.status],
          )}
        >
          {sprint.status}
        </span>
        <span className="text-xs text-muted-foreground">
          {fmt(sprint.startDate)} – {fmt(sprint.endDate)}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {sprint.doneCount}/{sprint.taskCount} done
        </span>
        {sprint.status !== "complete" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              update({
                sprintId: sprint._id,
                status: sprint.status === "planned" ? "active" : "complete",
              })
            }
          >
            {sprint.status === "planned" ? "Start" : "Complete"}
          </Button>
        )}
        <button
          type="button"
          title="Delete sprint (tasks are kept)"
          onClick={() => {
            if (window.confirm(`Delete ${sprint.name}? Tasks are kept.`)) {
              remove({ sprintId: sprint._id });
            }
          }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-red-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {sprint.goal && (
        <p className="mt-1 pl-7 text-xs text-muted-foreground">{sprint.goal}</p>
      )}

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-brand-600 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>

      {open && summary && (
        <ul className="mt-3 space-y-1 pl-7">
          {summary.tasks.length === 0 && (
            <li className="text-xs text-muted-foreground">
              No tasks in this sprint yet. Add them from a task&apos;s Sprint
              field.
            </li>
          )}
          {sprint.status !== "complete" && (
            <li>
              <select
                value=""
                aria-label="Add task to sprint"
                onChange={(e) => {
                  const id = e.currentTarget.value;
                  if (id) {
                    updateTask({
                      taskId: id as Id<"tasks">,
                      sprintId: sprint._id,
                    });
                  }
                }}
                className="rounded-full border border-dashed border-border bg-background px-3 py-1 text-sm text-muted-foreground"
              >
                <option value="">+ Add task to sprint…</option>
                {(addable ?? []).map((t) => (
                  <option key={t.taskId} value={t.taskId}>
                    {t.title}
                  </option>
                ))}
              </select>
            </li>
          )}
          {summary.tasks.map((t) => (
            <li key={t._id} className="flex items-center gap-2 text-sm">
              <span
                aria-hidden
                className={cn(
                  "h-1.5 w-1.5 flex-shrink-0 rounded-full",
                  t.statusCategory === "complete" ||
                    t.statusCategory === "closed"
                    ? "bg-emerald-500"
                    : t.statusCategory === "in_progress"
                      ? "bg-blue-500"
                      : "bg-muted-foreground",
                )}
              />
              <Link
                href={`/dashboard/l/${t.listId}/t/${t._id}`}
                className="min-w-0 flex-1 truncate hover:underline"
              >
                {t.title}
              </Link>
              <span className="text-xs text-muted-foreground">
                {t.statusName}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
