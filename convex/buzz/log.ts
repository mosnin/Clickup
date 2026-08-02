// The log: one way in, one way out.
//
// Everything the Chat dashboard knows is an event in `buzzEvents`, and this file
// is the only module allowed to put one there or take one out. That is the whole
// design. Buzz's own hard-won shape (06-protocol.md §16) is a list of rules that
// are each one forgotten call site from being false, so the answer is to have
// very few call sites: one write core, one read core, one per-event visibility
// function that every read runs (§16.12).
//
// The write core takes an explicit `Actor`. A person posting a message and an
// agent posting a message go through the same function with a different actor —
// the house rule (CLAUDE.md, "one core per write path"), and here it is also a
// protocol rule: an agent's events are signed by the agent's own key and are
// distinguishable in the log forever, without trusting a boolean column.
//
// Tenancy is `_authz.requireScopeAccess`, never a hand-rolled membership query.
// Buzz's "row zero" (§15) says a request's community comes from the server and
// never from the client; ours is the caller's authenticated access to a scope,
// and there is exactly one function in this app that answers that.

import { ConvexError, v } from "convex/values";
import type { IndexRange } from "convex/server";
import { mutation, query } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireScopeAccess } from "../_authz";
import type { Actor } from "../_agentAuth";
import {
  isEphemeral,
  replacementKey,
  signEvent,
  supersedes,
  type NostrEvent,
} from "./_nostr";
import {
  AUTHOR_ONLY_KINDS,
  INDEXED_TAGS,
  KIND_AGENT_ENGRAM,
  P_GATED_KINDS,
  RESULT_GATED_KINDS,
  SEARCHABLE_KINDS,
  SHARED_GATED_KINDS,
  eventIsShared,
  validateEvent,
  type KindSpec,
} from "./_kinds";
import { pubkeyFor, requireSigningIdentity } from "./identity";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type Scope = { scopeType: "user" | "workspace"; scopeId: string };

export type EventRow = Doc<"buzzEvents">;

/**
 * A NIP-01 filter, in the shape a Convex validator can express.
 *
 * The wire form keys tag filters as `#e` / `#p` / `#h`, which no validator can
 * describe, so they arrive as a list of `{name, values}`. Same semantics, and
 * `nostrFilterKeys` converts back for anything that needs the wire shape.
 */
export type BuzzFilter = {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  tags?: { name: string; values: string[] }[];
};

const filterValidator = v.object({
  ids: v.optional(v.array(v.string())),
  authors: v.optional(v.array(v.string())),
  kinds: v.optional(v.array(v.number())),
  since: v.optional(v.number()),
  until: v.optional(v.number()),
  limit: v.optional(v.number()),
  tags: v.optional(v.array(v.object({ name: v.string(), values: v.array(v.string()) }))),
});

const scopeArgs = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

/** §7.1: a page is 1000 events, and an absent `limit` means the same. */
export const DEFAULT_MAX_PAGE_LIMIT = 1000;
/** §8.1: more than ten filters on one read is a parse-level rejection. */
export const MAX_FILTERS = 10;

export type PublishOutcome =
  | { status: "inserted"; event: NostrEvent; docId: Id<"buzzEvents"> }
  /** Already had it. Not an error — resubmitting a signed event is idempotent. */
  | { status: "duplicate"; event: NostrEvent }
  /** Lost the replacement race (§6.2). **Must not fan out.** */
  | { status: "dominated"; event: NostrEvent }
  /** 20000–29999: signed, handed back for fan-out, never written (§16.22). */
  | { status: "ephemeral"; event: NostrEvent };

// ---------------------------------------------------------------------------
// Small pure helpers over a stored row
// ---------------------------------------------------------------------------

/** The row, back in NIP-01 shape. What every read surface returns. */
export function toNostrEvent(row: EventRow): NostrEvent {
  return {
    id: row.eventId,
    pubkey: row.pubkey,
    created_at: row.createdAt,
    kind: row.kind,
    tags: row.tags,
    content: row.content,
    sig: row.sig,
  };
}

function tagValuesOf(tags: readonly string[][], name: string): string[] {
  return tags.filter((t) => t[0] === name && t[1] !== undefined).map((t) => t[1]);
}

function filterTagValues(filter: BuzzFilter, name: string): string[] {
  return (filter.tags ?? []).filter((t) => t.name === name).flatMap((t) => t.values);
}

