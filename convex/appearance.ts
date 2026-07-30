import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  mayGovernSpace,
  requireIdentity,
  requireListAccess,
  requireProjectAccess,
  requireSpaceAccess,
  requireTaskAccess,
} from "./_authz";

// Per-user UI preferences, and the spaces they are resolved against.
//
// There is no save button and no "apply" step: a change is a patch, and every
// tab holding this query re-renders from the same subscription. That is the
// whole reason this lives in Convex rather than in localStorage — someone who
// tunes their sidebar on a laptop should find it tuned on their phone, and two
// windows of the same app should never disagree about what the UI looks like.
// It is also what makes a space being re-themed arrive live for everyone in it.
//
// This file stores and serves patches; it does not resolve them. Precedence —
// which layer beats which, and what a space is allowed to set — lives in
// src/lib/appearance.ts so there is exactly one answer, shared by the client
// and by anything else that ever needs to render these tokens.
//
// The stored values are deliberately unvalidated at the schema level and
// normalized on read. A preferences row is the last thing that should ever be
// able to break someone's session: a row written by a newer build, or with a
// key this build has never heard of, has to degrade to "the defaults for
// anything I don't recognise" rather than throw.

/** Rows written by this build hold sparse patches rather than snapshots. */
const PATCH_VERSION = 2;

export const forCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const row = await ctx.db
      .query("uiPreferences")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .unique();
    if (!row) {
      return {
        personal: null,
        patchVersion: PATCH_VERSION,
        spaceOverrides: {},
        componentStyle: null,
        componentStyleBySpace: {},
        panelStyles: {},
      };
    }
    return {
      personal: row.appearance ?? null,
      componentStyle: row.componentStyle ?? null,
      componentStyleBySpace: (row.componentStyleBySpace ?? {}) as Record<
        string,
        unknown
      >,
      panelStyles: (row.panelStyles ?? {}) as Record<string, unknown>,
      // The client needs this to know whether it is holding a sparse patch or
      // a legacy snapshot it has to interpret.
      patchVersion: row.patchVersion ?? 1,
      spaceOverrides: (row.spaceOverrides ?? {}) as Record<string, unknown>,
    };
  },
});

/**
 * Save the person's own preferences — either everywhere, or for one space.
 *
 * The patch replaces rather than merges. The client holds the whole patch for
 * the scope it is editing, so a merge here would make clearing a key
 * impossible: the absence that means "inherit" would be read as "no change".
 */
export const save = mutation({
  args: {
    patch: v.any(),
    /** Omitted saves the everywhere-preferences; set saves that space only. */
    spaceId: v.optional(v.id("spaces")),
  },
  handler: async (ctx, { patch, spaceId }) => {
    const identity = await requireIdentity(ctx);
    // A per-space override is still the person's own setting, so read access
    // to the space is the right bar — not the governance bar `setTheme` uses.
    if (spaceId) await requireSpaceAccess(ctx, spaceId);

    const existing = await ctx.db
      .query("uiPreferences")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .unique();

    const now = Date.now();
    if (!spaceId) {
      if (existing) {
        await ctx.db.patch(existing._id, {
          appearance: patch,
          patchVersion: PATCH_VERSION,
          updatedAt: now,
        });
        return;
      }
      await ctx.db.insert("uiPreferences", {
        userClerkId: identity.subject,
        appearance: patch,
        patchVersion: PATCH_VERSION,
        spaceOverrides: {},
        updatedAt: now,
      });
      return;
    }

    const overrides = {
      ...((existing?.spaceOverrides ?? {}) as Record<string, unknown>),
    };
    // An empty patch is not an override — storing it would leave a row that
    // reads as "customised" in every "have you changed anything here?" check.
    if (patch && typeof patch === "object" && Object.keys(patch).length > 0) {
      overrides[spaceId] = patch;
    } else {
      delete overrides[spaceId];
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        spaceOverrides: overrides,
        patchVersion: existing.patchVersion ?? PATCH_VERSION,
        updatedAt: now,
      });
      return;
    }
    await ctx.db.insert("uiPreferences", {
      userClerkId: identity.subject,
      appearance: {},
      patchVersion: PATCH_VERSION,
      spaceOverrides: overrides,
      updatedAt: now,
    });
  },
});

