import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity, requireListAccess, requireTaskAccess } from "./_authz";
import { emitEvent } from "./events";
import { updateTaskCore } from "./tasks";

// Deferred consent: the agent proposes, the human applies.
//
// The reasoning for the whole idea is in src/lib/pending-effects.ts. This file
// is the machinery, and four of its decisions carry weight:
//
// **The gate is enforced in two places on purpose.** `updateTaskCore` still
// refuses an agent completing a gated task, exactly as before — nothing here
// relaxes it. The deferral happens BEFORE the core is called, by a caller that
// checks the same condition and records an effect instead of attempting the
// write. If the deferral path is ever wrong, the core refuses and the worst
// case is the old behaviour; if the core were relaxed to "trust the caller",
// the worst case is a gate that silently stopped gating.
//
// **The recording cannot live inside the refusal.** A Convex mutation that
// throws rolls back everything it wrote, so an effect inserted on the way to
// raising an error would never exist. This is the same lesson the spend
// ceiling learned — a refusal cannot leave a trace of itself, so whatever
// needs to survive has to happen in a call that commits.
//
// **Applying runs through the ordinary core with the AGENT as actor.** Not a
// direct `db.patch`. The agent did the work; a person consented to it. So
// events, automations, recurrence, blocker checks and notifications all fire
// exactly as they would have, and the activity feed reads "scout-agent
// completed X" rather than attributing a fleet's afternoon to whoever happened
// to clear the queue.
//
// **A proposal is about the world it was made in.** Between proposing and
// deciding, somebody else may have moved the task. Approving blind would
// clobber that, so the status the task had at proposal time is recorded and
// checked; a task that moved makes the effect `superseded`, which is a
// discovery rather than a verdict.

/** How many an agent may have waiting per scope before it must stop piling up. */
const MAX_PENDING_PER_AGENT = 200;

/** A batch a person can act on in one click. Bounded because it is a write. */
const MAX_BATCH = 100;

/**
 * Would completing this task be refused for want of a human?
 *
 * The single source of truth for "this is the deferrable case", so the check
 * that decides to defer and the check that refuses cannot drift apart. Reads
 * only — safe to call before deciding which path to take.
 */
export async function completionNeedsApproval(
  ctx: QueryCtx | MutationCtx,
  task: Doc<"tasks">,
  targetStatusId: Id<"listStatuses">,
): Promise<boolean> {
  if (!task.requiresApproval) return false;
  if (task.approvedAt !== undefined) return false;
  const [current, target] = await Promise.all([
    ctx.db.get(task.statusId),
    ctx.db.get(targetStatusId),
  ]);
  const wasComplete =
    current?.category === "complete" || current?.category === "closed";
  const willBeComplete =
    target?.category === "complete" || target?.category === "closed";
  return !wasComplete && willBeComplete;
}

/**
 * Record an agent's completion as pending instead of applying it.
 *
 * Returns the effect id. Idempotent per task: an agent that proposes twice
 * updates its own proposal rather than filing a second one — a retry loop must
 * not be able to turn one decision into fifty. The retry DOES refresh the
 * reason and the basis, because the second attempt is the more recent account
 * of the work.
 */
