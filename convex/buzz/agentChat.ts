// Being in the room, from the other side of the key.
//
// This is the surface an agent's own runtime calls to take part in Chat: list
// the rooms it can see, join one, read it, say something, reply in a thread,
// react, move its read marker, say what it is working on, search. It exists
// because of D9 — **the turn runs on the agent's own runtime**, so a mention is
// a ping to a harness and the answer comes back through tools like these. We do
// not run the turn; there is no server-side fallback, and a newly created agent
// is silent until somebody runs a harness for it. That silence is the honest
// state and this file is the other half of it.
//
// Three rules shape every function below, and none of them are new here.
//
//   - **One write path.** Every mutation calls the same core a person's click
//     calls — `postMessageCore`, `joinChannelCore`, `reactCore`,
//     `markChannelReadCore`, `publishStatus` — with an agent `Actor` instead of
//     a user one. That is the codebase's Actor pattern (CLAUDE.md), and the
//     reason for it is specific rather than tidy: a message is not one write. It
//     is a signed event, a server-derived mention set, a thread root climbed
//     from the parent, a room clock, and a notification fan-out, and a second
//     implementation that got four of the five right would produce agent
//     messages that look correct in the transcript and quietly notify nobody.
//
//   - **Identity, not a flag.** An agent's events are signed by the agent's own
//     key (`publishCore` → `requireSigningIdentity`), so who wrote what is
//     answerable forever from the log itself, without trusting a boolean column
//     (02-agents §10.3, D3). Nothing here can sign as its owner, as the
//     deployment, or as the community relay. An agent that has never been
//     minted a key cannot write at all, and the refusal names the human action
//     that fixes it — an agent must not be able to summon its own identity.
//
//   - **The fence is the agent's scope.** A room is looked up by
//     `(scopeType, scopeId, channelId)` inside the community the *key* resolves
//     to, so a channel id from another workspace does not resolve to a refusal,
//     it resolves to nothing. Note what is deliberately absent from every
//     signature below: a scope argument. The community comes from the key, so
//     there is no field a caller could put somebody else's community into —
//     which is the same rule the human surfaces get from `requireScopeAccess`,
//     reached through the other door (D4).
//
// Governance is `_agentAuth.requireAgentByKey`'s, not this file's, and the mode
// argument is the whole of it. `"write"` refuses a readonly agent **before** it
// touches the daily budget or the burst counter, so a refused post costs an
// agent nothing; `"presence"` is neither role-gated nor budgeted, which is why
// heartbeat-shaped calls (marking read, saying what you are doing) use it —
// telling the room what you are doing must never consume the budget for doing
// it. Nothing below reimplements a limit, and nothing below should ever start.

import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import {
  agentActor,
  requireAgentByKey,
  requireUnrestricted,
} from "../_agentAuth";
import {
  joinChannelCore,
  leaveChannelCore,
  listChannelsCore,
  resolveChannelForActor,
  type ChannelPrincipal,
} from "./channels";
import {
  postMessageCore,
  reactCore,
  readChannelPage,
  readThreadPage,
  unreactCore,
} from "./messages";
import { markChannelReadCore } from "./readState";
import { publishStatus, USER_STATUS_MAX_LENGTH } from "./presence";
import { searchMessagesCore } from "./search";
import { describePubkey, pubkeyFor } from "./identity";
import type { Scope } from "./log";
import type { NostrEvent } from "./_nostr";

// ---------------------------------------------------------------------------
// The community, and the principal acting in it
// ---------------------------------------------------------------------------

/**
 * The community an agent belongs to, which is the only one it can reach.
 *
 * A Buzz community is a workspace or a personal space (D4) and an agent is
 * scoped to exactly one of those, so the mapping is total and there is nothing
 * to choose.
 */
function communityFor(agent: Doc<"agents">): Scope {
  return { scopeType: agent.parentType, scopeId: agent.parentId };
}

/**
 * Authenticate a key, and hand back both the agent and the shape the cores take.
 *
 * `mode` is passed straight through to `requireAgentByKey` — the role check, the
 * daily budget, the burst cap and the x402 metering all live there and are
 * deliberately not restated. A revoked key, an expired OAuth token and a paused
 * agent all fail closed inside it before this function returns anything.
 */
async function requireAgentPrincipal(
  ctx: QueryCtx | MutationCtx,
  apiKey: string,
  mode: "read" | "write" | "presence" = "read",
): Promise<{ agent: Doc<"agents">; scope: Scope; principal: ChannelPrincipal }> {
  const { agent } = await requireAgentByKey(ctx, apiKey, mode);
  return {
    agent,
    scope: communityFor(agent),
    principal: {
      actor: agentActor(agent),
      actorType: "agent",
      actorId: agent._id,
    },
  };
}

