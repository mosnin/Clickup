import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity, requireListAccess } from "./_authz";
import type { Actor } from "./_agentAuth";
import { emitEvent, scopeForList, userActor } from "./events";

// Sprints: workspace-level timeboxes that tasks from any list in the
// workspace can be pulled into (tasks.sprintId). Status flows
// planned → active → complete; each transition emits an event so agents
// subscribed to sprint.* webhooks can kick off planning/retro playbooks.

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

async function emitSprintEvent(
  ctx: MutationCtx,
  sprint: Doc<"sprints">,
  type: string,
  actor: Actor,
  payload?: unknown,
): Promise<void> {
  await emitEvent(ctx, {
    scopeType: "workspace",
    scopeId: sprint.workspaceId,
    type,
    actor,
    entityType: "sprint",
    entityId: sprint._id,
    entityTitle: sprint.name,
    payload,
  });
}

// ── Cores (shared with the agent API) ──────────────────────────────────

export async function createSprintCore(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    name: string;
    goal?: string;
    startDate: number;
    endDate: number;
  },
  actor: Actor,
): Promise<Id<"sprints">> {
  if (!args.name.trim()) throw new Error("Sprint name is required");
  if (args.endDate <= args.startDate) {
    throw new Error("Sprint must end after it starts");
  }
  const sprintId = await ctx.db.insert("sprints", {
    workspaceId: args.workspaceId,
    name: args.name.trim(),
    goal: args.goal,
    startDate: args.startDate,
    endDate: args.endDate,
    status: "planned",
    createdByActorId: actor.id,
    createdAt: Date.now(),
  });
  const sprint = (await ctx.db.get(sprintId))!;
  await emitSprintEvent(ctx, sprint, "sprint.created", actor);
  return sprintId;
}

export async function updateSprintCore(
  ctx: MutationCtx,
  args: {
    sprintId: Id<"sprints">;
    name?: string;
    goal?: string;
    startDate?: number;
    endDate?: number;
    status?: "planned" | "active" | "complete";
  },
  actor: Actor,
): Promise<void> {
  const sprint = await ctx.db.get(args.sprintId);
  if (!sprint) throw new Error("Sprint not found");
  const patch: Record<string, unknown> = {};
  if (args.name !== undefined && args.name.trim()) patch.name = args.name;
  if (args.goal !== undefined) patch.goal = args.goal;
  if (args.startDate !== undefined) patch.startDate = args.startDate;
  if (args.endDate !== undefined) patch.endDate = args.endDate;
  if (args.status !== undefined) patch.status = args.status;
  await ctx.db.patch(args.sprintId, patch);
  const updated = (await ctx.db.get(args.sprintId))!;
  if (args.status !== undefined && args.status !== sprint.status) {
    const type =
      args.status === "active"
        ? "sprint.started"
        : args.status === "complete"
          ? "sprint.completed"
          : "sprint.updated";
    await emitSprintEvent(ctx, updated, type, actor);
  } else if (Object.keys(patch).length > 0) {
    await emitSprintEvent(ctx, updated, "sprint.updated", actor);
  }
}

// Task rollup for one sprint: totals by status category plus per-assignee
// counts. Cheap at our scale (walks the sprint's tasks once).
export async function sprintSummaryCore(
  ctx: QueryCtx | MutationCtx,
  sprintId: Id<"sprints">,
) {
  const sprint = await ctx.db.get(sprintId);
  if (!sprint) return null;
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_sprint", (q) => q.eq("sprintId", sprintId))
    .collect();
  let open = 0;
  let inProgress = 0;
  let done = 0;
  const byAssignee: Record<string, number> = {};
  const items = [];
  for (const t of tasks) {
    const status = await ctx.db.get(t.statusId);
    const category = status?.category ?? "open";
    if (category === "complete" || category === "closed") done++;
    else if (category === "in_progress") inProgress++;
    else open++;
    for (const a of t.assigneeClerkIds) {
      byAssignee[a] = (byAssignee[a] ?? 0) + 1;
    }
    items.push({
      _id: t._id,
      title: t.title,
      listId: t.listId,
      statusName: status?.name ?? "?",
      statusCategory: category,
      assigneeIds: t.assigneeClerkIds,
      dueDate: t.dueDate,
      priority: t.priority,
    });
  }
  return {
    sprint,
    totals: { total: tasks.length, open, inProgress, done },
    byAssignee,
    tasks: items,
  };
}

