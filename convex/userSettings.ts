import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireIdentity } from "./_authz";

// Per-user personalization (Phase L). One row per user; every field is
// optional so absence means "the default experience".

export const current = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return await ctx.db
      .query("userSettings")
      .withIndex("by_clerk", (q) => q.eq("clerkId", identity.subject))
      .first();
  },
});

// Ordered list of visible Home widgets; null restores the default layout.
export const setHomeWidgets = mutation({
  args: { homeWidgets: v.union(v.array(v.string()), v.null()) },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const existing = await ctx.db
      .query("userSettings")
      .withIndex("by_clerk", (q) => q.eq("clerkId", identity.subject))
      .first();
    const homeWidgets = args.homeWidgets ?? undefined;
    if (existing) {
      await ctx.db.patch(existing._id, { homeWidgets });
    } else {
      await ctx.db.insert("userSettings", {
        clerkId: identity.subject,
        homeWidgets,
      });
    }
  },
});
