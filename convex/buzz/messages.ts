// Messages: the events a room is made of.
//
// A message is not a row here. It is an event in the log — kind 9 — and so are
// the things that happen to it afterwards: an edit is a 40003 pointing at it, a
// deletion is a 9005, a reaction is a kind 7. Nothing in this file rewrites a
// message; every write is one more signed event, published through `publishCore`,
// which stays the only function in the codebase allowed to put an event in the
// table.
//
// **The read returns raw events, not rendered messages.** That is Buzz's design
// (01-core-comms §2.1) and the reason it is worth keeping: the fold from "these
// events" to "what a person reads" — deletions hide rows, the newest edit wins,
// reactions aggregate into pills — is a pure function over an array
// (`src/lib/buzz/timeline.ts`, C4a). A server that folded would have to re-fold
// on every live event, could not answer an optimistic row, and could not be
// tested without a database. So this file's job is to hand the projector
// *everything that bears on the page*: the messages, and the edits, deletions
// and reactions that overlay them. A page missing its edits renders stale text.
//
// Two rules from the spec shape almost every decision below.
//
//   - **Threading lives in tags** (§2.2). A reply is an ordinary message
//     carrying `["e", root, "", "root"]` and `["e", parent, "", "reply"]`, and a
//     client that ignores the marker renders a reply as a top-level row. So the
//     server owns the markers: `post` derives the root from the parent it was
//     given rather than believing a caller's `rootId`, because a wrong root does
//     not fail loudly — it silently puts the message in the wrong thread,
//     forever, in a log that does not rewrite.
//   - **Pagination is a cursor over an index range** (§2.8, §0.4), and the
//     cursor is composite `(createdAt, eventId)`. A bare `until` cursor cannot
//     escape a second denser than one page: it re-returns the same slice
//     forever. The cursor counts *events* while the client counts *rows*,
//     because a history batch heavy with replies adds many events and few rows —
//     which is a question about what is being rendered, and only the renderer
//     can answer it.
//
// Mentions are parsed **server-side from the body** (`resolveMentions`), never
// accepted as an argument, exactly as `createMessageCore` does on the Work side.
// A client that forgets to send them must not be able to produce a message whose
// stored mentions disagree with its own text — the tag is what wakes somebody
// up, and a body that says "@Ada" while the event says nobody is a notification
// that silently never arrives.

import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Actor } from "../_agentAuth";
// Membership and room visibility are `channels.ts`'s answer and there is exactly
// one of it. `requireChannelAccess` is the tenancy fence (`requireScopeAccess`)
// plus the room's own rule, and re-rolling either here is how two files end up
// disagreeing about who may read #acquisition.
import {
  requireChannelAccess,
  resolveChannelForActor,
  type ChannelPrincipal,
} from "./channels";
import { pubkeyFor, principalForPubkey } from "./identity";
import { asRelay } from "./relay";
import { notifyForEvent } from "./notifications";
import { requireNotRestricted } from "./moderation";
import { onEventCore } from "./workflows";
// C12. `extractRefs` is the app's one reference parser, shared with the Work
// side — a second one here would be a token that resolves in one dashboard and
// not the other.
import { extractRefs } from "../_refs";
import { emitForBridgedMessage } from "./bridge";
import {
  eventVisibleToReader,
  publishCore,
  toNostrEvent,
  type EventRow,
  type Scope,
} from "./log";
import type { NostrEvent } from "./_nostr";

// ---------------------------------------------------------------------------
// The kinds this file reads and writes
// ---------------------------------------------------------------------------

/** NIP-09 deletion marker. Used here to retract a reaction. */
const KIND_DELETION = 5;
/** NIP-25 reaction. Its channel is derived from its `#e` target, never from `h`. */
const KIND_REACTION = 7;
/** The message. */
const KIND_STREAM_MESSAGE = 9;
/** Buzz-native delete: an author's own message, or a moderator's removal. */
const KIND_NIP29_DELETE_EVENT = 9005;
/** Rich message. Written by a later phase; read (and editable) from this one. */
const KIND_STREAM_MESSAGE_V2 = 40002;
/** An edit. Overlays a message rather than replacing it (§2.1). */
const KIND_STREAM_MESSAGE_EDIT = 40003;
/** Diff message — renders its own row. */
const KIND_STREAM_MESSAGE_DIFF = 40008;
/** Relay-signed state row ("Ada joined", "Ada removed a message"). */
const KIND_SYSTEM_MESSAGE = 40099;
/** A huddle began. Renders its own row; never editable, never deletable. */
const KIND_HUDDLE_STARTED = 48100;
/**
 * A forum post, and a comment on one (C7a, `convex/buzz/forum.ts`).
 *
 * Named here rather than only in `forum.ts` because *this* file owns the two
 * questions a forum post has to answer the same way a message does: what may be
 * replied to, and what may be edited or reacted to. A post is a message with a
 * different kind (03-workflows-projects §5.1) — it is written through
 * `postMessageCore`, read through `readThreadPage`, edited by a 40003 and
 * deleted by a 9005, exactly like a message. What it is *not* is a row in the
 * chat transcript: `TIMELINE_CONTENT_KINDS` deliberately excludes both, which is
 * the whole of "a forum channel's chat view and its post view do not leak into
 * each other". Adding them to that set would put every post in the room's
 * transcript as well.
 */
const KIND_FORUM_POST = 45001;
const KIND_FORUM_COMMENT = 45003;

/**
 * Kinds that render their **own row** in a timeline (§0.2
 * `CHANNEL_TIMELINE_CONTENT_KINDS`).
 *
 * This is what a reply may point at, what may be edited or deleted, and what a
 * reaction may land on. Everything outside it either overlays a row (an edit) or
 * is not part of the transcript at all (a canvas, a metadata edit) — so a reply
 * to one would be a reply to something the reader cannot see.
 */
const TIMELINE_CONTENT_KINDS: ReadonlySet<number> = new Set([
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_SYSTEM_MESSAGE,
  43001,
  43002,
  43003,
  43004,
  43005,
  43006,
  KIND_HUDDLE_STARTED,
]);

/**
 * Everything a reply, an edit, a reaction or a deletion may point at.
 *
 * `TIMELINE_CONTENT_KINDS` answers "does this draw a row in the chat
 * transcript"; this answers "is this a thing somebody said". They are different
 * questions and a forum post is the case that separates them — it is said, so it
 * can be replied to, corrected, reacted to and removed; it is not a transcript
 * row, so the chat view never draws it.
 *
 * Keeping one set for both would force a choice between two bugs: forum posts in
 * the room's transcript, or a post nobody can react to.
 */
