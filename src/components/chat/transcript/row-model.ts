// What the transcript knows about a row before it has drawn one.
//
// Everything here is pure and none of it needs a DOM, which is the point: the
// virtualizer has to answer "how tall is row 400" for rows it has never
// mounted, the pager has to answer "is there enough on screen" before a page
// arrives, and the surface has to answer "skeleton or empty" before the first
// paint. Three questions, all asked about rows rather than about pixels.
//
// What is deliberately NOT here: anything about which rows a surface shows.
// `projectTimeline` already answers that — it folds events to messages, keeps
// the top-level ones and emits the dividers between them — and a second filter
// here would be a second opinion about what a channel contains. This file
// starts from the rows it is handed.

import type { ChatRow } from "@/lib/buzz/message-types";
// Re-exported below so a call site reads one import; the constant itself is
// pinned against the Convex kind registry by the projector's own tests.
import { KIND_HUDDLE_STARTED } from "@/lib/buzz/timeline";

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * A stable, namespaced key for a row.
 *
 * Namespaced because the three families genuinely can collide: a day divider
 * keyed by a raw timestamp and a message keyed by an event id are both strings
 * in the same measurement map, and a virtualizer that mixes them up reuses a
 * measurement taken from a different kind of row.
 */
export function rowKey(row: ChatRow): string {
  switch (row.type) {
    case "message":
      // `renderKey`, not `id`: it survives the optimistic → acknowledged
      // transition, and keying on `id` remounts the row the instant it lands,
      // which the reader sees as the message they just sent flickering.
      return `msg:${row.message.renderKey}`;
    case "day":
      // `at` is already start-of-local-day (the projector keys it that way, so
      // prepending an older message into a rendered day reuses the row rather
      // than remounting the section).
      return `day:${row.at}`;
    case "unread":
      return "unread";
    case "system":
      return `sys:${row.id}`;
    case "system-group":
      // A different namespace from `sys:`, even though the projector anchors a
      // group on its newest member and could hand back that member's id: a
      // folded row and the single row it might collapse from are different
      // heights, and sharing a key hands one a measurement taken from the other.
      return `sysgroup:${row.id}`;
  }
}

/** The event id a row can be jumped to by, if it has one. */
export function rowMessageId(row: ChatRow): string | null {
  return row.type === "message" ? row.message.id : null;
}

