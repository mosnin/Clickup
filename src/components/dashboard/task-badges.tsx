"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import {
  Link2,
  Lock,
  PackageCheck,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";
import { Tooltip } from "@/components/beui/tooltip";

// Compact inline badges shown next to task titles in List/Board views so
// humans can see agent-collaboration state (claimed / blocked / awaiting
// approval) without opening the task.
export function TaskBadges({ task }: { task: Doc<"tasks"> }) {
  const blockedByIds = useMemo(
    () => task.blockedByTaskIds ?? [],
    [task.blockedByTaskIds],
  );
  const hasBlockers = blockedByIds.length > 0;

  // The backend only refuses completion for blockers whose status category
  // is still open/in_progress, so only query — and only flag — when there
  // actually are blockers, and only count the ones still open. Both
  // queries key off the same listId as `task` and share the Convex
  // client's subscription cache with every other TaskBadges/TaskBlockedBy
  // instance on the page, so this doesn't multiply per row.
  const statuses = useQuery(
    api.listStatuses.listForList,
    hasBlockers ? { listId: task.listId } : "skip",
  );
  const siblingTasks = useQuery(
    api.tasks.listForList,
    hasBlockers ? { listId: task.listId } : "skip",
  );

  const openBlockerCount = useMemo(() => {
    if (!hasBlockers || !statuses || !siblingTasks) return 0;
    const statusById = new Map(statuses.map((s) => [s._id, s]));
    const taskById = new Map(siblingTasks.map((t) => [t._id, t]));
    return blockedByIds.filter((id) => {
      const blocker = taskById.get(id);
      if (!blocker) return false;
      const status = statusById.get(blocker.statusId);
      return status?.category !== "complete" && status?.category !== "closed";
    }).length;
  }, [hasBlockers, statuses, siblingTasks, blockedByIds]);

  // Which tasks on this board have a completion waiting on a human. One
  // subscription for the whole list, shared across every row by the Convex
  // client's cache — the same shape the two queries above use.
  const handedBack = useQuery(api.pendingEffects.forList, {
    listId: task.listId,
  });
  const finished = (handedBack ?? []).includes(task._id);
  const held = task.thrashHeldAt !== undefined;

  const blocked = openBlockerCount > 0;
  // An approval gate on a task an agent has already finished is not the same
  // fact, and the stronger one wins: "waiting on you" beats "will need you".
  const awaitingApproval =
    task.requiresApproval && !task.approvedAt && !finished;
  if (
    !task.claimedByActorId &&
    !blocked &&
    !awaitingApproval &&
    !finished &&
    !held
  ) {
    return null;
  }
  // Every glyph here is 12px of pure colour carrying a whole fact, so each one
  // has to clear the 3:1 floor for a non-text graphical object in BOTH themes,
  // and none of them may sit on it — a mark you have to hunt for is
  // decoration. Measured on the row's own surface (#fff and #232326):
  //
  //   brand-500  10.4 / 6.1     amber-600 → 700/500  5.0 / 7.3
  //   red-600 → 500/500          4.8 / 4.2
  //
  // The two that were `text-brand-600` measured 18.5 in light and 3.24 in dark
  // — the widest swing of the four and the only pair actually on the floor,
  // which is what a token tuned for one theme does. `amber-600` and `red-500`
  // are Tailwind literals with no dark value at all, so each is split into the
  // shade that reads on the surface it lands on.
  return (
    <span className="ml-1 inline-flex items-center gap-1 align-middle">
      {task.claimedByActorId && (
        <Tooltip content="Claimed — someone is actively working on this">
        <span>
          <Lock
            className="h-3 w-3 text-amber-700 dark:text-amber-500"
            aria-hidden
          />
        </span>
        </Tooltip>
      )}
      {blocked && (
        <Tooltip content="Blocked by other open tasks">
        <span>
          <Link2
            className="h-3 w-3 text-red-600 dark:text-red-500"
            aria-hidden
          />
        </span>
        </Tooltip>
      )}
      {awaitingApproval && (
        <Tooltip content="Needs your approval before completion">
        <span>
          <ShieldAlert className="h-3 w-3 text-brand-500" aria-hidden />
        </span>
        </Tooltip>
      )}
      {/* Finished, and one click from landing. Without this a task an agent
          completed yesterday sorts and renders exactly like untouched work,
          so scanning a board cannot tell you where the fleet actually got to. */}
      {finished && (
        <Tooltip content="An agent finished this — waiting for your go-ahead">
        <span>
          <PackageCheck className="h-3 w-3 text-brand-500" aria-hidden />
        </span>
        </Tooltip>
      )}
      {/* Held: withheld from the dispatcher until somebody looks. The one
          state where a task looks completely normal and is guaranteed not to
          move, which is how a person concludes the fleet has stopped. */}
      {held && (
        <Tooltip content="Held after repeated failure — agents will not pick this up">
        <span>
          <TriangleAlert className="h-3 w-3 text-danger" aria-hidden />
        </span>
        </Tooltip>
      )}
    </span>
  );
}
