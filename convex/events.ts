import { v } from "convex/values";
import { query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { getSpaceForList } from "./_authz";
import type { Actor } from "./_agentAuth";

// Append-only activity log. emitEvent() is called from inside mutations
// (tasks, messages, sprints, scheduled tasks) so the event row commits in
// the same transaction as the change it describes. Webhook fan-out is
// scheduled from here too: matching subscriptions each get a delivery row
// plus a scheduled internal action that POSTs and retries.

export type EventInput = {
  scopeType: "user" | "workspace";
  scopeId: string;
  type: string;
  actor: Actor;
  entityType: string;
  entityId: string;
  entityTitle?: string;
  listId?: Id<"lists">;
  payload?: unknown;
};

export async function emitEvent(
  ctx: MutationCtx,
  e: EventInput,
): Promise<Id<"events">> {
  const eventId = await ctx.db.insert("events", {
    scopeType: e.scopeType,
    scopeId: e.scopeId,
    type: e.type,
    actorType: e.actor.type,
    actorId: e.actor.id,
    actorName: e.actor.name,
    entityType: e.entityType,
    entityId: e.entityId,
    entityTitle: e.entityTitle,
    listId: e.listId,
    payload: e.payload,
    createdAt: Date.now(),
  });

  const subs = await ctx.db
    .query("webhookSubscriptions")
    .withIndex("by_scope", (q) =>
      q.eq("scopeType", e.scopeType).eq("scopeId", e.scopeId),
    )
    .collect();
  for (const sub of subs) {
    if (!sub.enabled) continue;
    if (sub.eventTypes.length > 0 && !sub.eventTypes.includes(e.type)) {
      continue;
    }
    if (sub.listId !== undefined && sub.listId !== e.listId) continue;
    const deliveryId = await ctx.db.insert("webhookDeliveries", {
      subscriptionId: sub._id,
      eventId,
      eventType: e.type,
      status: "pending",
      attempts: 0,
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.webhookDelivery.deliver, {
      deliveryId,
    });
  }
  return eventId;
}

// Resolve the scope (personal user or workspace) that a list lives in.
// Used by every task-related emitter.
export async function scopeForList(
  ctx: QueryCtx | MutationCtx,
  list: Doc<"lists">,
): Promise<{ scopeType: "user" | "workspace"; scopeId: string } | null> {
  const space = await getSpaceForList(ctx, list);
  if (!space) return null;
  return { scopeType: space.parentType, scopeId: space.parentId };
}

export async function userActor(
  ctx: QueryCtx | MutationCtx,
  clerkId: string,
): Promise<Actor> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
    .unique();
  return {
    type: "user",
    id: clerkId,
    name: user?.name ?? user?.email ?? "Someone",
  };
}

// ── Human-facing feed ──────────────────────────────────────────────────

const MAX_FEED = 100;

// Activity feed across everything the current user can see: their personal
// scope plus every workspace they belong to. Optionally narrowed to one
// scope. Newest first.
export const feed = query({
  args: {
    scopeType: v.optional(v.union(v.literal("user"), v.literal("workspace"))),
    scopeId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const limit = Math.min(args.limit ?? 50, MAX_FEED);

    let scopes: { scopeType: "user" | "workspace"; scopeId: string }[];
    if (args.scopeType && args.scopeId) {
      // Authorize the requested scope.
      if (args.scopeType === "user") {
        if (args.scopeId !== identity.subject) return [];
      } else {
        const member = await ctx.db
          .query("memberships")
          .withIndex("by_user_and_workspace", (q) =>
            q
              .eq("userClerkId", identity.subject)
              .eq("workspaceId", args.scopeId as Id<"workspaces">),
          )
          .unique();
        if (!member) return [];
      }
      scopes = [{ scopeType: args.scopeType, scopeId: args.scopeId }];
    } else {
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
        .collect();
      scopes = [
        { scopeType: "user" as const, scopeId: identity.subject },
        ...memberships.map((m) => ({
          scopeType: "workspace" as const,
          scopeId: m.workspaceId as string,
        })),
      ];
    }

    const chunks = await Promise.all(
      scopes.map((s) =>
        ctx.db
          .query("events")
          .withIndex("by_scope", (q) =>
            q.eq("scopeType", s.scopeType).eq("scopeId", s.scopeId),
          )
          .order("desc")
          .take(limit),
      ),
    );
    return chunks
      .flat()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  },
});