// ---------------------------------------------------------------------------
// The write path
// ---------------------------------------------------------------------------

export type PublishArgs = {
  actor: Actor;
  scope: Scope;
  kind: number;
  tags: string[][];
  content: string;
  /**
   * Seconds. Only a system/backfill caller should ever set this: NIP-01 lets an
   * author choose its own timestamp, but `created_at` decides replacement (§6),
   * so a client that picks its own can pin a coordinate at the head for the
   * whole ±15 minute drift window. The public mutation does not expose it.
   */
  createdAt?: number;
};

/**
 * The timestamp a replaceable event must carry to actually replace its head.
 *
 * Returns `now` for anything that replaces nothing, and `max(now, head + 1)`
 * otherwise. Costs one indexed read on the replaceable path and nothing at all
 * on the ordinary one — a message never reaches it, because `replacementKey`
 * is null for regular kinds.
 */
async function nextCreatedAtFor(
  ctx: MutationCtx,
  scope: Scope,
  draft: { pubkey: string; kind: number; tags: string[][] },
  now: number,
): Promise<number> {
  const coord = replacementKey({
    pubkey: draft.pubkey,
    kind: draft.kind,
    tags: draft.tags,
    created_at: now,
    content: "",
  });
  if (!coord) return now;

  const heads = await ctx.db
    .query("buzzEvents")
    .withIndex("by_coord", (q) =>
      q
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("coord", coord)
        .eq("supersededAt", undefined),
    )
    .collect();

  let latest = now;
  for (const head of heads) latest = Math.max(latest, head.createdAt + 1);
  return latest;
}

/**
 * Validate → sign → dedupe → replace-or-insert → project tags. One transaction.
 *
 * Ordering here is Buzz's ingest pipeline (§8.4) minus the rungs our substrate
 * answers by construction. The load-bearing part is that *all* of it is one
 * transaction: because signing happens inside the mutation (D2), there is no
 * moment where an unsigned event, or an event without its tag rows, is
 * observable by a reader.
 */
