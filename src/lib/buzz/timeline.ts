// The one projector: signed events in, the rows a reader sees out.
//
// The log holds a message, the edit that replaced its text, the deletion that
// retracted it, and every reaction anybody pressed — four independent events
// that together answer one question, "what does this message say right now".
// This file is the single place that answers it. There is exactly one of it for
// the same reason `message-types.ts` is one file: the transcript, the thread
// pane, the search-hit renderer and the unread counter all need that answer,
// and four private folds would disagree about an edited message inside a week.
//
// Pure — no React, no Convex, no ctx. It runs client-side over whatever window
// of events the subscription has delivered, exactly as Buzz's
// `formatTimelineMessages` does, which is what makes every rule below testable
// without a database or a DOM.
//
// **Order-independence is the property, not a nicety.** The same events arrive
// in different orders depending on whether history or the live subscription got
// there first, and a reader must not be able to tell. Every pass here is either
// commutative (a set union, a min, a max) or is applied to an already-sorted
// array, and the tests assert every rule in both input orders — an
// order-dependent implementation passes a single-order test perfectly.
//
// Timestamps are Nostr `created_at`: **seconds**, not milliseconds. They stay
// seconds the whole way through, including on `ChatRow`, because the substrate
// speaks seconds and one conversion in the middle is one place to get it wrong.
//
// Spec: docs/buzz-parity/01-core-comms.md §2.1 (versions and the edit overlay),
// §2.2 (threading), §2.7 (ordering), §2.10 (date separators, grouping, system
// rows), §3.2 (reactions).

import type { NostrEvent } from "@convex/buzz/_nostr";
import type { ChatMessage, ChatReaction, ChatRow } from "./message-types";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * What the projector folds.
 *
 * Derived from `NostrEvent` rather than retyped, so "what an event is" still has
 * one definition — with exactly one delta, spelled out here: an **optimistic**
 * row has no `id` and no `sig` yet, because the id is the hash of the signed
 * event and only exists once the server has signed it. Making `id` optional is
 * what lets the composer's pending row travel the same pipeline as an
 * acknowledged one instead of being special-cased into the list afterwards.
 */
export type TimelineEvent = Omit<NostrEvent, "id" | "sig"> & {
  id?: string;
  sig?: string;
  /** Client-side key for a row that has not been acknowledged. */
  localKey?: string;
  pending?: boolean;
  failed?: boolean;
};

/** A resolved principal — whatever the profile batch could tell us about a pubkey. */
export type TimelineActor = {
  pubkey: string;
  /** Display label. Empty or missing falls back to a truncated pubkey. */
  label?: string;
  avatarUrl?: string;
  isAgent?: boolean;
  /** For an agent: the principal answerable for it. */
  ownerLabel?: string;
  /** The actor's role in this channel, if any. */
  role?: string;
};

export type ActorDirectory =
  | ReadonlyMap<string, TimelineActor>
  | Readonly<Record<string, TimelineActor>>;

export type TimelineOptions = {
  /** The reader. Drives `mine`, the `"You"` reactor label and system-copy person. */
  selfPubkey?: string;
  /**
   * The community's relay identity.
   *
   * Only relay-signed events may be attributed to somebody other than their
   * signer, so without this the `actor` tag is ignored entirely — otherwise any
   * author could put an `["actor", …]` tag on their own message and have the
   * room draw somebody else's name on it.
   */
  relayPubkey?: string;
  actors?: ActorDirectory;
  /** Jump-to-message landed here; the row flashes once. */
  highlightedId?: string;
  /**
   * Which kinds occupy a row. Defaults to the chat timeline's set.
   *
   * The forum is why this exists, and it is a separation rather than an option:
   * a forum post (45001) and its comments (45003) are messages in every way that
   * matters — same author, same edits, same reactions, same threading — and are
   * *not* rows in the room's transcript. Two disjoint content sets over one
   * projector is what makes "a forum channel's chat view and its post view do
   * not leak into each other" a property of the code rather than of a filter
   * somebody remembers to apply: neither surface can show the other's rows,
   * because neither one lists them.
   *
   * A set rather than a boolean because the caller knows which surface it is;
   * the projector has no business guessing from a channel type it cannot see.
   */
  contentKinds?: ReadonlySet<number>;
};

export type TimelineRowOptions = {
  /** The first message the reader has not seen. The divider is drawn above it. */
  firstUnreadId?: string;
  /** Authoritative unread count from read state. Counted from the divider when absent. */
  unreadCount?: number;
  /**
   * Whether the beginning of the channel has been proven.
   *
   * Gates the *oldest* day divider only, and it is not a detail: the oldest
   * loaded day begins at the arbitrary edge of the loaded window, so a divider
   * there would have to accept older same-day rows prepending behind it, which
   * is both a lie about the day's start and a broken virtualizer key.
   */
  historyExhausted?: boolean;
};

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------
//
// Restated here rather than imported from `convex/buzz/_kinds.ts`, for one
// reason: that module imports `_nostr.ts`, which imports `@noble/curves` — a
// signing library the browser has no use for and should not download to draw a
// transcript. The duplication is the hazard the codebase warns about, so
// `tests/buzz-timeline.test.ts` pins every constant below against the registry
// and fails if the two ever drift.

/** Buzz v1 stream message. */
export const KIND_STREAM_MESSAGE = 9;
/** NIP-25 reaction. */
export const KIND_REACTION = 7;
/** NIP-09 deletion. */
export const KIND_DELETION = 5;
/** NIP-29 delete-event. A second deletion marker, mirroring the relay. */
export const KIND_NIP29_DELETE_EVENT = 9005;
/** Buzz v2 stream message. */
export const KIND_STREAM_MESSAGE_V2 = 40002;
/** An edit. Never a row of its own — it is an overlay on the message it names. */
export const KIND_STREAM_MESSAGE_EDIT = 40003;
/** A diff message. */
export const KIND_STREAM_MESSAGE_DIFF = 40008;
/** Relay-signed room narration: joins, topic changes, moderator removals. */
export const KIND_SYSTEM_MESSAGE = 40099;
/** A huddle announcement. It occupies a row, so it is content. */
export const KIND_HUDDLE_STARTED = 48100;

