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
  },
  handler: async (ctx, { entryId, description, billable }) => {
    const identity = await requireIdentity(ctx);
    const entry = await ctx.db.get(entryId);
    if (!entry) throw new Error("Entry not found");
    if (entry.userClerkId !== identity.subject) {
      throw new Error("Only the owning user can edit this entry");
    }
    const patch: Record<string, unknown> = {};
    if (description !== undefined) patch.description = description;
    if (billable !== undefined) patch.billable = billable;
    await ctx.db.patch(entryId, patch);
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
