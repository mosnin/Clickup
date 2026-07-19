"use client";

import type { Id } from "@convex/_generated/dataModel";

// Phase F stub — sprint planning: workspace backlog on the left, the
// sprint's committed tasks on the right, with a story-point capacity bar.
// Implemented by the sprint-planning workstream.

export function SprintPlanning(props: {
  sprintId: Id<"sprints">;
  workspaceId: Id<"workspaces">;
}) {
  void props;
  return null;
}
