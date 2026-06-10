import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireIdentity } from "./_authz";

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const roleValidator = v.union(
  v.literal("admin"),
  v.literal("member"),
  v.literal("viewer"),
);

async function requireWorkspaceAdmin(
  ctx: Parameters<typeof requireIdentity>[0],
  workspaceId: import("./_generated/dataModel").Id<"workspaces">,
) {
  const identity = await requireIdentity(ctx);
  const m = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
    )
    .unique();
  if (!m) throw new Error("Not a member");
  if (m.role !== "owner" && m.role !== "admin") {
    throw new Error("Only owners and admins can manage invites");
  }
  return identity;
}

export const listForWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const m = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
      )
      .unique();
    if (!m) return [];
    const all = await ctx.db
      .query("invitations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    return all
      .filter((i) => !i.acceptedAt && !i.revokedAt && i.expiresAt > Date.now())
      .sort((a, b) => b.createdAt - a.createdAt);
  },
});

// Public lookup by token. Used by the /invite/[token] accept page so the
// recipient can see the workspace name and the inviter's name before
// agreeing to join. Returns null for expired / revoked / accepted /
// missing tokens.
export const lookup = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const inv = await ctx.db
      .query("invitations")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!inv) return null;
    if (inv.acceptedAt || inv.revokedAt || inv.expiresAt < Date.now()) {
      return { state: "expired" as const };
    }
    const workspace = await ctx.db.get(inv.workspaceId);
    if (!workspace) return null;
    const inviter = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", inv.inviterClerkId))
      .unique();
    return {
      state: "active" as const,
      workspaceName: workspace.name,
      role: inv.role,
      inviterName: inviter?.name ?? inviter?.email ?? "A teammate",
      email: inv.email,
    };
  },
});

export const create = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    email: v.string(),
    role: roleValidator,
  },
  handler: async (ctx, args) => {
    const identity = await requireWorkspaceAdmin(ctx, args.workspaceId);
    const email = args.email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      throw new Error("Enter a valid email");
    }

    // If the user already exists and is already a member, reject early.
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (existingUser) {
      const already = await ctx.db
        .query("memberships")
        .withIndex("by_user_and_workspace", (q) =>
          q
            .eq("userClerkId", existingUser.clerkId)
            .eq("workspaceId", args.workspaceId),
        )
        .unique();
      if (already) throw new Error("That person is already a member");
    }

    const token = crypto.randomUUID();
    const now = Date.now();
    const inviteId = await ctx.db.insert("invitations", {
      workspaceId: args.workspaceId,
      email,
      role: args.role,
      token,
      inviterClerkId: identity.subject,
      createdAt: now,
      expiresAt: now + INVITE_TTL_MS,
    });

    const workspace = await ctx.db.get(args.workspaceId);
    const inviter = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    await ctx.scheduler.runAfter(0, internal.notifications.sendInviteEmail, {
      toEmail: email,
      fromName: inviter?.name ?? inviter?.email ?? "A teammate",
      workspaceName: workspace?.name ?? "a Pace workspace",
      role: args.role,
      token,
    });

    return inviteId;
  },
});

export const revoke = mutation({
  args: { invitationId: v.id("invitations") },
  handler: async (ctx, { invitationId }) => {
    const inv = await ctx.db.get(invitationId);
    if (!inv) return;
    await requireWorkspaceAdmin(ctx, inv.workspaceId);
    if (inv.revokedAt || inv.acceptedAt) return;
    await ctx.db.patch(invitationId, { revokedAt: Date.now() });
  },
});

export const accept = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const identity = await requireIdentity(ctx);
    const inv = await ctx.db
      .query("invitations")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!inv) throw new Error("Invitation not found");
    if (inv.revokedAt) throw new Error("This invitation was revoked");
    if (inv.acceptedAt) throw new Error("This invitation was already used");
    if (inv.expiresAt < Date.now()) throw new Error("This invitation has expired");

    // If the caller is already a member, treat accept as a no-op so
    // navigating to a stale invite link doesn't bounce.
    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q
          .eq("userClerkId", identity.subject)
          .eq("workspaceId", inv.workspaceId),
      )
      .unique();
    if (!existing) {
      await ctx.db.insert("memberships", {
        workspaceId: inv.workspaceId,
        userClerkId: identity.subject,
        role: inv.role,
        joinedAt: Date.now(),
      });
    }

    await ctx.db.patch(inv._id, {
      acceptedAt: Date.now(),
      acceptedByClerkId: identity.subject,
    });

    return inv.workspaceId;
  },
});
