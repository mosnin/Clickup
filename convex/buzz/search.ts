// Search — spec 01 §6, 06-protocol §12.
//
// The load-bearing decision was made somewhere else and this file only has to
// not undo it: **privacy-sensitive kinds are unsearchable at the storage layer**
// (§16.16). `log.publishCore` writes `searchText` only for the kinds in
// `SEARCHABLE_KINDS`, so an event outside that allowlist has no entry in the
// `search_content` index at all. There is nothing here that excludes it, because
// there is nothing here to exclude: it was never indexed. That is the whole
// difference between a privacy boundary and a filter somebody has to remember —
// a post-query exclusion leaks the first time a call site forgets it, and it
// leaks through result counts even when nobody forgets.
//
// What this file *does* have to get right is §16.12, and search is the exact
// place it is usually got wrong: **one per-event visibility function on every
// read surface, and the filter-level gates run before the search branch.** A hit
// arrives from an index rather than from a channel read, so none of the checks
// that a timeline read performs on the way down the hierarchy have happened. The
// order below is therefore fixed and stated out loud:
//
//   1. `requireScopeAccess` — the tenancy fence, before anything is read.
//   2. `globalFilterGateFailure` — the filter-level gates, before the index is
//      touched at all. Today they pass trivially (no searchable kind is gated);
//      they are here so that the day one is added, search fails loudly instead
//      of quietly answering.
//   3. the search branch — one index query per (kind, channel).
//   4. per hit: the scope again, then the room's own visibility, then
//      `eventVisibleToReader`.
//
// Step 4 is not belt-and-braces about step 1; the index cannot express any of
// it. Convex search indexes take equality filters on enumerated fields only
// (`scopeId`, `channelId`, `kind`), so "rooms this person is in" is not
// expressible as a filter and *has* to be applied to the hits. Buzz says the
// same thing about its own engine: "permission filtering is the caller's job —
// buzz-search returns candidate hits; the relay refetches each canonically and
// re-runs the access predicate. Search can never widen visibility."
//
// The operator grammar (`from:`, `in:`, `after:`, `before:`) is not here. It is
// pure and it lives in `src/lib/buzz/search-query.ts`, which the client parses
// and resolves before calling — so what arrives here is already a structured
// question, and an operator the client could not resolve produces no call at
// all rather than a widened one.

