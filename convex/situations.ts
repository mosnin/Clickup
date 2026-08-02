import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { canAccessScope, requireIdentity, requireScopeAccess } from "./_authz";
import { resolveEnvelope } from "./dataStream";
import { emitEvent } from "./events";
import {
  describeSituation,
  isSituationTrue,
  normalizeSituation,
  situationRefusal,
  type Situation,
} from "./_situations";

// Panels that subscribe to a condition instead of occupying a slot.
//
// `src/lib/situation.ts` is the spec; this is the half that persists and polls.
// Four things it is careful about, each one a failure that would otherwise be
// inevitable:
//
// **The previous answer is stored, or there is no hysteresis.** The dead band
// is asymmetric — a true situation must travel a whole band back before it goes
// false — and that is only expressible if the last verdict survives between
// polls. A cron recomputing from `false` every tick would flap exactly as hard
// as a cron with no band at all.
//
// **A measurement runs the resolver a screen runs.** `resolveEnvelope`, with a
// scalar taken off the envelope. A second evaluator that "just does scalars" is
// how one vocabulary becomes two, and the newer one grows a filter the older
// one ignores — the same reason calibration lifted it out.
//
// **A query whose filters the resolver would ignore is refused, not
// evaluated.** See the matrix in `_situations.ts`. A situation is read by
// nobody and decides whether a panel appears, so a filter that silently does
// nothing is a panel arriving for a reason that is not true.
//
// **Nothing here applies a layout change.** Evaluation records that a condition
// became true. Whether a panel then arrives is a consent decision made
// elsewhere, per person, because layouts are per person — the same shape as a
// screen proposal, and for the same reason.

const SCOPE = v.union(v.literal("user"), v.literal("workspace"));

/**
 * How long a verdict stands before it is re-measured.
 *
 * The watchdog's cadence, deliberately: a condition over a team's work does not
 * change meaningfully inside fifteen minutes, and a second schedule would be a
 * second thing to reason about for no gain. It is also the interval the dead
 * band is sized against — a band that only has to survive four polls an hour is
 * a band that can be small.
 */
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

/** Bounded like every other sweep; the next tick catches any backlog. */
const SWEEP_BATCH = 100;

const SYSTEM_ACTOR = { type: "system" as const, id: "system", name: "operate" };

// ── Measuring ───────────────────────────────────────────────────────────

/**
 * What this subscription's condition measures right now, or null.
 *
 * Null is "could not be read", which is emphatically not zero: zero satisfies
 * `at_most` forever, so an unreadable measurement that fell through as a number
 * would make a panel arrive precisely when the system had lost the ability to
 * say anything about it.
 */
async function measure(
  ctx: QueryCtx,
  row: Doc<"panelSituations">,
  situation: Situation,
): Promise<number | null> {
  // Re-checked on every evaluation rather than trusted from subscribe time: a
  // workspace membership can be revoked afterwards, and a subscription that
  // kept measuring would be a query running under an authorization nobody
  // holds. Cheap — one indexed read.
  if (
    !(await canAccessScope(
      ctx,
      row.scopeType,
      row.scopeId,
      row.ownerClerkId,
    ))
  ) {
    return null;
  }

  const envelope = await resolveEnvelope(
    ctx,
    {
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      query: situation.query,
      // The walk runs as the owner, so the condition sees exactly what the
      // person who subscribed to it sees. `assignee: "me"` is theirs too, and
      // is meaningful here in a way it is not for a graded expectation: a
      // subscription belongs to exactly one person.
      asSubject: row.ownerClerkId,
    },
    row.ownerClerkId,
  );
  return Number.isFinite(envelope.scalar) ? envelope.scalar : null;
}

/**
 * Write the verdict, and announce a transition if there was one.
 *
 * Returns whether the state changed. The patch always moves `nextCheckAt`, even
 * for a row that could not be measured or could not be parsed — a row that
 * stays due is a row that occupies the batch on every sweep and starves the
 * ones behind it.
 */
async function record(
  ctx: MutationCtx,
  row: Doc<"panelSituations">,
  situation: Situation | null,
  value: number | null,
  now: number,
): Promise<boolean> {
  const isTrue =
    situation !== null && value !== null
      ? isSituationTrue(situation, value, row.wasTrue)
      : false;
  const changed = isTrue !== row.wasTrue;

  await ctx.db.patch(row._id, {
    wasTrue: isTrue,
    lastValue: value ?? undefined,
    lastCheckedAt: now,
    nextCheckAt: now + CHECK_INTERVAL_MS,
    updatedAt: now,
    ...(changed ? (isTrue ? { becameTrueAt: now } : { becameFalseAt: now }) : {}),
  });

  if (!changed || situation === null) return changed;

  // Emitted so the arrival can be announced and so the transition is auditable
  // — a panel that appeared has to be answerable for why. The event names the
  // condition rather than the panel, because "Sprint panel appeared" tells a
  // reader nothing about what changed in their work.
  await emitEvent(ctx, {
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    type: isTrue ? "situation.became_true" : "situation.became_false",
    actor: SYSTEM_ACTOR,
    entityType: "panel",
    entityId: row.panelId,
    entityTitle: describeSituation(situation),
    payload: {
      situationId: situation.id,
      label: situation.label,
      compare: situation.compare,
      threshold: situation.threshold,
      value,
      screenKey: row.screenKey,
      ownerClerkId: row.ownerClerkId,
    },
  });
  return changed;
}

// ── Subscribing ─────────────────────────────────────────────────────────

