import { describe, expect, it } from "vitest";
import {
  isStale,
  sortObligations,
  summarize,
  waitedFor,
  type Obligation,
} from "../src/lib/obligations";

// The queue's rules, tested where they can be tested without a browser.
//
// The property that matters most is the sort. Every one of the four surfaces
// this replaces ordered newest-first, like a feed — which buries the
// obligation that has waited longest, i.e. exactly the one at risk of never
// being answered at all.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

const at = (ms: number, kind: Obligation["kind"] = "approval"): Obligation => ({
  kind,
  id: `${kind}-${ms}`,
  title: "Something",
  href: "/dashboard",
  createdAt: NOW - ms,
});

describe("the queue sorts by age, oldest first", () => {
  it("puts the longest-waiting obligation at the top", () => {
    const sorted = sortObligations([at(HOUR), at(5 * DAY), at(2 * HOUR)]);
    expect(sorted.map((r) => r.createdAt)).toEqual([
      NOW - 5 * DAY,
      NOW - 2 * HOUR,
      NOW - HOUR,
    ]);
  });

  it("is stable when two things arrived together", () => {
    // Same instant, different kinds — the order has to be the same on every
    // render rather than depending on which query answered first.
    const a = sortObligations([at(DAY, "outcome"), at(DAY, "approval")]);
    const b = sortObligations([at(DAY, "approval"), at(DAY, "outcome")]);
    expect(a.map((r) => r.kind)).toEqual(b.map((r) => r.kind));
  });

  it("does not mutate what it was given", () => {
    const input = [at(HOUR), at(DAY)];
    const copy = [...input];
    sortObligations(input);
    expect(input).toEqual(copy);
  });
});

describe("how long it has waited", () => {
  it("speaks in the buckets a person reacts to", () => {
    expect(waitedFor(NOW - 60_000, NOW)).toBe("just now");
    expect(waitedFor(NOW - 3 * HOUR, NOW)).toBe("3h");
    expect(waitedFor(NOW - 3 * DAY, NOW)).toBe("3d");
    // Precision nobody acts on differently is precision not worth spending:
    // "2d 19h" and "2d" carry the same decision.
    expect(waitedFor(NOW - (2 * DAY + 19 * HOUR), NOW)).toBe("2d");
  });

  it("never reads as negative when a clock disagrees", () => {
    expect(waitedFor(NOW + 5 * HOUR, NOW)).toBe("just now");
  });
});

describe("staleness marks, never hides", () => {
  it("turns over at a working day", () => {
    expect(isStale(NOW - (DAY - 1), NOW)).toBe(false);
    expect(isStale(NOW - DAY, NOW)).toBe(true);
  });

  it("counts what is waiting and what has waited too long", () => {
    const rows = [at(HOUR), at(2 * DAY), at(9 * DAY)];
    expect(summarize(rows, NOW)).toEqual({ total: 3, stale: 2 });
    // Zero has to be reachable, or the queue is just another inbox.
    expect(summarize([], NOW)).toEqual({ total: 0, stale: 0 });
  });
});