import { ConvexError, v } from "convex/values";
import { query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import { requireScopeAccess } from "../_authz";
import { SEARCHABLE_KINDS, kindSpec } from "./_kinds";
import {
  eventVisibleToReader,
  globalFilterGateFailure,
  type BuzzFilter,
  type EventRow,
  type Scope,
} from "./log";
import { describePubkey, pubkeyFor } from "./identity";
import { resolveChannelForActor } from "./channels";
import { threadReferenceFrom } from "./messages";

const scopeArgs = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

// ---------------------------------------------------------------------------
// Clamps
// ---------------------------------------------------------------------------

/** §6.2 — Buzz's default page. Small on purpose: this is a ⌘K list, not a report. */
export const DEFAULT_SEARCH_LIMIT = 12;
/** §12 — `per_page` is clamped. Ours is smaller because a hit costs two reads. */
export const MAX_SEARCH_LIMIT = 100;
/** §12 — the query text is clamped before it reaches the index. */
export const MAX_QUERY_CHARS = 4096;

/**
 * How many index rows to pull per (kind, channel) before narrowing in memory.
 *
 * There has to be a multiplier because most of the predicates cannot be pushed
 * into the index: `authors`, `since`, `until`, the room's visibility and the
 * per-event gate all run over what comes back. Without headroom, a page of hits
 * that are mostly from rooms the reader is not in returns almost nothing and
 * looks like "there is nothing there".
 *
 * It is a multiplier and not "fetch everything" because the opposite failure is
 * worse: an unbounded read on the hottest table in the product.
 */
const OVERFETCH = 6;

/**
 * A ceiling on how many rooms one call may name, so the fan-out stays bounded.
 *
 * Refused rather than truncated. Silently searching the first eight of twelve
 * rooms returns a confident answer to a narrower question than the one asked,
 * and there is nothing in the response that would let the caller notice.
 */
const MAX_CHANNEL_FILTERS = 8;

// ---------------------------------------------------------------------------
// What is searched
// ---------------------------------------------------------------------------

/**
 * The kinds a *message* search reaches: the searchable allowlist, minus the
 * kinds that have no room.
 *
 * Derived from the registry rather than written out, so it cannot drift from the
 * allowlist it narrows. The exclusion is not a privacy rule — kind 0 (profiles)
 * is deliberately searchable — it is a navigation rule: §6.3 says a hit with no
 * channel is unnavigable, and a result nobody can open is a result that wastes
 * the one row of attention a search has. Finding people is a different surface
 * with a different shape, and it can read the same index when it exists.
 */
export const SEARCHABLE_MESSAGE_KINDS: readonly number[] = [...SEARCHABLE_KINDS]
  .filter((kind) => {
    const spec = kindSpec(kind);
    return spec !== undefined && spec.scope !== "global";
  })
  .sort((a, b) => a - b);

// ---------------------------------------------------------------------------
// The result shape (§6.2)
// ---------------------------------------------------------------------------

export type SearchHit = {
  eventId: string;
  kind: number;
  pubkey: string;
  content: string;
  channelId: string;
  channelName: string;
  /** Present so the result row can say "#design" or a DM's members. */
  channelDisplayName: string;
  /** Seconds, as everywhere else in the log. */
  createdAt: number;
  /** The thread this message lives in, if any — §6.3 carries it into the link. */
  threadRootId?: string;
  authorName: string;
  authorIsAgent: boolean;
};

export type SearchResponse = {
  hits: SearchHit[];
  /** How many hits survived every gate. Never a count of what was *indexed*. */
  found: number;
  /**
   * Whether an index page was filled, i.e. there may be more behind this answer.
   *
   * Named for what it is rather than "hasMore", because there is no cursor: a
   * relevance-ordered index cannot be paged stably while the log is being
   * written to, and a "load more" that returns overlapping results is worse than
   * one that is not offered. The surface says "narrow your search" instead.
   */
  truncated: boolean;
};

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

/**
 * Search the messages of one community.
 *
 * `text` is the free text left after the client stripped the operators;
 * `channelIds` / `authors` / `since` / `until` are what those operators resolved
 * to. An empty `text` short-circuits with no database round trip (§12) — a
 * full-text search with no terms either matches everything or nothing depending
 * on the engine, and neither is an answer to what was asked.
 */
export const messages = query({
  args: {
    ...scopeArgs,
    text: v.string(),
    channelIds: v.optional(v.array(v.string())),
    authors: v.optional(v.array(v.string())),
    since: v.optional(v.number()),
    until: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SearchResponse> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };

    // 1. The tenancy fence, first, exactly as every other read surface does it.
    //    Row zero (§15): the community comes from the caller's authenticated
    //    access to a scope, never from anything in the query string.
    const { subject } = await requireScopeAccess(ctx, scope);
    return await searchMessagesCore(
      ctx,
      scope,
      { actorType: "user", actorId: subject },
      args,
    );
  },
});

/**
 * The search itself, once the caller's right to the community is settled.
 *
 * Split so a key-authenticated agent searches through the *same* function — the
 * same gate before the index branch, the same per-room visibility, the same
 * per-event gate. A second search would be the worst possible place for a
 * missing clause: an index answers instantly and confidently, and nothing in a
 * result row says which rung was skipped to produce it.
 *
 * **The caller owes the tenancy fence** — `requireScopeAccess` for a person,
 * `_agentAuth`'s community check for an agent — and this function owes
 * everything downstream of it.
 */
