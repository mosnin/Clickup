import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireFolderAccess, requireSpaceAccess } from "./_authz";
import { purgeList, softDeleteList } from "./lists";

export const listForSpace = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const space = await ctx.db.get(spaceId);
    if (!space) return [];
    const folders = await ctx.db
      .query("folders")
      .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
      .collect();
    return folders.filter((f) => !f.deletedAt);
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
    if (folder.deletedAt) return;
    await softDeleteFolder(ctx, folderId, Date.now());
  },
});

export async function softDeleteFolder(
  ctx: MutationCtx,
  folderId: Id<"folders">,
  ts: number,
): Promise<void> {
  const folder = await ctx.db.get(folderId);
  if (!folder || folder.deletedAt) return;
  const childLists = await ctx.db
    .query("lists")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", "folder").eq("parentId", folderId),
    )
    .collect();
  for (const list of childLists) {
    if (!list.deletedAt) await softDeleteList(ctx, list._id, ts);
  }
  await ctx.db.patch(folderId, { deletedAt: ts });
}

export const restore = mutation({
  args: { folderId: v.id("folders") },
  handler: async (ctx, { folderId }) => {
    const folder = await ctx.db.get(folderId);
    if (!folder || !folder.deletedAt) return;
    await requireFolderAccess(ctx, folderId);
    const ts = folder.deletedAt;
    await ctx.db.patch(folderId, { deletedAt: undefined });
    const childLists = await ctx.db
      .query("lists")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "folder").eq("parentId", folderId),
      )
      .collect();
    for (const list of childLists) {
      if (list.deletedAt === ts) {
        await ctx.db.patch(list._id, { deletedAt: undefined });
        const tasks = await ctx.db
          .query("tasks")
          .withIndex("by_list", (q) => q.eq("listId", list._id))
          .collect();
        for (const t of tasks) {
          if (t.deletedAt === ts) await ctx.db.patch(t._id, { deletedAt: undefined });
        }
      }
    }
  },
});

export const purge = mutation({
  args: { folderId: v.id("folders") },
  handler: async (ctx, { folderId }) => {
    const folder = await ctx.db.get(folderId);
    if (!folder) return;
    await requireFolderAccess(ctx, folderId);
    await purgeFolder(ctx, folderId);
  },
});

export async function purgeFolder(
  ctx: MutationCtx,
  folderId: Id<"folders">,
): Promise<void> {
  const childLists = await ctx.db
    .query("lists")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", "folder").eq("parentId", folderId),
    )
    .collect();
  for (const list of childLists) await purgeList(ctx, list._id);
  await ctx.db.delete(folderId);
}