const THREADABLE_KINDS: ReadonlySet<number> = new Set([
  ...TIMELINE_CONTENT_KINDS,
  KIND_FORUM_POST,
  KIND_FORUM_COMMENT,
]);

/** The two forum kinds, as a set — "is this a forum thing" asked once. */
const FORUM_KINDS: ReadonlySet<number> = new Set([KIND_FORUM_POST, KIND_FORUM_COMMENT]);

/**
 * What a member may *say* through `postMessageCore`.
 *
 * An allow-list rather than "any kind the caller passes", because this core is
 * reached by the agent surface too: a general door would let an API key publish
 * a relay-signed system row, a membership event or a huddle announcement wearing
 * a message's clothes. Every entry here is prose somebody typed.
 */
const SAYABLE_KINDS: ReadonlySet<number> = new Set([
  KIND_STREAM_MESSAGE,
  KIND_FORUM_POST,
  KIND_FORUM_COMMENT,
]);

/**
 * Auxiliary kinds (§0.2 `CHANNEL_AUX_EVENT_KINDS`): events that **overlay onto
 * or hide** an existing row instead of rendering one.
 *
 * They are fetched by `#e` reference over the ids a page loaded, not by time
 * window — a message edited a week after it was written has an edit event that
 * lives nowhere near it in the log, and a page that only read a time range would
 * render the stale text.
 */
const AUX_KINDS: ReadonlySet<number> = new Set([
  KIND_DELETION,
  KIND_REACTION,
  KIND_NIP29_DELETE_EVENT,
  KIND_STREAM_MESSAGE_EDIT,
]);

/**
 * What a person may edit: their own words, and only those.
 *
 * A system row is signed by the relay precisely so a member cannot write one,
 * and a huddle-started row is immutable regardless of authorship (§3.1) — both
 * are statements about what happened, not statements somebody made.
 */
const EDITABLE_KINDS: ReadonlySet<number> = new Set([
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  // A forum post is written to be read later, which makes correcting it *more*
  // important than correcting a chat line, not less — a message scrolls away and
  // a post does not. Same 40003 overlay, same author-only rule, same "(edited)".
  KIND_FORUM_POST,
  KIND_FORUM_COMMENT,
]);

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Buzz's history page size (§2.8). */
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
/** §2.2: the relay caps mention `p` tags at 50, deduped. */
const MAX_MENTIONS = 50;
/**
 * How many `#e` references one page will follow per message.
 *
 * A cap rather than a `.collect()` because this is the one unbounded fan-in in
 * the read: a message everybody reacted to has one tag row per reaction, and a
 * transcript should not be able to load ten thousand of them because one message
 * went round the company.
 */
const AUX_PER_TARGET = 200;
/** The same bound, when looking for *your* reaction among everybody's. */
const REACTION_SCAN = 500;
/** How many replies a thread read returns before it pages. */
const THREAD_PAGE = 100;

const scopeArgs = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

type ChannelRow = Doc<"buzzChannels">;
type MembershipRow = Doc<"buzzMemberships">;

// ---------------------------------------------------------------------------
// Threading (§2.2) — pure, so the tag grammar can be tested without a database
// ---------------------------------------------------------------------------

export type ThreadReference = { parentId: string; rootId: string };

/**
 * Read a thread reference back out of an event's tags. Buzz's
 * `getThreadReference`, verbatim.
 *
 * The asymmetry is deliberate and is Buzz's: the **first** `root` marker and the
 * **last** `reply` marker win. A message with no reply marker is top-level even
 * if it carries `e` tags — an `e` tag without a marker is a quote or a mention
 * of an event, not a parent, and treating one as a parent would silently reparent
 * every message that ever linked to another.
 */
export function threadReferenceFrom(
  tags: readonly string[][],
): { parentId: string | null; rootId: string | null } {
  const eTags = tags.filter((t) => t[0] === "e" && t[1]);
  if (eTags.length === 0) return { parentId: null, rootId: null };
  const rootTag = eTags.find((t) => t[3] === "root");
  const replyTags = eTags.filter((t) => t[3] === "reply");
  const replyTag = replyTags[replyTags.length - 1];
  if (!replyTag) return { parentId: null, rootId: null };
  const parentId = replyTag[1];
  return { parentId, rootId: rootTag?.[1] ?? parentId };
}

/**
 * The tags a message carries. Buzz's `buildReplyTags`, plus the non-reply case.
 *
 * Tag order is part of the event id — the canonical serialization hashes the
 * tags array verbatim — so it cannot be "whatever the caller assembled". One
 * order, here, for every message: the author's self-tag, the room, the mentions,
 * then the thread markers.
 *
 * A reply directly to a root carries a single `["e", root, "", "reply"]`; a
 * deeper reply carries the root **and** the parent. That is what lets a client
 * draw a thread without having loaded the intermediate messages.
 */
export function messageTags(
  channelId: string,
  authorPubkey: string,
  mentionPubkeys: readonly string[],
  ref: ThreadReference | null,
): string[][] {
  const tags: string[][] = [
    ["p", authorPubkey],
    ["h", channelId],
  ];
  for (const mention of mentionPubkeys) tags.push(["p", mention]);
  if (ref) {
    if (ref.parentId === ref.rootId) {
      tags.push(["e", ref.rootId, "", "reply"]);
    } else {
      tags.push(["e", ref.rootId, "", "root"]);
      tags.push(["e", ref.parentId, "", "reply"]);
    }
  }
  return tags;
}

/**
 * The mention tokens in a body.
 *
 * `@[Name](actorId)` — the app's one mention grammar (`src/lib/mentions.ts`),
 * restated here rather than imported because `convex/` deploys as its own
 * bundle and its only edge into the Next tree is a type import, which is erased.
 * The same restatement already exists in `convex/_markdown.ts` and
 * `convex/messages.ts`; this is the established shape, not a new one.
 *
 * The id half may be a Chat pubkey or an actor id — `resolveMentions` decides,
 * because only it can look one up.
 */