export async function searchMessagesCore(
  ctx: QueryCtx,
  scope: Scope,
  reader: { actorType: "user" | "agent"; actorId: string },
  args: {
  text: string;
  channelIds?: string[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  },
): Promise<SearchResponse> {
  const readerPubkey = (await pubkeyFor(ctx, reader.actorType, reader.actorId)) ?? "";

  const text = normalizeQueryText(args.text);
  const limit = clampLimit(args.limit);
  if (text.length === 0 || limit === 0) {
    return { hits: [], found: 0, truncated: false };
  }

  const channelIds = args.channelIds ?? [];
  if (channelIds.length > MAX_CHANNEL_FILTERS) {
    throw new ConvexError(
      `invalid: a search may name at most ${MAX_CHANNEL_FILTERS} channels`,
    );
  }
  const authors = args.authors ?? [];

  // 2. The filter-level gates, **before the search branch** (§16.12).
  //
  //    This is the rung that is skipped in every implementation that gets this
  //    wrong, and the reason is that it looks like dead code: no kind in
  //    `SEARCHABLE_MESSAGE_KINDS` is gated, so the gate passes. That is
  //    exactly why it is here. `SEARCHABLE_KINDS` is an allowlist somebody
  //    will one day extend, and the moment a `#p`-gated or author-only kind
  //    joins it, this call starts throwing — loudly, on the first search —
  //    instead of the index quietly answering with somebody else's mail.
  const gateFilter: BuzzFilter = {
    kinds: [...SEARCHABLE_MESSAGE_KINDS],
    ...(authors.length > 0 ? { authors } : {}),
    ...(args.since !== undefined ? { since: args.since } : {}),
    ...(args.until !== undefined ? { until: args.until } : {}),
  };
  const gateFailure = globalFilterGateFailure(gateFilter, readerPubkey);
  if (gateFailure) throw new ConvexError(gateFailure);

  // 3. The search branch.
  const fetchPerQuery = Math.min(limit * OVERFETCH, MAX_SEARCH_LIMIT * OVERFETCH);
  const seen = new Map<string, EventRow>();
  let truncated = false;

  for (const kind of SEARCHABLE_MESSAGE_KINDS) {
    const pages: EventRow[][] = [];
    if (channelIds.length > 0) {
      for (const channelId of channelIds) {
        pages.push(
          await ctx.db
            .query("buzzEvents")
            .withSearchIndex("search_content", (q) =>
              q
                .search("searchText", text)
                // `scopeId` is the only tenancy field the index carries, and
                // that is safe for the same reason the vector index is: a
                // Clerk subject and a Convex workspace id can never be the
                // same string. It is still re-checked per hit below — the
                // fence is not allowed to depend on that argument staying
                // true.
                .eq("scopeId", scope.scopeId)
                .eq("kind", kind)
                .eq("channelId", channelId),
            )
            .take(fetchPerQuery),
        );
      }
    } else {
      pages.push(
        await ctx.db
          .query("buzzEvents")
          .withSearchIndex("search_content", (q) =>
            q.search("searchText", text).eq("scopeId", scope.scopeId).eq("kind", kind),
          )
          .take(fetchPerQuery),
      );
    }
    for (const page of pages) {
      if (page.length >= fetchPerQuery) truncated = true;
      for (const row of page) seen.set(row.eventId, row);
    }
  }

  // 4. Per hit: everything the index could not express.
  const channelCache = new Map<string, ChannelFacts | null>();
  const authorCache = new Map<string, { name: string; isAgent: boolean }>();
  const hits: SearchHit[] = [];

  for (const row of seen.values()) {
    // The tenancy fence again, on the row rather than on the request.
    if (row.scopeType !== scope.scopeType || row.scopeId !== scope.scopeId) continue;
    if (row.deletedAt !== undefined || row.supersededAt !== undefined) continue;
    // Two restatements of the allowlist, and both are cheap. A row whose kind
    // is not searchable, or which somehow carries no `searchText`, cannot have
    // come out of that index — so if one ever does, it is a bug and it stops
    // here rather than in somebody's results.
    if (!SEARCHABLE_KINDS.has(row.kind) || row.searchText === undefined) continue;
    if (!SEARCHABLE_MESSAGE_KINDS.includes(row.kind)) continue;
    if (row.channelId === undefined) continue;

    if (authors.length > 0 && !authors.includes(row.pubkey)) continue;
    if (args.since !== undefined && row.createdAt < args.since) continue;
    if (args.until !== undefined && row.createdAt > args.until) continue;

    // The room's own visibility. A private room's messages must never surface
    // to a non-member, and the index has no idea who is in what.
    const facts = await channelFacts(ctx, scope, row.channelId, reader.actorId, channelCache);
    if (facts === null) continue;

    // The one per-event visibility function (§16.12). It runs on a search hit
    // for the same reason it runs on a timeline row: this is a read surface,
    // and there is exactly one answer to "may this reader see this event".
    if (!eventVisibleToReader(row, readerPubkey)) continue;

    let author = authorCache.get(row.pubkey);
    if (!author) {
      const described = await describePubkey(ctx, row.pubkey);
      author = {
        name: described?.name ?? "Someone",
        isAgent: described?.isAgent ?? false,
      };
      authorCache.set(row.pubkey, author);
    }

    const thread = threadReferenceFrom(row.tags);
    hits.push({
      eventId: row.eventId,
      kind: row.kind,
      pubkey: row.pubkey,
      content: row.content,
      channelId: row.channelId,
      channelName: facts.name,
      channelDisplayName: facts.displayName,
      createdAt: row.createdAt,
      ...(thread.rootId ? { threadRootId: thread.rootId } : {}),
      authorName: author.name,
      authorIsAgent: author.isAgent,
    });
  }

  // Relevance decided which hits survived — Convex returns a search index in
  // relevance order, and the overfetch is taken from the front of it. Recency
  // decides the order they are *shown* in, because the results are merged from
  // several index reads (one per kind, one per room) and there is no
  // cross-read score to merge on. Ties break on the event id, so two messages
  // in the same second are ordered the same way for everybody.
  hits.sort((a, b) => b.createdAt - a.createdAt || a.eventId.localeCompare(b.eventId));

  return {
    found: hits.length,
    hits: hits.slice(0, limit),
    truncated: truncated || hits.length > limit,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 0), MAX_SEARCH_LIMIT);
}