// ── Clerk-authenticated API ────────────────────────────────────────────

export const listForWorkspace = query({
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
    const withCounts = [];
    for (const s of sprints.sort((a, b) => b.startDate - a.startDate)) {
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_sprint", (q) => q.eq("sprintId", s._id))
        .collect();
      let done = 0;
      for (const t of tasks) {
        const status = await ctx.db.get(t.statusId);
        if (status?.category === "complete" || status?.category === "closed") {
          done++;
        }
      }
      withCounts.push({ ...s, taskCount: tasks.length, doneCount: done });
    }
    return withCounts;
  },
});

// Sprints available to tasks on this list (empty for personal-space
// lists — sprints are workspace-level). Powers the Sprint select on the
// task detail page without the page needing to know the workspace.
export const listForList = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    let list;
    try {
      ({ list } = await requireListAccess(ctx, listId));
    } catch {
      return [];
    }
    const scope = await scopeForList(ctx, list);
    if (!scope || scope.scopeType !== "workspace") return [];
    const sprints = await ctx.db
      .query("sprints")
      .withIndex("by_workspace", (q) =>
        q.eq("workspaceId", scope.scopeId as Id<"workspaces">),
      )
      .collect();
    return sprints
      .filter((s) => s.status !== "complete")
      .sort((a, b) => b.startDate - a.startDate)
      .map((s) => ({ _id: s._id, name: s.name, status: s.status }));
  },
});

// Open tasks in the workspace not yet in this sprint, for the sprint
// card's "+ Add task" picker. Walks the workspace tree (reports-style).
export const addableTasks = query({
  args: { sprintId: v.id("sprints") },
  handler: async (ctx, { sprintId }) => {
    const sprint = await ctx.db.get(sprintId);
    if (!sprint) return [];
    try {
      await requireWorkspaceMember(ctx, sprint.workspaceId);
    } catch {
      return [];
    }
    const out: { taskId: Id<"tasks">; title: string }[] = [];
    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", sprint.workspaceId),
      )
      .collect();
    for (const space of spaces) {
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
            out.push({ taskId: t._id, title: t.title });
            if (out.length >= 200) return out;
          }
        }
      }
    }
    return out;
  },
});

export const summary = query({
  args: { sprintId: v.id("sprints") },
  handler: async (ctx, { sprintId }) => {
    const sprint = await ctx.db.get(sprintId);
    if (!sprint) return null;
    try {
      await requireWorkspaceMember(ctx, sprint.workspaceId);
    } catch {
      return null;
    }
    return await sprintSummaryCore(ctx, sprintId);
  },
});

export const create = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
    goal: v.optional(v.string()),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    const subject = await requireWorkspaceMember(ctx, args.workspaceId);
    const actor = await userActor(ctx, subject);
    return await createSprintCore(ctx, args, actor);
  },
});

export const update = mutation({
  args: {
    sprintId: v.id("sprints"),
    name: v.optional(v.string()),
    goal: v.optional(v.string()),
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
    status: v.optional(
      v.union(
        v.literal("planned"),
        v.literal("active"),
        v.literal("complete"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const sprint = await ctx.db.get(args.sprintId);
    if (!sprint) throw new Error("Sprint not found");
    const subject = await requireWorkspaceMember(ctx, sprint.workspaceId);
    const actor = await userActor(ctx, subject);
    await updateSprintCore(ctx, args, actor);
  },
});

export const remove = mutation({
  args: { sprintId: v.id("sprints") },
  handler: async (ctx, { sprintId }) => {
    const sprint = await ctx.db.get(sprintId);
    if (!sprint) return;
    await requireWorkspaceMember(ctx, sprint.workspaceId);
    // Detach tasks rather than deleting them.
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_sprint", (q) => q.eq("sprintId", sprintId))
      .collect();
    for (const t of tasks) await ctx.db.patch(t._id, { sprintId: undefined });
    await ctx.db.delete(sprintId);
  },
});
