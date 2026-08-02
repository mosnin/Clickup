import { describe, expect, it } from "vitest";
import {
  describeAnswer,
  nextAnnouncement,
  nextDeparture,
  shouldAnnounce,
  shouldReportDeparture,
  type ScreenFacts,
  type SituationState,
} from "../src/lib/situation";

// Whether to interrupt somebody.
//
// `situation.test.ts` proves whether a condition HOLDS. This proves whether the
// screen gets to say so, which is a different question with a different failure
// mode: the arithmetic failing shows a panel at the wrong number, and this
// failing shows the same banner every fifteen minutes until the reader stops
// looking at their own screen.
//
// It is a pure predicate rather than a React effect on purpose. "Dismiss then
// re-announce a week later" is a claim about three timestamps and a set
// membership; expressed as an effect it would need a fake clock, a rendered
// tree and a fake subscription to say anything at all, and it would still only
// be checking one path through it.

const ON: ScreenFacts = { onScreen: true, drawable: true };
const OFF: ScreenFacts = { onScreen: false, drawable: true };

function state(over: Partial<SituationState> = {}): SituationState {
  return {
    subscriptionId: "sub1",
    panelId: "custom:sprint-heat",
    description: "Open tasks in this sprint reached 6",
    isTrue: true,
    becameTrueAt: 1_000,
    becameFalseAt: null,
    acknowledgedAt: null,
    resolution: null,
    ...over,
  };
}

describe("an arrival announces once, and only when there is something to say", () => {
  it("announces a true condition whose panel is not on the screen", () => {
    expect(shouldAnnounce(state(), OFF)).toBe(true);
  });

  it("says nothing while the condition is false", () => {
    expect(shouldAnnounce(state({ isTrue: false }), OFF)).toBe(false);
  });

  it("says nothing about a panel already on the screen", () => {
    // Offering to add what is already there is a control that does nothing —
    // and it is what makes "keep" final, since a kept panel answers every later
    // occurrence of its own condition.
    expect(shouldAnnounce(state(), ON)).toBe(false);
  });

  it("says nothing when the panel would draw nothing", () => {
    // A subscription can outlive the panel it points at. Consenting to
    // something and getting an empty tile is worse than never being asked.
    expect(
      shouldAnnounce(state(), { onScreen: false, drawable: false }),
    ).toBe(false);
  });

  it("stays quiet about a true condition it cannot date", () => {
    // Any dismissal would record a stamp the row never moves past, so the
    // banner would return forever with no way to stop it. A banner you cannot
    // dismiss is worse than a panel you never saw.
    expect(shouldAnnounce(state({ becameTrueAt: null }), OFF)).toBe(false);
  });
});

describe("not now is durable, and not permanent", () => {
  it("stays dismissed while the same occurrence is still true", () => {
    // The property the whole mechanism exists for. The sweep runs every
    // fifteen minutes and re-measures the same true condition; an in-memory
    // dismissal would put the banner back on every one of them.
    const dismissed = state({ acknowledgedAt: 1_000 });
    for (let i = 0; i < 96; i += 1) {
      expect(shouldAnnounce(dismissed, OFF)).toBe(false);
    }
  });

  it("announces again after the condition has cleared and returned", () => {
    // A new occurrence is a new fact about the work. Six tasks open today,
    // dismissed; the sprint clears; six are open again next week — that is
    // worth saying, and a subscription-wide "never again" flag could not.
    const again = state({
      acknowledgedAt: 1_000,
      becameFalseAt: 2_000,
      becameTrueAt: 3_000,
    });
    expect(shouldAnnounce(again, OFF)).toBe(true);
  });

  it("does not treat an acknowledgement of a later transition as stale", () => {
    // The reverse ordering: a row acknowledged AFTER its current occurrence
    // began (a departure answered while the condition was already back) must
    // not reopen the arrival it already answered.
    const answered = state({ becameTrueAt: 3_000, acknowledgedAt: 3_000 });
    expect(shouldAnnounce(answered, OFF)).toBe(false);
  });

  it("keeps a kept panel from re-announcing when the condition returns", () => {
    // Belt and braces with the stamp: even if the acknowledgement were lost,
    // the panel is on the screen, and that alone silences it.
    const kept = state({
      resolution: "kept",
      becameFalseAt: 2_000,
      becameTrueAt: 3_000,
      acknowledgedAt: null,
    });
    expect(shouldAnnounce(kept, ON)).toBe(false);
  });
});

describe("a departure is reported only for a panel somebody kept", () => {
  const gone = (over: Partial<SituationState> = {}) =>
    state({
      isTrue: false,
      becameTrueAt: 1_000,
      becameFalseAt: 2_000,
      resolution: "kept",
      acknowledgedAt: 1_000,
      ...over,
    });

  it("tells the reader the reason has expired", () => {
    expect(shouldReportDeparture(gone(), ON)).toBe(true);
  });

  it("says nothing about a panel that was only ever previewed", () => {
    // Nothing was written, so there is nothing standing on the screen for the
    // note to be about. The preview withdrew in the tab it existed in.
    expect(shouldReportDeparture(gone({ resolution: null }), ON)).toBe(false);
  });

  it("says nothing about a panel that was dismissed", () => {
    expect(shouldReportDeparture(gone({ resolution: "dismissed" }), ON)).toBe(
      false,
    );
  });

  it("says nothing once the reader has removed the panel themselves", () => {
    expect(shouldReportDeparture(gone(), OFF)).toBe(false);
  });

  it("says nothing while the condition still holds", () => {
    expect(shouldReportDeparture(gone({ isTrue: true }), ON)).toBe(false);
  });

  it("is said once per occurrence rather than becoming chrome", () => {
    const acknowledged = gone({ acknowledgedAt: 2_000 });
    expect(shouldReportDeparture(acknowledged, ON)).toBe(false);
    // …and is said again if the condition holds and lapses a second time,
    // because that is a second thing that happened.
    expect(
      shouldReportDeparture(
        gone({ acknowledgedAt: 2_000, becameTrueAt: 3_000, becameFalseAt: 4_000 }),
        ON,
      ),
    ).toBe(true);
  });
});

