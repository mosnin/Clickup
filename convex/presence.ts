import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { Actor } from "./_agentAuth";
import {
  requireIdentity,
  requireListAccess,
  requirePageAccess,
  requireProjectAccess,
  requireScopeAccess,
  requireSpaceAccess,
  requireTaskAccess,
} from "./_authz";

// Who is on a surface right now.
//
// The version of this that existed before covered one surface and one kind of
// principal: people, on pages, and nothing rendered it. The interesting half was
// missing. An agent's work was *reported* — a heartbeat and a "now working on"
// string in a dashboard about agents — while the surface it was actually
// changing showed no sign of it. Watching the machine work beside you in the
// same place is the whole difference between an automation and a colleague, so
// presence has to be a property of every surface and both kinds of principal.
//
// Deliberately a plain table with a freshness window rather than a realtime
// service. Convex pushes query results to every subscriber, so a heartbeat row
// is already a live feed, and there is no second system to authenticate or keep
// in sync. Ably carries what a query can't — a caret moving between keystrokes —
// and this is not that.

/** A row older than this is gone. Two missed heartbeats. */
export const PRESENCE_TTL_MS = 45_000;

/** How stale a row must be before a passing writer sweeps it. */
const SWEEP_AFTER_MS = PRESENCE_TTL_MS * 4;

export const SURFACE_TYPE = v.union(
  v.literal("page"),
  v.literal("task"),
  v.literal("list"),
  v.literal("project"),
  v.literal("space"),
  // The Chat side's community surface (07-integration-map §3, §9). Its id is
  // `"<scopeType>:<scopeId>"` — a scope, not a document — so it needs the one
  // branch in `requireSurface` below and nothing else here.
  v.literal("community"),
);

export type SurfaceType =
  | "page"
  | "task"
  | "list"
  | "project"
  | "space"
  | "community";

/**
 * Confirm the caller can be on this surface at all.
 *
 * Routed through the same helpers every other read uses, so presence can never
 * become the one query that answers "who is in the space you can't see" — the
 * names of a workspace's members are exactly the sort of thing a leak like that
 * would hand over.
 */
async function requireSurface(
  ctx: QueryCtx | MutationCtx,
  surfaceType: SurfaceType,
  surfaceId: string,
): Promise<void> {
  if (surfaceType === "page") {
    const id = ctx.db.normalizeId("pages", surfaceId);
    if (!id) throw new Error("Not found");
    await requirePageAccess(ctx, id);
    return;
  }
  if (surfaceType === "task") {
    const id = ctx.db.normalizeId("tasks", surfaceId);
    if (!id) throw new Error("Not found");
    await requireTaskAccess(ctx, id);
    return;
  }
  if (surfaceType === "list") {
    const id = ctx.db.normalizeId("lists", surfaceId);
    if (!id) throw new Error("Not found");
    await requireListAccess(ctx, id);
    return;
  }
  if (surfaceType === "project") {
    const id = ctx.db.normalizeId("projects", surfaceId);
    if (!id) throw new Error("Not found");
    await requireProjectAccess(ctx, id);
    return;
  }
  if (surfaceType === "community") {
    // A Chat community is a scope rather than a document (00-decisions D4), so
    // its surface id is the pair `_authz` already speaks, joined by a colon.
    // The scope check is the whole fence: presence is community-wide, never
    // room-wide, precisely so this branch cannot become a way to learn who is
    // standing in a private room.
    const separator = surfaceId.indexOf(":");
    const scopeType = surfaceId.slice(0, separator);
    const scopeId = surfaceId.slice(separator + 1);
    if (scopeType !== "user" && scopeType !== "workspace") throw new Error("Not found");
    await requireScopeAccess(ctx, { scopeType, scopeId });
    return;
  }
  const id = ctx.db.normalizeId("spaces", surfaceId);
  if (!id) throw new Error("Not found");
  await requireSpaceAccess(ctx, id);
}

