import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";

// Called by the Clerk webhook (user.created / user.updated).
export const upsertFromClerk = internalMutation({
  args: {
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", args.clerkId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        email: args.email,
        name: args.name,
        imageUrl: args.imageUrl,
      });
      return existing._id;
    }

    const userId = await ctx.db.insert("users", {
      clerkId: args.clerkId,
      email: args.email,
      name: args.name,
      imageUrl: args.imageUrl,
    });

    // Every user gets a personal space on first sync.
    await ctx.db.insert("spaces", {
      name: "Personal",
      color: "#6366f1",
      parentType: "user",
      parentId: args.clerkId,
      position: 0,
      createdAt: Date.now(),
    });

    return userId;
  },
});

export const deleteFromClerk = internalMutation({
  args: { clerkId: v.string() },
  handler: async (ctx, { clerkId }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
      .unique();
    if (user) await ctx.db.delete(user._id);
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
    if (!identity) throw new Error("Not authenticated");

    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!existing) {
      await ctx.db.insert("users", {
        clerkId: identity.subject,
        email: identity.email ?? "",
        name: identity.name,
        imageUrl: identity.pictureUrl,
      });
    }

    const personal = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "user").eq("parentId", identity.subject),
      )
      .unique();
    if (!personal) {
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

// Marks the user as onboarded. Wizard calls this last so the
// dashboard's first-run dialog can decide whether to show.
export const completeOnboarding = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
    if (!user) return;
    if (user.onboardedAt) return;
    await ctx.db.patch(user._id, { onboardedAt: Date.now() });
  },
});

// Resolves the caller's personal space — used by the onboarding wizard
// to know where to drop a starter template.
export const personalSpaceId = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const space = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "user").eq("parentId", identity.subject),
      )
      .unique();
    return space?._id ?? null;
  },
});

export const current = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
  },
});

export const listByClerkIds = query({
  args: { clerkIds: v.array(v.string()) },
  handler: async (ctx, { clerkIds }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const results = await Promise.all(
      clerkIds.map((id) =>
        ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", id))
          .unique(),
      ),
    );
    return results.filter((u): u is NonNullable<typeof u> => u !== null);
  },
});
