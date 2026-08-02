// Pulse: a view over the log, and nothing else.
//
// **Pulse is derived, never stored.** There is no `pulseFeed` table here, no
// denormalized counter, no per-tab materialization — because a second copy of
// activity is a copy that can disagree with the log it came from, and the
// disagreement always surfaces as "the feed says I posted that and the room
// says I didn't". Every function below reads `buzzEvents` through
// `readEventsCore`, which means every row Pulse can ever show has already
// passed the tenancy fence, the channel boundary and the one per-event
// visibility gate. Nothing here re-decides any of those.
//
// The **derivation** lives in `src/lib/buzz/pulse.ts`, pure and tested, exactly
// as the transcript's fold lives in `timeline.ts`. This file's job is narrower
// and worth stating so it does not creep: decide *which window of events* a tab
// needs and hand it over raw. It does not fold, does not group, does not rank.
// A server that folded would have to re-fold on every live event, could not
// show an optimistic row, and could not be tested without a database.
//
// ## One log, and the other one
//
// The Work dashboard has its own activity log (`convex/events.ts`) and Pulse
// deliberately does not read it yet. Not because two feeds are wanted — the
// opposite: C12 joins them, and a Pulse that had grown its own copy of Work
// activity in the meantime would have to have that copy deleted first. So the
// rule is the same rule as above, one step out: Pulse reads logs, it does not
// accumulate one.
//
// ## The channel boundary, for free
//
// A note (kind 1) is a **global** kind in the registry, so it is stored with no
// channel and a global read returns exactly the events with no channel
// (§16.9). That is why Pulse cannot leak a room's messages however the filters
// are shaped: a channel-scoped event never reaches a global subscription. It is
// worth knowing that this is structural rather than a filter somebody wrote —
// nothing in this file has to remember to exclude rooms.
//
// Spec: docs/buzz-parity/03-workflows-projects.md §3.

import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireScopeAccess } from "../_authz";
import { describePubkey, pubkeyFor } from "./identity";
import { resolveMentions } from "./messages";
import { requireNotRestricted } from "./moderation";
import { publishCore, readEventsCore, type Scope } from "./log";
import type { NostrEvent } from "./_nostr";
import {
  KIND_REACTION,
  KIND_TEXT_NOTE,
  PULSE_PAGE_LIMIT,
  UPVOTE,
  type PulseTab,
} from "../../src/lib/buzz/pulse";

/** NIP-09 retraction: how an upvote is taken back. */
const KIND_DELETION = 5;
/** NIP-02 contact list. One replaceable event per person. */
const KIND_CONTACT_LIST = 3;

const scopeArgs = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

/**
 * How far back the "which notes have I upvoted" read goes.
 *
 * Bounded because it is an author-plan read: the index ranges one person's
 * events and the kind is applied afterwards, so a chatty author needs a window
 * wider than the page they are looking at. Wider than this and the Liked tab
 * would be paying for history nobody scrolls to.
 */
const MY_REACTION_WINDOW = 200;

export type PulseAuthor = { pubkey: string; name: string; isAgent: boolean };

export type PulseFeedResult = {
  /** `""` for a reader with no Chat identity yet — which is nobody. */
  viewerPubkey: string;
  /** Raw signed events. The fold is the client's (`src/lib/buzz/pulse.ts`). */
  notes: NostrEvent[];
  /** Reactions that bear on those notes. Only `+` is counted, by the fold. */
  reactions: NostrEvent[];
  contactPubkeys: string[];
  agentPubkeys: string[];
  likedNoteIds: string[];
  /** For the Agents tab's badge, and for "no agents" vs "no agent notes". */
  agentCount: number;
  /** Display names for every pubkey on screen, resolved once. */
  authors: PulseAuthor[];
};

function isTab(value: string): value is PulseTab {
  return ["search", "everyone", "following", "liked", "agents", "mine"].includes(value);
}

