"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Hand,
  Lock,
  PackageCheck,
  Plus,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
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
import { errorMessage } from "@/lib/errors";

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
  const decideEffect = useMutation(api.pendingEffects.decide);
  const clearHold = useMutation(api.tasks.clearThrashHold);
  // Work an agent finished that nobody has consented to yet. Fetched here
  // rather than derived from the task, because the task looks completely
  // ordinary while one of these is outstanding — which is the whole problem.
  const handback = useQuery(api.pendingEffects.forTask, { taskId: task._id });
  const assignable = useQuery(api.agents.listAssignableForList, { listId });
  const { toast } = useToast();

  // Every banner action can be refused server-side (e.g. a claim race:
  // "Task is already claimed") — surface the reason instead of swallowing.
  async function run(fn: () => Promise<unknown>, fallback: string) {
    try {
      await fn();
    } catch (e) {
      toast(errorMessage(e, fallback), { kind: "error" });
    }
  }

  const byId = useMemo(
    () => new Map((assignable ?? []).map((a) => [a.id, a])),
    [assignable],
  );
  const claimant = task.claimedByActorId
    ? byId.get(task.claimedByActorId)
    : undefined;

  // What actually needs the person, ranked — and at most one of them gets a
  // card. A finished handback outranks a hold because approving it resolves
  // the task outright, which makes the hold moot; a hold outranks nothing,
  // because nothing else here is a demand at all.
  //
  // This ranking is a fix, not a tidy-up. Each banner was designed on its own
  // and every one of them was right on its own; a task that had been handed
  // back, held, gated AND claimed drew four full-width coloured cards in a
  // column, three of them some flavour of alarm, and the page read as broken.
  // Everything that is a FACT about the task rather than a demand on the
  // reader — the gate, the claim, a hold that lost the card — moved to one
  // quiet line underneath, each fact keeping its own control.
  const demand: "handback" | "hold" | null = handback
    ? "handback"
    : task.thrashHeldAt !== undefined
      ? "hold"
      : null;

  return (
    <div className="space-y-3">
      {/* ── An agent finished this and is waiting ──
          First, because it is the only banner here that represents work
          somebody has already done. Everything else on this page describes a
          state; this describes a thing waiting to be applied. */}
      {handback && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: EASE }}
        >
          <Card className="gap-2 border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            <div className="flex items-center gap-2">
              <PackageCheck className="h-4 w-4 flex-shrink-0" />
              <span className="min-w-0 flex-1 font-medium">
                {handback.agentName} finished this{" "}
                {timeAgo(handback.createdAt)} and needs your go-ahead
              </span>
            </div>
            {/* The agent's own account of what it did. The point of recording
                the attempt rather than refusing it was to keep exactly this —
                without it a reviewer has to re-do the work to find out what
                happened. */}
            {/* brand-700 at 80%, not brand-600. The ramp's 600 stop is a mid
                grey in BOTH themes, so as a quieter register it reads 17:1 in
                light and 3.81:1 in dark — under AA at body size on exactly the
                paragraph a reviewer has to read before approving. Alpha on the
                ink stop is quieter in the same proportion either way. */}
            <p className="pl-6 text-brand-700/80">{handback.reason}</p>
            {handback.stale && (
              <p className="pl-6 text-tiny text-danger">
                The task has changed since this was written, so approving will
                not apply it.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 pl-6">
              <Button
                size="sm"
                onClick={() =>
                  void run(
                    () =>
                      decideEffect({ ids: [handback.id], decision: "approve" }),
                    "Couldn't approve this",
                  )
                }
              >
                Approve and complete
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void run(
                    () =>
                      decideEffect({ ids: [handback.id], decision: "reject" }),
                    "Couldn't send this back",
                  )
                }
              >
                Send back
              </Button>
            </div>
          </Card>
        </motion.div>
      )}
      {/* ── Held until somebody looks ──
          A held task is withheld from the dispatcher, so on its own page it
          looks like ordinary open work that no agent happens to be picking up.
          Saying nothing here is how a person concludes the fleet is broken.
          Drawn as a card only when nothing outranks it; otherwise it keeps its
          words and its control down on the facts line. */}
      {demand === "hold" && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: EASE }}
        >
          <Card className="flex-row items-center gap-2 border-danger/30 bg-danger/5 px-4 py-2.5 text-sm text-danger">
            <TriangleAlert className="h-4 w-4 flex-shrink-0" />
            <span className="min-w-0 flex-1">
              {holdSentence(task)}. Agents will not pick this up until you
              release it.
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void run(
                  () => clearHold({ taskId: task._id }),
                  "Couldn't release this task",
                )
              }
            >
              Let it retry
            </Button>
          </Card>
        </motion.div>
      )}
      {/* ── The facts, and their controls ──
          Everything true about this task that is not a demand on the reader.
          One line of small type: a person scanning the page reads the card,
          and reads this only when they want to know why. */}
      <div className="flex flex-wrap items-center gap-2">
        {/* A hold that lost the card still has to be sayable, and still has to
            be releasable — its whole point is that nothing moves until
            somebody acts. */}
        {task.thrashHeldAt !== undefined && demand !== "hold" && (
          <Fact
            icon={TriangleAlert}
            tone="border-danger/30 text-danger"
            action={{
              label: "Let it retry",
              onClick: () =>
                void run(
                  () => clearHold({ taskId: task._id }),
                  "Couldn't release this task",
                ),
            }}
          >
            {holdSentence(task)}
          </Fact>
        )}
        {task.requiresApproval && (
          <Fact
            icon={ShieldCheck}
            tone={
              task.approvedAt
                ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
                : undefined
            }
            action={{
              label: "Remove gate",
              onClick: () =>
                void run(
                  () => update({ taskId: task._id, requiresApproval: false }),
                  "Couldn't remove the approval gate",
                ),
            }}
          >
            {task.approvedAt
              ? "Approved, agents may complete this"
              : handback
                ? "Gated — approving above finishes it"
                : "Gated: an agent's completion is recorded for you, not applied"}
          </Fact>
        )}
        {/* No Approve here while a handback is outstanding. tasks.approve
            lifts the gate WITHOUT applying the agent's completion, so a person
            clicking it would believe they had approved the work while the
            finished completion sat unapplied above. The handback card's own
            Approve is the one that completes the task. */}
        {task.requiresApproval && !task.approvedAt && !handback && (
          <Button
            size="sm"
            onClick={() =>
              void run(
                () => approve({ taskId: task._id }),
                "Couldn't approve this task",
              )
            }
          >
            Approve
          </Button>
        )}
        {task.claimedByActorId ? (
          <Fact
            icon={Lock}
            action={{
              label: "Release",
              onClick: () =>
                void run(
                  () => releaseClaim({ taskId: task._id }),
                  "Couldn't release the claim",
                ),
            }}
          >
            {claimant ? claimant.name : "Someone"} is on it,{" "}
            {task.claimedAt ? timeAgo(task.claimedAt) : "recently"}
          </Fact>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void run(
                () => claim({ taskId: task._id }),
                "Couldn't claim this task",
              )
            }
          >
            <Hand className="h-3.5 w-3.5" /> I&apos;m on it
          </Button>
        )}
        {!task.requiresApproval && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void run(
                () => update({ taskId: task._id, requiresApproval: true }),
                "Couldn't add the approval gate",
              )
            }
          >
            <ShieldCheck className="h-3.5 w-3.5" /> Require approval
          </Button>
        )}
      </div>
    </div>
  );
}

