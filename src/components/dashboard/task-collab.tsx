"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Hand, Lock, Plus, ShieldCheck, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Picker } from "@/components/ui/picker";
import { cn } from "@/lib/utils";
import { AnimatePresence, EASE, motion } from "@/components/motion";

// Collaboration sections for the task detail page: approval/claim banners,
// assignees (humans AND agents), sprint membership, acceptance-criteria
// checklist, and blocked-by dependencies. Exported as separate components
// so the task page can lay them out (banners full-width, state in the
// right rail, checklist with the content). All persistence goes through
// tasks.update so agents see identical state over MCP.

export function TaskBanners({
  task,
  listId,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
}) {
  const update = useMutation(api.tasks.update);
  const releaseClaim = useMutation(api.tasks.releaseClaim);
  const claim = useMutation(api.tasks.claim);
  const approve = useMutation(api.tasks.approve);
  const assignable = useQuery(api.agents.listAssignableForList, { listId });

  const byId = useMemo(
    () => new Map((assignable ?? []).map((a) => [a.id, a])),
    [assignable],
  );
  const claimant = task.claimedByActorId
    ? byId.get(task.claimedByActorId)
    : undefined;

  return (
    <div className="space-y-3">
      {task.requiresApproval && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: EASE }}
          className={cn(
            "flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm",
            task.approvedAt
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-brand-200 bg-brand-50 text-brand-800",
          )}
        >
          <ShieldCheck className="h-4 w-4 flex-shrink-0" />
          <span className="min-w-0 flex-1">
            {task.approvedAt
              ? "Approved — agents may complete this task."
              : "Approval gate: agents can't complete this task until a human approves."}
          </span>
          {!task.approvedAt && (
            <Button size="sm" onClick={() => approve({ taskId: task._id })}>
              Approve
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              update({ taskId: task._id, requiresApproval: false })
            }
          >
            Remove gate
          </Button>
        </motion.div>
      )}
      {task.claimedByActorId ? (
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
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => claim({ taskId: task._id })}
          >
            <Hand className="h-3.5 w-3.5" /> I&apos;m on it
          </Button>
          {!task.requiresApproval && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                update({ taskId: task._id, requiresApproval: true })
              }
            >
              <ShieldCheck className="h-3.5 w-3.5" /> Require approval
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function TaskAssignees({
  task,
  listId,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
}) {
  const update = useMutation(api.tasks.update);
  const assignable = useQuery(api.agents.listAssignableForList, { listId });
  const byId = useMemo(
    () => new Map((assignable ?? []).map((a) => [a.id, a])),
    [assignable],
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {task.assigneeClerkIds.map((id) => {
        const person = byId.get(id);
        return (
          <span
            key={id}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-sm"
          >
            {person?.kind === "agent" ? (person.emoji ?? "🤖") : null}
            <span>{person?.name ?? "Someone"}</span>
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
              className="tap-target text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}
      <Picker
        label="+ Assign…"
        dashed
        options={(assignable ?? [])
          .filter((a) => !task.assigneeClerkIds.includes(a.id))
          .map((a) => ({
            id: a.id,
            label: a.name,
            emoji: a.kind === "agent" ? (a.emoji ?? "🤖") : undefined,
            hint: a.kind === "agent" ? "agent" : undefined,
          }))}
        onSelect={(id) =>
          update({
            taskId: task._id,
            assigneeClerkIds: [...task.assigneeClerkIds, id],
          })
        }
      />
    </div>
  );
}

// Renders nothing when the list's workspace has no sprints.
export function TaskSprintPicker({
  task,
  listId,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
}) {
  const update = useMutation(api.tasks.update);
  const sprints = useQuery(api.sprints.listForList, { listId });
  if (sprints === undefined || sprints.length === 0) return null;

  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Sprint
      </h2>
      <Picker
        label={
          task.sprintId
            ? (sprints.find((s) => s._id === task.sprintId)?.name ?? "Sprint")
            : "No sprint"
        }
        selectedId={task.sprintId ?? "none"}
        options={[
          { id: "none", label: "No sprint" },
          ...sprints.map((s) => ({
            id: s._id as string,
            label: s.name,
            hint: s.status,
          })),
        ]}
        onSelect={(id) =>
          update({
            taskId: task._id,
            sprintId: id === "none" ? null : (id as Id<"sprints">),
          })
        }
      />
    </section>
  );
}

export function TaskBlockedBy({
  task,
  listId,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
}) {
  const update = useMutation(api.tasks.update);
  const siblingTasks = useQuery(api.tasks.listForList, { listId });
  const blockerTitles = useQuery(api.tasks.titles, {
    taskIds: task.blockedByTaskIds ?? [],
  });

  return (
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
              className="tap-target text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <Picker
          label="+ Add blocker…"
          dashed
          options={(siblingTasks ?? [])
            .filter(
              (t) =>
                t._id !== task._id &&
                !(task.blockedByTaskIds ?? []).includes(t._id),
            )
            .map((t) => ({ id: t._id as string, label: t.title }))}
          onSelect={(id) =>
            update({
              taskId: task._id,
              blockedByTaskIds: [
                ...(task.blockedByTaskIds ?? []),
                id as Id<"tasks">,
              ],
            })
          }
        />
      </div>
      {(task.blockedByTaskIds ?? []).length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          This task can&apos;t be completed while a blocker is still open.
        </p>
      )}
    </section>
  );
}

export function TaskChecklist({ task }: { task: Doc<"tasks"> }) {
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
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <motion.li
              key={item.id}
              layout
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="flex items-center gap-2 overflow-hidden"
            >
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
                className="tap-target text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
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
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={!newItem.trim()}
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </form>
    </section>
  );
}