export function mentionedActorIds(body: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(/@\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
    const id = match[2];
    if (seen.has(id)) continue;
    seen.add(id);
    found.push(id);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Cursors (§0.4)
// ---------------------------------------------------------------------------

export type Cursor = { createdAt: number; eventId: string };

/**
 * The highest event id there is.
 *
 * A cursor holding it means "everything in this second is behind us", which is
 * how `pageWindow` steps past a second denser than one page. It reads the same
 * in both directions — the id tie-break inside a second is ascending either way
 * — so there is deliberately no mirrored constant: a `MIN_EVENT_ID` used in the
 * forward direction would say "the whole second again" and loop forever.
 */
const MAX_EVENT_ID = "f".repeat(64);

const CURSOR_RE = /^(\d+):([0-9a-f]{64})$/;

function encodeCursor(row: Cursor): string {
  return `${row.createdAt}:${row.eventId}`;
}

/**
 * Parse a cursor, or refuse loudly.
 *
 * Loud rather than "start from the beginning": a malformed cursor silently
 * treated as absent re-serves page one forever, which reads as a scroll that
 * will not move rather than as an error anybody can act on.
 */
export function decodeCursor(raw: string | undefined): Cursor | null {
  if (raw === undefined) return null;
  const match = CURSOR_RE.exec(raw);
  if (!match) throw new ConvexError("invalid: malformed cursor");
  return { createdAt: Number(match[1]), eventId: match[2] };
}

/**
 * Relay order: `created_at` **descending**, then event id **ascending** (§0.4,
 * §2.7).
 *
 * The id tie-break is not tidiness. Two events routinely share a `created_at`
 * (it is seconds), and without a total order the same page delivered by history
 * and by a live subscription lands in different positions — which reads as a
 * message that moved, or went missing, at a fixed scroll offset.
 */
function byRelayOrder(a: Cursor, b: Cursor): number {
  return b.createdAt - a.createdAt || a.eventId.localeCompare(b.eventId);
}

/** The same order read forwards, for a thread (§2.3). */
function byForwardOrder(a: Cursor, b: Cursor): number {
  return a.createdAt - b.createdAt || a.eventId.localeCompare(b.eventId);
}

/**
 * Is this row strictly after `cursor` in the traversal order?
 *
 * Note that the id half is `>` in **both** directions: the tie-break inside one
 * second is ascending either way, so only the `createdAt` comparison flips.
 */
function isAfterCursor(row: Cursor, cursor: Cursor, direction: Direction): boolean {
  if (row.createdAt === cursor.createdAt) return row.eventId > cursor.eventId;
  return direction === "back"
    ? row.createdAt < cursor.createdAt
    : row.createdAt > cursor.createdAt;
}

export type Direction = "back" | "forward";

/**
 * One page of a keyset-paginated index range, in relay order, with no gap at a
 * second boundary.
 *
 * The problem this exists for: our indexes end in `createdAt`, so they order by
 * the second and, *inside* a second, by insertion. Relay order inside a second
 * is by event id. Those disagree, so a page cut mid-second and resumed by a
 * `(createdAt, eventId)` cursor would skip every row of that second whose id
 * happened to sort before the cursor's — a gap that appears only under load,
 * only at a boundary, and only for some readers.
 *
 * So a second is never half-read. Either it is complete in the window, or it is
 * dropped and read again next page, or — when a single second is denser than one
 * page — it is read **in full** by an equality range and ordered in memory,
 * which is the only way to order it correctly at all. The last case is exactly
 * what §0.4 says a bare `until` cursor cannot escape.
 *
 * `fetch` returns rows from `bound` onwards in the traversal direction (`<=` for
 * a channel read, `>=` for a thread), in index order; `fetchSecond` returns every
 * row in exactly one second. Both are index ranges — nothing here scans.
 */
export async function pageWindow<T extends Cursor>(opts: {
  direction: Direction;
  limit: number;
  cursor: Cursor | null;
  fetch: (bound: number | undefined, take: number) => Promise<T[]>;
  fetchSecond: (second: number) => Promise<T[]>;
}): Promise<{ examined: T[]; nextCursor?: string }> {
  const { direction, limit } = opts;
  const compare = direction === "back" ? byRelayOrder : byForwardOrder;
  const step = direction === "back" ? -1 : 1;

  let bound = opts.cursor?.createdAt;
  let cursor = opts.cursor;

  // The loop exists for one case: a cursor sitting on the last row of a second
  // that is itself denser than a page. The window then contains only rows the
  // caller has already seen, so there is nothing to return *and* nothing to
  // build a cursor from — and a cursor that does not move is a scroll that
  // never ends. Each turn steps the bound strictly past an exhausted second, so
  // it terminates; sixteen is room to spare rather than a bet, and the exit
  // below still returns a cursor that has moved.
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const raw = await opts.fetch(bound, limit + 1);
    // The `+ 1` is a probe, not a row: it answers "is there more" exactly, so
    // the client is never told to stop one page early.
    const truncated = raw.length > limit;
    let rows = raw;
    let denseSecond: number | undefined;

    if (truncated) {
      const tailSecond = raw[raw.length - 1].createdAt;
      const complete = raw.filter((row) => row.createdAt !== tailSecond);
      if (complete.length === 0) {
        // The whole window is one second. Read it in full — an equality range
        // on the same index — because a partial second cannot be ordered by id.
        rows = await opts.fetchSecond(tailSecond);
        denseSecond = tailSecond;
      } else {
        rows = complete;
      }
    }

    const ordered = rows
      .filter((row) => (cursor ? isAfterCursor(row, cursor, direction) : true))
      .sort(compare);

    if (ordered.length > 0) {
      const examined = ordered.slice(0, limit);
      const hasMore = truncated || ordered.length > limit;
      return hasMore
        ? { examined, nextCursor: encodeCursor(examined[examined.length - 1]) }
        : { examined };
    }
    // Nothing qualified. If the window was not full there is genuinely nothing
    // left; the log ends here.
    if (!truncated) return { examined: [] };

    const stalled = denseSecond ?? bound;
    if (stalled === undefined) return { examined: [] };
    bound = stalled + step;
    // Past the exhausted second, every row qualifies, so the cursor has done
    // its job and would only re-apply a comparison against a second we have
    // left behind.
    cursor = null;
  }

  // Out of attempts — sixteen exhausted dense seconds in one page. Hand back a
  // cursor that resumes exactly where this call gave up rather than pretending
  // the history ended: `{second, MAX}` means "strictly beyond this whole
  // second" in either direction, which is why there is no mirrored constant.
  const resumeAt = bound === undefined ? undefined : bound - step;
  return resumeAt === undefined
    ? { examined: [] }
    : { examined: [], nextCursor: encodeCursor({ createdAt: resumeAt, eventId: MAX_EVENT_ID }) };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE;
  if (!Number.isFinite(limit)) return DEFAULT_PAGE;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_PAGE);
}

/** A row that is still part of the log, and that this reader may see. */
function isLive(row: EventRow): boolean {
  return row.deletedAt === undefined && row.supersededAt === undefined;
}

function visible(row: EventRow, readerPubkey: string): boolean {
  // `eventVisibleToReader` is the one per-event gate (§16.12) and every read
  // surface runs it — including this one, whose kinds are all `open` today.
  // The point of having one function is that it keeps being true when a gated
  // kind starts appearing in a room.
  return isLive(row) && eventVisibleToReader(row, readerPubkey);
}

