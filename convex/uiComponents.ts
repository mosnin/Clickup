import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireIdentity, requireScopeAccess } from "./_authz";

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

/** Panels this person can put on a screen in this scope. */
export const listForScope = query({
  args: { scopeType: SCOPE, scopeId: v.string() },
  handler: async (ctx, { scopeType, scopeId }) => {
    let subject: string;
    try {
      ({ subject } = await requireScopeAccess(ctx, { scopeType, scopeId }));
    } catch {
      return [];
    }
    const rows = await ctx.db
      .query("uiComponents")
      .withIndex("by_owner_and_scope", (q) =>
        q
          .eq("ownerClerkId", subject)
          .eq("scopeType", scopeType)
          .eq("scopeId", scopeId),
      )
      .collect();
    return rows.map((r) => ({
      componentId: r._id,
      definition: r.definition as unknown,
      authoredByName: r.authoredByName ?? null,
      updatedAt: r.updatedAt,
    }));
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
    };
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
