"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { Link2, Lock, ShieldAlert } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";

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

  const blocked = openBlockerCount > 0;
  const awaitingApproval = task.requiresApproval && !task.approvedAt;
  if (!task.claimedByActorId && !blocked && !awaitingApproval) return null;
  return (
    <span className="ml-1 inline-flex items-center gap-1 align-middle">
      {task.claimedByActorId && (
        <span title="Claimed, someone is actively working on this">
          <Lock className="h-3 w-3 text-amber-600" aria-hidden />
        </span>
      )}
      {blocked && (
        <span title="Blocked by other open task(s)">
          <Link2 className="h-3 w-3 text-red-500" aria-hidden />
        </span>
      )}
      {awaitingApproval && (
        <span title="Needs human approval before completion">
          <ShieldAlert className="h-3 w-3 text-brand-600" aria-hidden />
        </span>
      )}
    </span>
  );
}