export async function publishCore(
  ctx: MutationCtx,
  args: PublishArgs,
): Promise<PublishOutcome> {
  const nowMs = Date.now();
  const nowSecs = Math.floor(nowMs / 1000);
  const createdAt = args.createdAt ?? nowSecs;

  const verdict = validateEvent(
    { kind: args.kind, created_at: createdAt, tags: args.tags, content: args.content },
    { now: nowSecs, actorType: args.actor.type },
  );
  if (!verdict.ok) throw new ConvexError(verdict.reason);

  // Sign before the ephemeral branch: an ephemeral event is fanned out to other
  // clients, so it needs a real signature even though it is never stored. What
  // it must not get is a row.
  const { pubkey, secretKey } = await requireSigningIdentity(ctx, args.actor);

  // Replaceable kinds get a timestamp strictly newer than the head they are
  // replacing, and it has to happen *here*, before signing, because created_at
  // is hashed into the id and the signature.
  //
  // Why it is needed at all: created_at is SECONDS, and the domination rule
  // (§6, below) breaks a same-second tie on the lexicographically lowest event
  // id — which is a hash, so effectively a coin flip. Two edits inside one
  // second therefore keep an arbitrary one, and under load that is not rare:
  // it surfaced as an intermittently failing test that passed eight times in a
  // row on a quiet machine and failed twice in six runs while five agents were
  // building. In production it is an edit that silently does not take.
  //
  // The tie-break itself is not the bug and must not be "fixed" — it is what
  // keeps two independent replicas of this log converging on the same winner.
  // The fix is to stop producing ties we control the input to.
  //
  // Two modules had already solved this for themselves (canvases, reminders).
  // Doing it here instead means every replaceable kind gets it, including the
  // ones nobody has written yet, which is the difference between a fix and a
  // habit.
  const monotonicCreatedAt =
    args.createdAt === undefined
      ? await nextCreatedAtFor(ctx, args.scope, { pubkey, kind: args.kind, tags: args.tags }, createdAt)
      : createdAt;

  const event = signEvent(
    {
      pubkey,
      created_at: monotonicCreatedAt,
      kind: args.kind,
      tags: args.tags,
      content: args.content,
    },
    secretKey,
  );

  if (isEphemeral(args.kind)) return { status: "ephemeral", event };

  // Dedupe. An id is the hash of the event, so an identical resubmission is the
  // same row and answering "already had it" is the correct, non-error reply
  // (§6.4). Scoped, because the same signed event may legitimately exist in two
  // communities.
  const existing = await ctx.db
    .query("buzzEvents")
    .withIndex("by_scope_event_id", (q) =>
      q
        .eq("scopeType", args.scope.scopeType)
        .eq("scopeId", args.scope.scopeId)
        .eq("eventId", event.id),
    )
    .first();
  if (existing) return { status: "duplicate", event };

  const channelId = await resolveChannelId(ctx, event, verdict.spec, args.scope);

  // Replacement (§6). The coordinate never includes the channel (§16.6): an
  // author's addressable event is one resource identified by its d tag, and a
  // coordinate that carried the channel would let the same author hold two
  // "current" versions of it in two rooms.
  //
  // Buzz's *replaceable* key (§6.1) does include the channel, and ours does not
  // — `replacementKey` is `kind:pubkey`. That difference is currently empty:
  // every replaceable kind in the registry is global-only, so its channel is
  // always none, and the case Buzz added it for (relay-signed NIP-29 group
  // state, where the channel distinguishes one group's row from another's) is
  // served by 39000–39002, which are *parameterized* and already key on a `d`
  // tag holding the channel uuid. If a channel-scoped replaceable kind is ever
  // registered, this is the line that has to change with it.
  const coord = replacementKey(event) ?? undefined;
  let superseded: EventRow[] = [];
  if (coord) {
    superseded = await ctx.db
      .query("buzzEvents")
      .withIndex("by_coord", (q) =>
        q
          .eq("scopeType", args.scope.scopeType)
          .eq("scopeId", args.scope.scopeId)
          .eq("coord", coord)
          .eq("supersededAt", undefined),
      )
      .collect();
    for (const head of superseded) {
      // The domination test, and it is the reason two independent replicas of
      // this log stay identical: newer `created_at` wins, and on an equal second
      // the lexicographically lowest id wins. Timestamps are seconds and a
      // client writing twice in one second is ordinary, so the tie-break is not
      // a corner case — without it, two servers handed the same pair keep
      // different winners and never reconcile.
      if (!supersedes(event, toNostrEvent(head))) {
        // A dominated write is not inserted and must not fan out (§16.5). On
        // this substrate "does not fan out" is automatic: fan-out *is* the
        // Convex subscription over the rows, so not writing one is not sending
        // one. That is exactly why the check has to happen before the insert
        // rather than as a filter afterwards.
        return { status: "dominated", event };
      }
    }
  }

  for (const head of superseded) {
    // Superseded, not deleted. The log is append-only and "what did this say
    // before" is the question an audit trail exists to answer; reads range on
    // the live index, so history costs nothing until somebody asks for it.
    //
    // Milliseconds, unlike `createdAt`. Not a slip: `createdAt` is the event's
    // own NIP-01 timestamp and the hash is over it in seconds, while this is our
    // bookkeeping and matches every other clock in this app.
    await ctx.db.patch(head._id, { supersededAt: nowMs });
  }

  const docId = await ctx.db.insert("buzzEvents", {
    eventId: event.id,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
    scopeType: args.scope.scopeType,
    scopeId: args.scope.scopeId,
    channelId,
    coord,
    shared: eventIsShared(event.tags),
    // Absent, not empty, for everything outside the allowlist (§16.16). A search
    // index with no entry cannot return a hit, cannot leak through a count, and
    // cannot be un-forgotten by a later refactor of the query side.
    searchText: SEARCHABLE_KINDS.has(event.kind) ? event.content : undefined,
  });

  await projectTags(ctx, event, {
    scope: args.scope,
    channelId,
    kind: event.kind,
    createdAt: event.created_at,
  });

  return { status: "inserted", event, docId };
}

/**
 * Which channel does this event belong to? (§5)
 *
 * Three rules, and the third is the interesting one. A global-only kind is
 * stored with no channel **even when it carries an `h` tag** — the event is
 * signed, so a stray tag cannot be stripped, but it must never bind a
 * community-wide record to a room. Buzz documents the same behaviour and warns
 * that the filter layer still treats the tag as authoritative (§4); we keep both
 * halves rather than inventing a third answer.
 */
