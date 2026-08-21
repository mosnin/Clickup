/**
 * Shared completion-state patch used by the task cores, status
 * recategorize/delete, and automations. `completedAt` is what routing,
 * reports, ops overview and sprint burndown use as "is this open?" —
 * stomping it on Complete→Closed, or leaving it stale when a column is
 * recategorized, silently corrupts those reads.
 *
 * Moving between two done categories keeps the original timestamp.
 * Entering the done bucket stamps now (or keeps a stamp already there).
 * Leaving the done bucket clears it and revokes a prior approval so a
 * later complete can't ride a stale sign-off.
 */

export function isDoneCategory(category: string | undefined): boolean {
  return category === "complete" || category === "closed";
}

export function completionStatePatch(
  task: {
    completedAt?: number;
    requiresApproval?: boolean;
  },
  willBeComplete: boolean,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    completedAt: willBeComplete ? (task.completedAt ?? Date.now()) : undefined,
  };
  if (willBeComplete) {
    patch.claimedByActorId = undefined;
    patch.claimedAt = undefined;
    patch.thrashHeldAt = undefined;
    patch.thrashFailures = undefined;
  } else if (task.requiresApproval) {
    patch.approvedAt = undefined;
    patch.approvedByClerkId = undefined;
  }
  return patch;
}
