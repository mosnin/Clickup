import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireListAccess, requireTaskAccess } from "./_authz";
import { applyAutomations } from "./listAutomations";

const recurrenceValidator = v.union(
  v.literal("daily"),
  v.literal("weekly"),
  v.literal("monthly"),
);

function addRecurrence(ts: number, recurrence: "daily" | "weekly" | "monthly"): number {
  const d = new Date(ts);
  switch (recurrence) {
    case "daily":
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "monthly":
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
  }
  return d.getTime();
}

// When a recurring task is moved into a complete-category status, spawn
// the next instance on the same list with its dates advanced. The new
// task is open, retains the same priority/assignees/recurrence/etc., and
// is appended at the bottom of the list.
async function spawnRecurringInstance(
  ctx: MutationCtx,
  completedTask: Doc<"tasks">,
): Promise<void> {
  if (!completedTask.recurrence) return;

  const statuses = await ctx.db
    .query("listStatuses")
    .withIndex("by_list", (q) => q.eq("listId", completedTask.listId))
    .collect();
  const sorted = [...statuses].sort((a, b) => a.position - b.position);
  const openStatus = sorted.find((s) => s.category === "open") ?? sorted[0];
  if (!openStatus) return;

  const baseDue = completedTask.dueDate ?? Date.now();
  const newDue = addRecurrence(baseDue, completedTask.recurrence);
  const newStart = completedTask.startDate
    ? addRecurrence(completedTask.startDate, completedTask.recurrence)
    : undefined;

  const siblings = await ctx.db
    .query("tasks")
    .withIndex("by_list", (q) => q.eq("listId", completedTask.listId))
    .collect();

  await ctx.db.insert("tasks", {
    listId: completedTask.listId,
    title: completedTask.title,
    description: completedTask.description,
    statusId: openStatus._id,
    priority: completedTask.priority,
    startDate: newStart,
    dueDate: newDue,
    assigneeClerkIds: completedTask.assigneeClerkIds,
    parentTaskId: completedTask.parentTaskId,
    recurrence: completedTask.recurrence,
    createdByClerkId: completedTask.createdByClerkId,
    position: siblings.length,
    createdAt: Date.now(),
  });
}

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
    return await ctx.db.get(taskId);
  },
});

export const create = mutation({
  args: {
    listId: v.id("lists"),
    title: v.string(),
    description: v.optional(v.string()),
    statusId: v.optional(v.id("listStatuses")),
    priority: v.optional(priorityValidator),
    startDate: v.optional(v.number()),
    dueDate: v.optional(v.number()),
    assigneeClerkIds: v.optional(v.array(v.string())),
    parentTaskId: v.optional(v.id("tasks")),
    recurrence: v.optional(recurrenceValidator),
  },
  handler: async (ctx, args) => {
    const { identity } = await requireListAccess(ctx, args.listId);

    let statusId = args.statusId;
    if (!statusId) {
      const all = await ctx.db
        .query("listStatuses")
        .withIndex("by_list", (q) => q.eq("listId", args.listId))
        .collect();
      if (all.length === 0) {
        throw new Error("List has no statuses configured");
      }
      const sorted = [...all].sort((a, b) => a.position - b.position);
      statusId = (sorted.find((s) => s.category === "open") ?? sorted[0])._id;
    } else {
      const status = await ctx.db.get(statusId);
      if (!status || status.listId !== args.listId) {
        throw new Error("statusId must belong to the same list");
      }
    }

    const siblings = await ctx.db
      .query("tasks")
      .withIndex("by_list", (q) => q.eq("listId", args.listId))
      .collect();

    const taskId = await ctx.db.insert("tasks", {
      listId: args.listId,
      title: args.title,
      description: args.description,
      statusId,
      priority: args.priority,
      startDate: args.startDate,
      dueDate: args.dueDate,
      assigneeClerkIds: args.assigneeClerkIds ?? [],
      parentTaskId: args.parentTaskId,
      recurrence: args.recurrence,
      createdByClerkId: identity.subject,
      position: siblings.length,
      createdAt: Date.now(),
    });

    const created = await ctx.db.get(taskId);
    if (created) await applyAutomations(ctx, created, "task_created");

    return taskId;
  },
});

