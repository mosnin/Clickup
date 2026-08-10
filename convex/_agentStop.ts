import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

// Stopping an agent.
//
// The product had exactly one halt — pausing the whole agent — and it is the
// wrong shape for the thing people actually need. A pause says "this agent is
// off until further notice"; what somebody watching a fleet go wrong wants to
// say is "drop what you are doing NOW". Worse, a pause was invisible to a run
// already in flight: the agent found out at its next write, if it made one.
//
// Two things had to be separated to fix that, and keeping them separate is the
// whole design:
//
// **The notice is one channel.** Whoever pulled the stop — a person hitting
// the button, or a spend ceiling running out — the agent learns the same way,
// through the wake inbox it already polls (`sourceKind: "stop"`). One thing to
// implement in a runtime, one thing to document, one place to look.
//
// **The enforcement is deliberately NOT one mechanism**, and this is the part
// that would be wrong to unify for the sake of tidiness. A human stop is
// durable: it persists until a human lifts it, because the person who pulled
// it is the only one who knows whether the reason has passed. A budget stop is
// self-clearing: it lasts until the UTC day rolls, because that is what a
// DAILY ceiling means. Give the budget a durable flag and every morning starts
// with somebody manually un-sticking a fleet that was never in trouble — a
// worse product, arrived at by making the code look symmetrical.
//
// So: one `stopNotice` both triggers call, two independent enforcement paths
// (`agents.stopRequestedAt` here, the spend counters in `_agentAuth`).

/**
 * Tell an agent it has been stopped, through the channel it already polls.
 *
 * Idempotent per reason within a short window is NOT attempted: a second stop
 * for a second reason is a second notice, because "you are out of budget" and
 * "a human stopped you" are different facts and an agent that only heard one
 * of them would act on an incomplete picture.
 */
export async function stopNotice(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  args: { reason: string; source: "human" | "budget"; taskId?: Doc<"tasks">["_id"] },
): Promise<void> {
  await ctx.db.insert("agentPingDeliveries", {
    scopeType: agent.parentType,
    scopeId: agent.parentId,
    sourceKind: "stop",
    sourceId: `${args.source}:${agent._id}`,
    agentId: agent._id,
    taskId: args.taskId,
    type: "stop",
    payload: {
      apiVersion: 1,
      reason: args.reason,
      source: args.source,
      // What the agent should DO, stated rather than implied. A runtime
      // reading this should not have to infer the difference between "stop
      // and wait to be resumed" and "stop, you will be able to work again
      // tomorrow".
      resumesWhen:
        args.source === "budget"
          ? "the next UTC day, or when a human raises the limit"
          : "a human clears the stop",
    },
    // `poll_required` rather than `pending`: an agent with no notifyUrl has
    // no push to wait on, and marking it pending would leave a delivery that
    // never resolves sitting in the outbound queue.
    status: agent.notifyUrl ? "pending" : "poll_required",
    attempts: 0,
    createdAt: Date.now(),
  });
}

/**
 * Release every claim this agent holds.
 *
 * A stopped agent still holding claims is work nobody else may touch, held by
 * something that has been told to do nothing — the exact deadlock a stop is
 * pulled to prevent. Bounded by the claim index rather than a scan.
 */
export async function releaseAgentClaims(
  ctx: MutationCtx,
  agent: Doc<"agents">,
): Promise<number> {
  const claimed = await ctx.db
    .query("tasks")
    .withIndex("by_claimed", (q) => q.eq("claimedByActorId", agent._id))
    .take(200);
  for (const task of claimed) {
    await ctx.db.patch(task._id, {
      claimedByActorId: undefined,
      claimedAt: undefined,
    });
  }
  return claimed.length;
}
