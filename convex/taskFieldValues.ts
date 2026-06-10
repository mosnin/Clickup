import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTaskAccess } from "./_authz";

// `taskFieldValues` rows are sparse: only present when a task has a value
// set for a given custom field. Setting a value upserts; clearing deletes
// the row.

export const listForTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    return await ctx.db
      .query("taskFieldValues")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .collect();
  },
});

export const set = mutation({
  args: {
    taskId: v.id("tasks"),
    fieldId: v.id("customFields"),
    textValue: v.optional(v.string()),
    numberValue: v.optional(v.number()),
    booleanValue: v.optional(v.boolean()),
    dateValue: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { task } = await requireTaskAccess(ctx, args.taskId);
    const field = await ctx.db.get(args.fieldId);
    if (!field) throw new Error("Field not found");
    if (field.listId !== task.listId) {
      throw new Error("Field does not belong to this task's list");
    }

    const existing = await ctx.db
      .query("taskFieldValues")
      .withIndex("by_task_and_field", (q) =>
        q.eq("taskId", args.taskId).eq("fieldId", args.fieldId),
      )
      .unique();

    const patch = {
      textValue: args.textValue,
      numberValue: args.numberValue,
      booleanValue: args.booleanValue,
      dateValue: args.dateValue,
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("taskFieldValues", {
      taskId: args.taskId,
      fieldId: args.fieldId,
      ...patch,
    });
  },
});

export const clear = mutation({
  args: { taskId: v.id("tasks"), fieldId: v.id("customFields") },
  handler: async (ctx, { taskId, fieldId }) => {
    await requireTaskAccess(ctx, taskId);
    const existing = await ctx.db
      .query("taskFieldValues")
      .withIndex("by_task_and_field", (q) =>
        q.eq("taskId", taskId).eq("fieldId", fieldId),
      )
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
