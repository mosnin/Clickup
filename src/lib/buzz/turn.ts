// A turn: what an agent is doing in a room, right now.
//
// Nothing in this file runs a turn. Per 00-decisions.md D9 the turn itself runs
// on the agent's own runtime — a mention pings `notifyUrl`, the harness answers
// over MCP, and the server never holds a model connection. What the server owns
// is the *record*: started, streaming, finished, cancelled, failed, and the
// working signal a room draws off it.
//
// The record is the only thing that can be wrong in a way people notice, and it
// is wrong in exactly one way: **a turn that never ends.** A harness that
// crashes mid-turn, a laptop that closes, a process killed by an OOM — none of
// them get to send a completion, and every one of them leaves a spinner in
// somebody's sidebar forever. So the central rule here is that liveness is
// **derived from the clock at read time, never stored**: a turn does not become
// stale because something remembered to mark it stale, it becomes stale because
// nobody has heard from it lately. There is no sweeper to forget to run, no
// cron whose failure looks like an agent working very hard for three days.
//
// That is Buzz's own model (02-agents.md §5.4: "anchors are derived at read
// time, not stored") and it is what the constants below are: its
// `activeAgentTurnsStore` numbers, with its reasons, on our substrate.
//
// Pure on purpose. `convex/buzz/agents.ts` runs every transition through
// `nextTurnState` before it writes a row, and the client runs `turnIsLive` on
// every animation frame it likes — one set of rules, tested once, so a turn
// cannot be live in the sidebar and finished in the database.

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/**
 * How often a working harness is expected to say it is still there.
 *
 * Buzz's `LIVENESS_INTERVAL_MS` / `BUZZ_ACP_TURN_LIVENESS_SECS`. Everything
 * below is a multiple of it, which is the point: one number to retune, and the
 * relationships between the others survive the retune.
 */
export const TURN_LIVENESS_INTERVAL_MS = 10_000;

/**
 * Silence longer than this and the turn stops reading as live (interval × 2.5).
 *
 * Two and a half beats rather than one: a single missed heartbeat is a slow
 * network, and a working badge that flickers off and back on every time a
 * packet is late is worse than no badge — people stop believing it. Two and a
 * half is late enough to be a real absence and short enough that a crashed
 * harness clears in the time it takes to notice it stopped talking.
 */
export const TURN_STALE_AFTER_MS = 2.5 * TURN_LIVENESS_INTERVAL_MS;

/**
 * Silence longer than this and the turn cannot come back at all (3 minutes).
 *
 * Buzz's `PRUNE_PAUSE_MAX_MS`, and it exists because "stale" is deliberately
 * recoverable: a harness whose frames were delayed by a reconnect should be
 * able to pick its own turn back up rather than orphan it (§5.4, resurrection).
 * But recovery has to be bounded, or a frame that arrives from a process
 * resumed after lunch resurrects a turn everybody has stopped caring about and
 * the room draws work that is not happening. Past this line the harness has to
 * start a new turn, which costs it nothing and tells the truth.
 */
export const TURN_ABANDON_AFTER_MS = 180_000;

/**
 * The absolute wall-clock cap on one turn (2 hours).
 *
 * Buzz's `BUZZ_ACP_MAX_TURN_DURATION` default, and it is a safety valve rather
 * than a timeout: a harness that keeps heartbeating forever is indistinguishable
 * from one doing genuine long work, and the only honest way to tell them apart
 * is to stop believing either after long enough. A turn past this is refused
 * more work and reads as abandoned, whatever its heartbeat says.
 */
export const MAX_TURN_DURATION_MS = 7_200_000;

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

