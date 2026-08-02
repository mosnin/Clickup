import { describe, expect, it } from "vitest";
import {
  MAX_TURN_DURATION_MS,
  TERMINAL_TURN_STATES,
  TURN_ABANDON_AFTER_MS,
  TURN_LIVENESS_INTERVAL_MS,
  TURN_STALE_AFTER_MS,
  isTerminalTurnState,
  nextTurnState,
  turnIsLive,
  turnLiveness,
  workingAgents,
  type ChatTurn,
  type TurnState,
} from "../src/lib/buzz/turn";

// The turn state machine, on its own. Every rule here is about a harness that
// misbehaves in a way a well-behaved one never would — arriving late, arriving
// twice, arriving after somebody already stopped it, or never arriving again —
// because a harness that behaves is not the case this file exists for.

const T0 = 1_700_000_000_000;

function turn(patch: Partial<ChatTurn> = {}): ChatTurn {
  return {
    turnId: "turn-1",
    channelId: "room-1",
    agentId: "agent-1",
    agentPubkey: "aa".repeat(32),
    state: "started",
    startedAt: T0,
    lastActivityAt: T0,
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

describe("the constants", () => {
  it("keeps its windows in the order the rules depend on", () => {
    // Every rule below assumes stale < abandoned < the wall-clock cap. Reorder
    // them and "stalled" becomes unreachable, which is the state the whole
    // design exists to be able to draw.
    expect(TURN_STALE_AFTER_MS).toBeGreaterThan(TURN_LIVENESS_INTERVAL_MS);
    expect(TURN_ABANDON_AFTER_MS).toBeGreaterThan(TURN_STALE_AFTER_MS);
    expect(MAX_TURN_DURATION_MS).toBeGreaterThan(TURN_ABANDON_AFTER_MS);
    // Two and a half beats: one missed heartbeat must not be a state change.
    expect(TURN_STALE_AFTER_MS).toBe(2.5 * TURN_LIVENESS_INTERVAL_MS);
  });

  it("agrees with itself about which states are terminal", () => {
    const all: TurnState[] = ["started", "streaming", "finished", "cancelled", "failed"];
    expect(all.filter(isTerminalTurnState).sort()).toEqual([
      "cancelled",
      "failed",
      "finished",
    ]);
    expect(TERMINAL_TURN_STATES.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

describe("liveness is derived from the clock", () => {
  it("reads as working while the beats keep arriving", () => {
    const t = turn({ lastActivityAt: T0 });
    expect(turnIsLive(t, T0)).toBe(true);
    expect(turnIsLive(t, T0 + TURN_STALE_AFTER_MS - 1)).toBe(true);
    // One missed beat is a slow network, not a state change.
    expect(turnIsLive(t, T0 + TURN_LIVENESS_INTERVAL_MS + 1)).toBe(true);
  });

  it("stops reading as live the moment the harness goes quiet", () => {
    // The property the whole file exists for: a crashed harness clears itself.
    // Nothing wrote anything, nothing was scheduled, no cron ran — the turn is
    // simply not live any more because time passed.
    const t = turn({ lastActivityAt: T0 });
    expect(turnIsLive(t, T0 + TURN_STALE_AFTER_MS)).toBe(false);
    expect(turnLiveness(t, T0 + TURN_STALE_AFTER_MS)).toBe("stalled");
  });

  it("decays through stalled to abandoned, so there is always something to draw", () => {
    const t = turn({ lastActivityAt: T0 });
    expect(turnLiveness(t, T0)).toBe("working");
    expect(turnLiveness(t, T0 + TURN_STALE_AFTER_MS + 1)).toBe("stalled");
    expect(turnLiveness(t, T0 + TURN_ABANDON_AFTER_MS)).toBe("abandoned");
    // "stalled" is the honest middle: it may still come back, and the reader
    // deserves to be told that rather than shown nothing.
    expect(turnLiveness(t, T0 + TURN_ABANDON_AFTER_MS - 1)).toBe("stalled");
  });

  it("refuses to believe a heartbeat past the two-hour cap", () => {
    // A wedged harness that pings forever is exactly what the cap is for, so a
    // fresh beat must not be able to talk its way past it.
    const t = turn({ startedAt: T0, lastActivityAt: T0 + MAX_TURN_DURATION_MS });
    expect(turnLiveness(t, T0 + MAX_TURN_DURATION_MS)).toBe("abandoned");
    expect(turnIsLive(t, T0 + MAX_TURN_DURATION_MS)).toBe(false);
  });

  it("calls a terminal turn ended however recently it moved", () => {
    for (const state of ["finished", "cancelled", "failed"] as const) {
      expect(turnLiveness(turn({ state, endedAt: T0 }), T0)).toBe("ended");
      expect(turnIsLive(turn({ state }), T0)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

describe("a turn cannot go backwards", () => {
  it("refuses every event once a turn is terminal", () => {
    for (const state of ["finished", "cancelled", "failed"] as const) {
      const t = turn({ state, endedAt: T0 });
      for (const event of [
        { type: "start", at: T0 + 1 },
        { type: "partial", at: T0 + 1 },
        { type: "finish", at: T0 + 1 },
        { type: "fail", at: T0 + 1, error: "boom" },
        { type: "cancel", at: T0 + 1 },
      ] as const) {
        const step = nextTurnState(t, event);
        expect(step.ok, `${state} + ${event.type}`).toBe(false);
      }
    }
  });

  it("does not let a restart pull a streaming turn back to started", () => {
    // A harness re-announcing a turn it is already streaming is a restart, not
    // a rewind: the room has already seen output and must not be told it hasn't.
    const step = nextTurnState(turn({ state: "streaming" }), { type: "start", at: T0 + 5 });
    expect(step).toMatchObject({ ok: true });
    if (!step.ok) return;
    expect(step.turn.state).toBe("streaming");
    expect(step.turn.lastActivityAt).toBe(T0 + 5);
  });

  it("promotes started to streaming on the first partial, and stays there", () => {
    const first = nextTurnState(turn(), { type: "partial", at: T0 + 1, narration: "reading" });
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) return;
    expect(first.turn.state).toBe("streaming");
    expect(first.turn.narration).toBe("reading");

    const second = nextTurnState(first.turn, { type: "partial", at: T0 + 2, narration: "writing" });
    expect(second).toMatchObject({ ok: true });
    if (!second.ok) return;
    // Replaced, never appended: the record is one sentence, the transcript is
    // the room.
    expect(second.turn.narration).toBe("writing");
  });

  it("refuses a frame older than the record rather than rewinding the clock", () => {
    // A delayed packet that moved `lastActivityAt` backwards would make a live
    // turn read as stale — the badge flickering that the 2.5-beat window exists
    // to prevent, reintroduced from the other end.
    const t = turn({ lastActivityAt: T0 + 10_000 });
    const step = nextTurnState(t, { type: "partial", at: T0 + 5_000 });
    expect(step.ok).toBe(false);
  });

  it("accepts a late completion and clamps it forward", () => {
    // A completion is authoritative and always lands. What it must not do is
    // end before the turn's own last activity — a negative duration is a record
    // nothing can draw.
    const t = turn({ lastActivityAt: T0 + 10_000 });
    const step = nextTurnState(t, { type: "finish", at: T0 + 5_000 });
    expect(step).toMatchObject({ ok: true });
    if (!step.ok) return;
    expect(step.turn.endedAt).toBe(T0 + 10_000);
    expect(step.turn.endedAt).toBeGreaterThanOrEqual(step.turn.startedAt);
  });
});

describe("resurrection is bounded", () => {
  it("lets a stalled turn be picked back up", () => {
    // A harness whose frames were delayed by a reconnect should recover its own
    // turn rather than orphan it.
    const t = turn({ lastActivityAt: T0 });
    const at = T0 + TURN_STALE_AFTER_MS + 1_000;
    expect(turnLiveness(t, at)).toBe("stalled");
    const step = nextTurnState(t, { type: "partial", at });
    expect(step).toMatchObject({ ok: true });
    if (!step.ok) return;
    expect(turnIsLive(step.turn, at)).toBe(true);
    // And the anchor survives: the elapsed counter keeps counting from the
    // original start rather than resetting to "just started".
    expect(step.turn.startedAt).toBe(T0);
  });

  it("refuses to reanimate an abandoned turn", () => {
    const t = turn({ lastActivityAt: T0 });
    const at = T0 + TURN_ABANDON_AFTER_MS + 1;
    const step = nextTurnState(t, { type: "partial", at });
    expect(step).toMatchObject({ ok: false });
    if (step.ok) return;
    expect(step.reason).toMatch(/start a new turn/);
  });

  it("still accepts a terminal event on an abandoned turn", () => {
    // A late "it failed" is information. An abandoned record that never says
    // how it ended is not.
    const t = turn({ lastActivityAt: T0 });
    const step = nextTurnState(t, {
      type: "fail",
      at: T0 + TURN_ABANDON_AFTER_MS + 60_000,
      error: "harness died",
    });
    expect(step).toMatchObject({ ok: true });
    if (!step.ok) return;
    expect(step.turn.state).toBe("failed");
    expect(step.turn.error).toBe("harness died");
  });

  it("refuses more work past the wall-clock cap but records the end", () => {
    const t = turn({ startedAt: T0, lastActivityAt: T0 + MAX_TURN_DURATION_MS });
    const at = T0 + MAX_TURN_DURATION_MS + 1;
    expect(nextTurnState(t, { type: "partial", at }).ok).toBe(false);
    expect(nextTurnState(t, { type: "cancel", at, byActorId: "user_alice" }).ok).toBe(true);
  });

  it("records who cancelled, because that is the fact a person created", () => {
    const step = nextTurnState(turn(), { type: "cancel", at: T0 + 1, byActorId: "user_alice" });
    expect(step).toMatchObject({ ok: true });
    if (!step.ok) return;
    expect(step.turn.state).toBe("cancelled");
    expect(step.turn.cancelledByActorId).toBe("user_alice");
    // Not folded into "finished": the turn produced whatever it produced and a
    // person stopped it, and that is not the same event.
    expect(step.turn.state).not.toBe("finished");
  });
});

// ---------------------------------------------------------------------------
// The working signal
// ---------------------------------------------------------------------------

describe("the working signal", () => {
  it("shows only turns that are actually live", () => {
    const live = turn({ turnId: "a", agentId: "agent-1", lastActivityAt: T0 });
    const stale = turn({
      turnId: "b",
      agentId: "agent-2",
      lastActivityAt: T0 - TURN_ABANDON_AFTER_MS,
      startedAt: T0 - TURN_ABANDON_AFTER_MS,
    });
    const done = turn({ turnId: "c", agentId: "agent-3", state: "finished", endedAt: T0 });
    const signal = workingAgents([live, stale, done], T0);
    expect(signal.map((entry) => entry.agentId)).toEqual(["agent-1"]);
  });

  it("collapses one agent's concurrent turns to the earliest start", () => {
    // The elapsed counter answers "how long has this been going on", so the
    // anchor is the oldest live turn — not the newest, which would reset the
    // number every time the agent started another one.
    const older = turn({ turnId: "a", startedAt: T0 - 30_000, lastActivityAt: T0 });
    const newer = turn({ turnId: "b", startedAt: T0 - 5_000, lastActivityAt: T0 });
    const signal = workingAgents([newer, older], T0);
    expect(signal).toHaveLength(1);
    expect(signal[0].anchorAt).toBe(T0 - 30_000);
    expect(signal[0].turnId).toBe("a");
  });

  it("keeps one entry per agent per room", () => {
    const here = turn({ turnId: "a", channelId: "room-1", lastActivityAt: T0 });
    const there = turn({ turnId: "b", channelId: "room-2", lastActivityAt: T0 });
    expect(workingAgents([here, there], T0)).toHaveLength(2);
  });

  it("orders stably, so a ticking clock does not reshuffle the list", () => {
    const one = turn({ turnId: "a", agentId: "agent-b", startedAt: T0 - 1, lastActivityAt: T0 });
    const two = turn({ turnId: "b", agentId: "agent-a", startedAt: T0, lastActivityAt: T0 });
    expect(workingAgents([one, two], T0).map((e) => e.agentId)).toEqual([
      "agent-a",
      "agent-b",
    ]);
    expect(workingAgents([two, one], T0).map((e) => e.agentId)).toEqual([
      "agent-a",
      "agent-b",
    ]);
  });

  it("is empty when the room is quiet, rather than absent", () => {
    expect(workingAgents([], T0)).toEqual([]);
  });
});
