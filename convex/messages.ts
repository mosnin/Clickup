import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireIdentity, requireMessageParentAccess } from "./_authz";

async function describeMessageContext(
  ctx: MutationCtx,
  msg: Pick<Doc<"messages">, "parentType" | "parentId" | "body">,
): Promise<string> {
  if (msg.parentType === "task") {
    const task = await ctx.db.get(msg.parentId as Id<"tasks">);
    return task ? `task "${task.title}"` : "a task";
  }
  if (msg.parentType === "workspace") {
    const ws = await ctx.db.get(msg.parentId as Id<"workspaces">);
    return ws ? `the ${ws.name} workspace chat` : "a workspace chat";
  }
  return "a space";
}

function snippetFromBody(body: string): string {
  const stripped = body.replace(/@\[([^\]]+)\]\([^)]+\)/g, "@$1");
  const trimmed = stripped.trim();
  return trimmed.length > 240 ? trimmed.slice(0, 240) + "…" : trimmed;
}

const parentTypeValidator = v.union(
  v.literal("task"),
  v.literal("space"),
  v.literal("workspace"),
);

export const listForParent = query({
  args: { parentType: parentTypeValidator, parentId: v.string() },
  handler: async (ctx, { parentType, parentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    // Don't throw on read — just return empty if unauthorized so the UI
    // stays calm during route transitions.
    try {
      await requireMessageParentAccess(ctx, parentType, parentId);
    } catch {
      return [];
    }
    const all = await ctx.db
      .query("messages")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", parentType).eq("parentId", parentId),
      )
      .collect();
    return all.sort((a, b) => a.createdAt - b.createdAt);
  },
});