export const update = mutation({
  args: {
    taskId: v.id("tasks"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    statusId: v.optional(v.id("listStatuses")),
    priority: v.optional(priorityValidator),
    startDate: v.optional(v.union(v.number(), v.null())),
    dueDate: v.optional(v.union(v.number(), v.null())),
    assigneeClerkIds: v.optional(v.array(v.string())),
    recurrence: v.optional(v.union(recurrenceValidator, v.null())),
  },
  handler: async (ctx, args) => {
    const { task } = await requireTaskAccess(ctx, args.taskId);

    // Detect "transition into complete" before applying the patch so we
    // can run automations + spawn the recurring instance afterwards.
    const oldStatus = await ctx.db.get(task.statusId);
    const wasComplete =
      oldStatus?.category === "complete" || oldStatus?.category === "closed";

    let willBeComplete = wasComplete;
    if (args.statusId !== undefined && args.statusId !== task.statusId) {
      const newStatus = await ctx.db.get(args.statusId);
      if (!newStatus || newStatus.listId !== task.listId) {
        throw new Error("statusId must belong to the same list");
      }
      willBeComplete =
        newStatus.category === "complete" || newStatus.category === "closed";
    }

    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.description !== undefined) patch.description = args.description;
    if (args.statusId !== undefined) {
      patch.statusId = args.statusId;
      patch.completedAt = willBeComplete ? Date.now() : undefined;
    }
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.startDate !== undefined) {
      patch.startDate = args.startDate ?? undefined;
    }
    if (args.dueDate !== undefined) {
      patch.dueDate = args.dueDate ?? undefined;
    }
    if (args.assigneeClerkIds !== undefined) {
      patch.assigneeClerkIds = args.assigneeClerkIds;
    }
    if (args.recurrence !== undefined) {
      patch.recurrence = args.recurrence ?? undefined;
    }

    await ctx.db.patch(args.taskId, patch);

    if (!wasComplete && willBeComplete) {
      const updated = await ctx.db.get(args.taskId);
      if (updated) {
        await applyAutomations(ctx, updated, "status_changed_to_complete");
        await spawnRecurringInstance(ctx, updated);
      }
    }
  },
});

// Toggle convenience: flip task between its first "open" and first
// "complete" status. Used by the row-level checkbox in the list view so
// the UI doesn't need to know status IDs.
export const toggleComplete = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const { task, list } = await requireTaskAccess(ctx, taskId);
    const statuses = await ctx.db
      .query("listStatuses")
      .withIndex("by_list", (q) => q.eq("listId", list._id))
      .collect();
    const sorted = [...statuses].sort((a, b) => a.position - b.position);
    const current = await ctx.db.get(task.statusId);
    const isDone =
      current?.category === "complete" || current?.category === "closed";
    const next = isDone
      ? sorted.find((s) => s.category === "open") ?? sorted[0]
      : sorted.find((s) => s.category === "complete") ?? sorted[0];
    if (!next) return;
    await ctx.db.patch(taskId, {
      statusId: next._id,
      completedAt:
        next.category === "complete" || next.category === "closed"
          ? Date.now()
          : undefined,
    });
  },
});

// Bulk reorder used by Board drag-drop: each task in `orderedIds` gets
// `position = its index`. Optionally moves them all to a new status in the
// same call. All tasks must belong to the same list.
export const reorder = mutation({
  args: {
    listId: v.id("lists"),
    orderedIds: v.array(v.id("tasks")),
    statusId: v.optional(v.id("listStatuses")),
  },
  handler: async (ctx, { listId, orderedIds, statusId }) => {
    await requireListAccess(ctx, listId);
    if (statusId) {
      const status = await ctx.db.get(statusId);
      if (!status || status.listId !== listId) {
        throw new Error("statusId must belong to the same list");
      }
    }
    for (let i = 0; i < orderedIds.length; i++) {
      const task = await ctx.db.get(orderedIds[i]);
      if (!task || task.listId !== listId) continue;
      const patch: Record<string, unknown> = { position: i };
      if (statusId) {
        patch.statusId = statusId;
        const status = await ctx.db.get(statusId);
        if (status?.category === "complete" || status?.category === "closed") {
          patch.completedAt = Date.now();
        } else {
          patch.completedAt = undefined;
        }
      }
      await ctx.db.patch(orderedIds[i], patch);
    }
  },
});

export const remove = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return;
    await requireTaskAccess(ctx, taskId);

    const subtasks = await ctx.db
      .query("tasks")
      .withIndex("by_parent_task", (q) => q.eq("parentTaskId", taskId))
      .collect();
    for (const s of subtasks) {
      const sValues = await ctx.db
        .query("taskFieldValues")
        .withIndex("by_task", (q) => q.eq("taskId", s._id))
        .collect();
      for (const v of sValues) await ctx.db.delete(v._id);
      await ctx.db.delete(s._id);
    }

    const values = await ctx.db
      .query("taskFieldValues")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .collect();
    for (const v of values) await ctx.db.delete(v._id);

    await ctx.db.delete(taskId);
  },
});