/**
 * The five states, and there are deliberately not six.
 *
 * `started` and `streaming` are both "working" and the room draws them
 * identically — they are separate because they answer different questions for
 * the person reading the record afterwards ("did it ever say anything, or did
 * it die before the first token"), and because the transition between them is
 * the cheapest possible proof that the harness is alive and producing rather
 * than merely alive.
 *
 * `cancelled` is not a flavour of `finished`. A cancelled turn produced
 * whatever it produced and was stopped by a person; folding it into `finished`
 * would lose the one fact a human went out of their way to create. And it is
 * not a flavour of `failed` either — nothing went wrong.
 *
 * There is no `stale` state, and that absence is the design: staleness is a
 * function of the clock (see `turnLiveness`), so it cannot be stored, cannot go
 * out of date, and cannot need a cron to maintain.
 */
export type TurnState = "started" | "streaming" | "finished" | "cancelled" | "failed";

/** The three states nothing can leave. */
export const TERMINAL_TURN_STATES: ReadonlySet<TurnState> = new Set<TurnState>([
  "finished",
  "cancelled",
  "failed",
]);

export function isTerminalTurnState(state: TurnState): boolean {
  return TERMINAL_TURN_STATES.has(state);
}

/**
 * One agent's one turn in one room.
 *
 * `agentPubkey` is carried rather than looked up because it is the answer to
 * "who signed the events this turn produced", and that question must be
 * answerable from the record alone — an agent whose key was rotated afterwards
 * still signed the old turn with the old key (02-agents.md §10.3: scoping is by
 * identity, not by a flag).
 *
 * `narration` is one line, replaced, never appended to. A turn record is not a
 * transcript: the transcript is the room, where the agent's actual messages
 * are, and a second growing text field beside it is a second place for the
 * story to be told differently.
 */
export type ChatTurn = {
  turnId: string;
  channelId: string;
  /** The `agents` document id — the same actor-id shape a member row carries. */
  agentId: string;
  /** The key the agent's own events are signed with. */
  agentPubkey: string;
  agentName?: string;
  state: TurnState;
  /** Milliseconds. The anchor an elapsed timer counts from. */
  startedAt: number;
  /** Milliseconds. The last time this turn proved it was alive. */
  lastActivityAt: number;
  endedAt?: number;
  /** The agent's current sentence — one line, replaced. */
  narration?: string;
  /** Why a `failed` turn failed. */
  error?: string;
  /** Who stopped a `cancelled` turn: a Clerk subject. */
  cancelledByActorId?: string;
  /** The message that triggered the turn, if it had one. */
  triggerEventId?: string;
};

// ---------------------------------------------------------------------------
// Liveness — derived, never stored
// ---------------------------------------------------------------------------

/**
 * What a turn is, right now, to somebody looking at it.
 *
 * Four answers, and the middle two are the reason this function exists at all:
 * a turn that stopped reporting is not the same thing as a turn that ended, and
 * it is not the same thing as a turn nobody should wait for any more. Collapsing
 * them into a boolean is how a crashed harness becomes either a permanent
 * spinner (if you call it live) or a silently vanished agent (if you call it
 * ended) — and both of those are the bug this file exists to prevent.
 *
 *   working    — heard from within the last 2.5 beats. Draw the signal.
 *   stalled    — silent, but recently enough that it may still come back.
 *                Draw *something*: "stopped responding", not nothing.
 *   abandoned  — silent past the recovery window, or past the 2-hour cap.
 *                Stop drawing it; it is never coming back.
 *   ended      — a terminal state. It said how it went.
 */
export type TurnLiveness = "working" | "stalled" | "abandoned" | "ended";

export function turnLiveness(turn: ChatTurn, now: number): TurnLiveness {
  if (isTerminalTurnState(turn.state)) return "ended";
  // The wall-clock cap outranks the heartbeat on purpose: a wedged harness that
  // pings forever is exactly the case the cap was added for, so a fresh
  // heartbeat must not be able to talk its way past it.
  if (now - turn.startedAt >= MAX_TURN_DURATION_MS) return "abandoned";
  const silence = now - turn.lastActivityAt;
  if (silence < TURN_STALE_AFTER_MS) return "working";
  if (silence < TURN_ABANDON_AFTER_MS) return "stalled";
  return "abandoned";
}