// Mention candidates for the given parent. For workspace-scoped parents
// it's every workspace member; for personal-space parents it's just the
// personal user.
export const listMentionableUsers = query({
  args: { parentType: parentTypeValidator, parentId: v.string() },
  handler: async (ctx, { parentType, parentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    let workspaceId: Id<"workspaces"> | null = null;
    try {
      const ctx2 = await requireMessageParentAccess(ctx, parentType, parentId);
      workspaceId = ctx2.workspaceId;
    } catch {
      return [];
    }

    if (workspaceId === null) {
      // Personal — only the current user.
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
        .unique();
      return user ? [user] : [];
    }

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    const users = await Promise.all(
      memberships.map((m) =>
        ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", m.userClerkId))
          .unique(),
      ),
    );
    return users.filter((u): u is NonNullable<typeof u> => u !== null);
  },
});

export const create = mutation({
  args: {
    parentType: parentTypeValidator,
    parentId: v.string(),
    body: v.string(),
    parentMessageId: v.optional(v.id("messages")),
    assigneeClerkId: v.optional(v.string()),
    mentionClerkIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const { identity, workspaceId } = await requireMessageParentAccess(
      ctx,
      args.parentType,
      args.parentId,
    );

    if (!args.body.trim()) throw new Error("Empty message");

    if (args.parentMessageId) {
      const root = await ctx.db.get(args.parentMessageId);
      if (
        !root ||
        root.parentType !== args.parentType ||
        root.parentId !== args.parentId
      ) {
        throw new Error("Reply parent must belong to the same context");
      }
    }

    const messageId = await ctx.db.insert("messages", {
      parentType: args.parentType,
      parentId: args.parentId,
      authorClerkId: identity.subject,
      body: args.body,
      parentMessageId: args.parentMessageId,
      assigneeClerkId: args.assigneeClerkId,
      createdAt: Date.now(),
    });

    // Author info, used to populate the email "from" line.
    const author = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
    const authorName = author?.name ?? author?.email ?? "Someone";
    const contextLabel = await describeMessageContext(ctx, {
      parentType: args.parentType,
      parentId: args.parentId,
      body: args.body,
    });
    const snippet = snippetFromBody(args.body);

    // Create mention rows. Validate that every mentioned user can actually
    // see this context — silently drop the rest. For each surviving
    // mention, schedule an outbound email if the user has an address on
    // file.
    const mentionIds = Array.from(new Set(args.mentionClerkIds ?? []));
    for (const clerkId of mentionIds) {
      if (workspaceId === null) {
        if (clerkId !== identity.subject) continue;
      } else {
        const member = await ctx.db
          .query("memberships")
          .withIndex("by_user_and_workspace", (q) =>
            q.eq("userClerkId", clerkId).eq("workspaceId", workspaceId),
          )
          .unique();
        if (!member) continue;
      }
      // Don't notify yourself.
      if (clerkId === identity.subject) continue;
      await ctx.db.insert("mentions", {
        messageId,
        mentionedClerkId: clerkId,
        parentType: args.parentType,
        parentId: args.parentId,
        createdAt: Date.now(),
      });

      const recipient = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
        .unique();
      if (recipient?.email) {
        await ctx.scheduler.runAfter(
          0,
          internal.notifications.sendMentionEmail,
          {
            toEmail: recipient.email,
            toName: recipient.name,
            fromName: authorName,
            snippet,
            contextLabel,
          },
        );
      }
    }

    return messageId;
  },
});

export const update = mutation({
  args: {
    messageId: v.id("messages"),
    body: v.string(),
    mentionClerkIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { messageId, body, mentionClerkIds }) => {
    const identity = await requireIdentity(ctx);
    const msg = await ctx.db.get(messageId);
    if (!msg) throw new Error("Message not found");
    if (msg.authorClerkId !== identity.subject) {
      throw new Error("Only the author can edit");
    }
    const { workspaceId } = await requireMessageParentAccess(
      ctx,
      msg.parentType,
      msg.parentId,
    );

    await ctx.db.patch(messageId, { body, editedAt: Date.now() });

    // Replace mentions: drop old rows, recreate from the new list.
    if (mentionClerkIds) {
      const old = await ctx.db
        .query("mentions")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .collect();
      for (const m of old) await ctx.db.delete(m._id);

      for (const clerkId of new Set(mentionClerkIds)) {
        if (clerkId === identity.subject) continue;
        if (workspaceId !== null) {
          const member = await ctx.db
            .query("memberships")
            .withIndex("by_user_and_workspace", (q) =>
              q.eq("userClerkId", clerkId).eq("workspaceId", workspaceId),
            )
            .unique();
          if (!member) continue;
        }
        await ctx.db.insert("mentions", {
          messageId,
          mentionedClerkId: clerkId,
          parentType: msg.parentType,
          parentId: msg.parentId,
          createdAt: Date.now(),
        });
      }
    }
  },
});

export const remove = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const identity = await requireIdentity(ctx);
    const msg = await ctx.db.get(messageId);
    if (!msg) return;
    if (msg.authorClerkId !== identity.subject) {
      throw new Error("Only the author can delete");
    }
    // Cascade replies and mentions.
    const replies = await ctx.db
      .query("messages")
      .withIndex("by_parent_message", (q) =>
        q.eq("parentMessageId", messageId),
      )
      .collect();
    for (const r of replies) {
      const ms = await ctx.db
        .query("mentions")
        .withIndex("by_message", (q) => q.eq("messageId", r._id))
        .collect();
      for (const m of ms) await ctx.db.delete(m._id);
      await ctx.db.delete(r._id);
    }
    const ms = await ctx.db
      .query("mentions")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .collect();
    for (const m of ms) await ctx.db.delete(m._id);
    await ctx.db.delete(messageId);
  },
});

export const resolve = mutation({
  args: { messageId: v.id("messages"), resolved: v.boolean() },
  handler: async (ctx, { messageId, resolved }) => {
    const identity = await requireIdentity(ctx);
    const msg = await ctx.db.get(messageId);
    if (!msg) throw new Error("Message not found");
    await requireMessageParentAccess(ctx, msg.parentType, msg.parentId);
    if (resolved) {
      await ctx.db.patch(messageId, {
        resolvedAt: Date.now(),
        resolvedByClerkId: identity.subject,
      });
    } else {
      await ctx.db.patch(messageId, {
        resolvedAt: undefined,
        resolvedByClerkId: undefined,
      });
    }
  },
});
