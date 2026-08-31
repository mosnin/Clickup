import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { canAccessSpace } from "./_authz";
import { getRollup } from "./rollups";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TIME_CAP_PER_ACTOR = 200;

// Workspace Reports tab. Status totals come from maintained listRollups
// (written in the task *Core paths). Time is ranged per member, not joined
// per task. Completed-this-week is counted from the activity log. A grown
// workspace must not time out this query.

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

    const lists: { _id: Id<"lists">; name: string }[] = [];
    for (const space of spaces) {
      if (space.archivedAt !== undefined) continue;
      if (!(await canAccessSpace(ctx, space, identity))) continue;

      const directLists = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();
      lists.push(...directLists);

      const projects = await ctx.db
        .query("projects")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      for (const project of projects) {
        const projectLists = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "project").eq("parentId", project._id),
          )
          .collect();
        lists.push(...projectLists);
      }
    }

    let openTaskCount = 0;
    let inProgressTaskCount = 0;
    let doneTaskCount = 0;
    let totalTasks = 0;
    const taskCountByList: { listId: Id<"lists">; name: string; count: number }[] =
      [];

    for (const list of lists) {
      const rollup = await getRollup(ctx, list._id);
      if (!rollup) continue;
      const open = Math.max(0, rollup.total - rollup.done - rollup.inProgress);
      openTaskCount += open;
      inProgressTaskCount += rollup.inProgress;
      doneTaskCount += rollup.done;
      totalTasks += rollup.total;
      const remaining = rollup.total - rollup.done;
      if (remaining > 0) {
        taskCountByList.push({
          listId: list._id,
          name: list.name,
          count: remaining,
        });
      }
    }

    const recentEvents = await ctx.db
      .query("events")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", "workspace").eq("scopeId", workspaceId),
      )
      .order("desc")
      .take(200);
    const completedThisWeek = recentEvents.filter(
      (e) => e.type === "task.completed" && e.createdAt >= since,
    ).length;

    const members = await ctx.db
      .query("memberships")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    const agents = await ctx.db
      .query("agents")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", workspaceId),
      )
      .collect();
    const actorIds = [
      ...members.map((m) => m.userClerkId),
      ...agents.map((a) => a._id as string),
    ];

    let timeTrackedThisWeekMs = 0;
    const timeByUser = new Map<string, number>();
    for (const actorId of actorIds) {
      const entries = await ctx.db
        .query("timeEntries")
        .withIndex("by_user_started", (q) =>
          q.eq("userClerkId", actorId).gte("startedAt", since),
        )
        .take(TIME_CAP_PER_ACTOR);
      for (const e of entries) {
        const ended = e.endedAt ?? Date.now();
        const start = Math.max(e.startedAt, since);
        const duration = Math.max(0, ended - start);
        if (duration === 0) continue;
        timeTrackedThisWeekMs += duration;
        timeByUser.set(actorId, (timeByUser.get(actorId) ?? 0) + duration);
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
        total: totalTasks,
        done: doneTaskCount,
      },
      // Kept for the existing widget; counts are open work per list (from
      // rollups) rather than a full-tree assignee walk.
      taskCountByAssignee: taskCountByList.map((row) => ({
        clerkId: row.listId,
        count: row.count,
        label: row.name,
      })),
      timeTrackedThisWeekMs,
      timeByUser: Array.from(timeByUser.entries()).map(([clerkId, ms]) => ({
        clerkId,
        ms,
      })),
      goals: {
        open: openGoals,
        complete: completeGoals,
        total: goals.length,
        avgProgress: goalAvgProgress,
      },
    };
  },
});