export async function eventById(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  eventId: string,
): Promise<EventRow | null> {
  return await ctx.db
    .query("buzzEvents")
    .withIndex("by_scope_event_id", (q) =>
      q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("eventId", eventId),
    )
    .first();
}

/**
 * The events that **overlay** the rows on a page: edits, deletions, reactions.
 *
 * Fetched by `#e` reference over the loaded ids rather than by time window, for
 * the reason §0.2 gives: an edit written today for a message written last month
 * is nowhere near it in the log, and a page that only read a time range would
 * hand the projector the message without its edit and render text nobody has
 * said for a month.
 */
export async function auxEventsFor(
  ctx: QueryCtx,
  channel: ChannelRow,
  targets: readonly EventRow[],
  readerPubkey: string,
  already: Set<string>,
): Promise<EventRow[]> {
  const wanted = new Set<string>();
  for (const target of targets) {
    const tagRows = await ctx.db
      .query("buzzEventTags")
      .withIndex("by_tag", (q) =>
        q
          .eq("scopeType", channel.scopeType)
          .eq("scopeId", channel.scopeId)
          .eq("name", "e")
          .eq("value", target.eventId),
      )
      .take(AUX_PER_TARGET);
    for (const tagRow of tagRows) {
      if (!AUX_KINDS.has(tagRow.kind)) continue;
      if (already.has(tagRow.eventId)) continue;
      wanted.add(tagRow.eventId);
    }
  }

  const out: EventRow[] = [];
  for (const eventId of wanted) {
    const row = await eventById(ctx, { scopeType: channel.scopeType, scopeId: channel.scopeId }, eventId);
    if (!row) continue;
    // The channel boundary, re-applied: an aux event reached by reference is
    // still an event, and one that resolved to another room has no business in
    // this transcript.
    if (row.channelId !== channel.channelId) continue;
    if (!visible(row, readerPubkey)) continue;
    out.push(row);
    already.add(eventId);
  }
  return out;
}

/**
 * A page of a room's timeline, newest first.
 *
 * Returns **raw events** — the fold into messages is `src/lib/buzz/timeline.ts`
 * (C4a). `events` therefore holds three things: the page's own events, in relay
 * order, and the edits / deletions / reactions that bear on them. Deleted rows
 * are absent rather than tombstoned: the content of a deleted message is not
 * served at all, and the 9005 that removed it is, so a client holding an
 * optimistic copy learns to drop it.
 *
 * The cursor counts events, not rows (§2.8). A batch heavy with replies adds
 * many events and few top-level rows, and only the renderer knows how many rows
 * it drew — so "is this enough" is the client's question and it asks again.
 */
export const list = query({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ events: NostrEvent[]; nextCursor?: string }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel } = await requireChannelAccess(ctx, scope, args.channelId);
    const readerPubkey = (await pubkeyFor(ctx, "user", subject)) ?? "";
    return await readChannelPage(ctx, scope, channel, readerPubkey, args);
  },
});

/**
 * The page itself, once the room has been resolved and the reader identified.
 *
 * Split from the query so the key-authenticated agent surface reads a room
 * through *this* — the cursor that cannot skip a second, the aux fetch that
 * keeps an edited message from rendering stale, the per-event gate. A read that
 * looks simple is exactly the kind that gets reimplemented; the second copy
 * would page correctly right up until a second held more than one page of
 * events, which is the case this function exists for.
 */
export async function readChannelPage(
  ctx: QueryCtx,
  scope: Scope,
  channel: ChannelRow,
  readerPubkey: string,
  args: { cursor?: string; limit?: number },
): Promise<{ events: NostrEvent[]; nextCursor?: string }> {
  const limit = clampLimit(args.limit);

  const { examined, nextCursor } = await pageWindow<EventRow>({
    direction: "back",
    limit,
    cursor: decodeCursor(args.cursor),
    fetch: async (bound, take) =>
      bound === undefined
        ? await ctx.db
            .query("buzzEvents")
            .withIndex("by_scope_channel", (q) =>
              q
                .eq("scopeType", scope.scopeType)
                .eq("scopeId", scope.scopeId)
                .eq("channelId", channel.channelId)
                .eq("supersededAt", undefined),
            )
            .order("desc")
            .take(take)
        : await ctx.db
            .query("buzzEvents")
            .withIndex("by_scope_channel", (q) =>
              q
                .eq("scopeType", scope.scopeType)
                .eq("scopeId", scope.scopeId)
                .eq("channelId", channel.channelId)
                .eq("supersededAt", undefined)
                .lte("createdAt", bound),
            )
            .order("desc")
            .take(take),
    fetchSecond: async (second) =>
      await ctx.db
        .query("buzzEvents")
        .withIndex("by_scope_channel", (q) =>
          q
            .eq("scopeType", scope.scopeType)
            .eq("scopeId", scope.scopeId)
            .eq("channelId", channel.channelId)
            .eq("supersededAt", undefined)
            .gte("createdAt", second)
            .lte("createdAt", second),
        )
        .order("desc")
        .collect(),
  });

  // Visibility is applied *after* the window is measured, so a hidden row
  // consumes its place in the page rather than shifting the cursor. The
  // alternative — refilling the page — would make the cursor depend on who is
  // reading, and two readers would page through different histories.
  const rows = examined.filter((row) => visible(row, readerPubkey));
  const seen = new Set(rows.map((row) => row.eventId));
  const aux = await auxEventsFor(
    ctx,
    channel,
    rows.filter((row) => TIMELINE_CONTENT_KINDS.has(row.kind)),
    readerPubkey,
    seen,
  );

  return {
    events: [...rows, ...aux].map(toNostrEvent),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

/**
 * One thread: its head, its whole subtree, and the events that overlay them.
 *
 * Read **forwards** (§2.3) — a channel is read backwards from now, a thread is
 * read forwards from the message that started it — which is why the order and
 * the cursor direction differ from `list`. The head is returned only on the
 * first page; a later page would otherwise repeat it.
 *
 * Every descendant is found through one index range, not by walking the tree,
 * because `messageTags` always carries the root: a nested reply names its root
 * *and* its parent, so `#e = rootId` is the whole subtree in one read.
 */
export const thread = query({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    rootId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ events: NostrEvent[]; nextCursor?: string }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel } = await requireChannelAccess(ctx, scope, args.channelId);
    const readerPubkey = (await pubkeyFor(ctx, "user", subject)) ?? "";
    return await readThreadPage(ctx, scope, channel, readerPubkey, args);
  },
});

/**
 * The thread read itself, once the room has been resolved and the reader
 * identified. Same split, and the same reason, as `readChannelPage`.
 */
