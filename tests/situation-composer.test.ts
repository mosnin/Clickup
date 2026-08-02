import { describe, expect, it } from "vitest";
import { normalizeQuery } from "../src/lib/data-stream";
import { normalizePanel } from "../src/lib/panel";
import { PANEL_PRESETS } from "../src/lib/panel-intent";
import {
  SITUATION_STARTERS,
  comparisonLabel,
  describeSituation,
  isSituationTrue,
  newDraft,
  normalizeSituation,
  seedFor,
  seedThreshold,
  situationFromDraft,
  COMPARISONS,
  type SituationDraft,
} from "../src/lib/situation";
import { situationRefusal } from "../convex/_situations";

// What the composer must not be able to do.
//
// `situations.subscribe` REFUSES rather than repairs — a malformed condition
// would make panels appear for reasons that are not true — which puts the
// burden on the surface that composes one: every affordance it offers has to
// lead somewhere the mutation will accept, or the feature is a button that
// produces a red toast.
//
// So the centre of this file is not "does the draft round-trip". It is: run
// every starting point the composer can offer through the server's own two
// refusals, in both scopes, and fail if any of them would be turned away.

const SCOPES = ["user", "workspace"] as const;

describe("the composer cannot offer a condition the server refuses", () => {
  it("accepts every starting point, in either scope", () => {
    for (const starter of SITUATION_STARTERS) {
      for (const scopeType of SCOPES) {
        expect(
          situationRefusal(starter.query, scopeType),
          `${starter.id} in a ${scopeType} scope`,
        ).toBeNull();
      }
    }
  });

  it("produces a situation the shape check accepts, for every comparison", () => {
    for (const starter of SITUATION_STARTERS) {
      for (const compare of COMPARISONS) {
        const draft = { ...newDraft(starter, compare), threshold: 3 };
        expect(
          normalizeSituation(situationFromDraft("custom:abc", draft)),
        ).not.toBeNull();
      }
    }
  });

  it("only offers a panel's own question when that question is measurable", () => {
    // The composer pre-fills from the panel's own query, which is the whole
    // point of "two taps". But a panel is allowed to ask things a situation
    // cannot measure — a page count narrowed to one list, say — and offering
    // one of those as a starting point is offering a refusal. This asserts the
    // gate exists in the only place it can be checked purely: the presets a
    // panel is most likely to have been built from.
    const measurable = PANEL_PRESETS.filter(
      (p) =>
        situationRefusal(normalizePanel(p.def).query, "workspace") === null,
    );
    // Some are measurable and some are not — if every preset passed, the gate
    // in `questionsFor` would be untested by construction.
    expect(measurable.length).toBeGreaterThan(0);
    expect(measurable.length).toBeLessThan(PANEL_PRESETS.length);
  });
});

describe("the number starts somewhere that means something", () => {
  it("anchors one step off what the question answers right now", () => {
    // A constant seed is a first sentence with no content: "at least 1" over a
    // board with forty open tasks is already true and says nothing.
    expect(seedThreshold("at_least", 40)).toBe(41);
    expect(seedThreshold("at_most", 40)).toBe(39);
    expect(seedThreshold("equals", 40)).toBe(40);
  });

  it("never seeds below zero, and never on an unreadable value", () => {
    expect(seedThreshold("at_most", 0)).toBe(0);
    expect(seedThreshold("at_least", NaN)).toBe(1);
  });

  it("stops the moment the person has moved it", () => {
    const fresh = newDraft(SITUATION_STARTERS[0]);
    expect(seedFor(fresh, 12)).toBe(13);
    // A control that keeps rewriting what you chose is worse than one that
    // never helps.
    expect(seedFor({ ...fresh, touched: true }, 12)).toBeNull();
    // And a reading that could not be taken is not zero — see `useMeasured`.
    expect(seedFor(fresh, null)).toBeNull();
  });
});

describe("one condition, one sentence", () => {
  it("reads back in the words the announcement uses", () => {
    // The studio, the toast and the arrival banner all render
    // `describeSituation`. A second phrasing anywhere is a condition that
    // appears to be two different conditions depending on where you read it.
    const draft: SituationDraft = {
      ...newDraft(
        { id: "overdue", label: "Overdue tasks", query: normalizeQuery({}) },
        "at_least",
      ),
      threshold: 6,
    };
    expect(describeSituation(situationFromDraft("custom:x", draft))).toBe(
      "Overdue tasks reached 6",
    );
  });

  it("names the panel as the condition's identity", () => {
    // One panel has one condition, so the panel IS the id. A fresh id per edit
    // would leave the previous verdict's dead band attached to a threshold
    // nobody is comparing against any more.
    const draft = newDraft(SITUATION_STARTERS[0]);
    expect(situationFromDraft("custom:sprint-heat", draft).id).toBe(
      "custom:sprint-heat",
    );
    expect(situationFromDraft("x".repeat(200), draft).id.length).toBe(64);
  });

  it("gives every comparison a word the row can wear", () => {
    for (const compare of COMPARISONS) {
      expect(comparisonLabel(compare)).toMatch(/^[a-z ]+$/);
    }
  });
});

describe("the live reading answers the question the gauge asks", () => {
  it("says 'true now' for exactly the values the poll would fire on", () => {
    // The composer draws its verdict with `wasTrue: false`, which is the
    // strict reading — a condition somebody is still composing has not earned
    // a dead band, and showing the banded answer would promise an arrival at a
    // value that will not produce one.
    const draft = { ...newDraft(SITUATION_STARTERS[0], "at_least"), threshold: 6 };
    const situation = situationFromDraft("custom:x", draft);
    expect(isSituationTrue(situation, 6, false)).toBe(true);
    expect(isSituationTrue(situation, 5, false)).toBe(false);
  });
});
