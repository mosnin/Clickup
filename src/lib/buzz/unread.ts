// The reader's side of read state: the divider, the pill, and the badges.
//
// `convex/buzz/readState.ts` owns the *protocol* — the blob, the merge, the byte
// budget, the markers that get published. This file owns the two questions the
// protocol cannot answer, because both are about what is currently on the
// screen:
//
//   1. **Where does the "New" divider go, and does it stay there?** (§4.6) The
//      answer has to be computed from a frontier captured when the channel was
//      *opened*, not from the live marker — opening a channel immediately
//      advances the marker, so a divider derived from the live value vanishes in
//      the same frame it appears (§10.8). That capture is a client concern; the
//      server has no notion of "when you opened this".
//   2. **Which replies in an open thread are still unread?** (§4.7) One
//      grow-only `msg:<id>` marker per reply, so reading an ancestor never
//      covers a descendant — and the divider inside the thread reads a snapshot
//      of those markers frozen before the on-open mark-read effect ran.
//
// Pure — no React, no Convex, no ctx — so every rule below is testable without a
// DOM or a database, and so the same functions can serve a component, a test and
// a story. The output feeds `timeline.ts`'s `TimelineRowOptions`
// (`firstUnreadId` / `unreadCount`), which is the projector's one hook for this.
//
// A small amount of the protocol's algebra is **restated** here rather than
// imported: `convex/buzz/readState.ts` imports Convex's server runtime, and the
// browser has no use for that to draw a divider. It is exactly the trade
// `timeline.ts` already makes with the kind registry, and it carries the same
// obligation: `tests/buzz-unread.test.ts` pins every restated constant and
// function against the Convex module and fails if the two ever drift.
//
// Spec: docs/buzz-parity/01-core-comms.md §4.2 (the frontier), §4.4 (forced
// unread), §4.6 (divider and pill), §4.7 (thread unreads), §4.8 (badge rollups).

import type { ChatChannelSummary } from "./channel-types";
import type { TimelineRowOptions } from "./timeline";

// ---------------------------------------------------------------------------
// The restated core (pinned against convex/buzz/readState.ts by test)
// ---------------------------------------------------------------------------

/** Context key → unix **seconds**. */
export type ReadContexts = Record<string, number>;

const THREAD_PREFIX = "thread:";
const MESSAGE_PREFIX = "msg:";

export type ContextKind = "channel" | "thread" | "message";

export function channelContextKey(channelId: string): string {
  return channelId;
}
export function threadContextKey(rootId: string): string {
  return `${THREAD_PREFIX}${rootId}`;
}
export function messageContextKey(messageId: string): string {
  return `${MESSAGE_PREFIX}${messageId}`;
}

export function classifyContextKey(key: string): ContextKind {
  if (key.startsWith(MESSAGE_PREFIX)) return "message";
  if (key.startsWith(THREAD_PREFIX)) return "thread";
  return "channel";
}

/**
 * The largest non-null marker. `null` means "never read", which is not zero.
 *
 * The distinction is the whole reason the divider can exist: a channel with no
 * marker has every message unread and no boundary to draw one at, and a channel
 * marked at second zero has a boundary that happens to be before everything.
 */
export function maxReadAt(...markers: readonly (number | null | undefined)[]): number | null {
  let best: number | null = null;
  for (const marker of markers) {
    if (marker === null || marker === undefined) continue;
    best = best === null ? marker : Math.max(best, marker);
  }
  return best;
}

/** The kinds that may make something unread (§0.2, §10.1). */
export const CONVERSATIONAL_UNREAD_KINDS: ReadonlySet<number> = new Set([9, 40002, 40008]);

/** An `undefined` kind counts as conversational: an optimistic row has none yet (§10.2). */
export function isConversationalUnreadKind(kind: number | undefined): boolean {
  return kind === undefined || CONVERSATIONAL_UNREAD_KINDS.has(kind);
}

/** A message at **exactly** the frontier is read. Strictly greater, everywhere (§10.13). */
export function isEventUnread(createdAt: number, readAt: number | null): boolean {
  return readAt === null || createdAt > readAt;
}

/**
 * Is a forced-unread mark still in force? (§4.4)
 *
 * Gated on the marker captured when mark-unread was invoked, so that a genuine
 * read — here or on another device — wins. Without the gate the dot could only
 * be cleared by the device that lit it.
 */
export function forcedUnreadStillLit(baseline: number | null, marker: number | null): boolean {
  if (marker === null) return true;
  if (baseline === null) return false;
  return marker <= baseline;
}

// ---------------------------------------------------------------------------
// §4.2 The frontier, and the trap in it
// ---------------------------------------------------------------------------

