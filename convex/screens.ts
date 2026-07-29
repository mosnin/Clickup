import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireIdentity } from "./_authz";

// Per-user screen layouts.
//
// Deliberately dumb storage: this file does not know what a widget is, what
// spans are legal, or which widgets exist in the build asking for them. All of
// that is versioned client code (src/lib/screen-layout.ts + the widget
// registry), and putting it here would mean a schema migration every time
// someone adds a panel.
//
// The consequence is the contract: a layout is normalized *on read by the
// client*, against the set of widgets that client can actually render. A
// layout referencing a widget this build has never heard of renders without
// it rather than failing.

export const layoutFor = query({
  args: { screenKey: v.string() },
  handler: async (ctx, { screenKey }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const row = await ctx.db
      .query("screenLayouts")
      .withIndex("by_user_and_screen", (q) =>
        q.eq("userClerkId", identity.subject).eq("screenKey", screenKey),
      )
      .unique();
    // null means "never customised", which is different from a customised
    // layout that happens to be empty — the UI needs to tell those apart to
    // know whether to show the defaults.
    return row ? { layout: row.layout, updatedAt: row.updatedAt } : null;
  },
});

export const saveLayout = mutation({
  args: { screenKey: v.string(), layout: v.any() },
  handler: async (ctx, { screenKey, layout }) => {
    const identity = await requireIdentity(ctx);
    const existing = await ctx.db
      .query("screenLayouts")
      .withIndex("by_user_and_screen", (q) =>
        q.eq("userClerkId", identity.subject).eq("screenKey", screenKey),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { layout, updatedAt: Date.now() });
      return existing._id;
    }
    return await ctx.db.insert("screenLayouts", {
      userClerkId: identity.subject,
      screenKey,
      layout,
      updatedAt: Date.now(),
    });
  },
});

/** Back to the default composition for this screen. */
export const resetLayout = mutation({
  args: { screenKey: v.string() },
  handler: async (ctx, { screenKey }) => {
    const identity = await requireIdentity(ctx);
    const existing = await ctx.db
      .query("screenLayouts")
      .withIndex("by_user_and_screen", (q) =>
        q.eq("userClerkId", identity.subject).eq("screenKey", screenKey),
      )
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
