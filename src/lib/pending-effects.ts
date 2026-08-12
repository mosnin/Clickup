// Work an agent finished that a human has not yet consented to.
//
// The problem this exists for, stated the way the people who found it state
// it: synchronous human-in-the-loop is why teams end up running with approvals
// switched off. You hand an agent a task, walk away, and come back to find it
// stopped on step one waiting for a click — so the second time, you turn the
// gate off, and now nothing is reviewed at all. A gate that costs you the
// agent's whole afternoon is a gate that gets removed.
//
// Our version of that failure was precise. An agent working a task behind an
// approval gate did all the work, called `complete_task`, and was REFUSED. The
// refusal threw, so everything the attempt knew — that the work was finished,
// what the agent had done, what it wanted to say about it — was discarded. The
// agent then had to notice, call `request_approval` separately, and come back
// LATER to complete the task once a person had clicked. Three legs, and the
// third one requires the agent to still be alive and still be watching.
//
// A pending effect is that attempt, kept. The agent proposes the completion,
// is told it was recorded rather than refused, and moves on to the next task.
// A person approves in bulk whenever they next look, and approving APPLIES the
// completion — attributed to the agent that earned it. The agent never comes
// back.
//
// Three things this is deliberately NOT:
//
// **It is not a weaker gate.** The task does not complete until a human says
// so. That is the whole guarantee of `requiresApproval` and nothing here
// touches it; what changes is only whether the agent's attempt survives being
// refused. Asserted directly in tests, because "we made approvals more
// convenient" is exactly the sentence under which a gate quietly stops gating.
//
// **It is not a simulated success.** The prior art here hands the agent a
// fabricated result — tells it the side effect happened, and serves matching
// fake reads back — so the agent's plan can continue undisturbed. We tell the
// truth instead: `applied: false, pending: true`. The property that matters is
// that the agent is not BLOCKED, and honesty buys that just as well. Lying is
// only necessary if the agent must not notice, and an agent that knows its
// completion is awaiting a person can say so in its run notes, pick up
// something else, and never be surprised later by a task it believes is done.
// We reach for the simulation the day a real integration needs a return value
// to keep going, and not before.
//
// **It is not a second approval queue.** It feeds the one queue that already
// exists (`src/lib/obligations.ts`), for the reason that queue exists: a fifth
// place to look is a fifth place to forget.

/**
 * What can be deferred.
 *
 * Closed, and closed for the same reason the panel vocabulary is closed — an
 * agent writes these, and a kind is a promise that exactly one apply branch
 * knows how to carry out. A new kind is one entry here and one branch there;
 * anything the resolver does not enumerate is dropped rather than guessed at.
 *
 * One entry today, and that is honest rather than unfinished: completing a
 * gated task is the only action in the product that currently stops an agent
 * dead. Adding `task.status` or `message.post` on spec would be building
 * consent machinery for refusals nobody has hit.
 */
export type EffectKind = "task.complete";

export const EFFECT_KINDS: EffectKind[] = ["task.complete"];

export function isEffectKind(v: unknown): v is EffectKind {
  return typeof v === "string" && (EFFECT_KINDS as string[]).includes(v);
}

/**
 * Where an effect got to.
 *
 * `superseded` is not a decision, it is a discovery: the world moved under the
 * proposal between it being made and somebody looking at it. It is a separate
 * state rather than a rejection because rejecting means "I considered this and
 * said no", and telling an agent that when nobody considered anything teaches
 * it the wrong lesson about its own work.
 */
export type EffectState = "pending" | "approved" | "rejected" | "superseded";

export type PendingEffect = {
  id: string;
  kind: EffectKind;
  state: EffectState;
  /** The task the effect acts on. Every kind is task-scoped so far. */
  taskId: string;
  taskTitle: string;
  /** Where the reviewer goes to see the work itself. */
  href: string;
  agentId: string;
  agentName: string;
  /** The agent's own account of what it did. Required at proposal time. */
  reason: string;
  createdAt: number;
  decidedAt?: number;
  decidedByName?: string;
  decisionNote?: string;
};

/** What each kind is called, and what approving it will actually do. */
export const EFFECT_KIND_COPY: Record<
  EffectKind,
  { label: string; approving: string }
> = {
  "task.complete": {
    label: "Completion",
    approving: "marks the task complete, credited to the agent",
  },
};

/**
 * Oldest first — the same ordering rule the obligations queue runs on, and for
 * the same reason. These do not move until somebody touches them, so the one
 * at risk of never being touched is the one that has waited longest. Sorting a
 * queue like a feed systematically buries exactly the row that needed you.
 */
export function sortEffects<T extends { createdAt: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Group a batch by agent, for the bulk surface.
 *
 * Bulk review is only tolerable if the batch has a shape. Twelve loose rows is
 * twelve decisions; "scout-agent finished 9 tasks" is one decision with nine
 * items under it, and the reviewer can drill in on the one line that looks
 * wrong. Groups come back in the order their OLDEST member waited, so the
 * ordering rule survives grouping instead of being quietly replaced by
 * whichever agent happens to sort first by name.
 */
export function groupByAgent<
  T extends { agentId: string; agentName: string; createdAt: number },
>(rows: T[]): { agentId: string; agentName: string; items: T[] }[] {
  const byAgent = new Map<string, { agentName: string; items: T[] }>();
  for (const row of sortEffects(rows)) {
    const existing = byAgent.get(row.agentId);
    if (existing) existing.items.push(row);
    else byAgent.set(row.agentId, { agentName: row.agentName, items: [row] });
  }
  return [...byAgent.entries()]
    .map(([agentId, g]) => ({ agentId, agentName: g.agentName, items: g.items }))
    .sort((a, b) => a.items[0].createdAt - b.items[0].createdAt);
}

/**
 * The sentence shown on a batch button.
 *
 * Says what will HAPPEN, not how many rows are selected. "Approve 9" is a
 * count; "Complete 9 tasks" is the consequence, and the consequence is the
 * thing somebody is agreeing to. Singular and plural both matter here — a
 * button that reads "Complete 1 tasks" on the last item of a batch is the
 * tell that nobody used their own queue down to empty.
 */
export function describeBatch(rows: { kind: EffectKind }[]): string {
  if (rows.length === 0) return "Nothing selected";
  const n = rows.length;
  const allSame = rows.every((r) => r.kind === rows[0].kind);
  if (!allSame) return `Apply ${n} change${n === 1 ? "" : "s"}`;
  switch (rows[0].kind) {
    case "task.complete":
      return `Complete ${n} task${n === 1 ? "" : "s"}`;
  }
}