/**
 * The room, resolved inside the agent's own community.
 *
 * There is no cross-community branch to get wrong: the id is looked up under
 * the scope the key resolved to, and a room in another workspace simply is not
 * there. `resolveChannelForActor` then applies the room's own rule — archived
 * and private rooms are members-only, a DM is participants-only — and reports
 * "Channel not found" for all of them, because whether `#acquisition` exists is
 * itself the thing a private room is keeping.
 */
async function requireRoom(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  principal: ChannelPrincipal,
  channelId: string,
) {
  return await resolveChannelForActor(ctx, scope, channelId, principal.actorId);
}

/**
 * Who wrote the events on a page, resolved once per distinct key.
 *
 * The read hands back **raw events** rather than rendered messages, for the
 * reason `messages.ts` gives at length: the fold from events to what a reader
 * sees is one pure function (`src/lib/buzz/timeline.ts`) and a server-side
 * second copy would drift from it. But a bare event names its author as 64 hex
 * characters, and an agent deciding whether it is being talked to needs a name
 * — so the names travel beside the events instead of inside them, which keeps
 * the events exactly what the log holds.
 */
async function authorsFor(
  ctx: QueryCtx,
  events: readonly NostrEvent[],
): Promise<
  Record<string, { name: string; isAgent: boolean; actorType: string; actorId: string }>
> {
  const out: Record<
    string,
    { name: string; isAgent: boolean; actorType: string; actorId: string }
  > = {};
  for (const event of events) {
    if (out[event.pubkey]) continue;
    const described = await describePubkey(ctx, event.pubkey);
    out[event.pubkey] = described
      ? {
          name: described.name,
          isAgent: described.isAgent,
          actorType: described.type,
          actorId: described.id,
        }
      : // A relay-signed row (a system message) has no principal behind it, and
        // saying so is better than inventing one: "the community said this" is
        // exactly the distinction relay signing exists to draw.
        { name: "the community", isAgent: false, actorType: "relay", actorId: "" };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Who am I, in Chat?
 *
 * The first call a harness makes. `pubkey` being null is the interesting
 * answer and the one worth reading carefully: it means nobody has minted this
 * agent a signing identity, so every write below will refuse. That is not a
 * failure state to route around — minting happens in a Node action a human
 * runs when the agent is attached to a room, precisely so that an agent cannot
 * summon its own identity (02-agents §10.3).
 */
export const identity = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent, scope } = await requireAgentPrincipal(ctx, apiKey);
    const pubkey = await pubkeyFor(ctx, "agent", agent._id);
    const role = agent.role ?? "member";
    return {
      agentId: agent._id,
      name: agent.name,
      community: scope,
      pubkey,
      role,
      // Two separate facts, because they refuse different things: a readonly
      // agent may read every room and write in none, and a list-restricted
      // agent may write in the rooms it is in but may not change its own
      // membership.
      canWrite: role !== "readonly",
      canChangeOwnMembership: role !== "readonly" && agent.allowedListIds === undefined,
      ...(pubkey === null
        ? {
            note: "This agent has no Chat signing key yet, so it cannot post, react or join. A human mints one when the agent is attached to a room.",
          }
        : {}),
    };
  },
});

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/**
 * Every room in this community the agent may see, with its unread numbers.
 *
 * The rail's own answer, from the rail's own function, so an agent and the
 * person beside it are never looking at different lists. `joined` is the field
 * that matters to a harness: an open room it can see but has not joined is
 * readable and not writable, which is the header a person sees too.
 */
export const listChannels = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent, scope } = await requireAgentPrincipal(ctx, apiKey);
    return await listChannelsCore(ctx, scope, {
      actorType: "agent",
      actorId: agent._id,
    });
  },
});

/**
 * Join an open room.
 *
 * Two governance facts sit on this one call. It is a `"write"`, so a readonly
 * agent is refused before the budget moves. And it is refused outright for a
 * **list-restricted** agent: `allowedListIds` says this agent's world is
 * exactly those lists, and a principal that can widen its own reach is not
 * restricted — the same reason `requireUnrestricted` guards every other
 * structure-level operation in `agentApi`. A restricted agent still works in
 * rooms a human puts it in, which is Buzz's model anyway (§3.1: a human
 * attaches an agent to a channel).
 *
 * A private room refuses regardless — `joinChannelCore` says so — because a
 * private room is joined by being added.
 */
export const joinChannel = mutation({
  args: { apiKey: v.string(), channelId: v.string() },
  handler: async (ctx, { apiKey, channelId }) => {
    const { agent, scope, principal } = await requireAgentPrincipal(ctx, apiKey, "write");
    requireUnrestricted(agent);
    return await joinChannelCore(ctx, scope, channelId, principal);
  },
});

