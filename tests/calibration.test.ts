import { describe, expect, it } from "vitest";
import { normalizeQuery } from "../src/lib/data-stream";
import {
  brokenClaimFor,
  DIRECTIONS,
  UNCHANGED_TOLERANCE,
  calibrationOf,
  describeCalibration,
  describeExpectation,
  describeOutcome,
  evaluate,
  normalizeExpectation,
  type Direction,
  type Expectation,
} from "../src/lib/calibration";

// Decisions that find out whether they were right.
//
// The property everything here defends: an expectation must be falsifiable.
// That sounds abstract and is entirely concrete — a baseline read after the
// fact already contains the effect, so a claim attached later compares the
// world to itself and can never be wrong. Most of these tests are about
// keeping that impossible.

const AT = 1_000_000;

function expectation(over: Record<string, unknown> = {}) {
  return normalizeExpectation({
    query: { from: "tasks", filter: { due: "overdue" } },
    direction: "down",
    baseline: 20,
    dueAt: AT,
    ...over,
  })!;
}

describe("normalization", () => {
  it("refuses anything with no baseline", () => {
    // Without one there is nothing to be wrong about.
    expect(
      normalizeExpectation({ query: { from: "tasks" }, dueAt: AT }),
    ).toBeNull();
  });

  it("refuses anything with no horizon", () => {
    expect(
      normalizeExpectation({ query: { from: "tasks" }, baseline: 3 }),
    ).toBeNull();
  });

  it("refuses a ceiling or a floor with no number", () => {
    for (const direction of ["at_most", "at_least"]) {
      expect(
        normalizeExpectation({ direction, baseline: 3, dueAt: AT }),
        direction,
      ).toBeNull();
    }
    expect(
      normalizeExpectation({
        direction: "at_most",
        target: 5,
        baseline: 3,
        dueAt: AT,
      }),
    ).not.toBeNull();
  });

  it("survives anything at all", () => {
    for (const junk of [null, undefined, 0, "", []]) {
      expect(() => normalizeExpectation(junk)).not.toThrow();
      expect(normalizeExpectation(junk)).toBeNull();
    }
  });

  it("rewrites 'assigned to me' into 'anyone'", () => {
    // A claim whose answer depends on who is asking cannot be graded by a
    // cron, which has nobody's identity. Rewritten rather than refused: the
    // intent survives it, and refusing would push people to state it worse.
    const e = expectation({
      query: { from: "tasks", filter: { assignee: "me", due: "overdue" } },
    });
    expect(e.query.filter.assignee).toBe("anyone");
    expect(e.query.filter.due).toBe("overdue");
  });

  it("leaves any other assignee alone", () => {
    expect(
      expectation({ query: { from: "tasks", filter: { assignee: "agents" } } })
        .query.filter.assignee,
    ).toBe("agents");
  });

  it("drops a direction it does not enumerate", () => {
    expect(expectation({ direction: "sideways" }).direction).toBe("down");
  });

  it("is idempotent", () => {
    const once = expectation({ note: "  should halve  " });
    expect(normalizeExpectation(once)).toEqual(once);
    expect(once.note).toBe("should halve");
  });
});

describe("grading a claim", () => {
  it("says nothing before it is due", () => {
    // A verdict before the horizon is a verdict on an unfinished experiment.
    const e = expectation();
    expect(evaluate(e, 5, AT - 1).verdict).toBe("pending");
    expect(evaluate(e, 500, AT - 1).verdict).toBe("pending");
  });

  it("grades 'down' against the baseline, not against zero", () => {
    const e = expectation({ direction: "down", baseline: 20 });
    expect(evaluate(e, 19, AT).verdict).toBe("met");
    expect(evaluate(e, 20, AT).verdict).toBe("missed");
    expect(evaluate(e, 21, AT).verdict).toBe("missed");
  });

  it("grades 'up' the other way", () => {
    const e = expectation({ direction: "up", baseline: 20 });
    expect(evaluate(e, 21, AT).verdict).toBe("met");
    expect(evaluate(e, 20, AT).verdict).toBe("missed");
  });

  it("grades a ceiling against its number, not the baseline", () => {
    // "Keep it under ten" is true whether it started at four or forty.
    const e = expectation({ direction: "at_most", target: 10, baseline: 40 });
    expect(evaluate(e, 10, AT).verdict).toBe("met");
    expect(evaluate(e, 11, AT).verdict).toBe("missed");
  });

  it("grades a floor against its number", () => {
    const e = expectation({ direction: "at_least", target: 10, baseline: 2 });
    expect(evaluate(e, 10, AT).verdict).toBe("met");
    expect(evaluate(e, 9, AT).verdict).toBe("missed");
  });

  it("gives 'unchanged' a proportional band", () => {
    // Unchanged around 4 and around 400 are different claims.
    const small = expectation({ direction: "unchanged", baseline: 100 });
    expect(evaluate(small, 100 + 100 * UNCHANGED_TOLERANCE, AT).verdict).toBe("met");
    expect(evaluate(small, 100 + 100 * UNCHANGED_TOLERANCE + 1, AT).verdict).toBe(
      "missed",
    );
  });

  it("gives 'unchanged' a floor of one unit near zero", () => {
    // A proportional band around zero is nothing, which would make
    // "unchanged from 0" mean "exactly 0" — a different and much stronger
    // claim than anybody making it intended.
    const e = expectation({ direction: "unchanged", baseline: 0 });
    expect(evaluate(e, 1, AT).verdict).toBe("met");
    expect(evaluate(e, 2, AT).verdict).toBe("missed");
  });

  it("says a question that has gone cannot be graded", () => {
    // Scoring it as a miss would blame a team for a change in the furniture.
    expect(evaluate(expectation(), null, AT).verdict).toBe("unevaluable");
  });

  it("has a verdict for every direction", () => {
    for (const direction of DIRECTIONS as Direction[]) {
      const e = expectation({ direction, target: 5 });
      expect(["met", "missed"], direction).toContain(
        evaluate(e, 7, AT).verdict,
      );
    }
  });
});

