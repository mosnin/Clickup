// The forum: posts that are meant to be read later.
//
// **A forum post is a message with a different kind.** That is the whole of
// 03-workflows-projects §5.1 and it is why this file is short: kind 45001 is a
// top-level post, kind 45003 is a comment on one, and both travel the *same*
// transport as a chat message — `postMessageCore` writes them, `readThreadPage`
// reads a post and its comments, a 40003 edits one, a 9005 deletes one, a kind-7
// reacts to one. Nothing about reactions, editing or deletion is reimplemented
// here; `tests/buzz-forum.test.ts` proves that by driving `buzz/messages:react`,
// `:edit` and `:remove` against a post and asserting they land.
//
// What is genuinely different is the *reading*, and it is one sentence: a post is
// a **card in a list**, a message is a line in a transcript. So:
//
//   - The list is an index range over one kind in one room
//     (`by_scope_channel_kind`), not the room's whole timeline. A forum channel
//     still has a chat timeline, and a room where every post also appeared in the
//     transcript would be one surface pretending to be two.
//   - Nothing in the chat transcript draws a 45001 or a 45003. That is enforced
//     by `TIMELINE_CONTENT_KINDS` (server) and by the projector's default content
//     set (`src/lib/buzz/timeline.ts`), both of which exclude them — the forum
//     surfaces opt in explicitly. The two views cannot leak into each other by
//     forgetting a filter, because neither view has one to forget.
//   - A post carries a **title**, in a `["subject", …]` tag — the same tag the
//     forge vocabulary in this spec already uses for a pull request's title
//     (§2.2). A title is not content: putting it in `content` would mean the
//     preview repeated it, an agent reading the post could not tell the two
//     apart, and the 200-character card preview would spend its budget on a
//     heading. It is not indexed either (`INDEXED_TAGS` does not carry
//     `subject`), because nothing looks a post up *by* its title — the title is
//     read off the event once it has been found, which is exactly the rule
//     `_kinds.ts` states for the un-indexed tags.
//
// **The reads return raw events, not rendered cards**, for the reason
// `messages.ts` gives at length: the fold from "these events" to "what a person
// reads" is a pure function over an array, and a server that folded could not
// answer an optimistic row and could not be tested without a database. So a post
// list is the 45001s of a page plus the edits, deletions and reactions that
// overlay them, plus one small thing the projector genuinely cannot compute —
// how many replies a post has, when the last one landed, and who wrote them,
// which live outside the loaded window by construction.
//
// Sorting is deliberately **not** here. It is a pure function over cards
// (`src/components/chat/forum/model.ts`), because ordering by "most recently
// replied to" is ordering by a number derived from other rows, which no index
// can express — so the server pages by creation time and the surface orders what
// it has. One implementation, pure, tested in both directions.

import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireChannelAccess, type ChannelPrincipal } from "./channels";
import { describePubkey, pubkeyFor } from "./identity";
import type { Scope } from "./log";
import type { NostrEvent } from "./_nostr";
import type { Actor } from "../_agentAuth";
// Every one of these is reused rather than restated. `pageWindow` is the cursor
// that cannot skip a second (a forum import can easily put fifty posts in one),
// `auxEventsFor` is what stops an edited post rendering its original text,
// `eventVisibleInRoom` is the one per-event gate, and `postMessageCore` is the
// single write path that parses mentions, derives the thread root, bumps the
// room's clock and wakes the right people.
import {
  auxEventsFor,
  clampLimit,
  decodeCursor,
  eventById,
  eventVisibleInRoom,
  pageWindow,
  postMessageCore,
  readThreadPage,
} from "./messages";
import { toNostrEvent, type EventRow } from "./log";

// ---------------------------------------------------------------------------
// The kinds (§5.1)
// ---------------------------------------------------------------------------

/** A top-level forum post. Registered in `_kinds.ts`; `h` required, gate open. */
export const KIND_FORUM_POST = 45001;
/**
 * A vote on a post.
 *
 * Reserved by the spec and **deliberately unbuilt**: §5.1 says it "has no client
 * surface in this tree", and a vote button that writes an event nothing counts is
 * worse than no vote button. Named here so the next phase finds the number rather
 * than inventing a second one.
 */