/** Every agent in this community that has a Chat identity. */
async function agentPubkeysFor(
  ctx: QueryCtx,
  scope: Scope,
): Promise<{ pubkeys: string[]; count: number }> {
  const agents = await ctx.db
    .query("agents")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", scope.scopeType).eq("parentId", scope.scopeId),
    )
    .collect();
  const pubkeys: string[] = [];
  for (const agent of agents) {
    const pubkey = await pubkeyFor(ctx, "agent", agent._id);
    if (pubkey) pubkeys.push(pubkey);
  }
  // The count is every agent, not every agent with a key: "no agents registered
  // yet" and "your agents have not posted" are different sentences, and an
  // agent that has not been attached to a room yet still exists.
  return { pubkeys, count: agents.length };
}

/** The viewer's NIP-02 contacts, or none. */
async function contactsFor(
  ctx: QueryCtx,
  scope: Scope,
  viewerPubkey: string,
): Promise<string[]> {
  if (!viewerPubkey) return [];
  const [list] = await readEventsCore(ctx, {
    scope,
    filters: [{ kinds: [KIND_CONTACT_LIST], authors: [viewerPubkey], limit: 1 }],
    readerPubkey: viewerPubkey,
  });
  if (!list) return [];
  return [...new Set(list.tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1]))];
}

function lastETag(tags: readonly string[][]): string | null {
  for (let i = tags.length - 1; i >= 0; i -= 1) {
    if (tags[i][0] === "e" && tags[i][1]) return tags[i][1];
  }
  return null;
}

/**
 * One tab's window of events.
 *
 * The per-tab `authors` narrowing happens here rather than only in the pure
 * selector, and both is on purpose. Here, because a tab like Mine over a busy
 * community would otherwise page fifty notes by other people and select none of
 * them — an empty feed that is not empty. In the selector, because that is the
 * rule a test can hold, and because the two tabs that cannot be narrowed by
 * author (Everyone, Liked) still go through it.
 *
 * `search` returns nothing at all: §3.1 says it is not wired to a backend, and
 * quietly answering it with the Everyone feed would read as a search that
 * matched everything.
 */
export const feed = query({
  args: { ...scopeArgs, tab: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<PulseFeedResult> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    if (!isTab(args.tab)) throw new ConvexError("Unknown Pulse tab");
    const tab = args.tab;
    const limit = Math.min(Math.max(args.limit ?? PULSE_PAGE_LIMIT, 1), PULSE_PAGE_LIMIT);

    const viewerPubkey = (await pubkeyFor(ctx, "user", subject)) ?? "";
    const [contactPubkeys, agents] = await Promise.all([
      contactsFor(ctx, scope, viewerPubkey),
      agentPubkeysFor(ctx, scope),
    ]);

    // Which notes this reader has upvoted. Needed by every tab (it is the state
    // of the pill) and it is the whole query for Liked, so it is read once.
    const myReactions = viewerPubkey
      ? await readEventsCore(ctx, {
          scope,
          filters: [
            { kinds: [KIND_REACTION], authors: [viewerPubkey], limit: MY_REACTION_WINDOW },
          ],
          readerPubkey: viewerPubkey,
        })
      : [];
    const likedNoteIds = [
      ...new Set(
        myReactions
          .filter((event) => event.content.trim() === UPVOTE)
          .map((event) => lastETag(event.tags))
          .filter((id): id is string => id !== null),
      ),
    ];

    let notes: NostrEvent[] = [];
    if (tab === "search") {
      notes = [];
    } else if (tab === "liked") {
      const ids = likedNoteIds.slice(0, limit);
      notes =
        ids.length === 0
          ? []
          : await readEventsCore(ctx, {
              scope,
              filters: [{ ids, kinds: [KIND_TEXT_NOTE], limit }],
              readerPubkey: viewerPubkey,
            });
    } else {
      const authors =
        tab === "mine"
          ? viewerPubkey
            ? [viewerPubkey]
            : []
          : tab === "following"
            ? contactPubkeys
            : tab === "agents"
              ? agents.pubkeys
              : undefined;
      // An empty author list is a caller who narrowed to nobody, not one who
      // forgot to narrow — the same rule `kinds: []` follows in the log. Passing
      // it through would read the whole community.
      notes =
        authors !== undefined && authors.length === 0
          ? []
          : await readEventsCore(ctx, {
              scope,
              filters: [
                { kinds: [KIND_TEXT_NOTE], limit, ...(authors ? { authors } : {}) },
              ],
              readerPubkey: viewerPubkey,
            });
    }

    const noteIds = notes.map((note) => note.id);
    const reactions =
      noteIds.length === 0
        ? []
        : await readEventsCore(ctx, {
            scope,
            filters: [
              {
                kinds: [KIND_REACTION],
                tags: [{ name: "e", values: noteIds }],
                limit: Math.min(noteIds.length * 20, 1000),
              },
            ],
            readerPubkey: viewerPubkey,
          });

    // One name per pubkey on screen, resolved here rather than per row: a feed
    // of fifty notes is usually a handful of authors, and fifty round trips to
    // answer that would be fifty reads of the same three rows.
    const seen = new Set<string>();
    const authorList: PulseAuthor[] = [];
    for (const pubkey of [
      ...notes.map((n) => n.pubkey),
      ...reactions.map((r) => r.pubkey),
    ]) {
      if (seen.has(pubkey)) continue;
      seen.add(pubkey);
      const described = await describePubkey(ctx, pubkey);
      authorList.push({
        pubkey,
        name: described?.name ?? "Unknown",
        isAgent: described?.isAgent ?? false,
      });
    }

    return {
      viewerPubkey,
      notes,
      reactions,
      contactPubkeys,
      agentPubkeys: agents.pubkeys,
      likedNoteIds,
      agentCount: agents.count,
      authors: authorList,
    };
  },
});

