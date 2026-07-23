import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireIdentity } from "./_authz";

// The in-app notification feed. Rows are written inside the same
// transaction as the thing they announce (assignment, mention, approval
// request, invite, due-soon/overdue) via the `notify` helper below, so the
// Inbox is always consistent with the data it points at.

export async function notify(
  ctx: MutationCtx,
  n: {
    userClerkId: string;
    type: string;
    title: string;
    body?: string;
    href?: string;
  },
): Promise<void> {
  await ctx.db.insert("notifications", { ...n, createdAt: Date.now() });
}

export const listForCurrent = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    return await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .order("desc")
      .take(50);
  },
});

export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return 0;
    // Recent window is enough for a badge; caps the scan.
    const recent = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .order("desc")
      .take(100);
    return recent.filter((n) => n.readAt === undefined).length;
  },
});

export const markRead = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, { notificationId }) => {
    const { subject } = await requireIdentity(ctx);
    const n = await ctx.db.get(notificationId);
    if (!n || n.userClerkId !== subject) throw new Error("Not found");
    if (n.readAt === undefined) {
      await ctx.db.patch(notificationId, { readAt: Date.now() });
    }
  },
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const { subject } = await requireIdentity(ctx);
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userClerkId", subject))
      .order("desc")
      .take(200);
    for (const n of unread) {
      if (n.readAt === undefined) {
        await ctx.db.patch(n._id, { readAt: Date.now() });
      }
    }
  },
});
