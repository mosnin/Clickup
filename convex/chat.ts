import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  canAccessSpace,
  requireIdentity,
  requireListAccess,
  requirePageAccess,
  requireProjectAccess,
  requireTaskAccess,
} from "./_authz";
import { markChannelReadCore } from "./messages";
import { bodyToText } from "./_refs";

// The messaging surface.
//
// Channels already existed as a place for agent↔agent deliberation
// (convex/channels.ts). What was missing is everything that makes a channel
// list usable as a chat app rather than a tab: what's unread, what happened
// last, and who is in the room. That is what this file adds — and it adds it
// by reading denormalized columns rather than by walking every channel's
// messages, because a rail that costs one query per channel is a rail that
// stops loading at twenty channels.
//
// Convex remains the source of truth for every message. Ably (see
// convex/realtime.ts) carries the ephemeral half — typing, presence, and the
// nudge to clients that aren't holding a Convex subscription.

/** Every scope the caller can chat in, personal space first. */
export const scopesForCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const out: {
      scopeType: "user" | "workspace";
      scopeId: string;
      name: string;
    }[] = [{ scopeType: "user", scopeId: identity.subject, name: "Personal" }];

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .collect();
    for (const m of memberships) {
      const ws = await ctx.db.get(m.workspaceId);
      if (ws && ws.suspendedAt === undefined) {
        out.push({
          scopeType: "workspace",
          scopeId: ws._id,
          name: ws.name,
        });
      }
    }
    return out;
  },
});

async function scopeAccess(
  ctx: QueryCtx | MutationCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
): Promise<string> {
  const identity = await requireIdentity(ctx);
  if (scopeType === "user") {
    if (scopeId !== identity.subject) throw new ConvexError("Forbidden");
    return identity.subject;
  }
  const member = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q
        .eq("userClerkId", identity.subject)
        .eq("workspaceId", scopeId as Id<"workspaces">),
    )
    .unique();
  if (!member) throw new ConvexError("Forbidden");
  return identity.subject;
}

async function channelAccess(
  ctx: QueryCtx | MutationCtx,
  channelId: Id<"channels">,
): Promise<{ channel: Doc<"channels">; subject: string }> {
  const channel = await ctx.db.get(channelId);
  if (!channel) throw new ConvexError("Channel not found");
  const subject = await scopeAccess(ctx, channel.scopeType, channel.scopeId);
  return { channel, subject };
}

/**
 * The channel rail: newest activity first, with an unread count per channel.
 *
 * The count is bounded by a range read on the messages index rather than a
 * full scan, and only for channels whose `lastMessageAt` is actually newer
 * than the caller's read cursor — so a quiet channel costs nothing.
 */
export const channels = query({
  args: {
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
  },
  handler: async (ctx, { scopeType, scopeId }) => {
    let subject: string;
    try {
      subject = await scopeAccess(ctx, scopeType, scopeId);
    } catch {
      return [];
    }

    const rows = await ctx.db
      .query("channels")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", scopeType).eq("scopeId", scopeId),
      )
      .collect();

    const reads = await ctx.db
      .query("channelReads")
      .withIndex("by_actor", (q) => q.eq("actorId", subject))
      .collect();
    const readAt = new Map(reads.map((r) => [r.channelId as string, r.lastReadAt]));

    const out = [];
    for (const c of rows) {
      if (c.archivedAt !== undefined) continue;
      const since = readAt.get(c._id) ?? 0;
      let unread = 0;
      if ((c.lastMessageAt ?? 0) > since) {
        const messages = await ctx.db
          .query("messages")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "channel").eq("parentId", c._id),
          )
          .collect();
        unread = messages.filter(
          (m) => m.createdAt > since && m.authorClerkId !== subject,
        ).length;
      }
      out.push({
        channelId: c._id,
        name: c.name,
        topic: c.topic,
        lastMessageAt: c.lastMessageAt,
        lastMessagePreview: c.lastMessagePreview,
        lastMessageByName: c.lastMessageByName,
        unread,
      });
    }
    // Active channels first; never-used ones fall back to alphabetical so the
    // rail has a stable order on a fresh workspace.
    out.sort((a, b) => {
      const d = (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });
    return out;
  },
});

/**
 * One channel's messages, newest-last, with authors resolved.
 *
 * `limit` is a tail window: chat is read from the bottom, so the useful
 * default is "the last N", not "the first N".
 */
export const thread = query({
  args: { channelId: v.id("channels"), limit: v.optional(v.number()) },
  handler: async (ctx, { channelId, limit }) => {
    let channel: Doc<"channels">;
    try {
      ({ channel } = await channelAccess(ctx, channelId));
    } catch {
      return null;
    }

    const all = await ctx.db
      .query("messages")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "channel").eq("parentId", channelId),
      )
      .collect();
    const window = all
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-Math.min(limit ?? 200, 500));

    const nameCache = new Map<string, { name: string; isAgent: boolean }>();
    const resolveAuthor = async (actorId: string) => {
      const cached = nameCache.get(actorId);
      if (cached) return cached;
      let resolved = { name: "Someone", isAgent: false };
      const agentId = ctx.db.normalizeId("agents", actorId);
      if (agentId) {
        const agent = await ctx.db.get(agentId);
        if (agent) resolved = { name: agent.name, isAgent: true };
      } else {
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", actorId))
          .unique();
        if (user) {
          resolved = { name: user.name ?? user.email, isAgent: false };
        }
      }
      nameCache.set(actorId, resolved);
      return resolved;
    };

    const messages = [];
    for (const m of window) {
      const author = await resolveAuthor(m.authorClerkId);
      messages.push({
        messageId: m._id,
        body: m.body,
        authorId: m.authorClerkId,
        authorName: author.name,
        authorIsAgent: author.isAgent,
        refs: m.refs ?? [],
        editedAt: m.editedAt,
        createdAt: m.createdAt,
      });
    }

    return {
      channel: {
        channelId: channel._id,
        name: channel.name,
        topic: channel.topic,
        scopeType: channel.scopeType,
        scopeId: channel.scopeId,
      },
      messages,
      // True when the window clipped history, so the UI can say so instead of
      // pretending the conversation starts there.
      truncated: all.length > messages.length,
    };
  },
});