/**
 * Say something on Pulse — an ordinary kind-1 note.
 *
 * Global by construction: kind 1 is a global kind, so the note has no channel
 * and reaches the community rather than a room. That is the whole difference
 * between Pulse and a channel, and it is a property of the kind rather than of
 * this function.
 *
 * Mentions are resolved **server-side from the body** by `messages.resolveMentions`
 * — imported, not re-rolled. A client that forgets to send its mentions must not
 * be able to produce a note whose stored `p` tags disagree with its own text:
 * the tag is what wakes somebody up, and a body reading "@Ada" over an event
 * that names nobody is a notification that silently never arrives.
 */
export const post = mutation({
  args: { ...scopeArgs, body: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const body = args.body.trim();
    if (body.length === 0) throw new ConvexError("A note needs something in it");

    const actor = await userActor(ctx, subject);
    const authorPubkey = await pubkeyFor(ctx, "user", subject);
    if (!authorPubkey) {
      throw new ConvexError("Open Chat once before posting — a note is signed by you");
    }
    // The same enforcement seam a room message hits (§6.3). A community
    // restriction that stopped somebody talking in rooms but not on the
    // community-wide feed would be a restriction in name only.
    await requireNotRestricted(ctx, scope, authorPubkey);

    const mentions = await resolveMentions(ctx, body, authorPubkey);
    const outcome = await publishCore(ctx, {
      actor,
      scope,
      kind: KIND_TEXT_NOTE,
      tags: mentions.map((pubkey) => ["p", pubkey]),
      content: body,
    });
    if (outcome.status === "dominated" || outcome.status === "ephemeral") {
      throw new ConvexError("The log refused this note; nothing was written");
    }
    return { eventId: outcome.event.id };
  },
});

/**
 * Toggle an upvote on a note.
 *
 * Idempotent in both directions, which is what makes it safe to drive from an
 * optimistic pill: upvoting twice is one reaction, un-upvoting something you
 * never upvoted is a no-op that says so. The retraction is a **kind-5 naming
 * the reaction**, plus a soft delete on the reaction row, which is NIP-09 —
 * the same two halves `messages.unreactCore` performs, because that is what the
 * protocol says a retraction is, not because one file copied another.
 *
 * The kind-7 carries **no `h` tag**: a reaction's room is derived from the
 * event it points at, so a reaction can never plant itself in a room its target
 * is not in. Here the target is a global note, so the reaction is global too.
 */