describe("the list and the banner cannot contradict each other", () => {
  // Both halves of this feature read the same query, and they are on the same
  // screen at the same time — the banner above the canvas, the list in the
  // arrange tray. Without this the list says "True now" about a condition whose
  // banner is deliberately absent, and nothing anywhere explains the gap. "True,
  // and nothing happened" reads as the product being broken, which is a worse
  // outcome than having dismissed it.

  it("says nothing about a condition nobody has answered", () => {
    expect(describeAnswer(state())).toBeNull();
  });

  it("says nothing about a condition that is not true", () => {
    expect(
      describeAnswer(state({ isTrue: false, acknowledgedAt: 5_000 })),
    ).toBeNull();
  });

  it("explains a dismissal, which is why no banner is showing", () => {
    expect(
      describeAnswer(state({ acknowledgedAt: 1_000, resolution: "dismissed" })),
    ).toBe("dismissed for now");
  });

  it("explains a panel that was kept", () => {
    expect(
      describeAnswer(state({ acknowledgedAt: 1_000, resolution: "kept" })),
    ).toBe("you kept it");
  });

  it("goes quiet again the moment a new occurrence is on offer", () => {
    // The exact complement of `shouldAnnounce`: if the banner is back, the list
    // must stop explaining an answer that belongs to the previous occurrence.
    const again = state({
      acknowledgedAt: 1_000,
      resolution: "dismissed",
      becameFalseAt: 2_000,
      becameTrueAt: 3_000,
    });
    expect(shouldAnnounce(again, OFF)).toBe(true);
    expect(describeAnswer(again)).toBeNull();
  });

  it("is the exact complement of announcing, for every stamp", () => {
    // Stated as a property rather than four examples, because the two are read
    // side by side: whenever the banner is silent about a true condition for a
    // reason the reader caused, the list has to be able to say so.
    for (const acknowledgedAt of [null, 500, 1_000, 1_500]) {
      const s = state({ acknowledgedAt, resolution: "dismissed" });
      const announcing = shouldAnnounce(s, OFF);
      expect(describeAnswer(s) === null, `ack=${acknowledgedAt}`).toBe(
        announcing,
      );
    }
  });
});

describe("absence means always-on", () => {
  it("announces nothing when there are no subscriptions", () => {
    // The rule this codebase has already paid for twice. A panel with no
    // situation behaves exactly as it does today, which means a screen with no
    // situations shows exactly what it showed before this feature existed.
    expect(nextAnnouncement([], () => OFF)).toBeNull();
    expect(nextDeparture([], () => OFF)).toBeNull();
  });

  it("announces nothing when every subscription is false", () => {
    const quiet = [
      state({ subscriptionId: "a", isTrue: false }),
      state({ subscriptionId: "b", isTrue: false, resolution: "dismissed" }),
    ];
    expect(nextAnnouncement(quiet, () => OFF)).toBeNull();
    expect(nextDeparture(quiet, () => ON)).toBeNull();
  });
});

describe("one at a time, oldest first", () => {
  it("offers the condition that became true first", () => {
    // Freshest-first sounds more relevant and is how a queue starves: with
    // several live conditions the first one to become true would never be seen.
    const many = [
      state({ subscriptionId: "new", panelId: "custom:b", becameTrueAt: 9_000 }),
      state({ subscriptionId: "old", panelId: "custom:a", becameTrueAt: 1_000 }),
      state({ subscriptionId: "mid", panelId: "custom:c", becameTrueAt: 5_000 }),
    ];
    expect(nextAnnouncement(many, () => OFF)?.subscriptionId).toBe("old");
  });

  it("advances the queue when one is answered", () => {
    const answered = state({
      subscriptionId: "old",
      panelId: "custom:a",
      becameTrueAt: 1_000,
      acknowledgedAt: 1_000,
    });
    const waiting = state({
      subscriptionId: "mid",
      panelId: "custom:c",
      becameTrueAt: 5_000,
    });
    expect(
      nextAnnouncement([answered, waiting], () => OFF)?.subscriptionId,
    ).toBe("mid");
  });

  it("never offers an arrival and a departure about the same screen at once", () => {
    // Not a rule the predicates enforce between them — it is enforced by the
    // banner rendering one or the other — but the two queues must at least be
    // able to disagree without both pointing at the same subscription.
    const s = state({ isTrue: true, resolution: "kept" });
    expect(shouldAnnounce(s, ON)).toBe(false);
    expect(shouldReportDeparture(s, ON)).toBe(false);
  });
});
