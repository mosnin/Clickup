"use client";

import { Link2, Lock, ShieldAlert } from "lucide-react";
import type { Doc } from "@convex/_generated/dataModel";

// Compact inline badges shown next to task titles in List/Board views so
// humans can see agent-collaboration state (claimed / blocked / awaiting
// approval) without opening the task.
export function TaskBadges({ task }: { task: Doc<"tasks"> }) {
  const blocked = (task.blockedByTaskIds?.length ?? 0) > 0;
  const awaitingApproval = task.requiresApproval && !task.approvedAt;
  if (!task.claimedByActorId && !blocked && !awaitingApproval) return null;
  return (
    <span className="ml-1 inline-flex items-center gap-1 align-middle">
      {task.claimedByActorId && (
        <span title="Claimed — someone is actively working on this">
          <Lock className="h-3 w-3 text-amber-600" aria-hidden />
        </span>
      )}
      {blocked && (
        <span title="Blocked by other task(s)">
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
