import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireListAccess } from "./_authz";

// Saved views: named presets of view + filters per list. Shared by everyone
// with access to the list; they encode navigation, not data, so any member
// can manage them.

const MAX_VIEWS_PER_LIST = 20;

export const listForList = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    try {
      await requireListAccess(ctx, listId);
    } catch {
      return [];
    }
    const rows = await ctx.db
      .query("savedViews")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  },
});

export const create = mutation({
  args: {
    listId: v.id("lists"),
    name: v.string(),
    view: v.union(
      v.literal("overview"),
      v.literal("list"),
      v.literal("board"),
      v.literal("table"),
      v.literal("calendar"),
      v.literal("gantt"),
      v.literal("timeline"),
      v.literal("workload"),
    ),
    flags: v.optional(v.string()),
    priority: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { identity } = await requireListAccess(ctx, args.listId);
    const name = args.name.trim().slice(0, 60);
    if (!name) throw new Error("Give the view a name");

    const existing = await ctx.db
      .query("savedViews")
      .withIndex("by_list", (q) => q.eq("listId", args.listId))
      .collect();
    if (existing.length >= MAX_VIEWS_PER_LIST) {
      throw new Error("This list already has the maximum number of saved views");
    }
    if (existing.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("A view with that name already exists");
    }

    return await ctx.db.insert("savedViews", {
      listId: args.listId,
      name,
      view: args.view,
      flags: args.flags,
      priority: args.priority,
      createdByClerkId: identity.subject,
      createdAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { savedViewId: v.id("savedViews") },
  handler: async (ctx, { savedViewId }) => {
    const row = await ctx.db.get(savedViewId);
    if (!row) return;
    await requireListAccess(ctx, row.listId);
    await ctx.db.delete(savedViewId);
  },
});