/** Find the row key holding a message id — what jump-to-message scrolls to. */
export function keyForMessageId(
  rows: readonly ChatRow[],
  messageId: string,
): string | null {
  for (const row of rows) {
    if (row.type === "message" && row.message.id === messageId) return rowKey(row);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Height estimates (spec 01 §2.8, `rowHeightEstimate.ts`)
// ---------------------------------------------------------------------------

// Buzz's constants, kept verbatim so a row realises near its true height on
// first paint instead of teleporting when it is finally measured. They are
// deliberately crude — no DOM, no markdown parse — because an estimate that
// costs a layout is not an estimate.
export const TEXT_LINE_HEIGHT = 20;
export const CODE_LINE_HEIGHT = 19;
export const CHARS_PER_LINE = 64;
export const ROW_CHROME = 26;
export const CONTINUATION_ROW_CHROME = 8;
export const REACTION_ROW = 24;
export const MIN_ESTIMATE = 60;
export const CONTINUATION_MIN_ESTIMATE = 28;
export const DIVIDER_HEIGHT = 32;
export const SYSTEM_ROW_HEIGHT = 40;
/**
 * A folded run of system events, collapsed.
 *
 * Buzz's own constant, and taller than a single system row because the row
 * carries a facepile and a disclosure alongside its sentence. Expanded it is
 * taller still — which the estimate deliberately does not try to predict: the
 * expansion is a gesture the reader just made, so the row is mounted and
 * measured by the time its true height matters.
 */
export const SYSTEM_GROUP_HEIGHT = 80;

export function estimateRowHeight(row: ChatRow): number {
  if (row.type === "day" || row.type === "unread") return DIVIDER_HEIGHT;
  if (row.type === "system") return SYSTEM_ROW_HEIGHT;
  if (row.type === "system-group") return SYSTEM_GROUP_HEIGHT;

  const { message, grouped } = row;
  const body = message.body ?? "";
  // Fenced code counts at mono line-height; everything else wraps at a nominal
  // 64 characters. Both are wrong for any given row and right on average,
  // which is all an estimate has to be.
  let height = 0;
  let text = body;
  const fences = body.match(/```[\s\S]*?```/g);
  if (fences) {
    for (const block of fences) {
      height += block.split("\n").length * CODE_LINE_HEIGHT;
      text = text.replace(block, "");
    }
  }
  for (const line of text.split("\n")) {
    height += Math.max(1, Math.ceil(line.length / CHARS_PER_LINE)) * TEXT_LINE_HEIGHT;
  }
  height += grouped ? CONTINUATION_ROW_CHROME : ROW_CHROME;
  if (message.reactions.length > 0) height += REACTION_ROW;
  return Math.max(grouped ? CONTINUATION_MIN_ESTIMATE : MIN_ESTIMATE, height);
}

// ---------------------------------------------------------------------------
// Paging (spec 01 §2.8)
// ---------------------------------------------------------------------------

/** One server window per call. */
export const PAGE_SIZE = 50;

/**
 * How many *visible top-level rows* a cold load must produce before paging
 * stops.
 *
 * Counting rows rather than events is the whole trick, and it is not a nicety:
 * fifty events in a busy room can be forty-eight thread replies, reactions and
 * edits, and two rows. Paging on the event count declares the timeline full
 * while the reader is looking at two lines and a screen of white; paging on
 * rows keeps asking until there is something to read.
 */
export const TOP_LEVEL_ROW_FLOOR = 20;

/** Message rows in a projected list — dividers are rows but not content. */
export function countMessageRows(rows: readonly ChatRow[]): number {
  return rows.filter((row) => row.type === "message").length;
}

/**
 * Whether to ask for one more page.
 *
 * `hasMore` is read from the tail page's own answer every time, never latched.
 * A latch reset only on channel change goes stale on reconnect — the refreshed
 * newest window reports more history, the latch still says no, and paging is
 * frozen at page one until you switch rooms and back.
 */
export function needsAnotherPage(args: {
  visibleRowCount: number;
  hasMore: boolean;
  floor?: number;
}): boolean {
  if (!args.hasMore) return false;
  return args.visibleRowCount < (args.floor ?? TOP_LEVEL_ROW_FLOOR);
}

/**
 * `historyExhausted` — distinct from `!hasMore`, and only this may claim to
 * show a channel's beginning (it is what gates the oldest day divider). An
 * empty or not-yet-loaded window also reports "no more"; exhaustion needs a
 * page that actually resolved and said so.
 */
export function historyExhausted(args: {
  resolvedPages: number;
  hasMore: boolean;
}): boolean {
  return args.resolvedPages > 0 && !args.hasMore;
}

// ---------------------------------------------------------------------------
// Scroll deltas (spec 01 §2.8)
// ---------------------------------------------------------------------------

export type TimelineDelta = "prepend" | "append" | "replace" | "none";

/**
 * What just happened to the row list, decided from keys alone.
 *
 * The consumer that matters: a prepend must never pin the reader to the
 * bottom. Older history arriving while somebody reads upward and yanking them
 * to the newest message is the single most infuriating bug a transcript can
 * have, and it is what happens when "the list changed" is the only signal.
 */
export function classifyDelta(args: {
  current: readonly string[];
  previous: readonly string[];
}): TimelineDelta {
  const { current, previous } = args;
  if (previous.length === 0) return current.length === 0 ? "none" : "replace";
  if (current.length === previous.length) {
    return current[0] === previous[0] &&
      current[current.length - 1] === previous[previous.length - 1]
      ? "none"
      : "replace";
  }
  if (current.length > previous.length) {
    const delta = current.length - previous.length;
    // An exact *suffix* match means everything previously rendered is still
    // rendered, in order, with new rows in front of it.
    if (previous.every((key, i) => key === current[i + delta])) return "prepend";
    if (previous.every((key, i) => key === current[i])) return "append";
  }
  return "replace";
}

// ---------------------------------------------------------------------------
// The surface state machine (spec 01 §9.1)
// ---------------------------------------------------------------------------

export type TranscriptSurface = "skeleton" | "empty" | "list" | "error";

/**
 * Which of the four things the transcript is showing.
 *
 * The trap this guards: "we have data" is not "we have loaded". A Convex
 * subscription seeds early, and a room that has never had a message is
 * indistinguishable from a room whose first page has not landed — so the
 * skeleton is held for the whole cold load, and only a *resolved* first page
 * is allowed to say "no messages yet".
 */
export function selectTranscriptSurface(args: {
  rowCount: number;
  isLoading: boolean;
  error?: string | null;
  /** A channel intro is stable content; replacing it with a skeleton reads as a reload. */
  hasPersistentIntro?: boolean;
}): TranscriptSurface {
  if (args.error) return "error";
  if (args.isLoading) return args.hasPersistentIntro ? "empty" : "skeleton";
  return args.rowCount === 0 ? "empty" : "list";
}

/**
 * The loading latch: monotonic per channel.
 *
 * Once a channel has settled, a background refetch must never re-show the
 * skeleton — the rows are right there, and blanking them is a flash of nothing
 * in exchange for no information. A different channel resets it, because a
 * different channel genuinely has not loaded.
 */
export function nextLoadingLatch(
  previous: { channelId: string | null; settled: boolean },
  activeChannelId: string,
  loadingNow: boolean,
): { channelId: string | null; settled: boolean } {
  if (previous.channelId !== activeChannelId) {
    return { channelId: activeChannelId, settled: !loadingNow };
  }
  return { channelId: activeChannelId, settled: previous.settled || !loadingNow };
}

// ---------------------------------------------------------------------------
// Permissions (spec 01 §3.1, `canManageMessage.ts`)
// ---------------------------------------------------------------------------

/**
 * May the reader edit or delete this message?
 *
 * Huddle rows are immutable regardless of authorship — they are the record of
 * a call having happened, and an author who could rewrite one could rewrite
 * history the other participants were in. Otherwise: the author, or the
 * verified owner of an agent author. Mirrors the relay's own authz, which is
 * the real gate; this one only decides whether to draw a button that would be
 * refused.
 */
export function canManageMessage(
  message: { kind: number; mine: boolean; pubkey: string },
  opts: { ownedAgentPubkeys?: readonly string[] } = {},
): boolean {
  if (message.kind === KIND_HUDDLE_STARTED) return false;
  if (message.mine) return true;
  const owned = opts.ownedAgentPubkeys ?? [];
  const author = message.pubkey.trim().toLowerCase();
  return author.length > 0 && owned.some((pk) => pk.trim().toLowerCase() === author);
}

/**
 * Copy actions need a real, delivered event: there is nothing to link to until
 * the server has signed it, and a link to an id that does not exist yet is a
 * link that 404s for whoever it was pasted to.
 */
export function hasCopyActions(message: { kind: number; pending: boolean }): boolean {
  return !message.pending && message.kind !== KIND_HUDDLE_STARTED;
}

export { KIND_HUDDLE_STARTED };
