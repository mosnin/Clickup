import {
  DEFAULT_QUERY,
  describeQuery,
  normalizeQuery,
  type DataQuery,
} from "@/lib/data-stream";

// Decisions that find out whether they were right.
//
// The plan records what a team decided. It records nothing about what they
// *expected*, so nobody ever learns whether the reasoning was any good — which
// makes a decision log an archive rather than a loop. Everywhere else this is
// true too: retrospectives are recalled rather than measured, and the recalling
// is done by the people with the most to lose from the answer.
//
// The piece that makes it cheap here is that the claim can be stated in a
// vocabulary the system already executes. "This will cut overdue work" is a
// panel query and a direction. Nothing new has to be invented to check it; the
// same resolver that draws the chart grades the decision.
//
// **The baseline is captured when the claim is made, and that is the whole
// design.** A baseline read afterwards already contains the effect, so an
// expectation attached to a decision made last month is unfalsifiable — it
// would compare the world to itself. So `attach` records the value at that
// instant and refuses to backfill. It is the one rule that makes the rest
// honest, and the reason expectations cannot be added retrospectively.
//
// **Missing is not failing.** A missed expectation is the most valuable row in
// the system: it is the only place a team finds out its model of its own work
// is wrong. Nothing here softens it, hides it, or scores people on it — the
// verdict is stated flatly, and the plan shows it next to what was decided.

/** What a claim about the future can say. */
export type Direction =
  /** Lower than it was. The most common claim anyone makes. */
  | "down"
  /** Higher than it was. */
  | "up"
  /** No higher than a number. A ceiling — "keep it under ten". */
  | "at_most"
  /** No lower than a number. A floor. */
  | "at_least"
  /** Unmoved, within a tolerance. The "this will not regress anything" claim. */
  | "unchanged";

export const DIRECTIONS: Direction[] = [
  "down",
  "up",
  "at_most",
  "at_least",
  "unchanged",
];

export type Expectation = {
  /** The question, in the same vocabulary a panel asks. */
  query: DataQuery;
  direction: Direction;
  /** Required by `at_most`/`at_least`; ignored otherwise. */
  target: number;
  /** What the query answered at the moment the claim was made. */
  baseline: number;
  /** When it becomes checkable. */
  dueAt: number;
  /** In the claimant's own words. Optional — the query already says it. */
  note: string;
};

export type Verdict = "pending" | "met" | "missed" | "unevaluable";

export type Outcome = {
  verdict: Verdict;
  /** What the query answered when it was checked. */
  value: number;
  checkedAt: number;
};

/**
 * How much a value may drift and still count as unchanged.
 *
 * Proportional rather than absolute, because "unchanged" around 4 and around
 * 400 are different claims. Ten per cent is a judgement call; it is stated in
 * one place so it can be argued with rather than discovered.
 */
export const UNCHANGED_TOLERANCE = 0.1;

/**
 * Coerce anything into a checkable expectation.
 *
 * Two rules beyond the usual normalization, both of which exist because an
 * expectation is checked by a cron with nobody's identity:
 *
 *   - **"Assigned to me" becomes "anyone".** A claim whose answer depends on
 *     who is asking cannot be graded on a schedule. Rewritten rather than
 *     refused, because the intent — "this much work, of this kind" — survives
 *     the rewrite and refusing it would just push people to state it worse.
 *   - **The window is pinned to the query, not to now.** A `7d` window
 *     evaluated later means something different from what was claimed; leaving
 *     it is correct, and it is only worth saying because it looks like a bug.
 */
export function normalizeExpectation(input: unknown): Expectation | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;

  const query = normalizeQuery(raw.query ?? DEFAULT_QUERY);
  const direction = DIRECTIONS.includes(raw.direction as Direction)
    ? (raw.direction as Direction)
    : "down";
  const baseline = num(raw.baseline);
  const dueAt = num(raw.dueAt);
  if (baseline === null || dueAt === null || dueAt <= 0) return null;

  const target = num(raw.target) ?? 0;
  if ((direction === "at_most" || direction === "at_least") && raw.target === undefined) {
    return null;
  }

  return {
    query: {
      ...query,
      filter: {
        ...query.filter,
        assignee: query.filter.assignee === "me" ? "anyone" : query.filter.assignee,
      },
    },
    direction,
    target,
    baseline,
    dueAt,
    note: typeof raw.note === "string" ? raw.note.trim().slice(0, 200) : "",
  };
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Did the claim hold?
 *
 * Pure, and total. `now` is passed rather than read so the same function can
 * grade a decision, preview a grading, and be tested without a clock.
 */
export function evaluate(
  expectation: Expectation,
  value: number | null,
  now: number,
): Outcome {
  if (now < expectation.dueAt) {
    return { verdict: "pending", value: value ?? 0, checkedAt: now };
  }
  if (value === null) {
    // The query cannot be answered any more — a list was deleted, a scope
    // moved. Saying so is the honest verdict; scoring it as a miss would
    // blame a team for a change in the furniture.
    return { verdict: "unevaluable", value: 0, checkedAt: now };
  }

  const met = held(expectation, value);
  return { verdict: met ? "met" : "missed", value, checkedAt: now };
}

function held(e: Expectation, value: number): boolean {
  switch (e.direction) {
    case "down":
      return value < e.baseline;
    case "up":
      return value > e.baseline;
    case "at_most":
      return value <= e.target;
    case "at_least":
      return value >= e.target;
    case "unchanged": {
      // Around zero a proportional band is nothing, so the tolerance falls
      // back to one whole unit — otherwise "unchanged" from 0 could only ever
      // be met by exactly 0, which is a different claim.
      const band = Math.max(Math.abs(e.baseline) * UNCHANGED_TOLERANCE, 1);
      return Math.abs(value - e.baseline) <= band;
    }
  }
}