/**
 * Record that an actor is here.
 *
 * Shared by the human heartbeat and every agent path, so an agent appears the
 * same way a person does rather than through a parallel implementation that
 * renders differently. Never throws on the agent side of things: presence is
 * decoration on a real operation, and failing to announce yourself must not
 * fail the write you were announcing.
 */
export async function markPresence(
  ctx: MutationCtx,
  surfaceType: SurfaceType,
  surfaceId: string,
  actor: Actor,
  opts: { editing: boolean; detail?: string },
): Promise<void> {
  // A system actor is a cron, and nobody wants to see the clock in the rail.
  if (actor.type === "system") return;

  const now = Date.now();
  const existing = await ctx.db
    .query("presence")
    .withIndex("by_surface_and_actor", (q) =>
      q
        .eq("surfaceType", surfaceType)
        .eq("surfaceId", surfaceId)
        .eq("actorId", actor.id),
    )
    .unique();

  const row = {
    surfaceType,
    surfaceId,
    actorId: actor.id,
    actorType: actor.type as "user" | "agent",
    name: actor.name,
    editing: opts.editing,
    detail: opts.detail?.slice(0, 120) || undefined,
    updatedAt: now,
  };
  if (existing) {
    await ctx.db.patch(existing._id, row);
  } else {
    await ctx.db.insert("presence", row);
  }

  // Opportunistic cleanup: whoever writes also clears whoever has aged out, so
  // stale rows never accumulate and no cron is involved.
  const others = await ctx.db
    .query("presence")
    .withIndex("by_surface", (q) =>
      q.eq("surfaceType", surfaceType).eq("surfaceId", surfaceId),
    )
    .collect();
  for (const r of others) {
    if (r._id !== existing?._id && now - r.updatedAt > SWEEP_AFTER_MS) {
      await ctx.db.delete(r._id);
    }
  }
}

/** The human heartbeat: "I am looking at this, and here is whether I'm typing." */
export const heartbeat = mutation({
  args: {
    surfaceType: SURFACE_TYPE,
    surfaceId: v.string(),
    name: v.string(),
    editing: v.boolean(),
  },
  handler: async (ctx, { surfaceType, surfaceId, name, editing }) => {
    const identity = await requireIdentity(ctx);
    await requireSurface(ctx, surfaceType, surfaceId);
    await markPresence(
      ctx,
      surfaceType,
      surfaceId,
      { type: "user", id: identity.subject, name },
      { editing },
    );
  },
});