async function resolveChannelId(
  ctx: MutationCtx,
  event: NostrEvent,
  spec: KindSpec,
  scope: Scope,
): Promise<string | undefined> {
  if (spec.scope === "global") return undefined;

  if (spec.scope === "derived") {
    // Kind 5 and kind 7 take their room from the event they point at, never from
    // their own `h` tag — otherwise a reaction could name a room its target is
    // not in and plant itself there. The **last** valid 64-hex `e` tag wins,
    // matching `derive_reaction_channel`.
    const targets = tagValuesOf(event.tags, "e").filter((id) => /^[0-9a-f]{64}$/.test(id));
    const target = targets[targets.length - 1];
    if (!target) {
      // A deletion may address a coordinate instead of an event id, so it is
      // allowed to have no `e`. A reaction with no target is meaningless.
      if (event.kind === 7) throw new ConvexError("invalid: reaction has no target event");
      return undefined;
    }
    const row = await ctx.db
      .query("buzzEvents")
      .withIndex("by_scope_event_id", (q) =>
        q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("eventId", target),
      )
      .first();
    // Fail closed: an unknown target is rejected rather than stored globally.
    // Storing it would put a reaction to a private room's message into the
    // community-wide read.
    if (!row) throw new ConvexError("invalid: target event not found");
    return row.channelId;
  }

  return event.tags.find((t) => t[0] === "h")?.[1] || undefined;
}

/**
 * Project the queryable tags into their own rows.
 *
 * Convex cannot index an array of arrays, and `#p` / `#e` / `#h` lookups are how
 * half the product asks its questions. Deduped per (name, value) so a message
 * that mentions somebody twice is one row: the index answers "does this event
 * carry this tag", and a second identical row can only produce a duplicate hit.
 */