/** The claim, in the product's words. */
export function describeExpectation(e: Expectation): string {
  const what = describeQuery(e.query);
  switch (e.direction) {
    case "down":
      return `${what} will be lower than ${e.baseline}`;
    case "up":
      return `${what} will be higher than ${e.baseline}`;
    case "at_most":
      return `${what} will stay at or under ${e.target}`;
    case "at_least":
      return `${what} will reach at least ${e.target}`;
    case "unchanged":
      return `${what} will stay about where it is (${e.baseline})`;
  }
}

/** The result, in the product's words. Flat on purpose — see the note above. */
export function describeOutcome(e: Expectation, o: Outcome): string {
  switch (o.verdict) {
    case "pending":
      return `Not checked yet. It was ${e.baseline} when this was decided.`;
    case "unevaluable":
      return "This can no longer be checked — the question it asked has gone.";
    case "met":
      return `It held: ${o.value}, from ${e.baseline}.`;
    case "missed":
      return `It did not hold: ${o.value}, from ${e.baseline}.`;
  }
}

export type Calibration = {
  met: number;
  missed: number;
  pending: number;
  unevaluable: number;
  /** Of the claims that could be graded, how many held. Null when none were. */
  rate: number | null;
  graded: number;
};

/**
 * How often this scope's claims turn out to be right.
 *
 * The compounding artifact. One graded decision is a curiosity; forty is a
 * team discovering it is systematically optimistic about the same kind of
 * thing, which is not a fact anybody can get any other way.
 *
 * `rate` is null rather than 0 when nothing has been graded, because "we have
 * never been right" and "we have never checked" are opposite states and a
 * zero would read as the first.
 */
export function calibrationOf(outcomes: { verdict: Verdict }[]): Calibration {
  const count = (v: Verdict) => outcomes.filter((o) => o.verdict === v).length;
  const met = count("met");
  const missed = count("missed");
  const graded = met + missed;
  return {
    met,
    missed,
    pending: count("pending"),
    unevaluable: count("unevaluable"),
    graded,
    rate: graded === 0 ? null : met / graded,
  };
}

/** The calibration in one sentence, for a header or an agent's brief. */
export function describeCalibration(c: Calibration): string {
  if (c.graded === 0) {
    return c.pending > 0
      ? `${c.pending} claim${c.pending === 1 ? "" : "s"} waiting to be checked.`
      : "No claims have been checked yet.";
  }
  const pct = Math.round((c.rate ?? 0) * 100);
  const tail = c.pending > 0 ? `, ${c.pending} still open` : "";
  return `${c.met} of ${c.graded} claims held (${pct}%)${tail}.`;
}

/** Horizons worth offering. Typing a date is a worse question than picking. */
export const HORIZONS: { label: string; days: number }[] = [
  { label: "In a week", days: 7 },
  { label: "In two weeks", days: 14 },
  { label: "In a month", days: 30 },
  { label: "In a quarter", days: 90 },
];

// ── The claim a number broke ────────────────────────────────────────────
//
// Calibration grades what a team expected. Provenance lets a metric say where
// it came from. Neither knew about the other, so a decision could be measured
// as wrong in one place while the very number that proved it wrong was drawn
// somewhere else, saying nothing. Joining them is what turns a dashboard from
// something that reports the world back at you into something that holds you
// to your own reasoning: **23 overdue — you expected at most 10 by today.**
//
// **Matched on the query, not on prose.** `relevantDecisions` finds decisions
// that *bear on* a panel by word overlap, because a decision's text is the
// only thing there is to compare. Here both sides are structured — an
// expectation is stated in the same vocabulary a panel asks in — so the match
// is an equality rather than a guess. That matters more here than anywhere
// else in the product: a wrong "you said this would go down" attributes a
// failure to someone who never claimed it, which is worse than saying nothing.
//
// **Only `missed`.** Not pending (nothing happened yet), not met (a dashboard
// congratulating you is noise), and never `unevaluable`, which means the
// question went away rather than the claim failing.
//
// **Nothing here is narrated.** The sentence is computed from the two
// structures. An explanation that can disagree with the number it explains is
// worse than none, because people believe it.

export type BrokenClaim = {
  /** What was claimed, in the product's words. */
  claim: string;
  /** The question whose decision carried it, for the link back. */
  question: string;
  /** What it actually came to. */
  value: number;
};

/** Does this expectation ask the same thing this panel draws? */
function sameQuestion(a: DataQuery, b: DataQuery): boolean {
  // Source and measure only. A claim about "how many tasks" is about the same
  // number whether the panel groups it by assignee or by status — grouping
  // changes how it is drawn, not what is counted. Comparing the filter too
  // would silently drop the match every time somebody re-filtered their own
  // panel, which reads as the feature quietly breaking.
  return a.from === b.from && a.measure === b.measure;
}

/**
 * The broken claim a panel should be wearing, if there is one.
 *
 * Newest check wins when several apply: an older failed claim about the same
 * number has already been superseded by whatever was decided next.
 */
export function brokenClaimFor(
  query: DataQuery,
  decisions: readonly {
    question: string;
    expectation: Expectation;
    outcome: Outcome;
  }[],
): BrokenClaim | null {
  const hits = decisions
    .filter(
      (d) =>
        d.outcome.verdict === "missed" && sameQuestion(d.expectation.query, query),
    )
    .sort((a, b) => b.outcome.checkedAt - a.outcome.checkedAt);

  const top = hits[0];
  if (!top) return null;
  return {
    claim: describeExpectation(top.expectation),
    question: top.question,
    value: top.outcome.value,
  };
}
