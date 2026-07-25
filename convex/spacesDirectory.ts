import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { canAccessSpace } from "./_authz";
import { getRollup } from "./rollups";

const MAX_ROWS = 200;

export type SpaceDirectoryRow = {
  spaceId: Id<"spaces">;
  name: string;
  description?: string;
  color?: string;
  private: boolean;
  workspaceName: string;
  position: number;
  createdAt: number;
  listCount: number;
  folderCount: number;
  docCount: number;
  whiteboardCount: number;
  totalTasks: number;
  completedTasks: number;
};

async function taskCounts(ctx: QueryCtx, listId: Id<"lists">) {
  const rollup = await getRollup(ctx, listId);
  if (rollup) return rollup;
  const [statuses, tasks] = await Promise.all([
    ctx.db
      .query("listStatuses")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect(),
    ctx.db
      .query("tasks")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect(),
  ]);
  const doneIds = new Set(
    statuses
      .filter(
        (status) =>
          status.category === "complete" || status.category === "closed",
      )
      .map((status) => status._id),
  );
  return {
    total: tasks.length,
    done: tasks.filter((task) => doneIds.has(task.statusId)).length,
  };
}

async function summarizeSpace(
  ctx: QueryCtx,
  space: Doc<"spaces">,
  workspaceName: string,
): Promise<SpaceDirectoryRow> {
  const folders = await ctx.db
    .query("folders")
    .withIndex("by_space", (q) => q.eq("spaceId", space._id))
    .collect();
  const directLists = await ctx.db
    .query("lists")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", "space").eq("parentId", space._id),
    )
    .collect();
  const nestedLists = (
    await Promise.all(
      folders.map((folder) =>
        ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "folder").eq("parentId", folder._id),
          )
          .collect(),
      ),
    )
  ).flat();
  const lists = [...directLists, ...nestedLists];
  const [docs, whiteboards, rollups] = await Promise.all([
    ctx.db
      .query("docs")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "space").eq("parentId", space._id),
      )
      .collect(),
    ctx.db
      .query("whiteboards")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "space").eq("parentId", space._id),
      )
      .collect(),
    Promise.all(lists.map((list) => taskCounts(ctx, list._id))),
  ]);
  return {
    spaceId: space._id,
    name: space.name,
    description: space.description,
    color: space.color,
    private: space.parentType === "user" || space.private === true,
    workspaceName,
    position: space.position,
    createdAt: space.createdAt,
    listCount: lists.length,
    folderCount: folders.length,
    docCount: docs.length,
    whiteboardCount: whiteboards.length,
    totalTasks: rollups.reduce((sum, rollup) => sum + rollup.total, 0),
    completedTasks: rollups.reduce(
      (sum, rollup) => sum + rollup.done,
      0,
    ),
  };
}

export const list = query({
  args: { search: v.optional(v.string()) },
  handler: async (
    ctx,
    { search },
  ): Promise<{ rows: SpaceDirectoryRow[]; totalCount: number }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { rows: [], totalCount: 0 };
    const candidates: { space: Doc<"spaces">; workspaceName: string }[] = [];
    const personal = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "user").eq("parentId", identity.subject),
      )
      .collect();
    for (const space of personal) {
      if (!space.archivedAt) candidates.push({ space, workspaceName: "Personal" });
    }

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .collect();
    for (const membership of memberships) {
      const workspace = await ctx.db.get(membership.workspaceId);
      if (!workspace) continue;
      const spaces = await ctx.db
        .query("spaces")
        .withIndex("by_parent", (q) =>
          q
            .eq("parentType", "workspace")
            .eq("parentId", membership.workspaceId),
        )
        .collect();
      for (const space of spaces) {
        if (
          !space.archivedAt &&
          (await canAccessSpace(ctx, space, { subject: identity.subject }))
        ) {
          candidates.push({ space, workspaceName: workspace.name });
        }
      }
    }

    const needle = search?.trim().toLowerCase();
    const visible = needle
      ? candidates.filter(({ space, workspaceName }) =>
          `${space.name} ${space.description ?? ""} ${workspaceName}`
            .toLowerCase()
            .includes(needle),
        )
      : candidates;
    const rows = await Promise.all(
      visible.slice(0, MAX_ROWS).map(({ space, workspaceName }) =>
        summarizeSpace(ctx, space, workspaceName),
      ),
    );
    rows.sort(
      (a, b) =>
        a.workspaceName.localeCompare(b.workspaceName) ||
        a.position - b.position ||
        a.name.localeCompare(b.name),
    );
    return { rows, totalCount: visible.length };
  },
});
