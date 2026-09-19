"use client";

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";

export type SidebarTree = NonNullable<ReturnType<typeof useTreeQuery>>;

export function useTreeQuery() {
  return useQuery(api.sidebar.tree, {});
}

// `wb` before `w` so `/dashboard/wb/:id` is not cut at `w`.
const CONTENT_ID_RE = /^\/dashboard\/(?:wb|w|s|l|d|p)\/([^/]+)/;

export type WorkspaceContext =
  | { kind: "workspace"; workspace: SidebarTree["workspaces"][number] }
  | { kind: "personal" };

/**
 * Whose work this URL is standing in.
 *
 * Content-derived: any /dashboard/w|s|l|d|wb|p/[id] resolves against the
 * tree so the top-bar switcher and the spaces rail stay pinned to the same
 * workspace. There is no separate client-side "selected workspace" state.
 */
export function useCurrentContext(tree: SidebarTree | null | undefined): WorkspaceContext {
  const pathname = usePathname();
  const id = CONTENT_ID_RE.exec(pathname)?.[1];

  const idToWorkspace = useMemo(() => {
    const map = new Map<string, SidebarTree["workspaces"][number]>();
    for (const workspace of tree?.workspaces ?? []) {
      map.set(workspace._id, workspace);
      for (const space of workspace.spaces) {
        map.set(space._id, workspace);
        for (const list of space.lists) map.set(list._id, workspace);
        for (const page of space.pages) map.set(page._id, workspace);
        for (const wb of space.whiteboards) map.set(wb._id, workspace);
        for (const project of space.projects) {
          map.set(project._id, workspace);
          for (const list of project.lists) map.set(list._id, workspace);
        }
      }
    }
    return map;
  }, [tree]);

  const workspace = id ? idToWorkspace.get(id) : undefined;
  if (workspace) return { kind: "workspace", workspace };
  return { kind: "personal" };
}
