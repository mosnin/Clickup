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

import type { DataQuery } from "./data-stream";

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