export async function proposeCompletion(
  ctx: MutationCtx,
  args: {
    task: Doc<"tasks">;
    agent: Doc<"agents">;
    targetStatusId: Id<"listStatuses">;
    reason: string;
  },
): Promise<Id<"pendingEffects">> {
  const reason = args.reason.trim();
  if (!reason) {
    throw new ConvexError(
      "A deferred completion needs a note saying what you did — it is what the person approving it reads instead of re-doing your work.",
    );
  }

  const existing = await ctx.db
    .query("pendingEffects")
    .withIndex("by_task_and_state", (q) =>
      q.eq("taskId", args.task._id).eq("state", "pending"),
    )
    .first();

  if (existing) {
    // Somebody else's agent got there first. Two agents proposing completion
    // of one task is a coordination problem, not a queue problem — surfacing
    // both would ask a person to arbitrate something the claim system exists
    // to prevent.
    if (existing.agentId !== args.agent._id) {
      throw new ConvexError(
        `${existing.agentName} already has a completion awaiting approval on this task.`,
      );
    }
    await ctx.db.patch(existing._id, {
      reason,
      basedOnStatusId: args.task.statusId,
      targetStatusId: args.targetStatusId,
      createdAt: existing.createdAt,
    });
    return existing._id;
  }

  const waiting = await ctx.db
    .query("pendingEffects")
    .withIndex("by_agent_and_state", (q) =>
      q.eq("agentId", args.agent._id).eq("state", "pending"),
    )
    .take(MAX_PENDING_PER_AGENT + 1);
  if (waiting.length > MAX_PENDING_PER_AGENT) {
    // Not a rate limit — a signal. An agent that has finished two hundred
    // gated tasks nobody has looked at is not being helped by finishing a
    // two hundred and first, and a queue that long has stopped being
    // reviewable, which is the failure this whole feature exists to avoid.
    throw new ConvexError(
      `You already have ${MAX_PENDING_PER_AGENT} completions awaiting approval. Stop proposing and tell a human the queue needs clearing.`,
    );
  }

  const effectId = await ctx.db.insert("pendingEffects", {
    scopeType: args.agent.parentType,
    scopeId: args.agent.parentId,
    kind: "task.complete",
    taskId: args.task._id,
    agentId: args.agent._id,
    agentName: args.agent.name,
    reason,
    basedOnStatusId: args.task.statusId,
    targetStatusId: args.targetStatusId,
    state: "pending",
    createdAt: Date.now(),
  });

  await emitEvent(ctx, {
    scopeType: args.agent.parentType,
    scopeId: args.agent.parentId,
    type: "task.effect_proposed",
    actor: { type: "agent", id: args.agent._id, name: args.agent.name },
    entityType: "task",
    entityId: args.task._id,
    entityTitle: args.task.title,
    listId: args.task.listId,
    payload: { kind: "task.complete", reason, effectId },
  });

  return effectId;
}

/** Every scope this person can see. Same boundary the obligations queue uses. */
async function visibleScopes(
  ctx: QueryCtx,
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

type EffectRow = {
  id: Id<"pendingEffects">;
  kind: "task.complete";
  taskId: Id<"tasks">;
  taskTitle: string;
  listId: Id<"lists">;
  agentId: Id<"agents">;
  agentName: string;
  reason: string;
  createdAt: number;
  /** True when the task moved since the proposal — approving will not apply. */
  stale: boolean;
};

/**
 * Everything waiting on this person, oldest first.
 *
 * Access-checked per row on top of the scope range, not instead of it. Scope
 * membership says which workspaces you are in; `requireTaskAccess` says
 * whether you can open this particular task, and a queue that skipped the
 * second check would be a tidy way to enumerate titles inside a workspace you
 * belong to but a list you cannot reach.
 */
export const listForCurrentUser = query({
  args: {},
  handler: async (ctx): Promise<EffectRow[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const rows: EffectRow[] = [];
    for (const scope of await visibleScopes(ctx, identity.subject)) {
      const effects = await ctx.db
        .query("pendingEffects")
        .withIndex("by_scope_and_state", (q) =>
          q
            .eq("scopeType", scope.scopeType)
            .eq("scopeId", scope.scopeId)
            .eq("state", "pending"),
        )
        .take(MAX_BATCH);
      for (const effect of effects) {
        const task = await ctx.db.get(effect.taskId);
        if (!task) continue;
        try {
          await requireTaskAccess(ctx, effect.taskId);
        } catch {
          continue;
        }
        rows.push({
          id: effect._id,
          kind: effect.kind,
          taskId: effect.taskId,
          taskTitle: task.title,
          listId: task.listId,
          agentId: effect.agentId,
          agentName: effect.agentName,
          reason: effect.reason,
          createdAt: effect.createdAt,
          stale: task.statusId !== effect.basedOnStatusId,
        });
      }
    }
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  },
});

/**
 * The completion waiting on a human for one task, if there is one.
 *
 * The task page needs this for the same reason the queue did, and the failure
 * it prevents is the same one: without it the page shows an approval gate
 * whose Approve button calls `tasks.approve`, which lifts the gate WITHOUT
 * applying the agent's completion — so a person looking straight at the task
 * approves it and the finished work stays unapplied behind them.
 */
export const forTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (
    ctx,
    { taskId },
  ): Promise<{
    id: Id<"pendingEffects">;
    agentName: string;
    reason: string;
    createdAt: number;
    stale: boolean;
  } | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    try {
      await requireTaskAccess(ctx, taskId);
    } catch {
      return null;
    }
    const effect = await ctx.db
      .query("pendingEffects")
      .withIndex("by_task_and_state", (q) =>
        q.eq("taskId", taskId).eq("state", "pending"),
      )
      .first();
    if (!effect) return null;
    const task = await ctx.db.get(taskId);
    return {
      id: effect._id,
      agentName: effect.agentName,
      reason: effect.reason,
      createdAt: effect.createdAt,
      stale: task ? task.statusId !== effect.basedOnStatusId : true,
    };
  },
});

