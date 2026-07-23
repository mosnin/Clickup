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
  "channel.created": "opened channel",
  "goal.progress": "updated goal",
  "goal.completed": "completed goal",
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
  return null;
}
