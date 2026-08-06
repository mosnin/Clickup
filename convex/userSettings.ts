import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireIdentity, requireListAccess } from "./_authz";

// Per-user personalization (Phase L). One row per user; every field is
// optional so absence means "the default experience".

// The whole row, including `listViewSettings` — the per-list view
// customization the hook in src/lib/use-view-settings.ts falls back to
// before localStorage.
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
  args: {
    homeWidgets: v.union(v.array(v.string()), v.null()),
    /** Widths by widget id. Omitted leaves them alone; null clears them. */
    spans: v.optional(v.union(v.any(), v.null())),
    /** Heights by widget id, same contract as spans. */
    rows: v.optional(v.union(v.any(), v.null())),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const existing = await ctx.db
      .query("userSettings")
      .withIndex("by_clerk", (q) => q.eq("clerkId", identity.subject))
      .first();
    const homeWidgets = args.homeWidgets ?? undefined;
    // Only widths this build understands, so a row written by a newer one
    // can't put a widget at span 7.
    let homeWidgetSpans: Record<string, number> | undefined;
    if (args.spans === null) {
      homeWidgetSpans = undefined;
    } else if (args.spans && typeof args.spans === "object") {
      homeWidgetSpans = {};
      for (const [id, span] of Object.entries(
        args.spans as Record<string, unknown>,
      )) {
        if (span === 1 || span === 2 || span === 3) homeWidgetSpans[id] = span;
      }
    }
    // Same shape as spans: only heights this build understands, so a row
    // written by a newer one cannot put a panel at nine rows tall. Six steps
    // since the 6rem row unit — the old 1–3 clamp silently dropped every
    // drag past three rows, so tall tiles snapped back on the next
    // subscription update while the mutation reported success.
    let homeWidgetRows: Record<string, number> | undefined;
    if (args.rows === null) {
      homeWidgetRows = undefined;
    } else if (args.rows && typeof args.rows === "object") {
      homeWidgetRows = {};
      for (const [id, value] of Object.entries(
        args.rows as Record<string, unknown>,
      )) {
        if (
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 1 &&
          value <= 6
        ) {
          homeWidgetRows[id] = value;
        }
      }
      // The record carries its own unit version: rows stored before the
      // 6rem row unit (no marker) are in 10.5rem units and are rescaled on
      // read — see migrateStoredRows in src/lib/screen-layout.ts.
      homeWidgetRows.__v = 2;
    }

    const patch = {
      homeWidgets,
      ...(args.spans === undefined ? {} : { homeWidgetSpans }),
      ...(args.rows === undefined ? {} : { homeWidgetRows }),
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("userSettings", {
        clerkId: identity.subject,
        ...patch,
      });
    }
  },
});

// One person can visit a lot of lists; without a cap this array would grow
// forever inside a single document. 50 most-recently-touched lists is far
// more than anyone actively customizes, and the oldest entry falls off.
export const MAX_LIST_VIEW_SETTINGS = 50;

/**
 * Remember (or forget) one list's "Customize view" setup for this user.
 *
 * `settings` is the compact `vs`/`vf` query-string encoding produced by
 * src/lib/view-settings.ts — the server stores it opaquely, so adding a
 * toggle to the panel needs no backend change. An empty string means "back
 * to the defaults" and drops the entry rather than storing a no-op row.
 *
 * The touched list is moved to the front, so the cap evicts the list you
 * customized longest ago instead of the one you're using right now.
 */
export const setListViewSettings = mutation({
  args: { listId: v.id("lists"), settings: v.string() },
  handler: async (ctx, { listId, settings }) => {
    const identity = await requireIdentity(ctx);
    // Reading a list you can't access would leak nothing here (we never read
    // the list), but storing a preference for it is pointless — the
    // hierarchy check keeps the array honest.
    await requireListAccess(ctx, listId);

    const existing = await ctx.db
      .query("userSettings")
      .withIndex("by_clerk", (q) => q.eq("clerkId", identity.subject))
      .first();

    const others = (existing?.listViewSettings ?? []).filter(
      (row) => row.listId !== listId,
    );
    const trimmed = settings.trim();
    const next = (trimmed ? [{ listId, settings: trimmed }, ...others] : others)
      .slice(0, MAX_LIST_VIEW_SETTINGS);

    if (existing) {
      await ctx.db.patch(existing._id, { listViewSettings: next });
    } else if (next.length > 0) {
      await ctx.db.insert("userSettings", {
        clerkId: identity.subject,
        listViewSettings: next,
      });
    }
  },
});