/**
 * Which tasks in one list have a completion waiting on a human.
 *
 * Per LIST rather than per task, because the caller is a badge rendered once
 * per row: a per-task query would be one subscription per visible task, where
 * this one is shared across every row on the board by the Convex client's
 * cache — the same shape `TaskBadges` already uses for statuses and siblings.
 *
 * Ids only. A badge needs to know THAT, and anything more would be a payload
 * multiplied by every row to render a mark three pixels wide.
 */
export const forList = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }): Promise<Id<"tasks">[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    try {
      await requireListAccess(ctx, listId);
    } catch {
      return [];
    }
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
    const out: Id<"tasks">[] = [];
    for (const task of tasks) {
      const effect = await ctx.db
        .query("pendingEffects")
        .withIndex("by_task_and_state", (q) =>
          q.eq("taskId", task._id).eq("state", "pending"),
        )
        .first();
      if (effect) out.push(task._id);
    }
    return out;
  },
});

export const countForCurrentUser = query({
  args: {},
  handler: async (ctx): Promise<number> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return 0;
    let n = 0;
    for (const scope of await visibleScopes(ctx, identity.subject)) {
      const effects = await ctx.db
        .query("pendingEffects")
        .withIndex("by_scope_and_state", (q) =>
          q
            .eq("scopeType", scope.scopeType)
            .eq("scopeId", scope.scopeId)
            .eq("state", "pending"),
        )
        .take(MAX_BATCH);
      for (const effect of effects) {
        try {
          await requireTaskAccess(ctx, effect.taskId);
          n++;
        } catch {
          // Not yours to know about.
        }
      }
    }
    return n;
  },
});

/**
 * Tell the agent what happened to its work, through the channel it polls.
 *
 * Only on rejection and supersession. An approval needs no notice: the effect
 * applied, so the task itself now says so and the agent will see it in any
 * ordinary read — a wake-up whose entire content is "the thing you asked for
 * happened" is noise in a channel that is meant to mean something.
 */
async function noticeAgent(
  ctx: MutationCtx,
  effect: Doc<"pendingEffects">,
  outcome: "rejected" | "superseded",
  note: string | undefined,
): Promise<void> {
  await ctx.db.insert("agentPingDeliveries", {
    scopeType: effect.scopeType,
    scopeId: effect.scopeId,
    sourceKind: "effect_decided",
    sourceId: `${outcome}:${effect._id}`,
    agentId: effect.agentId,
    taskId: effect.taskId,
    type: "effect_decided",
    payload: {
      apiVersion: 1,
      effectId: effect._id,
      kind: effect.kind,
      outcome,
      note: note ?? undefined,
      // Said rather than implied, so a runtime does not have to infer the
      // difference between "a person disagreed" and "the world moved".
      guidance:
        outcome === "rejected"
          ? "A human rejected this completion. Do not re-propose it unchanged — read the note, fix what it names, then complete again."
          : "The task changed after you proposed this, so it was not applied. Re-read the task before deciding whether it still needs completing.",
    },
    status: "poll_required",
    attempts: 0,
    createdAt: Date.now(),
  });
}

