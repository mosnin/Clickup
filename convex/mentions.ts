import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireIdentity } from "./_authz";

export const listForCurrent = query({
  args: { unreadOnly: v.optional(v.boolean()) },
  handler: async (ctx, { unreadOnly }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const all = await ctx.db
      .query("mentions")
      .withIndex("by_user", (q) => q.eq("mentionedClerkId", identity.subject))
      .collect();
    const filtered = unreadOnly ? all.filter((m) => !m.readAt) : all;
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const unreadCountForCurrent = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return 0;
    const all = await ctx.db
      .query("mentions")
      .withIndex("by_user", (q) => q.eq("mentionedClerkId", identity.subject))
      .collect();
    return all.filter((m) => !m.readAt).length;
  },
});

export const markRead = mutation({
  args: { mentionId: v.id("mentions") },
  handler: async (ctx, { mentionId }) => {
    const identity = await requireIdentity(ctx);
    const mention = await ctx.db.get(mentionId);
    if (!mention || mention.mentionedClerkId !== identity.subject) return;
    if (!mention.readAt) {
      await ctx.db.patch(mentionId, { readAt: Date.now() });
    }
  },
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    const unread = await ctx.db
      .query("mentions")
      .withIndex("by_user", (q) => q.eq("mentionedClerkId", identity.subject))
      .collect();
    const now = Date.now();
    for (const m of unread) {
      if (!m.readAt) await ctx.db.patch(m._id, { readAt: now });
    }
  },
});
