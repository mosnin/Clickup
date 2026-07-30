// What a panel remembers.
//
// A dashboard is pull. You look at it, it shows you a number, and it has no
// idea it ever showed you anything before — so the one question people
// actually arrive with, *what changed since I last looked*, is the one it
// cannot answer. Every product in this category works this way, and the
// workaround is always the same: a separate notifications inbox, disconnected
// from the panel that would have explained it.
//
// The fix is not a notification system. It is memory. A panel that stores the
// last value it showed *you* can answer the question itself, in place, without
// a second surface to check — "14 open, up 4 since Tuesday" is the sentence a
// dashboard was always supposed to say.
//
// Two faculties, both pure functions over a number the panel already fetched:
//
//   1. **The delta.** Compared against what this reader last saw, not against
//      an arbitrary window. "Since you last looked" is personal by
//      construction, which is exactly why it has to be stored per person and
//      why it cannot be computed from the data alone.
//   2. **The watch.** An optional condition the panel evaluates against
//      itself. When it trips, the panel says so where the panel is — not in an
//      inbox somewhere else that you have to correlate back.
//
// Neither needs a cron, a background job, or a second query. The panel has the
// number; the reader has a memory of the last one. Everything below is
// arithmetic on those two, which is what keeps it testable and instant.

/** How a watch compares the current reading to its threshold. */
export type WatchOp =
  | "above"
  | "below"
  | "equals"
  /** Any movement at all since you last looked. */
  | "changes"
  /** Moved up since you last looked. */
  | "rises"
  /** Moved down since you last looked. */
  | "falls";

export type Watch = {
  op: WatchOp;
  /** Ignored by the movement operators, which compare against memory. */
  threshold: number;
  /**
   * How loudly a tripped watch announces itself.
   *
   * A dashboard where everything is urgent is a dashboard where nothing is.
   * "note" changes a number's weight; "alert" is allowed to interrupt.
   */
  tone: "note" | "alert";
};

export const DEFAULT_WATCH: Watch = { op: "above", threshold: 0, tone: "note" };

const OPS: WatchOp[] = ["above", "below", "equals", "changes", "rises", "falls"];
const TONES: Watch["tone"][] = ["note", "alert"];

/** Operators that compare against memory rather than against a threshold. */
const MOVEMENT_OPS: WatchOp[] = ["changes", "rises", "falls"];

export function isMovementOp(op: WatchOp): boolean {
  return MOVEMENT_OPS.includes(op);
}

export const WATCH_VOCABULARY = { ops: OPS, tones: TONES } as const;

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Coerce anything into a runnable watch, or null for "no watch".
 *
 * Null rather than a default watch, because "watching nothing" is the normal
 * state and a default-constructed watch would quietly start announcing things
 * on every panel that had never asked for one.
 */
export function normalizeWatch(input: unknown): Watch | null {
  // `typeof [] === "object"`, so the array check is not pedantry: without it a
  // stored `[]` becomes a default watch, and a panel that never asked for one
  // starts announcing itself.
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Partial<Watch>;
  const op = pick(raw.op, OPS, DEFAULT_WATCH.op);
  const threshold =
    typeof raw.threshold === "number" && Number.isFinite(raw.threshold)
      ? // Bounded: a threshold beyond any plausible reading is a watch that can
        // never trip, which is indistinguishable from no watch and much harder
        // to notice.
        Math.max(-1e9, Math.min(1e9, raw.threshold))
      : DEFAULT_WATCH.threshold;
  return { op, threshold, tone: pick(raw.tone, TONES, DEFAULT_WATCH.tone) };
}

/** What a panel remembers about the last time this person looked at it. */
export type Memory = {
  /** The value it showed. */
  value: number;
  /** When it showed it. */
  seenAt: number;
};

export type PanelState = {
  /** The reading now. */
  value: number;
  /** Movement since this reader last looked, or null if they never have. */
  delta: number | null;
  /** When they last looked, or null. */
  since: number | null;
  /** Whether the watch (if any) is currently tripped. */
  tripped: boolean;
  tone: Watch["tone"] | null;
  /** One sentence, in plain words. Empty when there is nothing to say. */
  message: string;
};

/**
 * Read a panel's current state against what it remembers.
 *
 * Deliberately total and side-effect free: the same inputs always describe the
 * same state, which is what lets it be rendered during a paint and tested
 * without a database.
 */
