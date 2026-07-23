import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { canAccessSpace, requireIdentity, requireTaskAccess } from "./_authz";
import { updateTaskCore } from "./tasks";
import { userActor } from "./events";

// Sprint planning: a two-pane workspace-backlog vs. committed-tasks view
// with a story-point capacity bar. Backed by the same `tasks.sprintId` /
// `tasks.estimatePoints` columns the scrum board and Gantt read, so
// committing/uncommitting here is just a `tasks.sprintId` patch routed
// through `updateTaskCore` — automations, events, and notifications stay
// identical to every other task write path.

async function requireWorkspaceMember(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<string> {
  const identity = await requireIdentity(ctx);
  const member = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
    )
    .unique();
  if (!member) throw new Error("Forbidden");
  return identity.subject;
}

const MAX_BACKLOG = 300;

export type PlanningTask = {
  taskId: Id<"tasks">;
  title: string;
  listId: Id<"lists">;
  listName: string;
  priority: "urgent" | "high" | "normal" | "low" | undefined;
  estimatePoints: number | undefined;
  statusCategory: "open" | "in_progress" | "complete" | "closed";
  assigneeIds: string[];
  sprintId: Id<"sprints"> | undefined;
  sprintName: string | undefined;
};

async function toPlanningTask(
  ctx: QueryCtx | MutationCtx,
  task: Doc<"tasks">,
  listNameCache: Map<Id<"lists">, string>,
  sprintNameCache: Map<Id<"sprints">, string>,
): Promise<PlanningTask> {
  const status = await ctx.db.get(task.statusId);
  let listName = listNameCache.get(task.listId);
  if (listName === undefined) {
    const list = await ctx.db.get(task.listId);
    listName = list?.name ?? "?";
    listNameCache.set(task.listId, listName);
  }
  let sprintName: string | undefined;
  if (task.sprintId) {
    sprintName = sprintNameCache.get(task.sprintId);
    if (sprintName === undefined) {
      const sprint = await ctx.db.get(task.sprintId);
      sprintName = sprint?.name;
      if (sprintName) sprintNameCache.set(task.sprintId, sprintName);
    }
  }
  return {
    taskId: task._id,
    title: task.title,
    listId: task.listId,
    listName,
    priority: task.priority,
    estimatePoints: task.estimatePoints,
    statusCategory: status?.category ?? "open",
    assigneeIds: task.assigneeClerkIds,
    sprintId: task.sprintId,
    sprintName,
  };
}