export const KIND_FORUM_VOTE = 45002;
/** A comment on a post. A reply, in every sense `messages.ts` already means. */
export const KIND_FORUM_COMMENT = 45003;

/** The tag a post's title rides in. See the header. */
export const SUBJECT_TAG = "subject";

/**
 * How long a title may be.
 *
 * Long enough for a real sentence, short enough that a card is a card. A title
 * that wraps to four lines is a body with delusions, and the composer says so
 * rather than truncating silently — truncation loses words somebody typed.
 */
export const MAX_TITLE_CHARS = 200;

/** Posts per page. Buzz asks for 50; a card is taller than a message row. */
const DEFAULT_POST_PAGE = 20;
const MAX_POST_PAGE = 50;

/**
 * How many comments one card's summary will look at.
 *
 * A cap rather than a count, because "N replies" on a list of twenty cards must
 * not be able to read a thread of ten thousand. When it is hit the card says
 * `capped` and the surface draws "60+", which is honest — a number that silently
 * stops at sixty is a number that lies at exactly the sizes it matters.
 */
const REPLIES_PER_CARD = 60;

/** How many faces a summary carries. Buzz's `MAX_SUMMARY_PARTICIPANTS`. */
const MAX_SUMMARY_PARTICIPANTS = 3;

const scopeArgs = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

type ChannelRow = Doc<"buzzChannels">;

// ---------------------------------------------------------------------------
// Titles — pure, so the grammar can be read without a database
// ---------------------------------------------------------------------------

/**
 * A title, as it will be stored: whitespace collapsed, trimmed, capped.
 *
 * Newlines collapse rather than being rejected, because a title arrives from a
 * paste as often as from typing and refusing one for containing a line break is
 * a refusal about the clipboard. An empty result is refused by the caller — a
 * post with no title is the one thing a post is not.
 */
export function normalizeTitle(raw: string): string {
  return raw.replace(/\s+/gu, " ").trim().slice(0, MAX_TITLE_CHARS);
}

/** The tag a normalized title becomes. One place, so the reader below matches. */
export function subjectTags(title: string): string[][] {
  return [[SUBJECT_TAG, title]];
}

/**
 * The title on an event, or the empty string.
 *
 * **First** subject tag wins, and the choice is the same one `threadReferenceFrom`
 * makes about `root`: an author who can append a second tag must not be able to
 * choose which one a reader believes. Empty rather than a fallback to the body's
 * first line — a derived title that changes when somebody edits a paragraph is a
 * title the log never agreed to.
 */
export function titleFromTags(tags: readonly string[][]): string {
  for (const tag of tags) {
    if (tag[0] === SUBJECT_TAG && typeof tag[1] === "string") return tag[1];
  }
  return "";
}

// ---------------------------------------------------------------------------
// The wire shapes
// ---------------------------------------------------------------------------

/**
 * What a card knows that the projector cannot work out.
 *
 * Reply counts are the one genuinely server-side fact in the forum: a thread's
 * replies are not in the post list's window and never will be, so a client that
 * folded its own summary would report zero on every post whose comments it had
 * not separately loaded. Everything else on a card — the edited body, the
 * reactions, whether it is yours — is folded client-side from the events below.
 */
export type ForumThreadSummary = {
  postId: string;
  replyCount: number;
  /** Seconds. 0 when nothing has replied — the surface draws no footer at all. */
  lastReplyAt: number;
  /** Pubkeys, **oldest-first**, at most three: a facepile reads left to right. */
  participants: string[];
  /** The scan hit `REPLIES_PER_CARD`; the count is a floor, not a total. */
  capped: boolean;
};

/** A resolved principal, in the shape the client projector already speaks. */
export type ForumActor = {
  pubkey: string;
  label: string;
  isAgent: boolean;
};

export type ForumPostsPage = {
  /** The 45001s of this page, plus the edits/deletions/reactions over them. */
  events: NostrEvent[];
  summaries: ForumThreadSummary[];
  actors: ForumActor[];
  nextCursor?: string;
};

