import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Teams Hub query: per-member workload + week stats + currently-running
// timer. Walks the workspace tree once and folds task and time data into
// per-user aggregates so the UI can render a single page without N+1
// queries from the client.
export const hub = query({
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

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    const users = await Promise.all(
      memberships.map(async (m) => {
        const u = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", m.userClerkId))
          .unique();
        return { membership: m, user: u };
      }),
    );

    // Walk workspace → spaces → (folders →) lists → tasks once.
    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", workspaceId),
      )
      .collect();
    const lists: Doc<"lists">[] = [];
    for (const space of spaces) {
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
        const folderLists = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "folder").eq("parentId", folder._id),
          )
          .collect();
        lists.push(...folderLists);
      }
    }

    const since = Date.now() - WEEK_MS;
    const open = new Map<string, number>();
    const completedThisWeek = new Map<string, number>();
    const allTaskIds: Id<"tasks">[] = [];

    for (const list of lists) {
      const statuses = await ctx.db
        .query("listStatuses")
        .withIndex("by_list", (q) => q.eq("listId", list._id))
        .collect();
      const cat = new Map(statuses.map((s) => [s._id, s.category]));
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_list", (q) => q.eq("listId", list._id))
        .collect();
      for (const t of tasks) {
        allTaskIds.push(t._id);
        const c = cat.get(t.statusId);
        for (const a of t.assigneeClerkIds) {
          if (c === "open" || c === "in_progress") {
            open.set(a, (open.get(a) ?? 0) + 1);
          } else if (
            (c === "complete" || c === "closed") &&
            t.completedAt &&
            t.completedAt >= since
          ) {
            completedThisWeek.set(a, (completedThisWeek.get(a) ?? 0) + 1);
          }
        }
      }
    }

    // Time tracked this week + currently-running timers, joined to tasks
    // in this workspace.
    const trackedMs = new Map<string, number>();
    const running = new Map<
      string,
      { taskId: Id<"tasks">; taskTitle: string; startedAt: number }
    >();
    for (const taskId of allTaskIds) {
      const entries = await ctx.db
        .query("timeEntries")
        .withIndex("by_task", (q) => q.eq("taskId", taskId))
        .collect();
      for (const e of entries) {
        const ended = e.endedAt ?? Date.now();
        if (ended >= since) {
          const start = Math.max(e.startedAt, since);
          trackedMs.set(
            e.userClerkId,
            (trackedMs.get(e.userClerkId) ?? 0) + Math.max(0, ended - start),
          );
        }
        if (e.endedAt === undefined && !running.has(e.userClerkId)) {
          const task = await ctx.db.get(taskId);
          if (task) {
            running.set(e.userClerkId, {
              taskId,
              taskTitle: task.title,
              startedAt: e.startedAt,
            });
          }
        }
      }
    }

    return users
      .filter((u): u is { membership: Doc<"memberships">; user: Doc<"users"> } =>
        u.user !== null,
      )
      .map(({ membership, user }) => ({
        clerkId: user.clerkId,
        name: user.name ?? user.email,
        email: user.email,
        imageUrl: user.imageUrl,
        role: membership.role,
        openTasks: open.get(user.clerkId) ?? 0,
        completedThisWeek: completedThisWeek.get(user.clerkId) ?? 0,
        trackedThisWeekMs: trackedMs.get(user.clerkId) ?? 0,
        running: running.get(user.clerkId) ?? null,
      }));
  },
});
