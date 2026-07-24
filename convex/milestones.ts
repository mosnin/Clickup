import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireListAccess } from "./_authz";
import type { Actor } from "./_agentAuth";
import { emitEvent, scopeForList, userActor } from "./events";

// Milestones: named, dated checkpoints inside ONE project (a `lists` row).
// A roadmap phase sequences projects at the workspace level and the
// `tasks.milestone` boolean flags a single date-anchored task; neither
// gives a project its own internal checkpoints, which is what this is.
//
// Progress is derived, never stored: a milestone's done/total come from the
// tasks pointing at it (tasks.milestoneId) and their status categories —
// same style as goals.withDerivedProgress, so the number can never drift
// from the work. `status` stays a human/agent judgement call ("this
// checkpoint is signed off"), independent of the task counts.
//
// Both entry points (the Clerk-authenticated mutations at the bottom and
// the key-authenticated agent surface in agentApi.ts) route through the
// *Core functions so events carry the real actor either way.

export type MilestoneView = {
  _id: Id<"milestones">;
  listId: Id<"lists">;
  name: string;
  description?: string;
  targetDate?: number;
  position: number;
  status: "open" | "complete";
  completedAt?: number;
  createdByActorId: string;
  createdAt: number;
  /** Tasks linked to this milestone. */
  total: number;
  /** Linked tasks in a complete/closed-category status. */
  done: number;
};

function view(m: Doc<"milestones">, counts: { total: number; done: number }): MilestoneView {
  return {
    _id: m._id,
    listId: m.listId,
    name: m.name,
    description: m.description,
    targetDate: m.targetDate,
    position: m.position,
    status: m.status,
    completedAt: m.completedAt,
    createdByActorId: m.createdByActorId,
    createdAt: m.createdAt,
    ...counts,
  };
}

// Every milestone of a list, ordered by position, each carrying its derived
// task counts. One pass over the list's statuses + tasks (not one query per
// milestone), so a project with a dozen checkpoints still costs two reads.
export async function milestonesWithProgress(
  ctx: QueryCtx | MutationCtx,
  listId: Id<"lists">,
): Promise<MilestoneView[]> {
  const milestones = await ctx.db
    .query("milestones")
    .withIndex("by_list", (q) => q.eq("listId", listId))
    .collect();
  if (milestones.length === 0) return [];

  const statuses = await ctx.db
    .query("listStatuses")
    .withIndex("by_list", (q) => q.eq("listId", listId))
    .collect();
  const doneStatusIds = new Set(
    statuses
      .filter((s) => s.category === "complete" || s.category === "closed")
      .map((s) => s._id),
  );
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_list", (q) => q.eq("listId", listId))
    .collect();

  const counts = new Map<string, { total: number; done: number }>();
  for (const t of tasks) {
    if (!t.milestoneId) continue;
    const bucket = counts.get(t.milestoneId) ?? { total: 0, done: 0 };
    bucket.total += 1;
    if (doneStatusIds.has(t.statusId)) bucket.done += 1;
    counts.set(t.milestoneId, bucket);
  }

  return milestones
    .sort((a, b) => a.position - b.position)
    .map((m) => view(m, counts.get(m._id) ?? { total: 0, done: 0 }));
}

async function emitMilestoneEvent(
  ctx: MutationCtx,
  milestone: Doc<"milestones">,
  type: string,
  actor: Actor,
  payload?: unknown,
): Promise<void> {
  const list = await ctx.db.get(milestone.listId);
  if (!list) return;
  const scope = await scopeForList(ctx, list);
  if (!scope) return;
  await emitEvent(ctx, {
    ...scope,
    type,
    actor,
    entityType: "milestone",
    entityId: milestone._id,
    entityTitle: milestone.name,
    // Carried so event deep links can reach the project this checkpoint
    // lives on (a milestone has no page of its own).
    listId: milestone.listId,
    payload,
  });
}

// ── Cores (shared with agentApi) ───────────────────────────────────────

export type CreateMilestoneArgs = {
  name: string;
  description?: string;
  targetDate?: number;
};

export async function createMilestoneCore(
  ctx: MutationCtx,
  list: Doc<"lists">,
  args: CreateMilestoneArgs,
  actor: Actor,
): Promise<Id<"milestones">> {
  const name = args.name.trim();
  if (!name) throw new ConvexError("Milestone name is required");
  const siblings = await ctx.db
    .query("milestones")
    .withIndex("by_list", (q) => q.eq("listId", list._id))
    .collect();
  // max+1, not count: deletes leave gaps, so length would collide.
  const maxPosition = siblings.reduce((m, s) => Math.max(m, s.position), -1);
  const milestoneId = await ctx.db.insert("milestones", {
    listId: list._id,
    name,
    description: args.description?.trim() || undefined,
    targetDate: args.targetDate,
    position: maxPosition + 1,
    status: "open",
    createdByActorId: actor.id,
    createdAt: Date.now(),
  });
  const created = (await ctx.db.get(milestoneId))!;
  await emitMilestoneEvent(ctx, created, "milestone.created", actor, {
    targetDate: args.targetDate,
  });
  return milestoneId;
}

export type UpdateMilestoneArgs = {
  name?: string;
  description?: string | null;
  targetDate?: number | null;
  status?: "open" | "complete";
};