/**
 * Is this turn something the room should draw a working signal for?
 *
 * Deliberately the narrow reading — `working` only. A stalled turn still has a
 * story to tell and `turnLiveness` tells it, but a working *signal* is a claim
 * that something is happening now, and a claim nobody has evidence for is the
 * thing that makes every other signal in the product untrustworthy.
 *
 * `now` is a parameter rather than `Date.now()` so that the client can anchor
 * it to its own ticking clock, the server can anchor it to the transaction's,
 * and a test can anchor it to whatever it likes. A pure function that reads the
 * clock itself is a pure function you cannot test at the boundary, which is the
 * only place these numbers are interesting.
 */
export function turnIsLive(turn: ChatTurn, now: number): boolean {
  return turnLiveness(turn, now) === "working";
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * The things that happen to a turn.
 *
 * `at` is on every one of them rather than read from a clock inside, for the
 * same reason `turnIsLive` takes `now`: the caller knows when the thing
 * happened and this file does not.
 */
export type TurnEvent =
  /** The harness picked the turn back up (a restart, or the first report). */
  | { type: "start"; at: number }
  /** Streaming output, or a bare liveness beat. */
  | { type: "partial"; at: number; narration?: string }
  | { type: "finish"; at: number; narration?: string }
  | { type: "fail"; at: number; error: string }
  | { type: "cancel"; at: number; byActorId?: string };

/**
 * A refusal is a value, not an exception.
 *
 * The caller is a Convex mutation that has to decide between "tell the agent it
 * cannot do that" and "quietly do nothing" — a late completion for a turn a
 * human already cancelled is the second, and a throw would force it to be the
 * first. Returning the reason lets one function serve both without this file
 * knowing which is which.
 */
export type TurnTransition =
  | { ok: true; turn: ChatTurn }
  | { ok: false; reason: string };

/**
 * The one place a turn changes state.
 *
 * Four rules, each of which is a bug that has actually happened in systems
 * shaped like this one:
 *
 * 1. **A terminal turn is terminal.** A completion is authoritative and outlives
 *    everything (§5.4); a liveness frame already on the wire when a turn was
 *    cancelled must not resurrect it, and a second `finish` must not overwrite
 *    the first one's account of how it went.
 *
 * 2. **A turn never goes backwards.** `streaming` does not return to `started`.
 *    The states are not a set of labels, they are an ordering, and a UI that
 *    reads "started" after it read "streaming" has been lied to about what it
 *    already saw.
 *
 * 3. **A stale frame does not rewind the clock.** A `partial` older than what
 *    the record already holds is a delayed packet, not new life; accepting it
 *    would move `lastActivityAt` backwards and make a live turn look stale.
 *    Terminal events are exempt and clamp instead — a completion always lands,
 *    however out of order it arrived.
 *
 * 4. **Resurrection is bounded.** Past `TURN_ABANDON_AFTER_MS` of silence, or
 *    past the 2-hour cap, a `partial` is refused: the harness must open a new
 *    turn rather than reanimate one the room has stopped believing in. Terminal
 *    events are still accepted, because a late "it failed" is information and
 *    an abandoned record that says nothing is not.
 */
export function nextTurnState(turn: ChatTurn, event: TurnEvent): TurnTransition {
  const terminal = isTerminalTurnState(turn.state);
  const isTerminalEvent =
    event.type === "finish" || event.type === "fail" || event.type === "cancel";

  // 1. Terminal is terminal.
  if (terminal) {
    return {
      ok: false,
      reason: `This turn already ${turn.state === "failed" ? "failed" : turn.state}.`,
    };
  }

  if (!isTerminalEvent) {
    // 4. Bounded resurrection — a dead turn is not restarted, it is replaced.
    const liveness = turnLiveness(turn, event.at);
    if (liveness === "abandoned") {
      return {
        ok: false,
        reason:
          "This turn has been silent too long to continue; start a new turn instead.",
      };
    }
    // 3. A frame older than the record is a delayed packet.
    if (event.at < turn.lastActivityAt) {
      return { ok: false, reason: "That frame is older than this turn's last activity." };
    }
  }

  switch (event.type) {
    case "start":
      // 2. Idempotent restart, and never backwards: a harness re-announcing a
      // turn it is already streaming refreshes the clock and keeps `streaming`.
      return {
        ok: true,
        turn: { ...turn, lastActivityAt: event.at },
      };

    case "partial":
      return {
        ok: true,
        turn: {
          ...turn,
          state: "streaming",
          lastActivityAt: event.at,
          ...(event.narration !== undefined ? { narration: event.narration } : {}),
        },
      };

    case "finish":
      return {
        ok: true,
        turn: {
          ...turn,
          state: "finished",
          ...endedClock(turn, event.at),
          ...(event.narration !== undefined ? { narration: event.narration } : {}),
        },
      };

    case "fail":
      return {
        ok: true,
        turn: {
          ...turn,
          state: "failed",
          ...endedClock(turn, event.at),
          error: event.error,
        },
      };

    case "cancel":
      return {
        ok: true,
        turn: {
          ...turn,
          state: "cancelled",
          ...endedClock(turn, event.at),
          ...(event.byActorId !== undefined ? { cancelledByActorId: event.byActorId } : {}),
        },
      };
  }
}

/**
 * When a turn ended, and when it was last heard from.
 *
 * Clamped forward rather than taken verbatim because a terminal event is always
 * accepted (rule 3) and may therefore carry a timestamp behind the record. A
 * turn that ended before its own last activity is a record that cannot be
 * drawn: the elapsed time is negative and every duration computed from it is
 * nonsense.
 */
function endedClock(turn: ChatTurn, at: number): { lastActivityAt: number; endedAt: number } {
  const ended = Math.max(at, turn.lastActivityAt);
  return { lastActivityAt: ended, endedAt: ended };
}

// ---------------------------------------------------------------------------
// The working signal (§5.5)
// ---------------------------------------------------------------------------

/**
 * One agent, working, somewhere a reader can see.
 *
 * `anchorAt` is the *start* of the earliest live turn, not the latest activity:
 * an elapsed counter is supposed to say how long this has been going on, and
 * anchoring it to the last heartbeat would reset it to zero every ten seconds —
 * the single most common way this display is got wrong.
 */
export type WorkingAgent = {
  agentId: string;
  agentPubkey: string;
  agentName?: string;
  channelId: string;
  turnId: string;
  anchorAt: number;
  narration?: string;
};

/**
 * The room's working signal, from its turns.
 *
 * One entry per agent per channel — Buzz collapses an agent's concurrent turns
 * in one room to the **earliest** start (§5.4, `getActiveTurnsForAgent`), and so
 * does this: a person watching a room wants to know that Scout is working and
 * for how long, not that Scout holds three turn ids.
 *
 * Sorted by `(channelId, agentId)` and not by time, because the order must be
 * stable while the signal is unchanged — a list that reorders itself as
 * timestamps tick is a list that re-renders forever and cannot be read.
 */
export function workingAgents(turns: readonly ChatTurn[], now: number): WorkingAgent[] {
  const byAgent = new Map<string, WorkingAgent>();
  for (const turn of turns) {
    if (!turnIsLive(turn, now)) continue;
    const key = `${turn.channelId}/${turn.agentId}`;
    const existing = byAgent.get(key);
    if (existing && existing.anchorAt <= turn.startedAt) continue;
    byAgent.set(key, {
      agentId: turn.agentId,
      agentPubkey: turn.agentPubkey,
      ...(turn.agentName !== undefined ? { agentName: turn.agentName } : {}),
      channelId: turn.channelId,
      turnId: turn.turnId,
      anchorAt: turn.startedAt,
      ...(turn.narration !== undefined ? { narration: turn.narration } : {}),
    });
  }
  return [...byAgent.values()].sort(
    (left, right) =>
      left.channelId.localeCompare(right.channelId) ||
      left.agentId.localeCompare(right.agentId),
  );
}
