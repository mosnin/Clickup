import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity } from "./_authz";
import { resolveRoomMention } from "./buzz/bridge";

export const listForCurrent = query({
  args: { unreadOnly: v.optional(v.boolean()) },
  handler: async (ctx, { unreadOnly }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const all = await ctx.db
      .query("mentions")
      .withIndex("by_user", (q) => q.eq("mentionedClerkId", identity.subject))
      .order("desc")
      .take(200);
    const filtered = unreadOnly ? all.filter((m) => !m.readAt) : all;
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  },
});

// The Inbox's fully-resolved feed: each mention arrives with its message
// preview and a working deep link, so the client renders one subscription
// instead of three queries per row. Rows whose target no longer resolves
// return href: null (the UI renders them quietly instead of dead-linking);
// parents with no dedicated page yet (space chat, personal-scoped channels)
// fall back to the inbox itself rather than a dead link.
export const feedForCurrent = query({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 100);
    const page = await ctx.db
      .query("mentions")
      .withIndex("by_user", (q) => q.eq("mentionedClerkId", identity.subject))
      .order("desc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });
    const sorted = page.page.sort((a, b) => b.createdAt - a.createdAt);

    const nameCache = new Map<string, string>();
    const resolveAuthor = async (actorId: string): Promise<string> => {
      const cached = nameCache.get(actorId);
      if (cached !== undefined) return cached;
      let name = "";
      const agentId = ctx.db.normalizeId("agents", actorId);
      if (agentId) {
        const agent = await ctx.db.get(agentId);
        name = agent?.name ?? "";
      } else {
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", actorId))
          .unique();
        name = user?.name ?? user?.email ?? "";
      }
      nameCache.set(actorId, name);
      return name;
    };

    return await Promise.all(
      sorted.map(async (mention) => {
        // Page mentions have no message: the tag lives in the page's own
        // markdown, and the snippet was captured at write time.
        const message = mention.messageId
          ? await ctx.db.get(mention.messageId)
          : null;

        let href: string | null = null;
        let contextLabel = mention.parentType === "page" ? "Page" : "Comment";
        if (mention.parentType === "workspace") {
          href = `/dashboard/w/${mention.parentId}?tab=chat`;
          const ws = await ctx.db.get(mention.parentId as Id<"workspaces">);
          contextLabel = ws ? `${ws.name} chat` : "Workspace chat";
        } else if (mention.parentType === "task") {
          const task = await ctx.db.get(mention.parentId as Id<"tasks">);
          if (task) {
            href = `/dashboard/l/${task.listId}/t/${task._id}`;
            contextLabel = task.title;
          }
        } else if (mention.parentType === "channel") {
          const channel = await ctx.db.get(
            mention.parentId as Id<"channels">,
          );
          if (channel?.scopeType === "workspace") {
            href = `/dashboard/w/${channel.scopeId}?tab=chat&channel=${channel._id}`;
          } else {
            // Personal-scoped ("user") channels have no dedicated chat
            // page yet — fall back to the inbox so the card is still
            // clickable (mirrors messages.ts mentionHref).
            href = "/dashboard/inbox";
          }
          contextLabel = channel ? `#${channel.name}` : "Channel";
        } else if (mention.parentType === "page") {
          const page = await ctx.db.get(mention.parentId as Id<"pages">);
          if (page) {
            href = `/dashboard/pages/${page._id}`;
            contextLabel = page.title;
          }
        } else if (mention.parentType === "room") {
          // C12: a Chat room. One branch, and the resolution lives in
          // convex/buzz/bridge.ts so the room-key grammar has one owner.
          ({ href, label: contextLabel } = await resolveRoomMention(
            ctx,
            mention.parentId,
          ));
        } else if (mention.parentType === "space") {
          // Space chat has no dedicated page yet — fall back to the inbox
          // so the card is still clickable (mirrors messages.ts
          // mentionHref).
          href = "/dashboard/inbox";
          const space = await ctx.db.get(mention.parentId as Id<"spaces">);
          contextLabel = space ? `${space.name} chat` : "Space chat";
        }

        return {
          _id: mention._id,
          createdAt: mention.createdAt,
          readAt: mention.readAt,
          parentType: mention.parentType as Doc<"mentions">["parentType"],
          body: message?.body ?? mention.snippet ?? "",
          authorName: message
            ? await resolveAuthor(message.authorClerkId)
            : (mention.byName ?? ""),
          href,
          contextLabel,
        };
      }),
    );
  },
});

export const unreadCountForCurrent = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return 0;
    const all = await ctx.db
      .query("mentions")
      .withIndex("by_user", (q) => q.eq("mentionedClerkId", identity.subject))
      .take(1000);
    return all.filter((m) => !m.readAt).length;
  },
});

export const markRead = mutation({
  args: { mentionId: v.id("mentions") },
  handler: async (ctx, { mentionId }) => {
    const identity = await requireIdentity(ctx);
    const mention = await ctx.db.get(mentionId);
    if (!mention || mention.mentionedClerkId !== identity.subject) return;
    if (!mention.readAt) {
      await ctx.db.patch(mentionId, { readAt: Date.now() });
    }
  },
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    const unread = await ctx.db
      .query("mentions")
      .withIndex("by_user", (q) => q.eq("mentionedClerkId", identity.subject))
      .collect();
    const now = Date.now();
    for (const m of unread) {
      if (!m.readAt) await ctx.db.patch(m._id, { readAt: now });
    }
  },
});