// Backlog + committed tasks for one sprint's planning board, plus capacity
// totals. Mirrors sprints.addableTasks' workspace-tree walk but returns
// the richer row shape the planning UI needs (list name, priority,
// estimate, assignees) instead of just an id/title pair, and also
// surfaces tasks already committed to a *different* sprint (tagged with
// their sprintName) rather than silently excluding them.
export const planning = query({
  args: { sprintId: v.id("sprints") },
  handler: async (ctx, { sprintId }) => {
    const sprint = await ctx.db.get(sprintId);
    if (!sprint) return null;
    let subject: string;
    try {
      subject = await requireWorkspaceMember(ctx, sprint.workspaceId);
    } catch {
      return null;
    }

    const listNameCache = new Map<Id<"lists">, string>();
    const sprintNameCache = new Map<Id<"sprints">, string>();

    // Per-viewer space gate: tasks in a private space the caller can't
    // access must not surface here (title leak), even though the caller
    // is a workspace member. Cached per space; committed tasks resolve
    // their space through the list's parent chain.
    const spaceOkCache = new Map<Id<"spaces">, boolean>();
    async function spaceVisible(spaceId: Id<"spaces">): Promise<boolean> {
      const cached = spaceOkCache.get(spaceId);
      if (cached !== undefined) return cached;
      const space = await ctx.db.get(spaceId);
      const ok =
        !!space &&
        space.archivedAt === undefined &&
        (await canAccessSpace(ctx, space, { subject }));
      spaceOkCache.set(spaceId, ok);
      return ok;
    }
    const listSpaceCache = new Map<Id<"lists">, Id<"spaces"> | null>();
    async function taskListVisible(listId: Id<"lists">): Promise<boolean> {
      let spaceId = listSpaceCache.get(listId);
      if (spaceId === undefined) {
        const list = await ctx.db.get(listId);
        if (!list) spaceId = null;
        else if (list.parentType === "space") {
          spaceId = list.parentId as Id<"spaces">;
        } else {
          const folder = await ctx.db.get(list.parentId as Id<"folders">);
          spaceId = folder ? folder.spaceId : null;
        }
        listSpaceCache.set(listId, spaceId);
      }
      return spaceId !== null && (await spaceVisible(spaceId));
    }

    const committedTasks = await ctx.db
      .query("tasks")
      .withIndex("by_sprint", (q) => q.eq("sprintId", sprintId))
      .collect();
    const committed: PlanningTask[] = [];
    let committedPoints = 0;
    let committedUnestimated = 0;
    for (const t of committedTasks) {
      if (!(await taskListVisible(t.listId))) continue;
      const row = await toPlanningTask(ctx, t, listNameCache, sprintNameCache);
      committed.push(row);
      if (typeof t.estimatePoints === "number") {
        committedPoints += t.estimatePoints;
      } else {
        committedUnestimated++;
      }
    }

    const backlog: PlanningTask[] = [];
    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", sprint.workspaceId),
      )
      .collect();
    outer: for (const space of spaces) {
      if (!(await spaceVisible(space._id))) continue;
      const parents: { type: "space" | "folder"; id: string }[] = [
        { type: "space", id: space._id },
      ];
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      for (const f of folders) parents.push({ type: "folder", id: f._id });
      for (const p of parents) {
        const lists = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", p.type).eq("parentId", p.id),
          )
          .collect();
        for (const l of lists) {
          const tasks = await ctx.db
            .query("tasks")
            .withIndex("by_list", (q) => q.eq("listId", l._id))
            .collect();
          for (const t of tasks) {
            if (t.sprintId === sprintId) continue;
            const status = await ctx.db.get(t.statusId);
            if (
              status?.category === "complete" ||
              status?.category === "closed"
            ) {
              continue;
            }
            backlog.push(
              await toPlanningTask(ctx, t, listNameCache, sprintNameCache),
            );
            if (backlog.length >= MAX_BACKLOG) break outer;
          }
        }
      }
    }

    return {
      sprint,
      committed,
      backlog,
      committedPoints,
      committedUnestimated,
      capacityPoints: sprint.capacityPoints,
    };
  },
});

export const commit = mutation({
  args: { sprintId: v.id("sprints"), taskId: v.id("tasks") },
  handler: async (ctx, { sprintId, taskId }) => {
    const { identity } = await requireTaskAccess(ctx, taskId);
    const actor = await userActor(ctx, identity.subject);
    await updateTaskCore(ctx, { taskId, sprintId }, actor);
  },
});

export const uncommit = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const { identity } = await requireTaskAccess(ctx, taskId);
    const actor = await userActor(ctx, identity.subject);
    await updateTaskCore(ctx, { taskId, sprintId: null }, actor);
  },
});

export const setEstimate = mutation({
  args: { taskId: v.id("tasks"), points: v.union(v.number(), v.null()) },
  handler: async (ctx, { taskId, points }) => {
    const { identity } = await requireTaskAccess(ctx, taskId);
    const actor = await userActor(ctx, identity.subject);
    await updateTaskCore(ctx, { taskId, estimatePoints: points }, actor);
  },
});

// Points-based velocity for the last (up to) 5 completed sprints in a
// workspace, oldest first — complements sprints.velocity's task-count
// series with a story-point one for teams that estimate.
export const velocityPoints = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    try {
      await requireWorkspaceMember(ctx, workspaceId);
    } catch {
      return [];
    }
    const sprints = await ctx.db
      .query("sprints")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    const recent = sprints
      .filter((s) => s.status === "complete")
      .sort((a, b) => b.endDate - a.endDate)
      .slice(0, 5);

    const out: {
      sprintId: Id<"sprints">;
      name: string;
      completedPoints: number;
      completedCount: number;
    }[] = [];
    for (const s of recent) {
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_sprint", (q) => q.eq("sprintId", s._id))
        .collect();
      let completedPoints = 0;
      let completedCount = 0;
      for (const t of tasks) {
        const status = await ctx.db.get(t.statusId);
        if (status?.category === "complete" || status?.category === "closed") {
          completedCount++;
          completedPoints += t.estimatePoints ?? 0;
        }
      }
      out.push({ sprintId: s._id, name: s.name, completedPoints, completedCount });
    }
    return out.reverse();
  },
});