/** Stop being here, without waiting out the window. */
export const leave = mutation({
  args: { surfaceType: SURFACE_TYPE, surfaceId: v.string() },
  handler: async (ctx, { surfaceType, surfaceId }) => {
    const identity = await requireIdentity(ctx);
    const existing = await ctx.db
      .query("presence")
      .withIndex("by_surface_and_actor", (q) =>
        q
          .eq("surfaceType", surfaceType)
          .eq("surfaceId", surfaceId)
          .eq("actorId", identity.subject),
      )
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

export type Viewer = {
  actorId: string;
  actorType: "user" | "agent";
  name: string;
  editing: boolean;
  detail: string | null;
  /** Seconds since their last sign of life, for a fading indicator. */
  age: number;
};

/**
 * Everyone on this surface but you.
 *
 * Excluding yourself is not a detail: a rail that shows your own avatar reads as
 * "someone else is here" at a glance, which is the one thing it exists to tell
 * you. Returns an empty list rather than throwing on a surface you can't open,
 * so a stale link renders a quiet page instead of an error boundary.
 */
export const viewers = query({
  args: { surfaceType: SURFACE_TYPE, surfaceId: v.string() },
  handler: async (ctx, { surfaceType, surfaceId }): Promise<Viewer[]> => {
    try {
      await requireIdentity(ctx);
      await requireSurface(ctx, surfaceType, surfaceId);
    } catch {
      return [];
    }
    return await readViewers(ctx, surfaceType, surfaceId);
  },
});

/**
 * The read itself, minus the access check.
 *
 * Separate so a surface that has already established access — a page editor
 * that just loaded the page — can reuse it without paying for the walk twice,
 * and so there is one definition of "who is here" rather than one per caller.
 */
export async function readViewers(
  ctx: QueryCtx,
  surfaceType: SurfaceType,
  surfaceId: string,
): Promise<Viewer[]> {
  const identity = await ctx.auth.getUserIdentity();
  const subject = identity?.subject ?? "";
  {
    const now = Date.now();
    const rows = await ctx.db
      .query("presence")
      .withIndex("by_surface", (q) =>
        q.eq("surfaceType", surfaceType).eq("surfaceId", surfaceId),
      )
      .collect();
    return rows
      .filter((r) => now - r.updatedAt < PRESENCE_TTL_MS && r.actorId !== subject)
      .sort((a, b) => {
        // Agents first, and whoever is typing above whoever is reading: the rail
        // is read left to right and the machine at work is the news.
        if (a.actorType !== b.actorType) return a.actorType === "agent" ? -1 : 1;
        if (a.editing !== b.editing) return a.editing ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((r) => ({
        actorId: r.actorId,
        actorType: r.actorType,
        name: r.name,
        editing: r.editing,
        detail: r.detail ?? null,
        age: Math.round((now - r.updatedAt) / 1000),
      }));
  }
}

/**
 * Where an agent is, for the surfaces that talk about agents rather than to
 * them — Mission Control, a task's rail, the fleet view.
 */
export const forActor = query({
  args: { actorId: v.string() },
  handler: async (ctx, { actorId }) => {
    await requireIdentity(ctx);
    const now = Date.now();
    const rows = await ctx.db
      .query("presence")
      .withIndex("by_actor", (q) => q.eq("actorId", actorId))
      .collect();
    const live = rows.filter((r) => now - r.updatedAt < PRESENCE_TTL_MS);
    // Access-check each surface, so this cannot be used to learn that an agent
    // is working somewhere the caller can't see.
    const out: {
      surfaceType: SurfaceType;
      surfaceId: string;
      editing: boolean;
      detail: string | null;
    }[] = [];
    for (const r of live) {
      try {
        await requireSurface(ctx, r.surfaceType, r.surfaceId);
      } catch {
        continue;
      }
      out.push({
        surfaceType: r.surfaceType,
        surfaceId: r.surfaceId,
        editing: r.editing,
        detail: r.detail ?? null,
      });
    }
    return out;
  },
});

/**
 * One actor stops being on one surface.
 *
 * Used where an agent explicitly puts something down — releasing a claim — so
 * the rail empties immediately rather than showing a machine at work on
 * something it has walked away from for the next forty-five seconds.
 */
export async function clearActorPresence(
  ctx: MutationCtx,
  surfaceType: SurfaceType,
  surfaceId: string,
  actorId: string,
): Promise<void> {
  const existing = await ctx.db
    .query("presence")
    .withIndex("by_surface_and_actor", (q) =>
      q
        .eq("surfaceType", surfaceType)
        .eq("surfaceId", surfaceId)
        .eq("actorId", actorId),
    )
    .unique();
  if (existing) await ctx.db.delete(existing._id);
}

/** Drain rows for a surface that no longer exists. Called from delete cascades. */
export async function clearPresence(
  ctx: MutationCtx,
  surfaceType: SurfaceType,
  surfaceId: string,
): Promise<void> {
  const rows = await ctx.db
    .query("presence")
    .withIndex("by_surface", (q) =>
      q.eq("surfaceType", surfaceType).eq("surfaceId", surfaceId),
    )
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}

/** A row this old is not presence, it is litter. Used by the retention pass. */
export function presenceIsStale(row: Doc<"presence">, now: number): boolean {
  return now - row.updatedAt > SWEEP_AFTER_MS;
}
