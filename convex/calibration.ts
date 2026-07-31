import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireIdentity, requireProjectAccess, requireScopeAccess } from "./_authz";
import { resolveEnvelope } from "./dataStream";
import { emitEvent } from "./events";

// Grading a decision against what it claimed.
//
// See `src/lib/calibration.ts` for why. In short: the plan records what a team
// decided and nothing about what they expected, so the reasoning is never
// checked and a decision log stays an archive.
//
// Three properties this file exists to hold:
//
// **The baseline is measured here, now, by the server.** Not supplied by the
// caller. A client-supplied baseline is a claim about the past that nobody can
// check, in a feature whose entire value is being checkable — and the obvious
// abuse is trivial: claim the number was worse than it was and every decision
// looks like a win.
//
// **Grading runs the same resolver the screen runs.** `resolveEnvelope` is
// lifted out of `dataStream.resolve` for exactly this; a second evaluator that
// "just does scalars" is how one vocabulary becomes two.
//
// **An expectation cannot be retrofitted.** `attach` refuses a decision that
// already carries one, and there is no path that sets a baseline to anything
// but the value at attach time.

const SCOPE = v.union(v.literal("user"), v.literal("workspace"));

/**
 * Measure a query right now, in the scope of a project.
 *
 * The scalar only — an expectation is a claim about one number. Returns null
 * when the question cannot be answered at all, which is a verdict of its own
 * rather than a zero.
 */
/**
 * Measure a query, narrowed to the project the decision was made in.
 *
 * The narrowing is the design, not a detail. A claim attached to a decision is
 * about the thing the decision was about, so measuring it across a whole
 * workspace would let the number move for reasons nobody claimed anything
 * about — and would fold in private spaces the claimant may not even see.
 *
 * Narrowing is also what makes it gradable at all. Grading runs on a cron with
 * no identity, so a per-space visibility check would return nothing; the
 * project boundary stands in for it, and the caller has already been
 * authorized against that project.
 */
async function measure(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  query: unknown,
): Promise<{ value: number; scopeType: "user" | "workspace"; scopeId: string } | null> {
  const project = await ctx.db.get(projectId);
  if (!project) return null;
  const space = await ctx.db.get(project.spaceId);
  if (!space) return null;
  const scopeType: "user" | "workspace" =
    space.parentType === "workspace" ? "workspace" : "user";
  const scopeId = space.parentId;

  const raw = (query ?? {}) as { filter?: Record<string, unknown> };
  const envelope = await resolveEnvelope(
    ctx,
    {
      scopeType,
      scopeId,
      query: {
        ...raw,
        filter: {
          ...(raw.filter ?? {}),
          // Forced, not defaulted: a claim cannot opt out of being about its
          // own project.
          scopeToKind: "project",
          scopeToId: projectId,
        },
      },
      unscoped: true,
    },
    "",
  );
  return { value: envelope.scalar, scopeType, scopeId };
}

/**
 * Attach a claim to a decision.
 *
 * The baseline is read at this instant and stored. That is what makes the
 * claim falsifiable, and it is why this refuses to run twice on the same
 * decision: a second attach would re-baseline against a world that already
 * contains the effect.
 */
export const attach = mutation({
  args: {
    decisionId: v.id("planNodes"),
    /** A DataQuery — the same vocabulary a panel asks in. */
    query: v.any(),
    direction: v.union(
      v.literal("down"),
      v.literal("up"),
      v.literal("at_most"),
      v.literal("at_least"),
      v.literal("unchanged"),
    ),
    target: v.optional(v.number()),
    /** How far out the claim reaches. */
    dueAt: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const decision = await ctx.db.get(args.decisionId);
    if (!decision || decision.kind !== "decision") {
      throw new ConvexError("Decision not found");
    }
    await requireProjectAccess(ctx, decision.projectId);
    if (decision.expectation !== undefined) {
      throw new ConvexError(
        "This decision already has an expectation. Re-baselining it would compare the world to itself.",
      );
    }
    if (args.dueAt <= Date.now()) {
      throw new ConvexError("A claim has to reach into the future");
    }

    const measured = await measure(ctx, decision.projectId, args.query);
    if (!measured) throw new ConvexError("That question can't be measured here");

    await ctx.db.patch(args.decisionId, {
      expectation: {
        query: args.query,
        direction: args.direction,
        target: args.target ?? 0,
        baseline: measured.value,
        dueAt: args.dueAt,
        note: args.note ?? "",
      },
      expectationDueAt: args.dueAt,
    });
    return { baseline: measured.value };
  },
});

/** Take the claim back. Only before it has been graded — see below. */
export const detach = mutation({
  args: { decisionId: v.id("planNodes") },
  handler: async (ctx, { decisionId }) => {
    const decision = await ctx.db.get(decisionId);
    if (!decision) throw new ConvexError("Decision not found");
    await requireProjectAccess(ctx, decision.projectId);
    if (decision.outcome !== undefined) {
      // Deleting a graded claim is how a team quietly stops being wrong. The
      // record of having been wrong is the entire point of the feature.
      throw new ConvexError("A claim that has been checked stays on the record");
    }
    await ctx.db.patch(decisionId, {
      expectation: undefined,
      expectationDueAt: undefined,
    });
  },
});

