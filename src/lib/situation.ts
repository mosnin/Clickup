// A panel that is TRUE rather than placed.
//
// Every dashboard is a shelf: you put things on it and they stay. The adaptive
// alternative is to rearrange the screen for you, which this codebase already
// rejects for a good reason — a screen that changes without being asked is a
// screen nobody can learn.
//
// There is a third option. A **situation** is a named condition over the work:
// *a sprint ends in two days with six still open*, *an agent has held a task
// with no heartbeat for forty minutes*, *three claims expired overnight*. A
// panel may subscribe to one instead of occupying a slot forever. It arrives
// when its condition becomes true and leaves when it stops being true — and it
// **announces**, exactly like an agent's screen proposal, because consent is
// what separates this from the adaptive UI that everyone hates.
//
// Four properties hold this together, and each one is a failure that would
// otherwise be inevitable:
//
// **The condition is stated in the vocabulary that already exists.** A query
// plus a comparison plus a number. Not an expression, not a script, not a path
// into the database — agents author these, and the ceiling on a hostile or
// hallucinated situation must be "a question somebody could already ask".
//
// **Absence means always-on.** A panel with no situation behaves exactly as it
// does today. Personalisation that changes the product for someone who never
// opted in is a regression wearing a feature's clothes, and that rule has
// already been paid for twice in this codebase.
//
// **A condition sitting on its threshold must not flap.** Six open tasks, one
// gets closed, one gets opened — without a dead band that is a panel appearing
// and vanishing every poll, which is worse than never appearing at all. The
// band is asymmetric on purpose: it is harder to leave than to enter, because
// a panel that vanishes while you are reading it is the more expensive failure.
//
// **Nothing here writes.** Evaluation is pure. Whether an arrival is offered,
// accepted, or ignored is a decision made elsewhere, per person, because
// layouts are per person.

import { normalizeQuery, type DataQuery } from "./data-stream";

/** How a measured value is compared to the threshold. */
export type Comparison = "at_least" | "at_most" | "equals";

export const COMPARISONS: readonly Comparison[] = [
  "at_least",
  "at_most",
  "equals",
];

export type Situation = {
  /** Stable id — what a layout subscribes to. */
  id: string;
  /**
   * What it says when it arrives, in the reader's language. Shown in the
   * announcement, so it has to name the condition rather than the panel:
   * "6 tasks still open" tells you why a panel appeared; "Sprint panel" does
   * not.
   */
  label: string;
  /** The question, in the same vocabulary a panel asks. */
  query: DataQuery;
  compare: Comparison;
  threshold: number;
};

/**
 * How far a value must travel back before a true situation goes false.
 *
 * Ten per cent of the threshold, never less than one whole unit. The floor
 * matters more than the ratio: around a threshold of 3, a proportional band is
 * 0.3, which for a count is no band at all — and counts are what almost every
 * situation measures.
 */
export function deadBand(threshold: number): number {
  if (!Number.isFinite(threshold)) return 1;
  return Math.max(1, Math.abs(threshold) * 0.1);
}

/**
 * Is this situation true, given what it measures and whether it was true
 * before?
 *
 * `wasTrue` is the whole hysteresis mechanism: entering uses the threshold,
 * leaving uses the threshold plus the band. Callers that genuinely have no
 * prior state pass `false` and get the strict reading, which is the safe
 * direction — a situation that has never been seen should have to earn its
 * arrival.
 */
export function isSituationTrue(
  situation: Situation,
  value: number,
  wasTrue: boolean,
): boolean {
  const { compare, threshold } = situation;
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) return false;
  const band = wasTrue ? deadBand(threshold) : 0;

  switch (compare) {
    case "at_least":
      // Enters at >= threshold, leaves only below threshold - band.
      return value >= threshold - band;
    case "at_most":
      return value <= threshold + band;
    case "equals":
      // "Exactly N" cannot hold a band without meaning something else, so it
      // is the one comparison with no hysteresis — and the one to avoid for
      // anything that changes often. Stated rather than silently widened,
      // because a panel that appears at "about 5" when it promised "5" is
      // lying about its own condition.
      return value === threshold;
  }
}

