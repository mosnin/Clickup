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
    const docs = await ctx.db
      .query("docs")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", parentType).eq("parentId", parentId),
      )
      .collect();
    return docs.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const get = query({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const doc = await ctx.db.get(docId);
    if (!doc) return null;
    try {
      await requireDocLikeParentAccess(ctx, doc.parentType, doc.parentId);
    } catch {
      return null;
    }
    return doc;
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
    return await ctx.db.insert("docs", {
      parentType,
      parentId,
      title: title?.trim() || "Untitled",
      content: { type: "doc", content: [{ type: "paragraph" }] },
      createdByClerkId: identity.subject,
      updatedAt: now,
      createdAt: now,
    });
  },
});

export const rename = mutation({
  args: { docId: v.id("docs"), title: v.string() },
  handler: async (ctx, { docId, title }) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(docId);
    if (!doc) throw new Error("Doc not found");
    await requireDocLikeParentAccess(ctx, doc.parentType, doc.parentId);
    await ctx.db.patch(docId, { title: title.trim() || "Untitled" });
  },
});

export const updateContent = mutation({
  args: { docId: v.id("docs"), content: v.any() },
  handler: async (ctx, { docId, content }) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(docId);
    if (!doc) throw new Error("Doc not found");
    await requireDocLikeParentAccess(ctx, doc.parentType, doc.parentId);
    await ctx.db.patch(docId, { content, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(docId);
    if (!doc) return;
    await requireDocLikeParentAccess(ctx, doc.parentType, doc.parentId);
    await ctx.db.delete(docId);
  },
});