/**
 * Grade everything whose horizon has passed.
 *
 * Runs on the same 15-minute cron as the watchdog. Idempotent by construction:
 * a graded decision has its `expectationDueAt` cleared, so it leaves the range
 * and can never be graded twice.
 */
export const gradeDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("planNodes")
      .withIndex("by_expectation_due", (q) => q.lte("expectationDueAt", now))
      .take(50);

    for (const decision of due) {
      if (decision.expectationDueAt === undefined) continue;
      const expectation = decision.expectation as
        | { query: unknown; direction: string; target: number; baseline: number }
        | undefined;
      if (!expectation) {
        await ctx.db.patch(decision._id, { expectationDueAt: undefined });
        continue;
      }

      // A retracted decision is out of the plan; grading it would put it back
      // into the record through a side door.
      if (decision.retractedAt !== undefined) {
        await ctx.db.patch(decision._id, { expectationDueAt: undefined });
        continue;
      }

      // Narrowed to the decision's own project, exactly as the baseline was.
      // A cron has no identity, which is also why an expectation's query may
      // not be about "me" — see `normalizeExpectation`.
      const measured = await measure(ctx, decision.projectId, expectation.query);

      const verdict = measured
        ? held(expectation, measured.value)
          ? ("met" as const)
          : ("missed" as const)
        : ("unevaluable" as const);

      await ctx.db.patch(decision._id, {
        outcome: { verdict, value: measured?.value ?? 0, checkedAt: now },
        // Out of the range for good.
        expectationDueAt: undefined,
      });

      if (measured && verdict !== "unevaluable") {
        await emitEvent(ctx, {
          scopeType: decision.scopeType,
          scopeId: decision.scopeId,
          type: verdict === "met" ? "question.claim_held" : "question.claim_missed",
          actor: { type: "system", id: "system", name: "operate" },
          entityType: "project",
          entityId: decision.projectId,
          entityTitle: decision.body.slice(0, 120),
          payload: { was: expectation.baseline, now: measured.value },
        });
      }
    }
    return { graded: due.length };
  },
});

/**
 * The comparison, restated here.
 *
 * The Convex tree cannot import from `src/`, so this mirrors `held` in
 * `src/lib/calibration.ts`. Two copies of a rule drift, so
 * `tests/calibration-backend.test.ts` imports both sides and fails if they
 * ever disagree — the same treatment the plan's parent rule gets.
 */
export function held(
  e: { direction: string; target: number; baseline: number },
  value: number,
): boolean {
  switch (e.direction) {
    case "down":
      return value < e.baseline;
    case "up":
      return value > e.baseline;
    case "at_most":
      return value <= e.target;
    case "at_least":
      return value >= e.target;
    case "unchanged":
      return Math.abs(value - e.baseline) <= Math.max(Math.abs(e.baseline) * 0.1, 1);
    default:
      return false;
  }
}

/**
 * How often this scope's claims turn out to be right.
 *
 * The compounding artifact: one graded decision is a curiosity, forty is a
 * team discovering it is systematically optimistic about the same kind of
 * thing — which is not a fact obtainable any other way.
 */
export const forScope = query({
  args: { scopeType: SCOPE, scopeId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    try {
      await requireScopeAccess(ctx, {
        scopeType: args.scopeType,
        scopeId: args.scopeId,
      });
    } catch {
      return [];
    }
    const limit = Math.min(Math.max(args.limit ?? 40, 1), 100);

    const rows = await ctx.db
      .query("planNodes")
      .withIndex("by_scope_and_kind", (q) =>
        q
          .eq("scopeType", args.scopeType)
          .eq("scopeId", args.scopeId)
          .eq("kind", "decision"),
      )
      .order("desc")
      .take(300);

    const out: {
      decisionId: string;
      body: string;
      question: string;
      projectId: string;
      decidedByName: string;
      expectation: unknown;
      outcome: { verdict: string; value: number; checkedAt: number } | null;
    }[] = [];

    for (const row of rows) {
      if (row.retractedAt !== undefined || row.expectation === undefined) continue;
      const question = row.parentId ? await ctx.db.get(row.parentId) : null;
      if (!question || question.retractedAt !== undefined) continue;
      out.push({
        decisionId: row._id as string,
        body: row.body,
        question: question.body,
        projectId: row.projectId as string,
        decidedByName: row.acceptedByName ?? row.authorName,
        expectation: row.expectation as unknown,
        outcome: row.outcome ?? null,
      });
      if (out.length >= limit) break;
    }
    return out;
  },
});

/** Measure a query without committing to it — what the composer previews. */
export const preview = query({
  args: { projectId: v.id("projects"), query: v.any() },
  handler: async (ctx, args) => {
    const { identity } = await requireProjectAccess(ctx, args.projectId);
    const measured = await measure(ctx, args.projectId, args.query);
    return { value: measured?.value ?? null };
  },
});
