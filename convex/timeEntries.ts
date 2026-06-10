import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireIdentity, requireTaskAccess } from "./_authz";

export const listForTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const all = await ctx.db
      .query("timeEntries")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .collect();
    return all.sort((a, b) => b.startedAt - a.startedAt);
  },
});

// Currently-running entry for the calling user, if any. The sidebar's
// timer chip subscribes to this.
export const runningForCurrent = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const recent = await ctx.db
      .query("timeEntries")
      .withIndex("by_user_started", (q) =>
        q.eq("userClerkId", identity.subject),
      )
      .order("desc")
      .take(5);
    return recent.find((e) => e.endedAt === undefined) ?? null;
  },
});

// Start a new entry. Stops any running entry for the same user first so
// only one timer ever runs per user.
export const start = mutation({
  args: {
    taskId: v.id("tasks"),
    description: v.optional(v.string()),
    billable: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { identity } = await requireTaskAccess(ctx, args.taskId);

    const recent = await ctx.db
      .query("timeEntries")
      .withIndex("by_user_started", (q) =>
        q.eq("userClerkId", identity.subject),
      )
      .order("desc")
      .take(5);
    for (const e of recent) {
      if (e.endedAt === undefined) {
        const ended = Date.now();
        await ctx.db.patch(e._id, {
          endedAt: ended,
          durationMs: ended - e.startedAt,
        });
      }
    }

    return await ctx.db.insert("timeEntries", {
      taskId: args.taskId,
      userClerkId: identity.subject,
      startedAt: Date.now(),
      description: args.description,
      billable: args.billable ?? false,
      createdAt: Date.now(),
    });
  },
});

export const stop = mutation({
  args: { entryId: v.optional(v.id("timeEntries")) },
  handler: async (ctx, { entryId }) => {
    const identity = await requireIdentity(ctx);

    let entry;
    if (entryId) {
      entry = await ctx.db.get(entryId);
    } else {
      const recent = await ctx.db
        .query("timeEntries")
        .withIndex("by_user_started", (q) =>
          q.eq("userClerkId", identity.subject),
        )
        .order("desc")
        .take(5);
      entry = recent.find((e) => e.endedAt === undefined) ?? null;
    }
    if (!entry) return;
    if (entry.userClerkId !== identity.subject) {
      throw new Error("Only the owning user can stop this entry");
    }
    if (entry.endedAt !== undefined) return; // already stopped

    const ended = Date.now();
    await ctx.db.patch(entry._id, {
      endedAt: ended,
      durationMs: ended - entry.startedAt,
    });
  },
});

export const update = mutation({
  args: {
    entryId: v.id("timeEntries"),
    description: v.optional(v.string()),
    billable: v.optional(v.boolean()),
    // Allow shifting the entry on the timesheet. We accept startedAt
    // and endedAt independently so the form can patch one or both.
    // durationMs is derived; we recompute it whenever either bound
    // changes so the per-day totals query stays simple.
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { entryId, description, billable, startedAt, endedAt },
  ) => {
    const identity = await requireIdentity(ctx);
    const entry = await ctx.db.get(entryId);
    if (!entry) throw new Error("Entry not found");
    if (entry.userClerkId !== identity.subject) {
      throw new Error("Only the owning user can edit this entry");
    }
    const patch: Record<string, unknown> = {};
    if (description !== undefined) patch.description = description;
    if (billable !== undefined) patch.billable = billable;
    let nextStart = entry.startedAt;
    let nextEnd = entry.endedAt;
    if (startedAt !== undefined) {
      patch.startedAt = startedAt;
      nextStart = startedAt;
    }
    if (endedAt !== undefined) {
      patch.endedAt = endedAt;
      nextEnd = endedAt;
    }
    if (startedAt !== undefined || endedAt !== undefined) {
      if (nextEnd !== undefined) {
        if (nextEnd < nextStart) {
          throw new Error("End time must be after start time");
        }
        patch.durationMs = nextEnd - nextStart;
      }
    }
    await ctx.db.patch(entryId, patch);
  },
});

// Insert a completed time entry directly (no live timer). Used by the
// timesheet's "Add entry" form. Both bounds are required and the
// duration is computed server-side so we don't end up with mismatched
// rows that the reporting query has to reconcile.
export const manualCreate = mutation({
  args: {
    taskId: v.id("tasks"),
    startedAt: v.number(),
    endedAt: v.number(),
    description: v.optional(v.string()),
    billable: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { identity } = await requireTaskAccess(ctx, args.taskId);
    if (args.endedAt < args.startedAt) {
      throw new Error("End time must be after start time");
    }
    return await ctx.db.insert("timeEntries", {
      taskId: args.taskId,
      userClerkId: identity.subject,
      startedAt: args.startedAt,
      endedAt: args.endedAt,
      durationMs: args.endedAt - args.startedAt,
      description: args.description,
      billable: args.billable ?? false,
      createdAt: Date.now(),
    });
  },
});

// All entries for the calling user whose start falls inside [from, to).
// Returned with task title + listId resolved so the timesheet can
// render rows + deep-link without a per-row roundtrip. We index by
// (userClerkId, startedAt) so this is a range scan, not a full table
// walk.
export const listForUserInRange = query({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    if (to <= from) return [];
    const candidates = await ctx.db
      .query("timeEntries")
      .withIndex("by_user_started", (q) =>
        q.eq("userClerkId", identity.subject).gte("startedAt", from),
      )
      .collect();
    const inWindow = candidates.filter((e) => e.startedAt < to);

    const enriched = await Promise.all(
      inWindow.map(async (e) => {
        const task = await ctx.db.get(e.taskId);
        return {
          ...e,
          taskTitle: task?.title ?? "(deleted task)",
          listId: task?.listId ?? null,
          taskDeleted: !task || task.deletedAt !== undefined,
        };
      }),
    );
    return enriched.sort((a, b) => a.startedAt - b.startedAt);
  },
});

export const remove = mutation({
  args: { entryId: v.id("timeEntries") },
  handler: async (ctx, { entryId }) => {
    const identity = await requireIdentity(ctx);
    const entry = await ctx.db.get(entryId);
    if (!entry) return;
    if (entry.userClerkId !== identity.subject) {
      throw new Error("Only the owning user can delete this entry");
    }
    await ctx.db.delete(entryId);
  },
});
