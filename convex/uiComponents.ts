import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  requireIdentity,
  requireProjectAccess,
  requireScopeAccess,
} from "./_authz";

// Where authored panels are stored.
//
// A panel is a definition (src/lib/panel.ts) — a question, a shape and a look
// — and this file only keeps them. It used to *execute* them too, with its own
// filter implementation and its own four-shape vocabulary. That second
// resolver is gone: `dataStream.resolve` answers every panel now, built-in and
// authored alike, so there is one place a definition is turned into data and
// one vocabulary it is checked against. Two resolvers for one concept is how a
// closed vocabulary stops being closed — the newer one grows a filter the
// older one silently ignores.
//
// Access is checked at the scope on the way in, and a row is checked again on
// the way out. A panel is a query someone else may have written; it must never
// become a way to read across a boundary its author could not cross.

const SCOPE = v.union(v.literal("user"), v.literal("workspace"));

/**
 * Panels this person can put on a screen in this scope.
 *
 * Theirs, plus anything a teammate has shared. Shared panels are OFFERED —
 * they appear in the tray and on nobody's screen — because a panel arriving
 * on your dashboard uninvited is the adaptive-UI mistake in a different hat.
 * Spreading a good panel and changing someone's screen have to stay separate
 * acts.
 */
export const listForScope = query({
  args: { scopeType: SCOPE, scopeId: v.string() },
  handler: async (ctx, { scopeType, scopeId }) => {
    let subject: string;
    try {
      ({ subject } = await requireScopeAccess(ctx, { scopeType, scopeId }));
    } catch {
      return [];
    }
    const mine = await ctx.db
      .query("uiComponents")
      .withIndex("by_owner_and_scope", (q) =>
        q
          .eq("ownerClerkId", subject)
          .eq("scopeType", scopeType)
          .eq("scopeId", scopeId),
      )
      .collect();
    // Everything shared into this scope, whoever owns it. Bounded because a
    // tray is a shelf you scan, not a directory you search.
    const shared = (
      await ctx.db
        .query("uiComponents")
        .withIndex("by_scope", (q) =>
          q.eq("scopeType", scopeType).eq("scopeId", scopeId),
        )
        .take(200)
    ).filter((r) => r.sharedAt !== undefined && r.ownerClerkId !== subject);

    return [...mine, ...shared].map((r) => ({
      componentId: r._id,
      definition: r.definition as unknown,
      authoredByName: r.authoredByName ?? null,
      updatedAt: r.updatedAt,
      mine: r.ownerClerkId === subject,
      shared: r.sharedAt !== undefined,
    }));
  },
});

/**
 * Offer a panel to everyone in its scope, or stop offering it.
 *
 * Only the owner may. Sharing does not copy: the row stays theirs, and a
 * teammate placing it is placing *that* panel — so when the author improves
 * it, everyone who took it gets the improvement. A copy would be a fork that
 * silently stops tracking, which is the same failure as copying down a theme
 * value instead of inheriting it.
 */
export const setShared = mutation({
  args: { componentId: v.id("uiComponents"), shared: v.boolean() },
  handler: async (ctx, { componentId, shared }) => {
    const identity = await requireIdentity(ctx);
    const row = await ctx.db.get(componentId);
    if (!row || row.ownerClerkId !== identity.subject) {
      throw new ConvexError("Panel not found");
    }
    await ctx.db.patch(componentId, {
      sharedAt: shared ? Date.now() : undefined,
      updatedAt: Date.now(),
    });
  },
});

/**
 * One panel, by id.
 *
 * What the in-place inspector reads. It is pointed at a panel by a click on a
 * screen, so all it holds is the widget id — it has no scope, no list, and no
 * business acquiring one just to look up a single row.
 *
 * Answers `null` for a panel that is not yours rather than refusing, because
 * the caller is a rail that may be pointed at a built-in panel with no
 * definition at all; "nothing to edit here" and "not yours" should look the
 * same from outside.
 */
