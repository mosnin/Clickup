import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { hasNamedPersonalSpace } from "./_userSpaces";

// Convex indexes are not unique constraints. The Clerk webhook and
// users.ensureCurrent can both insert a users row (and a Personal space)
// on first login; .unique() then throws on every later visit. Home's
// useQuery rethrows that during render. Prefer .first() for clerkId
// lookups — one of the rows is enough to proceed.
async function userByClerkId(ctx: QueryCtx | MutationCtx, clerkId: string) {
  return await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
    .first();
}

// Called by the Clerk webhook (user.created / user.updated).
export const upsertFromClerk = internalMutation({
  args: {
    clerkId: v.string(),
    email: v.string(),
    emailVerified: v.boolean(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Store emails lowercased so the by_email index is a reliable lookup key
    // (admin grants, mention resolution). Emails are case-insensitive in
    // practice, and the env-allowlist admin check already lowercases.
    const email = args.email.toLowerCase();
    const existing = await userByClerkId(ctx, args.clerkId);

    if (existing) {
      await ctx.db.patch(existing._id, {
        email,
        emailVerified: args.emailVerified,
        name: args.name,
        imageUrl: args.imageUrl,
      });
      return existing._id;
    }

    const userId = await ctx.db.insert("users", {
      clerkId: args.clerkId,
      email,
      emailVerified: args.emailVerified,
      name: args.name,
      imageUrl: args.imageUrl,
    });

    // Seed the default Personal space only. Extra user-scoped spaces
    // (company spaces created via spaces.create) must stay; .unique()
    // on this index is what crashed Home.
    if (!(await hasNamedPersonalSpace(ctx, args.clerkId))) {
      await ctx.db.insert("spaces", {
        name: "Personal",
        color: "#6366f1",
        parentType: "user",
        parentId: args.clerkId,
        position: 0,
        createdAt: Date.now(),
      });
    }

    return userId;
  },
});

export const deleteFromClerk = internalMutation({
  args: { clerkId: v.string() },
  handler: async (ctx, { clerkId }) => {
    const rows = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
      .collect();
    for (const user of rows) await ctx.db.delete(user._id);
  },
});

// Idempotent client-callable bootstrap. The Clerk webhook is the canonical
// source of user records, but this mutation lets the dashboard self-heal
// when a user lands before the webhook has fired (e.g. local dev without
// public webhook delivery).
export const ensureCurrent = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Not authenticated");

    const existing = await userByClerkId(ctx, identity.subject);

    if (!existing) {
      await ctx.db.insert("users", {
        clerkId: identity.subject,
        email: (identity.email ?? "").toLowerCase(),
        // The self-healing path cannot independently prove the email. The
        // signed Clerk webhook upgrades this once the primary address is
        // verified, so UserInfo never asserts a fact we did not receive.
        emailVerified: false,
        name: identity.name,
        imageUrl: identity.pictureUrl,
      });
    }

    if (!(await hasNamedPersonalSpace(ctx, identity.subject))) {
      await ctx.db.insert("spaces", {
        name: "Personal",
        color: "#6366f1",
        parentType: "user",
        parentId: identity.subject,
        position: 0,
        createdAt: Date.now(),
      });
    }
  },
});

export const current = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return await userByClerkId(ctx, identity.subject);
  },
});

export const listByClerkIds = query({
  args: { clerkIds: v.array(v.string()) },
  handler: async (ctx, { clerkIds }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const myMemberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .collect();
    const myWorkspaces = new Set(
      myMemberships.map((m) => m.workspaceId as string),
    );
    const results = [];
    for (const id of clerkIds) {
      if (id !== identity.subject) {
        const theirMemberships = await ctx.db
          .query("memberships")
          .withIndex("by_user", (q) => q.eq("userClerkId", id))
          .collect();
        const shared = theirMemberships.some((m) =>
          myWorkspaces.has(m.workspaceId as string),
        );
        if (!shared) continue;
      }
      const user = await userByClerkId(ctx, id);
      if (user) results.push(user);
    }
    return results;
  },
});
