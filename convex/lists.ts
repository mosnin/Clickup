import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  canAccessSpace,
  requireFolderAccess,
  requireListAccess,
  requireSpaceAccess,
} from "./_authz";

const parentTypeValidator = v.union(
  v.literal("space"),
  v.literal("folder"),
);

export const listForParent = query({
  args: { parentType: parentTypeValidator, parentId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    return await ctx.db
      .query("lists")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", args.parentType).eq("parentId", args.parentId),
      )
      .collect();
  },
});

export const get = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const list = await ctx.db.get(listId);
    if (!list) return null;
    // Resolve up to space and check access.
    let space;
    if (list.parentType === "space") {
      space = await ctx.db.get(list.parentId as Id<"spaces">);
    } else {
      const folder = await ctx.db.get(list.parentId as Id<"folders">);
      if (!folder) return null;
      space = await ctx.db.get(folder.spaceId);
    }
    if (!space) return null;
    if (!(await canAccessSpace(ctx, space, { subject: identity.subject }))) {
      return null;
    }
    return list;
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    color: v.optional(v.string()),
    parentType: parentTypeValidator,
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.parentType === "space") {
      await requireSpaceAccess(ctx, args.parentId as Id<"spaces">);
    } else {
      await requireFolderAccess(ctx, args.parentId as Id<"folders">);
    }

    const siblings = await ctx.db
      .query("lists")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", args.parentType).eq("parentId", args.parentId),
      )
      .collect();

    return await ctx.db.insert("lists", {
      ...args,
      position: siblings.length,
      createdAt: Date.now(),
    });
  },
});

export const rename = mutation({
  args: { listId: v.id("lists"), name: v.string() },
  handler: async (ctx, { listId, name }) => {
    const { list } = await requireListAccess(ctx, listId);
    await ctx.db.patch(list._id, { name });
  },
});

export const remove = mutation({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    const { list } = await requireListAccess(ctx, listId);
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_list", (q) => q.eq("listId", list._id))
      .collect();
    for (const t of tasks) await ctx.db.delete(t._id);
    await ctx.db.delete(list._id);
  },
});
