import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireIdentity } from "./_authz";

// Workspace data export — portability + compliance. An owner/admin can
// export their workspace's structure and task data as a single JSON
// document (downloaded client-side). Secrets are never included: no API
// keys, webhook secrets, or embeddings. Bounded to the workspace's own
// spaces → folders → lists → tasks, plus sprints and agent metadata.

export const exportWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const identity = await requireIdentity(ctx);
    const workspace = await ctx.db.get(workspaceId);
    if (!workspace) throw new Error("Workspace not found");
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
      )
      .unique();
    if (!membership || membership.role === "member") {
      throw new Error("Only workspace owners and admins can export data");
    }

    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", workspaceId),
      )
      .collect();

    async function tasksForList(listId: Id<"lists">) {
      const statuses = await ctx.db
        .query("listStatuses")
        .withIndex("by_list", (q) => q.eq("listId", listId))
        .collect();
      const statusName = new Map(statuses.map((s) => [s._id, s.name]));
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_list", (q) => q.eq("listId", listId))
        .collect();
      return tasks.map((t) => ({
        title: t.title,
        description: t.description,
        status: statusName.get(t.statusId) ?? "",
        priority: t.priority,
        startDate: t.startDate,
        dueDate: t.dueDate,
        assignees: t.assigneeClerkIds,
        checklist: t.checklist,
        completedAt: t.completedAt,
        createdAt: t.createdAt,
      }));
    }

    async function listNode(list: {
      _id: Id<"lists">;
      name: string;
    }) {
      return { name: list.name, tasks: await tasksForList(list._id) };
    }

    const spaceNodes = [];
    for (const space of spaces) {
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      const folderNodes = [];
      for (const folder of folders) {
        const lists = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "folder").eq("parentId", folder._id),
          )
          .collect();
        folderNodes.push({
          name: folder.name,
          lists: await Promise.all(lists.map(listNode)),
        });
      }
      const directLists = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();
      spaceNodes.push({
        name: space.name,
        folders: folderNodes,
        lists: await Promise.all(directLists.map(listNode)),
      });
    }

    const sprints = await ctx.db
      .query("sprints")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();

    const agents = await ctx.db
      .query("agents")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", workspaceId),
      )
      .collect();

    return {
      exportedAt: Date.now(),
      apiVersion: 1,
      workspace: { name: workspace.name, slug: workspace.slug },
      spaces: spaceNodes,
      sprints: sprints.map((s) => ({
        name: s.name,
        goal: s.goal,
        startDate: s.startDate,
        endDate: s.endDate,
        status: s.status,
      })),
      agents: agents.map((a) => ({
        name: a.name,
        role: a.role ?? "member",
        status: a.status,
        dailyActionLimit: a.dailyActionLimit,
      })),
    };
  },
});
