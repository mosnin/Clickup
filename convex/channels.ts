import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireIdentity } from "./_authz";
import type { Actor } from "./_agentAuth";
import { emitEvent } from "./events";

// Topic channels: named threads (messages with parentType "channel") so
// agent↔agent deliberation doesn't drown the main workspace chat. Humans
// can read and join every channel in their scope from the Chat tab.

async function requireScopeMembership(
  ctx: QueryCtx | MutationCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
): Promise<string> {
  const identity = await requireIdentity(ctx);
  if (scopeType === "user") {
    if (scopeId !== identity.subject) throw new Error("Forbidden");
  } else {
    const member = await ctx.db
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

export async function createChannelCore(
  ctx: MutationCtx,
  args: { scopeType: "user" | "workspace"; scopeId: string; name: string },
  actor: Actor,
): Promise<Id<"channels">> {
  const name = args.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60);
  if (!name) throw new Error("Channel name is required");
  const existing = await ctx.db
    .query("channels")
    .withIndex("by_scope", (q) =>
      q.eq("scopeType", args.scopeType).eq("scopeId", args.scopeId),
    )
    .collect();
  const clash = existing.find((c) => c.name === name);
  if (clash) return clash._id; // idempotent: joining an existing topic
  const channelId = await ctx.db.insert("channels", {
    scopeType: args.scopeType,
    scopeId: args.scopeId,
    name,
    createdByActorId: actor.id,
    createdAt: Date.now(),
  });
  await emitEvent(ctx, {
    scopeType: args.scopeType,
    scopeId: args.scopeId,
    type: "channel.created",
    actor,
    entityType: "channel",
    entityId: channelId,
    entityTitle: `#${name}`,
  });
  return channelId;
}

// Single channel lookup for deep links (inbox → workspace chat tab).
export const get = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, { channelId }) => {
    const channel = await ctx.db.get(channelId);
    if (!channel) return null;
    try {
      await requireScopeMembership(ctx, channel.scopeType, channel.scopeId);
    } catch {
      return null;
    }
    return {
      _id: channel._id,
      name: channel.name,
      scopeType: channel.scopeType,
      scopeId: channel.scopeId,
    };
  },
});

export const listForScope = query({
  args: {
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
  },
  handler: async (ctx, { scopeType, scopeId }) => {
    try {
      await requireScopeMembership(ctx, scopeType, scopeId);
    } catch {
      return [];
    }
    const channels = await ctx.db
      .query("channels")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", scopeType).eq("scopeId", scopeId),
      )
      .collect();
    return channels.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const create = mutation({
  args: {
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const subject = await requireScopeMembership(
      ctx,
      args.scopeType,
      args.scopeId,
    );
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", subject))
      .unique();
    return await createChannelCore(ctx, args, {
      type: "user",
      id: subject,
      name: user?.name ?? user?.email ?? "Someone",
    });
  },
});

export const remove = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, { channelId }) => {
    const channel = await ctx.db.get(channelId);
    if (!channel) return;
    await requireScopeMembership(ctx, channel.scopeType, channel.scopeId);
    // Cascade messages + mentions in the channel.
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "channel").eq("parentId", channelId),
      )
      .collect();
    for (const m of messages) {
      const mentions = await ctx.db
        .query("mentions")
        .withIndex("by_message", (q) => q.eq("messageId", m._id))
        .collect();
      for (const men of mentions) await ctx.db.delete(men._id);
      await ctx.db.delete(m._id);
    }
    await ctx.db.delete(channelId);
  },
});