export async function updateMilestoneCore(
  ctx: MutationCtx,
  milestone: Doc<"milestones">,
  args: UpdateMilestoneArgs,
  actor: Actor,
): Promise<void> {
  const patch: Record<string, unknown> = {};
  const changedFields: string[] = [];
  if (args.name !== undefined) {
    const name = args.name.trim();
    if (!name) throw new ConvexError("Milestone name is required");
    if (name !== milestone.name) {
      patch.name = name;
      changedFields.push("name");
    }
  }
  if (args.description !== undefined) {
    // null clears; the client can't send `undefined` (Convex drops the key
    // from the wire), so null is the only working "no description" signal.
    patch.description = args.description?.trim() || undefined;
    changedFields.push("description");
  }
  if (args.targetDate !== undefined) {
    patch.targetDate = args.targetDate ?? undefined;
    changedFields.push("targetDate");
  }
  const completing =
    args.status !== undefined && args.status !== milestone.status;
  if (completing) {
    patch.status = args.status;
    patch.completedAt = args.status === "complete" ? Date.now() : undefined;
    changedFields.push("status");
  }
  if (changedFields.length === 0) return;

  await ctx.db.patch(milestone._id, patch);
  const updated = (await ctx.db.get(milestone._id))!;
  // A checkpoint being reached is its own moment in the feed; everything
  // else is an ordinary edit.
  if (completing && args.status === "complete") {
    await emitMilestoneEvent(ctx, updated, "milestone.completed", actor);
  } else {
    await emitMilestoneEvent(ctx, updated, "milestone.updated", actor, {
      fields: changedFields,
    });
  }
}

// Deleting a checkpoint must never delete the work under it: linked tasks
// are unlinked, not removed.
export async function removeMilestoneCore(
  ctx: MutationCtx,
  milestone: Doc<"milestones">,
  actor: Actor,
): Promise<void> {
  const linked = await ctx.db
    .query("tasks")
    .withIndex("by_milestone", (q) => q.eq("milestoneId", milestone._id))
    .collect();
  for (const t of linked) {
    await ctx.db.patch(t._id, { milestoneId: undefined });
  }
  await emitMilestoneEvent(ctx, milestone, "milestone.deleted", actor, {
    unlinkedTasks: linked.length,
  });
  await ctx.db.delete(milestone._id);
}

export async function reorderMilestonesCore(
  ctx: MutationCtx,
  listId: Id<"lists">,
  orderedIds: Id<"milestones">[],
): Promise<void> {
  for (let i = 0; i < orderedIds.length; i++) {
    const milestone = await ctx.db.get(orderedIds[i]);
    // Stale client order (a milestone deleted or from another project) —
    // skip rather than corrupt positions.
    if (!milestone || milestone.listId !== listId) continue;
    if (milestone.position !== i) {
      await ctx.db.patch(milestone._id, { position: i });
    }
  }
}

// Delete every milestone of a list. Called from lists.removeListCore, where
// the tasks are being deleted anyway, so there's nothing to unlink.
export async function deleteMilestonesForList(
  ctx: MutationCtx,
  listId: Id<"lists">,
): Promise<void> {
  const milestones = await ctx.db
    .query("milestones")
    .withIndex("by_list", (q) => q.eq("listId", listId))
    .collect();
  for (const m of milestones) await ctx.db.delete(m._id);
}

// Resolve a milestone plus its project, gating on the project the same way
// every other list-scoped read/write does.
async function requireMilestoneAccess(
  ctx: QueryCtx | MutationCtx,
  milestoneId: Id<"milestones">,
) {
  const milestone = await ctx.db.get(milestoneId);
  if (!milestone) throw new ConvexError("Milestone not found");
  const { list, identity } = await requireListAccess(ctx, milestone.listId);
  return { milestone, list, identity };
}

// ── Clerk-authenticated API ────────────────────────────────────────────

export const listForList = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    // Full hierarchy check, not just "is logged in" — milestone names in
    // foreign projects must not be enumerable by ID.
    try {
      await requireListAccess(ctx, listId);
    } catch {
      return [];
    }
    return await milestonesWithProgress(ctx, listId);
  },
});

export const create = mutation({
  args: {
    listId: v.id("lists"),
    name: v.string(),
    description: v.optional(v.string()),
    targetDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { list, identity } = await requireListAccess(ctx, args.listId);
    const actor = await userActor(ctx, identity.subject);
    return await createMilestoneCore(
      ctx,
      list,
      {
        name: args.name,
        description: args.description,
        targetDate: args.targetDate,
      },
      actor,
    );
  },
});

export const update = mutation({
  args: {
    milestoneId: v.id("milestones"),
    name: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    targetDate: v.optional(v.union(v.number(), v.null())),
    status: v.optional(v.union(v.literal("open"), v.literal("complete"))),
  },
  handler: async (ctx, args) => {
    const { milestone, identity } = await requireMilestoneAccess(
      ctx,
      args.milestoneId,
    );
    const actor = await userActor(ctx, identity.subject);
    await updateMilestoneCore(
      ctx,
      milestone,
      {
        name: args.name,
        description: args.description,
        targetDate: args.targetDate,
        status: args.status,
      },
      actor,
    );
  },
});

export const remove = mutation({
  args: { milestoneId: v.id("milestones") },
  handler: async (ctx, { milestoneId }) => {
    const { milestone, identity } = await requireMilestoneAccess(
      ctx,
      milestoneId,
    );
    const actor = await userActor(ctx, identity.subject);
    await removeMilestoneCore(ctx, milestone, actor);
  },
});

export const reorder = mutation({
  args: {
    listId: v.id("lists"),
    orderedIds: v.array(v.id("milestones")),
  },
  handler: async (ctx, args) => {
    await requireListAccess(ctx, args.listId);
    await reorderMilestonesCore(ctx, args.listId, args.orderedIds);
  },
});