/** Why this task is held, in words, wherever it happens to be said. */
function holdSentence(task: Doc<"tasks">): string {
  return task.holdReason === "attempts_exhausted"
    ? "Held after running out of dispatch attempts"
    : `Held after ${task.thrashFailures ?? "repeated"} failed attempts`;
}

/**
 * One true thing about the task, with the control that changes it.
 *
 * The control lives INSIDE the chip on purpose: a row of facts followed by a
 * row of buttons makes the reader match them up, and gets it wrong the moment
 * a fact is absent. `.tap-target` is a pseudo-element halo, so a 44px touch
 * area costs the chip no layout.
 */
function Fact({
  icon: Icon,
  tone,
  action,
  children,
}: {
  icon: typeof Lock;
  tone?: string;
  action?: { label: string; onClick: () => void };
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground",
        tone,
      )}
    >
      <Icon className="h-3.5 w-3.5 flex-shrink-0" />
      <span>{children}</span>
      {action && (
        <>
          <span aria-hidden className="opacity-40">
            ·
          </span>
          <button
            type="button"
            onClick={action.onClick}
            className="tap-target font-medium text-foreground underline-offset-2 hover:underline"
          >
            {action.label}
          </button>
        </>
      )}
    </span>
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
    const missing = (task.requiredCapabilities ?? []).filter(
      (capability) => !(agent.capabilities ?? []).includes(capability),
    );
    if (missing.length > 0) return `missing ${missing.join(", ")}`;
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
                className="text-micro uppercase tracking-wider text-muted-foreground"
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
        for (const f of s.projects) {
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
  // Optimistic update on the task doc: `commit` computes the next checklist
  // from the rendered `task` prop, so without this two rapid toggles would
  // each start from the same stale snapshot and the second would undo the
  // first. Patching the tasks.get result locally means each commit renders
  // (and computes) on top of the in-flight one. Same pattern as the
  // subtasks toggle.
  const update = useMutation(api.tasks.update).withOptimisticUpdate(
    (localStore, args) => {
      if (args.checklist === undefined) return;
      const current = localStore.getQuery(api.tasks.get, {
        taskId: args.taskId,
      });
      if (!current) return;
      localStore.setQuery(
        api.tasks.get,
        { taskId: args.taskId },
        { ...current, checklist: args.checklist },
      );
    },
  );
  const { toast } = useToast();
  const [newItem, setNewItem] = useState("");
  const items = task.checklist ?? [];
  const doneCount = items.filter((i) => i.done).length;
  const pct = items.length > 0 ? (doneCount / items.length) * 100 : 0;

  function commit(next: { id: string; text: string; done: boolean }[]) {
    update({ taskId: task._id, checklist: next }).catch((e) => {
      toast(errorMessage(e, "Couldn't update checklist"), { kind: "error" });
    });
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
                        <span className="flex-shrink-0 text-micro text-muted-foreground">
                          {t.items.length} item
                          {t.items.length === 1 ? "" : "s"}
                        </span>
                        {t.source === "personal" && (
                          <span className="flex-shrink-0 text-micro uppercase tracking-wider text-muted-foreground">
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