export async function readThreadPage(
  ctx: QueryCtx,
  scope: Scope,
  channel: ChannelRow,
  readerPubkey: string,
  args: { rootId: string; cursor?: string; limit?: number },
): Promise<{ events: NostrEvent[]; nextCursor?: string }> {
  const cursor = decodeCursor(args.cursor);
  const limit = clampLimit(args.limit ?? THREAD_PAGE);

  const head = await eventById(ctx, scope, args.rootId);
  // "Not found" for a head in another room, deleted, or gated away — the same
  // answer for all three, because which of them it is, is itself information.
  if (!head || head.channelId !== channel.channelId || !visible(head, readerPubkey)) {
    throw new ConvexError("Message not found");
  }

  const { examined, nextCursor } = await pageWindow<Doc<"buzzEventTags">>({
    direction: "forward",
    limit,
    cursor,
    fetch: async (bound, take) =>
      bound === undefined
        ? await ctx.db
            .query("buzzEventTags")
            .withIndex("by_tag", (q) =>
              q
                .eq("scopeType", scope.scopeType)
                .eq("scopeId", scope.scopeId)
                .eq("name", "e")
                .eq("value", args.rootId),
            )
            .take(take)
        : await ctx.db
            .query("buzzEventTags")
            .withIndex("by_tag", (q) =>
              q
                .eq("scopeType", scope.scopeType)
                .eq("scopeId", scope.scopeId)
                .eq("name", "e")
                .eq("value", args.rootId)
                .gte("createdAt", bound),
            )
            .take(take),
    fetchSecond: async (second) =>
      await ctx.db
        .query("buzzEventTags")
        .withIndex("by_tag", (q) =>
          q
            .eq("scopeType", scope.scopeType)
            .eq("scopeId", scope.scopeId)
            .eq("name", "e")
            .eq("value", args.rootId)
            .gte("createdAt", second)
            .lte("createdAt", second),
        )
        .collect(),
  });

  const replies: EventRow[] = [];
  for (const tagRow of examined) {
    // `THREADABLE_KINDS`, not the transcript's set: a forum post's comments are
    // 45003s, and a thread read that only admitted transcript kinds would return
    // the post with none of its replies.
    if (!THREADABLE_KINDS.has(tagRow.kind)) continue;
    const row = await eventById(ctx, scope, tagRow.eventId);
    if (!row || row.channelId !== channel.channelId) continue;
    if (!visible(row, readerPubkey)) continue;
    replies.push(row);
  }

  const rows = cursor ? replies : [head, ...replies];
  const seen = new Set(rows.map((row) => row.eventId));
  const aux = await auxEventsFor(ctx, channel, rows, readerPubkey, seen);

  return {
    events: [...rows, ...aux].map(toNostrEvent),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

// ---------------------------------------------------------------------------
// Writing — the shared preconditions
// ---------------------------------------------------------------------------

/** The acting principal, in the shape every write path in this app takes. */
async function userActor(ctx: QueryCtx | MutationCtx, subject: string): Promise<Actor> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", subject))
    .unique();
  return { type: "user", id: subject, name: user?.name ?? user?.email ?? subject };
}

/**
 * The writer's own pubkey, or a refusal naming the bootstrap that should have
 * minted it.
 *
 * Needed *before* publishing, because the author's self-tag is part of the event
 * being signed. `publishCore` resolves the same key a moment later and would
 * refuse just as loudly — this is the same refusal, arriving early enough to
 * build the tags.
 */
async function requireOwnPubkey(
  ctx: MutationCtx,
  principal: ChannelPrincipal,
): Promise<string> {
  const pubkey = await pubkeyFor(ctx, principal.actorType, principal.actorId);
  if (!pubkey) {
    throw new ConvexError(
      `${principal.actor.name} has no Chat signing key yet; keys are minted by the buzz.keys.mint action when Chat is opened.`,
    );
  }
  return pubkey;
}

/** A person, as a principal. The other constructor is the agent surface's. */
async function userPrincipal(
  ctx: QueryCtx | MutationCtx,
  subject: string,
): Promise<ChannelPrincipal> {
  return {
    actor: await userActor(ctx, subject),
    actorType: "user",
    actorId: subject,
  };
}

/**
 * Membership, which is what a write to a room needs.
 *
 * An open room is readable by the whole community and **writable only by its
 * members** — Buzz's own header says so in as many words ("Read-only until you
 * join this open channel", §1.5). A private room is neither, and
 * `requireChannelAccess` has already answered that by refusing to admit the room
 * exists.
 */
function requireMember(
  channel: ChannelRow,
  membership: MembershipRow | null,
): MembershipRow {
  if (!membership) {
    throw new ConvexError(
      channel.visibility === "open"
        ? "Join this channel before posting in it"
        : "You are not in this channel",
    );
  }
  return membership;
}

/**
 * Membership, and a room that still accepts writes.
 *
 * An archived room is frozen rather than gone: its history stays readable by the
 * people who were in it, and nothing new is added. Deletion is deliberately not
 * routed through here — moderation has to keep working on an archive, or
 * archiving becomes a way to make a message permanent.
 */
function requireWritable(
  channel: ChannelRow,
  membership: MembershipRow | null,
): MembershipRow {
  const active = requireMember(channel, membership);
  if (channel.archivedAt !== undefined) throw new ConvexError("This channel is archived");
  return active;
}

/**
 * Publish, and refuse to continue on an outcome that wrote nothing.
 *
 * `duplicate` is fine and is not an error: an id is the hash of the event, so an
 * identical resubmission *is* the event that is already there — which is what
 * makes a retried send idempotent instead of a second message. `dominated` and
 * `ephemeral` wrote no row, and a caller that went on to patch one would be
 * patching on the strength of an event that does not exist.
 */
async function publishOrThrow(
  ctx: MutationCtx,
  args: Parameters<typeof publishCore>[1],
): Promise<{ eventId: string; createdAt: number; fresh: boolean }> {
  const outcome = await publishCore(ctx, args);
  if (outcome.status === "dominated" || outcome.status === "ephemeral") {
    throw new ConvexError(
      `The channel log refused this event (${outcome.status}); nothing was written.`,
    );
  }
  return {
    eventId: outcome.event.id,
    createdAt: outcome.event.created_at,
    fresh: outcome.status === "inserted",
  };
}

/** A live, visible content event in this room — what a reply/edit/reaction needs. */
async function requireTarget(
  ctx: MutationCtx,
  scope: Scope,
  channel: ChannelRow,
  eventId: string,
  readerPubkey: string,
): Promise<EventRow> {
  const row = await eventById(ctx, scope, eventId);
  // One answer for "no such message", "in another room", "already deleted" and
  // "not yours to see". A reaction to a message you cannot see must be refused,
  // and a refusal that distinguishes the cases is a way to ask whether a message
  // exists in a room you were kept out of.
  if (
    !row ||
    row.channelId !== channel.channelId ||
    !THREADABLE_KINDS.has(row.kind) ||
    !visible(row, readerPubkey)
  ) {
    throw new ConvexError("Message not found");
  }
  return row;
}

/**
 * The per-event gate, for the surfaces built on top of this file.
 *
 * `forum.ts` reads its own index range (posts of one kind in one channel) and
 * owes every row the same two-part answer this file gives: still part of the log,
 * and visible to *this* reader. A second copy of those two lines is how a gated
 * kind eventually appears on one surface and not the other.
 */
export function eventVisibleInRoom(row: EventRow, readerPubkey: string): boolean {
  return visible(row, readerPubkey);
}

/**
 * Turn the mention tokens in a body into `p` tag values.
 *
 * Server-side, from the body, always. Three rules, all of them Buzz's
 * `normalizeMentionPubkeys` (§2.2): lowercase, dedupe, **drop self** (a message
 * does not notify its own author), and cap at 50.
 *
 * A token naming nobody produces no tag rather than an error. A body is prose,
 * and `(nobody@example.com)` inside a markdown-shaped token is a typo, not an
 * attack — and refusing the whole message would make a mention token something
 * a person has to get right.
 */
export async function resolveMentions(
  ctx: MutationCtx,
  body: string,
  selfPubkey: string,
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of mentionedActorIds(body)) {
    if (out.length >= MAX_MENTIONS) break;
    const pubkey = await resolveMentionTarget(ctx, id);
    if (!pubkey) continue;
    if (pubkey === selfPubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    out.push(pubkey);
  }
  return out;
}

/**
 * The pubkey a mention token names, or null.
 *
 * A token may carry either half of an identity: a Chat pubkey (what a Chat
 * composer knows) or an actor id (what the rest of this app passes around).
 * Both resolve, and a pubkey is checked against `buzzKeys` rather than trusted —
 * otherwise any 64 hex characters typed into a body would become a `p` tag, and
 * `p` is the read-authorization key for gated kinds.
 */
async function resolveMentionTarget(
  ctx: MutationCtx,
  id: string,
): Promise<string | null> {
  if (/^[0-9a-fA-F]{64}$/.test(id)) {
    const lower = id.toLowerCase();
    return (await principalForPubkey(ctx, lower)) ? lower : null;
  }
  return (
    (await pubkeyFor(ctx, "user", id)) ?? (await pubkeyFor(ctx, "agent", id)) ?? null
  );
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/**
 * Say something in a room.
 *
 * `parentId` makes it a reply. `rootId` is accepted because the contract carries
 * it, and it is **verified rather than believed**: the root is derived from the
 * parent's own tags, and a caller whose `rootId` disagrees is refused. A wrong
 * root does not fail loudly — it files the message under a thread nobody is
 * reading, in a log that never rewrites.
 */
export const post = mutation({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    body: v.string(),
    parentId: v.optional(v.string()),
    rootId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireChannelAccess(ctx, scope, args.channelId);
    return await postMessageCore(
      ctx,
      scope,
      args.channelId,
      await userPrincipal(ctx, subject),
      args,
    );
  },
});

/**
 * Saying something, for anybody.
 *
 * This is the function the Actor pattern exists for. A message written by an
 * agent has to be the same object a message written by a person is — signed by
 * its author's own key, carrying the same server-derived mentions, filed under
 * the same thread root, waking the same people, bumping the same clock. Every
 * one of those is a line below, and an agent path that reimplemented four of
 * the five would produce messages that look right and quietly do not notify
 * anybody.
 */
export async function postMessageCore(
  ctx: MutationCtx,
  scope: Scope,
  channelId: string,
  principal: ChannelPrincipal,
  input: {
    body: string;
    parentId?: string;
    rootId?: string;
    /**
     * What kind of thing is being said. Kind 9 unless the caller says otherwise.
     *
     * The one seam a forum needs (03-workflows-projects §5.1: both post kinds go
     * through the *same* transport, differing only in the kind argument). Passing
     * a kind rather than writing a second post path is what keeps mentions parsed
     * from the body, threading derived from the parent, the room's clock bumped
     * and the notification fan-out identical for a post and a message — five
     * things a forked path would have got four of.
     *
     * Constrained to what a person can say. Anything else — a system row, a
     * membership event, a canvas — is written by the surface that owns it, and a
     * general "post any kind" door is exactly the door an agent walks through to
     * forge one.
     */
    kind?: number;
    /** Extra tags appended after the message grammar's own. See below. */
    extraTags?: readonly string[][];
  },
): Promise<{ eventId: string; createdAt: number }> {
  const { channel, membership } = await resolveChannelForActor(
    ctx,
    scope,
    channelId,
    principal.actorId,
  );
  requireWritable(channel, membership);
  if (input.body.trim().length === 0) {
    throw new ConvexError("A message needs something in it");
  }

  const kind = input.kind ?? KIND_STREAM_MESSAGE;
  if (!SAYABLE_KINDS.has(kind)) {
    throw new ConvexError(`invalid: kind ${kind} is not something a member can post`);
  }

  const authorPubkey = await requireOwnPubkey(ctx, principal);
  // A community restriction bites here and only here.
  //
  // One seam rather than a check on each write surface: a ban enforced in the
  // room composer and forgotten in the agent API is not a ban. Everything that
  // says anything — a person, an agent over MCP, a forum post, a workflow —
  // reaches the log through this function, so this is the one place a
  // restriction cannot be routed around.
  await requireNotRestricted(ctx, scope, authorPubkey);

  let ref: ThreadReference | null = null;
  if (input.parentId) {
    const parent = await requireTarget(ctx, scope, channel, input.parentId, authorPubkey);
    // A reply has to be the same *sort* of thing as what it replies to, and this
    // is where that is decided once. A chat message filed under a forum post
    // would be a comment the post view never draws and the chat view draws in
    // the wrong place — one row, two surfaces, neither of them right. Refusing
    // names the door that does work rather than silently producing it.
    if (FORUM_KINDS.has(parent.kind) !== FORUM_KINDS.has(kind)) {
      throw new ConvexError(
        FORUM_KINDS.has(parent.kind)
          ? "Comment on a forum post through buzz.forum.comment"
          : "A forum comment can only be filed under a forum post",
      );
    }
    const parentRef = threadReferenceFrom(parent.tags);
    // Climb to the parent's root, which is Buzz's `resolveReplyRootId`: a
    // thread has one root however deep the reply is, so a reply to a reply
    // belongs to the same thread rather than starting a second one.
    const rootId = parentRef.rootId ?? parent.eventId;
    if (input.rootId && input.rootId !== rootId) {
      throw new ConvexError("That reply's root does not match its parent's thread");
    }
    ref = { parentId: parent.eventId, rootId };
  } else if (input.rootId) {
    throw new ConvexError("A reply needs the message it is replying to");
  }

  const mentions = await resolveMentions(ctx, input.body, authorPubkey);
  const published = await publishOrThrow(ctx, {
    actor: principal.actor,
    scope,
    kind,
    tags: [
      ...messageTags(channel.channelId, authorPubkey, mentions, ref),
      // Whatever the caller wants carried that the message grammar has no slot
      // for — today only a forum post's `["subject", …]` title. Appended after
      // the fixed order rather than mixed into it, because tag order is part of
      // the event id and `messageTags` owns that order for everything it emits.
      ...(input.extraTags ?? []),
    ],
    content: input.body,
  });

  // The room's clock, which orders the rail and measures an ephemeral room's
  // TTL. `updatedAt` is deliberately untouched: a message is not a change to
  // what the room *is*.
  await ctx.db.patch(channel._id, { lastActivityAt: Date.now() });

  // Who hears about it. In the same transaction on purpose: a notification
  // scheduled for afterwards can be delivered for a message that was rolled
  // back, and "you were mentioned in a message that does not exist" is worse
  // than a missed ping. Every failure inside is a no-op rather than a throw —
  // there is no version of "your message could not be sent because the email
  // about it could not be addressed" that is the right behaviour.
  await notifyForEvent(ctx, {
    scope,
    channelId: channel.channelId,
    eventId: published.eventId,
  });

  // And what reacts to it. Message-triggered workflows fire from here rather
  // than from publishCore, deliberately: a workflow's own actions post
  // messages, and hanging the dispatcher off the log's write would let every
  // workflow retrigger itself through the substrate. The tag a workflow stamps
  // on its output is the other half of that guard.
  // Read the stored row back rather than reconstructing it: the dispatcher
  // matches on the event as it actually landed — its id, its author, its tags —
  // and a locally rebuilt copy is a second opinion about what was written.
  const stored = await eventById(ctx, scope, published.eventId);
  if (stored) {
    await onEventCore(
      ctx,
      scope,
      {
        id: stored.eventId,
        pubkey: stored.pubkey,
        kind: stored.kind,
        created_at: stored.createdAt,
        tags: stored.tags,
        content: stored.content,
      },
      channel.channelId,
    );
  }

  // C12: and what the *other* dashboard hears about it. Only messages naming a
  // Work object cross the seam — see `emitForBridgedMessage`, which is a
  // no-op for everything else.
  await emitForBridgedMessage(
    ctx,
    scope,
    channel,
    { eventId: published.eventId, pubkey: authorPubkey, content: input.body },
    extractRefs(input.body),
  );

  return { eventId: published.eventId, createdAt: published.createdAt };
}

// ---------------------------------------------------------------------------
// Editing and deleting (§3.4)
// ---------------------------------------------------------------------------

/**
 * Edit a message: a 40003 that overlays it, never a rewrite.
 *
 * Author-only, and that is checked against the *signing* pubkey on the target
 * rather than against anything a caller said. The log is append-only, so the
 * original text stays — which is the honest behaviour for a record that other
 * people have already read and replied to.
 *
 * The edit carries only the mentions it **newly adds** (Buzz's
 * `diffAddedMentionPubkeys`). A typo fix that leaves the mention set alone
 * carries no `p` tags and therefore re-wakes nobody: being notified twice for
 * one mention because somebody fixed a comma is how people turn notifications
 * off.
 */
export const edit = mutation({
  args: { ...scopeArgs, channelId: v.string(), targetId: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    return await editMessageCore(ctx, scope, args);
  },
});

/**
 * Editing, for a caller that has something to carry with the new text.
 *
 * Extracted from the mutation above for one reason, and it is the reason
 * `postMessageCore` exists too: an edit *replaces the media tags* of the message
 * it overlays (`timeline.applyEditTagOverlay` — media only, everything else is
 * what the message is rather than what it says). So an edit that cannot carry
 * `imeta` tags is not a narrower edit, it is an edit that **deletes every
 * attachment on the message**, silently, in a log that does not rewrite. The
 * media surface re-emits the full set through `extraTags`; a plain text edit
 * passes none and behaves exactly as it did before.
 *
 * `extraTags` is an allow-list of one name, applied by the caller
 * (`buzz/media.ts` filters to `imeta` before calling). Nothing here merges a
 * caller's tags into the thread markers or the room tag, which is the injection
 * defence §2.7 names.
 */
export async function editMessageCore(
  ctx: MutationCtx,
  scope: Scope,
  input: {
    channelId: string;
    targetId: string;
    body: string;
    extraTags?: readonly string[][];
  },
): Promise<{ eventId: string }> {
  const { subject, channel, membership } = await requireChannelAccess(
    ctx,
    scope,
    input.channelId,
  );
  requireWritable(channel, membership);
  if (input.body.trim().length === 0) {
    throw new ConvexError("An edited message still needs something in it");
  }

  const principal = await userPrincipal(ctx, subject);
  const actor = principal.actor;
  const authorPubkey = await requireOwnPubkey(ctx, principal);
  const target = await requireTarget(ctx, scope, channel, input.targetId, authorPubkey);

  if (!EDITABLE_KINDS.has(target.kind)) {
    throw new ConvexError("That is not an editable message");
  }
  if (target.pubkey !== authorPubkey) {
    throw new ConvexError("Only the author of a message can edit it");
  }

  const before = new Set(
    target.tags.filter((tag) => tag[0] === "p" && tag[1]).map((tag) => tag[1]),
  );
  const mentions = await resolveMentions(ctx, input.body, authorPubkey);
  const added = mentions.filter((pubkey) => !before.has(pubkey));

  const published = await publishOrThrow(ctx, {
    actor,
    scope,
    kind: KIND_STREAM_MESSAGE_EDIT,
    tags: [
      ["h", channel.channelId],
      ["e", target.eventId],
      ...added.map((pubkey) => ["p", pubkey]),
      ...(input.extraTags ?? []),
    ],
    content: input.body,
  });
  return { eventId: published.eventId };
}

/**
 * Delete a message.
 *
 * Two halves, both required. The **9005** is the record: who removed what, kept
 * forever, so "where did that go" has an answer. The **soft delete** on the row
 * is the effect: a deleted message's content stops being served at all, rather
 * than being served and hidden by a client — the log is read by agents too, and
 * a rule that only the renderer enforces is not a rule.
 *
 * Authorship or moderation, exactly as Buzz has it: an author may always delete
 * their own, otherwise it takes an owner or an admin **of this room**. Note what
 * this deliberately does *not* reach for: the community-governor fallback in
 * `channels.mayGovernChannel`, which that file does not export. Copying it here
 * would be a second answer to a governance question that has one, and the two
 * would drift the first time either changed.
 */
export const remove = mutation({
  args: { ...scopeArgs, channelId: v.string(), targetId: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel, membership } = await requireChannelAccess(
      ctx,
      scope,
      args.channelId,
    );
    const active = requireMember(channel, membership);

    const principal = await userPrincipal(ctx, subject);
    const actor = principal.actor;
    const actorPubkey = await requireOwnPubkey(ctx, principal);
    const target = await requireTarget(ctx, scope, channel, args.targetId, actorPubkey);

    const mine = target.pubkey === actorPubkey;
    const moderator = active.role === "owner" || active.role === "admin";
    if (!mine && !moderator) {
      throw new ConvexError(
        "Only the author of a message, or one of this channel's owners and admins, can delete it",
      );
    }

    await publishOrThrow(ctx, {
      actor,
      scope,
      kind: KIND_NIP29_DELETE_EVENT,
      tags: [
        ["h", channel.channelId],
        ["e", target.eventId],
      ],
      content: "",
    });
    await ctx.db.patch(target._id, { deletedAt: Date.now() });

    // The tombstone the transcript shows in its place (§2.10). Relay-signed,
    // because "this was removed, by them" is a statement about the room that a
    // member must not be able to write.
    await publishOrThrow(
      ctx,
      asRelay(scope, {
        kind: KIND_SYSTEM_MESSAGE,
        tags: [["h", channel.channelId]],
        content: JSON.stringify({
          type: "message_deleted",
          actor: actorPubkey,
          target: target.pubkey,
        }),
      }),
    );

    return { removed: true };
  },
});

