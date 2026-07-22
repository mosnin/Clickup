"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Hand, Lock, Plus, ShieldCheck, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Picker } from "@/components/ui/picker";
import { Monogram } from "@/components/dashboard/monogram";
import { InlineCreate } from "@/components/dashboard/inline-create";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { AnimatedBar, AnimatePresence, EASE, motion } from "@/components/motion";

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
        >
          <Card
            className={cn(
              "flex-row items-center gap-2 px-4 py-2.5 text-sm",
              task.approvedAt
                ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/40 dark:bg-emerald-950/40 dark:text-emerald-400"
                : "border-brand-200 bg-brand-50 text-brand-800",
            )}
          >
            <ShieldCheck className="h-4 w-4 flex-shrink-0" />
            <span className="min-w-0 flex-1">
              {task.approvedAt
                ? "Approved, agents may complete this task."
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
          </Card>
        </motion.div>
      )}
      {task.claimedByActorId ? (
        <Card className="flex-row items-center gap-2 border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 dark:border-amber-800/40 dark:bg-amber-950/40 dark:text-amber-400">
          <Lock className="h-4 w-4 flex-shrink-0" />
          <span className="min-w-0 flex-1">
            Claimed by{" "}
            <span className="font-medium">
              {claimant ? claimant.name : "someone"}
            </span>{" "}
            {task.claimedAt ? timeAgo(task.claimedAt) : "recently"}, they&apos;re
            actively working on this. Auto-releases after 60 min of
            inactivity.
          </span>
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
          <Button
            size="sm"
            variant="outline"
            onClick={() => releaseClaim({ taskId: task._id })}
          >
            Release
          </Button>
        </Card>
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
  // listAssignableForList doesn't return status/role/allowedListIds, so
  // cross-reference full agent docs (already fetched for the Agents HQ
  // page) to find ones that structurally can't act on this list: paused,
  // readonly, or list-restricted away from here. Matching is by agent _id,
  // which is globally unique, so scope doesn't need to be re-derived.
  const myAgents = useQuery(api.agents.listForCurrentUser, {});
  const agentDocsById = useMemo(() => {
    const map = new Map<string, Doc<"agents">>();
    for (const a of myAgents?.personal ?? []) map.set(a._id, a);
    for (const w of myAgents?.workspaces ?? []) {
      for (const a of w.agents) map.set(a._id, a);
    }
    return map;
  }, [myAgents]);

  function unavailableReason(agentId: string): string | null {
    const agent = agentDocsById.get(agentId);
    if (!agent) return null;
    if (agent.status === "paused") return "paused";
    if (agent.role === "readonly") return "read-only";
    if (agent.allowedListIds && !agent.allowedListIds.includes(listId)) {
      return "restricted";
    }
    return null;
  }

  const byId = useMemo(
    () => new Map((assignable ?? []).map((a) => [a.id, a])),
    [assignable],
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {task.assigneeClerkIds.map((id) => {
        const person = byId.get(id);
        const reason =
          person?.kind === "agent" ? unavailableReason(id) : null;
        return (
          <Badge
            key={id}
            variant="outline"
            className="gap-1.5 py-1 pr-1 pl-3 text-sm font-normal"
          >
            {person?.kind === "agent" && (
              <Monogram name={person.name} size="sm" />
            )}
            <span>{person?.name ?? "Someone"}</span>
            {reason && (
              <span
                title={`This agent can't act on this task (${reason})`}
                className="text-[10px] uppercase tracking-wider text-muted-foreground"
              >
                {reason}
              </span>
            )}
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
          </Badge>
        );
      })}
      <Picker
        label="+ Assign…"
        dashed
        options={(assignable ?? [])
          .filter((a) => !task.assigneeClerkIds.includes(a.id))
          .filter((a) => a.kind !== "agent" || !unavailableReason(a.id))
          .map((a) => ({
            id: a.id,
            label: a.name,
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

// Personal lists (no workspace) render nothing — sprints are a workspace
// feature. Workspace lists always render the section, with a create link
// when no sprint exists yet so the feature is discoverable from the task.
export function TaskSprintPicker({
  task,
  listId,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
}) {
  const update = useMutation(api.tasks.update);
  const sprints = useQuery(api.sprints.listForList, { listId });
  // The sidebar keeps this subscription warm app-wide, so resolving the
  // list's workspace from it is a cache hit, not an extra round-trip.
  const tree = useQuery(api.sidebar.tree, {});
  const workspaceId = useMemo(() => {
    for (const w of tree?.workspaces ?? []) {
      for (const s of w.spaces) {
        if (s.lists.some((l) => l._id === listId)) return w._id;
        for (const f of s.folders) {
          if (f.lists.some((l) => l._id === listId)) return w._id;
        }
      }
    }
    return null;
  }, [tree, listId]);

  if (sprints === undefined) return null;

  const newSprintHref = workspaceId
    ? `/dashboard/w/${workspaceId}?tab=sprints&new=1`
    : null;

  if (sprints.length === 0) {
    // No sprints yet: without a link here the whole feature is invisible
    // from where people actually work.
    if (!newSprintHref) return null;
    return (
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Sprint
        </h2>
        <Link
          href={newSprintHref}
          className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Create the first sprint
        </Link>
      </section>
    );
  }

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
      {newSprintHref && (
        <Link
          href={newSprintHref}
          className="mt-1.5 inline-block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          New sprint
        </Link>
      )}
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
  const statuses = useQuery(api.listStatuses.listForList, { listId });
  const blockerTitles = useQuery(api.tasks.titles, {
    taskIds: task.blockedByTaskIds ?? [],
  });

  // The backend only refuses completion for blockers whose status category
  // is still open/in_progress — a completed/closed blocker no longer
  // counts, so the warning (and any "still blocking" styling) must key off
  // that, not raw list length.
  const statusById = useMemo(
    () => new Map((statuses ?? []).map((s) => [s._id, s])),
    [statuses],
  );
  const taskById = useMemo(
    () => new Map((siblingTasks ?? []).map((t) => [t._id, t])),
    [siblingTasks],
  );
  function isBlockerOpen(id: Id<"tasks">): boolean {
    const blocker = taskById.get(id);
    if (!blocker) return false;
    const status = statusById.get(blocker.statusId);
    return status?.category !== "complete" && status?.category !== "closed";
  }
  const openBlockerCount = (task.blockedByTaskIds ?? []).filter(
    isBlockerOpen,
  ).length;

  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Blocked by
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        {(task.blockedByTaskIds ?? []).map((id) => {
          const open = isBlockerOpen(id);
          return (
            <Badge
              key={id}
              variant="outline"
              className={cn(
                "gap-1.5 py-1 pr-1 pl-3 text-sm font-normal",
                !open && "opacity-60",
              )}
            >
              <Link
                href={`/dashboard/l/${listId}/t/${id}`}
                className={cn("hover:underline", !open && "line-through")}
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
            </Badge>
          );
        })}
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
      {openBlockerCount > 0 && (
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
  const pct = items.length > 0 ? (doneCount / items.length) * 100 : 0;

  function commit(next: { id: string; text: string; done: boolean }[]) {
    update({ taskId: task._id, checklist: next });
  }

  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Checklist
      </h2>
      {items.length > 0 && (
        <div className="mb-2 flex items-center gap-2">
          <AnimatedBar
            pct={pct}
            className="h-1 flex-1 overflow-hidden rounded-full bg-muted"
            barClassName={cn(
              "h-full rounded-full",
              pct === 100 ? "bg-pastel-green" : "bg-foreground/70",
            )}
          />
          <span className="flex-shrink-0 text-xs tabular-nums text-muted-foreground">
            {doneCount} of {items.length} done
          </span>
        </div>
      )}
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
          className="soft-field flex-1 px-3 py-1.5 text-sm focus:outline-none"
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
      <ChecklistTemplates task={task} hasItems={items.length > 0} />
    </section>
  );
}

// Quiet "Templates" affordance beneath the checklist: apply a saved
// playbook (its items append as fresh, unchecked entries) or snapshot the
// current checklist into a new one. Both round-trip through
// checklistTemplates.ts, never a raw db.patch, so agents over MCP see the
// exact same state.
function ChecklistTemplates({
  task,
  hasItems,
}: {
  task: Doc<"tasks">;
  hasItems: boolean;
}) {
  const templates = useQuery(api.checklistTemplates.listForTask, {
    taskId: task._id,
  });
  const applyTemplate = useMutation(api.checklistTemplates.applyToTask);
  const saveTemplate = useMutation(api.checklistTemplates.saveFromTask);
  const removeTemplate = useMutation(api.checklistTemplates.remove);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // Undo-able delete: rows hide locally first; the mutation only runs
  // when the toast's undo window closes (CLAUDE.md feedback system).
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  async function apply(templateId: Id<"checklistTemplates">) {
    try {
      await applyTemplate({ taskId: task._id, templateId });
      toast("Checklist items added");
      setOpen(false);
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "Couldn't apply template",
        { kind: "error" },
      );
    }
  }

  function remove(templateId: Id<"checklistTemplates">) {
    setHiddenIds((prev) => new Set(prev).add(templateId));
    toast("Template deleted", {
      action: {
        label: "Undo",
        onClick: () =>
          setHiddenIds((prev) => {
            const next = new Set(prev);
            next.delete(templateId);
            return next;
          }),
      },
      onExpire: () => {
        void removeTemplate({ templateId }).catch((err) => {
          setHiddenIds((prev) => {
            const next = new Set(prev);
            next.delete(templateId);
            return next;
          });
          toast(
            err instanceof Error ? err.message : "Couldn't delete template",
            { kind: "error" },
          );
        });
      },
    });
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <div ref={rootRef} className="relative">
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
          Templates
        </Button>
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: 4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.98 }}
              transition={{ duration: 0.18, ease: EASE }}
              className="absolute left-0 top-full z-30 mt-1.5 w-64 overflow-hidden rounded-2xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
            >
              {templates === undefined ||
              templates.filter((t) => !hiddenIds.has(t._id)).length === 0 ? (
                <p className="px-2.5 py-2 text-xs text-muted-foreground">
                  No checklist templates yet in this scope.
                </p>
              ) : (
                <ul className="max-h-60 overflow-y-auto">
                  {templates
                    .filter((t) => !hiddenIds.has(t._id))
                    .map((t) => (
                    <li
                      key={t._id}
                      className="flex items-center gap-0.5 rounded-lg hover:bg-accent hover:text-accent-foreground"
                    >
                      <button
                        type="button"
                        onClick={() => void apply(t._id)}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {t.name}
                        </span>
                        <span className="flex-shrink-0 text-[10px] text-muted-foreground">
                          {t.items.length} item
                          {t.items.length === 1 ? "" : "s"}
                        </span>
                        {t.source === "personal" && (
                          <span className="flex-shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                            Personal
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete template ${t.name}`}
                        onClick={() => void remove(t._id)}
                        className="tap-target flex-shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {saving ? (
        <InlineCreate
          placeholder="Template name…"
          className="w-48"
          onSubmit={async (name) => {
            try {
              await saveTemplate({ taskId: task._id, name });
              toast("Saved as template");
            } catch (err) {
              toast(
                err instanceof Error
                  ? err.message
                  : "Couldn't save template",
                { kind: "error" },
              );
            } finally {
              setSaving(false);
            }
          }}
          onCancel={() => setSaving(false)}
        />
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={!hasItems}
          onClick={() => setSaving(true)}
        >
          Save as template
        </Button>
      )}
    </div>
  );
}
