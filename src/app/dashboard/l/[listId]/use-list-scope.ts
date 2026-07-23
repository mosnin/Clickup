"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

export type ListScope = { scopeType: "user" | "workspace"; scopeId: string };

// Resolve which scope (the user's personal space or one workspace) a list
// belongs to, client-side. Skills and task blueprints are scoped this way,
// but there's no dedicated resolver query — the already-subscribed sidebar
// tree contains every list the current user can see, so we walk it.
// Returns undefined while loading or when the list isn't in the tree.
export function useListScope(listId: Id<"lists">): ListScope | undefined {
  const tree = useQuery(api.sidebar.tree, {});
  return useMemo(() => {
    if (!tree) return undefined;
    const containsList = (space: {
      lists: { _id: Id<"lists"> }[];
      folders: { lists: { _id: Id<"lists"> }[] }[];
    }) =>
      space.lists.some((l) => l._id === listId) ||
      space.folders.some((f) => f.lists.some((l) => l._id === listId));
    if (tree.personal && containsList(tree.personal)) {
      return { scopeType: "user", scopeId: tree.currentClerkId };
    }
    for (const ws of tree.workspaces) {
      if (ws.spaces.some(containsList)) {
        return { scopeType: "workspace", scopeId: ws._id };
      }
    }
    return undefined;
  }, [tree, listId]);
}