/**
 * The kinds that occupy a row.
 *
 * Note what is absent: **40003**. An edit is not a message, it is a revision of
 * one — a projector that let edits into the visible set would draw every
 * correction as a second message, which is the single most visible way to get
 * this wrong.
 */
export const TIMELINE_CONTENT_KINDS: ReadonlySet<number> = new Set([
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_SYSTEM_MESSAGE,
  KIND_HUDDLE_STARTED,
]);

/** Both deletion markers. Two kinds, one meaning — the relay accepts either. */
export const DELETION_KINDS: ReadonlySet<number> = new Set([
  KIND_DELETION,
  KIND_NIP29_DELETE_EVENT,
]);

export function isTimelineContentEvent(kind: number): boolean {
  return TIMELINE_CONTENT_KINDS.has(kind);
}

/** 10 minutes. The boundary is inclusive: exactly 600 groups, 601 does not. */
export const MESSAGE_GROUPING_WINDOW_SECONDS = 600;

/**
 * 5 minutes — the membership-grouping window (§2.10), deliberately half the
 * message window.
 *
 * Joins an hour apart are two facts about when people arrived, and folding them
 * would rewrite the room's history into a single moment. Joins thirty seconds
 * apart are one fact — somebody pasted an invite link — and drawing that as ten
 * rows pushes the conversation off the screen.
 */
export const MEMBERSHIP_GROUP_WINDOW_SECONDS = 300;

/** How many names the folded sentence says before it says "and N others". */
export const MAX_SYSTEM_GROUP_NAMES = 3;

// ---------------------------------------------------------------------------
// Hex identity
// ---------------------------------------------------------------------------

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * A tag value read as an event id, or nothing.
 *
 * **64-char hex only.** A deletion whose `e` tag is a channel name, a URL or a
 * truncated id must delete nothing rather than something: the alternative is a
 * malformed tag that happens to collide with a prefix quietly retracting a
 * message its author never touched.
 */
function asEventId(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim().toLowerCase();
  return HEX_64.test(clean) ? clean : undefined;
}

/** Same shape, different meaning — a 32-byte x-only pubkey. */
function asPubkey(value: string | undefined): string | undefined {
  return asEventId(value);
}

