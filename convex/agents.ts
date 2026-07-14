import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity, requireListAccess, requireTaskAccess } from "./_authz";
import { DEFAULT_DAILY_ACTION_LIMIT } from "./_agentAuth";
import { validateWebhookUrl } from "./webhooks";

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
// query so the UI doesn't fetch per agent. Access-checked per task.
export const currentTaskTitles = query({
  args: { taskIds: v.array(v.id("tasks")) },
  handler: async (ctx, { taskIds }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return {};
    const out: Record<string, string> = {};
    for (const id of taskIds) {
      try {
        const { task } = await requireTaskAccess(ctx, id);
        out[id] = task.title;
      } catch {
        // skip inaccessible tasks
      }
    }
    return out;
  },
});

// Everything the agent detail page needs in one subscription: the agent,
// its recent runs, today's action usage, its recent events, and the tasks
// it currently claims or is assigned.
export const detail = query({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    let agent;
    try {
      ({ agent } = await requireAgentManageAccess(ctx, agentId));
    } catch {
      return null;
    }

    const runs = await ctx.db
      .query("agentRuns")
      .withIndex("by_agent", (q) => q.eq("agentId", agentId))
      .order("desc")
      .take(25);

    const day = new Date().toISOString().slice(0, 10);
    const usage = await ctx.db
      .query("agentUsage")
      .withIndex("by_agent_day", (q) => q.eq("agentId", agentId).eq("day", day))
      .unique();

    const events = await ctx.db
      .query("events")
      .withIndex("by_actor", (q) =>
        q.eq("actorType", "agent").eq("actorId", agentId),
      )
      .order("desc")
      .take(50);

    // Tasks in the agent's scope it claims or is assigned to. Full walk of
    // scope tasks via events would miss quiet assignments, so scan the
    // scope's lists (same tradeoff as reports).
    const claimed: { taskId: Id<"tasks">; listId: Id<"lists">; title: string }[] = [];
    const assigned: typeof claimed = [];
    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", agent.parentType).eq("parentId", agent.parentId),
      )
      .collect();
    for (const space of spaces) {
      const parents: { type: "space" | "folder"; id: string }[] = [
        { type: "space", id: space._id },
      ];
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      for (const f of folders) parents.push({ type: "folder", id: f._id });
      for (const p of parents) {
        const lists = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", p.type).eq("parentId", p.id),
          )
          .collect();
        for (const l of lists) {
          const tasks = await ctx.db
            .query("tasks")
            .withIndex("by_list", (q) => q.eq("listId", l._id))
            .collect();
          for (const t of tasks) {
            const row = { taskId: t._id, listId: l._id, title: t.title };
            if (t.claimedByActorId === agentId) claimed.push(row);
            if (t.assigneeClerkIds.includes(agentId)) {
              const status = await ctx.db.get(t.statusId);
              if (
                status?.category !== "complete" &&
                status?.category !== "closed"
              ) {
                assigned.push(row);
              }
            }
          }
        }
      }
    }

    return {
      agent,
      runs,
      usageToday: usage?.count ?? 0,
      usageLimit: agent.dailyActionLimit ?? DEFAULT_DAILY_ACTION_LIMIT,
      events,
      claimed,
      assigned,
    };
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

// Agents of one workspace (id/name/emoji only) — merged into name maps by
// Reports and other member-keyed UI so agent actors don't render as
// "Unknown".
export const listForWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const member = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
      )
      .unique();
    if (!member) return [];
    const agents = await ctx.db
      .query("agents")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", workspaceId),
      )
      .collect();
    return agents.map((a) => ({ _id: a._id, name: a.name, emoji: a.emoji }));
  },
});

