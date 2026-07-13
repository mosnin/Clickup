import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireIdentity, requireMessageParentAccess } from "./_authz";
import type { Actor } from "./_agentAuth";
import { emitEvent, scopeForList } from "./events";

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

// Scope (personal user / workspace) that a message parent lives in, for
// event emission.
export async function scopeForMessageParent(
  ctx: QueryCtx | MutationCtx,
  parentType: "task" | "space" | "workspace",
  parentId: string,
): Promise<{ scopeType: "user" | "workspace"; scopeId: string } | null> {
  if (parentType === "workspace") {
    return { scopeType: "workspace", scopeId: parentId };
  }
  if (parentType === "space") {
    const space = await ctx.db.get(parentId as Id<"spaces">);
    if (!space) return null;
    return { scopeType: space.parentType, scopeId: space.parentId };
  }
  const task = await ctx.db.get(parentId as Id<"tasks">);
  if (!task) return null;
  const list = await ctx.db.get(task.listId);
  if (!list) return null;
  return await scopeForList(ctx, list);
}

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

// Mention candidates for the given parent: workspace members (or the
// personal user), plus every AI agent in the same scope. Agents come back
// user-shaped (their id in `clerkId`) so the composer, pills, and author
// rendering work unchanged; `isAgent` lets the UI badge them.
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

    const people: {
      clerkId: string;
      name?: string;
      email: string;
      imageUrl?: string;
      isAgent?: boolean;
    }[] = [];

    if (workspaceId === null) {
      // Personal — only the current user.
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
        .unique();
      if (user) people.push(user);
    } else {
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId!))
        .collect();
      for (const m of memberships) {
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", m.userClerkId))
          .unique();
        if (user) people.push(user);
      }
    }

    const scope =
      workspaceId === null
        ? { parentType: "user" as const, parentId: identity.subject }
        : { parentType: "workspace" as const, parentId: workspaceId };
    const agents = await ctx.db
      .query("agents")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", scope.parentType).eq("parentId", scope.parentId),
      )
      .collect();
    for (const a of agents) {
      people.push({
        clerkId: a._id,
        name: `${a.emoji ?? "🤖"} ${a.name}`,
        email: "",
        isAgent: true,
      });
    }
    return people;
  },
});

// Is this id mentionable in the given scope? Members are; so are agents
// that live in the scope.
async function canBeMentioned(
  ctx: MutationCtx,
  id: string,
  workspaceId: Id<"workspaces"> | null,
  personalSubject: string | null,
): Promise<boolean> {
  if (workspaceId !== null) {
    const member = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q.eq("userClerkId", id).eq("workspaceId", workspaceId),
      )
      .unique();
    if (member) return true;
  } else if (personalSubject !== null && id === personalSubject) {
    return true;
  }
  // Agent ids are Convex document ids; a failed normalize is just "not an
  // agent".
  const agentId = ctx.db.normalizeId("agents", id);
  if (!agentId) return false;
  const agent = await ctx.db.get(agentId);
  if (!agent) return false;
  if (workspaceId !== null) {
    return (
      agent.parentType === "workspace" && agent.parentId === workspaceId
    );
  }
  return (
    agent.parentType === "user" && agent.parentId === (personalSubject ?? "")
  );
}

// ── Core write path (shared with the agent API) ────────────────────────

export type CreateMessageArgs = {
  parentType: "task" | "space" | "workspace";
  parentId: string;
  body: string;
  parentMessageId?: Id<"messages">;
  assigneeClerkId?: string;
  mentionIds?: string[];
};

export async function createMessageCore(
  ctx: MutationCtx,
  args: CreateMessageArgs,
  actor: Actor,
  workspaceId: Id<"workspaces"> | null,
): Promise<Id<"messages">> {
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
    authorClerkId: actor.id,
    body: args.body,
    parentMessageId: args.parentMessageId,
    assigneeClerkId: args.assigneeClerkId,
    createdAt: Date.now(),
  });

  const contextLabel = await describeMessageContext(ctx, {
    parentType: args.parentType,
    parentId: args.parentId,
    body: args.body,
  });
  const snippet = snippetFromBody(args.body);

  const scope = await scopeForMessageParent(
    ctx,
    args.parentType,
    args.parentId,
  );
  // In personal scope, the only mentionable human is the space owner.
  const personalOwner =
    workspaceId === null && scope?.scopeType === "user"
      ? scope.scopeId
      : null;
  if (scope) {
    await emitEvent(ctx, {
      ...scope,
      type: "comment.created",
      actor,
      entityType: "message",
      entityId: messageId,
      entityTitle: contextLabel,
      payload: {
        parentType: args.parentType,
        parentId: args.parentId,
        snippet,
      },
    });
  }

  // Create mention rows. Validate that every mentioned principal can
  // actually see this context — silently drop the rest. Mentioned humans
  // get an email; mentioned agents get an event (their MCP inbox +
  // webhooks pick it up).
  const mentionIds = Array.from(new Set(args.mentionIds ?? []));
  for (const id of mentionIds) {
    if (id === actor.id) continue;
    const allowed = await canBeMentioned(ctx, id, workspaceId, personalOwner);
    if (!allowed) continue;

    await ctx.db.insert("mentions", {
      messageId,
      mentionedClerkId: id,
      parentType: args.parentType,
      parentId: args.parentId,
      createdAt: Date.now(),
    });

    if (scope) {
      await emitEvent(ctx, {
        ...scope,
        type: "mention.created",
        actor,
        entityType: "message",
        entityId: messageId,
        entityTitle: contextLabel,
        payload: { mentionedId: id, snippet },
      });
    }

    const recipient = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", id))
      .unique();
    if (recipient?.email) {
      await ctx.scheduler.runAfter(
        0,
        internal.notifications.sendMentionEmail,
        {
          toEmail: recipient.email,
          toName: recipient.name,
          fromName: actor.name,
          snippet,
          contextLabel,
        },
      );
    }
  }

  return messageId;
}

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
    const author = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
    const actor: Actor = {
      type: "user",
      id: identity.subject,
      name: author?.name ?? author?.email ?? "Someone",
    };
    return await createMessageCore(
      ctx,
      {
        parentType: args.parentType,
        parentId: args.parentId,
        body: args.body,
        parentMessageId: args.parentMessageId,
        assigneeClerkId: args.assigneeClerkId,
        mentionIds: args.mentionClerkIds,
      },
      actor,
      workspaceId,
    );
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

      for (const id of new Set(mentionClerkIds)) {
        if (id === identity.subject) continue;
        const allowed = await canBeMentioned(
          ctx,
          id,
          workspaceId,
          workspaceId === null ? identity.subject : null,
        );
        if (!allowed) continue;
        await ctx.db.insert("mentions", {
          messageId,
          mentionedClerkId: id,
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
