import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireIdentity } from "./_authz";

// Per-user UI preferences.
//
// There is no save button and no "apply" step: a change is a patch, and every
// tab holding this query re-renders from the same subscription. That is the
// whole reason this lives in Convex rather than in localStorage — someone who
// tunes their sidebar on a laptop should find it tuned on their phone, and
// two windows of the same app should never disagree about what the UI looks
// like.
//
// The stored value is deliberately unvalidated at the schema level and
// normalized on read (src/lib/appearance.ts). A preferences row is the last
// thing that should ever be able to break someone's session: a row written by
// a newer build, or with a key this build has never heard of, has to degrade
// to "the defaults for anything I don't recognise" rather than throw.

export const forCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const row = await ctx.db
      .query("uiPreferences")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .unique();
    return row?.appearance ?? null;
  },
});

export const save = mutation({
  args: { appearance: v.any() },
  handler: async (ctx, { appearance }) => {
    const identity = await requireIdentity(ctx);
    const existing = await ctx.db
      .query("uiPreferences")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { appearance, updatedAt: Date.now() });
      return existing._id;
    }
    return await ctx.db.insert("uiPreferences", {
      userClerkId: identity.subject,
      appearance,
      updatedAt: Date.now(),
    });
  },
});

/** Back to the shipped design — one click, no confirmation to get wrong. */
export const reset = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    const existing = await ctx.db
      .query("uiPreferences")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