/** The condition in words, for the announcement and for an agent to read. */
export function describeSituation(situation: Situation): string {
  const { compare, threshold, label } = situation;
  switch (compare) {
    case "at_least":
      return `${label} reached ${threshold}`;
    case "at_most":
      return `${label} fell to ${threshold}`;
    case "equals":
      return `${label} is exactly ${threshold}`;
  }
}

// ── Arriving, and leaving ───────────────────────────────────────────────
//
// Everything above decides whether a condition HOLDS. Nothing above decides
// whether to say so, and the difference is the whole feature: a condition that
// is true is a fact about the work, while an announcement is an interruption of
// a person, and the second is only justified by the first plus three things the
// server cannot know.
//
// Those three are why this is here rather than in `convex/situations.ts`. Two
// of them — is the panel already on this reader's screen, does its id still
// resolve to something drawable — are facts about a layout the client composed;
// the server genuinely cannot answer them (it cannot even distinguish "never
// arranged this screen" from "arranged it empty", which is why accepting a
// panel proposal hands the id back for the client to place). Splitting the
// predicate across the wire would put half the rule where it cannot be tested
// and the other half where it cannot see.

export type Resolution = "kept" | "dismissed";

/** One subscription as the screen sees it — `situations.forScreen`'s row. */
export type SituationState = {
  subscriptionId: string;
  /** The widget id a layout would carry: "custom:<id>" or a built-in. */
  panelId: string;
  /** `describeSituation`, computed server-side. Shown verbatim. */
  description: string;
  isTrue: boolean;
  becameTrueAt: number | null;
  becameFalseAt: number | null;
  acknowledgedAt: number | null;
  resolution: Resolution | null;
};

/** What only the screen knows about a panel. */
export type ScreenFacts = {
  /** Is it already in the reader's own saved layout? */
  onScreen: boolean;
  /** Does its id still resolve to a panel this screen can draw? */
  drawable: boolean;
};

/**
 * Should this condition announce itself?
 *
 * Five ways to answer no, and each one is a banner somebody would otherwise
 * have had to live with:
 *
 * **It isn't true.** The obvious one, stated first so the rest read as
 * refinements of it rather than as exceptions.
 *
 * **The panel is already there.** Offering to add what is on the screen is a
 * control that does nothing, and this is also what makes "keep" final: a kept
 * panel stays placed, so every later occurrence of its condition is answered by
 * the panel itself rather than by another banner.
 *
 * **Nothing would be drawn.** A subscription can outlive the panel it points
 * at. Announcing an arrival that resolves to an empty tile is worse than
 * silence, because the reader consents to something and gets nothing.
 *
 * **It was answered.** `acknowledgedAt` is the occurrence, not the
 * subscription, so "not now" is durable across sweeps without being permanent
 * across time — the condition has to go false and become true again to earn a
 * second hearing, and when it does, that is a new fact about the work.
 *
 * **We cannot date it.** A true condition with no transition stamp cannot be
 * acknowledged: any dismissal would record a time the row never moves past, so
 * the banner would return every fifteen minutes with no way to stop it. A
 * banner you cannot dismiss is worse than a panel you never saw, so an undated
 * condition stays quiet. Only reachable for a row written before transitions
 * were recorded; `record()` stamps every real one.
 */
export function shouldAnnounce(s: SituationState, f: ScreenFacts): boolean {
  if (!s.isTrue) return false;
  if (f.onScreen) return false;
  if (!f.drawable) return false;
  if (s.becameTrueAt === null) return false;
  if (s.acknowledgedAt === null) return true;
  return s.acknowledgedAt < s.becameTrueAt;
}

/**
 * Should the reader be told the reason a panel arrived has expired?
 *
 * Only for a panel they KEPT, and only while it is still on their screen. A
 * panel that was dismissed or merely previewed was never placed, so there is
 * nothing standing on the screen for the note to be about; a panel they have
 * since removed has already been dealt with more decisively than a note.
 *
 * It stays a note and never an action. The panel is theirs now — see the
 * departure reasoning in `convex/situations.ts` — so this says what changed and
 * offers, and the acknowledgement stamp keeps it to once per occurrence rather
 * than letting it settle into chrome.
 */
export function shouldReportDeparture(
  s: SituationState,
  f: ScreenFacts,
): boolean {
  if (s.isTrue) return false;
  if (s.resolution !== "kept") return false;
  if (!f.onScreen) return false;
  if (s.becameFalseAt === null) return false;
  if (s.acknowledgedAt === null) return true;
  return s.acknowledgedAt < s.becameFalseAt;
}

