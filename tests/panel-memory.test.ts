import { describe, expect, it } from "vitest";
import {
  DEFAULT_WATCH,
  WATCH_VOCABULARY,
  describeWatch,
  describeWatchIntent,
  isMovementOp,
  normalizeWatch,
  readPanelState,
  shouldRemember,
  type Watch,
  type WatchOp,
} from "../src/lib/panel-memory";

// A panel that remembers what it told you.
//
// The failures that matter here are all quiet ones. A panel that overwrites
// its memory on every render reports "no change" forever and looks like it is
// working. A watch that fires the first time it sees a value has not observed
// a change, it has observed an arrival — and the person who set it learns to
// ignore it. A delta measured against a number you saw thirty seconds ago
// makes the panel look like it is moving when you are the one who moved.
//
// None of those throw, none of them look broken, and every one of them
// destroys the reason the feature exists.

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("normalization", () => {
  it("returns null for no watch, rather than a default one", () => {
    // A default-constructed watch would quietly start announcing things on
    // every panel that never asked for one.
    for (const junk of [null, undefined, 0, "", [] as unknown]) {
      expect(normalizeWatch(junk), String(junk)).toBeNull();
    }
  });

  it("drops operators it does not enumerate", () => {
    expect(normalizeWatch({ op: "explodes" })?.op).toBe(DEFAULT_WATCH.op);
    expect(normalizeWatch({ tone: "scream" })?.tone).toBe(DEFAULT_WATCH.tone);
  });

  it("accepts every operator it advertises", () => {
    for (const op of WATCH_VOCABULARY.ops) {
      expect(normalizeWatch({ op })?.op, op).toBe(op);
    }
    for (const tone of WATCH_VOCABULARY.tones) {
      expect(normalizeWatch({ tone })?.tone, tone).toBe(tone);
    }
  });

  it("bounds the threshold", () => {
    // A threshold beyond any plausible reading is a watch that can never trip,
    // which is indistinguishable from no watch and much harder to notice.
    expect(normalizeWatch({ threshold: 1e30 })?.threshold).toBe(1e9);
    expect(normalizeWatch({ threshold: -1e30 })?.threshold).toBe(-1e9);
    expect(normalizeWatch({ threshold: NaN })?.threshold).toBe(
      DEFAULT_WATCH.threshold,
    );
  });
});

describe("the delta", () => {
  it("is silent the first time you ever see a panel", () => {
    const state = readPanelState({ value: 14, memory: null, watch: null, now: NOW });
    expect(state.delta).toBeNull();
    expect(state.since).toBeNull();
    expect(state.message).toBe("");
  });

  it("reports movement since you last looked", () => {
    const state = readPanelState({
      value: 14,
      memory: { value: 10, seenAt: NOW - 3 * DAY },
      watch: null,
      now: NOW,
    });
    expect(state.delta).toBe(4);
    expect(state.message).toContain("up 4");
    expect(state.message).toContain("3 days ago");
  });

  it("reports a fall as a fall", () => {
    const state = readPanelState({
      value: 6,
      memory: { value: 10, seenAt: NOW - 2 * HOUR },
      watch: null,
      now: NOW,
    });
    expect(state.delta).toBe(-4);
    expect(state.message).toContain("down 4");
  });

  it("says nothing when nothing moved", () => {
    const state = readPanelState({
      value: 10,
      memory: { value: 10, seenAt: NOW - DAY },
      watch: null,
      now: NOW,
    });
    expect(state.delta).toBe(0);
    expect(state.message).toBe("");
  });

  it("ignores a memory from moments ago — that is the same visit", () => {
    // Announcing a delta against a number you saw thirty seconds ago makes the
    // panel look like it is changing when you are the one who moved.
    const state = readPanelState({
      value: 14,
      memory: { value: 10, seenAt: NOW - 5_000 },
      watch: null,
      now: NOW,
    });
    expect(state.delta).toBeNull();
    expect(state.message).toBe("");
  });

  it("survives a non-finite reading rather than reporting NaN movement", () => {
    const state = readPanelState({
      value: Number.NaN,
      memory: { value: 10, seenAt: NOW - DAY },
      watch: null,
      now: NOW,
    });
    expect(Number.isFinite(state.value)).toBe(true);
    expect(state.message).not.toContain("NaN");
  });
});

describe("threshold watches", () => {
  const watch = (op: WatchOp, threshold = 5): Watch => ({
    op,
    threshold,
    tone: "note",
  });

  it("trips on the comparison it names", () => {
    expect(readPanelState({ value: 6, memory: null, watch: watch("above"), now: NOW }).tripped).toBe(true);
    expect(readPanelState({ value: 5, memory: null, watch: watch("above"), now: NOW }).tripped).toBe(false);
    expect(readPanelState({ value: 4, memory: null, watch: watch("below"), now: NOW }).tripped).toBe(true);
    expect(readPanelState({ value: 5, memory: null, watch: watch("below"), now: NOW }).tripped).toBe(false);
    expect(readPanelState({ value: 5, memory: null, watch: watch("equals"), now: NOW }).tripped).toBe(true);
  });

  it("trips without a memory, because a threshold does not need one", () => {
    const state = readPanelState({
      value: 9,
      memory: null,
      watch: watch("above"),
      now: NOW,
    });
    expect(state.tripped).toBe(true);
    expect(state.message).toContain("over 5");
  });

  it("carries its tone only while tripped", () => {
    const loud: Watch = { op: "above", threshold: 5, tone: "alert" };
    expect(readPanelState({ value: 9, memory: null, watch: loud, now: NOW }).tone).toBe("alert");
    expect(readPanelState({ value: 1, memory: null, watch: loud, now: NOW }).tone).toBeNull();
  });

  it("says nothing about a watch that has not tripped", () => {
    const state = readPanelState({
      value: 1,
      memory: null,
      watch: watch("above"),
      now: NOW,
    });
    expect(state.message).toBe("");
  });
});