/**
 * Back to inherited — one click, no confirmation to get wrong.
 *
 * Without a space this drops the person's global preferences; with one it drops
 * only their divergence from that space, which puts them back on whatever the
 * space currently looks like and keeps them tracking it.
 */
export const reset = mutation({
  args: { spaceId: v.optional(v.id("spaces")) },
  handler: async (ctx, { spaceId }) => {
    const identity = await requireIdentity(ctx);
    const existing = await ctx.db
      .query("uiPreferences")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .unique();
    if (!existing) return;

    if (!spaceId) {
      const overrides = (existing.spaceOverrides ?? {}) as Record<string, unknown>;
      // Keep per-space divergences: "reset my preferences" is not "forget
      // every space I have tuned".
      if (Object.keys(overrides).length > 0) {
        await ctx.db.patch(existing._id, {
          appearance: {},
          patchVersion: PATCH_VERSION,
          updatedAt: Date.now(),
        });
        return;
      }
      await ctx.db.delete(existing._id);
      return;
    }

    const overrides = {
      ...((existing.spaceOverrides ?? {}) as Record<string, unknown>),
    };
    if (!(spaceId in overrides)) return;
    delete overrides[spaceId];
    await ctx.db.patch(existing._id, {
      spaceOverrides: overrides,
      updatedAt: Date.now(),
    });
  },
});

// ── The space a surface belongs to ──────────────────────────────────────

const SURFACE_KIND = v.union(
  v.literal("space"),
  v.literal("project"),
  v.literal("list"),
  v.literal("task"),
);

/**
 * Which space the thing you are looking at lives in, and what it looks like.
 *
 * The provider asks this from the route, because "which room am I in" has to be
 * answerable from a list or a task and not only from the space page — walking
 * into a space's list should look like being in that space. Returns null rather
 * than throwing for anything unresolvable: an id that no longer exists, or one
 * you can't see, should render the app unthemed rather than an error boundary.
 */
export const spaceContext = query({
  args: { kind: SURFACE_KIND, id: v.string() },
  handler: async (ctx, { kind, id }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    let space: Doc<"spaces"> | null = null;
    try {
      if (kind === "space") {
        const normalized = ctx.db.normalizeId("spaces", id);
        if (!normalized) return null;
        space = (await requireSpaceAccess(ctx, normalized)).space;
      } else if (kind === "project") {
        const normalized = ctx.db.normalizeId("projects", id);
        if (!normalized) return null;
        space = (await requireProjectAccess(ctx, normalized)).space;
      } else if (kind === "list") {
        const normalized = ctx.db.normalizeId("lists", id);
        if (!normalized) return null;
        space = (await requireListAccess(ctx, normalized)).space;
      } else {
        const normalized = ctx.db.normalizeId("tasks", id);
        if (!normalized) return null;
        space = (await requireTaskAccess(ctx, normalized)).space;
      }
    } catch {
      return null;
    }

    return {
      spaceId: space._id,
      name: space.name,
      color: space.color ?? null,
      theme: space.theme ?? null,
      /** How this space draws its panels — src/lib/component-style.ts. */
      componentStyle: space.componentStyle ?? null,
      /** Whether this viewer may change the look for everyone in the space. */
      mayTheme: await mayGovernSpace(ctx, space, identity.subject),
    };
  },
});

/**
 * Set how a space looks, for everyone in it.
 *
 * Replaces rather than merges, for the same reason `save` does: an absent key
 * means "inherit", and a merge would make a key impossible to give back.
 * Whether the patch is allowed to contain personal keys is not decided here —
 * the resolver drops them on read, so no write path can smuggle one in.
 */
export const setSpaceTheme = mutation({
  args: { spaceId: v.id("spaces"), theme: v.any() },
  handler: async (ctx, { spaceId, theme }) => {
    const { space, identity } = await requireSpaceAccess(ctx, spaceId);
    if (!(await mayGovernSpace(ctx, space, identity.subject))) {
      throw new ConvexError(
        "Only the space creator or workspace owner can change how this space looks",
      );
    }
    const empty =
      !theme || typeof theme !== "object" || Object.keys(theme).length === 0;
    await ctx.db.patch(space._id, { theme: empty ? undefined : theme });
    return { cleared: empty };
  },
});


