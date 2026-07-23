import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireIdentity, requireTaskAccess } from "./_authz";

// Convex file storage workflow:
// 1. Client calls generateUploadUrl, gets a presigned POST URL.
// 2. Client uploads the blob to that URL.
// 3. Storage returns a storageId; client calls clips.create with it.
// 4. Playback fetches the storage URL via getUrl.
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireIdentity(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const listForTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    // Same soft-fail shape as timeEntries.listForTask: no access = empty,
    // never leak another tenant's clips.
    try {
      await requireTaskAccess(ctx, taskId);
    } catch {
      return [];
    }
    const all = await ctx.db
      .query("clips")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "task").eq("parentId", taskId),
      )
      .collect();
    return all.sort((a, b) => b.createdAt - a.createdAt);
  },
});

// Takes the clip's document id (not a bare storageId) so there's an
// ownership trail: clip -> parent task -> access check, and only then a
// signed download URL.
export const getUrl = query({
  args: { clipId: v.id("clips") },
  handler: async (ctx, { clipId }) => {
    const clip = await ctx.db.get(clipId);
    if (!clip) return null;
    try {
      await requireTaskAccess(ctx, clip.parentId as Id<"tasks">);
    } catch {
      return null;
    }
    return await ctx.storage.getUrl(clip.storageId);
  },
});

export const create = mutation({
  args: {
    taskId: v.id("tasks"),
    storageId: v.id("_storage"),
    durationMs: v.optional(v.number()),
    mimeType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { identity } = await requireTaskAccess(ctx, args.taskId);
    return await ctx.db.insert("clips", {
      parentType: "task",
      parentId: args.taskId,
      authorClerkId: identity.subject,
      storageId: args.storageId,
      durationMs: args.durationMs,
      mimeType: args.mimeType,
      sizeBytes: args.sizeBytes,
      createdAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { clipId: v.id("clips") },
  handler: async (ctx, { clipId }) => {
    const identity = await requireIdentity(ctx);
    const clip = await ctx.db.get(clipId);
    if (!clip) return;
    if (clip.authorClerkId !== identity.subject) {
      throw new Error("Only the author can delete this clip");
    }
    await ctx.storage.delete(clip.storageId as Id<"_storage">);
    await ctx.db.delete(clipId);
  },
});
