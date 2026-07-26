import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity, requireListAccess, requireTaskAccess } from "./_authz";
import { emitEvent, scopeForList, userActor } from "./events";
import type { Actor } from "./_agentAuth";

// Revision requests — "this isn't right yet, here's what to change."
//
// Why this is not just a comment: a comment has no state. Nothing tells you
// which asks are still outstanding, and an agent reading a thread cannot
// distinguish a passing remark from a blocking correction. A revision is
// explicit, has a lifecycle, and shows up in the agent's own queue.
//
// The asymmetry mirrors approval gates, for the same reason: an agent may say
// "I addressed it", but only a person decides whether it is actually done.
//   open      -> anyone with access asks for a change
//   addressed -> whoever did the work reports back, with a note
//   accepted  -> a human agrees it's resolved
//   reopened  -> a human disagrees; back to open
//
// Both humans and agents go through the cores here, so events, authorization
// and notifications behave identically from either side (the Actor pattern —
// see CLAUDE.md; never add a second write path for agents).

export type RevisionParentType = "task" | "list";

const parentTypeValidator = v.union(v.literal("task"), v.literal("list"));

/** The project a revision hangs off, whichever parent kind it has. */
async function projectForParent(
  ctx: QueryCtx | MutationCtx,
  parentType: RevisionParentType,
  parentId: string,
): Promise<Doc<"lists">> {
  if (parentType === "list") {
    const list = await ctx.db.get(parentId as Id<"lists">);
    if (!list) throw new ConvexError("Project not found");
    return list;
  }
  const task = await ctx.db.get(parentId as Id<"tasks">);
  if (!task) throw new ConvexError("Task not found");
  const list = await ctx.db.get(task.listId);
  if (!list) throw new ConvexError("Project not found");
  return list;
}

/**
 * Access check for a revision's parent. Reuses the task/list helpers rather
 * than re-deriving the hierarchy, so a revision is exactly as reachable as the
 * thing it is about — never more.
 */
async function requireParentAccess(
  ctx: QueryCtx | MutationCtx,
  parentType: RevisionParentType,
  parentId: string,
): Promise<void> {
  if (parentType === "task") {
    await requireTaskAccess(ctx, parentId as Id<"tasks">);
    return;
  }
  await requireListAccess(ctx, parentId as Id<"lists">);
}

/** Event emission shared by every write below. */
async function emitRevisionEvent(
  ctx: MutationCtx,
  args: {
    type: string;
    revision: Pick<Doc<"revisions">, "parentType" | "parentId">;
    revisionId: Id<"revisions">;
    actor: Actor;
    summary: string;
  },
): Promise<void> {
  const list = await projectForParent(
    ctx,
    args.revision.parentType,
    args.revision.parentId,
  );
  const scope = await scopeForList(ctx, list);
  if (!scope) return;
  await emitEvent(ctx, {
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    type: args.type,
    actor: args.actor,
    entityType: "revision",
    entityId: args.revisionId,
    entityTitle: args.summary,
    listId: list._id,
    payload: {
      parentType: args.revision.parentType,
      parentId: args.revision.parentId,
    },
  });
}

