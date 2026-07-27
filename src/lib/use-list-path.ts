"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

// Space › Project › List breadcrumb for a list, resolved client-side from the
// sidebar tree the app is already subscribed to (the same trick as
// use-list-scope.ts — there's no dedicated path resolver query, and adding
// one would mean a second round-trip for data we already hold).
//
// Returns undefined while the tree loads or when the list isn't in it.

type ListNode = { _id: Id<"lists"> };
type ProjectNode = { name: string; lists: ListNode[] };
type SpaceNode = { name: string; projects: ProjectNode[]; lists: ListNode[] };

export function useListPath(listId: Id<"lists">): string[] | undefined {
  const tree = useQuery(api.sidebar.tree, {});
  return useMemo(() => {
    if (!tree) return undefined;

    const pathIn = (space: SpaceNode): string[] | null => {
      if (space.lists.some((l) => l._id === listId)) return [space.name];
      for (const project of space.projects) {
        if (project.lists.some((l) => l._id === listId)) {
          return [space.name, project.name];
        }
      }
      return null;
    };

    const spaces: SpaceNode[] = [
      ...(tree.personal ? [tree.personal as SpaceNode] : []),
      ...(tree.workspaces as { spaces: SpaceNode[] }[]).flatMap(
        (w) => w.spaces,
      ),
    ];
    for (const space of spaces) {
      const path = pathIn(space);
      if (path) return path;
    }
    return undefined;
  }, [tree, listId]);
}
