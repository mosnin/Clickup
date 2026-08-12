import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireTaskAccess } from "./_authz";

// The one queue of things waiting on a person.
//
// Four sources, gathered here rather than on four screens — see
// src/lib/obligations.ts for why this is a queue (oldest-first, counted)
// rather than a fifth feed.
//
// Every source is access-checked on its own terms rather than trusted: an
// obligation is a pointer into somebody's work, and a queue that gathered
// four kinds of pointer without re-checking each one would be a neat way to
// enumerate a workspace you cannot open. Each `catch { continue }` below is
// that check refusing, and dropping the row silently is correct — the reader
// is not entitled to know the thing exists.

type Row = {
  kind:
    | "approval"
    | "revision"
    | "question"
    | "outcome"
    | "handback"
    | "stuck";
  id: string;
  title: string;
  href: string;
  place?: string;
  raisedBy?: string;
  createdAt: number;
};

/** Bounded per source: a queue is for answering, not for scrolling. */
const PER_SOURCE = 50;

/**
 * Every scope this person can see: their own, plus each workspace they
 * belong to. The visibility boundary the rest of the product uses, resolved
 * once and shared by the sources that key off scope.
 */
async function visibleScopes(
  ctx: { db: QueryCtx["db"] },
  subject: string,
): Promise<{ scopeType: "user" | "workspace"; scopeId: string }[]> {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userClerkId", subject))
    .take(50);
  return [
    { scopeType: "user" as const, scopeId: subject },
    ...memberships.map((m) => ({
      scopeType: "workspace" as const,
      scopeId: m.workspaceId as string,
    })),
  ];
}

export const forCurrentUser = query({
  args: {},
  handler: async (ctx): Promise<Row[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const rows: Row[] = [];

    // ── Tasks behind an approval gate ──
    const gated = await ctx.db
      .query("tasks")
      .withIndex("by_approval", (q) => q.eq("requiresApproval", true))
      .take(200);
    for (const task of gated) {
      if (task.approvedAt !== undefined) continue;
      const status = await ctx.db.get(task.statusId);
      if (status?.category === "complete" || status?.category === "closed") {
        continue;
      }
      try {
        await requireTaskAccess(ctx, task._id);
      } catch {
        continue;
      }
      rows.push({
        kind: "approval",
        id: task._id,
        title: task.title,
        href: `/dashboard/l/${task.listId}/t/${task._id}`,
        createdAt: task.createdAt,
      });
      if (rows.length >= PER_SOURCE) break;
    }

    // ── Revisions somebody asked for and nobody answered ──
    //
    // "Open" is the state that waits on the person who has to make the
    // change; "addressed" waits on the requester to accept, which is a
    // different obligation and belongs to a different person — so only the
    // requester's own addressed rows come back to them.
    const revisions = await ctx.db
      .query("revisions")
      .withIndex("by_status", (q) => q.eq("status", "addressed"))
      .take(200);
    for (const revision of revisions) {
      if (revision.requestedByActorId !== identity.subject) continue;
      if (revision.parentType !== "task") continue;
      let listId: string | null = null;
      try {
        const { task } = await requireTaskAccess(
          ctx,
          revision.parentId as Parameters<typeof requireTaskAccess>[1],
        );
        listId = task.listId;
      } catch {
        continue;
      }
      rows.push({
        kind: "revision",
        id: revision._id,
        title: revision.body.slice(0, 140),
        href: `/dashboard/l/${listId}/t/${revision.parentId}`,
        raisedBy: revision.addressedByName,
        createdAt: revision.addressedAt ?? revision.createdAt,
      });
      if (rows.length >= PER_SOURCE * 2) break;
    }

    // ── Plan questions a person reserved for themselves ──
    //
    // `needsHuman` means an agent's answer lands unaccepted: the question is
    // open until a person rules on it, which is exactly an obligation.
    //
    // A question carries its scope denormalized (`scopeType`/`scopeId`), so
    // the visibility check is the scope itself rather than a walk up to the
    // project — cheaper, and it is the same boundary the agent side checks.
    const scopes = await visibleScopes(ctx, identity.subject);
    for (const scope of scopes) {
      const questions = await ctx.db
        .query("planNodes")
        .withIndex("by_scope_and_kind", (q) =>
          q
            .eq("scopeType", scope.scopeType)
            .eq("scopeId", scope.scopeId)
            .eq("kind", "question"),
        )
        .take(100);
      for (const node of questions) {
        if (node.needsHuman !== true) continue;
        if (node.retractedAt !== undefined) continue;
        // A question with an accepted decision under it is answered.
        const decisions = await ctx.db
          .query("planNodes")
          .withIndex("by_parent", (q) => q.eq("parentId", node._id))
          .take(20);
        const settled = decisions.some(
          (d) =>
            d.kind === "decision" &&
            d.retractedAt === undefined &&
            d.acceptedAt !== undefined,
        );
        if (settled) continue;
        rows.push({
          kind: "question",
          id: node._id,
          title: node.body.slice(0, 140),
          href: `/dashboard/p/${node.projectId}`,
          createdAt: node.createdAt,
        });
      }
      if (rows.length >= PER_SOURCE * 3) break;
    }

    // ── Outcome criteria with evidence submitted and nobody signing off ──
    //
    // Walked from the workspaces this person belongs to rather than from
    // every submitted check in the deployment: a plan is keyed by workspace,
    // so starting at the reader's own workspaces is both the cheaper range
    // and the visibility boundary itself, instead of a filter applied after
    // reading rows they cannot see.
    for (const scope of scopes) {
      if (scope.scopeType !== "workspace") continue;
      const plans = await ctx.db
        .query("executionPlans")
        .withIndex("by_workspace", (q) =>
          q.eq("workspaceId", scope.scopeId as Id<"workspaces">),
        )
        .take(50);
      for (const plan of plans) {
        const checks = await ctx.db
          .query("outcomeChecks")
          .withIndex("by_plan", (q) => q.eq("planId", plan._id))
          .take(50);
        for (const check of checks) {
          if (check.status !== "submitted") continue;
          rows.push({
            kind: "outcome",
            id: check._id,
            title: check.criterion.slice(0, 140),
            href: `/dashboard/w/${plan.workspaceId}`,
            createdAt: check.submittedAt ?? check.updatedAt,
          });
        }
      }
      if (rows.length >= PER_SOURCE * 4) break;
    }

    // ── Work an agent finished, waiting for consent ──
    //
    // The fifth source, and the one that arrives fastest: a fleet clearing
    // gated tasks all afternoon produces one of these per task. It goes here
    // rather than on its own screen for the reason the other four did — a
    // fifth place to look is a fifth place to forget — and it is the source
    // most expensive to miss, because until somebody decides, the work is
    // done and the task still says it is not.
    for (const scope of await visibleScopes(ctx, identity.subject)) {
      const effects = await ctx.db
        .query("pendingEffects")
        .withIndex("by_scope_and_state", (q) =>
          q
            .eq("scopeType", scope.scopeType)
            .eq("scopeId", scope.scopeId)
            .eq("state", "pending"),
        )
        .take(PER_SOURCE);
      for (const effect of effects) {
        const task = await ctx.db.get(effect.taskId);
        if (!task) continue;
        try {
          await requireTaskAccess(ctx, effect.taskId);
        } catch {
          continue;
        }
        rows.push({
          kind: "handback",
          id: effect._id,
          title: task.title,
          href: `/dashboard/inbox`,
          raisedBy: effect.agentName,
          createdAt: effect.createdAt,
        });
      }
    }

    // ── Tasks held after failing over and over ──
    //
    // The sixth source, and the only one nobody asked for: the others are
    // raised by a person or an agent deciding they need you, this one is
    // raised by a watchdog noticing that nothing is going to fix itself. It
    // belongs here because the hold BLOCKS work — the task is withheld from
    // the dispatcher until somebody looks — so it is waiting on a human in
    // the most literal sense of any row in the queue.
    const held = await ctx.db
      .query("tasks")
      .withIndex("by_thrash_held", (q) => q.gt("thrashHeldAt", 0))
      .take(PER_SOURCE);
    for (const task of held) {
      try {
        await requireTaskAccess(ctx, task._id);
      } catch {
        continue;
      }
      rows.push({
        kind: "stuck",
        id: task._id,
        title: task.title,
        href: `/dashboard/l/${task.listId}/t/${task._id}`,
        createdAt: task.thrashHeldAt ?? task.createdAt,
      });
    }

    // Oldest first — the whole point. See sortObligations; every source this
    // replaces sorted newest-first, which buries the one most likely to have
    // been forgotten.
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  },
});

