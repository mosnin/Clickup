import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireIdentity } from "./_authz";

const FRESH_MS = 30_000;
const STALE_MS = 5 * 60_000;

const focusTypeValidator = v.union(
  v.literal("task"),
  v.literal("doc"),
  v.literal("list"),
  v.literal("workspace"),
  v.literal("space"),
);

// Heartbeat upsert. Client sends every 10s while the tab is visible
// and aimed at this entity. The `typing` arg is tri-state by design:
//   - undefined → leave existing flag untouched (page-level heartbeat)
//   - true       → set typing on (composer pulse while typing)
//   - false      → set typing off (composer pulse on idle / blur)
// This lets the page heartbeat run alongside the composer heartbeat
// without the two racing on the typing flag.
//
// Authorization-light: presence leaks nothing useful (worst case is a
// coarse "someone is on a task with this id"). listForFocus is the
// gate.
export const heartbeat = mutation({
  args: {
    focusType: focusTypeValidator,
    focusId: v.string(),
    typing: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const existing = await ctx.db
      .query("presence")
      .withIndex("by_user_focus", (q) =>
        q
          .eq("userClerkId", identity.subject)
          .eq("focusType", args.focusType)
          .eq("focusId", args.focusId),
      )
      .unique();
    const now = Date.now();
    if (existing) {
      const patch: Record<string, unknown> = { lastSeenAt: now };
      if (args.typing !== undefined) patch.typing = args.typing;
      await ctx.db.patch(existing._id, patch);
      return;
    }
    await ctx.db.insert("presence", {
      userClerkId: identity.subject,
      focusType: args.focusType,
      focusId: args.focusId,
      typing: args.typing,
      lastSeenAt: now,
    });
  },
});

// Optional explicit clear — fired from `pagehide` / unmount so the
// avatar fades out instantly rather than waiting for the freshness
// window. Failure is non-fatal; the sweep cron picks up stragglers.
export const clear = mutation({
  args: { focusType: focusTypeValidator, focusId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return;
    const row = await ctx.db
      .query("presence")
      .withIndex("by_user_focus", (q) =>
        q
          .eq("userClerkId", identity.subject)
          .eq("focusType", args.focusType)
          .eq("focusId", args.focusId),
      )
      .unique();
    if (row) await ctx.db.delete(row._id);
  },
});

// Returns the users currently focused on the given entity (within the
// freshness window), excluding the caller. Joins to the users table so
// the UI can render names + avatars without a second round-trip.
export const listForFocus = query({
  args: { focusType: focusTypeValidator, focusId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const cutoff = Date.now() - FRESH_MS;
    const rows = await ctx.db
      .query("presence")
      .withIndex("by_focus", (q) =>
        q
          .eq("focusType", args.focusType)
          .eq("focusId", args.focusId)
          .gt("lastSeenAt", cutoff),
      )
      .collect();
    const others = rows.filter((r) => r.userClerkId !== identity.subject);
    const users = await Promise.all(
      others.map(async (r) => {
        const u = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", r.userClerkId))
          .unique();
        return u
          ? {
              clerkId: u.clerkId,
              name: u.name ?? u.email,
              email: u.email,
              imageUrl: u.imageUrl,
              typing: r.typing === true,
            }
          : null;
      }),
    );
    return users.filter(
      (u): u is NonNullable<typeof u> => u !== null,
    );
  },
});

// Cron sweep: drop rows older than STALE_MS. Cheap full-table scan;
// presence is a small, ephemeral table.
export const sweepStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - STALE_MS;
    const stale = await ctx.db.query("presence").collect();
    for (const r of stale) {
      if (r.lastSeenAt < cutoff) await ctx.db.delete(r._id);
    }
  },
});