export const upvote = mutation({
  args: { ...scopeArgs, noteId: v.string(), on: v.boolean() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const actor = await userActor(ctx, subject);
    const authorPubkey = await pubkeyFor(ctx, "user", subject);
    if (!authorPubkey) {
      throw new ConvexError("Open Chat once before upvoting — a reaction is signed by you");
    }
    await requireNotRestricted(ctx, scope, authorPubkey);

    // The note has to be reachable *through the read path*, not merely present:
    // `readEventsCore` is what applies the global boundary and the per-event
    // gate, so reacting to something is refused for exactly the reasons reading
    // it would be. Reacting to an event you cannot see would otherwise be a way
    // to find out that it exists.
    const [note] = await readEventsCore(ctx, {
      scope,
      filters: [{ ids: [args.noteId], kinds: [KIND_TEXT_NOTE], limit: 1 }],
      readerPubkey: authorPubkey,
    });
    if (!note || note.id !== args.noteId) throw new ConvexError("That note could not be found");

    const existing = await myUpvote(ctx, scope, args.noteId, authorPubkey);

    if (args.on) {
      if (existing) return { reacted: true, changed: false };
      await publishCore(ctx, {
        actor,
        scope,
        kind: KIND_REACTION,
        tags: [["e", args.noteId]],
        content: UPVOTE,
      });
      return { reacted: true, changed: true };
    }

    if (!existing) return { reacted: false, changed: false };
    await publishCore(ctx, {
      actor,
      scope,
      kind: KIND_DELETION,
      tags: [["e", existing.eventId]],
      content: "",
    });
    await ctx.db.patch(existing._id, { deletedAt: Date.now() });
    return { reacted: false, changed: true };
  },
});

/** How many reaction rows "have I already upvoted this" may look at. */
const REACTION_SCAN = 200;

/** The reader's own live `+` on one note, if any. */
async function myUpvote(
  ctx: MutationCtx,
  scope: Scope,
  noteId: string,
  pubkey: string,
) {
  const tagRows = await ctx.db
    .query("buzzEventTags")
    .withIndex("by_tag_kind", (q) =>
      q
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("name", "e")
        .eq("value", noteId)
        .eq("kind", KIND_REACTION),
    )
    .take(REACTION_SCAN);
  for (const tagRow of tagRows) {
    const row = await ctx.db
      .query("buzzEvents")
      .withIndex("by_scope_event_id", (q) =>
        q
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId)
          .eq("eventId", tagRow.eventId),
      )
      .first();
    if (!row || row.deletedAt !== undefined || row.supersededAt !== undefined) continue;
    if (row.pubkey !== pubkey) continue;
    if (row.content.trim() !== UPVOTE) continue;
    return row;
  }
  return null;
}

/** The acting principal, in the shape every write path in this app takes. */
async function userActor(ctx: QueryCtx | MutationCtx, subject: string) {
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", subject))
    .unique();
  return {
    type: "user" as const,
    id: subject,
    name: user?.name ?? user?.email ?? subject,
  };
}

/**
 * One note by id, through the same read path.
 *
 * Exists for a permalink. Deliberately built on `readEventsCore` rather than a
 * `db.get`: a bare id lookup is the read-leak shape, and this way an event the
 * filtered read would withhold is withheld here too.
 */
export const note = query({
  args: { ...scopeArgs, noteId: v.string() },
  handler: async (ctx, args): Promise<NostrEvent | null> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const readerPubkey = (await pubkeyFor(ctx, "user", subject)) ?? "";
    const [found] = await readEventsCore(ctx, {
      scope,
      filters: [{ ids: [args.noteId], kinds: [KIND_TEXT_NOTE], limit: 1 }],
      readerPubkey,
    });
    return found && found.id === args.noteId ? found : null;
  },
});