/**
 * Just the number, for the badge.
 *
 * A separate query rather than `.length` on the list: a count somebody reads
 * on every page must not carry the payload of a queue nobody opened.
 */
export const countForCurrentUser = query({
  args: {},
  handler: async (ctx): Promise<number> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return 0;
    let count = 0;
    const gated = await ctx.db
      .query("tasks")
      .withIndex("by_approval", (q) => q.eq("requiresApproval", true))
      .take(200);
    for (const task of gated) {
      if (task.approvedAt !== undefined) continue;
      const status = await ctx.db.get(task.statusId);
      if (status?.category === "complete" || status?.category === "closed") {
        continue;
      }
      try {
        await requireTaskAccess(ctx, task._id);
        count += 1;
      } catch {
        continue;
      }
    }
    for (const scope of await visibleScopes(ctx, identity.subject)) {
      const effects = await ctx.db
        .query("pendingEffects")
        .withIndex("by_scope_and_state", (q) =>
          q
            .eq("scopeType", scope.scopeType)
            .eq("scopeId", scope.scopeId)
            .eq("state", "pending"),
        )
        .take(PER_SOURCE);
      for (const effect of effects) {
        try {
          await requireTaskAccess(ctx, effect.taskId);
          count += 1;
        } catch {
          // Not yours to know about.
        }
      }
    }
    const heldTasks = await ctx.db
      .query("tasks")
      .withIndex("by_thrash_held", (q) => q.gt("thrashHeldAt", 0))
      .take(PER_SOURCE);
    for (const task of heldTasks) {
      try {
        await requireTaskAccess(ctx, task._id);
        count += 1;
      } catch {
        continue;
      }
    }
    for (const scope of await visibleScopes(ctx, identity.subject)) {
      if (scope.scopeType !== "workspace") continue;
      const plans = await ctx.db
        .query("executionPlans")
        .withIndex("by_workspace", (q) =>
          q.eq("workspaceId", scope.scopeId as Id<"workspaces">),
        )
        .take(50);
      for (const plan of plans) {
        const checks = await ctx.db
          .query("outcomeChecks")
          .withIndex("by_plan", (q) => q.eq("planId", plan._id))
          .take(50);
        count += checks.filter((c) => c.status === "submitted").length;
      }
    }
    return count;
  },
});
