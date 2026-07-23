// Per-user starred items powering the sidebar Favorites rail. A favorite is
// a (userClerkId, entityType, entityId) pin over a list, space, doc, or
// whiteboard the user can already access — pinning never grants access, it
// just remembers a shortcut. `toggle` re-checks access on every call (not
// just at pin time) so a favorite silently stops resolving the moment the
// underlying access is revoked; `listForCurrentUser` skips rows that no
// longer resolve rather than deleting them (queries can't write).
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  requireDocLikeParentAccess,
  requireIdentity,
  requireListAccess,
  requireSpaceAccess,
} from "./_authz";

const entityTypeValidator = v.union(
  v.literal("list"),
  v.literal("space"),
  v.literal("doc"),
  v.literal("whiteboard"),
);

type EntityType = Doc<"favorites">["entityType"];

// Confirms the current identity can access the given entity, following the
// same authorization path each entity type's own module uses for reads
// (requireListAccess / requireSpaceAccess / requireDocLikeParentAccess).
// Returns false (never throws) for a missing entity or a denied access
// check, so callers can turn it into a clean user-facing refusal.
async function canAccessEntity(
  ctx: MutationCtx | QueryCtx,
  entityType: EntityType,
  entityId: string,
): Promise<boolean> {
  try {
    if (entityType === "list") {
      await requireListAccess(ctx, entityId as Id<"lists">);
      return true;
    }
    if (entityType === "space") {
      await requireSpaceAccess(ctx, entityId as Id<"spaces">);
      return true;
    }
    if (entityType === "doc") {
      const doc = await ctx.db.get(entityId as Id<"docs">);
      if (!doc) return false;
      await requireDocLikeParentAccess(ctx, doc.parentType, doc.parentId);
      return true;
    }
    // whiteboard
    const whiteboard = await ctx.db.get(entityId as Id<"whiteboards">);
    if (!whiteboard) return false;
    await requireDocLikeParentAccess(
      ctx,
      whiteboard.parentType,
      whiteboard.parentId,
    );
    return true;
  } catch {
    return false;
  }
}

export const toggle = mutation({
  args: { entityType: entityTypeValidator, entityId: v.string() },
  handler: async (ctx, { entityType, entityId }) => {
    const identity = await requireIdentity(ctx);

    const existing = await ctx.db
      .query("favorites")
      .withIndex("by_user_entity", (q) =>
        q
          .eq("userClerkId", identity.subject)
          .eq("entityType", entityType)
          .eq("entityId", entityId),
      )
      .unique();

    if (existing) {
      // Un-favoriting something you can no longer see is always allowed —
      // only *adding* a favorite requires a fresh access check.
      await ctx.db.delete(existing._id);
      return { favorited: false };
    }

    if (!(await canAccessEntity(ctx, entityType, entityId))) {
      throw new Error("Not found or access denied");
    }

    const mine = await ctx.db
      .query("favorites")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .collect();

    await ctx.db.insert("favorites", {
      userClerkId: identity.subject,
      entityType,
      entityId,
      position: mine.length,
      createdAt: Date.now(),
    });
    return { favorited: true };
  },
});

export const isFavorite = query({
  args: { entityType: entityTypeValidator, entityId: v.string() },
  handler: async (ctx, { entityType, entityId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;
    const existing = await ctx.db
      .query("favorites")
      .withIndex("by_user_entity", (q) =>
        q
          .eq("userClerkId", identity.subject)
          .eq("entityType", entityType)
          .eq("entityId", entityId),
      )
      .unique();
    return existing !== null;
  },
});

export type FavoriteRow = {
  entityType: EntityType;
  entityId: string;
  name: string;
  href: string;
  color?: string;
};

async function resolveFavorite(
  ctx: QueryCtx,
  row: Doc<"favorites">,
): Promise<FavoriteRow | null> {
  if (row.entityType === "list") {
    const list = await ctx.db.get(row.entityId as Id<"lists">);
    if (!list) return null;
    try {
      await requireListAccess(ctx, list._id);
    } catch {
      return null;
    }
    return {
      entityType: "list",
      entityId: row.entityId,
      name: list.name,
      href: `/dashboard/l/${list._id}`,
      color: list.color,
    };
  }
  if (row.entityType === "space") {
    const space = await ctx.db.get(row.entityId as Id<"spaces">);
    if (!space) return null;
    try {
      await requireSpaceAccess(ctx, space._id);
    } catch {
      return null;
    }
    return {
      entityType: "space",
      entityId: row.entityId,
      name: space.name,
      href: `/dashboard/s/${space._id}`,
      color: space.color,
    };
  }
  if (row.entityType === "doc") {
    const doc = await ctx.db.get(row.entityId as Id<"docs">);
    if (!doc) return null;
    try {
      await requireDocLikeParentAccess(ctx, doc.parentType, doc.parentId);
    } catch {
      return null;
    }
    return {
      entityType: "doc",
      entityId: row.entityId,
      name: doc.title,
      href: `/dashboard/d/${doc._id}`,
    };
  }
  // whiteboard
  const whiteboard = await ctx.db.get(row.entityId as Id<"whiteboards">);
  if (!whiteboard) return null;
  try {
    await requireDocLikeParentAccess(
      ctx,
      whiteboard.parentType,
      whiteboard.parentId,
    );
  } catch {
    return null;
  }
  return {
    entityType: "whiteboard",
    entityId: row.entityId,
    name: whiteboard.title,
    href: `/dashboard/wb/${whiteboard._id}`,
  };
}

export const listForCurrentUser = query({
  args: {},
  handler: async (ctx, {}): Promise<FavoriteRow[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const rows = await ctx.db
      .query("favorites")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .collect();

    const out: FavoriteRow[] = [];
    for (const row of rows.sort((a, b) => a.position - b.position)) {
      const resolved = await resolveFavorite(ctx, row);
      if (resolved) out.push(resolved);
    }
    return out;
  },
});
