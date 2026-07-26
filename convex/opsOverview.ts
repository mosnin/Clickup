import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { canAccessSpace, requireIdentity } from "./_authz";

// Ops rhythm (Phase L): one query that answers "is the machine actually
// running?" for a workspace — every recurring schedule and what it's
// produced lately, every routed list and whether work is piling up
// unassigned, and the overdue backlog. O(lists + schedules + tasks in the
// workspace), same scale story as reports.workspaceSummary.

const DAY_MS = 24 * 60 * 60 * 1000;

export const workspaceOps = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    let identity;
    try {
      identity = await requireIdentity(ctx);
    } catch {
      return null;
    }
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
      )
      .unique();
    if (!membership) return null;

    // Viewer-visible lists in the workspace.
    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", workspaceId),
      )
      .collect();
    const lists = [];
    for (const space of spaces) {
      if (space.archivedAt !== undefined) continue;
      if (!(await canAccessSpace(ctx, space, { subject: identity.subject }))) {
        continue;
      }
      const direct = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();
      lists.push(...direct);
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      for (const folder of folders) {
        const nested = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "folder").eq("parentId", folder._id),
          )
          .collect();
        lists.push(...nested);
      }
    }

    const now = Date.now();
    const weekAgo = now - 7 * DAY_MS;

    const schedules = [];
    const routedLists = [];
    let produced7d = 0;
    let producedDone7d = 0;
    let overdueOpen = 0;

    for (const list of lists) {
      const listSchedules = await ctx.db
        .query("scheduledTasks")
        .withIndex("by_list", (q) => q.eq("listId", list._id))
        .collect();
      for (const st of listSchedules) {
        let blueprintName: string | undefined;
        if (st.blueprintId) {
          blueprintName = (await ctx.db.get(st.blueprintId))?.name;
        }
        schedules.push({
          _id: st._id,
          listId: list._id,
          listName: list.name,
          title: st.title,
          cadence: st.cadence,
          dayOfWeek: st.dayOfWeek,
          dayOfMonth: st.dayOfMonth,
          hourUtc: st.hourUtc,
          nextRunAt: st.nextRunAt,
          lastRunAt: st.lastRunAt,
          enabled: st.enabled,
          blueprintName,
        });
      }

      // Every list gets scanned — the overdue count spans the workspace.
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_list", (q) => q.eq("listId", list._id))
        .collect();
      let openUnassigned = 0;
      for (const t of tasks) {
        const open = t.completedAt === undefined;
        if (open && t.dueDate !== undefined && t.dueDate < now) {
          overdueOpen += 1;
        }
        if (open && t.assigneeClerkIds.length === 0) openUnassigned += 1;
        if (t.createdByClerkId === "scheduler" && t.createdAt >= weekAgo) {
          produced7d += 1;
          if (!open) producedDone7d += 1;
        }
      }
      if (list.routing) {
        routedLists.push({
          listId: list._id,
          name: list.name,
          mode: list.routing.mode,
          assignees: list.routing.assigneeIds.length,
          openUnassigned,
        });
      }
    }

    schedules.sort((a, b) => a.nextRunAt - b.nextRunAt);
    return {
      schedules,
      routedLists,
      produced7d,
      producedDone7d,
      overdueOpen,
      listCount: lists.length,
    };
  },
});
