import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireIdentity, requireTaskAccess } from "./_authz";
import {
  assertValueReferences,
  computeDerivedValues,
  fieldValueArgs,
  isComputedType,
  normalizeFieldValue,
} from "./_customFields";

// `taskFieldValues` rows are sparse: only present when a task has a value
// set for a given custom field. Setting a value upserts; clearing (or
// setting an empty value) deletes the row.
//
// Every write is validated against its field's type and config by
// normalizeFieldValue() in _customFields.ts — the same function the agent
// API calls — so "set a rating to 9 on a 5-star field" is refused with the
// same message whether it came from a human's click or an MCP tool call.

export const listForTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    try {
      await requireTaskAccess(ctx, taskId);
    } catch {
      return [];
    }
    return await ctx.db
      .query("taskFieldValues")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .collect();
  },
});

/**
 * The derived numbers for one task: formula results, rollup results, and
 * vote counts. Separate from listForTask because computed fields have no
 * stored row — callers merge the two by fieldId.
 */
export const computedForTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    let task;
    try {
      ({ task } = await requireTaskAccess(ctx, taskId));
    } catch {
      return [];
    }
    const fields = await ctx.db
      .query("customFields")
      .withIndex("by_list", (q) => q.eq("listId", task.listId))
      .collect();
    if (!fields.some((f) => isComputedType(f.type) || f.type === "voting")) {
      return [];
    }
    const values = await ctx.db
      .query("taskFieldValues")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .collect();
    return await computeDerivedValues(ctx, task, fields, values);
  },
});

/** Download URLs for the files stored on one `files` field. */
export const fileUrls = query({
  args: { taskId: v.id("tasks"), fieldId: v.id("customFields") },
  handler: async (ctx, { taskId, fieldId }) => {
    try {
      await requireTaskAccess(ctx, taskId);
    } catch {
      return [];
    }
    const row = await ctx.db
      .query("taskFieldValues")
      .withIndex("by_task_and_field", (q) =>
        q.eq("taskId", taskId).eq("fieldId", fieldId),
      )
      .unique();
    return await Promise.all(
      (row?.files ?? []).map(async (f) => ({
        storageId: f.storageId,
        name: f.name,
        mimeType: f.mimeType,
        sizeBytes: f.sizeBytes,
        url: await ctx.storage.getUrl(f.storageId),
      })),
    );
  },
});

/** Short-lived upload URL for a `files` custom field, same as attachments. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireIdentity(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const set = mutation({
  args: {
    taskId: v.id("tasks"),
    fieldId: v.id("customFields"),
    ...fieldValueArgs,
  },
  handler: async (ctx, args) => {
    const { task, identity } = await requireTaskAccess(ctx, args.taskId);
    const field = await ctx.db.get(args.fieldId);
    if (!field) throw new ConvexError("Field not found");
    if (field.listId !== task.listId) {
      throw new ConvexError("Field does not belong to this task's list");
    }

    const existing = await ctx.db
      .query("taskFieldValues")
      .withIndex("by_task_and_field", (q) =>
        q.eq("taskId", args.taskId).eq("fieldId", args.fieldId),
      )
      .unique();

    const patch = normalizeFieldValue(field, args, {
      voterId: identity.subject,
      existing,
    });

    if (patch === null) {
      if (existing) await ctx.db.delete(existing._id);
      return null;
    }
    await assertValueReferences(ctx, field, patch);
    for (const linkedId of patch.taskIds ?? []) {
      await requireTaskAccess(ctx, linkedId);
    }

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
    const { identity } = await requireTaskAccess(ctx, taskId);
    const existing = await ctx.db
      .query("taskFieldValues")
      .withIndex("by_task_and_field", (q) =>
        q.eq("taskId", taskId).eq("fieldId", fieldId),
      )
      .unique();
    if (!existing) return;

    // Clearing a voting field removes only YOUR vote — one principal can't
    // wipe everyone else's.
    const field = await ctx.db.get(fieldId);
    if (field?.type === "voting") {
      const kept = (existing.actorIds ?? []).filter(
        (id) => id !== identity.subject,
      );
      if (kept.length > 0) {
        await ctx.db.patch(existing._id, { actorIds: kept });
        return;
      }
    }
    await ctx.db.delete(existing._id);
  },
});
