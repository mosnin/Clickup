import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireIdentity } from "./_authz";
import { notify } from "./notificationCenter";

// Workspace invitations. Two acceptance paths:
//   1. In-app: the invited email matches a signed-in user → an invite card
//      appears on their Home/Inbox; accepting requires the email match.
//   2. Link: /invite/[token] is a capability link — any signed-in user
//      holding it may accept (Notion-style). Share deliberately.
//
// Convex mutations have no CSPRNG; like webhookSubscriptions' default
// secret, the token is Math.random-derived. It gates workspace membership
// (not money), is single-use, and is revocable — acceptable here.

function randomToken(): string {
  return Array.from({ length: 4 }, () =>
    Math.random().toString(36).slice(2, 10),
  ).join("");
}

async function requireManageAccess(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
  subject: string,
): Promise<Doc<"workspaces">> {
  const ws = await ctx.db.get(workspaceId);
  if (!ws) throw new Error("Workspace not found");
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q.eq("userClerkId", subject).eq("workspaceId", workspaceId),
    )
    .unique();
  if (!membership || membership.role === "member") {
    throw new Error("Only owners and admins can manage invites");
  }
  return ws;
}

function isPending(inv: Doc<"invites">): boolean {
  return inv.acceptedAt === undefined && inv.revokedAt === undefined;
}

export const create = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    email: v.string(),
    role: v.union(v.literal("admin"), v.literal("member")),
  },
  handler: async (ctx, args) => {
    const { subject } = await requireIdentity(ctx);
    const ws = await requireManageAccess(ctx, args.workspaceId, subject);

    const email = args.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Enter a valid email address");
    }

    // Already a member?
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (existingUser) {
      const member = await ctx.db
        .query("memberships")
        .withIndex("by_user_and_workspace", (q) =>
          q
            .eq("userClerkId", existingUser.clerkId)
            .eq("workspaceId", args.workspaceId),
        )
        .unique();
      if (member) throw new Error("They're already a member");
    }

    // Duplicate pending invite?
    const existing = await ctx.db
      .query("invites")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    if (existing.some((i) => i.email === email && isPending(i))) {
      throw new Error("An invite to that email is already pending");
    }

    const inviter = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", subject))
      .unique();
    const fromName = inviter?.name ?? inviter?.email ?? "A teammate";

    const token = randomToken();
    const inviteId = await ctx.db.insert("invites", {
      workspaceId: args.workspaceId,
      email,
      role: args.role,
      token,
      invitedByClerkId: subject,
      createdAt: Date.now(),
    });

    // If they already have an account, ping them in-app too.
    if (existingUser) {
      await notify(ctx, {
        userClerkId: existingUser.clerkId,
        type: "invite",
        title: `${fromName} invited you to ${ws.name}`,
        body: "Accept the invite from your Home or Inbox.",
        href: "/dashboard",
      });
    }

    await ctx.scheduler.runAfter(0, internal.notifications.sendInviteEmail, {
      toEmail: email,
      fromName,
      workspaceName: ws.name,
      token,
    });

    return { inviteId, token };
  },
});

export const listForWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const { subject } = await requireIdentity(ctx);
    await requireManageAccess(ctx, workspaceId, subject);
    const all = await ctx.db
      .query("invites")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    return all
      .filter(isPending)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((i) => ({
        _id: i._id,
        email: i.email,
        role: i.role,
        token: i.token,
        createdAt: i.createdAt,
      }));
  },
});

export const revoke = mutation({
  args: { inviteId: v.id("invites") },
  handler: async (ctx, { inviteId }) => {
    const { subject } = await requireIdentity(ctx);
    const invite = await ctx.db.get(inviteId);
    if (!invite) throw new Error("Invite not found");
    await requireManageAccess(ctx, invite.workspaceId, subject);
    if (isPending(invite)) {
      await ctx.db.patch(inviteId, { revokedAt: Date.now() });
    }
  },
});

// Pending invites addressed to the signed-in user's email.
export const listForCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const me = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
    const email = me?.email?.toLowerCase();
    if (!email) return [];
    const invites = await ctx.db
      .query("invites")
      .withIndex("by_email", (q) => q.eq("email", email))
      .collect();
    const pending = invites.filter(isPending);
    return await Promise.all(
      pending.map(async (i) => {
        const ws = await ctx.db.get(i.workspaceId);
        const inviter = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", i.invitedByClerkId))
          .unique();
        return {
          _id: i._id,
          workspaceName: ws?.name ?? "a workspace",
          invitedBy: inviter?.name ?? inviter?.email ?? "A teammate",
          role: i.role,
          createdAt: i.createdAt,
        };
      }),
    );
  },
});

async function joinWorkspace(
  ctx: MutationCtx,
  invite: Doc<"invites">,
  subject: string,
): Promise<Id<"workspaces">> {
  const already = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q.eq("userClerkId", subject).eq("workspaceId", invite.workspaceId),
    )
    .unique();
  if (!already) {
    await ctx.db.insert("memberships", {
      workspaceId: invite.workspaceId,
      userClerkId: subject,
      role: invite.role,
      joinedAt: Date.now(),
    });
  }
  await ctx.db.patch(invite._id, {
    acceptedAt: Date.now(),
    acceptedByClerkId: subject,
  });
  return invite.workspaceId;
}

// In-app accept: requires the signed-in user's email to match the invite.
export const accept = mutation({
  args: { inviteId: v.id("invites") },
  handler: async (ctx, { inviteId }) => {
    const { subject } = await requireIdentity(ctx);
    const invite = await ctx.db.get(inviteId);
    if (!invite || !isPending(invite)) throw new Error("Invite no longer valid");
    const me = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", subject))
      .unique();
    if (me?.email?.toLowerCase() !== invite.email) {
      throw new Error("This invite was sent to a different email");
    }
    return { workspaceId: await joinWorkspace(ctx, invite, subject) };
  },
});

export const decline = mutation({
  args: { inviteId: v.id("invites") },
  handler: async (ctx, { inviteId }) => {
    const { subject } = await requireIdentity(ctx);
    const invite = await ctx.db.get(inviteId);
    if (!invite || !isPending(invite)) return;
    const me = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", subject))
      .unique();
    if (me?.email?.toLowerCase() !== invite.email) {
      throw new Error("This invite was sent to a different email");
    }
    await ctx.db.patch(inviteId, { revokedAt: Date.now() });
  },
});

// Link path: look up + accept by token (capability link).
export const getByToken = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireIdentity(ctx);
    const invite = await ctx.db
      .query("invites")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!invite) return null;
    const ws = await ctx.db.get(invite.workspaceId);
    const inviter = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", invite.invitedByClerkId))
      .unique();
    return {
      workspaceName: ws?.name ?? "a workspace",
      invitedBy: inviter?.name ?? inviter?.email ?? "A teammate",
      role: invite.role,
      pending: isPending(invite),
    };
  },
});

export const acceptByToken = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { subject } = await requireIdentity(ctx);
    const invite = await ctx.db
      .query("invites")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!invite || !isPending(invite)) throw new Error("Invite no longer valid");
    return { workspaceId: await joinWorkspace(ctx, invite, subject) };
  },
});