/** Which context covers this one, if any. `null` ends the chain. */
export type ParentResolver = (key: string) => string | null;

/** Channels have no parent. The default, and the safe answer for a stale screen. */
export const NO_PARENT: ParentResolver = () => null;

export function resolveEffectiveTimestamp(
  contexts: Readonly<ReadContexts>,
  key: string,
  parentOf: ParentResolver,
): number | null {
  let best: number | null = null;
  let current: string | null = key;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const own = contexts[current];
    if (own !== undefined) best = best === null ? own : Math.max(best, own);
    current = parentOf(current);
  }
  return best;
}

export type ReadStateReader = {
  /** This context's own marker. Nothing folded in. */
  getOwnTimestamp: (key: string) => number | null;
  /** This context's marker, or its parent's if that is later (§4.2). */
  getEffectiveTimestamp: (key: string) => number | null;
};

/**
 * The two accessors, side by side, because choosing the wrong one is the single
 * most repeated bug in this subsystem (§4.2, §10.7).
 *
 * The parent resolver is installed by whichever screen is mounted, and it maps
 * **every** `thread:`/`msg:` context to the *active* channel. So any caller
 * evaluating a background channel's thread — the sidebar's scan, a badge on a
 * room you are not in — must use `getOwnTimestamp`, or it borrows the marker of
 * whatever room happens to be open and reports a thread as read because you read
 * somewhere else.
 *
 * Handing both out from one factory (rather than exporting two loose functions)
 * is what makes the choice visible at every call site.
 */
export function makeReadStateReader(
  contexts: Readonly<ReadContexts>,
  parentOf: ParentResolver = NO_PARENT,
): ReadStateReader {
  return {
    getOwnTimestamp: (key: string) => contexts[key] ?? null,
    getEffectiveTimestamp: (key: string) =>
      resolveEffectiveTimestamp(contexts, key, parentOf),
  };
}

/**
 * A resolver that maps every thread and message context to one channel.
 *
 * Buzz's `ChannelScreen` installs exactly this and clears it on unmount. The
 * clearing matters: a resolver left pointing at a channel you have navigated
 * away from keeps folding that channel's marker into every thread you look at.
 */
export function activeChannelParentResolver(channelId: string | null): ParentResolver {
  return (key: string) => {
    if (channelId === null) return null;
    return classifyContextKey(key) === "channel" ? null : channelId;
  };
}

/**
 * When was this event read? (§4.5)
 *
 * Note the deliberate asymmetry: the **channel** term is effective (so marking a
 * channel read covers everything in it), the thread and message terms are own
 * markers only.
 */
export function eventReadAt(
  reader: ReadStateReader,
  channelId: string,
  eventId: string,
  rootId: string | null,
): number | null {
  return maxReadAt(
    reader.getEffectiveTimestamp(channelContextKey(channelId)),
    reader.getOwnTimestamp(messageContextKey(eventId)),
    rootId === null ? null : reader.getOwnTimestamp(threadContextKey(rootId)),
  );
}

// ---------------------------------------------------------------------------
// §4.6 The in-channel divider and pill
// ---------------------------------------------------------------------------

/** The little a marker needs to know about a message. `ChatMessage` satisfies it. */
export type UnreadCandidate = {
  id: string;
  createdAt: number;
  pubkey: string;
  /** Set on a thread reply. Replies are out of scope for the channel divider. */
  parentId?: string;
  /** Absent on an optimistic row, which counts as conversational (§10.2). */
  kind?: number;
};

export type ChannelUnreadMarker = {
  /** The oldest unread message. The divider is drawn above it. */
  firstUnreadMessageId: string | null;
  unreadCount: number;
};

const NO_UNREAD: ChannelUnreadMarker = { firstUnreadMessageId: null, unreadCount: 0 };

