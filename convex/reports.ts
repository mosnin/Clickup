import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// One-shot aggregation behind the workspace Reports tab.
//
// Walks workspace -> spaces -> (folders ->) lists -> tasks. For each
// task it folds the open/complete counts and joins time entries into
// per-user totals for the last 7 days. This is O(tasks + entries) per
// workspace; fine for the sizes we're targeting in phase 6.
export const workspaceSummary = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const myMembership = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
      )
      .unique();
    if (!myMembership) return null;

    const since = Date.now() - WEEK_MS;

    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", workspaceId),
      )
      .collect();

    const lists: { _id: Id<"lists"> }[] = [];
    for (const space of spaces) {
      const directLists = (
        await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "space").eq("parentId", space._id),
          )
          .collect()
      ).filter((l) => !l.deletedAt);
      lists.push(...directLists);

      const folders = (
        await ctx.db
          .query("folders")
          .withIndex("by_space", (q) => q.eq("spaceId", space._id))
          .collect()
      ).filter((f) => !f.deletedAt);
      for (const folder of folders) {
        const folderLists = (
          await ctx.db
            .query("lists")
            .withIndex("by_parent", (q) =>
              q.eq("parentType", "folder").eq("parentId", folder._id),
            )
            .collect()
        ).filter((l) => !l.deletedAt);
        lists.push(...folderLists);
      }
    }

    let openTaskCount = 0;
    let inProgressTaskCount = 0;
    let completedThisWeek = 0;
    const taskCountByAssignee = new Map<string, number>();
    const allTasks: { _id: Id<"tasks"> }[] = [];

    for (const list of lists) {
      const statuses = await ctx.db
        .query("listStatuses")
        .withIndex("by_list", (q) => q.eq("listId", list._id))
        .collect();
      const statusCategoryById = new Map<Id<"listStatuses">, string>(
        statuses.map((s) => [s._id, s.category] as const),
      );

      const tasks = (
        await ctx.db
          .query("tasks")
          .withIndex("by_list", (q) => q.eq("listId", list._id))
          .collect()
      ).filter((t) => !t.deletedAt);
      for (const t of tasks) {
        allTasks.push({ _id: t._id });
        const cat = statusCategoryById.get(t.statusId);
        if (cat === "open") openTaskCount++;
        else if (cat === "in_progress") inProgressTaskCount++;
        if (
          (cat === "complete" || cat === "closed") &&
          t.completedAt &&
          t.completedAt >= since
        ) {
          completedThisWeek++;
        }
        for (const a of t.assigneeClerkIds) {
          taskCountByAssignee.set(a, (taskCountByAssignee.get(a) ?? 0) + 1);
        }
      }
    }

    // Time tracked this week, joined to workspace tasks.
    let timeTrackedThisWeekMs = 0;
    const timeByUser = new Map<string, number>();
    const taskIds = new Set(allTasks.map((t) => t._id));
    for (const taskId of taskIds) {
      const entries = await ctx.db
        .query("timeEntries")
        .withIndex("by_task", (q) => q.eq("taskId", taskId))
        .collect();
      for (const e of entries) {
        const ended = e.endedAt ?? Date.now();
        if (ended < since) continue;
        const start = Math.max(e.startedAt, since);
        const duration = Math.max(0, ended - start);
        timeTrackedThisWeekMs += duration;
        timeByUser.set(
          e.userClerkId,
          (timeByUser.get(e.userClerkId) ?? 0) + duration,
        );
      }
    }

    const goals = await ctx.db
      .query("goals")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", workspaceId),
      )
      .collect();
    const openGoals = goals.filter((g) => g.status === "open").length;
    const completeGoals = goals.filter((g) => g.status === "complete").length;
    const goalAvgProgress =
      goals.length === 0
        ? 0
        : goals.reduce((sum, g) => {
            const p =
              g.targetValue > 0
                ? Math.min(1, g.currentValue / g.targetValue)
                : 0;
            return sum + p;
          }, 0) / goals.length;

    return {
      workspaceId,
      taskCounts: {
        open: openTaskCount,
        inProgress: inProgressTaskCount,
        completedThisWeek,
        total: allTasks.length,
      },
      taskCountByAssignee: Array.from(taskCountByAssignee.entries()).map(
        ([clerkId, count]) => ({ clerkId, count }),
      ),
      timeTrackedThisWeekMs,
      timeByUser: Array.from(timeByUser.entries()).map(
        ([clerkId, ms]) => ({ clerkId, ms }),
      ),
      goals: {
        open: openGoals,
        complete: completeGoals,
        total: goals.length,
        avgProgress: goalAvgProgress,
      },
    };
  },
});