async function projectTags(
  ctx: MutationCtx,
  event: NostrEvent,
  meta: { scope: Scope; channelId?: string; kind: number; createdAt: number },
): Promise<void> {
  const seen = new Set<string>();
  for (const tag of event.tags) {
    const name = tag[0];
    const value = tag[1];
    if (!INDEXED_TAGS.has(name) || !value) continue;
    // A separator that cannot occur in a tag name, written as an escape rather
    // than as a raw byte: a literal NUL in the source makes the whole file
    // register as binary, so git shows no diff and grep skips it entirely.
    const key = `${name}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await ctx.db.insert("buzzEventTags", {
      eventId: event.id,
      name,
      value,
      // NIP-10 puts the marker in position 3 (`["e", id, relay, "reply"]`), so a
      // thread query can ask for replies without loading every referencing event.
      marker: tag[3] || undefined,
      scopeType: meta.scope.scopeType,
      scopeId: meta.scope.scopeId,
      channelId: meta.channelId,
      kind: meta.kind,
      createdAt: meta.createdAt,
    });
  }
}

/**
 * The Clerk-authenticated way in.
 *
 * Deliberately thin: it decides *who* is writing and *where*, and hands both to
 * the core. `created_at` is not an argument — see `PublishArgs`.
 */
export const publish = mutation({
  args: {
    ...scopeArgs,
    kind: v.number(),
    tags: v.array(v.array(v.string())),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", subject))
      .unique();
    const outcome = await publishCore(ctx, {
      actor: { type: "user", id: subject, name: user?.name ?? user?.email ?? subject },
      scope,
      kind: args.kind,
      tags: args.tags,
      content: args.content,
    });
    return { status: outcome.status, eventId: outcome.event.id };
  },
});

// ---------------------------------------------------------------------------
// The read path
// ---------------------------------------------------------------------------

/**
 * The one per-event visibility function (§9.3, §16.12).
 *
 * Three predicates ANDed, exactly as Buzz factored them — and factored for a
 * reason it states plainly: an implementation that inlines them at each read
 * surface will eventually miss one. Every surface in this file calls this, and
 * every surface a later phase adds must too.
 */
export function eventVisibleToReader(row: EventRow, readerPubkey: string): boolean {
  // Author-only (30300, 30350): a reminder's schedule and a push lease's
  // endpoint. Not just the content — existence, count and tags must not leak.
  const authorOnly = AUTHOR_ONLY_KINDS.has(row.kind) && row.pubkey !== readerPubkey;
  // Shared-gated (30175, 30178): withheld iff the reader is not the author and
  // the event does not carry exactly ["shared","true"].
  const unshared =
    SHARED_GATED_KINDS.has(row.kind) && row.pubkey !== readerPubkey && !row.shared;
  // Result-gated (30622, 44200): knowing an event id is not authorization
  // (§16.14), so the `#p` check runs per event even when the reader asked by id.
  const resultDenied =
    RESULT_GATED_KINDS.has(row.kind) && !tagValuesOf(row.tags, "p").includes(readerPubkey);
  return !authorOnly && !unshared && !resultDenied;
}

/**
 * Does a stored row match one filter? (§7.2)
 *
 * AND across conditions, OR within one. Two rules that look like details and are
 * not:
 *
 *   - `kinds: []` matches **nothing**, an absent `kinds` matches everything
 *     (§16.7). An empty list is a caller who narrowed to nothing, not a caller
 *     who forgot to narrow.
 *   - `#h` has a fallback (§5.3, §16.10): explicit `h` tags on the event are
 *     authoritative and a non-match is a strict rejection — the stored channel
 *     must not override them. Only an event with no `h` tag at all falls back to
 *     its stored channel, which is what makes `{kinds:[7], #h:[…]}` match
 *     tagless reactions whose room was derived from their target.
 */
export function matchesStoredFilter(row: EventRow, filter: BuzzFilter): boolean {
  // Prefix matching on ids is part of NIP-01 as Buzz implements it (§7.1).
  if (filter.ids && !filter.ids.some((prefix) => row.eventId.startsWith(prefix))) return false;
  if (filter.authors && !filter.authors.includes(row.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(row.kind)) return false;
  if (filter.since !== undefined && row.createdAt < filter.since) return false;
  if (filter.until !== undefined && row.createdAt > filter.until) return false;

  for (const { name, values } of filter.tags ?? []) {
    if (values.length === 0) return false;
    if (name === "h") {
      const explicit = tagValuesOf(row.tags, "h");
      if (explicit.length > 0) {
        if (!values.some((wanted) => explicit.includes(wanted))) return false;
        continue;
      }
      if (row.channelId === undefined || !values.includes(row.channelId)) return false;
      continue;
    }
    // Every other tag compares element index 1 only. Positions ≥2 are metadata
    // (relay hints, markers, roles) and are deliberately not filterable.
    const present = tagValuesOf(row.tags, name);
    if (!values.some((wanted) => present.includes(wanted))) return false;
  }
  return true;
}

/**
 * Which channel is this read about? (§7.3 step 4)
 *
 * `null` means a **global** read, and a global read sees only events with no
 * channel — that is the security boundary of §16.9, not an optimization. A
 * channel-scoped event never reaches a global subscription however well it
 * matches, which is why a reaction must be subscribed to as
 * `{kinds:[7], #h:[…]}` and not `{kinds:[7]}`.
 *
 * Anything ambiguous resolves to global, which is the fail-closed direction: a
 * global read cannot return a single channel row.
 */
export function subscriptionChannel(filters: BuzzFilter[]): string | null {
  let chosen: string | null = null;
  for (const filter of filters) {
    const hs = filterTagValues(filter, "h");
    if (hs.length !== 1) return null;
    if (chosen === null) chosen = hs[0];
    else if (chosen !== hs[0]) return null;
  }
  return chosen;
}

function allSelf(values: string[], reader: string): boolean {
  return values.length > 0 && values.every((v2) => v2 === reader && v2 !== "");
}

function canMatchAny(filter: BuzzFilter, set: ReadonlySet<number>): boolean {
  // An absent `kinds` matches every kind, including the gated ones — so the
  // gate applies. This is why an unconstrained global read is refused rather
  // than quietly narrowed: narrowing would answer a question nobody asked, and
  // the caller could not tell the difference between "nothing there" and
  // "not allowed".
  if (filter.kinds === undefined) return true;
  return filter.kinds.some((k) => set.has(k));
}

/**
 * The filter-level gates (§9.1), which run only for global reads (§9.2).
 *
 * A channel read is exempt because every gated kind is stored globally, so a
 * channel read cannot reach one — the fan-out invariant does the work. Returns
 * the rejection reason, or null.
 */
export function globalFilterGateFailure(filter: BuzzFilter, reader: string): string | null {
  const ids = filter.ids ?? [];
  const pValues = filterTagValues(filter, "p");
  const authors = filter.authors ?? [];

  if (canMatchAny(filter, P_GATED_KINDS)) {
    // The `ids` exemption is lost when the filter names 30622 or 44200 (§16.14):
    // a DM-visibility snapshot's id is not author-bound, and a turn metric's
    // envelope leaks activity metadata even encrypted. Those two are re-checked
    // per event as well — belt and braces, because this is the gate somebody
    // will one day route around.
    const namesResultGated =
      filter.kinds !== undefined && filter.kinds.some((k) => RESULT_GATED_KINDS.has(k));
    const idsExempt = ids.length > 0 && !namesResultGated;
    if (!idsExempt && !allSelf(pValues, reader)) {
      return "restricted: this read must name yourself in #p";
    }
  }

  if (canMatchAny(filter, new Set([KIND_AGENT_ENGRAM])) && ids.length === 0) {
    if (!allSelf(authors, reader) && !allSelf(pValues, reader)) {
      return "restricted: agent memory is readable only by its agent or its owner";
    }
  }

  // "Targeting only these": a filter that names author-only kinds and nothing
  // else must name its own author. A wider filter is handled per event instead.
  if (
    filter.kinds !== undefined &&
    filter.kinds.length > 0 &&
    filter.kinds.every((k) => AUTHOR_ONLY_KINDS.has(k)) &&
    !allSelf(authors, reader)
  ) {
    return "restricted: these kinds are readable only by their author";
  }

  return null;
}

const HEX = /^[0-9a-f]+$/;

/**
 * Candidate rows for one filter, always from an index range.
 *
 * Never a table scan, and never `.filter()` on an un-indexed field as the
 * primary narrowing — at the sizes chat reaches, a scan is the difference
 * between a room that opens instantly and one that times out, and it is also
 * where a tenancy fence gets skipped by accident. Every plan below starts by
 * pinning the scope.
 *
 * The plans are ordered by selectivity: an id is one row, a channel is a
 * timeline, a tag is a cross-cut, an author is a person's output, a kind is the
 * community. Whatever the plan does not narrow is ANDed in memory afterwards by
 * `matchesStoredFilter`, over a page rather than over the table.
 */
async function candidatesFor(
  ctx: QueryCtx,
  filter: BuzzFilter,
  scope: Scope,
  channel: string | null,
): Promise<EventRow[]> {
  const limit = Math.min(Math.max(filter.limit ?? DEFAULT_MAX_PAGE_LIMIT, 0), DEFAULT_MAX_PAGE_LIMIT);
  if (limit === 0) return [];
  // §16.7 again, at the plan level: the empty kinds list is indexed nowhere and
  // receives nothing. Returning early is not an optimization — falling through
  // would run a plan whose candidates are all rejected one layer later, which
  // costs a page read to answer "nothing".
  if (filter.kinds !== undefined && filter.kinds.length === 0) return [];

  const since = filter.since;
  const until = filter.until;

  // ── by id (prefix-capable) ───────────────────────────────────────────────
  if (filter.ids && filter.ids.length > 0) {
    const rows: EventRow[] = [];
    for (const prefix of filter.ids) {
      if (prefix.length === 0 || prefix.length > 64 || !HEX.test(prefix)) {
        // Loud rather than empty. An unbounded prefix would range the whole
        // scope, and a silently-dropped id looks exactly like a missing event.
        throw new ConvexError("invalid: ids must be 1..64 lowercase hex characters");
      }
      const page = await ctx.db
        .query("buzzEvents")
        .withIndex("by_scope_event_id", (q) =>
          q
            .eq("scopeType", scope.scopeType)
            .eq("scopeId", scope.scopeId)
            .gte("eventId", prefix)
            // Hex digits are all below "g", so this is the tight upper bound of
            // the prefix range.
            .lt("eventId", `${prefix}g`),
        )
        .take(limit);
      rows.push(...page);
    }
    return rows;
  }

  // ── a channel timeline ───────────────────────────────────────────────────
  if (channel !== null) {
    if (filter.kinds) {
      const rows: EventRow[] = [];
      for (const kind of filter.kinds) {
        const page = await ctx.db
          .query("buzzEvents")
          .withIndex("by_scope_channel_kind", (q) =>
            timeRange(
              q
                .eq("scopeType", scope.scopeType)
                .eq("scopeId", scope.scopeId)
                .eq("channelId", channel)
                .eq("kind", kind)
                .eq("supersededAt", undefined),
              since,
              until,
            ),
          )
          .order("desc")
          .take(limit);
        rows.push(...page);
      }
      return rows;
    }
    return await ctx.db
      .query("buzzEvents")
      .withIndex("by_scope_channel", (q) =>
        timeRange(
          q
            .eq("scopeType", scope.scopeType)
            .eq("scopeId", scope.scopeId)
            .eq("channelId", channel)
            .eq("supersededAt", undefined),
          since,
          until,
        ),
      )
      .order("desc")
      .take(limit);
  }

  // ── a tag cross-cut (global reads) ───────────────────────────────────────
  // "every event mentioning me", "every reaction to this message". The tag rows
  // carry the event's channel, so the global boundary is applied before the
  // events are loaded rather than after.
  const indexedTag = (filter.tags ?? []).find(
    (t) => t.name !== "h" && INDEXED_TAGS.has(t.name) && t.values.length > 0,
  );
  if (indexedTag) {
    const ids = new Set<string>();
    for (const value of indexedTag.values) {
      const tagRows = filter.kinds
        ? (
            await Promise.all(
              filter.kinds.map((kind) =>
                ctx.db
                  .query("buzzEventTags")
                  .withIndex("by_tag_kind", (q) =>
                    timeRange(
                      q
                        .eq("scopeType", scope.scopeType)
                        .eq("scopeId", scope.scopeId)
                        .eq("name", indexedTag.name)
                        .eq("value", value)
                        .eq("kind", kind),
                      since,
                      until,
                    ),
                  )
                  .order("desc")
                  .take(limit),
              ),
            )
          ).flat()
        : await ctx.db
            .query("buzzEventTags")
            .withIndex("by_tag", (q) =>
              timeRange(
                q
                  .eq("scopeType", scope.scopeType)
                  .eq("scopeId", scope.scopeId)
                  .eq("name", indexedTag.name)
                  .eq("value", value),
                since,
                until,
              ),
            )
            .order("desc")
            .take(limit);
      for (const tagRow of tagRows) {
        if (tagRow.channelId !== undefined) continue;
        ids.add(tagRow.eventId);
      }
    }
    const rows: EventRow[] = [];
    for (const id of ids) {
      const row = await ctx.db
        .query("buzzEvents")
        .withIndex("by_scope_event_id", (q) =>
          q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("eventId", id),
        )
        .first();
      if (row) rows.push(row);
    }
    return rows;
  }

  // ── one author's output ──────────────────────────────────────────────────
  if (filter.authors && filter.authors.length > 0) {
    const rows: EventRow[] = [];
    for (const author of filter.authors) {
      const page = await ctx.db
        .query("buzzEvents")
        .withIndex("by_author", (q) =>
          timeRange(
            q
              .eq("scopeType", scope.scopeType)
              .eq("scopeId", scope.scopeId)
              .eq("pubkey", author),
            since,
            until,
          ),
        )
        .order("desc")
        .take(limit);
      rows.push(...page);
    }
    return rows;
  }

  // ── the community-wide read ──────────────────────────────────────────────
  // `channelId: undefined` is a real index value, so "everything global" is a
  // range and not a scan-then-filter.
  if (filter.kinds) {
    const rows: EventRow[] = [];
    for (const kind of filter.kinds) {
      const page = await ctx.db
        .query("buzzEvents")
        .withIndex("by_scope_channel_kind", (q) =>
          timeRange(
            q
              .eq("scopeType", scope.scopeType)
              .eq("scopeId", scope.scopeId)
              .eq("channelId", undefined)
              .eq("kind", kind)
              .eq("supersededAt", undefined),
            since,
            until,
          ),
        )
        .order("desc")
        .take(limit);
      rows.push(...page);
    }
    return rows;
  }

  return await ctx.db
    .query("buzzEvents")
    .withIndex("by_scope_channel", (q) =>
      timeRange(
        q
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId)
          .eq("channelId", undefined)
          .eq("supersededAt", undefined),
        since,
        until,
      ),
    )
    .order("desc")
    .take(limit);
}

/**
 * `since`/`until` as an index range on the trailing `createdAt` column.
 *
 * Every index in this file ends in `createdAt`, so one helper covers all of
 * them. It exists because the alternative is the same four lines copied into six
 * plans, and the sixth copy is the one that applies the bound in memory instead
 * — which turns a bounded index read into a page read plus a filter.
 *
 * The two interfaces are the narrow slice of Convex's per-index builder that
 * this needs; they extend `IndexRange` so the un-bounded case can return the
 * builder untouched.
 */
interface CreatedAtUpperBound extends IndexRange {
  lte(field: "createdAt", value: number): IndexRange;
}
interface CreatedAtBound extends CreatedAtUpperBound {
  gte(field: "createdAt", value: number): CreatedAtUpperBound;
}
function timeRange(q: CreatedAtBound, since?: number, until?: number): IndexRange {
  if (since !== undefined && until !== undefined) {
    return q.gte("createdAt", since).lte("createdAt", until);
  }
  if (since !== undefined) return q.gte("createdAt", since);
  if (until !== undefined) return q.lte("createdAt", until);
  return q;
}

export type ReadArgs = {
  scope: Scope;
  filters: BuzzFilter[];
  /** The reader's own pubkey. `""` for a principal that has no key yet. */
  readerPubkey: string;
};

/**
 * Resolve a set of filters to events. OR across filters, AND within one.
 *
 * One query per filter, never a merged one (§16.8): merging collapses distinct
 * time windows and per-filter limits into a single page, so a filter with a
 * narrow window silently gets its results eaten by a broader sibling. And the
 * dedupe happens **after** acceptance, so an event rejected by filter A is still
 * eligible for filter B.
 */
export async function readEventsCore(
  ctx: QueryCtx,
  args: ReadArgs,
): Promise<NostrEvent[]> {
  // An empty filter *list* matches nothing (`filters_match(&[], ev)` is false),
  // while an empty filter *object* matches everything. Two different things that
  // read alike.
  if (args.filters.length === 0) return [];
  if (args.filters.length > MAX_FILTERS) {
    throw new ConvexError(`invalid: at most ${MAX_FILTERS} filters`);
  }

  const channel = subscriptionChannel(args.filters);
  if (channel === null) {
    // Gates run before anything touches the database (§7.3 step 6) — the point
    // of a filter-level gate is that the query is never made, so an error and a
    // timing signal cannot differ.
    for (const filter of args.filters) {
      const failure = globalFilterGateFailure(filter, args.readerPubkey);
      if (failure) throw new ConvexError(failure);
    }
  }

  const accepted = new Map<string, EventRow>();
  for (const filter of args.filters) {
    const candidates = await candidatesFor(ctx, filter, args.scope, channel);
    for (const row of candidates) {
      if (row.deletedAt !== undefined) continue;
      if (row.supersededAt !== undefined) continue;
      // The channel boundary, re-applied per event. A plan already narrowed to
      // it, but this is the line that makes §16.9 true no matter which plan ran.
      if (channel === null ? row.channelId !== undefined : row.channelId !== channel) continue;
      if (!matchesStoredFilter(row, filter)) continue;
      if (!eventVisibleToReader(row, args.readerPubkey)) continue;
      accepted.set(row.eventId, row);
    }
  }

  return [...accepted.values()]
    .sort((a, b) => b.createdAt - a.createdAt || a.eventId.localeCompare(b.eventId))
    .map(toNostrEvent);
}

/**
 * The Clerk-authenticated way out.
 *
 * `requireScopeAccess` is the tenancy fence and it runs first; the reader's
 * pubkey then decides the per-event gates. A principal with no key yet reads as
 * `""`, which is nobody: gated events are simply not there for them, which is
 * the right answer and not an error state.
 */
export const read = query({
  args: { ...scopeArgs, filters: v.array(filterValidator) },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const readerPubkey = (await pubkeyFor(ctx, "user", subject)) ?? "";
    return await readEventsCore(ctx, { scope, filters: args.filters, readerPubkey });
  },
});

/**
 * One event by id, through the same gates.
 *
 * A convenience over `read`, not a second path: it builds a filter and calls the
 * core, so an event that a filtered read would withhold is withheld here too.
 * The alternative — `ctx.db.get` and return it — is the read-leak shape.
 *
 * `channelId` is required to reach an event that lives in a room, and that is
 * the channel boundary doing its job rather than an awkward API: a bare id
 * lookup is a global read, and a global read cannot see into a channel (§16.9).
 * A permalink therefore carries the room it points at, which it has to anyway
 * for the reader to have somewhere to land.
 */
export const readOne = query({
  args: { ...scopeArgs, eventId: v.string(), channelId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const readerPubkey = (await pubkeyFor(ctx, "user", subject)) ?? "";
    const found = await readEventsCore(ctx, {
      scope,
      filters: [
        {
          ids: [args.eventId],
          limit: 1,
          ...(args.channelId ? { tags: [{ name: "h", values: [args.channelId] }] } : {}),
        },
      ],
      readerPubkey,
    });
    return found[0] ?? null;
  },
});