export const get = query({
  args: { componentId: v.string() },
  handler: async (ctx, { componentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    // An id from a DOM attribute is a string of unknown provenance; `db.get`
    // throws on one that is not an id of this table.
    const id = ctx.db.normalizeId("uiComponents", componentId);
    if (!id) return null;
    const row = await ctx.db.get(id);
    if (!row || row.ownerClerkId !== identity.subject) return null;
    return {
      componentId: row._id,
      definition: row.definition as unknown,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      sharedAt: row.sharedAt ?? null,
    };
  },
});

// ── Panels an agent has proposed ────────────────────────────────────────
//
// An agent may AUTHOR a panel; it may never place one. See the note on
// `panelProposals` in the schema for why. Accepting mints the panel into the
// acceptor's own collection and hands the id back, so the client can put it on
// the screen using the layout it is already holding — the server does not know
// whether this person has ever arranged this screen, and writing a layout row
// containing only the new panel would wipe a screen down to one panel.

/** Which project a screen key points at, or null for a kind we don't gate. */
function projectIdFromScreenKey(
  ctx: QueryCtx,
  screenKey: string,
): Id<"projects"> | null {
  if (!screenKey.startsWith("project:")) return null;
  return ctx.db.normalizeId("projects", screenKey.slice("project:".length));
}

/** Panels proposed for a screen and not yet resolved, oldest first. */
export const proposalsFor = query({
  args: { screenKey: v.string() },
  handler: async (ctx, { screenKey }) => {
    // Access-checked against the surface: a proposal carries an agent's name,
    // its reasoning, and a definition describing this workspace's work.
    const projectId = projectIdFromScreenKey(ctx, screenKey);
    if (!projectId) return [];
    try {
      await requireProjectAccess(ctx, projectId);
    } catch {
      return [];
    }
    const rows = await ctx.db
      .query("panelProposals")
      .withIndex("by_screen_and_status", (q) =>
        q.eq("screenKey", screenKey).eq("status", "pending"),
      )
      .collect();
    return rows.map((r) => ({
      proposalId: r._id,
      agentName: r.agentName,
      definition: r.definition as unknown,
      reason: r.reason,
      createdAt: r.createdAt,
    }));
  },
});

/**
 * Accept or dismiss a proposed panel.
 *
 * Accepting creates the panel under the acceptor's own ownership, credited to
 * the agent that wrote it — so it behaves exactly like one they built, and
 * removing it later is an ordinary delete rather than an argument with an
 * agent. Returns the new id; the client places it.
 */
export const resolveProposal = mutation({
  args: { proposalId: v.id("panelProposals"), accept: v.boolean() },
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
    if (!accept) return { componentId: null };

    // Re-checked at accept rather than trusted from propose time: an agent's
    // access can be narrowed between writing a proposal and someone reading it.
    await requireScopeAccess(ctx, {
      scopeType: proposal.scopeType,
      scopeId: proposal.scopeId,
    });

    const now = Date.now();
    const componentId = await ctx.db.insert("uiComponents", {
      ownerClerkId: identity.subject,
      scopeType: proposal.scopeType,
      scopeId: proposal.scopeId,
      definition: proposal.definition,
      authoredByName: proposal.agentName,
      createdAt: now,
      updatedAt: now,
    });
    return { componentId };
  },
});

export const create = mutation({
  args: { scopeType: SCOPE, scopeId: v.string(), definition: v.any() },
  handler: async (ctx, { scopeType, scopeId, definition }) => {
    const { subject } = await requireScopeAccess(ctx, { scopeType, scopeId });
    const now = Date.now();
    return await ctx.db.insert("uiComponents", {
      ownerClerkId: subject,
      scopeType,
      scopeId,
      definition,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: { componentId: v.id("uiComponents"), definition: v.any() },
  handler: async (ctx, { componentId, definition }) => {
    const identity = await requireIdentity(ctx);
    const row = await ctx.db.get(componentId);
    // A panel belongs to whoever authored it; "not found" rather than
    // "forbidden" so an id can't be probed for existence.
    if (!row || row.ownerClerkId !== identity.subject) {
      throw new ConvexError("Panel not found");
    }
    await ctx.db.patch(componentId, { definition, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { componentId: v.id("uiComponents") },
  handler: async (ctx, { componentId }) => {
    const identity = await requireIdentity(ctx);
    const row = await ctx.db.get(componentId);
    if (!row || row.ownerClerkId !== identity.subject) {
      throw new ConvexError("Panel not found");
    }
    await ctx.db.delete(componentId);
  },
});