export const markRead = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, { channelId }) => {
    const { subject } = await channelAccess(ctx, channelId);
    await markChannelReadCore(ctx, channelId, subject);
  },
});

export const setTopic = mutation({
  args: { channelId: v.id("channels"), topic: v.string() },
  handler: async (ctx, { channelId, topic }) => {
    await channelAccess(ctx, channelId);
    const trimmed = topic.trim().slice(0, 280);
    await ctx.db.patch(channelId, {
      topic: trimmed.length > 0 ? trimmed : undefined,
    });
  },
});

/**
 * Everything the composer's `#` menu can point at, for one scope.
 *
 * One query rather than four: the menu filters across kinds as you type, so
 * splitting it would mean four subscriptions and four loading states for one
 * popup.
 */
export const referenceTargets = query({
  args: {
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
  },
  handler: async (ctx, { scopeType, scopeId }) => {
    let subject: string;
    try {
      subject = await scopeAccess(ctx, scopeType, scopeId);
    } catch {
      return [];
    }

    const out: {
      kind: "project" | "list" | "task" | "page" | "sprint" | "goal";
      id: string;
      label: string;
      context?: string;
    }[] = [];

    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", scopeType).eq("parentId", scopeId),
      )
      .collect();

    for (const space of spaces) {
      if (space.archivedAt !== undefined) continue;
      if (!(await canAccessSpace(ctx, space, { subject }))) continue;
      const projects = await ctx.db
        .query("projects")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      for (const project of projects) {
        if (project.archivedAt !== undefined) continue;
        out.push({
          kind: "project",
          id: project._id,
          label: project.name,
          context: space.name,
        });
        const lists = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "project").eq("parentId", project._id),
          )
          .collect();
        for (const list of lists) {
          out.push({
            kind: "list",
            id: list._id,
            label: list.name,
            context: project.name,
          });
        }
      }
      const bareLists = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();
      for (const list of bareLists) {
        out.push({
          kind: "list",
          id: list._id,
          label: list.name,
          context: space.name,
        });
      }
    }

    const pages = await ctx.db
      .query("pages")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", scopeType).eq("scopeId", scopeId),
      )
      .collect();
    for (const page of pages) {
      if (page.archivedAt !== undefined) continue;
      out.push({ kind: "page", id: page._id, label: page.title });
    }

    if (scopeType === "workspace") {
      const sprints = await ctx.db
        .query("sprints")
        .withIndex("by_workspace", (q) =>
          q.eq("workspaceId", scopeId as Id<"workspaces">),
        )
        .collect();
      for (const sprint of sprints) {
        out.push({ kind: "sprint", id: sprint._id, label: sprint.name });
      }
      const goals = await ctx.db
        .query("goals")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "workspace").eq("parentId", scopeId),
        )
        .collect();
      for (const goal of goals) {
        out.push({ kind: "goal", id: goal._id, label: goal.title });
      }
    }

    return out;
  },
});

/**
 * Where a reference points, so a chip in a message is a working link.
 *
 * Resolved server-side rather than assembled in the client because a task's
 * URL needs its list, and a chip shouldn't have to know the routing table.
 */
export const resolveRefs = query({
  args: {
    refs: v.array(
      v.object({ kind: v.string(), id: v.string(), label: v.string() }),
    ),
  },
  handler: async (ctx, { refs }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const out: { kind: string; id: string; label: string; href: string | null }[] =
      [];
    for (const ref of refs) {
      let href: string | null = null;
      try {
        if (ref.kind === "page") {
          const id = ctx.db.normalizeId("pages", ref.id);
          if (id) {
            await requirePageAccess(ctx, id);
            href = `/dashboard/pages/${ref.id}`;
          }
        } else if (ref.kind === "project") {
          const id = ctx.db.normalizeId("projects", ref.id);
          if (id) {
            await requireProjectAccess(ctx, id);
            href = `/dashboard/p/${ref.id}`;
          }
        } else if (ref.kind === "list") {
          const id = ctx.db.normalizeId("lists", ref.id);
          if (id) {
            await requireListAccess(ctx, id);
            href = `/dashboard/l/${ref.id}`;
          }
        } else if (ref.kind === "task") {
          const id = ctx.db.normalizeId("tasks", ref.id);
          if (id) {
            const { task } = await requireTaskAccess(ctx, id);
            href = `/dashboard/l/${task.listId}/t/${task._id}`;
          }
        }
      } catch {
        href = null;
      }
      out.push({ ...ref, href });
    }
    return out;
  },
});

/** Plain text of a body, for anything that needs words without tokens. */
export function messageText(body: string): string {
  return bodyToText(body);
}
