// The turn contract, and the two formatting rules that hang off it.
//
// `src/lib/buzz/turn.ts` owns `ChatTurn`, the five states, the liveness ladder
// and `workingAgents` — it is the one place a turn's rules live, so that a turn
// cannot be live in the sidebar and finished in the database. This module
// re-exports it rather than importing it in six places, so there is exactly one
// line in this directory that knows where the contract lives.
//
// What is added here is display, not truth: how long a turn has been going, in
// words. It sits beside the re-export because every surface that draws an
// elapsed counter is a surface that already imports the turn.

export {
  isTerminalTurnState,
  turnIsLive,
  turnLiveness,
  workingAgents,
  MAX_TURN_DURATION_MS,
  TERMINAL_TURN_STATES,
  TURN_ABANDON_AFTER_MS,
  TURN_LIVENESS_INTERVAL_MS,
  TURN_STALE_AFTER_MS,
} from "@/lib/buzz/turn";
export type {
  ChatTurn,
  TurnEvent,
  TurnLiveness,
  TurnState,
  TurnTransition,
  WorkingAgent,
} from "@/lib/buzz/turn";

import type { ChatTurn } from "@/lib/buzz/turn";

/**
 * How long a turn has been running, in ms, clamped at zero.
 *
 * Anchored on `startedAt` and not on when this tab first saw the turn, so a
 * room opened mid-turn shows how long the agent has actually been working
 * rather than restarting the clock at nought for every new reader.
 */
export function turnElapsedMs(turn: ChatTurn, now: number): number {
  const started = Number.isFinite(turn.startedAt) ? turn.startedAt : now;
  return Math.max(0, now - started);
}

/**
 * `12s`, `4m 20s`, `1h 06m`.
 *
 * Seconds are shown for the first minute because that is the window in which a
 * person is deciding whether to wait, and "0m" tells them nothing. Past an hour
 * the seconds are dropped: nobody is waiting, and a digit changing every second
 * in the corner of a room is a distraction with no information in it.
 */
export function formatTurnElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
