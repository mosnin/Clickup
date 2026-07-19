"use client";

import type { Doc, Id } from "@convex/_generated/dataModel";
import { EmptyState } from "@/components/dashboard/empty-state";

// Phase F stub — dependency network diagram for a list, drawn from
// tasks.blockedByTaskIds. Implemented by the network-diagram workstream.

export function NetworkView(props: {
  listId: Id<"lists">;
  tasks: Doc<"tasks">[];
  statuses: Doc<"listStatuses">[];
}) {
  void props;
  return (
    <EmptyState
      title="Network view is being assembled"
      message="Dependencies between tasks will render here as a graph."
    />
  );
}