function normalizePubkey(value: string | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** `a1b2c3d4…9f0e`. What a person sees when no profile resolved. */
export function truncatePubkey(pubkey: string): string {
  const clean = normalizePubkey(pubkey);
  if (clean.length <= 12) return clean;
  return `${clean.slice(0, 8)}…${clean.slice(-4)}`;
}

/**
 * The id a row is keyed and deduped by.
 *
 * `id` once acknowledged, the local key before that. The `index` fallback exists
 * so an event carrying neither cannot silently merge with every other such
 * event into one row — a dedupe key that is `""` for two different messages
 * deletes one of them.
 */
function identity(event: TimelineEvent, index: number): string {
  return event.id || event.localKey || `@${index}`;
}

// ---------------------------------------------------------------------------
// §2.2 Threading
// ---------------------------------------------------------------------------

export type ThreadReference = { parentId: string | null; rootId: string | null };

/**
 * Which message is this a reply to, and which thread is it in?
 *
 * NIP-10 markers, read exactly as Buzz reads them: the **first** `root` and the
 * **last** `reply`. Last-wins on `reply` is the general rule for "which event
 * does this point at" in this file — NIP-10 orders references from least to most
 * specific, so the final one is always the thing the event is actually about.
 *
 * An `e` tag with no `reply` marker is a *mention* of another message, not a
 * parent. Treating one as a parent turns every quoted link into a thread reply.
 */
export function getThreadReference(tags: readonly string[][]): ThreadReference {
  const eTags = tags.filter((t) => t[0] === "e");
  if (eTags.length === 0) return { parentId: null, rootId: null };

  const rootTag = eTags.find((t) => t[3] === "root");
  let replyTag: string[] | undefined;
  for (const tag of eTags) if (tag[3] === "reply") replyTag = tag;
  if (!replyTag) return { parentId: null, rootId: null };

  const parentId = asEventId(replyTag[1]);
  if (!parentId) return { parentId: null, rootId: null };
  return { parentId, rootId: asEventId(rootTag?.[1]) ?? parentId };
}

/** A reply that also renders as a top-level row. */
export function isBroadcastReply(tags: readonly string[][]): boolean {
  return tags.some((t) => t[0] === "broadcast" && t[1] === "1");
}

/** Does this message occupy a row in the channel timeline, rather than a thread? */
export function isTopLevelMessage(message: Pick<ChatMessage, "parentId" | "tags">): boolean {
  return !message.parentId || isBroadcastReply(message.tags);
}

// ---------------------------------------------------------------------------
// §2.1 pass 1 — deletions
// ---------------------------------------------------------------------------

/**
 * Every event id retracted by a deletion marker in this window.
 *
 * Deliberately not an authorization check. Whether *this* author was allowed to
 * delete *that* message is settled at write time by the log, which is the only
 * place that can settle it; a projector re-deciding it would be a second answer
 * to the same question, and the two would disagree the moment a moderator
 * deletes somebody else's message.
 */
export function getDeletionTargets(events: readonly TimelineEvent[]): Set<string> {
  const targets = new Set<string>();
  for (const event of events) {
    if (!DELETION_KINDS.has(event.kind)) continue;
    for (const tag of event.tags) {
      if (tag[0] !== "e") continue;
      const id = asEventId(tag[1]);
      if (id) targets.add(id);
    }
  }
  return targets;
}

/**
 * The event an edit or a reaction points at: the **last** valid `e` tag.
 *
 * Scanned backwards for the NIP-10 reason above — the most specific reference is
 * last — and shared by both passes so "which message does this attach to" has
 * one answer. Two answers is how an edit and a reaction on the same threaded
 * message end up on different rows.
 */
export function getTargetEventId(tags: readonly string[][]): string | undefined {
  for (let i = tags.length - 1; i >= 0; i -= 1) {
    if (tags[i]?.[0] !== "e") continue;
    const id = asEventId(tags[i][1]);
    if (id) return id;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// §2.1 pass 2 — edits
// ---------------------------------------------------------------------------

export type TimelineEdit = {
  /** The edit event's own id. Used only to break a `created_at` tie. */
  id: string;
  content: string;
  /** Kept whole, because the renderer overlays the edit's media onto the original. */
  tags: string[][];
  createdAt: number;
};

/**
 * `targetId → the winning edit`.
 *
 * Two skips, and both are about a deletion outranking a revision: a **deleted
 * edit** must not keep rewriting the message it retracted (undo has to be
 * possible), and an edit of a **deleted message** must not resurrect text a
 * reader asked to be rid of — the message is gone, so its latest wording is not
 * a thing anybody should be able to publish afterwards.
 *
 * Most recent `created_at` wins. On a tie the lower id wins, which is the same
 * rule `_nostr.supersedes` uses for replaceable events — timestamps are seconds
 * and a client editing twice in one second is ordinary, so an unbroken tie would
 * make the shown text depend on delivery order.
 */
export function collectEdits(
  events: readonly TimelineEvent[],
  deleted: ReadonlySet<string>,
): Map<string, TimelineEdit> {
  const edits = new Map<string, TimelineEdit>();
  for (const event of events) {
    if (event.kind !== KIND_STREAM_MESSAGE_EDIT) continue;
    const editId = event.id ?? "";
    if (editId && deleted.has(editId)) continue;

    const targetId = getTargetEventId(event.tags);
    if (!targetId || deleted.has(targetId)) continue;

    const candidate: TimelineEdit = {
      id: editId,
      content: event.content,
      tags: event.tags,
      createdAt: event.created_at,
    };
    const existing = edits.get(targetId);
    if (!existing || supersedesEdit(candidate, existing)) edits.set(targetId, candidate);
  }
  return edits;
}

function supersedesEdit(candidate: TimelineEdit, existing: TimelineEdit): boolean {
  if (candidate.createdAt !== existing.createdAt) return candidate.createdAt > existing.createdAt;
  return candidate.id < existing.id;
}

/** The one tag family an edit may replace. NIP-92 inline media metadata. */
const MEDIA_TAG = "imeta";

/**
 * The original's tags with the edit's media swapped in.
 *
 * Media only. Every other tag is what the message *is* rather than what it says:
 * `h` is the room it was posted in, the `e` tags are its place in a thread, the
 * `p` tags are who it woke. An edit that could rewrite `h` would move a message
 * into a room its author never posted in, after the fact and without a trace, so
 * the overlay is an allow-list of one name rather than a merge.
 */
export function applyEditTagOverlay(
  originalTags: readonly string[][],
  editTags?: readonly string[][],
): string[][] {
  if (!editTags) return originalTags.map((tag) => [...tag]);
  const kept = originalTags.filter((tag) => tag[0] !== MEDIA_TAG).map((tag) => [...tag]);
  const media = editTags.filter((tag) => tag[0] === MEDIA_TAG).map((tag) => [...tag]);
  return [...kept, ...media];
}

// ---------------------------------------------------------------------------
// §2.1 pass 4–5 / §3.2 — reactions
// ---------------------------------------------------------------------------

/** `:party_parrot:` — a custom emoji, resolved against the event's NIP-30 tags. */
const SHORTCODE = /^:([^:\s]+):$/;

type ReactionSeed = {
  targetId: string;
  actor: string;
  emoji: string;
  emojiUrl?: string;
  at: number;
  /** Only a tie-break, so a duplicate delivery collapses the same way every time. */
  eventId: string;
};

/**
 * One entry per `target:actor:emoji`, holding the **earliest** `created_at`.
 *
 * The key is what makes a duplicate delivery a no-op — the same reaction
 * arriving from history and from the live subscription is one press, and a
 * count that went to 2 would be visibly wrong. Earliest rather than latest
 * because pills are ordered by that timestamp: keeping the latest would let a
 * row's pills visibly reshuffle whenever somebody reacted again, under the
 * reader's cursor.
 */
function collectReactionSeeds(
  events: readonly TimelineEvent[],
  deleted: ReadonlySet<string>,
  relayPubkey?: string,
): Map<string, ReactionSeed> {
  const seeds = new Map<string, ReactionSeed>();
  for (const event of events) {
    if (event.kind !== KIND_REACTION) continue;
    const eventId = event.id ?? "";
    if (eventId && deleted.has(eventId)) continue;

    const targetId = getTargetEventId(event.tags);
    // A reaction to a deleted message is dropped here rather than filtered at
    // render time, so a deleted message cannot leave a bare pill row behind.
    if (!targetId || deleted.has(targetId)) continue;

    const emoji = event.content.trim() || "+";
    const actor = resolveAttributedPubkey(event, relayPubkey);
    if (!actor) continue;

    const seed: ReactionSeed = {
      targetId,
      actor,
      emoji,
      emojiUrl: resolveEmojiUrl(emoji, event.tags),
      at: event.created_at,
      eventId,
    };
    const key = `${targetId}:${actor}:${emoji}`;
    const existing = seeds.get(key);
    if (!existing || seed.at < existing.at || (seed.at === existing.at && seed.eventId < existing.eventId)) {
      seeds.set(key, seed);
    }
  }
  return seeds;
}

function resolveEmojiUrl(emoji: string, tags: readonly string[][]): string | undefined {
  const match = SHORTCODE.exec(emoji);
  if (!match) return undefined;
  const shortcode = match[1];
  const tag = tags.find((t) => t[0] === "emoji" && t[1] === shortcode);
  return tag?.[2] || undefined;
}

/**
 * Seeds → the pills under each message.
 *
 * Pill order is **earliest reaction ascending** (the first emoji anybody pressed
 * sits leftmost, Slack-style), tie-broken by `localeCompare`. Both halves matter:
 * without the timestamp the pills reorder as people react, and without the
 * tie-break two emoji pressed in the same second swap places depending on which
 * subscription delivered first.
 */
function buildReactionPills(
  seeds: Iterable<ReactionSeed>,
  selfPubkey: string,
  label: (pubkey: string) => string,
): Map<string, ChatReaction[]> {
  const byTarget = new Map<string, Map<string, ReactionSeed[]>>();
  for (const seed of seeds) {
    let byEmoji = byTarget.get(seed.targetId);
    if (!byEmoji) byTarget.set(seed.targetId, (byEmoji = new Map()));
    const bucket = byEmoji.get(seed.emoji);
    if (bucket) bucket.push(seed);
    else byEmoji.set(seed.emoji, [seed]);
  }

  const out = new Map<string, ChatReaction[]>();
  for (const [targetId, byEmoji] of byTarget) {
    const pills: ChatReaction[] = [];
    for (const [emoji, bucket] of byEmoji) {
      // Reactor order is reaction order, pubkey-tie-broken so it cannot depend
      // on the order the Map happened to be filled in.
      const ordered = [...bucket].sort(
        (a, b) => a.at - b.at || (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0),
      );
      const mine = selfPubkey !== "" && ordered.some((seed) => seed.actor === selfPubkey);
      const others = ordered
        .filter((seed) => !(mine && seed.actor === selfPubkey))
        .map((seed) => label(seed.actor));
      const emojiUrl = ordered.find((seed) => seed.emojiUrl)?.emojiUrl;
      const pill: ChatReaction = {
        emoji,
        count: ordered.length,
        mine,
        // "You" first, because the reader scans this list for themselves before
        // they read anybody else's name.
        reactors: mine ? ["You", ...others] : others,
        firstAt: ordered[0].at,
      };
      if (emojiUrl) pill.emojiUrl = emojiUrl;
      pills.push(pill);
    }
    pills.sort((a, b) => a.firstAt - b.firstAt || a.emoji.localeCompare(b.emoji));
    out.set(targetId, pills);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/**
 * Who this event is *attributed* to, which is not always who signed it.
 *
 * A relay-signed event — a membership notification, a moderator removal — is
 * signed by the community's relay key and attributed to the person it is about.
 * The `actor` tag is honoured **only** when the signer is the relay, because
 * otherwise any author could tag somebody else's pubkey onto their own message
 * and have the room draw that person's name and avatar on it. Conflating the
 * two is a security bug, not a display bug: anything asking "did this principal
 * really write this" must read `signerPubkey`.
 */
export function resolveAttributedPubkey(event: TimelineEvent, relayPubkey?: string): string {
  const signer = normalizePubkey(event.pubkey);
  const relay = normalizePubkey(relayPubkey);
  if (!relay || signer !== relay) return signer;
  const tagged = asPubkey(event.tags.find((t) => t[0] === "actor")?.[1]);
  return tagged ?? signer;
}

// ---------------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------------

type ThreadNode = { id: string; parentId: string | null; rootId: string | null };

/**
 * How deep in a thread each message sits.
 *
 * Memoised, because a long thread resolved naively is quadratic, and
 * cycle-guarded, because parent pointers come off signed events written by other
 * clients and agents: nothing in the log prevents A naming B as its parent while
 * B names A. An unguarded walk there does not render a wrong depth, it hangs the
 * tab.
 *
 * The fallback when a parent is **not loaded** (paging has not reached it yet)
 * is deliberately not 0: the message is known to be a reply, so drawing it flush
 * with top-level rows would be a worse lie than guessing its indent. `2` when it
 * names a root distinct from its parent — a reply to a reply — else `1`.
 *
 * A cycle takes the same fallback, and for the same reason: the ancestor chain
 * is unusable, so we know it is a reply and cannot know how deep. One rule for
 * both, rather than a second constant nobody can explain later.
 */
export function resolveDepths(nodes: readonly ThreadNode[]): Map<string, number> {
  const byId = new Map<string, ThreadNode>();
  for (const node of nodes) if (node.id) byId.set(node.id, node);

  const memo = new Map<string, number>();
  const resolving = new Set<string>();

  const unresolvedDepth = (node: ThreadNode): number =>
    node.rootId && node.rootId !== node.parentId ? 2 : 1;

  // `null` means "the chain through here runs in a circle". It propagates
  // instead of being swallowed at the first frame that notices, and nothing on
  // a circular chain is memoised — otherwise the answer would depend on which
  // node the caller happened to ask about first, and two callers with the same
  // events would draw different indents.
  const walk = (node: ThreadNode): number | null => {
    if (!node.parentId) return 0;
    const cached = memo.get(node.id);
    if (cached !== undefined) return cached;
    if (resolving.has(node.id)) return null;

    resolving.add(node.id);
    const parent = byId.get(node.parentId);
    const parentDepth = parent ? walk(parent) : undefined;
    resolving.delete(node.id);

    if (parentDepth === null) return null;
    const depth = parentDepth === undefined ? unresolvedDepth(node) : parentDepth + 1;
    memo.set(node.id, depth);
    return depth;
  };

  const out = new Map<string, number>();
  for (const node of nodes) {
    if (node.id) out.set(node.id, walk(node) ?? unresolvedDepth(node));
  }
  return out;
}

// ---------------------------------------------------------------------------
// §2.7 Ordering
// ---------------------------------------------------------------------------

/**
 * One event per id, keeping the **last** occurrence.
 *
 * Later deliveries win: the same id arriving twice means the second copy came
 * from a fresher fetch, and it is the one whose tags reflect any server-side
 * enrichment.
 */
export function dedupeEventsById(events: readonly TimelineEvent[]): TimelineEvent[] {
  const seen = new Set<string>();
  const out: TimelineEvent[] = [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const key = identity(events[i], i);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(events[i]);
  }
  return out.reverse();
}

/**
 * Dedupe, then `created_at` ascending, **tie-broken on id ascending**.
 *
 * The tie-break is the whole point. `created_at` is seconds and a busy room
 * collides constantly; without it two events sharing a second land in different
 * positions depending on whether history or the live subscription delivered
 * first, which a reader sees as a message that moved — or went missing — at a
 * fixed scroll offset.
 */
export function sortEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  const deduped = dedupeEventsById(events);
  const keys = new Map<TimelineEvent, string>();
  deduped.forEach((event, index) => keys.set(event, identity(event, index)));
  return deduped.sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    const ka = keys.get(a) ?? "";
    const kb = keys.get(b) ?? "";
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

function actorLookup(actors?: ActorDirectory): (pubkey: string) => TimelineActor | undefined {
  if (!actors) return () => undefined;
  if (actors instanceof Map) return (pubkey) => actors.get(pubkey);
  const record = actors as Readonly<Record<string, TimelineActor>>;
  return (pubkey) => record[pubkey];
}

/**
 * The fold, in the order §2.1 specifies: deletions, then edits, then the visible
 * set, then reactions, then pills, then one message per visible event.
 *
 * The order is not stylistic. Edits consult the deletion set, reactions consult
 * it too, and the visible set is defined by it — computing deletions last would
 * mean a message could be drawn, edited and counted before being retracted.
 */
export function formatTimelineMessages(
  events: readonly TimelineEvent[],
  options: TimelineOptions = {},
): ChatMessage[] {
  const ordered = sortEvents(events);
  const selfPubkey = normalizePubkey(options.selfPubkey);
  const lookup = actorLookup(options.actors);
  const label = (pubkey: string): string => {
    const actor = lookup(pubkey);
    return actor?.label?.trim() || truncatePubkey(pubkey);
  };

  // 1. Deletions.
  const deleted = getDeletionTargets(ordered);

  // 2. Edits.
  const edits = collectEdits(ordered, deleted);

  // 3. The visible set. `contentKinds` is the surface's own answer to "what
  //    draws a row here" and defaults to the chat timeline's — see the option.
  const contentKinds = options.contentKinds ?? TIMELINE_CONTENT_KINDS;
  const visible = ordered.filter(
    (event) => contentKinds.has(event.kind) && !(event.id && deleted.has(event.id)),
  );

  // 4–5. Reactions, then pills.
  const pills = buildReactionPills(
    collectReactionSeeds(ordered, deleted, options.relayPubkey).values(),
    selfPubkey,
    label,
  );

  // Depth needs the whole visible set before any row can be emitted, because a
  // message's indent is a fact about its ancestors, not about itself.
  const references = visible.map((event) => ({
    id: event.id ?? "",
    ...getThreadReference(event.tags),
  }));
  const depths = resolveDepths(references);

  // 6. One message per visible event.
  return visible.map((event, index) => {
    const id = event.id ?? "";
    const reference = references[index];
    const edit = id ? edits.get(id) : undefined;
    const attributed = resolveAttributedPubkey(event, options.relayPubkey);
    const actor = lookup(attributed);

    const message: ChatMessage = {
      id,
      renderKey: event.localKey || id,
      createdAt: event.created_at,
      pubkey: attributed,
      signerPubkey: normalizePubkey(event.pubkey),
      author: label(attributed),
      isAgent: actor?.isAgent === true,
      body: edit ? edit.content : event.content,
      tags: applyEditTagOverlay(event.tags, edit?.tags),
      kind: event.kind,
      depth: depths.get(id) ?? 0,
      edited: edit !== undefined,
      pending: event.pending === true,
      mine: selfPubkey !== "" && attributed === selfPubkey,
      reactions: id ? (pills.get(id) ?? []) : [],
    };

    if (actor?.avatarUrl) message.authorAvatarUrl = actor.avatarUrl;
    if (actor?.ownerLabel) message.ownerLabel = actor.ownerLabel;
    if (actor?.role) message.role = actor.role;
    if (reference.parentId) message.parentId = reference.parentId;
    if (reference.rootId) message.rootId = reference.rootId;
    if (event.failed) message.failed = true;
    if (options.highlightedId && id && id === options.highlightedId) message.highlighted = true;

    return message;
  });
}

/** The messages the channel timeline draws: top-level, plus broadcast replies. */
export function topLevelMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter(isTopLevelMessage);
}

/**
 * How many rows a raw window would actually render.
 *
 * What fetch-older pages against, and the reason it is not `events.length`: a
 * history batch heavy with thread replies, reactions and edits can add a hundred
 * events and three rows. Paging on the event count stops fetching while the
 * screen is still half empty.
 *
 * Deliberately does not build messages — no profiles, no pills, no depth. The
 * predicates it shares with the full fold are the ones that decide visibility,
 * so the two can never disagree about what counts.
 */
export function countTopLevelTimelineRows(events: readonly TimelineEvent[]): number {
  const deleted = getDeletionTargets(events);
  let count = 0;
  for (const event of events) {
    if (!isTimelineContentEvent(event.kind)) continue;
    if (event.id && deleted.has(event.id)) continue;
    const { parentId } = getThreadReference(event.tags);
    if (parentId && !isBroadcastReply(event.tags)) continue;
    count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// §2.10 Days, grouping, system rows
// ---------------------------------------------------------------------------

/** Local midnight for a `created_at`, in seconds. */
export function startOfLocalDaySeconds(createdAt: number): number {
  const date = new Date(createdAt * 1000);
  date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

/** Same local calendar day? Local, because a reader's day is their own. */
export function isSameDay(a: number, b: number): boolean {
  return startOfLocalDaySeconds(a) === startOfLocalDaySeconds(b);
}

/**
 * Same author?
 *
 * Trimmed and lowercased, and a missing or empty pubkey **never** matches — two
 * unresolved authors are not one person, and grouping them would put one
 * stranger's words under another's name.
 */
export function hasSameMessageAuthor(
  previous: Pick<ChatMessage, "pubkey">,
  current: Pick<ChatMessage, "pubkey">,
): boolean {
  const a = normalizePubkey(previous.pubkey);
  const b = normalizePubkey(current.pubkey);
  return a !== "" && a === b;
}

/**
 * Within the grouping window?
 *
 * `0 <= gap <= 600`. A **negative** gap is out of window on purpose: an
 * out-of-order pair is not a continuation of anything, and treating it as one
 * hides a message under a header with a later timestamp than its own.
 */
export function isWithinGroupingWindow(previousAt: number, currentAt: number): boolean {
  if (!Number.isFinite(previousAt) || !Number.isFinite(currentAt)) return false;
  const gap = currentAt - previousAt;
  return gap >= 0 && gap <= MESSAGE_GROUPING_WINDOW_SECONDS;
}

/**
 * Is this row a continuation of the one above it?
 *
 * A **pending** row on either side breaks the group. A pending message renders
 * standalone so its send status can sit beside its own timestamp, and it stays
 * that way until the ack arrives — a row that gains a header the instant it
 * fails is a row that jumps.
 */
function isContinuation(previous: ChatMessage | null, current: ChatMessage): boolean {
  if (!previous) return false;
  if (previous.pending || current.pending) return false;
  if (!hasSameMessageAuthor(previous, current)) return false;
  return isWithinGroupingWindow(previous.createdAt, current.createdAt);
}

export type SystemEventPayload = {
  type?: string;
  /** Who did it. */
  actor?: string;
  /** Who it was done to. */
  target?: string;
  /** Additional principals, for the collapsed "along with …" forms. */
  others?: string[];
  /** The new topic/purpose. Blank means cleared. */
  value?: string;
  /** A moderator's public justification for a removal. */
  public_reason?: string;
};

function parseSystemPayload(content: string): SystemEventPayload | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SystemEventPayload;
    }
  } catch {
    // A system event whose content is not JSON is a system event from a build
    // that knows something this one does not. Rendering the raw content is a
    // worse sentence than the table below, and a far better outcome than an
    // empty row that makes the room look like it dropped an event.
  }
  return null;
}

/** `a`, `a and b`, `a, b and c`. */
function formatNameList(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * A moderator's public reason, made safe to put in a sentence.
 *
 * Control characters out, whitespace collapsed, length clamped. The row is built
 * as a text node rather than as markup, so this is not a sanitizer standing
 * between an author and an injection — it is a clamp standing between a
 * thousand-character justification and the transcript's layout.
 */
function sanitizePublicReason(reason: string): string {
  return reason
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export type SystemCopyContext = {
  /** Name-slot resolver: `"You"` for the reader, a display label otherwise. */
  name: (pubkey?: string) => string;
  /** Mid-sentence resolver: lowercase `"you"` for the reader. */
  inlineName: (pubkey?: string) => string;
};

/**
 * The sentence a system row says.
 *
 * The copy table from §2.10, in one function, because the same sentence is read
 * by the transcript, the inbox and search. Two rules worth stating:
 *
 * - A blank or whitespace-only topic means **cleared**, not `changed the topic
 *   to ""` — the relay reports a clear as a `topic_changed` carrying an empty
 *   string, so a projector that trusted the verb would narrate a rename to
 *   nothing.
 * - Self is decided by **comparing pubkeys**, never by matching the string
 *   `"You"`. Display names are user-controlled and identity is not; somebody
 *   naming themselves "You" must not make the room address everybody as
 *   themselves.
 */
export function describeSystemEvent(
  payload: SystemEventPayload,
  context: SystemCopyContext,
): string {
  const { name, inlineName } = context;
  const actor = name(payload.actor);
  const target = name(payload.target);
  const inlineActor = inlineName(payload.actor);
  const inlineTarget = inlineName(payload.target);
  const others = (payload.others ?? []).map((pubkey) => inlineName(pubkey));
  const alongWith = others.length > 0 ? `, along with ${formatNameList(others)}` : "";
  const value = (payload.value ?? "").trim();

  switch (payload.type) {
    case "members_added":
      return `${target} added by ${inlineActor}${alongWith}`;
    case "members_joined":
      return `${target} joined the channel${others.length > 0 ? ` along with ${formatNameList(others)}` : ""}`;
    case "member_joined":
      return normalizePubkey(payload.actor) === normalizePubkey(payload.target)
        ? `${target} joined the channel`
        : `${target} added by ${inlineActor}`;
    case "member_left":
      return `${actor} left the channel`;
    case "member_removed":
      return `${actor} removed ${inlineTarget} from the channel`;
    case "topic_changed":
      return value ? `${actor} changed the topic to “${value}”` : `${actor} cleared the topic`;
    case "purpose_changed":
      return value ? `${actor} changed the purpose to “${value}”` : `${actor} cleared the purpose`;
    case "channel_created":
      return `${actor} created this channel`;
    case "channel_archived":
      return `${actor} archived this channel`;
    case "channel_unarchived":
      return `${actor} unarchived this channel`;
    case "message_deleted": {
      const reason = sanitizePublicReason(payload.public_reason ?? "");
      return reason
        ? `Removed by community moderators “${reason}”`
        : `${actor} removed a message`;
    }
    default:
      return "";
  }
}

/** The name resolvers, built once per render rather than once per row. */
function systemCopyContext(options: TimelineOptions): SystemCopyContext {
  const selfPubkey = normalizePubkey(options.selfPubkey);
  const lookup = actorLookup(options.actors);
  const label = (pubkey: string): string => lookup(pubkey)?.label?.trim() || truncatePubkey(pubkey);
  return {
    name: (pubkey) => {
      const clean = normalizePubkey(pubkey);
      if (!clean) return "Someone";
      return selfPubkey !== "" && clean === selfPubkey ? "You" : label(clean);
    },
    inlineName: (pubkey) => {
      const clean = normalizePubkey(pubkey);
      if (!clean) return "someone";
      return selfPubkey !== "" && clean === selfPubkey ? "you" : label(clean);
    },
  };
}

function systemRowText(
  message: ChatMessage,
  payload: SystemEventPayload | null,
  context: SystemCopyContext,
): string {
  const described = payload ? describeSystemEvent(payload, context) : "";
  return described || message.body.trim();
}

// ---------------------------------------------------------------------------
// §2.10 System-message grouping
// ---------------------------------------------------------------------------

/**
 * The key two system rows must share to fold into one, or `null` for a row that
 * never folds.
 *
 * The adder is *part of* the `added` key. "Bo added Ada" and "Cy added Dee" are
 * two different facts, and a fold that dropped the adder would put one person's
 * name on the other's action — a system row saying something that did not
 * happen. Joins have no adder to disagree about, so they key on the verb alone.
 *
 * Everything else is `null`, and that is the conservative direction on purpose:
 * a run of topic changes is one room being edited step by step, and a reader
 * wants each step. Only "N people did the same membership thing" is a single
 * fact wearing N rows.
 */
function systemGroupMode(payload: SystemEventPayload | null): string | null {
  if (!payload) return null;
  if (payload.type === "member_joined") {
    return normalizePubkey(payload.actor) === normalizePubkey(payload.target)
      ? "joined"
      : `added:${normalizePubkey(payload.actor)}`;
  }
  if (payload.type === "member_left") return "left";
  return null;
}

/** Who the row is *about* — the person who joined or left, not who did it to them. */
function systemGroupSubject(payload: SystemEventPayload): string | undefined {
  return payload.type === "member_left" ? payload.actor : payload.target;
}

/**
 * The names the sentence says, capped.
 *
 * `actors` on the row keeps every one of them — the renderer draws a facepile
 * from that array and can expand the row. The *sentence* is the summary, and a
 * summary listing forty names is not one.
 */
function capNames(names: readonly string[]): string[] {
  if (names.length <= MAX_SYSTEM_GROUP_NAMES) return [...names];
  const shown = names.slice(0, MAX_SYSTEM_GROUP_NAMES);
  const rest = names.length - shown.length;
  return [...shown, rest === 1 ? "1 other" : `${rest} others`];
}

/**
 * The one sentence a folded row says.
 *
 * Composed here for the same reason `describeSystemEvent` is: the renderer must
 * never be assembling prose out of parts, or the copy lives in two places and
 * the singular and plural forms drift apart while sitting next to each other in
 * the same transcript. Which is why the plural keeps the singular's shape —
 * `<who> added by <adder>` reads slightly stiffly and reads *consistently*,
 * and consistency is what the reader is actually parsing.
 */
export function describeSystemGroup(
  kind: string,
  names: readonly string[],
  addedBy: string,
): string {
  const list = formatNameList(capNames(names));
  switch (kind) {
    case "joined":
      return `${list} joined the channel`;
    case "added":
      return `${list} added by ${addedBy}`;
    case "left":
      return `${list} left the channel`;
    default:
      return list;
  }
}

/**
 * Which system rows fold together, decided **backwards from the newest**.
 *
 * The direction is the whole invariant. Groups are anchored on their newest
 * member and measured back from it, so an older message prepended by paging can
 * only ever be absorbed into a group that already exists — it can never split
 * one, re-anchor one, or change a group's identity. Grouping forwards from the
 * oldest looks identical on a static list and repartitions the screen every time
 * history loads, which is a run of rows visibly rewriting itself above the
 * reader.
 *
 * A group needs its members to be **adjacent**: an ordinary message, an
 * ungroupable system row, a day divider or the unread divider between two joins
 * all break the run. A fold that reached across a message would claim the joins
 * happened together when the transcript plainly shows they did not.
 *
 * Returns the run-start index → its member indices ascending, plus the indices
 * folded away. A run of one is still returned, and the caller draws it as a
 * plain `system` row: a "group" with one member is a second row type for no
 * reason, and the renderer would have to special-case it.
 */
function planSystemGroups(
  messages: readonly ChatMessage[],
  payloads: readonly (SystemEventPayload | null)[],
  isBarrier: (index: number) => boolean,
): { runs: Map<number, number[]>; folded: Set<number> } {
  const runs = new Map<number, number[]>();
  const folded = new Set<number>();

  // Newest first, and `open` holds the members of the group being built, in
  // that same newest-first order. `open[0]` is therefore the anchor.
  let open: number[] | null = null;
  let openMode: string | null = null;

  const close = (): void => {
    if (!open) return;
    const ascending = [...open].reverse();
    runs.set(ascending[0], ascending);
    for (const index of ascending.slice(1)) folded.add(index);
    open = null;
    openMode = null;
  };

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const mode =
      messages[i].kind === KIND_SYSTEM_MESSAGE ? systemGroupMode(payloads[i]) : null;
    if (mode === null) {
      close();
      continue;
    }

    if (open && openMode === mode) {
      // Adjacency is guaranteed by the loop rather than checked here: anything
      // that is not this mode closes the open run above, so an open run's
      // oldest member is always `i + 1`. A check for it would be a condition no
      // input can make false, which reads as a rule and tests as dead code.
      const oldestSoFar = open[open.length - 1];
      const anchor = messages[open[0]];
      const gap = anchor.createdAt - messages[i].createdAt;
      // `gap >= 0` is not redundant: the row builder draws whatever list it is
      // handed, and an out-of-order pair is not a run of anything.
      const withinWindow = gap >= 0 && gap <= MEMBERSHIP_GROUP_WINDOW_SECONDS;
      if (!isBarrier(oldestSoFar) && withinWindow) {
        open.push(i);
        continue;
      }
    }

    close();
    open = [i];
    openMode = mode;
  }
  close();

  return { runs, folded };
}

/**
 * Messages → the flat row list a virtualized transcript draws.
 *
 * Dividers are rows, not decorations rendered beside a message. That is the
 * whole reason `ChatRow` is a union: a divider drawn inside a message row makes
 * that row a different height than the virtualizer was told, and the list then
 * mismeasures everything below it.
 */
export function buildTimelineRows(
  messages: readonly ChatMessage[],
  rowOptions: TimelineRowOptions = {},
  options: TimelineOptions = {},
): ChatRow[] {
  const rows: ChatRow[] = [];
  const copy = systemCopyContext(options);
  const payloads = messages.map((message) =>
    message.kind === KIND_SYSTEM_MESSAGE ? parseSystemPayload(message.body) : null,
  );

  // The barriers a fold may not cross, computed before anything is drawn
  // because grouping runs backwards and drawing runs forwards. A divider is
  // emitted *above* index `i`, so it separates `i - 1` from `i`.
  const days = messages.map((message) => startOfLocalDaySeconds(message.createdAt));
  const unreadIndex = rowOptions.firstUnreadId
    ? messages.findIndex((message) => message.id === rowOptions.firstUnreadId)
    : -1;
  const isBarrier = (index: number): boolean =>
    index > 0 && (days[index] !== days[index - 1] || index === unreadIndex);

  const { runs, folded } = planSystemGroups(messages, payloads, isBarrier);

  // The previous *grouping* entry, which is not the previous row: a divider or a
  // system row resets it, so the message under one always draws its own header.
  let previous: ChatMessage | null = null;
  let currentDay: number | null = null;
  let unreadDrawn = false;

  messages.forEach((message, index) => {
    // Folded into the group drawn at the start of its run. Skipped before the
    // dividers, because a barrier can never sit inside a run by construction —
    // `planSystemGroups` refused to build one across it.
    if (folded.has(index)) return;

    const day = days[index];
    if (day !== currentDay) {
      const isOldestLoadedDay = currentDay === null;
      if (!isOldestLoadedDay || rowOptions.historyExhausted === true) {
        // Keyed by start-of-day rather than by the first message in it, so
        // prepending an older message into an already-rendered day reuses the
        // row instead of remounting the whole section.
        rows.push({ type: "day", at: day });
        previous = null;
      }
      currentDay = day;
    }

    if (!unreadDrawn && rowOptions.firstUnreadId && message.id === rowOptions.firstUnreadId) {
      const remaining = messages
        .slice(index)
        .filter((m) => m.kind !== KIND_SYSTEM_MESSAGE).length;
      rows.push({ type: "unread", count: rowOptions.unreadCount ?? remaining });
      unreadDrawn = true;
      previous = null;
    }

    if (message.kind === KIND_SYSTEM_MESSAGE) {
      const run = runs.get(index);
      if (run && run.length > 1) {
        // Identity comes from the **newest** member, per §2.10, for the same
        // reason the fold is anchored there: absorbing an older row must not
        // change the key of a row already on the screen.
        const anchor = messages[run[run.length - 1]];
        const anchorPayload = payloads[run[run.length - 1]];
        const mode = systemGroupMode(anchorPayload) ?? "";
        const kind = mode.startsWith("added:") ? "added" : mode;
        const subjects = run.map((member) => systemGroupSubject(payloads[member] ?? {}));
        // Two forms of the same list, and they are not interchangeable. The
        // facepile draws chips, so every label is the name-slot form ("You").
        // The sentence reads as prose, so only the one that *starts* it is
        // capitalised and the rest are mid-sentence ("P1 and you joined") —
        // §2.10's rule, and the same one the singular copy already follows.
        const actors = subjects.map((subject) => copy.name(subject));
        const spoken = subjects.map((subject, position) =>
          position === 0 ? copy.name(subject) : copy.inlineName(subject),
        );
        rows.push({
          type: "system-group",
          id: anchor.renderKey || anchor.id,
          at: anchor.createdAt,
          kind,
          actors,
          text: describeSystemGroup(kind, spoken, copy.inlineName(anchorPayload?.actor)),
        });
        previous = null;
        return;
      }

      rows.push({
        type: "system",
        id: message.renderKey || message.id,
        at: message.createdAt,
        text: systemRowText(message, payloads[index], copy),
      });
      previous = null;
      return;
    }

    rows.push({ type: "message", message, grouped: isContinuation(previous, message) });
    previous = message;
  });

  return rows;
}

/**
 * Raw signed events → the rows a reader sees. The one entry point.
 *
 * Everything above is exported so it can be tested and reused in isolation, but
 * a surface drawing a transcript should call this: it is the only place that
 * knows the passes run in the order they run in, and that the channel timeline
 * shows top-level rows rather than every message in the window.
 */
export function projectTimeline(
  events: readonly TimelineEvent[],
  options: TimelineOptions = {},
  rowOptions: TimelineRowOptions = {},
): ChatRow[] {
  return buildTimelineRows(
    topLevelMessages(formatTimelineMessages(events, options)),
    rowOptions,
    options,
  );
}
