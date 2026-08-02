// The Chat dashboard's tables.
//
// Kept in their own file and spread into convex/schema.ts, for two reasons.
// One is merge hygiene: schema.ts is 2,400 lines that another build is editing
// concurrently, and this way Chat costs it two lines forever. The other is that
// these tables are a different *kind* of thing — an append-only signed log and
// its indexes, not the mutable domain rows the rest of the app is made of — and
// filing them together says so.
//
// The substrate — the log, its tag index, and the keys that sign into it —
// plus the projections that have earned a row: rooms, who is in them, and (C5)
// one reader's read state. Mutes and stars still have none, because a schema
// written ahead of its first caller is a guess.

import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * A community is a workspace, or a person's personal space.
 *
 * Deliberately the same `(scopeType, scopeId)` pair `_authz.requireScopeAccess`
 * already speaks, rather than a new "community id". Buzz's row-zero rule is
 * that the community comes from the host and never from the client, and every
 * scoped row carries an immutable community with every unique key leading on
 * it. Our equivalent of "the host" is the caller's authenticated access to a
 * scope — so reusing the existing pair means there is one answer to "may this
 * person see this", not two that can drift apart.
 */
const scope = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

export const buzzTables = {
  /**
   * The log. One row per signed event.
   *
   * Everything except the first seven fields is derived from those seven at
   * write time — denormalized so a read can hit an index instead of scanning
   * and re-parsing tags. Derived columns are written once, in the same
   * transaction, by the one function allowed to insert here.
   */
  buzzEvents: defineTable({
    // ---- NIP-01, verbatim. These six are the event; the rest is bookkeeping.
    // `eventId` rather than `id` because Convex owns `_id`, and two fields
    // called id in one row is how the wrong one ends up in a URL.
    eventId: v.string(),
    pubkey: v.string(),
    /** Seconds, not milliseconds — NIP-01 is seconds, and the hash is over it. */
    createdAt: v.number(),
    kind: v.number(),
    tags: v.array(v.array(v.string())),
    content: v.string(),
    sig: v.string(),

    // ---- Tenancy.
    ...scope,

    /**
     * The `h` tag: which channel this belongs to, if any.
     *
     * Channel-scoped events must never reach a global subscription however well
     * they match a filter — that is the security boundary, not an optimization.
     * Storing it as a column is what lets the read path enforce that with an
     * index range rather than a post-filter somebody can forget.
     */
    channelId: v.optional(v.string()),

    /**
     * The replacement coordinate: `kind:pubkey` or `kind:pubkey:d`, absent for
     * regular kinds. NIP-33 keys on (kind, pubkey, d) and never on the channel
     * — a coordinate that included the channel would let one author hold two
     * "current" versions of the same replaceable event.
     */
    coord: v.optional(v.string()),

    /**
     * The `["shared", "true"]` tag, as a boolean, fail-closed on any other
     * shape.
     *
     * A tag rather than a content field on purpose: toggling whether something
     * is shared must not change the content bytes, because changing content
     * changes the id, and an event that changes its own identity when its
     * visibility changes cannot be referred to.
     */
    shared: v.boolean(),

    /**
     * What the search index sees. **Absent** for privacy-sensitive kinds.
     *
     * Absent, not filtered afterwards: a post-query exclusion is one forgotten
     * call site away from leaking, and it also leaks through result counts. If
     * it was never indexed it cannot be found.
     */
    searchText: v.optional(v.string()),

    /**
     * Set when a later event supersedes this one, or when it is deleted.
     *
     * Superseded rows are kept rather than removed — the log is append-only,
     * and "what did this say before" is a question the audit trail exists to
     * answer. Reads range on the live index; history reads ask for it.
     */
    supersededAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
  })
    // An id is a hash, so this is the natural key and the dedupe check.
    //
    // Scope-leading, like every other index here, for two reasons. Dedupe is
    // per-community by construction in Buzz (§6.4) — the same signed event may
    // legitimately exist in two of them — so a global uniqueness check would
    // refuse a write it has no business refusing. And a scope-blind id lookup is
    // a read that skips the tenancy fence; not having one is how the fence stays
    // unskippable rather than remembered. Prefix `ids` filters (§7.1) range on
    // this index inside one scope.
    .index("by_scope_event_id", ["scopeType", "scopeId", "eventId"])
    // The channel timeline: the single hottest read in the product.
    //
    // Leading on the scope is not an optimization either: a channel id is not
    // globally unique (Buzz's channels are PK'd `(community_id, id)`), so a read
    // keyed on the channel alone would answer with another tenant's room the day
    // two ids collide.
    .index("by_scope_channel", ["scopeType", "scopeId", "channelId", "supersededAt", "createdAt"])
    .index("by_scope_channel_kind", [
      "scopeType",
      "scopeId",
      "channelId",
      "kind",
      "supersededAt",
      "createdAt",
    ])
    // Community-wide reads that are not about one channel (home feed, audit).
    .index("by_scope_kind", ["scopeType", "scopeId", "kind", "supersededAt", "createdAt"])
    // "Everything this author wrote" — the agent activity view, and moderation.
    .index("by_author", ["scopeType", "scopeId", "pubkey", "createdAt"])
    // Replacement: find the current holder of a coordinate in one read.
    .index("by_coord", ["scopeType", "scopeId", "coord", "supersededAt"])
    .searchIndex("search_content", {
      searchField: "searchText",
      filterFields: ["scopeId", "channelId", "kind"],
    }),

  /**
   * The tag index.
   *
   * Convex cannot index an array of arrays, and `#p`/`#e`/`#t` lookups are how
   * half the product asks its questions ("every reaction to this message",
   * "every event mentioning me"). So each tag worth querying is projected into
   * a row here at write time.
   *
   * Not every tag: projecting all of them would multiply the write cost of a
   * message by its tag count for lookups nobody performs. The indexed set is
   * enumerated in _kinds.ts, alongside the kinds themselves, so adding a
   * queryable tag is one edit in one place.
   */
  buzzEventTags: defineTable({
    eventId: v.string(),
    /** The tag name, without the `#`: "e", "p", "t", … */
    name: v.string(),
    value: v.string(),
    /** The NIP-10 marker, if the tag carries one: "root" | "reply" | "mention". */
    marker: v.optional(v.string()),
    // Denormalized from the event so a tag query answers without a join, and
    // so the tenancy fence applies to the index itself rather than only to the
    // rows it points at.
    ...scope,
    channelId: v.optional(v.string()),
    kind: v.number(),
    createdAt: v.number(),
  })
    .index("by_tag", ["scopeType", "scopeId", "name", "value", "createdAt"])
    .index("by_tag_kind", ["scopeType", "scopeId", "name", "value", "kind", "createdAt"])
    .index("by_event", ["eventId"]),

  /**
   * One keypair per principal — every person and every agent.
   *
   * The private key lives here and is never sent to the browser; signing
   * happens in the mutation (see 00-decisions.md D2). That is a deliberate
   * trade: Buzz's desktop client holds the key locally, which is stronger, and
   * is not available to a web app that must sign on behalf of a user who is not
   * looking at the screen. Storing it server-side is what makes an agent's
   * events signable at all.
   *
   * `principalId` is a Clerk subject for a person and an `agents` document id
   * for an agent — the same string shape the rest of the app already uses
   * interchangeably for an actor, so an agent is a member here for the same
   * reason it is an assignee there.
   */
  buzzKeys: defineTable({
    principalType: v.union(v.literal("user"), v.literal("agent")),
    principalId: v.string(),
    /** x-only, 64 hex chars. The public half of the identity. */
    pubkey: v.string(),
    /** 64 hex chars. Server-side only — no query may return this field. */
    secretKey: v.string(),
    createdAt: v.number(),
    /** Set when a key is rotated out; its events stay verifiable forever. */
    retiredAt: v.optional(v.number()),
  })
    .index("by_principal", ["principalType", "principalId", "retiredAt"])
    .index("by_pubkey", ["pubkey"]),

  /**
   * A room. **A projection of the log, never a source of truth.**
   *
   * Every column here was put there by an event: the row is created by a 9007,
   * renamed by a 9002, archived by another 9002, and its member count moves
   * with 9000/9001/9021/9022. Nothing writes a channel row without publishing
   * the event that explains it, in the same transaction — which is what makes
   * "what happened to this room, and who did it" answerable from the log alone
   * rather than from an audit column somebody remembered to set.
   *
   * The shape is Buzz's `Channel`/`ChannelDetail` (01-core-comms §1.1), and it
   * is deliberately a **product of three axes** rather than one enum: a public
   * channel is `stream`+`open`, a private one is `stream`+`private`, a DM is
   * `dm` with two members, a group DM is `dm` with more, and an ephemeral room
   * is any of them with a `ttlSeconds`. A single `kind` column would have had
   * to enumerate the product, and the eleventh combination would be the one
   * nobody added.
   */
  buzzChannels: defineTable({
    ...scope,

    /**
     * The id every `["h", …]` tag carries — and it is the id of the 9007 event
     * that created the room.
     *
     * Not a uuid, for a reason that is more than convenience: a mutation has no
     * CSPRNG, so a random id would have to come from the client, and a
     * client-chosen id is one a client can collide on purpose. An event id is a
     * hash of the creating event, so it is unforgeable, unique, and it makes
     * the room's identity *derived from* the log entry that announced it.
     */
    channelId: v.string(),

    /**
     * The canonical name `#name` resolves against: lowercase, dashed, no `#`.
     * Empty for a DM, which has no name — its title is its members.
     */
    name: v.string(),
    /** What a person typed, minus the display-only `#`. Empty for a DM. */
    displayName: v.string(),

    channelType: v.union(v.literal("stream"), v.literal("forum"), v.literal("dm")),
    visibility: v.union(v.literal("open"), v.literal("private")),

    /** The browsable blurb. Set at creation, edited in the edit dialog. */
    description: v.string(),
    /** "What we're on right now" — any member may set it. */
    topic: v.optional(v.string()),
    topicSetByActorId: v.optional(v.string()),
    topicSetAt: v.optional(v.number()),
    /** The long-lived charter. Distinct from topic on purpose (§1.5). */
    purpose: v.optional(v.string()),
    purposeSetByActorId: v.optional(v.string()),
    purposeSetAt: v.optional(v.number()),

    /**
     * Ephemeral: cleans up after this long with no activity.
     *
     * Absent means permanent. There is deliberately no `ttlDeadline` column
     * yet: Buzz sets one when its sweeper schedules the cleanup, and we have no
     * sweeper — a stored deadline nothing enforces is a promise the product
     * cannot keep, and the display already reads an absent deadline as "cleans
     * up after N of inactivity", which is exactly true here.
     */
    ttlSeconds: v.optional(v.number()),

    /** Clerk subject or `agents` id — the actor shape the rest of the app uses. */
    createdByActorId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    /** Archived when set. Archived rooms are visible only to their members. */
    archivedAt: v.optional(v.number()),

    /**
     * Denormalized so the rail does not count members per row.
     *
     * The same reason `channels.lastMessageAt` is denormalized on the Work
     * side: a list of rooms is the hottest read in the product and it must not
     * be N reads deep.
     */
    memberCount: v.number(),
    /** Drives rail ordering and the ephemeral TTL clock. */
    lastActivityAt: v.number(),

    /**
     * A DM's participant set, sorted and joined — the DM's real identity.
     *
     * Present only for `dm`. It is what makes "open a DM with Ada" idempotent:
     * the second call finds this row instead of creating a second conversation
     * with the same two people. And it is why a DM's members are immutable —
     * adding somebody would change this key, i.e. make it a different
     * conversation, which is exactly what Buzz says it is (§1.2).
     */
    participantKey: v.optional(v.string()),

    /** The template a room was furnished from, for provenance (§1.7). */
    templateId: v.optional(v.string()),
  })
    // Scope-leading, like every index in this file, and for the reason stated
    // at `buzzEvents`: a channel id is unique inside a community, so a read
    // keyed on the channel alone answers with another tenant's room the day two
    // ids collide. Not having a scope-blind lookup is what keeps the tenancy
    // fence unskippable rather than remembered.
    .index("by_scope_channel", ["scopeType", "scopeId", "channelId"])
    // Uniqueness *and* the rail read. One index does both because the rail
    // wants every room in the community and the name check wants one of them.
    .index("by_scope_name", ["scopeType", "scopeId", "name"])
    .index("by_scope_participants", ["scopeType", "scopeId", "participantKey"]),

  /**
   * Who is in a room, and as what.
   *
   * Keyed on an **actor id** — a Clerk subject or an `agents` document id —
   * rather than a pubkey, because that is the string the rest of this app
   * already uses interchangeably for a person or an agent (assignees, message
   * authors, `*ActorId` columns). It is the whole reason an agent can be a room
   * member with no second concept: `channelReads` already does this.
   *
   * A member's pubkey is deliberately **not** stored. It is one indexed read
   * away through `identity.pubkeyFor`, and it can be rotated — a denormalized
   * copy would be a second answer to "which key is this member's", drifting the
   * first time somebody rotates.
   */
  buzzMemberships: defineTable({
    ...scope,
    channelId: v.string(),
    actorId: v.string(),
    actorType: v.union(v.literal("user"), v.literal("agent")),

    /**
     * Buzz's five roles, in Buzz's vocabulary. `bot` is a role and not a
     * synonym for `actorType: "agent"`: a human account can run as a bot, and
     * an agent can hold `admin`.
     */
    role: v.union(
      v.literal("owner"),
      v.literal("admin"),
      v.literal("member"),
      v.literal("guest"),
      v.literal("bot"),
    ),
    joinedAt: v.number(),
    invitedByActorId: v.optional(v.string()),

    /**
     * Removal is a **soft delete** (§11.4), and re-adding reverses it.
     *
     * Keeping the row is what lets "Ada was in this room until March" stay
     * answerable, and it keeps the membership row aligned with the log, which
     * never forgets either. It is also part of the index key, so "the current
     * members" is a range rather than a filter over everyone who ever joined.
     */
    removedAt: v.optional(v.number()),
    removedByActorId: v.optional(v.string()),

    /**
     * The per-viewer DM hide state.
     *
     * A DM cannot be left — its participant set is immutable — so closing one
     * hides it for you and for nobody else. A shared `archivedAt` would let one
     * participant remove a conversation from the other's client.
     */
    hiddenAt: v.optional(v.number()),
  })
    .index("by_channel", ["scopeType", "scopeId", "channelId", "removedAt"])
    // "Which rooms is this actor in" — one range read for the whole rail,
    // rather than a membership lookup per channel.
    .index("by_actor", ["scopeType", "scopeId", "actorId", "removedAt"])
    .index("by_channel_actor", ["scopeType", "scopeId", "channelId", "actorId"]),

  /**
   * One reader's read state in one community. **A projection of the log.**
   *
   * The source of truth is the kind-30078 blob (or blobs — see `publishedSlots`)
   * that `readState.ts` publishes; every field here was put there by one, and
   * every write re-reads them and max-merges before it changes anything. Keeping
   * a row at all is what makes the sidebar's unread algorithm a bounded index
   * range instead of a parse of the log per rail render, which at the rate a
   * rail redraws is the difference between a room list and a stall.
   *
   * Keyed on the **pubkey**, not the Clerk subject: read state is addressed to
   * the identity the log speaks, so a rotated key starts a fresh read state
   * rather than inheriting one addressed to a key nothing new is signed by.
   */
  buzzReadState: defineTable({
    ...scope,
    pubkey: v.string(),

    /**
     * Context key → unix **seconds**: a bare channel id, `thread:<root>` or
     * `msg:<id>`. Seconds because Nostr `created_at` is seconds and this is
     * compared against it on every read; one conversion in the middle is one
     * place to get an off-by-a-thousand wrong.
     */
    contexts: v.record(v.string(), v.number()),

    /**
     * Channel id → the reader's own marker at the moment they marked it unread,
     * or `null` if they had none.
     *
     * Deliberately **not** in the blob. A marker is monotonic, so a retrograde
     * read position cannot be expressed in one, and expressing it as a smaller
     * number would rewind the reader's position permanently and everywhere. So
     * mark-unread is a separate fact with its own gate: if the marker later
     * advances past this baseline, a genuine read has happened and the dot goes
     * out on its own.
     */
    forcedUnread: v.record(v.string(), v.union(v.number(), v.null())),

    /**
     * The blob's `client_id` and the slot-rotation counter.
     *
     * Both derived rather than random, because a mutation has no CSPRNG and
     * there is no client-side store to keep a random one in. The counter exists
     * for one case: a blob found at our coordinate carrying somebody else's
     * `client_id` means two clients are sharing a slot, and rotating to a fresh
     * one is how neither of them clobbers the other.
     */
    clientId: v.string(),
    rotation: v.number(),

    /**
     * The blobs currently standing for this state, and what they say.
     *
     * More than one when the contexts outgrow a single 32 KB blob: channel keys
     * are dealt round-robin across up to eight slots, because channel keys are
     * the entries that may never be evicted. `publishedContexts` is their union
     * and exists so a publish that would say exactly what the last one said is
     * not made at all.
     */
    publishedSlots: v.array(v.object({ slotId: v.string(), eventId: v.string() })),
    publishedContexts: v.record(v.string(), v.number()),

    /**
     * The ordering watermark (06-protocol §6.3), in **seconds**.
     *
     * Read state is one of the two coordinates whose superseded payload is
     * hard-deleted rather than kept, so there is no old head left to compare a
     * new blob against. This is what replaces it: every blob is published at
     * `max(now, publishedAt + 1)`, so a previously accepted blob can never be
     * resurrected and clock skew cannot silently lose a write.
     */
    publishedAt: v.number(),
    updatedAt: v.number(),
  }).index("by_scope_pubkey", ["scopeType", "scopeId", "pubkey"]),

  /**
   * One agent's one turn in one room. **A projection, like every row above.**
   *
   * Why this is not `agentRuns`, which already exists and already models a
   * structured agent work session with steps, narration and live state — the
   * question was asked, and the answer is three facts about that table rather
   * than a preference:
   *
   *   1. **Its coordinates are the wrong ones.** `agentRuns` is indexed
   *      `by_agent` and `by_task`; it carries no community and no room. The two
   *      hottest reads here are "every live turn in this room" and "is anyone
   *      working here", and on that table both are a scan over every run the
   *      agent has ever done, filtered in memory. Adding a channel column and a
   *      scope-leading index to `agentRuns` would also mean editing
   *      `convex/schema.ts` beyond the one-line spread the Chat build is allowed
   *      (07-integration-map §9) — and it would put a tenancy fence on a table
   *      whose existing readers do not apply one.
   *
   *   2. **Its lifecycle is a different lifecycle.** A run is
   *      running/succeeded/failed/abandoned, and `abandoned` is *written* by the
   *      watchdog cron. A turn is started/streaming/finished/cancelled/failed,
   *      it has cancellation (which a run does not — nobody cancels a run), and
   *      its decay is **derived from the clock at read time** rather than
   *      written by anything (see `src/lib/buzz/turn.ts`). Sharing a status
   *      column would mean one of the two lifecycles lying about the other, and
   *      `cancelled` would have to be smuggled in as `abandoned`.
   *
   *   3. **A run is about work; a turn is about a conversation.** A run has a
   *      task, artifacts and a cost. A turn has a room, a triggering message and
   *      a sentence. The overlap is that both have a start and an end, which is
   *      not enough shared meaning to make one table — it is how a table ends up
   *      with two disjoint halves and every reader having to know which half it
   *      is looking at.
   *
   * What is *not* duplicated: governance. Every write here goes through
   * `requireAgentByKey`, so role, list fences, the daily budget, the burst cap
   * and x402 metering are the same ones the Work side enforces, counted in the
   * same `agentUsage` row. There is no second budget.
   *
   * The row is a projection: each transition also publishes a signed event (a
   * 20002 typing indicator while working, a 44200 turn metric at the end, a
   * 24200 control frame for a human's cancel), and `lastEventId` names the one
   * that explains the current state. The ephemeral ones leave no row by design —
   * a liveness beat every ten seconds must not accumulate in an append-only log
   * — which is exactly why the projection has to exist at all.
   */
  buzzTurns: defineTable({
    ...scope,
    channelId: v.string(),

    /**
     * The harness's own turn id, or the id of the event that announced the turn
     * when the harness has none.
     *
     * Unique per agent, not per community: Buzz's `turnId` is process-local and
     * resets (§"Non-obvious rules" 1), so two agents may legitimately both call
     * their first turn `1`. Every index below leads on the agent for that
     * reason, and a collision between two agents is impossible rather than
     * merely unlikely.
     */
    turnId: v.string(),

    /** The `agents` document id — the actor-id shape a membership row carries. */
    agentId: v.string(),
    /**
     * The key this turn's events are signed with, copied at start.
     *
     * A copy, unlike `buzzMemberships`, which deliberately stores no pubkey and
     * resolves it live. The difference is tense: a membership asks "which key is
     * this member's *now*", which rotation must be able to change; a turn asks
     * "which key signed *this*", which rotation must not.
     */
    agentPubkey: v.string(),

    state: v.union(
      v.literal("started"),
      v.literal("streaming"),
      v.literal("finished"),
      v.literal("cancelled"),
      v.literal("failed"),
    ),

    /** Milliseconds. The anchor an elapsed counter counts from. */
    startedAt: v.number(),
    /** Milliseconds. The last proof of life; liveness is derived from it. */
    lastActivityAt: v.number(),
    endedAt: v.optional(v.number()),

    /** One line, replaced. Never a transcript — the transcript is the room. */
    narration: v.optional(v.string()),
    error: v.optional(v.string()),
    /** The Clerk subject who stopped it, when a person did. */
    cancelledByActorId: v.optional(v.string()),
    /** The message that triggered the turn, when it had one. */
    triggerEventId: v.optional(v.string()),
    /** The signed event that explains the current state. */
    lastEventId: v.string(),

    /** Reported by the harness at the end, like `agentRuns` does for a run. */
    tokensUsed: v.optional(v.number()),
    costUsd: v.optional(v.number()),
  })
    // "What is live in this room" — the rail's read, and the working signal's.
    // `state` sits before `lastActivityAt` so a query can range the two
    // non-terminal states over a recency window: a turn nobody has heard from
    // in days falls out of the read on its own, with no sweeper to run and no
    // write to make. Decay is a property of the index range, not of a cron.
    .index("by_channel_state", [
      "scopeType",
      "scopeId",
      "channelId",
      "state",
      "lastActivityAt",
    ])
    // The uniqueness key, and the one every transition looks up by.
    .index("by_agent_turn", ["scopeType", "scopeId", "agentId", "turnId"])
    // "Everything this agent is doing, anywhere" — the all-channels scope rule
    // of the working signal (02-agents.md §5.5).
    .index("by_agent", ["scopeType", "scopeId", "agentId", "lastActivityAt"]),
};