describe("reading it back", () => {
  it("states every kind of claim in words", () => {
    for (const direction of DIRECTIONS as Direction[]) {
      const text = describeExpectation(expectation({ direction, target: 5 }));
      expect(text.length, direction).toBeGreaterThan(10);
      expect(text, direction).toContain("tasks");
    }
  });

  it("states a miss flatly, without softening it", () => {
    // A missed expectation is the most valuable row in the system. Hedging it
    // is how a team learns to stop making claims.
    const e = expectation();
    const text = describeOutcome(e, evaluate(e, 40, AT));
    expect(text).toContain("did not hold");
    expect(text).toContain("40");
    expect(text).toContain("20");
  });

  it("says what it was at the time when nothing is checked yet", () => {
    const e = expectation();
    expect(describeOutcome(e, evaluate(e, 3, AT - 1))).toContain("20");
  });
});

describe("calibration across a scope", () => {
  const outcomes = (spec: Record<string, number>) =>
    Object.entries(spec).flatMap(([verdict, n]) =>
      Array.from({ length: n }, () => ({ verdict: verdict as never })),
    );

  it("counts only what was actually graded", () => {
    // Pending and unevaluable claims are not evidence either way, and folding
    // them in would let a team improve its score by making claims it never
    // checks.
    const c = calibrationOf(
      outcomes({ met: 3, missed: 1, pending: 5, unevaluable: 2 }),
    );
    expect(c.graded).toBe(4);
    expect(c.rate).toBe(0.75);
  });

  it("distinguishes never-right from never-checked", () => {
    // A zero would read as the first when it means the second.
    expect(calibrationOf(outcomes({ pending: 4 })).rate).toBeNull();
    expect(calibrationOf(outcomes({ missed: 4 })).rate).toBe(0);
  });

  it("survives an empty scope", () => {
    const c = calibrationOf([]);
    expect(c.rate).toBeNull();
    expect(describeCalibration(c)).toContain("No claims");
  });

  it("says how it is going in one sentence", () => {
    const text = describeCalibration(
      calibrationOf(outcomes({ met: 3, missed: 1, pending: 2 })),
    );
    expect(text).toContain("3 of 4");
    expect(text).toContain("75%");
    expect(text).toContain("2 still open");
  });

  it("counts one waiting claim in the singular", () => {
    expect(describeCalibration(calibrationOf(outcomes({ pending: 1 })))).toContain(
      "1 claim ",
    );
  });
});

describe("the shape of a stored expectation", () => {
  it("keeps the window the claim was made with", () => {
    // A `7d` window evaluated a month later means something different from
    // what was claimed. Leaving it is correct; it is only worth a test
    // because it looks like a bug.
    const e: Expectation = expectation({
      query: { from: "tasks", filter: { window: "7d" } },
    });
    expect(e.query.filter.window).toBe("7d");
  });
});

describe("the claim a number broke", () => {
  // Normalized, because `describeQuery` reads the whole shape — a bare
  // `{from, measure}` is not a query this system ever produces.
  const query = normalizeQuery({ from: "tasks", measure: "count" });
  const other = normalizeQuery({ from: "pages", measure: "count" });
  const claim = (
    q: unknown,
    verdict: "missed" | "met" | "pending" | "unevaluable",
    checkedAt: number,
    value = 23,
  ) => ({
    question: `Did it move? ${checkedAt}`,
    expectation: {
      query: q as never,
      direction: "at_most" as const,
      target: 10,
      baseline: 18,
      dueAt: 0,
      note: "",
    },
    outcome: { verdict, value, checkedAt } as never,
  });

  it("wears a missed claim about the same number", () => {
    const found = brokenClaimFor(query, [claim(query, "missed", 5)]);
    expect(found?.value).toBe(23);
    expect(found?.claim).toContain("10");
  });

  it("says nothing when the claim held, or has not been checked", () => {
    expect(brokenClaimFor(query, [claim(query, "met", 5)])).toBeNull();
    expect(brokenClaimFor(query, [claim(query, "pending", 5)])).toBeNull();
    // "Unevaluable" means the question went away, not that anyone was wrong.
    expect(brokenClaimFor(query, [claim(query, "unevaluable", 5)])).toBeNull();
  });

  it("never attributes a failure to a claim about a different number", () => {
    // The expensive mistake this guards: telling somebody they said a number
    // would fall when they were talking about something else entirely.
    expect(brokenClaimFor(query, [claim(other, "missed", 5)])).toBeNull();
  });

  it("prefers the newest check, because a later decision supersedes it", () => {
    const found = brokenClaimFor(query, [
      claim(query, "missed", 5, 40),
      claim(query, "missed", 9, 23),
    ]);
    expect(found?.value).toBe(23);
  });

  it("says nothing at all when nobody claimed anything", () => {
    expect(brokenClaimFor(query, [])).toBeNull();
  });
});
