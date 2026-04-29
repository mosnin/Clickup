import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireDocLikeParentAccess, requireIdentity } from "./_authz";

const parentTypeValidator = v.union(
  v.literal("user"),
  v.literal("workspace"),
  v.literal("space"),
);

export const listForParent = query({
  args: { parentType: parentTypeValidator, parentId: v.string() },
  handler: async (ctx, { parentType, parentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    try {
      await requireDocLikeParentAccess(ctx, parentType, parentId);
    } catch {
      return [];
    }
    const wbs = await ctx.db
      .query("whiteboards")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", parentType).eq("parentId", parentId),
      )
      .collect();
    return wbs.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const get = query({
  args: { whiteboardId: v.id("whiteboards") },
  handler: async (ctx, { whiteboardId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const wb = await ctx.db.get(whiteboardId);
    if (!wb) return null;
    try {
      await requireDocLikeParentAccess(ctx, wb.parentType, wb.parentId);
    } catch {
      return null;
    }
    return wb;
  },
});

export const create = mutation({
  args: {
    parentType: parentTypeValidator,
    parentId: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, { parentType, parentId, title }) => {
    const { identity } = await requireDocLikeParentAccess(
      ctx,
      parentType,
      parentId,
    );
    const now = Date.now();
    return await ctx.db.insert("whiteboards", {
      parentType,
      parentId,
      title: title?.trim() || "Untitled board",
      snapshot: undefined,
      createdByClerkId: identity.subject,
      updatedAt: now,
      createdAt: now,
    });
  },
});

export const rename = mutation({
  args: { whiteboardId: v.id("whiteboards"), title: v.string() },
  handler: async (ctx, { whiteboardId, title }) => {
    await requireIdentity(ctx);
    const wb = await ctx.db.get(whiteboardId);
    if (!wb) throw new Error("Whiteboard not found");
    await requireDocLikeParentAccess(ctx, wb.parentType, wb.parentId);
    await ctx.db.patch(whiteboardId, {
      title: title.trim() || "Untitled board",
    });
  },
});

export const updateSnapshot = mutation({
  args: { whiteboardId: v.id("whiteboards"), snapshot: v.any() },
  handler: async (ctx, { whiteboardId, snapshot }) => {
    await requireIdentity(ctx);
    const wb = await ctx.db.get(whiteboardId);
    if (!wb) throw new Error("Whiteboard not found");
    await requireDocLikeParentAccess(ctx, wb.parentType, wb.parentId);
    await ctx.db.patch(whiteboardId, { snapshot, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { whiteboardId: v.id("whiteboards") },
  handler: async (ctx, { whiteboardId }) => {
    await requireIdentity(ctx);
    const wb = await ctx.db.get(whiteboardId);
    if (!wb) return;
    await requireDocLikeParentAccess(ctx, wb.parentType, wb.parentId);
    await ctx.db.delete(whiteboardId);
  },
});
