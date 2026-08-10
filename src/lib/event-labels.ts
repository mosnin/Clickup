// Human-readable phrasing for activity events, shared by every surface
// that renders an event row (Agents HQ feed, agent detail page, …).
// Add a label whenever a new event type ships — raw "task.foo" strings
// must never reach the UI.
export const EVENT_LABEL: Record<string, string> = {
  "task.created": "created task",
  "task.updated": "updated task",
  "task.assigned": "assigned",
  "task.status_changed": "moved",
  "task.completed": "completed task",
  "task.deleted": "deleted task",
  "task.claimed": "claimed task",
  "task.released": "released task",
  "comment.created": "commented on",
  "mention.created": "mentioned someone in",
  // Distinct from the `plan.*` namespace above, which is about execution
  // plans — a different concept that happens to share the English word.
  "question.opened": "raised the question",
  "question.decision_proposed": "proposed settling",
  "question.decided": "settled",
  "question.claim_held": "was right about",
  "question.claim_missed": "was wrong about",
  "sprint.created": "created sprint",
  "sprint.started": "started sprint",
  "sprint.completed": "completed sprint",
  "sprint.updated": "updated sprint",
  "task.approved": "approved",
  "task.approval_requested": "requested approval on",
  "task.handoff": "handed off",
  "task.overdue": "flagged overdue",
  "task.claim_expired": "expired a claim on",
  "agent.error": "reported an error",
  "agent.stalled": "went quiet on a task",
  "agent.connected": "came online",
  // Deliberately plain. A budget stop is not an error and not an alarm — it
  // is the ceiling somebody set doing exactly what they set it to do.
  "agent.budget_exhausted": "reached its daily spend limit",
  "agent.stopped": "was stopped by a teammate",
  "agent.resumed": "was cleared to work again",
  "fleet.budget_exhausted": "spent this space's daily budget",
  // The grant and the key are two facts, so they read as two lines: a human
  // said yes at one moment, a credential came into existence at another.
  "agent.authorized": "authorized",
  "agent.key_issued": "issued a key to",
  // Fleet lifecycle. "provisioned" is attributed to the orchestrator that
  // ran it, which is what makes a fleet legible as one thing rather than a
  // stream of agents appearing from nowhere.
  "fleet.granted": "granted a fleet to",
  "fleet.provisioned": "provisioned",
  "fleet.revoked": "revoked the fleet of",
  "channel.created": "opened channel",
  "goal.progress": "updated goal",
  "goal.completed": "completed goal",
  "roadmap.created": "created roadmap",
  "roadmap.phase_added": "added a phase to",
  "roadmap.phase_updated": "updated a phase of",
  "roadmap.phase_removed": "removed a phase from",
  "plan.committed": "compiled execution plan",
  "plan.context_revised": "revised execution context",
  "plan.wave_dispatched": "dispatched execution wave",
  "plan.execution_reconciled": "recovered stalled execution in",
  "workspace.execution_policy_updated": "updated execution policy for",
  "schedule.auto_paused": "paused recurring operation",
  "milestone.created": "added milestone",
  "milestone.updated": "updated milestone",
  "milestone.completed": "reached milestone",
  "milestone.deleted": "deleted milestone",
  "list.renamed": "renamed list",
  "list.updated": "updated list",
  "list.deleted": "deleted list",
  "list.moved": "moved list",
  "project.created": "created project",
  "project.renamed": "renamed project",
  "project.deleted": "deleted project",
  "context.created": "created shared context",
  "context.updated": "updated shared context",
  "context.deleted": "deleted shared context",
  "context.acknowledged": "acknowledged context for",
};

export function eventLabel(type: string): string {
  return EVENT_LABEL[type] ?? type.replace(/[._]/g, " ");
}

// Best-effort deep link for an event row.
export function eventHref(e: {
  type: string;
  entityType: string;
  entityId: string;
  listId?: string;
  scopeType: "user" | "workspace";
  scopeId: string;
  payload?: unknown;
}): string | null {
  if (e.entityType === "task" && e.listId) {
    return `/dashboard/l/${e.listId}/t/${e.entityId}`;
  }
  if (e.entityType === "message") {
    const p = (e.payload ?? {}) as { parentType?: string; parentId?: string };
    if (p.parentType === "task" && e.listId && p.parentId) {
      return `/dashboard/l/${e.listId}/t/${p.parentId}`;
    }
    if (p.parentType === "workspace" && p.parentId) {
      return `/dashboard/w/${p.parentId}?tab=chat`;
    }
    if (p.parentType === "channel" && p.parentId && e.scopeType === "workspace") {
      return `/dashboard/w/${e.scopeId}?tab=chat&channel=${p.parentId}`;
    }
  }
  if (e.entityType === "sprint" && e.scopeType === "workspace") {
    return `/dashboard/w/${e.scopeId}?tab=sprints`;
  }
  if (e.entityType === "agent") {
    return `/dashboard/agents/${e.entityId}`;
  }
  if (e.entityType === "roadmap" && e.scopeType === "workspace") {
    return `/dashboard/w/${e.scopeId}?tab=roadmap`;
  }
  if (e.entityType === "scheduled_task") {
    return e.scopeType === "workspace"
      ? `/dashboard/w/${e.scopeId}?tab=operations`
      : e.listId
        ? `/dashboard/l/${e.listId}/settings`
        : null;
  }
  if (e.entityType === "workspace" && e.scopeType === "workspace") {
    return `/dashboard/w/${e.scopeId}?tab=settings`;
  }
  // A milestone has no page of its own — it lives on its project's
  // Overview, which is still the right landing spot after a delete.
  if (e.entityType === "milestone" && e.listId) {
    return `/dashboard/l/${e.listId}?view=overview`;
  }
  if (e.entityType === "list" && e.type !== "list.deleted") {
    return `/dashboard/l/${e.entityId}`;
  }
  // A project has no page of its own — it lives inside its Space, and a
  // deleted project's Space is still the right place to land.
  if (e.entityType === "project") {
    const p = (e.payload ?? {}) as { spaceId?: string };
    return p.spaceId ? `/dashboard/s/${p.spaceId}` : null;
  }
  return null;
}