// ── Panel style ─────────────────────────────────────────────────────────
//
// Stored beside appearance rather than inside it, because it answers a
// different question — what does a *panel* look like, not what does the app
// look like — and because a space may set every key of it. None of these is an
// accessibility setting; they are all about how one panel is drawn.

/** Save the person's panel style, globally or for one space. */
export const saveComponentStyle = mutation({
  args: { patch: v.any(), spaceId: v.optional(v.id("spaces")) },
  handler: async (ctx, { patch, spaceId }) => {
    const identity = await requireIdentity(ctx);
    const row = await ctx.db
      .query("uiPreferences")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .unique();

    const empty =
      !patch || typeof patch !== "object" || Object.keys(patch).length === 0;

    if (spaceId) {
      // Confirms the space exists and is visible before writing a key for it,
      // so a preferences row cannot accumulate ids its owner cannot see.
      await requireSpaceAccess(ctx, spaceId);
      const current = ((row?.componentStyleBySpace ?? {}) as Record<
        string,
        unknown
      >);
      const next = { ...current };
      // An empty patch deletes the key rather than storing `{}`: absence is
      // what means "inherit", and an empty object is a pinned nothing.
      if (empty) delete next[spaceId];
      else next[spaceId] = patch;
      if (row) {
        await ctx.db.patch(row._id, { componentStyleBySpace: next });
      } else {
        await ctx.db.insert("uiPreferences", {
          userClerkId: identity.subject,
          appearance: {},
          updatedAt: Date.now(),
          patchVersion: PATCH_VERSION,
          componentStyleBySpace: next,
        });
      }
      return;
    }

    if (row) {
      await ctx.db.patch(row._id, {
        componentStyle: empty ? undefined : patch,
        patchVersion: PATCH_VERSION,
      });
    } else if (!empty) {
      await ctx.db.insert("uiPreferences", {
        userClerkId: identity.subject,
        appearance: {},
        updatedAt: Date.now(),
        patchVersion: PATCH_VERSION,
        componentStyle: patch,
      });
    }
  },
});

/** Set how a space draws its panels, for everyone in it. */
export const setSpaceComponentStyle = mutation({
  args: { spaceId: v.id("spaces"), style: v.any() },
  handler: async (ctx, { spaceId, style }) => {
    const { space, identity } = await requireSpaceAccess(ctx, spaceId);
    if (!(await mayGovernSpace(ctx, space, identity.subject))) {
      throw new ConvexError(
        "Only the space creator or workspace owner can change how this space looks",
      );
    }
    const empty =
      !style || typeof style !== "object" || Object.keys(style).length === 0;
    await ctx.db.patch(space._id, { componentStyle: empty ? undefined : style });
    return { cleared: empty };
  },
});


/**
 * Override how one panel is drawn.
 *
 * The narrowest layer, and the one the in-place inspector writes: you point at
 * a panel on your own screen and change that panel. Keyed by widget id and
 * sparse — an empty patch deletes the key rather than storing `{}`, because
 * absence is what lets a later change to the space's look still reach it.
 *
 * Per person, deliberately. Two people looking at the same screen may want
 * different things from the same panel, and that divergence is the product.
 */
export const savePanelStyle = mutation({
  args: { panelId: v.string(), patch: v.any() },
  handler: async (ctx, { panelId, patch }) => {
    const identity = await requireIdentity(ctx);
    const key = panelId.trim().slice(0, 120);
    if (!key) return;

    const row = await ctx.db
      .query("uiPreferences")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .unique();

    const empty =
      !patch || typeof patch !== "object" || Object.keys(patch).length === 0;
    const current = (row?.panelStyles ?? {}) as Record<string, unknown>;
    const next = { ...current };
    if (empty) delete next[key];
    else next[key] = patch;

    if (row) {
      await ctx.db.patch(row._id, { panelStyles: next });
    } else if (!empty) {
      await ctx.db.insert("uiPreferences", {
        userClerkId: identity.subject,
        appearance: {},
        updatedAt: Date.now(),
        patchVersion: PATCH_VERSION,
        panelStyles: next,
      });
    }
  },
});