export function readPanelState(input: {
  value: number;
  memory: Memory | null;
  watch: Watch | null;
  /** Below this, "since you last looked" means "a moment ago" — say nothing. */
  staleAfterMs?: number;
  now?: number;
}): PanelState {
  const value = Number.isFinite(input.value) ? input.value : 0;
  const memory = input.memory;
  const watch = input.watch;
  const now = input.now ?? Date.now();
  // Default: a gap of under a minute is the same visit. Announcing a delta
  // against a number you saw thirty seconds ago is noise, and worse, it makes
  // the panel look like it is changing when you are the one who moved.
  const staleAfter = input.staleAfterMs ?? 60_000;

  const fresh = memory !== null && now - memory.seenAt >= staleAfter;
  const delta = fresh ? value - memory.value : null;
  const since = fresh ? memory.seenAt : null;

  let tripped = false;
  if (watch) {
    switch (watch.op) {
      case "above":
        tripped = value > watch.threshold;
        break;
      case "below":
        tripped = value < watch.threshold;
        break;
      case "equals":
        tripped = value === watch.threshold;
        break;
      // Movement operators need a memory to compare against. Without one the
      // honest answer is "not yet" — a watch that fires on first sight has not
      // observed a change, it has observed an arrival.
      case "changes":
        tripped = delta !== null && delta !== 0;
        break;
      case "rises":
        tripped = delta !== null && delta > 0;
        break;
      case "falls":
        tripped = delta !== null && delta < 0;
        break;
    }
  }

  return {
    value,
    delta,
    since,
    tripped,
    tone: tripped && watch ? watch.tone : null,
    message: describeState({ value, delta, since, tripped, watch, now }),
  };
}

/**
 * The sentence a panel says about itself.
 *
 * Kept short on purpose: this sits under a number in a panel a person is
 * glancing at. A paragraph explaining a delta is a paragraph nobody reads.
 */
function describeState(input: {
  value: number;
  delta: number | null;
  since: number | null;
  tripped: boolean;
  watch: Watch | null;
  now: number;
}): string {
  const parts: string[] = [];

  if (input.delta !== null && input.delta !== 0 && input.since !== null) {
    const direction = input.delta > 0 ? "up" : "down";
    parts.push(`${direction} ${Math.abs(input.delta)} since ${ago(input.since, input.now)}`);
  }

  if (input.tripped && input.watch && !isMovementOp(input.watch.op)) {
    // Movement watches are already described by the delta clause; repeating
    // "up 4 since Tuesday, and it went up" is the panel talking to itself.
    parts.push(describeWatch(input.watch));
  }

  return parts.join(" · ");
}

/** A watch in words, for a control label and for a tripped panel. */
export function describeWatch(watch: Watch): string {
  switch (watch.op) {
    case "above":
      return `over ${watch.threshold}`;
    case "below":
      return `under ${watch.threshold}`;
    case "equals":
      return `exactly ${watch.threshold}`;
    case "changes":
      return "changed";
    case "rises":
      return "went up";
    case "falls":
      return "went down";
  }
}

/** How a watch reads when you are setting it, rather than when it trips. */
export function describeWatchIntent(watch: Watch): string {
  switch (watch.op) {
    case "above":
      return `Tell me when it goes over ${watch.threshold}`;
    case "below":
      return `Tell me when it drops under ${watch.threshold}`;
    case "equals":
      return `Tell me when it hits ${watch.threshold}`;
    case "changes":
      return "Tell me whenever it moves";
    case "rises":
      return "Tell me when it goes up";
    case "falls":
      return "Tell me when it goes down";
  }
}

/**
 * A coarse "when", for a sentence rather than a timestamp.
 *
 * Deliberately not `timeAgo` from lib/time: this reads inside a clause ("up 4
 * since ...") where "3 hours ago" would produce "since 3 hours ago". The
 * grammar is different, so the function is different.
 */
function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 3600) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
  }
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  return weeks === 1 ? "last week" : `${weeks} weeks ago`;
}

/**
 * Should the panel write a new memory?
 *
 * Not on every render — that would overwrite the very thing the delta is
 * measured against, and the panel would forever report "no change". A memory
 * is written when the reader has genuinely had a chance to see the current
 * value: they have been looking at it for a moment, and it differs from what
 * is stored.
 */
export function shouldRemember(input: {
  value: number;
  memory: Memory | null;
  now?: number;
  /** How long the panel must have been on screen. */
  dwellMs?: number;
  /** When this render started. */
  shownAt: number;
}): boolean {
  const now = input.now ?? Date.now();
  const dwell = input.dwellMs ?? 4_000;
  if (now - input.shownAt < dwell) return false;
  if (!input.memory) return true;
  return input.memory.value !== input.value;
}