/**
 * How this occurrence was answered, in the reader's words, or null.
 *
 * The complement of `shouldAnnounce`'s stamp clause, and it exists because
 * without it the two halves of this feature contradict each other on the same
 * screen. The "Only here sometimes" list says a condition is *true now*; the
 * banner that would have offered its panel is absent because it was dismissed
 * — and nothing anywhere says so. "True, and nothing happened" reads as the
 * feature being broken, which is a worse outcome than never having dismissed
 * it.
 *
 * Deliberately says nothing about a condition that is false, or one whose
 * current occurrence has not been answered: there is no fact to report, and a
 * phrase per row is chrome.
 */
export function describeAnswer(s: SituationState): string | null {
  if (!s.isTrue || s.becameTrueAt === null) return null;
  if (s.acknowledgedAt === null || s.acknowledgedAt < s.becameTrueAt) {
    return null;
  }
  return s.resolution === "kept" ? "you kept it" : "dismissed for now";
}

/**
 * The one arrival to announce, or null.
 *
 * One at a time, matching "one pending proposal per agent per screen": a stack
 * of banners is a wall, and a wall is read as chrome rather than as news.
 *
 * Oldest occurrence first. The alternative — freshest first — sounds more
 * relevant and is how a queue starves: a screen with several live conditions
 * would keep putting the newest in front and the first one to become true would
 * never be seen. Answering one always advances the queue, so nothing waits
 * behind anything forever.
 */
export function nextAnnouncement(
  states: readonly SituationState[],
  factsFor: (s: SituationState) => ScreenFacts,
): SituationState | null {
  let best: SituationState | null = null;
  for (const s of states) {
    if (!shouldAnnounce(s, factsFor(s))) continue;
    if (best === null || (s.becameTrueAt ?? 0) < (best.becameTrueAt ?? 0)) {
      best = s;
    }
  }
  return best;
}

/** The one departure to report, oldest first, for the reasons above. */
export function nextDeparture(
  states: readonly SituationState[],
  factsFor: (s: SituationState) => ScreenFacts,
): SituationState | null {
  let best: SituationState | null = null;
  for (const s of states) {
    if (!shouldReportDeparture(s, factsFor(s))) continue;
    if (best === null || (s.becameFalseAt ?? 0) < (best.becameFalseAt ?? 0)) {
      best = s;
    }
  }
  return best;
}

/**
 * Coerce anything into a situation, or refuse.
 *
 * Returns null rather than a repaired object: unlike a panel — where a
 * malformed style should still draw something — a malformed *condition* would
 * make panels appear for reasons that are not true. The honest failure is for
 * the subscription to be ignored, leaving the panel exactly as it was.
 */
export function normalizeSituation(input: unknown): Situation | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  const compare = raw.compare as Comparison;
  const threshold = raw.threshold;

  if (!id || !label) return null;
  if (!COMPARISONS.includes(compare)) return null;
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) return null;
  if (typeof raw.query !== "object" || raw.query === null) return null;

  return {
    id: id.slice(0, 64),
    label: label.slice(0, 80),
    // The query is normalized by the resolver on its way to being asked — the
    // same closed vocabulary, the same single place. Copying that logic here
    // is how one vocabulary becomes two that disagree.
    query: raw.query as DataQuery,
    compare,
    threshold,
  };
}

// ── Composing one, in a sentence somebody would say ──────────────────────
//
// Everything below is for the person putting a condition together. It adds no
// power: every starter is an ordinary query, run through `normalizeQuery` like
// any other, so nothing here can express something an agent or the pickers
// could not. It exists so the first question a composer asks has answers on it
// rather than an empty vocabulary.

/** How a comparison reads in the row of options, before a number is on it. */
const COMPARISON_WORDS: Record<Comparison, string> = {
  at_least: "at least",
  at_most: "at most",
  equals: "exactly",
};

export function comparisonLabel(compare: Comparison): string {
  return COMPARISON_WORDS[compare];
}

/**
 * A starting question, in the query vocabulary.
 *
 * Every one is over tasks with only filters `convex/dataStream.ts` actually
 * honours for tasks — which is what keeps the composer from ever offering a
 * condition `situationRefusal` would then refuse. A control that produces a
 * refusal is the same failure as a control that produces a stub.
 */
