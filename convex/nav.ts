import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireIdentity } from "./_authz";

// The workspace's navigation default.
//
// Storage only. Every decision about what this MEANS — precedence, what a
// required destination is, whether an unlisted item is hidden or merely
// unlisted — lives in src/lib/nav-items.ts, so the sidebar, the dock and this
// table can never disagree about it. A second copy of that reasoning here is
// how the two surfaces drift.

export const defaultsFor = query({
  args: {
    parentType: v.union(v.literal("user"), v.literal("workspace")),
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    if (!(await canSee(ctx, args.parentType, args.parentId, identity.subject))) {
      return null;
    }
    const row = await ctx.db
      .query("navDefaults")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", args.parentType).eq("parentId", args.parentId),
      )
      .unique();
    return row?.layout ?? null;
  },
});

export const saveDefaults = mutation({
  args: {
    parentType: v.union(v.literal("user"), v.literal("workspace")),
    parentId: v.string(),
    layout: v.any(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await requireGovern(ctx, args.parentType, args.parentId, identity.subject);
    const existing = await ctx.db
      .query("navDefaults")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", args.parentType).eq("parentId", args.parentId),
      )
      .unique();
    const patch = {
      layout: args.layout,
      updatedByClerkId: identity.subject,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("navDefaults", { ...args, ...patch });
    }
    return { saved: true };
  },
});

// Clearing DELETES the row rather than writing the shipped order into it.
// Copying the default down looks identical today and silently stops tracking
// tomorrow — the same reason clearing an appearance override deletes the key
// instead of materialising the parent's value.
export const clearDefaults = mutation({
  args: {
    parentType: v.union(v.literal("user"), v.literal("workspace")),
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await requireGovern(ctx, args.parentType, args.parentId, identity.subject);
    const existing = await ctx.db
      .query("navDefaults")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", args.parentType).eq("parentId", args.parentId),
      )
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    return { cleared: true };
  },
});

async function canSee(
  ctx: QueryCtx,
  parentType: "user" | "workspace",
  parentId: string,
  subject: string,
) {
  if (parentType === "user") return parentId === subject;
  return (
    (await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q.eq("userClerkId", subject).eq("workspaceId", parentId as Id<"workspaces">),
      )
      .unique()) !== null
  );
}

// Setting what everybody in a workspace sees on their first day is a shared
// act, so it takes the same bar every other shared change does.
async function requireGovern(
  ctx: MutationCtx,
  parentType: "user" | "workspace",
  parentId: string,
  subject: string,
) {
  if (parentType === "user") {
    if (parentId !== subject) throw new ConvexError("Forbidden");
    return;
  }
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q.eq("userClerkId", subject).eq("workspaceId", parentId as Id<"workspaces">),
    )
    .unique();
  if (!membership) throw new ConvexError("Forbidden");
  if (membership.role !== "owner" && membership.role !== "admin") {
    throw new ConvexError(
      "Only workspace owners and admins can set the default navigation",
    );
  }
}
