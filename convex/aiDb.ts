import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  requireDocLikeParentAccess,
  requireMessageParentAccess,
  requirePageAccess,
  requireTaskAccess,
} from "./_authz";

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
      const project = await ctx.db.get(list.parentId as Id<"projects">);
      if (project) space = await ctx.db.get(project.spaceId);
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
  parentType: "user" | "workspace" | "space" | "list",
  parentId: string,
): Promise<{ scopeType: "user" | "workspace"; scopeId: string } | null> {
  if (parentType === "user") return { scopeType: "user", scopeId: parentId };
  if (parentType === "workspace") {
    return { scopeType: "workspace", scopeId: parentId };
  }
  // A project doc resolves through the project to its space, so it is indexed
  // in the same vector scope as everything else in that space. Getting this
  // wrong would be a leak, not a bug: the scope is the filter Brain search
  // uses to keep one account's vectors away from another's.
  if (parentType === "list") {
    const list = await ctx.db.get(parentId as Id<"lists">);
    if (!list) return null;
    const spaceId =
      list.parentType === "space"
        ? (list.parentId as Id<"spaces">)
        : (await ctx.db.get(list.parentId as Id<"projects">))?.spaceId;
    if (!spaceId) return null;
    const listSpace = await ctx.db.get(spaceId);
    if (!listSpace) return null;
    return { scopeType: listSpace.parentType, scopeId: listSpace.parentId };
  }
  const space = await ctx.db.get(parentId as Id<"spaces">);
  if (!space) return null;
  return { scopeType: space.parentType, scopeId: space.parentId };
}

export const _upsertEmbedding = internalMutation({
  args: {
    parentType: v.union(
      v.literal("doc"),
      v.literal("task"),
      v.literal("page"),
      v.literal("message"),
    ),
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
    parentType: v.union(
      v.literal("doc"),
      v.literal("task"),
      v.literal("page"),
      v.literal("message"),
    ),
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

const brainHitValidator = v.object({
  parentType: v.union(
    v.literal("doc"),
    v.literal("task"),
    v.literal("page"),
    v.literal("message"),
  ),
  parentId: v.string(),
  textPreview: v.string(),
});

/**
 * Vector search is scoped to a workspace (or personal user), which is
 * coarser than `canAccessSpace`. Private-space tasks, space-parented
 * docs, and comments on either would otherwise come back as `textPreview`
 * to any workspace member. Drop anything the viewer could not open
 * through the ordinary hierarchy helpers.
 */
export const _filterHitsForViewer = internalQuery({
  args: { hits: v.array(brainHitValidator) },
  handler: async (ctx, { hits }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const out: typeof hits = [];
    for (const hit of hits) {
      if (await viewerCanReadHit(ctx, hit)) out.push(hit);
    }
    return out;
  },
});

async function viewerCanReadHit(
  ctx: QueryCtx,
  hit: {
    parentType: "doc" | "task" | "page" | "message";
    parentId: string;
  },
): Promise<boolean> {
  try {
    if (hit.parentType === "task") {
      const taskId = ctx.db.normalizeId("tasks", hit.parentId);
      if (!taskId) return false;
      await requireTaskAccess(ctx, taskId);
      return true;
    }
    if (hit.parentType === "page") {
      const pageId = ctx.db.normalizeId("pages", hit.parentId);
      if (!pageId) return false;
      await requirePageAccess(ctx, pageId);
      return true;
    }
    if (hit.parentType === "doc") {
      const docId = ctx.db.normalizeId("docs", hit.parentId);
      if (!docId) return false;
      const doc = await ctx.db.get(docId);
      if (!doc) return false;
      await requireDocLikeParentAccess(ctx, doc.parentType, doc.parentId);
      return true;
    }
    const messageId = ctx.db.normalizeId("messages", hit.parentId);
    if (!messageId) return false;
    const message = await ctx.db.get(messageId);
    if (!message) return false;
    await requireMessageParentAccess(ctx, message.parentType, message.parentId);
    return true;
  } catch {
    return false;
  }
}
