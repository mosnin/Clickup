import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const baseSlug = slugify(name) || "workspace";
    let slug = baseSlug;
    let suffix = 1;
    while (
      await ctx.db
        .query("workspaces")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique()
    ) {
      suffix += 1;
      slug = `${baseSlug}-${suffix}`;
    }

    const workspaceId = await ctx.db.insert("workspaces", {
      name,
      slug,
      ownerClerkId: identity.subject,
      createdAt: Date.now(),
    });

    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: identity.subject,
      role: "owner",
      joinedAt: Date.now(),
    });

    return workspaceId;
  },
});

export const listForCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .collect();

    const workspaces = await Promise.all(
      memberships.map((m) => ctx.db.get(m.workspaceId)),
    );

    return workspaces
      .filter((w): w is NonNullable<typeof w> => w !== null)
      .map((w, i) => ({ ...w, role: memberships[i].role }));
  },
});

const memberRoleValidator = v.union(
  v.literal("admin"),
  v.literal("member"),
  v.literal("viewer"),
);

async function requireWorkspaceRole(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  allowed: ("owner" | "admin" | "member" | "viewer")[],
) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  const m = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
    )
    .unique();
  if (!m || !allowed.includes(m.role)) throw new Error("Forbidden");
  return { identity, membership: m };
}

export const changeRole = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    targetClerkId: v.string(),
    role: memberRoleValidator,
  },
  handler: async (ctx, args) => {
    const { membership: actor } = await requireWorkspaceRole(
      ctx,
      args.workspaceId,
      ["owner", "admin"],
    );
    const target = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q
          .eq("userClerkId", args.targetClerkId)
          .eq("workspaceId", args.workspaceId),
      )
      .unique();
    if (!target) throw new Error("Member not found");
    if (target.role === "owner") {
      throw new Error("Use transferOwnership to move the owner role");
    }
    // Admins can't change other admins or the owner; only owners can.
    if (actor.role === "admin" && target.role === "admin") {
      throw new Error("Admins can't demote each other");
    }
    await ctx.db.patch(target._id, { role: args.role });
  },
});

export const removeMember = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    targetClerkId: v.string(),
  },
  handler: async (ctx, args) => {
    const { membership: actor, identity } = await requireWorkspaceRole(
      ctx,
      args.workspaceId,
      ["owner", "admin", "member", "viewer"],
    );
    const target = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q
          .eq("userClerkId", args.targetClerkId)
          .eq("workspaceId", args.workspaceId),
      )
      .unique();
    if (!target) return;

    // Removing yourself is always allowed (unless you're the owner).
    const isSelf = args.targetClerkId === identity.subject;
    if (isSelf && target.role === "owner") {
      throw new Error("Transfer ownership before leaving");
    }
    if (!isSelf) {
      if (actor.role !== "owner" && actor.role !== "admin") {
        throw new Error("Only owners and admins can remove members");
      }
      if (target.role === "owner") {
        throw new Error("Can't remove the owner");
      }
      if (actor.role === "admin" && target.role === "admin") {
        throw new Error("Admins can't remove each other");
      }
    }
    await ctx.db.delete(target._id);
  },
});

export const transferOwnership = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    newOwnerClerkId: v.string(),
  },
  handler: async (ctx, args) => {
    const { membership: actor } = await requireWorkspaceRole(
      ctx,
      args.workspaceId,
      ["owner"],
    );
    if (args.newOwnerClerkId === actor.userClerkId) return;
    const target = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q
          .eq("userClerkId", args.newOwnerClerkId)
          .eq("workspaceId", args.workspaceId),
      )
      .unique();
    if (!target) throw new Error("New owner must be a member of the workspace");
    await ctx.db.patch(actor._id, { role: "admin" });
    await ctx.db.patch(target._id, { role: "owner" });
    const ws = await ctx.db.get(args.workspaceId);
    if (ws) {
      await ctx.db.patch(args.workspaceId, {
        ownerClerkId: args.newOwnerClerkId,
      });
    }
  },
});

export const listMembers = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    // Caller must be a member.
    const myMembership = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
      )
      .unique();
    if (!myMembership) return [];

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    const users = await Promise.all(
      memberships.map((m) =>
        ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", m.userClerkId))
          .unique(),
      ),
    );
    return users
      .map((u, i) => (u ? { ...u, role: memberships[i].role } : null))
      .filter((u): u is NonNullable<typeof u> => u !== null);
  },
});