// ---------------------------------------------------------------------------
// Reactions (§3.2)
// ---------------------------------------------------------------------------

/**
 * The reader's own live reaction of one emoji on one message, if any.
 *
 * Found through the `#e` tag index, capped: a message everybody reacted to has a
 * tag row per reaction, and "did I already react" must not be able to load all
 * of them.
 */
async function myReaction(
  ctx: MutationCtx,
  scope: Scope,
  targetId: string,
  pubkey: string,
  emoji: string,
): Promise<EventRow | null> {
  const tagRows = await ctx.db
    .query("buzzEventTags")
    .withIndex("by_tag_kind", (q) =>
      q
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("name", "e")
        .eq("value", targetId)
        .eq("kind", KIND_REACTION),
    )
    .take(REACTION_SCAN);
  for (const tagRow of tagRows) {
    const row = await eventById(ctx, scope, tagRow.eventId);
    if (!row || !isLive(row)) continue;
    if (row.pubkey !== pubkey) continue;
    if (row.content !== emoji) continue;
    return row;
  }
  return null;
}

function normalizeEmoji(raw: string): string {
  const emoji = raw.trim();
  if (emoji.length === 0) throw new ConvexError("A reaction needs an emoji");
  // `validateEvent` enforces the same 64-character bound; checking here means the
  // refusal names the field a person actually touched.
  if ([...emoji].length > 64) throw new ConvexError("That is not an emoji");
  return emoji;
}

