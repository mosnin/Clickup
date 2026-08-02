import { describe, expect, it } from "vitest";
import { normalizeQuery } from "../src/lib/data-stream";
import {
  deadBand,
  describeSituation,
  isSituationTrue,
  normalizeSituation,
  type Situation,
} from "../src/lib/situation";

// The property that decides whether this feature is usable at all is not
// "does the comparison work" — it is "does a value sitting on the threshold
// make a panel blink". So the flap test is the centre of this file, and it is
// a property over an oscillating sequence rather than an example.

const base = (over: Partial<Situation> = {}): Situation => ({
  id: "sprint-open",
  label: "Open tasks in this sprint",
  query: normalizeQuery({ from: "tasks", measure: "count" }),
  compare: "at_least",
  threshold: 6,
  ...over,
});

describe("a condition on its threshold does not blink", () => {
  it("takes at most one transition while a value oscillates across it", () => {
    // Six open, one closes, one opens, one closes… Without a dead band this is
    // a panel arriving and leaving on every poll, which is worse than a panel
    // that never arrives: it trains you to ignore the screen.
    const s = base({ compare: "at_least", threshold: 6 });
    const sequence = [6, 5, 6, 5, 6, 5, 6];
    let state = false;
    let transitions = 0;
    for (const value of sequence) {
      const next = isSituationTrue(s, value, state);
      if (next !== state) transitions += 1;
      state = next;
    }
    expect(transitions).toBe(1);
    expect(state).toBe(true);
  });

  it("is harder to leave than to enter", () => {
    // Deliberately asymmetric: a panel that vanishes while you are reading it
    // is the more expensive failure, so leaving costs a whole band.
    const s = base({ compare: "at_least", threshold: 6 });
    expect(isSituationTrue(s, 5, false)).toBe(false);
    expect(isSituationTrue(s, 5, true)).toBe(true);
    expect(isSituationTrue(s, 4, true)).toBe(false);
  });

  it("bands `at_most` in the other direction", () => {
    const s = base({ compare: "at_most", threshold: 2 });
    expect(isSituationTrue(s, 3, false)).toBe(false);
    expect(isSituationTrue(s, 3, true)).toBe(true);
    expect(isSituationTrue(s, 4, true)).toBe(false);
  });

  it("gives a small threshold a band worth having", () => {
    // A proportional band around 3 is 0.3, which for a count is no band at
    // all — and counts are what almost every situation measures.
    expect(deadBand(3)).toBe(1);
    expect(deadBand(100)).toBe(10);
    expect(deadBand(NaN)).toBe(1);
  });

  it("refuses to widen `equals`, and says so by behaving strictly", () => {
    // "Exactly 5" with a band means "about 5", which is a different claim. A
    // panel that appears at 4 having promised 5 is lying about its own
    // condition.
    const s = base({ compare: "equals", threshold: 5 });
    expect(isSituationTrue(s, 5, false)).toBe(true);
    expect(isSituationTrue(s, 4, true)).toBe(false);
    expect(isSituationTrue(s, 6, true)).toBe(false);
  });
});

describe("a situation never fires on a value it cannot read", () => {
  it("is false for a measurement that is not a number", () => {
    // A resolver that returns nothing must not be read as "condition met".
    // Appearing for an unknown reason is the failure this whole feature has to
    // avoid.
    const s = base();
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(isSituationTrue(s, value, false)).toBe(false);
      expect(isSituationTrue(s, value, true)).toBe(false);
    }
  });

  it("is false when its own threshold is unreadable", () => {
    expect(isSituationTrue(base({ threshold: NaN }), 10, true)).toBe(false);
  });
});

describe("a malformed subscription is ignored, not repaired", () => {
  // Unlike a panel — where a broken style should still draw something — a
  // broken CONDITION would make panels appear for reasons that are not true.
  // The honest failure is that the subscription does nothing and the panel
  // stays exactly as it was.
  it("refuses anything missing its parts", () => {
    const ok = { id: "a", label: "Open", query: {}, compare: "at_least", threshold: 3 };
    expect(normalizeSituation(ok)).not.toBeNull();

    for (const bad of [
      null,
      undefined,
      42,
      "sprint",
      { ...ok, id: "" },
      { ...ok, label: "   " },
      { ...ok, compare: "roughly" },
      { ...ok, compare: undefined },
      { ...ok, threshold: "six" },
      { ...ok, threshold: NaN },
      { ...ok, query: undefined },
      { ...ok, query: "tasks" },
    ]) {
      expect(normalizeSituation(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("bounds the strings it will carry into the UI", () => {
    const long = normalizeSituation({
      id: "x".repeat(500),
      label: "y".repeat(500),
      query: {},
      compare: "at_most",
      threshold: 1,
    });
    expect(long?.id.length).toBe(64);
    expect(long?.label.length).toBe(80);
  });
});

describe("it says why it appeared", () => {
  it("names the condition, not the panel", () => {
    // "Sprint panel" tells you nothing about why your screen changed.
    expect(describeSituation(base({ compare: "at_least", threshold: 6 }))).toBe(
      "Open tasks in this sprint reached 6",
    );
    expect(describeSituation(base({ compare: "at_most", threshold: 0 }))).toBe(
      "Open tasks in this sprint fell to 0",
    );
    expect(describeSituation(base({ compare: "equals", threshold: 1 }))).toBe(
      "Open tasks in this sprint is exactly 1",
    );
  });
});
