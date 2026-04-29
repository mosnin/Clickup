import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireListAccess } from "./_authz";

const statusValidator = v.union(
  v.literal("open"),
  v.literal("in_progress"),
  v.literal("complete"),
  v.literal("closed"),
);

const priorityValidator = v.union(
  v.literal("urgent"),
  v.literal("high"),
  v.literal("normal"),
  v.literal("low"),
);

export const listForList = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    // Soft-fail — sidebar/list page may render before access is verified.
    const list = await ctx.db.get(listId);
    if (!list) return [];
    return await ctx.db
      .query("tasks")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
  },
});

export const get = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const task = await ctx.db.get(taskId);
    if (!task) return null;
    // Best-effort — caller should also call list/get for full auth.
    return task;
  },
});

export const create = mutation({
  args: {
    listId: v.id("lists"),
    title: v.string(),
    description: v.optional(v.string()),
    priority: v.optional(priorityValidator),
    dueDate: v.optional(v.number()),
    assigneeClerkIds: v.optional(v.array(v.string())),
    parentTaskId: v.optional(v.id("tasks")),
  },
  handler: async (ctx, args) => {
    const { identity } = await requireListAccess(ctx, args.listId);

    const siblings = await ctx.db
      .query("tasks")
      .withIndex("by_list", (q) => q.eq("listId", args.listId))
      .collect();

    return await ctx.db.insert("tasks", {
      listId: args.listId,
      title: args.title,
      description: args.description,
      status: "open",
      priority: args.priority,
      dueDate: args.dueDate,
      assigneeClerkIds: args.assigneeClerkIds ?? [],
      parentTaskId: args.parentTaskId,
      createdByClerkId: identity.subject,
      position: siblings.length,
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    taskId: v.id("tasks"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(statusValidator),
    priority: v.optional(priorityValidator),
    dueDate: v.optional(v.union(v.number(), v.null())),
    assigneeClerkIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");
    await requireListAccess(ctx, task.listId);

    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.description !== undefined) patch.description = args.description;
    if (args.status !== undefined) {
      patch.status = args.status;
      patch.completedAt =
        args.status === "complete" || args.status === "closed"
          ? Date.now()
          : undefined;
    }
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.dueDate !== undefined) {
      patch.dueDate = args.dueDate ?? undefined;
    }
    if (args.assigneeClerkIds !== undefined) {
      patch.assigneeClerkIds = args.assigneeClerkIds;
    }

    await ctx.db.patch(args.taskId, patch);
  },
});

export const remove = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return;
    await requireListAccess(ctx, task.listId);

    // Cascade subtasks.
    const subtasks = await ctx.db
      .query("tasks")
      .withIndex("by_parent_task", (q) => q.eq("parentTaskId", taskId))
      .collect();
    for (const s of subtasks) await ctx.db.delete(s._id);
    await ctx.db.delete(taskId);
  },
});