/**
 * React to a message.
 *
 * The kind-7 carries **no `h` tag on purpose** (§5.2): a reaction's room is
 * derived from the message it points at, so a reaction cannot name a room its
 * target is not in. `publishCore` resolves it, and refuses a target it cannot
 * find — which, combined with `requireTarget` above, is what makes a reaction to
 * a message you cannot see a refusal rather than a way to probe for one.
 *
 * Idempotent: reacting twice with the same emoji is the same act, so the second
 * call finds the first reaction and returns it instead of adding a second row
 * the projector would have to collapse.
 */
export const react = mutation({
  args: { ...scopeArgs, channelId: v.string(), targetId: v.string(), emoji: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireChannelAccess(ctx, scope, args.channelId);
    return await reactCore(
      ctx,
      scope,
      args.channelId,
      await userPrincipal(ctx, subject),
      args,
    );
  },
});

/** Reacting, for anybody. */
export async function reactCore(
  ctx: MutationCtx,
  scope: Scope,
  channelId: string,
  principal: ChannelPrincipal,
  input: { targetId: string; emoji: string },
): Promise<{ eventId: string; added: boolean }> {
  const { channel, membership } = await resolveChannelForActor(
    ctx,
    scope,
    channelId,
    principal.actorId,
  );
  requireWritable(channel, membership);

  const actorPubkey = await requireOwnPubkey(ctx, principal);
  const target = await requireTarget(ctx, scope, channel, input.targetId, actorPubkey);
  const emoji = normalizeEmoji(input.emoji);

  const existing = await myReaction(ctx, scope, target.eventId, actorPubkey, emoji);
  if (existing) return { eventId: existing.eventId, added: false };

  const published = await publishOrThrow(ctx, {
    actor: principal.actor,
    scope,
    kind: KIND_REACTION,
    tags: [["e", target.eventId]],
    content: emoji,
  });
  return { eventId: published.eventId, added: true };
}

