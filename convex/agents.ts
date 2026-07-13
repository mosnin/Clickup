import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity, requireListAccess } from "./_authz";

// Human-facing management of AI agent principals: create/pause/delete
// agents, inspect their keys, and feed the assignee pickers. The agent-
// facing side (key-authenticated) lives in convex/agentApi.ts.

const scopeValidator = {
  parentType: v.union(v.literal("user"), v.literal("workspace")),
  parentId: v.string(),
};

// The caller can manage agents in a scope when the scope is their own
// personal space or a workspace they belong to.
async function requireScopeAccess(
  ctx: QueryCtx | MutationCtx,
  parentType: "user" | "workspace",
  parentId: string,
): Promise<{ subject: string }> {
  const identity = await requireIdentity(ctx);
  if (parentType === "user") {
    if (parentId !== identity.subject) throw new Error("Forbidden");
    return identity;
  }
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q
        .eq("userClerkId", identity.subject)
        .eq("workspaceId", parentId as Id<"workspaces">),
    )
    .unique();
  if (!membership) throw new Error("Forbidden");
  return identity;
}

async function requireAgentManageAccess(
  ctx: QueryCtx | MutationCtx,
  agentId: Id<"agents">,
): Promise<{ agent: Doc<"agents">; subject: string }> {
  const agent = await ctx.db.get(agentId);
  if (!agent) throw new Error("Agent not found");
  const identity = await requireScopeAccess(
    ctx,
    agent.parentType,
    agent.parentId,
  );
  return { agent, subject: identity.subject };
}

// ── Queries ────────────────────────────────────────────────────────────

// All agents visible to the current user: personal ones plus one group per
// workspace membership. Powers the Agents HQ page.
export const listForCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const personal = await ctx.db
      .query("agents")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "user").eq("parentId", identity.subject),
      )
      .collect();

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .collect();
    const workspaces = [];
    for (const m of memberships) {
      const ws = await ctx.db.get(m.workspaceId);
      if (!ws) continue;
      const agents = await ctx.db
        .query("agents")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "workspace").eq("parentId", m.workspaceId),
        )
        .collect();
      workspaces.push({
        workspaceId: m.workspaceId,
        workspaceName: ws.name,
        agents,
      });
    }
    return { personal, workspaces };
  },
});

// Current task titles for the "Now" line on agent cards, resolved in one
// query so the UI doesn't fetch per agent.
export const currentTaskTitles = query({
  args: { taskIds: v.array(v.id("tasks")) },
  handler: async (ctx, { taskIds }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return {};
    const out: Record<string, string> = {};
    for (const id of taskIds) {
      const task = await ctx.db.get(id);
      if (task) out[id] = task.title;
    }
    return out;
  },
});

// Assignee-picker options for a list: human members of the list's scope
// plus agents in the same scope. Both sides share the shape the picker
// needs; `kind` tells them apart.
export const listAssignableForList = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    let space;
    try {
      ({ space } = await requireListAccess(ctx, listId));
    } catch {
      return [];
    }

    const options: {
      id: string;
      name: string;
      kind: "user" | "agent";
      imageUrl?: string;
      emoji?: string;
    }[] = [];

    if (space.parentType === "user") {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", space.parentId))
        .unique();
      if (user) {
        options.push({
          id: user.clerkId,
          name: user.name ?? user.email,
          kind: "user",
          imageUrl: user.imageUrl,
        });
      }
    } else {
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_workspace", (q) =>
          q.eq("workspaceId", space.parentId as Id<"workspaces">),
        )
        .collect();
      for (const m of memberships) {
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", m.userClerkId))
          .unique();
        if (user) {
          options.push({
            id: user.clerkId,
            name: user.name ?? user.email,
            kind: "user",
            imageUrl: user.imageUrl,
          });
        }
      }
    }

    const agents = await ctx.db
      .query("agents")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", space.parentType).eq("parentId", space.parentId),
      )
      .collect();
    for (const a of agents) {
      options.push({ id: a._id, name: a.name, kind: "agent", emoji: a.emoji });
    }
    return options;
  },
});

// Key metadata (never the key itself) for the management UI.
export const listKeys = query({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    try {
      await requireAgentManageAccess(ctx, agentId);
    } catch {
      return [];
    }
    const keys = await ctx.db
      .query("agentKeys")
      .withIndex("by_agent", (q) => q.eq("agentId", agentId))
      .collect();
    return keys.map((k) => ({
      _id: k._id,
      keyPrefix: k.keyPrefix,
      createdAt: k.createdAt,
      revokedAt: k.revokedAt,
      lastUsedAt: k.lastUsedAt,
    }));
  },
});

// ── Mutations ──────────────────────────────────────────────────────────

export const create = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    emoji: v.optional(v.string()),
    ...scopeValidator,
  },
  handler: async (ctx, args) => {
    const identity = await requireScopeAccess(
      ctx,
      args.parentType,
      args.parentId,
    );
    if (!args.name.trim()) throw new Error("Agent name is required");
    return await ctx.db.insert("agents", {
      name: args.name.trim(),
      description: args.description,
      emoji: args.emoji,
      parentType: args.parentType,
      parentId: args.parentId,
      status: "active",
      createdByClerkId: identity.subject,
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    agentId: v.id("agents"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    emoji: v.optional(v.string()),
    status: v.optional(v.union(v.literal("active"), v.literal("paused"))),
  },
  handler: async (ctx, args) => {
    await requireAgentManageAccess(ctx, args.agentId);
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined && args.name.trim()) {
      patch.name = args.name.trim();
    }
    if (args.description !== undefined) patch.description = args.description;
    if (args.emoji !== undefined) patch.emoji = args.emoji;
    if (args.status !== undefined) patch.status = args.status;
    await ctx.db.patch(args.agentId, patch);
  },
});

export const remove = mutation({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const agent = await ctx.db.get(agentId);
    if (!agent) return;
    await requireAgentManageAccess(ctx, agentId);
    const keys = await ctx.db
      .query("agentKeys")
      .withIndex("by_agent", (q) => q.eq("agentId", agentId))
      .collect();
    for (const k of keys) await ctx.db.delete(k._id);
    // Webhook subscriptions the agent registered die with it.
    const subs = await ctx.db
      .query("webhookSubscriptions")
      .withIndex("by_owner", (q) =>
        q.eq("ownerType", "agent").eq("ownerId", agentId),
      )
      .collect();
    for (const s of subs) await ctx.db.delete(s._id);
    await ctx.db.delete(agentId);
  },
});

export const revokeKey = mutation({
  args: { keyId: v.id("agentKeys") },
  handler: async (ctx, { keyId }) => {
    const key = await ctx.db.get(keyId);
    if (!key) return;
    await requireAgentManageAccess(ctx, key.agentId);
    await ctx.db.patch(keyId, { revokedAt: Date.now() });
  },
});

// ── Internal (used by the key-creation action) ─────────────────────────

export const _assertManageAccess = internalQuery({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const { agent } = await requireAgentManageAccess(ctx, agentId);
    return { agentName: agent.name };
  },
});

export const _storeKey = internalMutation({
  args: {
    agentId: v.id("agents"),
    keyHash: v.string(),
    keyPrefix: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("agentKeys", {
      agentId: args.agentId,
      keyHash: args.keyHash,
      keyPrefix: args.keyPrefix,
      createdAt: Date.now(),
    });
  },
});
