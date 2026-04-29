import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireFolderAccess, requireSpaceAccess } from "./_authz";

export const listForSpace = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    // Soft-fail (return []) instead of throwing so the sidebar can render
    // gracefully when a stale spaceId is passed.
    const space = await ctx.db.get(spaceId);
    if (!space) return [];
    return await ctx.db
      .query("folders")
      .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
      .collect();
  },
});

export const create = mutation({
  args: { spaceId: v.id("spaces"), name: v.string() },
  handler: async (ctx, { spaceId, name }) => {
    await requireSpaceAccess(ctx, spaceId);
    const siblings = await ctx.db
      .query("folders")
      .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
      .collect();
    return await ctx.db.insert("folders", {
      name,
      spaceId,
      position: siblings.length,
      createdAt: Date.now(),
    });
  },
});

export const rename = mutation({
  args: { folderId: v.id("folders"), name: v.string() },
  handler: async (ctx, { folderId, name }) => {
    const { folder } = await requireFolderAccess(ctx, folderId);
    await ctx.db.patch(folder._id, { name });
  },
});

export const remove = mutation({
  args: { folderId: v.id("folders") },
  handler: async (ctx, { folderId }) => {
    const { folder } = await requireFolderAccess(ctx, folderId);

    // Cascade: delete child lists and their tasks.
    const childLists = await ctx.db
      .query("lists")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "folder").eq("parentId", folder._id),
      )
      .collect();
    for (const list of childLists) {
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_list", (q) => q.eq("listId", list._id))
        .collect();
      for (const t of tasks) await ctx.db.delete(t._id);
      await ctx.db.delete(list._id);
    }
    await ctx.db.delete(folder._id);
  },
});