export type SituationStarter = {
  id: string;
  /** What the condition is ABOUT — `describeSituation` puts a number after it. */
  label: string;
  query: DataQuery;
};

export const SITUATION_STARTERS: SituationStarter[] = [
  {
    id: "overdue",
    label: "Overdue tasks",
    query: normalizeQuery({
      from: "tasks",
      filter: { status: "open", due: "overdue" },
      measure: "count",
    }),
  },
  {
    id: "blocked",
    label: "Blocked tasks",
    query: normalizeQuery({
      from: "tasks",
      filter: { status: "open", blocked: true },
      measure: "count",
    }),
  },
  {
    id: "approval",
    label: "Tasks waiting on approval",
    query: normalizeQuery({
      from: "tasks",
      filter: { status: "open", needsApproval: true },
      measure: "count",
    }),
  },
  {
    id: "unassigned",
    label: "Tasks with nobody on them",
    query: normalizeQuery({
      from: "tasks",
      filter: { status: "open", assignee: "unassigned" },
      measure: "count",
    }),
  },
  {
    id: "mine",
    label: "My open tasks",
    query: normalizeQuery({
      from: "tasks",
      filter: { status: "open", assignee: "me" },
      measure: "count",
    }),
  },
  {
    id: "due-week",
    label: "Tasks due this week",
    query: normalizeQuery({
      from: "tasks",
      filter: { status: "open", due: "week" },
      measure: "count",
    }),
  },
];

/**
 * Where the threshold starts, given what the condition measures right now.
 *
 * Not 1, and not zero. A condition seeded at a constant is a condition whose
 * first reading is meaningless — "at least 1" over a board with forty open
 * tasks is already true and says nothing. Anchoring one step off the current
 * value makes the default sentence "tell me when this gets worse", which is
 * what somebody subscribing a panel almost always means, and it is legible
 * because the current value is on screen beside it.
 */
export function seedThreshold(compare: Comparison, value: number): number {
  if (!Number.isFinite(value)) return 1;
  const now = Math.round(value);
  switch (compare) {
    case "at_least":
      return now + 1;
    case "at_most":
      return Math.max(0, now - 1);
    case "equals":
      return Math.max(0, now);
  }
}

/**
 * A condition being composed, before anybody has agreed to it.
 *
 * The draft is separate from the `Situation` for one reason: `touched`. A
 * threshold nobody has moved may be re-seeded from a live reading, and one they
 * have moved may not — and that distinction has to survive the composer without
 * ever reaching the mutation, which is only interested in the claim.
 */
export type SituationDraft = {
  /** Which starting point it came from — `panel` for the panel's own question. */
  starterId: string;
  label: string;
  query: DataQuery;
  compare: Comparison;
  threshold: number;
  /** False until the person has moved the number themselves. */
  touched: boolean;
};

/** A fresh draft over one question, keeping the comparison already chosen. */
export function newDraft(
  question: { id: string; label: string; query: DataQuery },
  compare: Comparison = "at_least",
): SituationDraft {
  return {
    starterId: question.id,
    label: question.label,
    query: question.query,
    compare,
    // Replaced by the first live reading — see `seedFor`. One rather than zero
    // so a draft that is never measured is still a condition somebody meant.
    threshold: 1,
    touched: false,
  };
}

/** A draft as the thing the mutation takes. */
export function situationFromDraft(
  panelId: string,
  draft: SituationDraft,
): Situation {
  return {
    // Stable per panel: one panel has one condition, so the panel is the
    // identity. A fresh id per edit would leave the previous verdict's dead
    // band attached to a threshold nobody is comparing against any more.
    id: panelId.slice(0, 64),
    label: draft.label,
    query: draft.query,
    compare: draft.compare,
    threshold: draft.threshold,
  };
}

/**
 * The threshold this draft should start at, or null to leave it alone.
 *
 * Once per question, and never after the number has been touched: a control
 * that keeps rewriting what you chose is worse than one that never helps.
 */
export function seedFor(
  draft: SituationDraft,
  value: number | null,
): number | null {
  if (draft.touched || value === null) return null;
  return seedThreshold(draft.compare, value);
}
