import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  canAccessSpace,
  requireFolderAccess,
  requireListAccess,
  requireSpaceAccess,
} from "./_authz";
import { seedDefaultStatuses } from "./listStatuses";

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

// Returns the workspace members that the given list lives under, or
// an empty list for personal-space lists. Drives the member picker in
// the assign_user automation editor.
export const membersForList = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const list = await ctx.db.get(listId);
    if (!list) return [];
    let space;
    if (list.parentType === "space") {
      space = await ctx.db.get(list.parentId as Id<"spaces">);
    } else {
      const folder = await ctx.db.get(list.parentId as Id<"folders">);
      if (!folder) return [];
      space = await ctx.db.get(folder.spaceId);
    }
    if (!space) return [];
    if (!(await canAccessSpace(ctx, space, { subject: identity.subject }))) {
      return [];
    }
    if (space.parentType === "user") {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", space.parentId))
        .unique();
      return user ? [user] : [];
    }
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_workspace", (q) =>
        q.eq("workspaceId", space.parentId as Id<"workspaces">),
      )
      .collect();
    const users = await Promise.all(
      memberships.map((m) =>
        ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", m.userClerkId))
          .unique(),
      ),
    );
    return users.filter((u): u is NonNullable<typeof u> => u !== null);
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

    const listId = await ctx.db.insert("lists", {
      ...args,
      position: siblings.length,
      createdAt: Date.now(),
    });

    await seedDefaultStatuses(ctx, listId);

    return listId;
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

    // Cascade everything that hangs off this list:
    //   tasks → taskFieldValues → also remove the task row
    //   listStatuses, customFields → drop directly
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_list", (q) => q.eq("listId", list._id))
      .collect();
    for (const t of tasks) {
      const values = await ctx.db
        .query("taskFieldValues")
        .withIndex("by_task", (q) => q.eq("taskId", t._id))
        .collect();
      for (const v of values) await ctx.db.delete(v._id);
      await ctx.db.delete(t._id);
    }

    const statuses = await ctx.db
      .query("listStatuses")
      .withIndex("by_list", (q) => q.eq("listId", list._id))
      .collect();
    for (const s of statuses) await ctx.db.delete(s._id);

    const fields = await ctx.db
      .query("customFields")
      .withIndex("by_list", (q) => q.eq("listId", list._id))
      .collect();
    for (const f of fields) await ctx.db.delete(f._id);

    const automations = await ctx.db
      .query("listAutomations")
      .withIndex("by_list", (q) => q.eq("listId", list._id))
      .collect();
    for (const a of automations) await ctx.db.delete(a._id);

    await ctx.db.delete(list._id);
  },
});
