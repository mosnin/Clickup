import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  canAccessSpace,
  requireIdentity,
  requireSpaceAccess,
} from "./_authz";

export const personal = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "user").eq("parentId", identity.subject),
      )
      .unique();
  },
});

export const listForWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
      )
      .unique();
    if (!membership) return [];

    return await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", workspaceId),
      )
      .collect();
  },
});

export const get = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const space = await ctx.db.get(spaceId);
    if (!space) return null;
    if (!(await canAccessSpace(ctx, space, { subject: identity.subject }))) {
      return null;
    }
    return space;
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    color: v.optional(v.string()),
    parentType: v.union(v.literal("user"), v.literal("workspace")),
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);

    if (args.parentType === "user") {
      if (args.parentId !== identity.subject) {
        throw new Error("Cannot create a personal space for another user");
      }
    } else {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user_and_workspace", (q) =>
          q
            .eq("userClerkId", identity.subject)
            .eq("workspaceId", args.parentId as Id<"workspaces">),
        )
        .unique();
      if (!membership) throw new Error("Not a member of this workspace");
    }

    const siblings = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", args.parentType).eq("parentId", args.parentId),
      )
      .collect();

    return await ctx.db.insert("spaces", {
      ...args,
      position: siblings.length,
      createdAt: Date.now(),
    });
  },
});

export const rename = mutation({
  args: { spaceId: v.id("spaces"), name: v.string() },
  handler: async (ctx, { spaceId, name }) => {
    const { space } = await requireSpaceAccess(ctx, spaceId);
    await ctx.db.patch(space._id, { name });
  },
});
