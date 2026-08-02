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
  sameClaim,
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
  //
  // **Into the OWNER's scope, never the subscription's.** Two boundaries live
  // on this row and conflating them is a privacy leak, which is exactly what
  // happened here: the event was emitted at `row.scopeType`/`row.scopeId`, so a
  // workspace-scoped subscription wrote "Open tasks in this sprint reached 6"
  // into the workspace activity feed — the owner's own free-text label and
  // their clerk id, fanned out to every member, to every workspace webhook, and
  // over the workspace's realtime channel.
  //
  //   `row.scopeType`/`row.scopeId` is the boundary the QUESTION may never read
  //   past. It belongs to `measure()` and nothing here touches it.
  //
  //   The event's scope is about who is ENTITLED TO KNOW that this person's
  //   condition tripped, and the answer is: the person. A subscription is a
  //   statement about what one individual is privately watching for, and
  //   publishing it to the team is the same class of mistake as a space theme
  //   reaching into somebody's personal type size — a personal act made shared
  //   without anyone asking.
  await emitEvent(ctx, {
    scopeType: "user",
    scopeId: row.ownerClerkId,
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
      // Where the question was asked, kept in the payload now that it is no
      // longer the event's own scope. An audit row that cannot say which
      // workspace a number came from is a weaker record than the one it
      // replaced, and the leak was in the addressing, not in the fact.
      measuredScopeType: row.scopeType,
      measuredScopeId: row.scopeId,
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
      // the old one: carrying `wasTrue` across would apply the previous
      // condition's dead band to this one's threshold.
      //
      // But the antecedent has to be ESTABLISHED, not assumed. Resetting on
      // every write — which is what this used to do — throws away the verdict
      // when nothing changed, so a value resting inside the dead band is re-read
      // strictly, goes false, comes back true, and announces. That is exactly
      // the flap the band exists to prevent, reintroduced through the save path
      // instead of the poll path, where nobody would look for it. And it is not
      // hypothetical: a composer that saves on change writes several times per
      // edit, so nudging a threshold from 6 to 7 and back to 6 would land on the
      // original condition having forgotten it was ever true.
      //
      // `sameClaim` compares the NORMALIZED forms — scope, query, comparison,
      // threshold — and deliberately ignores `id` and `label`, because renaming
      // a condition is not restating it.
      const previous = normalizeSituation(existing.situation);
      const unchanged =
        previous !== null &&
        sameClaim(
          {
            scopeType: existing.scopeType,
            scopeId: existing.scopeId,
            ...previous,
          },
          { scopeType: args.scopeType, scopeId: args.scopeId, ...situation },
        );

      await ctx.db.patch(id, {
        scopeType: args.scopeType,
        scopeId: args.scopeId,
        situation,
        updatedAt: now,
        ...(unchanged
          ? {}
          : {
              wasTrue: false,
              lastValue: undefined,
              // The transition stamps date the OLD claim's history. Left in
              // place they would let an acknowledgement of the previous
              // condition silence the new one's first arrival.
              becameTrueAt: undefined,
              becameFalseAt: undefined,
              nextCheckAt: now,
            }),
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

// ── Answering an announcement ───────────────────────────────────────────
//
// The consent shape is the one screen proposals and panel proposals already
// use, and it does not bend: the condition ANNOUNCES, a person PLACES. What is
// recorded here is only that the person answered — the layout write happens on
// the client, for the reason `uiComponents.resolveProposal` gives and which is
// worth repeating because it is not obvious: the server cannot tell "never
// arranged this screen" from "arranged it empty", so a server that helpfully
// wrote a layout row holding the one new panel would wipe a screen down to it.
// So this hands back the panel id and the client places it.
//
// **Departure.** A situation going false is not a licence to take a panel away.
// The rule, and the reasoning:
//
//   A panel the reader KEPT is theirs. It is in their layout, written by their
//   own consent, indistinguishable from a panel they added from the tray — and
//   a layout that edits itself is precisely the adaptive UI this codebase
//   rejects everywhere else. Removing it is their call. What the product owes
//   them instead is the truth: the reason it arrived has expired, said once,
//   with a one-tap way to act on it. Saying nothing would leave them reading a
//   panel whose premise is gone; removing it would be the screen changing
//   behind their back. Telling them and offering is the only option that is
//   neither.
//
//   A panel still only being PREVIEWED was never theirs — nothing was written,
//   nothing was consented to — so it withdraws with a settle and a line, which
//   is handled entirely on the client because a preview only ever existed
//   there.
//
// Departures are acknowledged through the same stamp as arrivals, so the note
// is said once per occurrence rather than sitting on the screen as chrome.
export const acknowledge = mutation({
  args: {
    subscriptionId: v.id("panelSituations"),
    /**
     * How an ARRIVAL was answered. Absent means this is a departure being
     * acknowledged, which has no resolution to record — the panel's fate was
     * decided when it arrived.
     */
    resolution: v.optional(v.union(v.literal("kept"), v.literal("dismissed"))),
  },
  handler: async (ctx, { subscriptionId, resolution }) => {
    const identity = await requireIdentity(ctx);
    const row = await ctx.db.get(subscriptionId);
    // "Not found" rather than "forbidden", so an id cannot be probed for
    // existence — the treatment every other per-person row here gets.
    if (!row || row.ownerClerkId !== identity.subject) {
      throw new ConvexError("Subscription not found");
    }

    // The transition being answered, taken from the row rather than from the
    // caller. A client-supplied stamp would let a stale banner acknowledge an
    // occurrence that had already been superseded — which reads as a dismissal
    // silently swallowing the NEXT arrival, the one failure this mechanism
    // exists to prevent.
    //
    // `Date.now()` only when neither stamp exists, which is a row written
    // before transitions were recorded. Stamping the present is the safe
    // direction: it suppresses this occurrence and nothing after it, since any
    // real transition from here on is later than now.
    const answered =
      (row.wasTrue ? row.becameTrueAt : row.becameFalseAt) ?? Date.now();

    await ctx.db.patch(subscriptionId, {
      acknowledgedAt: answered,
      ...(resolution === undefined ? {} : { resolution }),
      updatedAt: Date.now(),
    });

    // The panel id, so the client can place it. See the note above.
    return { panelId: row.panelId };
  },
});

/**
 * What is true on this screen, for this person.
 *
 * The consent surface reads this and decides what to offer. It deliberately
 * returns state rather than a layout: this file never says where a panel goes.
 *
 * Nor does it say whether to ANNOUNCE. That question needs two things only the
 * client holds — whether the panel is already on this reader's screen, and
 * whether its id still resolves to something drawable — so the predicate lives
 * once, in `src/lib/situation.ts`, where it is pure and testable, rather than
 * half here and half there.
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
          becameFalseAt: row.becameFalseAt ?? null,
          acknowledgedAt: row.acknowledgedAt ?? null,
          resolution: row.resolution ?? null,
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
