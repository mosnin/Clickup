"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Lock, Plus, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Collaboration controls on the task detail page: assignees (humans AND
// agents), sprint membership, the agent work-claim, acceptance-criteria
// checklist, and blocked-by dependencies. All persistence goes through
// tasks.update so agents see identical state over MCP.

export function TaskCollaboration({
  task,
  listId,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
}) {
  const update = useMutation(api.tasks.update);
  const releaseClaim = useMutation(api.tasks.releaseClaim);
  const assignable = useQuery(api.agents.listAssignableForList, { listId });
  const sprints = useQuery(api.sprints.listForList, { listId });
  const siblingTasks = useQuery(api.tasks.listForList, { listId });
  const blockerTitles = useQuery(api.tasks.titles, {
    taskIds: task.blockedByTaskIds ?? [],
  });

  const byId = useMemo(
    () => new Map((assignable ?? []).map((a) => [a.id, a])),
    [assignable],
  );
  const claimant = task.claimedByActorId
    ? byId.get(task.claimedByActorId)
    : undefined;

  return (
    <div className="space-y-6">
      {task.claimedByActorId && (
        <div className="flex items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          <Lock className="h-4 w-4 flex-shrink-0" />
          <span className="min-w-0 flex-1">
            Claimed by{" "}
            <span className="font-medium">
              {claimant
                ? `${claimant.kind === "agent" ? "🤖 " : ""}${claimant.name}`
                : "someone"}
            </span>{" "}
            — they&apos;re actively working on this.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => releaseClaim({ taskId: task._id })}
          >
            Release
          </Button>
        </div>
      )}

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Assignees
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {task.assigneeClerkIds.map((id) => {
            const person = byId.get(id);
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-sm"
              >
                {person?.kind === "agent" ? (person.emoji ?? "🤖") : null}
                <span>{person?.name ?? "Unknown"}</span>
                <button
                  type="button"
                  aria-label={`Unassign ${person?.name ?? "assignee"}`}
                  onClick={() =>
                    update({
                      taskId: task._id,
                      assigneeClerkIds: task.assigneeClerkIds.filter(
                        (a) => a !== id,
                      ),
                    })
                  }
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })}
          <select
            value=""
            onChange={(e) => {
              const id = e.currentTarget.value;
              if (id && !task.assigneeClerkIds.includes(id)) {
                update({
                  taskId: task._id,
                  assigneeClerkIds: [...task.assigneeClerkIds, id],
                });
              }
            }}
            className="rounded-full border border-dashed border-border bg-background px-3 py-1 text-sm text-muted-foreground"
          >
            <option value="">+ Assign…</option>
            {(assignable ?? [])
              .filter((a) => !task.assigneeClerkIds.includes(a.id))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.kind === "agent" ? `🤖 ${a.name} (agent)` : a.name}
                </option>
              ))}
          </select>
        </div>
      </section>

      {sprints !== undefined && sprints.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Sprint
          </h2>
          <select
            value={task.sprintId ?? ""}
            onChange={(e) => {
              const v = e.currentTarget.value;
              update({
                taskId: task._id,
                sprintId: v ? (v as Id<"sprints">) : null,
              });
            }}
            className="rounded-full border border-border bg-background px-3 py-1.5 text-sm"
          >
            <option value="">No sprint</option>
            {sprints.map((s) => (
              <option key={s._id} value={s._id}>
                {s.name} ({s.status})
              </option>
            ))}
          </select>
        </section>
      )}

      <Checklist task={task} />

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Blocked by
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {(task.blockedByTaskIds ?? []).map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-sm"
            >
              <Link
                href={`/dashboard/l/${listId}/t/${id}`}
                className="hover:underline"
              >
                {blockerTitles?.[id] ?? "Task"}
              </Link>
              <button
                type="button"
                aria-label="Remove dependency"
                onClick={() =>
                  update({
                    taskId: task._id,
                    blockedByTaskIds: (task.blockedByTaskIds ?? []).filter(
                      (b) => b !== id,
                    ),
                  })
                }
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <select
            value=""
            onChange={(e) => {
              const id = e.currentTarget.value as Id<"tasks">;
              if (id && !(task.blockedByTaskIds ?? []).includes(id)) {
                update({
                  taskId: task._id,
                  blockedByTaskIds: [...(task.blockedByTaskIds ?? []), id],
                });
              }
            }}
            className="rounded-full border border-dashed border-border bg-background px-3 py-1 text-sm text-muted-foreground"
          >
            <option value="">+ Add blocker…</option>
            {(siblingTasks ?? [])
              .filter(
                (t) =>
                  t._id !== task._id &&
                  !(task.blockedByTaskIds ?? []).includes(t._id),
              )
              .map((t) => (
                <option key={t._id} value={t._id}>
                  {t.title}
                </option>
              ))}
          </select>
        </div>
        {(task.blockedByTaskIds ?? []).length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            This task can&apos;t be completed while a blocker is still open.
          </p>
        )}
      </section>
    </div>
  );
}

function Checklist({ task }: { task: Doc<"tasks"> }) {
  const update = useMutation(api.tasks.update);
  const [newItem, setNewItem] = useState("");
  const items = task.checklist ?? [];
  const doneCount = items.filter((i) => i.done).length;

  function commit(next: { id: string; text: string; done: boolean }[]) {
    update({ taskId: task._id, checklist: next });
  }

  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Checklist{items.length > 0 && ` · ${doneCount}/${items.length}`}
      </h2>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={item.done}
              onChange={() =>
                commit(
                  items.map((i) =>
                    i.id === item.id ? { ...i, done: !i.done } : i,
                  ),
                )
              }
              className="h-4 w-4 rounded border-border"
            />
            <span
              className={cn(
                "flex-1 text-sm",
                item.done && "text-muted-foreground line-through",
              )}
            >
              {item.text}
            </span>
            <button
              type="button"
              aria-label="Remove item"
              onClick={() => commit(items.filter((i) => i.id !== item.id))}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newItem.trim()) return;
          commit([
            ...items,
            {
              id: Math.random().toString(36).slice(2, 10),
              text: newItem.trim(),
              done: false,
            },
          ]);
          setNewItem("");
        }}
      >
        <input
          value={newItem}
          onChange={(e) => setNewItem(e.currentTarget.value)}
          placeholder="Add acceptance criterion…"
          className="flex-1 rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
        <Button type="submit" size="sm" variant="outline" disabled={!newItem.trim()}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </form>
    </section>
  );
}