export type ForumThreadPage = {
  /** The post, its whole comment subtree, and the events overlaying them. */
  events: NostrEvent[];
  actors: ForumActor[];
  nextCursor?: string;
};

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * A forum channel, or a refusal.
 *
 * Refusing on a stream channel rather than answering with an empty list, because
 * the two mean different things and only one of them is true: a stream channel
 * does not *have* a post view, and an empty list says it has one and nobody has
 * used it. The channel type is immutable once created (`channels.update` cannot
 * change it), so this can never orphan posts somebody already wrote.
 */
function requireForum(channel: ChannelRow): ChannelRow {
  if (channel.channelType !== "forum") {
    throw new ConvexError("This channel is not a forum");
  }
  return channel;
}

/** The acting principal, in the shape every write path in this app takes. */
async function userActor(ctx: QueryCtx | MutationCtx, subject: string): Promise<Actor> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", subject))
    .unique();
  return { type: "user", id: subject, name: user?.name ?? user?.email ?? subject };
}

async function userPrincipal(
  ctx: QueryCtx | MutationCtx,
  subject: string,
): Promise<ChannelPrincipal> {
  return { actor: await userActor(ctx, subject), actorType: "user", actorId: subject };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Resolve a set of pubkeys to display labels, once each.
 *
 * The forum resolves names server-side where the transcript does not, and the
 * difference is not inconsistency — it is what the two surfaces are. A chat row
 * sits in a run of rows by the same person and reads fine while a profile
 * resolves; a card is a *heading and an author*, and one that says
 * `a1b2c3d4…9f0e` is not a card anybody will read. §5.5 makes the same point
 * from the other end: Buzz gathers pubkeys from post authors, **mention tags**
 * and thread-summary participants, because a mentioned person who never authored
 * a post would otherwise render as a dead chip.
 */
async function resolveActors(
  ctx: QueryCtx,
  pubkeys: Iterable<string>,
): Promise<ForumActor[]> {
  const out: ForumActor[] = [];
  const seen = new Set<string>();
  for (const pubkey of pubkeys) {
    if (!pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    const described = await describePubkey(ctx, pubkey);
    if (!described) continue;
    out.push({ pubkey, label: described.name, isAgent: described.isAgent });
  }
  return out;
}

/** Every pubkey a page of events names: authors and mention `p` tags. */
function pubkeysIn(events: readonly NostrEvent[]): Set<string> {
  const found = new Set<string>();
  for (const event of events) {
    found.add(event.pubkey);
    for (const tag of event.tags) {
      if (tag[0] === "p" && tag[1]) found.add(tag[1]);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Thread summaries
// ---------------------------------------------------------------------------

/**
 * How many comments a post has, when the last one landed, and who wrote them.
 *
 * Two properties worth stating, because both are easy to lose:
 *
 *   - It ranges `#e = postId` **filtered to kind 45003**, which is what makes it
 *     one bounded index read rather than a walk of every reaction and edit that
 *     ever pointed at the post. Nested comments are caught by the same range for
 *     free, because `messageTags` always carries the thread's root — a reply to a
 *     reply names the post as well as its parent.
 *   - It reads the rows rather than counting the tag index, because a deleted
 *     comment keeps its tag rows and loses its event. Counting the index would
 *     make "3 replies" outlive the three replies.
 */
async function summaryFor(
  ctx: QueryCtx,
  scope: Scope,
  channel: ChannelRow,
  postId: string,
  readerPubkey: string,
): Promise<ForumThreadSummary | null> {
  const tagRows = await ctx.db
    .query("buzzEventTags")
    .withIndex("by_tag_kind", (q) =>
      q
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("name", "e")
        .eq("value", postId)
        .eq("kind", KIND_FORUM_COMMENT),
    )
    // Newest first: the three faces a summary shows are the three most recent
    // repliers (§2.3), so the scan that finds them must start at the newest.
    .order("desc")
    .take(REPLIES_PER_CARD + 1);

  const capped = tagRows.length > REPLIES_PER_CARD;
  let replyCount = 0;
  let lastReplyAt = 0;
  const participants: string[] = [];
  const seen = new Set<string>();

  for (const tagRow of tagRows.slice(0, REPLIES_PER_CARD)) {
    const row = await eventById(ctx, scope, tagRow.eventId);
    if (!row || row.channelId !== channel.channelId) continue;
    if (!eventVisibleInRoom(row, readerPubkey)) continue;
    replyCount += 1;
    if (row.createdAt > lastReplyAt) lastReplyAt = row.createdAt;
    if (participants.length < MAX_SUMMARY_PARTICIPANTS && !seen.has(row.pubkey)) {
      seen.add(row.pubkey);
      participants.push(row.pubkey);
    }
  }

  if (replyCount === 0) return null;
  // Walked newest-first, displayed oldest-first — so the facepile reads in the
  // order people arrived and the most recent replier sits next to the count that
  // just changed (§2.3, and `thread-summary.ts` does the same on the client).
  return { postId, replyCount, lastReplyAt, participants: participants.reverse(), capped };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * A page of a forum's posts, newest first.
 *
 * The window is an index range over `(scope, channel, kind 45001)` — the same
 * shape `readChannelPage` uses for a room, one column narrower. It pages through
 * `pageWindow` rather than a bare `until` cursor for the reason that function
 * exists: our indexes order by the second and, inside a second, by insertion,
 * while relay order inside a second is by event id — so a page cut mid-second and
 * resumed by a `(createdAt, eventId)` cursor silently skips rows. A forum import
 * that writes fifty posts in one second is exactly that case.
 *
 * Visibility is applied *after* the window is measured, so a hidden row consumes
 * its place rather than shifting the cursor: two readers must page through the
 * same history even when they see different amounts of it.
 */
export const posts = query({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ForumPostsPage> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel } = await requireChannelAccess(ctx, scope, args.channelId);
    requireForum(channel);
    const readerPubkey = (await pubkeyFor(ctx, "user", subject)) ?? "";
    const limit = Math.min(clampLimit(args.limit ?? DEFAULT_POST_PAGE), MAX_POST_PAGE);

    const { examined, nextCursor } = await pageWindow<EventRow>({
      direction: "back",
      limit,
      cursor: decodeCursor(args.cursor),
      fetch: async (bound, take) =>
        bound === undefined
          ? await ctx.db
              .query("buzzEvents")
              .withIndex("by_scope_channel_kind", (q) =>
                q
                  .eq("scopeType", scope.scopeType)
                  .eq("scopeId", scope.scopeId)
                  .eq("channelId", channel.channelId)
                  .eq("kind", KIND_FORUM_POST)
                  .eq("supersededAt", undefined),
              )
              .order("desc")
              .take(take)
          : await ctx.db
              .query("buzzEvents")
              .withIndex("by_scope_channel_kind", (q) =>
                q
                  .eq("scopeType", scope.scopeType)
                  .eq("scopeId", scope.scopeId)
                  .eq("channelId", channel.channelId)
                  .eq("kind", KIND_FORUM_POST)
                  .eq("supersededAt", undefined)
                  .lte("createdAt", bound),
              )
              .order("desc")
              .take(take),
      fetchSecond: async (second) =>
        await ctx.db
          .query("buzzEvents")
          .withIndex("by_scope_channel_kind", (q) =>
            q
              .eq("scopeType", scope.scopeType)
              .eq("scopeId", scope.scopeId)
              .eq("channelId", channel.channelId)
              .eq("kind", KIND_FORUM_POST)
              .eq("supersededAt", undefined)
              .gte("createdAt", second)
              .lte("createdAt", second),
          )
          .order("desc")
          .collect(),
    });

    const rows = examined.filter((row) => eventVisibleInRoom(row, readerPubkey));
    const seen = new Set(rows.map((row) => row.eventId));
    // The same aux fetch the transcript uses, and for the same reason: a post
    // edited a month after it was written has its 40003 nowhere near it in the
    // log, and a card built from the window alone would show text nobody has
    // said since. Reactions ride along, so a card's pills are the room's pills.
    const aux = await auxEventsFor(ctx, channel, rows, readerPubkey, seen);

    const summaries: ForumThreadSummary[] = [];
    for (const row of rows) {
      const summary = await summaryFor(ctx, scope, channel, row.eventId, readerPubkey);
      if (summary) summaries.push(summary);
    }

    const events = [...rows, ...aux].map(toNostrEvent);
    const wanted = pubkeysIn(events);
    for (const summary of summaries) {
      for (const pubkey of summary.participants) wanted.add(pubkey);
    }

    return {
      events,
      summaries,
      actors: await resolveActors(ctx, wanted),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  },
});

/**
 * One post, its whole comment subtree, and the events overlaying them.
 *
 * Straight through `readThreadPage` — the post *is* the thread root, so there is
 * nothing forum-specific about reading it. That function already refuses a head
 * in another room, a deleted one and a gated one with the same "not found"
 * (which of the three it is, is itself information), pages the subtree forwards
 * from the root, and fetches the aux events over everything it returns.
 *
 * The only thing added is the names, for the reason `resolveActors` gives.
 */
export const post = query({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    postId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ForumThreadPage> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel } = await requireChannelAccess(ctx, scope, args.channelId);
    requireForum(channel);
    const readerPubkey = (await pubkeyFor(ctx, "user", subject)) ?? "";

    const head = await eventById(ctx, scope, args.postId);
    // A chat message's id handed to the post route must read as "no such post",
    // not as a post with no title: the two surfaces do not share ids in either
    // direction, and answering with a message here is precisely the leak this
    // phase is meant not to have.
    if (!head || head.kind !== KIND_FORUM_POST) throw new ConvexError("Post not found");

    const page = await readThreadPage(ctx, scope, channel, readerPubkey, {
      rootId: args.postId,
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });

    return {
      events: page.events,
      actors: await resolveActors(ctx, pubkeysIn(page.events)),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    };
  },
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Start a discussion.
 *
 * Everything except the title and the kind is `postMessageCore`'s: membership and
 * the archived-room refusal, the author's own signing key, mentions parsed from
 * the body, the room's clock, and the notification fan-out. A post that woke
 * nobody it named would be the failure mode of a second write path, and there
 * isn't one.
 */
export const createPost = mutation({
  args: { ...scopeArgs, channelId: v.string(), title: v.string(), body: v.string() },
  handler: async (ctx, args): Promise<{ eventId: string; createdAt: number }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel } = await requireChannelAccess(ctx, scope, args.channelId);
    requireForum(channel);

    const title = normalizeTitle(args.title);
    // Refused rather than derived from the body. A post whose title is its first
    // sentence changes its own name every time somebody fixes a typo, and a
    // reader who came back for "the migration one" can no longer find it.
    if (title.length === 0) throw new ConvexError("A post needs a title");

    return await postMessageCore(
      ctx,
      scope,
      args.channelId,
      await userPrincipal(ctx, subject),
      {
        body: args.body,
        kind: KIND_FORUM_POST,
        extraTags: subjectTags(title),
      },
    );
  },
});

/**
 * Comment on a post.
 *
 * Argument-compatible with `buzz/messages:post` on purpose: the comment box on a
 * post is the room's composer with one thing changed, the function it calls, and
 * a composer that needed a differently-shaped argument would be a second
 * composer inside a week. `parentId` is optional in the validator for exactly
 * that reason and required in fact — a comment with nothing to comment on is
 * refused here rather than filed as a second post.
 *
 * `rootId` is accepted and **verified rather than believed** by the core: it is
 * derived from the parent's own tags and a caller who disagrees is refused,
 * because a wrong root does not fail loudly, it files the comment under a thread
 * nobody is reading, forever, in a log that does not rewrite.
 */
export const comment = mutation({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    body: v.string(),
    parentId: v.optional(v.string()),
    rootId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ eventId: string; createdAt: number }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel } = await requireChannelAccess(ctx, scope, args.channelId);
    requireForum(channel);
    if (!args.parentId) throw new ConvexError("A comment needs the post it is on");

    return await postMessageCore(
      ctx,
      scope,
      args.channelId,
      await userPrincipal(ctx, subject),
      {
        body: args.body,
        parentId: args.parentId,
        ...(args.rootId !== undefined ? { rootId: args.rootId } : {}),
        kind: KIND_FORUM_COMMENT,
      },
    );
  },
});