/**
 * Approve or reject a batch.
 *
 * One mutation for the whole batch, so a bulk decision is one transaction and
 * cannot half-apply. Per-row outcomes come back rather than a single verdict:
 * in a batch of nine, one task may have moved since it was proposed, and
 * collapsing that into "done" would tell somebody nine things applied when
 * eight did.
 */
export const decide = mutation({
  args: {
    ids: v.array(v.id("pendingEffects")),
    decision: v.union(v.literal("approve"), v.literal("reject")),
    note: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ applied: number; rejected: number; superseded: number }> => {
    const identity = await requireIdentity(ctx);
    if (args.ids.length === 0) return { applied: 0, rejected: 0, superseded: 0 };
    if (args.ids.length > MAX_BATCH) {
      throw new ConvexError(`Decide at most ${MAX_BATCH} at a time.`);
    }
    const note = args.note?.trim() || undefined;

    let applied = 0;
    let rejected = 0;
    let superseded = 0;

    for (const id of args.ids) {
      const effect = await ctx.db.get(id);
      if (!effect) continue;
      // Already decided. Not an error — two people clearing the same queue is
      // the expected case, and failing the whole batch because one row was
      // handled a second ago would make the bulk button unusable in a team.
      if (effect.state !== "pending") continue;
      // The task check is the real boundary; the row's scope only narrowed
      // the search.
      await requireTaskAccess(ctx, effect.taskId);
      const task = await ctx.db.get(effect.taskId);
      if (!task) continue;

      if (task.statusId !== effect.basedOnStatusId) {
        await ctx.db.patch(id, {
          state: "superseded",
          decidedAt: Date.now(),
          decidedByClerkId: identity.subject,
          decisionNote: note,
        });
        await noticeAgent(ctx, effect, "superseded", note);
        superseded++;
        continue;
      }

      if (args.decision === "reject") {
        await ctx.db.patch(id, {
          state: "rejected",
          decidedAt: Date.now(),
          decidedByClerkId: identity.subject,
          decisionNote: note,
        });
        await noticeAgent(ctx, effect, "rejected", note);
        await emitEvent(ctx, {
          scopeType: effect.scopeType,
          scopeId: effect.scopeId,
          type: "task.effect_rejected",
          actor: { type: "user", id: identity.subject, name: "" },
          entityType: "task",
          entityId: effect.taskId,
          entityTitle: task.title,
          listId: task.listId,
          payload: { effectId: id, agentName: effect.agentName, note },
        });
        rejected++;
        continue;
      }

      // Approving is consent, and consent is what the gate was waiting for —
      // so lift it first, then apply through the ordinary core AS THE AGENT.
      // Order matters: the core refuses an agent completing an unapproved
      // gated task, which is exactly the guard we want left in place for
      // every other caller.
      await ctx.db.patch(effect.taskId, {
        approvedByClerkId: identity.subject,
        approvedAt: Date.now(),
      });
      await updateTaskCore(
        ctx,
        { taskId: effect.taskId, statusId: effect.targetStatusId },
        {
          type: "agent",
          id: effect.agentId,
          name: effect.agentName,
        },
      );
      await ctx.db.patch(id, {
        state: "approved",
        decidedAt: Date.now(),
        decidedByClerkId: identity.subject,
        decisionNote: note,
      });
      await emitEvent(ctx, {
        scopeType: effect.scopeType,
        scopeId: effect.scopeId,
        type: "task.effect_approved",
        actor: { type: "user", id: identity.subject, name: "" },
        entityType: "task",
        entityId: effect.taskId,
        entityTitle: task.title,
        listId: task.listId,
        payload: { effectId: id, agentName: effect.agentName, note },
      });
      applied++;
    }

    return { applied, rejected, superseded };
  },
});