/**
 * Take a reaction back.
 *
 * NIP-09: the retraction is a kind-5 naming the reaction event, and the reaction
 * row is soft-deleted so it stops being served. Removing a reaction nobody made
 * is not an error — a toggle that has already been toggled means the same thing
 * it did the first time.
 */
export const unreact = mutation({
  args: { ...scopeArgs, channelId: v.string(), targetId: v.string(), emoji: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireChannelAccess(ctx, scope, args.channelId);
    return await unreactCore(
      ctx,
      scope,
      args.channelId,
      await userPrincipal(ctx, subject),
      args,
    );
  },
});

/** Taking a reaction back, for anybody. */
export async function unreactCore(
  ctx: MutationCtx,
  scope: Scope,
  channelId: string,
  principal: ChannelPrincipal,
  input: { targetId: string; emoji: string },
): Promise<{ removed: boolean }> {
  const { channel, membership } = await resolveChannelForActor(
    ctx,
    scope,
    channelId,
    principal.actorId,
  );
  requireWritable(channel, membership);

  const actorPubkey = await requireOwnPubkey(ctx, principal);
  const target = await requireTarget(ctx, scope, channel, input.targetId, actorPubkey);
  const emoji = normalizeEmoji(input.emoji);

  const existing = await myReaction(ctx, scope, target.eventId, actorPubkey, emoji);
  if (!existing) return { removed: false };

  await publishOrThrow(ctx, {
    actor: principal.actor,
    scope,
    kind: KIND_DELETION,
    tags: [["e", existing.eventId]],
    content: "",
  });
  await ctx.db.patch(existing._id, { deletedAt: Date.now() });
  return { removed: true };
}
