import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertNotSuspended, requireIdentity } from "./_authz";

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
    await assertNotSuspended(ctx, identity.subject);

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

// ── Member management ──────────────────────────────────────────────────
// Mirrors invites.ts's requireManageAccess: owners and admins can manage
// membership, plain members cannot. requireIdentity already blocks a
// suspended caller (see _authz.requireIdentity), so no extra check needed.

async function requireMemberManageAccess(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  subject: string,
): Promise<Doc<"memberships">> {
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q.eq("userClerkId", subject).eq("workspaceId", workspaceId),
    )
    .unique();
  if (!membership || membership.role === "member") {
    throw new Error("Only owners and admins can manage members");
  }
  return membership;
}

async function getMembership(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  memberClerkId: string,
): Promise<Doc<"memberships">> {
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q.eq("userClerkId", memberClerkId).eq("workspaceId", workspaceId),
    )
    .unique();
  if (!membership) throw new Error("Not a member of this workspace");
  return membership;
}

async function countOwners(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<number> {
  const all = await ctx.db
    .query("memberships")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  return all.filter((m) => m.role === "owner").length;
}

// Owners/admins change another member's role. Only an existing owner may
// grant ownership or touch another owner's role (admins manage admins and
// members, never owners), and the last remaining owner can never be
// demoted — the workspace would otherwise be strandable with no one able
// to manage it.
export const updateMemberRole = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    memberClerkId: v.string(),
    role: v.union(
      v.literal("owner"),
      v.literal("admin"),
      v.literal("member"),
    ),
  },
  handler: async (ctx, { workspaceId, memberClerkId, role }) => {
    const identity = await requireIdentity(ctx);
    const myMembership = await requireMemberManageAccess(
      ctx,
      workspaceId,
      identity.subject,
    );
    const target = await getMembership(ctx, workspaceId, memberClerkId);

    if (
      (role === "owner" || target.role === "owner") &&
      myMembership.role !== "owner"
    ) {
      throw new Error("Only an owner can change an owner's role");
    }

    if (target.role === "owner" && role !== "owner") {
      const owners = await countOwners(ctx, workspaceId);
      if (owners <= 1) {
        throw new Error(
          "Workspace needs at least one owner — promote someone else first",
        );
      }
    }

    await ctx.db.patch(target._id, { role });
  },
});

// Owners/admins remove another member entirely. A member removes
// themselves via leaveWorkspace instead (kept separate so the "last owner"
// safeguard reads clearly for both call sites). Admins may not remove an
// owner; the last owner can never be removed.
export const removeMember = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    memberClerkId: v.string(),
  },
  handler: async (ctx, { workspaceId, memberClerkId }) => {
    const identity = await requireIdentity(ctx);
    if (memberClerkId === identity.subject) {
      throw new Error("Use leaveWorkspace to remove yourself");
    }
    const myMembership = await requireMemberManageAccess(
      ctx,
      workspaceId,
      identity.subject,
    );
    const target = await getMembership(ctx, workspaceId, memberClerkId);

    if (target.role === "owner") {
      if (myMembership.role !== "owner") {
        throw new Error("Only an owner can remove another owner");
      }
      const owners = await countOwners(ctx, workspaceId);
      if (owners <= 1) {
        throw new Error(
          "Can't remove the last owner — transfer ownership first",
        );
      }
    }

    await ctx.db.delete(target._id);
  },
});

// Any member (including an owner, as long as they aren't the last one)
// removes themselves from a workspace.
export const leaveWorkspace = mutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const identity = await requireIdentity(ctx);
    const membership = await getMembership(ctx, workspaceId, identity.subject);

    if (membership.role === "owner") {
      const owners = await countOwners(ctx, workspaceId);
      if (owners <= 1) {
        throw new Error(
          "You're the only owner — promote someone else before leaving",
        );
      }
    }

    await ctx.db.delete(membership._id);
  },
});
