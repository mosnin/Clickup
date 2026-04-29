import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
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
    return docs
      .filter((d) => !d.deletedAt)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const get = query({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const doc = await ctx.db.get(docId);
    if (!doc || doc.deletedAt) return null;
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
    const docId = await ctx.db.insert("docs", {
      parentType,
      parentId,
      title: title?.trim() || "Untitled",
      content: { type: "doc", content: [{ type: "paragraph" }] },
      createdByClerkId: identity.subject,
      updatedAt: now,
      createdAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.ai.indexDocument, { docId });
    return docId;
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
    await ctx.scheduler.runAfter(0, internal.ai.indexDocument, { docId });
  },
});

// Soft-delete the doc. Embedding gets dropped immediately so search
// doesn't surface it; restore re-indexes.
export const remove = mutation({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(docId);
    if (!doc || doc.deletedAt) return;
    await requireDocLikeParentAccess(ctx, doc.parentType, doc.parentId);
    await ctx.db.patch(docId, { deletedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.ai.dropEmbeddings, {
      parentType: "doc",
      parentId: docId,
    });
  },
});

export const restore = mutation({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const doc = await ctx.db.get(docId);
    if (!doc || !doc.deletedAt) return;
    await requireDocLikeParentAccess(ctx, doc.parentType, doc.parentId);
    await ctx.db.patch(docId, { deletedAt: undefined });
    await ctx.scheduler.runAfter(0, internal.ai.indexDocument, { docId });
  },
});

export const purge = mutation({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const doc = await ctx.db.get(docId);
    if (!doc) return;
    await requireDocLikeParentAccess(ctx, doc.parentType, doc.parentId);
    await ctx.db.delete(docId);
    await ctx.scheduler.runAfter(0, internal.ai.dropEmbeddings, {
      parentType: "doc",
      parentId: docId,
    });
  },
});
