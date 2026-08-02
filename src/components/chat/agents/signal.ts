// The working signal: one answer to "is a machine doing something right now".
//
// Buzz's rule, kept exactly (02-agents §5.5): **every** surface that shows a
// working affordance reads from one module rather than picking a pipe of its
// own. Otherwise the sidebar badge, the composer line and the member row
// disagree about the same agent within a week, and each is right about a
// different pipe.
//
// The derivation itself is `workingAgents` in `src/lib/buzz/turn.ts` — the same
// function `convex/buzz/agents.ts:working` runs on the server. This file is
// what the *client* has to add on top of it, which is one thing and it is not
// obvious: **a clock.**
//
// A Convex query re-runs when data changes, not when time passes. A turn goes
// stale because nobody has heard from it, which is precisely the case where no
// data changes — so a server-computed `working` boolean freezes at the exact
// moment it stops being true. The client must re-derive against its own ticking
// clock, and to do that honestly it has to know how far its own clock is from
// the one the anchors were measured on.
//
// Pure, and taking `now` as an argument rather than reading a clock: the whole
// value of this module is the decay rule, and a rule you can only exercise by
// waiting twenty-five seconds is a rule nobody tests.

import { turnLiveness, workingAgents, type ChatTurn, type WorkingAgent } from "@/lib/buzz/turn";

export type { WorkingAgent };

// ---------------------------------------------------------------------------
// Clock skew
// ---------------------------------------------------------------------------

/**
 * How far this browser's clock is ahead of the server's, in ms.
 *
 * `null` until a sample arrives, which is not the same as zero: before the
 * first `working` result we have no reason to believe our clock and no reason
 * to correct it either, and pretending to a correction of zero would make an
 * offset appearing later look like every turn jumping.
 */
export type ClockOffset = { ms: number } | null;

/**
 * Fold a `(serverNow, clientNow)` sample into the running estimate.
 *
 * The **minimum**, exactly as Buzz's `sampleClockOffset` does (§5.4), and the
 * reason is worth stating because "average" is the instinct and is wrong: every
 * sample is inflated by however long the answer spent on the wire, so the
 * smallest difference ever seen is the one with the least network in it. The
 * minimum therefore converges downwards on true skew and is immune to a single
 * slow round trip — which an average is not, and which matters because one slow
 * sample would push every elapsed counter in the room forward by its own
 * latency.
 *
 * Under *growing* skew the estimate goes stale-too-small and elapsed
 * over-reports, bounded by how far the skew grows in a session. That trade is
 * deliberate: over-reporting elapsed time is a cosmetic error, while
 * under-reporting silence would keep a dead turn on screen.
 */
export function foldClockOffset(
  current: ClockOffset,
  sample: { serverNow: number; clientNow: number },
): ClockOffset {
  if (!Number.isFinite(sample.serverNow) || !Number.isFinite(sample.clientNow)) {
    return current;
  }
  const offset = sample.clientNow - sample.serverNow;
  if (current === null) return { ms: offset };
  return offset < current.ms ? { ms: offset } : current;
}

/** This browser's clock, expressed on the server's. */
export function serverTime(clientNow: number, offset: ClockOffset): number {
  return offset === null ? clientNow : clientNow - offset.ms;
}

// ---------------------------------------------------------------------------
// The signal
// ---------------------------------------------------------------------------

/**
 * The room's working agents, re-derived against a corrected clock.
 *
 * A thin wrapper on purpose. The interesting part is that it exists at all —
 * the server answered this question already, and answering it again on the
 * client is what makes the answer decay. Everything about *which* agents and
 * *what* anchor is `workingAgents`, so the two readings cannot disagree.
 */
export function deriveWorking(
  turns: readonly ChatTurn[] | undefined,
  now: number,
): WorkingAgent[] {
  return workingAgents(turns ?? [], now);
}

/**
 * The sentence.
 *
 * Shaped like `typingLabel` in `src/lib/buzz/presence.ts` on purpose — the two
 * lines sit in the same band, and two grammars for "who is doing something" two
 * pixels apart reads as two products. Names are not elided below three for the
 * reason it gives: "2 agents are working" is strictly less information than
 * either name, and which agent is working is the entire question.
 */
export function workingLabel(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is working`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are working`;
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]} are working`;
  return `${names[0]}, ${names[1]}, and ${names.length - 2} others are working`;
}

/**
 * How long until something on screen changes, or null if nothing will.
 *
 * The clock is only allowed to run while something depends on it. A room whose
 * agents are all idle must not re-render once a second for the rest of the
 * afternoon; a room holding a turn must, because the next thing that happens
 * may be that the turn stops being true.
 */
export function workingTickMs(turns: readonly ChatTurn[] | undefined): number | null {
  return (turns ?? []).length > 0 ? 1000 : null;
}

// ---------------------------------------------------------------------------
// D9 — the honest silence
// ---------------------------------------------------------------------------

/**
 * What a room can truthfully say about one of its agents.
 *
 * Four states, and the last one is the one this product accepted a cost to
 * have. D9: a turn runs on the agent's own runtime, so a **newly created agent
 * does nothing at all** until somebody runs a harness for it. That silence is
 * the honest state and it is indistinguishable, from the outside, from a broken
 * product — which is exactly why it must be named rather than left as an
 * absence.
 *
 * The three quiet states are deliberately not one "offline":
 *
 *   `stalled`         — a turn was running and stopped reporting. Something is
 *                       wrong right now, and saying nothing would look like the
 *                       agent silently gave up.
 *   `idle`            — connected, nothing to do. The healthy resting state.
 *   `never-connected` — nothing has ever run this agent. A setup step that has
 *                       not happened, not an outage, and the only one of the
 *                       three that comes with an instruction.
 */
export type AgentReading = "working" | "stalled" | "idle" | "never-connected";

export function readAgentState(input: {
  /** This agent's live turns in this room, if any. */
  turns?: readonly ChatTurn[];
  /** The agent's own last heartbeat. Absent = no runtime has ever connected. */
  lastSeenAt?: number | null;
  now: number;
}): AgentReading {
  let stalled = false;
  for (const turn of input.turns ?? []) {
    const liveness = turnLiveness(turn, input.now);
    if (liveness === "working") return "working";
    if (liveness === "stalled") stalled = true;
  }
  if (stalled) return "stalled";
  // A turn on the record proves a runtime once connected, whatever the agent
  // row says — checked after the live readings so a stale turn cannot suppress
  // a fresh one.
  if (input.lastSeenAt || (input.turns ?? []).length > 0) return "idle";
  return "never-connected";
}
