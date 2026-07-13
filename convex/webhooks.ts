import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireIdentity } from "./_authz";

// Outbound webhook subscriptions + delivery bookkeeping. The actual HTTP
// POST (with HMAC signing and retries) lives in convex/webhookDelivery.ts
// in the Node runtime; this file owns the rows.

// Consecutive failures before a subscription is switched off.
const AUTO_DISABLE_AFTER = 10;
// Retry backoff per attempt (attempt 1 failed -> wait RETRY_DELAYS[0], …).
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000];

function randomSecret(): string {
  // Math.random is fine here: the secret is a shared HMAC key the
  // receiver uses to check message integrity, and callers (UI or agents)
  // can always supply their own high-entropy secret instead.
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += Math.floor(Math.random() * 0xffff)
      .toString(16)
      .padStart(4, "0");
  }
  return `whsec_${s}`;
}

export function validateWebhookUrl(url: string): void {
  if (!/^https:\/\/.+/i.test(url)) {
    throw new Error("Webhook URL must be https://");
  }
}

// Shared by the user-facing mutation below and the agent API.
export async function createSubscription(
  ctx: MutationCtx,
  args: {
    scopeType: "user" | "workspace";
    scopeId: string;
    url: string;
    eventTypes: string[];
    listId?: Id<"lists">;
    secret?: string;
    ownerType: "user" | "agent";
    ownerId: string;
  },
): Promise<{ subscriptionId: Id<"webhookSubscriptions">; secret: string }> {
  validateWebhookUrl(args.url);
  const secret = args.secret ?? randomSecret();
  const subscriptionId = await ctx.db.insert("webhookSubscriptions", {
    scopeType: args.scopeType,
    scopeId: args.scopeId,
    url: args.url,
    secret,
    eventTypes: args.eventTypes,
    listId: args.listId,
    ownerType: args.ownerType,
    ownerId: args.ownerId,
    enabled: true,
    failureCount: 0,
    createdAt: Date.now(),
  });
  return { subscriptionId, secret };
}

async function requireScopeMembership(
  ctx: MutationCtx | Parameters<typeof requireIdentity>[0],
  scopeType: "user" | "workspace",
  scopeId: string,
): Promise<string> {
  const identity = await requireIdentity(ctx);
  if (scopeType === "user") {
    if (scopeId !== identity.subject) throw new Error("Forbidden");
  } else {
    const member = await (
      ctx as MutationCtx
    ).db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q
          .eq("userClerkId", identity.subject)
          .eq("workspaceId", scopeId as Id<"workspaces">),
      )
      .unique();
    if (!member) throw new Error("Forbidden");
  }
  return identity.subject;
}

// ── User-facing CRUD ───────────────────────────────────────────────────

export const listForCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .collect();
    const scopes = [
      { scopeType: "user" as const, scopeId: identity.subject },
      ...memberships.map((m) => ({
        scopeType: "workspace" as const,
        scopeId: m.workspaceId as string,
      })),
    ];
    const chunks = await Promise.all(
      scopes.map((s) =>
        ctx.db
          .query("webhookSubscriptions")
          .withIndex("by_scope", (q) =>
            q.eq("scopeType", s.scopeType).eq("scopeId", s.scopeId),
          )
          .collect(),
      ),
    );
    // Never ship the secret back to the browser after creation.
    return chunks.flat().map(({ secret: _secret, ...rest }) => rest);
  },
});

export const create = mutation({
  args: {
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    url: v.string(),
    eventTypes: v.array(v.string()),
    listId: v.optional(v.id("lists")),
    secret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const subject = await requireScopeMembership(
      ctx,
      args.scopeType,
      args.scopeId,
    );
    return await createSubscription(ctx, {
      ...args,
      ownerType: "user",
      ownerId: subject,
    });
  },
});

export const update = mutation({
  args: {
    subscriptionId: v.id("webhookSubscriptions"),
    enabled: v.optional(v.boolean()),
    eventTypes: v.optional(v.array(v.string())),
    url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const sub = await ctx.db.get(args.subscriptionId);
    if (!sub) throw new Error("Subscription not found");
    await requireScopeMembership(ctx, sub.scopeType, sub.scopeId);
    const patch: Record<string, unknown> = {};
    if (args.enabled !== undefined) {
      patch.enabled = args.enabled;
      if (args.enabled) {
        patch.failureCount = 0;
        patch.disabledAt = undefined;
      }
    }
    if (args.eventTypes !== undefined) patch.eventTypes = args.eventTypes;
    if (args.url !== undefined) {
      validateWebhookUrl(args.url);
      patch.url = args.url;
    }
    await ctx.db.patch(args.subscriptionId, patch);
  },
});

export const remove = mutation({
  args: { subscriptionId: v.id("webhookSubscriptions") },
  handler: async (ctx, { subscriptionId }) => {
    const sub = await ctx.db.get(subscriptionId);
    if (!sub) return;
    await requireScopeMembership(ctx, sub.scopeType, sub.scopeId);
    const deliveries = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_subscription", (q) =>
        q.eq("subscriptionId", subscriptionId),
      )
      .collect();
    for (const d of deliveries) await ctx.db.delete(d._id);
    await ctx.db.delete(subscriptionId);
  },
});

export const recentDeliveries = query({
  args: {
    subscriptionId: v.id("webhookSubscriptions"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { subscriptionId, limit }) => {
    const sub = await ctx.db.get(subscriptionId);
    if (!sub) return [];
    try {
      await requireScopeMembership(ctx, sub.scopeType, sub.scopeId);
    } catch {
      return [];
    }
    return await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_subscription", (q) =>
        q.eq("subscriptionId", subscriptionId),
      )
      .order("desc")
      .take(Math.min(limit ?? 20, 50));
  },
});

// ── Internal: used by the delivery action ──────────────────────────────

export const _deliveryContext = internalQuery({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, { deliveryId }) => {
    const delivery = await ctx.db.get(deliveryId);
    if (!delivery) return null;
    const sub = await ctx.db.get(delivery.subscriptionId);
    const event = await ctx.db.get(delivery.eventId);
    if (!sub || !event) return null;
    return { delivery, sub, event };
  },
});

export const _recordResult = internalMutation({
  args: {
    deliveryId: v.id("webhookDeliveries"),
    ok: v.boolean(),
    responseStatus: v.optional(v.number()),
    error: v.optional(v.string()),
    final: v.boolean(),
  },
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery) return;
    const attempts = delivery.attempts + 1;
    await ctx.db.patch(args.deliveryId, {
      attempts,
      status: args.ok ? "success" : args.final ? "failed" : "pending",
      responseStatus: args.responseStatus,
      lastError: args.error,
      completedAt: args.ok || args.final ? Date.now() : undefined,
    });

    const sub = await ctx.db.get(delivery.subscriptionId);
    if (!sub) return;
    if (args.ok) {
      if (sub.failureCount > 0) {
        await ctx.db.patch(sub._id, { failureCount: 0 });
      }
    } else if (args.final) {
      const failureCount = sub.failureCount + 1;
      await ctx.db.patch(sub._id, {
        failureCount,
        ...(failureCount >= AUTO_DISABLE_AFTER
          ? { enabled: false, disabledAt: Date.now() }
          : {}),
      });
    }
  },
});