/** One-line event title: the log is a feed, not a second copy of the content. */
function shorten(text: string): string {
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

// ── Cores, shared with agentApi ───────────────────────────────────────────

export async function createRevisionCore(
  ctx: MutationCtx,
  args: { parentType: RevisionParentType; parentId: string; body: string },
  actor: Actor,
): Promise<Id<"revisions">> {
  const body = args.body.trim();
  if (!body) throw new ConvexError("A revision needs to say what to change");
  const revisionId = await ctx.db.insert("revisions", {
    parentType: args.parentType,
    parentId: args.parentId,
    body,
    status: "open",
    requestedByActorId: actor.id,
    requestedByName: actor.name,
    createdAt: Date.now(),
  });
  await emitRevisionEvent(ctx, {
    type: "revision.requested",
    revision: args,
    revisionId,
    actor,
    summary: shorten(body),
  });
  return revisionId;
}

export async function addressRevisionCore(
  ctx: MutationCtx,
  args: { revisionId: Id<"revisions">; note?: string },
  actor: Actor,
): Promise<void> {
  const revision = await ctx.db.get(args.revisionId);
  if (!revision) throw new ConvexError("Revision not found");
  if (revision.status === "accepted") {
    throw new ConvexError("That revision has already been accepted");
  }
  const note = args.note?.trim();
  await ctx.db.patch(args.revisionId, {
    status: "addressed",
    addressedAt: Date.now(),
    addressedByActorId: actor.id,
    addressedByName: actor.name,
    responseNote: note || undefined,
  });
  await emitRevisionEvent(ctx, {
    type: "revision.addressed",
    revision,
    revisionId: args.revisionId,
    actor,
    summary: note ? shorten(note) : "Reported the revision as addressed",
  });
}

/** Every revision on one parent, newest first. */
export async function revisionsForParent(
  ctx: QueryCtx,
  parentType: RevisionParentType,
  parentId: string,
): Promise<Doc<"revisions">[]> {
  const rows = await ctx.db
    .query("revisions")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", parentType).eq("parentId", parentId),
    )
    .collect();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

/** Just the ones still needing work — what an agent actually wants. */
export function openOnly(rows: Doc<"revisions">[]): Doc<"revisions">[] {
  return rows.filter((r) => r.status === "open");
}

// ── Human-facing API ─────────────────────────────────────────────────────

export const forParent = query({
  args: { parentType: parentTypeValidator, parentId: v.string() },
  handler: async (ctx, { parentType, parentId }) => {
    await requireParentAccess(ctx, parentType, parentId);
    return await revisionsForParent(ctx, parentType, parentId);
  },
});

export const request = mutation({
  args: {
    parentType: parentTypeValidator,
    parentId: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await requireParentAccess(ctx, args.parentType, args.parentId);
    return await createRevisionCore(
      ctx,
      args,
      await userActor(ctx, identity.subject),
    );
  },
});

export const address = mutation({
  args: { revisionId: v.id("revisions"), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const revision = await ctx.db.get(args.revisionId);
    if (!revision) throw new ConvexError("Revision not found");
    await requireParentAccess(ctx, revision.parentType, revision.parentId);
    await addressRevisionCore(
      ctx,
      args,
      await userActor(ctx, identity.subject),
    );
  },
});

/**
 * Accept or reopen. Deliberately human-only — there is no agent-side
 * equivalent, the same way an agent can raise an approval gate but never lower
 * it. An agent accepting its own work would make the whole object decorative.
 */
export const decide = mutation({
  args: { revisionId: v.id("revisions"), accept: v.boolean() },
  handler: async (ctx, { revisionId, accept }) => {
    const identity = await requireIdentity(ctx);
    const revision = await ctx.db.get(revisionId);
    if (!revision) throw new ConvexError("Revision not found");
    await requireParentAccess(ctx, revision.parentType, revision.parentId);

    if (accept) {
      await ctx.db.patch(revisionId, {
        status: "accepted",
        acceptedAt: Date.now(),
        acceptedByClerkId: identity.subject,
      });
    } else {
      // Reopening clears the response, so the next reader never sees a stale
      // "addressed" note sitting under an open status contradicting it.
      await ctx.db.patch(revisionId, {
        status: "open",
        addressedAt: undefined,
        addressedByActorId: undefined,
        addressedByName: undefined,
        responseNote: undefined,
        acceptedAt: undefined,
        acceptedByClerkId: undefined,
      });
    }

    await emitRevisionEvent(ctx, {
      type: accept ? "revision.accepted" : "revision.reopened",
      revision,
      revisionId,
      actor: await userActor(ctx, identity.subject),
      summary: accept ? "Accepted the revision" : "Reopened the revision",
    });
  },
});

export const remove = mutation({
  args: { revisionId: v.id("revisions") },
  handler: async (ctx, { revisionId }) => {
    await requireIdentity(ctx);
    const revision = await ctx.db.get(revisionId);
    if (!revision) return;
    await requireParentAccess(ctx, revision.parentType, revision.parentId);
    await ctx.db.delete(revisionId);
  },
});