/**
 * §12's clamp, restated server-side.
 *
 * The client clamps too (`searchTextForIndex`), and this is not redundancy for
 * its own sake: the client's copy is what keeps the input responsive, and this
 * one is what makes the bound true for callers that are not that client.
 */
function normalizeQueryText(raw: string): string {
  return raw
    .replace(/\0/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_QUERY_CHARS);
}

type ChannelFacts = { name: string; displayName: string };

/**
 * "May this reader see this room, and what is it called" — cached per query.
 *
 * `requireChannelAccess` is the *one* answer to the first half (it is what the
 * transcript, the header and the member list all ask), so this catches its
 * refusal rather than restating its rule. A second copy of "archived rooms are
 * members-only, private rooms are members-only, DMs are participants-only" is a
 * copy that will disagree with the first one the day somebody adds a fifth
 * clause — and the disagreeing copy would be the one in front of a search index.
 *
 * The cache matters: a page of hits is typically a handful of rooms, and without
 * it this is two reads per hit instead of two reads per room.
 */
async function channelFacts(
  ctx: QueryCtx,
  scope: Scope,
  channelId: string,
  actorId: string,
  cache: Map<string, ChannelFacts | null>,
): Promise<ChannelFacts | null> {
  const cached = cache.get(channelId);
  if (cached !== undefined) return cached;
  let facts: ChannelFacts | null = null;
  try {
    // `resolveChannelForActor` rather than `requireChannelAccess`: the tenancy
    // fence already ran once, at the top of the call, and re-running it per room
    // would be the same answer paid for again — while this half is the one that
    // differs by *actor* and must not.
    const { channel } = await resolveChannelForActor(ctx, scope, channelId, actorId);
    facts = { name: channel.name, displayName: channel.displayName };
  } catch {
    // "Channel not found" is what a room the reader may not see reports, and it
    // is deliberately indistinguishable from one that does not exist. Here it
    // means the same thing either way: this hit is not theirs.
    facts = null;
  }
  cache.set(channelId, facts);
  return facts;
}