function samePubkey(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Is `candidate` older than `best` in relay order?
 *
 * "Oldest unread" is decided by `(createdAt, id)` rather than by position in the
 * array, and that is what makes the divider **order-independent**: the same
 * window arrives in different orders depending on whether history or the live
 * subscription delivered it, and a divider that anchored on whichever unread
 * happened to be listed first would sit in a different place on a reload. The
 * id tie-break is the same one the log orders by, because `createdAt` is seconds
 * and a busy room collides constantly.
 */
function isOlder(
  candidate: UnreadCandidate,
  best: UnreadCandidate | null,
): boolean {
  if (best === null) return true;
  if (candidate.createdAt !== best.createdAt) return candidate.createdAt < best.createdAt;
  return candidate.id < best.id;
}

/**
 * Where the "New" divider goes, and how many messages are under it (§4.6).
 *
 * `frontierSeconds` is the **open-time** frontier: the reader's marker as it
 * stood when the channel was opened, captured during render rather than in an
 * effect. That is not a detail — opening a channel marks it read, so a frontier
 * read in an effect is already the post-open value and the divider disappears
 * the instant it is drawn (§10.8). It is also keyed per channel and dropped on
 * leave, because a stale one paints a phantom divider over messages you read
 * last time (§10.9).
 *
 * `suppressed` is `isActiveChannelForcedUnread || isWelcomeInitialUnreadSuppressed`
 * and wins over everything, including the never-read case. The reason is a
 * visible contradiction rather than a preference: a deliberate mark-unread has
 * no meaningful boundary *inside* the timeline — the open-time snapshot already
 * covers every message — so the pill and divider would render nothing while the
 * sidebar insists the room is unread (§10.16).
 *
 * Thread replies are skipped even when newer (they belong to the thread pane's
 * own marker), and so are your own messages — you know about your own posts, and
 * the comparison is case-insensitive because a case mismatch between an identity
 * pubkey and a signer pubkey would silently count them (§10.14).
 */
export function computeChannelUnreadMarker(
  messages: readonly UnreadCandidate[],
  frontierSeconds: number | null,
  suppressed: boolean,
  currentPubkey: string | undefined,
): ChannelUnreadMarker {
  if (suppressed) return NO_UNREAD;

  let oldest: UnreadCandidate | null = null;
  let unreadCount = 0;

  for (const message of messages) {
    // Filtered here rather than trusted to the caller: a system row or a
    // reaction that inflated the pill is the bug §10.3 describes, and a
    // predicate that only runs when somebody remembers is not a rule.
    if (!isConversationalUnreadKind(message.kind)) continue;
    if (message.parentId) continue;
    if (samePubkey(message.pubkey, currentPubkey)) continue;
    if (!isEventUnread(message.createdAt, frontierSeconds)) continue;

    if (isOlder(message, oldest)) oldest = message;
    unreadCount += 1;
  }

  if (oldest === null) return NO_UNREAD;
  return { firstUnreadMessageId: oldest.id, unreadCount };
}

/**
 * Does the divider render at this row?
 *
 * `index > 0` is the whole rule beyond the id match: when the first unread is
 * the first row on the screen there is nothing above it to separate it from, so
 * the divider is a banner rather than a boundary (§10.15).
 */
export function shouldRenderUnreadDivider(
  index: number,
  id: string,
  firstUnreadId: string | null | undefined,
): boolean {
  return index > 0 && !!firstUnreadId && id === firstUnreadId;
}

/** The pill's label. Singular at one, because "1 new messages" is a tell. */
export function unreadCountLabel(count: number): string {
  return `${count} new message${count === 1 ? "" : "s"}`;
}

/**
 * The marker, in the shape `timeline.ts` takes.
 *
 * It exists so the index-0 suppression cannot be forgotten: `buildTimelineRows`
 * draws the divider wherever `firstUnreadId` matches, so the only place that
 * rule can live is in what we hand it. `rendered` must be the same array passed
 * to the projector, or the index being checked is not the index being drawn.
 */
export function timelineUnreadOptions(
  rendered: readonly { id: string }[],
  marker: ChannelUnreadMarker,
  extra: { historyExhausted?: boolean } = {},
): TimelineRowOptions {
  const options: TimelineRowOptions = {};
  if (extra.historyExhausted !== undefined) options.historyExhausted = extra.historyExhausted;
  if (marker.firstUnreadMessageId === null) return options;

  const index = rendered.findIndex(
    (row: { id: string }) => row.id === marker.firstUnreadMessageId,
  );
  // Not in this window at all (paged away), or the oldest row on screen — the
  // same predicate the renderer would apply, run once here so the projector
  // never has to.
  if (index < 0) return options;
  if (!shouldRenderUnreadDivider(index, rendered[index].id, marker.firstUnreadMessageId)) {
    return options;
  }
  options.firstUnreadId = marker.firstUnreadMessageId;
  options.unreadCount = marker.unreadCount;
  return options;
}

// ---------------------------------------------------------------------------
// §4.7 Thread unreads
// ---------------------------------------------------------------------------

export type ThreadUnreadMarker = {
  firstUnreadReplyId: string | null;
  unreadCount: number;
};

/**
 * Which replies in an open thread are unread (§4.7, LP4 v3).
 *
 * One grow-only `msg:<id>` marker per reply rather than one frontier for the
 * thread, and the difference is a state a frontier simply cannot express: with
 * `getReadAt = (id) => id === "r2" ? 20 : null`, r1 and r3 are unread while r2 is
 * read. A single frontier at 20 would have covered r1 as well.
 *
 * `isForcedUnread` is the **session-only** per-message overlay (§4.4): marking
 * one message unread is not written to any marker store, is cleared on channel
 * leave, and is read only as an OR here. It never becomes a smaller timestamp,
 * for the same reason a channel's forced unread does not.
 */
export function computeThreadUnreadMarker(
  replies: readonly UnreadCandidate[],
  getReadAt: (replyId: string) => number | null,
  currentPubkey: string | undefined,
  isForcedUnread: (replyId: string) => boolean = () => false,
): ThreadUnreadMarker {
  let oldest: UnreadCandidate | null = null;
  let unreadCount = 0;

  for (const reply of replies) {
    if (samePubkey(reply.pubkey, currentPubkey)) continue;
    const forced = isForcedUnread(reply.id);
    if (!forced && !isEventUnread(reply.createdAt, getReadAt(reply.id))) continue;
    if (isOlder(reply, oldest)) oldest = reply;
    unreadCount += 1;
  }

  return { firstUnreadReplyId: oldest === null ? null : oldest.id, unreadCount };
}

/**
 * Read the in-thread divider's frozen snapshot — with `.has`, never `??`.
 *
 * The snapshot is taken before the on-open mark-read effect runs, and a
 * never-read reply snapshots to `null`. A nullish-coalescing fallthrough would
 * discard that `null`, re-read the now-advanced live marker, and collapse the
 * divider over exactly the replies it was supposed to anchor (§10.10). Written
 * as a function so the mistake has to be made here once rather than at every
 * lookup.
 */
export function snapshotReadAt(
  snapshot: ReadonlyMap<string, number | null>,
  live: (replyId: string) => number | null,
  replyId: string,
): number | null {
  return snapshot.has(replyId) ? (snapshot.get(replyId) ?? null) : live(replyId);
}

/**
 * Unread replies per thread root, for the badges in the main timeline (§4.7).
 *
 * Subtree membership keys on each reply's own **`rootId`**, never on a walk up
 * the parent chain (§10.17). Three things follow, and all three are why: a reply
 * whose intermediate ancestor is outside the loaded window still carries its true
 * root and rolls up; each reply has exactly one root, so it is counted once; and
 * a malformed parent cycle keys off no root rather than looping.
 *
 * `isNotified` is the thread-interest gate — participated ∨ authored ∨ followed ∨
 * mentioned, minus muted. Roots you have no interest in get no badge at all,
 * because a number on every thread in a busy room is a number nobody reads.
 */
export function computeThreadBadgeCounts(
  replies: readonly (UnreadCandidate & { rootId?: string })[],
  getReadAt: (replyId: string) => number | null,
  currentPubkey: string | undefined,
  isNotified: (rootId: string) => boolean,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const reply of replies) {
    const rootId = reply.rootId;
    if (!rootId) continue;
    if (!isNotified(rootId)) continue;
    if (samePubkey(reply.pubkey, currentPubkey)) continue;
    if (!isEventUnread(reply.createdAt, getReadAt(reply.id))) continue;
    counts.set(rootId, (counts.get(rootId) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// §4.8 Badge rollups
// ---------------------------------------------------------------------------

export type BadgeRollup = {
  /** How many rooms have anything unread. The rail's own "you have mail". */
  unreadChannels: number;
  /** Every unread message across the community. */
  unread: number;
  /** Every unread message addressed to you. */
  mentions: number;
  /**
   * What the OS badge shows: mentions in rooms that are not muted.
   *
   * Muted rooms still *count* unread — muting is about not being interrupted,
   * not about pretending nothing happened — so they contribute to `unread` and
   * `mentions` and never to this.
   */
  appBadge: number;
};

/**
 * Sum the rail. Deliberately a fold over the same rows the rail draws.
 *
 * The alternative — a second query that counts unread its own way — is how a
 * "3" on the app icon sits above a sidebar showing two rooms with one each. A
 * rollup that cannot disagree with its parts is one computed *from* them.
 */
export function rollupChannelBadges(
  channels: readonly ChatChannelSummary[],
): BadgeRollup {
  let unreadChannels = 0;
  let unread = 0;
  let mentions = 0;
  let appBadge = 0;
  for (const channel of channels) {
    if (channel.unread > 0) unreadChannels += 1;
    unread += channel.unread;
    mentions += channel.mentions;
    if (!channel.muted) appBadge += channel.mentions;
  }
  return { unreadChannels, unread, mentions, appBadge };
}