/**
 * Point a panel at a condition.
 *
 * Refuses rather than repairs, twice over: a malformed situation is not a
 * situation, and a query whose filters this source ignores would be measured
 * against the wrong records. Both refusals leave the panel exactly as it was,
 * which is the honest failure — the alternative is a panel that appears for a
 * reason nobody stated.
 *
 * Evaluated immediately. A condition that is already true when you subscribe to
 * it is true, and waiting a quarter of an hour to say so would read as the
 * feature not working.
 */
export const subscribe = mutation({
  args: {
    scopeType: SCOPE,
    scopeId: v.string(),
    screenKey: v.string(),
    panelId: v.string(),
    /** A Situation — see `src/lib/situation.ts`. */
    situation: v.any(),
  },
  handler: async (ctx, args) => {
    const { subject } = await requireScopeAccess(ctx, {
      scopeType: args.scopeType,
      scopeId: args.scopeId,
    });

    const screenKey = args.screenKey.trim().slice(0, 120);
    const panelId = args.panelId.trim().slice(0, 120);
    if (!screenKey || !panelId) throw new ConvexError("Nothing to subscribe");

    const situation = normalizeSituation(args.situation);
    if (!situation) {
      throw new ConvexError("That condition is missing something it needs");
    }
    const refusal = situationRefusal(situation.query, args.scopeType);
    if (refusal) throw new ConvexError(refusal);

    const now = Date.now();
    // One subscription per panel per screen per person: a panel with two
    // conditions has no answer to "is it here", and replacing is what someone
    // editing a condition means anyway.
    const existing = await ctx.db
      .query("panelSituations")
      .withIndex("by_owner_screen_and_panel", (q) =>
        q
          .eq("ownerClerkId", subject)
          .eq("screenKey", screenKey)
          .eq("panelId", panelId),
      )
      .unique();

    const id =
      existing?._id ??
      (await ctx.db.insert("panelSituations", {
        ownerClerkId: subject,
        scopeType: args.scopeType,
        scopeId: args.scopeId,
        screenKey,
        panelId,
        situation,
        // A situation nobody has seen starts false and has to earn its
        // arrival — the strict reading, which is the safe direction.
        wasTrue: false,
        nextCheckAt: now,
        createdAt: now,
        updatedAt: now,
      }));

    if (existing) {
      // A changed condition is a new claim, so the remembered verdict goes with
      // the old one. Carrying `wasTrue` across would apply the previous
      // condition's dead band to this one's threshold.
      await ctx.db.patch(id, {
        scopeType: args.scopeType,
        scopeId: args.scopeId,
        situation,
        wasTrue: false,
        lastValue: undefined,
        nextCheckAt: now,
        updatedAt: now,
      });
    }

    const row = (await ctx.db.get(id))!;
    const value = await measure(ctx, row, situation);
    await record(ctx, row, situation, value, now);

    const after = (await ctx.db.get(id))!;
    return { subscriptionId: id, isTrue: after.wasTrue, value };
  },
});

/** Stop watching. The panel goes back to being placed or not placed. */
export const unsubscribe = mutation({
  args: { subscriptionId: v.id("panelSituations") },
  handler: async (ctx, { subscriptionId }) => {
    const identity = await requireIdentity(ctx);
    const row = await ctx.db.get(subscriptionId);
    // "Not found" rather than "forbidden", so an id cannot be probed for
    // existence — the treatment every other per-person row here gets.
    if (!row || row.ownerClerkId !== identity.subject) {
      throw new ConvexError("Subscription not found");
    }
    await ctx.db.delete(subscriptionId);
  },
});

/**
 * What is true on this screen, for this person.
 *
 * The consent surface reads this and decides what to offer. It deliberately
 * returns state rather than a layout: this file never says where a panel goes.
 */
export const forScreen = query({
  args: { screenKey: v.string() },
  handler: async (ctx, { screenKey }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const rows = await ctx.db
      .query("panelSituations")
      .withIndex("by_owner_and_screen", (q) =>
        q.eq("ownerClerkId", identity.subject).eq("screenKey", screenKey),
      )
      .collect();

    return rows.flatMap((row) => {
      // Normalized on read like every stored definition, and a row that no
      // longer parses is dropped rather than shown: a subscription that cannot
      // be evaluated must not look like one that is false, and must certainly
      // not look like one that is true.
      const situation = normalizeSituation(row.situation);
      if (!situation) return [];
      return [
        {
          subscriptionId: row._id,
          panelId: row.panelId,
          scopeType: row.scopeType,
          scopeId: row.scopeId,
          situation,
          description: describeSituation(situation),
          isTrue: row.wasTrue,
          value: row.lastValue ?? null,
          becameTrueAt: row.becameTrueAt ?? null,
          lastCheckedAt: row.lastCheckedAt ?? null,
        },
      ];
    });
  },
});

// ── The sweep ───────────────────────────────────────────────────────────

/**
 * Evaluate every subscription whose turn has come.
 *
 * An index range rather than a scan, and bounded — the next tick picks up
 * anything left. Every row touched moves out of the range whatever happened to
 * it, including the ones that could not be parsed or measured, so one broken
 * subscription cannot starve the rest.
 */
export const evaluateDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("panelSituations")
      .withIndex("by_next_check", (q) => q.lte("nextCheckAt", now))
      .take(SWEEP_BATCH);

    let transitions = 0;
    for (const row of due) {
      const situation = normalizeSituation(row.situation);
      const value = situation ? await measure(ctx, row, situation) : null;
      if (await record(ctx, row, situation, value, now)) transitions += 1;
    }
    return { checked: due.length, transitions };
  },
});
