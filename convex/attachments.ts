import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireIdentity, requireTaskAccess } from "./_authz";

// Task file attachments. Bytes go straight to Convex file storage via a
// short-lived upload URL; rows here are metadata pointing at the blob.
// Same storage pattern as clips.

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireIdentity(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB

export const create = mutation({
  args: {
    taskId: v.id("tasks"),
    storageId: v.id("_storage"),
    name: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
  },
  handler: async (ctx, args) => {
    const { identity } = await requireTaskAccess(ctx, args.taskId);
    if (args.sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error("Attachments are limited to 50 MB");
    }
    return await ctx.db.insert("attachments", {
      taskId: args.taskId,
      storageId: args.storageId,
      name: args.name.slice(0, 200) || "file",
      mimeType: args.mimeType,
      sizeBytes: args.sizeBytes,
      uploadedByActorId: identity.subject,
      createdAt: Date.now(),
    });
  },
});

export const listForTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    await requireTaskAccess(ctx, taskId);
    const rows = await ctx.db
      .query("attachments")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .collect();
    return await Promise.all(
      rows
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(async (a) => ({
          ...a,
          url: await ctx.storage.getUrl(a.storageId),
        })),
    );
  },
});

export const remove = mutation({
  args: { attachmentId: v.id("attachments") },
  handler: async (ctx, { attachmentId }) => {
    const attachment = await ctx.db.get(attachmentId);
    if (!attachment) return;
    await requireTaskAccess(ctx, attachment.taskId);
    await ctx.storage.delete(attachment.storageId);
    await ctx.db.delete(attachmentId);
  },
});
