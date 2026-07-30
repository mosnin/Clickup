import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireIdentity, requireProjectAccess } from "./_authz";

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

// ── Proposals ───────────────────────────────────────────────────────────
//
// The layout is data, so an agent can author a better one — but authoring is
// all it gets. A proposal is shown with its reason, previewed as a morph, and
// applied only by a person accepting it. Acceptance writes the ACCEPTOR's
// layout: layouts are per-person, so "accept" means "arrange it this way for
// me", not "for everyone".

/** Which project a screen key points at, or null for a kind we don't gate. */
function projectIdFromScreenKey(
  ctx: { db: { normalizeId: (table: "projects", id: string) => Id<"projects"> | null } },
  screenKey: string,
): Id<"projects"> | null {
  if (!screenKey.startsWith("project:")) return null;
  return ctx.db.normalizeId("projects", screenKey.slice("project:".length));
}

/** Pending proposals for a screen, oldest first. */
export const proposalsFor = query({
  args: { screenKey: v.string() },
  handler: async (ctx, { screenKey }) => {
    // Access-checked against the surface the screen shows: a proposal reveals
    // an agent's name and reasoning, which is workspace-internal.
    const projectId = projectIdFromScreenKey(ctx, screenKey);
    if (!projectId) return [];
    try {
      await requireProjectAccess(ctx, projectId);
    } catch {
      return [];
    }
    const rows = await ctx.db
      .query("screenProposals")
      .withIndex("by_screen_and_status", (q) =>
        q.eq("screenKey", screenKey).eq("status", "pending"),
      )
      .collect();
    return rows.map((r) => ({
      proposalId: r._id,
      agentName: r.agentName,
      layout: r.layout as unknown,
      reason: r.reason,
      createdAt: r.createdAt,
    }));
  },
});

/**
 * Accept or dismiss a proposal.
 *
 * One resolution per proposal, by whoever acts first — the same contract as a
 * suggestion in a document. Accepting also writes the acceptor's layout, so
 * the one gesture both resolves the suggestion and applies it.
 */
export const resolveProposal = mutation({
  args: { proposalId: v.id("screenProposals"), accept: v.boolean() },
  handler: async (ctx, { proposalId, accept }) => {
    const identity = await requireIdentity(ctx);
    const proposal = await ctx.db.get(proposalId);
    if (!proposal || proposal.status !== "pending") {
      throw new ConvexError("That suggestion has already been handled");
    }
    const projectId = projectIdFromScreenKey(ctx, proposal.screenKey);
    if (!projectId) throw new ConvexError("Unknown screen");
    await requireProjectAccess(ctx, projectId);

    await ctx.db.patch(proposal._id, {
      status: accept ? "accepted" : "dismissed",
      resolvedAt: Date.now(),
      resolvedByClerkId: identity.subject,
    });

    if (accept) {
      const existing = await ctx.db
        .query("screenLayouts")
        .withIndex("by_user_and_screen", (q) =>
          q
            .eq("userClerkId", identity.subject)
            .eq("screenKey", proposal.screenKey),
        )
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          layout: proposal.layout,
          updatedAt: Date.now(),
        });
      } else {
        await ctx.db.insert("screenLayouts", {
          userClerkId: identity.subject,
          screenKey: proposal.screenKey,
          layout: proposal.layout,
          updatedAt: Date.now(),
        });
      }
    }
  },
});
