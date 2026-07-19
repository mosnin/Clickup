"use client";

import type { Id } from "@convex/_generated/dataModel";

// Phase F stub — sprint-scoped scrum board: tasks from every list in the
// sprint arranged in category columns (To do / In progress / Done /
// Closed) with optional swimlanes. Implemented by the scrum-board
// workstream.

export function ScrumBoard(props: {
  sprintId: Id<"sprints">;
  workspaceId: Id<"workspaces">;
}) {
  void props;
  return null;
}