/** Leave a room. Same governance as joining, and for the same reason. */
export const leaveChannel = mutation({
  args: { apiKey: v.string(), channelId: v.string() },
  handler: async (ctx, { apiKey, channelId }) => {
    const { agent, scope, principal } = await requireAgentPrincipal(ctx, apiKey, "write");
    requireUnrestricted(agent);
    return await leaveChannelCore(ctx, scope, channelId, principal);
  },
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * A page of a room, newest first, as raw signed events plus who wrote them.
 *
 * Reading does **not** move the read marker: a query cannot write, and that
 * limitation happens to be the right behaviour anyway — an agent that fetched a
 * page while deciding whether to answer would otherwise silently mark a room
 * caught up. `markRead` is the separate, deliberate act.
 *
 * What comes back is the log, not a rendering: kind 9 is a message, 40003
 * overlays one with an edit, 9005 says one was removed, 7 is a reaction, 40099
 * is the room narrating itself. The `e` tags carry threading (`root` / `reply`
 * markers), the `p` tags carry mentions.
 */
export const readChannel = query({
  args: {
    apiKey: v.string(),
    channelId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { apiKey, channelId, cursor, limit }) => {
    const { agent, scope, principal } = await requireAgentPrincipal(ctx, apiKey);
    const { channel, membership } = await requireRoom(ctx, scope, principal, channelId);
    const readerPubkey = (await pubkeyFor(ctx, "agent", agent._id)) ?? "";
    const page = await readChannelPage(ctx, scope, channel, readerPubkey, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return {
      channelId: channel.channelId,
      name: channel.name,
      displayName: channel.displayName,
      topic: channel.topic ?? null,
      joined: membership !== null,
      archived: channel.archivedAt !== undefined,
      ...page,
      authors: await authorsFor(ctx, page.events),
    };
  },
});

/**
 * One thread: the message that started it, its whole subtree, and the events
 * that overlay them — read forwards, the way a thread is read.
 */
export const readThread = query({
  args: {
    apiKey: v.string(),
    channelId: v.string(),
    rootId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { apiKey, channelId, rootId, cursor, limit }) => {
    const { agent, scope, principal } = await requireAgentPrincipal(ctx, apiKey);
    const { channel } = await requireRoom(ctx, scope, principal, channelId);
    const readerPubkey = (await pubkeyFor(ctx, "agent", agent._id)) ?? "";
    const page = await readThreadPage(ctx, scope, channel, readerPubkey, {
      rootId,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return {
      channelId: channel.channelId,
      rootId,
      ...page,
      authors: await authorsFor(ctx, page.events),
    };
  },
});

/**
 * Search this community's messages.
 *
 * The same index, the same gate before the branch, the same per-room and
 * per-event visibility a person's search runs — with the agent as the reader,
 * so a private room it is not in cannot surface a hit. There is no cursor by
 * design (a relevance-ordered index cannot be paged stably while the log is
 * being written to); `truncated` says to narrow the question instead.
 */
export const search = query({
  args: {
    apiKey: v.string(),
    text: v.string(),
    channelIds: v.optional(v.array(v.string())),
    authors: v.optional(v.array(v.string())),
    since: v.optional(v.number()),
    until: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { apiKey, ...args }) => {
    const { agent, scope } = await requireAgentPrincipal(ctx, apiKey);
    return await searchMessagesCore(
      ctx,
      scope,
      { actorType: "agent", actorId: agent._id },
      args,
    );
  },
});

// ---------------------------------------------------------------------------
// Saying something
// ---------------------------------------------------------------------------

/**
 * Post in a room, or reply in a thread.
 *
 * `parentId` makes it a reply and the server derives the thread root from that
 * parent rather than believing anything the caller says about it — a wrong root
 * does not fail, it files the message under a thread nobody is reading, in a log
 * that never rewrites.
 *
 * Mentions are parsed out of the body server-side (`@[Name](actorId)`), so an
 * agent that writes a name into its message wakes that person up without having
 * to know there is a tag involved — and cannot produce a message whose tags
 * disagree with its own text.
 *
 * Membership is required, not merely visibility: an open room is readable by
 * the whole community and writable by its members, which is the same sentence
 * the room header shows a person.
 */
export const postMessage = mutation({
  args: {
    apiKey: v.string(),
    channelId: v.string(),
    body: v.string(),
    parentId: v.optional(v.string()),
    rootId: v.optional(v.string()),
  },
  handler: async (ctx, { apiKey, channelId, ...input }) => {
    const { scope, principal } = await requireAgentPrincipal(ctx, apiKey, "write");
    return await postMessageCore(ctx, scope, channelId, principal, input);
  },
});

/**
 * React to a message. Idempotent: the same emoji twice is the same act, and the
 * second call hands back the first reaction rather than adding a row.
 */
export const react = mutation({
  args: {
    apiKey: v.string(),
    channelId: v.string(),
    targetId: v.string(),
    emoji: v.string(),
  },
  handler: async (ctx, { apiKey, channelId, ...input }) => {
    const { scope, principal } = await requireAgentPrincipal(ctx, apiKey, "write");
    return await reactCore(ctx, scope, channelId, principal, input);
  },
});

/** Take a reaction back. Removing one that was never there is not an error. */
export const unreact = mutation({
  args: {
    apiKey: v.string(),
    channelId: v.string(),
    targetId: v.string(),
    emoji: v.string(),
  },
  handler: async (ctx, { apiKey, channelId, ...input }) => {
    const { scope, principal } = await requireAgentPrincipal(ctx, apiKey, "write");
    return await unreactCore(ctx, scope, channelId, principal, input);
  },
});

// ---------------------------------------------------------------------------
// Bookkeeping about itself — never metered
// ---------------------------------------------------------------------------

/**
 * Move this agent's read marker in one room.
 *
 * `"presence"` mode, matching `agentApi.markChannelRead` word for word on the
 * reason: catching up on reading is not a metered action and must not consume
 * an agent's daily budget. It follows that a **readonly** agent may mark read
 * too, which is deliberate — read state is a fact about the reader, not a
 * change to the room, and a readonly agent that could not record what it had
 * seen would re-read the whole room on every wake and the rail's unread numbers
 * for it would never fall.
 *
 * A room the agent is not in is a quiet no-op rather than a refusal, exactly as
 * it is for a person glancing at an open room they never joined.
 */
export const markRead = mutation({
  args: {
    apiKey: v.string(),
    channelId: v.string(),
    /** Unix **seconds**. Absent means "as far as the room has got". */
    readAt: v.optional(v.number()),
    topLevelOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, { apiKey, channelId, readAt, topLevelOnly }) => {
    const { scope, principal } = await requireAgentPrincipal(ctx, apiKey, "presence");
    const { channel, membership } = await requireRoom(ctx, scope, principal, channelId);
    if (!membership) return { markedAt: null };
    return await markChannelReadCore(ctx, scope, channel, principal, {
      ...(readAt !== undefined ? { readAt } : {}),
      ...(topLevelOnly !== undefined ? { topLevelOnly } : {}),
    });
  },
});

/**
 * "Working on the migration."
 *
 * The same kind-30315 at the same coordinate a person's status uses, signed by
 * the agent's own key — which is what puts an agent's working state beside a
 * person's in the roster rather than in a separate panel about machines
 * (02-agents §3.4). Replaceable, so setting one replaces the last rather than
 * accumulating a history of moods.
 *
 * `"presence"` mode: saying what you are doing must never spend the budget for
 * doing it, and a throttled or readonly agent must still be able to say it —
 * "I have hit my limit" is precisely the status worth publishing.
 *
 * An empty text and emoji clears it, which publishes the same cleared shape the
 * human `clearStatus` publishes. Clearing is an explicit event, never a delete:
 * "I took my status down" is a fact readers need, and a cache holding the old
 * one needs something newer to learn from.
 */
export const setStatus = mutation({
  args: {
    apiKey: v.string(),
    text: v.string(),
    emoji: v.optional(v.string()),
    /** Milliseconds, or absent for "until it is cleared". */
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, { apiKey, text, emoji, expiresAt }) => {
    const { scope, principal } = await requireAgentPrincipal(ctx, apiKey, "presence");
    return await publishStatus(ctx, scope, principal.actor, {
      text: text.trim().slice(0, USER_STATUS_MAX_LENGTH),
      emoji: (emoji ?? "").trim(),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });
  },
});

// A note on what is deliberately *not* here, so it reads as a decision rather
// than an oversight.
//
//   - **Creating a room.** A room is a place people are put into and a name a
//     community has to live with; Buzz has humans create them and agents get
//     attached (§3.1). An agent that wanted one can ask for it in a room it is
//     already in, which is a sentence a person can say no to.
//   - **Editing and deleting messages.** The append-only log keeps both
//     available, and neither is something an agent needs to do its work — while
//     a moderator-shaped delete in an agent's hands is a way for a bad turn to
//     remove the evidence of itself.
//   - **Adding or removing other members.** Membership is governance, and
//     governance over an agent is a human's (02-agents §10.2). An agent that
//     could add another agent to a room could grow a fleet nobody chose.
