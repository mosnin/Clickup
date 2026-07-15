import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// Database-side helpers for the AI layer. The OpenAI actions in ai.ts run
// in the Node runtime, which may only define actions — every query/mutation
// they need lives here in the default (deterministic) runtime and is called
// via ctx.runQuery / ctx.runMutation.

export const _getDocForIndex = internalQuery({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const doc = await ctx.db.get(docId);
    if (!doc) return null;
    const scope = await scopeForDocLikeParent(ctx, doc.parentType, doc.parentId);
    if (!scope) return null;
    return {
      title: doc.title,
      content: doc.content,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
    };
  },
});

export const _getTaskForIndex = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return null;
    const list = await ctx.db.get(task.listId);
    if (!list) return null;
    let space: Doc<"spaces"> | null = null;
    if (list.parentType === "space") {
      space = await ctx.db.get(list.parentId as Id<"spaces">);
    } else {
      const folder = await ctx.db.get(list.parentId as Id<"folders">);
      if (folder) space = await ctx.db.get(folder.spaceId);
    }
    if (!space) return null;
    return {
      title: task.title,
      description: task.description,
      scopeType: space.parentType,
      scopeId: space.parentId,
    };
  },
});

async function scopeForDocLikeParent(
  ctx: QueryCtx,
  parentType: "user" | "workspace" | "space",
  parentId: string,
): Promise<{ scopeType: "user" | "workspace"; scopeId: string } | null> {
  if (parentType === "user") return { scopeType: "user", scopeId: parentId };
  if (parentType === "workspace") {
    return { scopeType: "workspace", scopeId: parentId };
  }
  const space = await ctx.db.get(parentId as Id<"spaces">);
  if (!space) return null;
  return { scopeType: space.parentType, scopeId: space.parentId };
}

export const _upsertEmbedding = internalMutation({
  args: {
    parentType: v.union(v.literal("doc"), v.literal("task")),
    parentId: v.string(),
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    textPreview: v.string(),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("embeddings")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", args.parentType).eq("parentId", args.parentId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        scopeType: args.scopeType,
        scopeId: args.scopeId,
        textPreview: args.textPreview,
        embedding: args.embedding,
        updatedAt: Date.now(),
      });
      return;
    }
    await ctx.db.insert("embeddings", { ...args, updatedAt: Date.now() });
  },
});

export const _dropEmbeddings = internalMutation({
  args: {
    parentType: v.union(v.literal("doc"), v.literal("task")),
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("embeddings")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", args.parentType).eq("parentId", args.parentId),
      )
      .collect();
    for (const e of existing) await ctx.db.delete(e._id);
  },
});

export const _isWorkspaceMember = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;
    const m = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
      )
      .unique();
    return m !== null;
  },
});

export const _embeddingsByIds = internalQuery({
  args: { ids: v.array(v.id("embeddings")) },
  handler: async (ctx, { ids }) => {
    const rows = await Promise.all(ids.map((id) => ctx.db.get(id)));
    return rows.filter((r): r is NonNullable<typeof r> => r !== null);
  },
});