// Last-7-days analytics for one agent: throughput, run outcomes, cost,
// and time logged. Powers the stat tiles on the agent detail page.
export const stats = query({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    try {
      await requireAgentManageAccess(ctx, agentId);
    } catch {
      return null;
    }
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const recentEvents = await ctx.db
      .query("events")
      .withIndex("by_actor", (q) =>
        q.eq("actorType", "agent").eq("actorId", agentId),
      )
      .order("desc")
      .take(500);
    let completed = 0;
    let created = 0;
    let comments = 0;
    for (const e of recentEvents) {
      if (e.createdAt < since) break;
      if (e.type === "task.completed") completed++;
      else if (e.type === "task.created") created++;
      else if (e.type === "comment.created") comments++;
    }

    const runs = await ctx.db
      .query("agentRuns")
      .withIndex("by_agent", (q) => q.eq("agentId", agentId))
      .order("desc")
      .take(200);
    let runsSucceeded = 0;
    let runsFailed = 0;
    let runMsTotal = 0;
    let runMsCount = 0;
    let tokensUsed = 0;
    let costUsd = 0;
    for (const r of runs) {
      if (r.startedAt < since) break;
      if (r.status === "succeeded") runsSucceeded++;
      if (r.status === "failed") runsFailed++;
      if (r.finishedAt !== undefined) {
        runMsTotal += r.finishedAt - r.startedAt;
        runMsCount++;
      }
      tokensUsed += r.tokensUsed ?? 0;
      costUsd += r.costUsd ?? 0;
    }

    const entries = await ctx.db
      .query("timeEntries")
      .withIndex("by_user_started", (q) =>
        q.eq("userClerkId", agentId).gt("startedAt", since),
      )
      .collect();
    const timeLoggedMs = entries.reduce((n, e) => n + (e.durationMs ?? 0), 0);

    return {
      completed7d: completed,
      created7d: created,
      comments7d: comments,
      runsSucceeded7d: runsSucceeded,
      runsFailed7d: runsFailed,
      avgRunMs: runMsCount > 0 ? Math.round(runMsTotal / runMsCount) : null,
      tokensUsed7d: tokensUsed,
      costUsd7d: Math.round(costUsd * 100) / 100,
      timeLoggedMs7d: timeLoggedMs,
    };
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
    role: v.optional(v.union(v.literal("member"), v.literal("readonly"))),
    allowedListIds: v.optional(v.union(v.array(v.id("lists")), v.null())),
    dailyActionLimit: v.optional(v.union(v.number(), v.null())),
    notifyUrl: v.optional(v.union(v.string(), v.null())),
    notifySecret: v.optional(v.union(v.string(), v.null())),
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
    if (args.role !== undefined) patch.role = args.role;
    if (args.allowedListIds !== undefined) {
      patch.allowedListIds = args.allowedListIds ?? undefined;
    }
    if (args.dailyActionLimit !== undefined) {
      if (args.dailyActionLimit !== null && args.dailyActionLimit < 1) {
        throw new Error("dailyActionLimit must be positive");
      }
      patch.dailyActionLimit = args.dailyActionLimit ?? undefined;
    }
    if (args.notifyUrl !== undefined) {
      if (args.notifyUrl) validateWebhookUrl(args.notifyUrl);
      patch.notifyUrl = args.notifyUrl || undefined;
    }
    if (args.notifySecret !== undefined) {
      patch.notifySecret = args.notifySecret || undefined;
    }
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
    const runs = await ctx.db
      .query("agentRuns")
      .withIndex("by_agent", (q) => q.eq("agentId", agentId))
      .collect();
    for (const r of runs) await ctx.db.delete(r._id);
    const usage = await ctx.db
      .query("agentUsage")
      .withIndex("by_agent_day", (q) => q.eq("agentId", agentId))
      .collect();
    for (const u of usage) await ctx.db.delete(u._id);

    // Strip the agent's id from live task state so no "Unknown" chips
    // linger: unassign it everywhere and release any claims it holds.
    const claimed = await ctx.db
      .query("tasks")
      .withIndex("by_claimed", (q) => q.eq("claimedByActorId", agentId))
      .collect();
    for (const t of claimed) {
      await ctx.db.patch(t._id, {
        claimedByActorId: undefined,
        claimedAt: undefined,
      });
    }
    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", agent.parentType).eq("parentId", agent.parentId),
      )
      .collect();
    for (const space of spaces) {
      const parents: { type: "space" | "folder"; id: string }[] = [
        { type: "space", id: space._id },
      ];
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      for (const f of folders) parents.push({ type: "folder", id: f._id });
      for (const p of parents) {
        const lists = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", p.type).eq("parentId", p.id),
          )
          .collect();
        for (const l of lists) {
          const tasks = await ctx.db
            .query("tasks")
            .withIndex("by_list", (q) => q.eq("listId", l._id))
            .collect();
          for (const t of tasks) {
            if (t.assigneeClerkIds.includes(agentId)) {
              await ctx.db.patch(t._id, {
                assigneeClerkIds: t.assigneeClerkIds.filter(
                  (a) => a !== agentId,
                ),
              });
            }
          }
        }
      }
    }
    // Its unread mentions are meaningless without the agent.
    const mentions = await ctx.db
      .query("mentions")
      .withIndex("by_user", (q) => q.eq("mentionedClerkId", agentId))
      .collect();
    for (const m of mentions) await ctx.db.delete(m._id);

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