describe("movement watches", () => {
  const rises: Watch = { op: "rises", threshold: 0, tone: "note" };
  const falls: Watch = { op: "falls", threshold: 0, tone: "note" };
  const changes: Watch = { op: "changes", threshold: 0, tone: "note" };

  it("does not fire the first time it sees a value", () => {
    // A watch that fires on first sight has not observed a change, it has
    // observed an arrival — and the person who set it learns to ignore it.
    for (const watch of [rises, falls, changes]) {
      expect(
        readPanelState({ value: 99, memory: null, watch, now: NOW }).tripped,
        watch.op,
      ).toBe(false);
    }
  });

  it("fires on movement in the direction it names", () => {
    const up = { value: 12, memory: { value: 10, seenAt: NOW - DAY }, now: NOW };
    const down = { value: 8, memory: { value: 10, seenAt: NOW - DAY }, now: NOW };
    expect(readPanelState({ ...up, watch: rises }).tripped).toBe(true);
    expect(readPanelState({ ...down, watch: rises }).tripped).toBe(false);
    expect(readPanelState({ ...down, watch: falls }).tripped).toBe(true);
    expect(readPanelState({ ...up, watch: falls }).tripped).toBe(false);
    expect(readPanelState({ ...up, watch: changes }).tripped).toBe(true);
    expect(readPanelState({ ...down, watch: changes }).tripped).toBe(true);
  });

  it("does not fire when nothing moved", () => {
    const same = { value: 10, memory: { value: 10, seenAt: NOW - DAY }, now: NOW };
    for (const watch of [rises, falls, changes]) {
      expect(readPanelState({ ...same, watch }).tripped, watch.op).toBe(false);
    }
  });

  it("does not repeat itself — the delta clause already said it moved", () => {
    // "up 4 since Tuesday, and it went up" is the panel talking to itself.
    const state = readPanelState({
      value: 14,
      memory: { value: 10, seenAt: NOW - DAY },
      watch: rises,
      now: NOW,
    });
    expect(state.tripped).toBe(true);
    expect(state.message).toContain("up 4");
    expect(state.message).not.toContain("went up");
  });

  it("classifies which operators need a memory", () => {
    expect(isMovementOp("rises")).toBe(true);
    expect(isMovementOp("falls")).toBe(true);
    expect(isMovementOp("changes")).toBe(true);
    expect(isMovementOp("above")).toBe(false);
    expect(isMovementOp("below")).toBe(false);
    expect(isMovementOp("equals")).toBe(false);
  });
});

describe("when to write a memory", () => {
  it("refuses before the reader has had a chance to see it", () => {
    // Writing on every render overwrites the very thing the delta is measured
    // against, and the panel reports "no change" forever while looking fine.
    expect(
      shouldRemember({ value: 14, memory: null, shownAt: NOW - 100, now: NOW }),
    ).toBe(false);
  });

  it("writes once the panel has been on screen a moment", () => {
    expect(
      shouldRemember({ value: 14, memory: null, shownAt: NOW - 10_000, now: NOW }),
    ).toBe(true);
  });

  it("does not rewrite an unchanged memory", () => {
    expect(
      shouldRemember({
        value: 14,
        memory: { value: 14, seenAt: NOW - DAY },
        shownAt: NOW - 10_000,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("writes when the value has moved under a reader who is still watching", () => {
    expect(
      shouldRemember({
        value: 15,
        memory: { value: 14, seenAt: NOW - DAY },
        shownAt: NOW - 10_000,
        now: NOW,
      }),
    ).toBe(true);
  });
});

describe("words", () => {
  it("reads a watch differently when setting it than when it trips", () => {
    const watch: Watch = { op: "above", threshold: 5, tone: "note" };
    expect(describeWatch(watch)).toBe("over 5");
    expect(describeWatchIntent(watch)).toContain("Tell me when");
  });

  it("has words for every operator, in both grammars", () => {
    for (const op of WATCH_VOCABULARY.ops) {
      const watch: Watch = { op, threshold: 3, tone: "note" };
      expect(describeWatch(watch).length, op).toBeGreaterThan(0);
      expect(describeWatchIntent(watch).length, op).toBeGreaterThan(0);
    }
  });

  it("phrases the gap as a clause, not as a timestamp", () => {
    // It reads inside "up 4 since …", where "3 hours ago" would give
    // "since 3 hours ago". Different grammar, different function.
    const cases: [number, string][] = [
      [NOW - 2 * 60_000, "2 minutes ago"],
      [NOW - 2 * HOUR, "2 hours ago"],
      [NOW - DAY, "yesterday"],
      [NOW - 3 * DAY, "3 days ago"],
      [NOW - 8 * DAY, "last week"],
    ];
    for (const [seenAt, expected] of cases) {
      const state = readPanelState({
        value: 5,
        memory: { value: 1, seenAt },
        watch: null,
        now: NOW,
      });
      expect(state.message, expected).toContain(expected);
    }
  });
});
