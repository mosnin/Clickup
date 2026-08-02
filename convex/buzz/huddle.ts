// Huddles: the lifecycle, the roster, and everything that is true with no
// audio provider at all.
//
// 00-decisions.md D6 is the whole shape of this file. Buzz's huddle is a room
// on its own relay's WebSocket carrying custom binary Opus frames — a stateful
// audio server that Convex is not and cannot be. We resolved that as a managed
// SFU carrying audio, with **identity, the roster and every lifecycle event
// staying ours, on the log**. So this module never touches audio. It publishes
// four signed events and reads them back, and that is the entire backend of a
// huddle:
//
//     48100  a call was started here          signed by the starter
//     48101  somebody joined                  signed by the community relay
//     48102  somebody left                    signed by the community relay
//     48103  the call is over                 signed by the community relay
//
// The three relay-signed ones are relay-signed for the reason `relay.ts` gives
// about membership: "Ada left the call" is worth something only if Ada could
// not have written it about somebody else. The participant's identity travels
// in the `p` tag, never in `pubkey` — every consumer must read it that way, and
// `participantPubkeyOf` in `src/lib/buzz/huddle.ts` is the one function that
// does.
//
// ---------------------------------------------------------------------------
// No tables, and no second room
//
// **This module owns no table.** A huddle is fully described by its events, so
// a projection row could only ever be a second copy that goes stale — and the
// property we most need is the one a table would cost us: a huddle is real
// whether or not any audio provider is configured, because the record is the
// log and nothing else. `foldHuddles` reconstructs the whole set on every read,
// which is idempotent by construction and survives out-of-order delivery and
// reconnect replay (§1.17).
//
// It also creates no ephemeral channel, which is where Buzz puts the huddle's
// id, guidelines, reactions and transcript. Ours is identified by **the id of
// its 48100** — the same rule `channels.create` uses for a room, and for the
// same reasons: an event id is a hash, so it is unique without the CSPRNG a
// Convex mutation does not have, and a client cannot collide it on purpose.
// The deltas point back at it with an `e` tag, which is indexed, so "every
// event of this call" is a range rather than a scan. A disposable room per call
// would clutter every rail and need a second copy of `channels.create`'s
// transaction to build.
//
// ---------------------------------------------------------------------------
// What is not here
//
// No screen share, no video, no deafen, no recording (§1.21). Those are absent
// from Buzz on purpose and their absence is a feature: the speaker control
// silences *synthesized agent speech* and there is deliberately no control
// anywhere that mutes another human.

import { ConvexError, v } from "convex/values";
import { action, mutation, query } from "../_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { anyApi } from "convex/server";
import type { FunctionReference } from "convex/server";
import { api } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { requireAgentByKey, type Actor } from "../_agentAuth";
import { publishCore, readEventsCore, type Scope } from "./log";
import {
  mayGovernCommunity,
  requireChannelAccess,
  resolveChannelForActor,
} from "./channels";
import { asRelay } from "./relay";
import { describePubkey, pubkeyFor } from "./identity";
import { buzzRoomChannel } from "./presence";
import {
  HUDDLE_LIFECYCLE_KINDS,
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_GUIDELINES,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
  KIND_HUDDLE_REACTION,
  KIND_HUDDLE_STARTED,
  MAX_HUDDLE_AGENTS,
  MAX_HUDDLE_PARTICIPANTS,
  agentsIn,
  foldHuddles,
  huddleById,
  isInHuddle,
  liveHuddle,
  normalizeReaction,
  normalizeSenderName,
  shouldAutoEnd,
  type HuddleLogEvent,
  type HuddleSnapshot,
} from "../../src/lib/buzz/huddle";

const scopeArgs = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

/**
 * How much of a room's huddle history one read looks at.
 *
 * Buzz subscribes with `limit: 100` and reconstructs from whatever arrives,
 * which is why `foldHuddles` can infer a huddle from a delta whose start has
 * scrolled out. Ours is higher because our page is per-kind rather than
 * combined, and it is still a bound rather than "everything": a room that has
 * held ten thousand calls must not read them all to answer "is anybody talking
 * right now".
 */
const HUDDLE_READ_LIMIT = 200;

/**
 * What agents are told when they join a call (§1.14).
 *
 * Published as a 48106 **before** any agent is added, and the ordering is
 * Buzz's with Buzz's reason: an agent subscribes when it learns it is a member
 * and may finish its backfill before a later-published briefing exists, so a
 * briefing written after the membership is a briefing some agents never see.
 *
 * The content is prompt text rather than a schema because that is what it is —
 * the prompt-level equivalent of token streaming. One sentence per message cuts
 * time-to-first-audio; markdown and code have no spoken form and belong in the
 * room; an agent that is not addressed says nothing, because a machine that
 * answers every remark is a machine nobody leaves in a call.
 */
export const VOICE_MODE_GUIDELINES = [
  "You are in a voice huddle. Reply immediately and briefly.",
  "Send one sentence per message — it is spoken as it arrives, so a long message is a long silence.",
  "No markdown, no code blocks, no lists. If the answer is code, say you will post it in the main channel, then post it there.",
  "Say one short sentence before running a tool, so the room knows why it went quiet.",
  "If a person starts speaking while you are mid-reply, drop the sentences you have not sent.",
  "If you are not addressed, say nothing.",
].join("\n");

// ---------------------------------------------------------------------------
// Cross-module calls
// ---------------------------------------------------------------------------

/**
 * `channels.addMembers`, as a callable.
 *
 * Through `anyApi` for the reason ./keys.ts states: the checked-in
 * `convex/_generated/api.d.ts` is a hand-rolled stub that predates
 * `convex/buzz/`, and only `npx convex dev` may rewrite it. **Replace with
 * `api.buzz.channels.addMembers` the first time the CLI regenerates it.**
 *
 * Called rather than reimplemented: putting an agent in a room is one fact with
 * one write path, and a second inserter here would be a second place for the
 * 9000, the system row, the member notification and the soft-delete reversal to
 * be got subtly differently — differently only for agents, which is to say in
 * the case nobody is watching.
 */
const channelsApi = anyApi.buzz.channels as unknown as {
  addMembers: FunctionReference<
    "mutation",
    "public",
    {
      scopeType: "user" | "workspace";
      scopeId: string;
      channelId: string;
      members: { actorId: string; actorType: "user" | "agent" }[];
      role?: "admin" | "member" | "guest" | "bot";
    },
    { added: string[]; errors: { actorId: string; error: string }[] }
  >;
};

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

type ChannelRow = Doc<"buzzChannels">;

/** The acting principal, in the shape every write path in this app takes. */
async function userActor(ctx: QueryCtx | MutationCtx, subject: string): Promise<Actor> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", subject))
    .unique();
  return { type: "user", id: subject, name: user?.name ?? user?.email ?? subject };
}

/**
 * You must be *in* the room to be in a call in it.
 *
 * `requireChannelAccess` is the tenancy fence plus the room's own visibility
 * rule; the membership check on top is the huddle's own bar and it is one null
 * test rather than a re-rolled rule. A person who can *see* an open room but
 * has not joined it has no business appearing in its call roster.
 */
async function requireRoomMembership(
  ctx: MutationCtx,
  scope: Scope,
  channelId: string,
): Promise<{ subject: string; channel: ChannelRow }> {
  const { subject, channel, membership } = await requireChannelAccess(ctx, scope, channelId);
  if (!membership) throw new ConvexError("You are not in this channel");
  if (channel.archivedAt !== undefined) {
    throw new ConvexError("This channel is archived");
  }
  return { subject, channel };
}

/**
 * The pubkey a principal's huddle events are addressed by, or a refusal.
 *
 * The same shape `channels.ts` uses for membership, and for the same reason: a
 * roster entry is a `p` tag, and a principal with no signing identity has no
 * value to put in one. Inventing one would put a string in a `p` tag that every
 * consumer compares against pubkeys and that silently never matches.
 */
async function requirePubkey(
  ctx: QueryCtx | MutationCtx,
  principalType: "user" | "agent",
  principalId: string,
  label: string,
): Promise<string> {
  const pubkey = await pubkeyFor(ctx, principalType, principalId);
  if (!pubkey) {
    throw new ConvexError(
      `${label} has not opened Chat yet, so they have no signing identity to join a huddle with.`,
    );
  }
  return pubkey;
}

/**
 * Publish, and refuse to continue if the log did not take it.
 *
 * `duplicate` is fine — an identical signed event already exists, so whatever
 * this transaction is about to do *is* explained. `dominated` wrote nothing.
 * `ephemeral` is accepted only where the caller expects it (a reaction), which
 * is why it is an argument rather than a blanket allowance: silently treating a
 * lifecycle event as fanned-out-but-unstored would produce a call nobody can
 * reconstruct.
 */
async function publishOrThrow(
  ctx: MutationCtx,
  args: Parameters<typeof publishCore>[1],
  opts: { allowEphemeral?: boolean } = {},
): Promise<string> {
  const outcome = await publishCore(ctx, args);
  if (outcome.status === "dominated") {
    throw new ConvexError("The channel log refused this huddle event; nothing was written.");
  }
  if (outcome.status === "ephemeral" && !opts.allowEphemeral) {
    throw new ConvexError("A huddle lifecycle event must be a stored event");
  }
  return outcome.event.id;
}

/** The lifecycle events of one room, folded. Always through the read core. */
async function readHuddles(
  ctx: QueryCtx,
  scope: Scope,
  channelId: string,
  readerPubkey: string,
): Promise<HuddleSnapshot[]> {
  const events = (await readEventsCore(ctx, {
    scope,
    filters: [
      {
        kinds: [...HUDDLE_LIFECYCLE_KINDS],
        tags: [{ name: "h", values: [channelId] }],
        limit: HUDDLE_READ_LIMIT,
      },
    ],
    readerPubkey,
  })) as HuddleLogEvent[];
  return foldHuddles(events, Date.now());
}

/**
 * The relay's record that somebody joined or left.
 *
 * Three tags and each is load-bearing: `h` binds the event to the room (48101–3
 * are channel-scoped, so without it the log refuses them and they would
 * otherwise be community-wide), `e` names the call, and `p` names the
 * participant — who is *not* the signer. `role` records whether a machine or a
 * person joined, at join time, so the auto-end rule can be evaluated from the
 * log alone rather than through a key lookup that a later account deletion
 * could change the answer to.
 */
function rosterDelta(
  scope: Scope,
  kind: number,
  input: { channelId: string; huddleId: string; pubkey: string; isAgent: boolean },
): Parameters<typeof publishCore>[1] {
  return asRelay(scope, {
    kind,
    tags: [
      ["h", input.channelId],
      ["e", input.huddleId],
      ["p", input.pubkey],
      ["role", input.isAgent ? "bot" : "human"],
    ],
    content: JSON.stringify({ huddle_id: input.huddleId, parent_channel_id: input.channelId }),
  });
}

function endEvent(
  scope: Scope,
  input: { channelId: string; huddleId: string },
): Parameters<typeof publishCore>[1] {
  return asRelay(scope, {
    kind: KIND_HUDDLE_ENDED,
    tags: [
      ["h", input.channelId],
      ["e", input.huddleId],
    ],
    content: JSON.stringify({ huddle_id: input.huddleId, parent_channel_id: input.channelId }),
  });
}

// ---------------------------------------------------------------------------
// Cores — one write path per fact, whoever is acting
// ---------------------------------------------------------------------------

export type JoinResult = { huddleId: string; joined: boolean };

/**
 * Put a principal in a call.
 *
 * The one function that publishes a 48101, and it is shared by every caller:
 * the starter joining their own call, a person joining an existing one, a
 * person adding an agent, and an agent joining under its own key. **An agent
 * joins exactly the way a person does** (D6) — same event, same tags, same
 * roster, one boolean different — which is what makes an agent appear in the
 * participant list beside people rather than in a panel about machines.
 */
async function joinHuddleCore(
  ctx: MutationCtx,
  scope: Scope,
  input: {
    channelId: string;
    pubkey: string;
    isAgent: boolean;
    /**
     * Folded once by the caller — every path here has already read it, and
     * re-reading would let the roster the rule was decided on differ from the
     * roster the caller checked.
     */
    snapshot: HuddleSnapshot | null;
  },
): Promise<JoinResult> {
  const { snapshot } = input;
  if (!snapshot) throw new ConvexError("That huddle is not in this room");
  if (!snapshot.live) {
    // An ended call can never be rejoined, which is the same rule Buzz enforces
    // relay-side by rejecting archived channels *first*: a call that auto-ended
    // when the last person left must not come back because somebody's tab was
    // still showing the old Join button.
    throw new ConvexError("That huddle has ended");
  }
  // Idempotent. A second Join is the same request as the first, and answering
  // it with an error would make a provider remount look like a failure.
  if (isInHuddle(snapshot, input.pubkey)) return { huddleId: snapshot.huddleId, joined: false };

  if (snapshot.participants.length >= MAX_HUDDLE_PARTICIPANTS) {
    throw new ConvexError(`A huddle holds at most ${MAX_HUDDLE_PARTICIPANTS} participants`);
  }
  if (input.isAgent && agentsIn(snapshot).length >= MAX_HUDDLE_AGENTS) {
    throw new ConvexError(`A huddle holds at most ${MAX_HUDDLE_AGENTS} agents`);
  }

  await publishOrThrow(
    ctx,
    rosterDelta(scope, KIND_HUDDLE_PARTICIPANT_JOINED, {
      channelId: input.channelId,
      huddleId: snapshot.huddleId,
      pubkey: input.pubkey,
      isAgent: input.isAgent,
    }),
  );
  return { huddleId: snapshot.huddleId, joined: true };
}

export type LeaveResult = { huddleId: string; left: boolean; ended: boolean };

/**
 * Take a principal out of a call, and end the call if they were the last human.
 *
 * The auto-end check runs on the roster **as it was before the leave** and is
 * decided by `shouldAutoEnd`, which is pure and shared with the client. The
 * order matters: publishing the 48102 first and then re-reading would work too,
 * but it would mean the rule was evaluated against a roster the caller had not
 * seen, and the one property this rule must have is that it is impossible for
 * two implementations to disagree about who was in the room.
 *
 * The machines are not individually removed. A 48103 clears the roster by
 * definition (`foldHuddles` empties it), so publishing N leave events for the
 * agents would be N events that say what one event already said.
 */
async function leaveHuddleCore(
  ctx: MutationCtx,
  scope: Scope,
  input: {
    channelId: string;
    pubkey: string;
    isAgent: boolean;
    snapshot: HuddleSnapshot | null;
  },
): Promise<LeaveResult> {
  const { snapshot } = input;
  if (!snapshot) throw new ConvexError("That huddle is not in this room");
  if (!snapshot.live || !isInHuddle(snapshot, input.pubkey)) {
    // Not an error. Leaving a call you are not in is what a client does when it
    // reconnects after the call already ended, and Buzz's `leave_huddle` is
    // idempotent for exactly that reason: a provider remount must never leave
    // the server holding an active huddle.
    return { huddleId: snapshot.huddleId, left: false, ended: !snapshot.live };
  }

  const ending = shouldAutoEnd(snapshot, input.pubkey);

  await publishOrThrow(
    ctx,
    rosterDelta(scope, KIND_HUDDLE_PARTICIPANT_LEFT, {
      channelId: input.channelId,
      huddleId: snapshot.huddleId,
      pubkey: input.pubkey,
      isAgent: input.isAgent,
    }),
  );

  if (ending) {
    await publishOrThrow(
      ctx,
      endEvent(scope, { channelId: input.channelId, huddleId: snapshot.huddleId }),
    );
  }

  return { huddleId: snapshot.huddleId, left: true, ended: ending };
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

/**
 * Start a huddle in this room.
 *
 * Publishing order, which is Buzz's with one inversion:
 *
 *   1. **48100 first**, because its id *is* the huddle and everything after it
 *      has to name it. Buzz publishes its equivalent last, since it already has
 *      a uuid from `Uuid::new_v4()`; a Convex mutation has no CSPRNG, so the
 *      hash is where our identity comes from and it has to exist first.
 *   2. **48106 guidelines before any agent joins.** Buzz's ordering and Buzz's
 *      reason: an agent subscribes on learning it is in the call and may finish
 *      its backfill before a later-published briefing exists.
 *   3. The starter's own 48101, then one per invited agent.
 *
 * An agent that cannot be added is **skipped with a reason**, never fatal — the
 * rule Buzz states as "only successfully added pubkeys are kept". Refusing the
 * whole call because one machine is paused would be a worse answer to a problem
 * the person can see and fix in the participants popover.
 *
 * A second concurrent call in one room is not started: the existing one is
 * returned with `created: false`. Two calls in one room split a conversation
 * with no way for anybody to tell which one the others are in, and a person who
 * pressed Start when a call was already running meant to be in that call.
 */
export const start = mutation({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    /** `agents` document ids to invite. Capped, deduped, order preserved. */
    agentIds: v.optional(v.array(v.string())),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    huddleId: string;
    created: boolean;
    agentsInvited: string[];
    agentErrors: { agentId: string; error: string }[];
  }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel } = await requireRoomMembership(ctx, scope, args.channelId);
    const actor = await userActor(ctx, subject);
    const pubkey = await requirePubkey(ctx, "user", subject, actor.name);

    const existing = liveHuddle(await readHuddles(ctx, scope, channel.channelId, pubkey));
    if (existing) {
      return { huddleId: existing.huddleId, created: false, agentsInvited: [], agentErrors: [] };
    }

    const requested = [...new Set(args.agentIds ?? [])];
    if (requested.length > MAX_HUDDLE_AGENTS) {
      throw new ConvexError(`A huddle holds at most ${MAX_HUDDLE_AGENTS} agents`);
    }

    const huddleId = await publishOrThrow(ctx, {
      actor,
      scope,
      kind: KIND_HUDDLE_STARTED,
      tags: [["h", channel.channelId]],
      // No room name in here. The 48100 is the row a timeline draws, and the
      // room it is in already says which room it is; repeating the name would
      // put it in a second place that a rename does not reach.
      content: JSON.stringify({ parent_channel_id: channel.channelId }),
    });

    await publishOrThrow(ctx, {
      actor,
      scope,
      kind: KIND_HUDDLE_GUIDELINES,
      tags: [
        ["h", channel.channelId],
        ["e", huddleId],
      ],
      content: VOICE_MODE_GUIDELINES,
    });

    // The starter is in their own call from the moment it exists, published as
    // an ordinary 48101 rather than implied by the 48100. That is what lets
    // `foldHuddles` build the roster from the deltas alone, with no special
    // case for the one participant whose membership was announced differently.
    await joinHuddleCore(ctx, scope, {
      channelId: channel.channelId,
      pubkey,
      isAgent: false,
      snapshot: huddleById(await readHuddles(ctx, scope, channel.channelId, pubkey), huddleId),
    });

    const agentsInvited: string[] = [];
    const agentErrors: { agentId: string; error: string }[] = [];
    for (const agentId of requested) {
      try {
        await addAgentCore(ctx, scope, {
          channel,
          agentId,
          // Re-folded per agent: each successful add is a 48101 the next one's
          // participant cap has to see. Folding once outside the loop would let
          // twenty-one agents past a cap of twenty.
          snapshot: huddleById(
            await readHuddles(ctx, scope, channel.channelId, pubkey),
            huddleId,
          ),
        });
        agentsInvited.push(agentId);
      } catch (error) {
        // Only *expected* refusals are collected. A ConvexError is a refusal we
        // wrote; anything else is a bug and must not be flattened into a
        // per-row message that hides it.
        if (!(error instanceof ConvexError)) throw error;
        agentErrors.push({ agentId, error: String(error.data) });
      }
    }

    return { huddleId, created: true, agentsInvited, agentErrors };
  },
});

// ---------------------------------------------------------------------------
// Joining, leaving, ending
// ---------------------------------------------------------------------------

export const join = mutation({
  args: { ...scopeArgs, channelId: v.string(), huddleId: v.string() },
  handler: async (ctx, args): Promise<JoinResult> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel } = await requireRoomMembership(ctx, scope, args.channelId);
    const actor = await userActor(ctx, subject);
    const pubkey = await requirePubkey(ctx, "user", subject, actor.name);
    const snapshot = huddleById(
      await readHuddles(ctx, scope, channel.channelId, pubkey),
      args.huddleId,
    );
    return await joinHuddleCore(ctx, scope, {
      channelId: channel.channelId,
      pubkey,
      isAgent: false,
      snapshot,
    });
  },
});

export const leave = mutation({
  args: { ...scopeArgs, channelId: v.string(), huddleId: v.string() },
  handler: async (ctx, args): Promise<LeaveResult> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel } = await requireRoomMembership(ctx, scope, args.channelId);
    const actor = await userActor(ctx, subject);
    const pubkey = await requirePubkey(ctx, "user", subject, actor.name);
    const snapshot = huddleById(
      await readHuddles(ctx, scope, channel.channelId, pubkey),
      args.huddleId,
    );
    return await leaveHuddleCore(ctx, scope, {
      channelId: channel.channelId,
      pubkey,
      isAgent: false,
      snapshot,
    });
  },
});

/**
 * End a call for everybody.
 *
 * The starter, or somebody who governs the community. Buzz makes this
 * creator-only with a `force` escape hatch the UI gates behind a confirmation,
 * for the case its comments call "creator vanished"; ours reaches the same
 * place without a second argument by letting the community's governor do it —
 * the same bar `channels.ts` uses for every other act that changes what
 * everyone sees, so there is one answer to "who may do this to a room".
 *
 * Anybody else who wants out uses `leave`, which is the honest verb for it.
 */
export const end = mutation({
  args: { ...scopeArgs, channelId: v.string(), huddleId: v.string() },
  handler: async (ctx, args): Promise<{ ended: boolean }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel } = await requireRoomMembership(ctx, scope, args.channelId);
    const pubkey = await requirePubkey(ctx, "user", subject, subject);
    const snapshot = huddleById(
      await readHuddles(ctx, scope, channel.channelId, pubkey),
      args.huddleId,
    );
    if (!snapshot) throw new ConvexError("That huddle is not in this room");
    if (!snapshot.live) return { ended: false };

    const isStarter = snapshot.startedByPubkey === pubkey;
    if (!isStarter && !(await mayGovernCommunity(ctx, scope, subject))) {
      throw new ConvexError("Only whoever started this huddle can end it for everybody");
    }

    await publishOrThrow(
      ctx,
      endEvent(scope, { channelId: channel.channelId, huddleId: snapshot.huddleId }),
    );
    return { ended: true };
  },
});

// ---------------------------------------------------------------------------
// Agents in the call
// ---------------------------------------------------------------------------

/**
 * Add a machine to a call.
 *
 * The fences are the ones `buzz/agents.ts` already states, checked again here
 * rather than assumed from an earlier attach: a fence added *after* an agent
 * joined a room must take effect without anybody remembering to detach it.
 *
 * Room membership is a **hard** prerequisite, which inverts Buzz's
 * best-effort-on-the-parent rule for a structural reason: Buzz has an ephemeral
 * channel the agent can be in even when adding it to the parent fails, and we
 * do not. An agent in a call it cannot read the room of would hear the audio
 * and see none of the conversation, so it is added to the room through
 * `channels.addMembers` — the one write path for that fact — or not added at
 * all.
 */
async function addAgentCore(
  ctx: MutationCtx,
  scope: Scope,
  input: { channel: ChannelRow; agentId: string; snapshot: HuddleSnapshot | null },
): Promise<JoinResult> {
  const agentId = ctx.db.normalizeId("agents", input.agentId);
  const agent = agentId ? await ctx.db.get(agentId) : null;
  if (!agent) throw new ConvexError("No such agent");
  if (agent.parentType !== scope.scopeType || agent.parentId !== scope.scopeId) {
    throw new ConvexError("This agent does not belong to that community");
  }
  if (agent.status !== "active") throw new ConvexError(`${agent.name} is paused`);
  if (agent.allowedListIds !== undefined) {
    // The same refusal `agents.assertMayJoinRooms` makes, in the same words'
    // spirit: a fence written in lists cannot describe a call, and a call
    // carries everything its participants say out loud.
    throw new ConvexError(
      `${agent.name} is restricted to specific lists, and a list allow-list cannot describe a huddle. Clear the restriction, or use a different agent.`,
    );
  }
  const pubkey = await requirePubkey(ctx, "agent", agent._id, agent.name);

  const member = await ctx.db
    .query("buzzMemberships")
    .withIndex("by_channel_actor", (q) =>
      q
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("channelId", input.channel.channelId)
        .eq("actorId", agent._id),
    )
    .unique();
  if (!member || member.removedAt !== undefined) {
    await ctx.runMutation(channelsApi.addMembers, {
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      channelId: input.channel.channelId,
      members: [{ actorId: agent._id, actorType: "agent" }],
      role: "bot",
    });
  }

  return await joinHuddleCore(ctx, scope, {
    channelId: input.channel.channelId,
    pubkey,
    isAgent: true,
    snapshot: input.snapshot,
  });
}

/** Add an agent to a call that is already running (the bar's Add-agent). */
export const addAgent = mutation({
  args: { ...scopeArgs, channelId: v.string(), huddleId: v.string(), agentId: v.string() },
  handler: async (ctx, args): Promise<JoinResult> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel } = await requireRoomMembership(ctx, scope, args.channelId);
    const pubkey = await requirePubkey(ctx, "user", subject, subject);
    const snapshot = huddleById(
      await readHuddles(ctx, scope, channel.channelId, pubkey),
      args.huddleId,
    );
    return await addAgentCore(ctx, scope, { channel, agentId: args.agentId, snapshot });
  },
});

/**
 * An agent's own runtime, joining a call.
 *
 * Key-authenticated in `"write"` mode: joining a call is a governed act, so a
 * read-only agent is refused here and the daily budget and burst cap bite here.
 * `agentLeave` below is `"presence"` for the reason the turn surface states —
 * once a machine is in a call, *getting out of it must never fail for budget
 * reasons*, or governance itself strands an agent in a room it cannot leave.
 *
 * Everything after the authentication is `joinHuddleCore`: the same event, the
 * same tags, the same roster a person gets.
 */
export const agentJoin = mutation({
  args: { apiKey: v.string(), ...scopeArgs, channelId: v.string(), huddleId: v.string() },
  handler: async (ctx, args): Promise<JoinResult> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { agent, pubkey } = await requireHuddleAgent(ctx, args.apiKey, scope, args.channelId, "write");
    const snapshot = huddleById(
      await readHuddles(ctx, scope, args.channelId, pubkey),
      args.huddleId,
    );
    if (agent.allowedListIds !== undefined) {
      throw new ConvexError(
        `${agent.name} is restricted to specific lists, and a list allow-list cannot describe a huddle.`,
      );
    }
    return await joinHuddleCore(ctx, scope, {
      channelId: args.channelId,
      pubkey,
      isAgent: true,
      snapshot,
    });
  },
});

export const agentLeave = mutation({
  args: { apiKey: v.string(), ...scopeArgs, channelId: v.string(), huddleId: v.string() },
  handler: async (ctx, args): Promise<LeaveResult> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { pubkey } = await requireHuddleAgent(
      ctx,
      args.apiKey,
      scope,
      args.channelId,
      "presence",
    );
    const snapshot = huddleById(
      await readHuddles(ctx, scope, args.channelId, pubkey),
      args.huddleId,
    );
    return await leaveHuddleCore(ctx, scope, {
      channelId: args.channelId,
      pubkey,
      isAgent: true,
      snapshot,
    });
  },
});

/**
 * An agent, its community fence, its room, and its key — in one place.
 *
 * The community check is the same comparison `presence.agentHeartbeat` and
 * `agents.ts` make, and it is the tenancy fence for a principal that cannot go
 * through `requireScopeAccess` because it authenticates by API key rather than
 * by session (D4: the same boundary, reached through the other door).
 * `resolveChannelForActor` then answers the room half — imported rather than
 * re-rolled, so a private room answers "not found" here exactly as it does
 * everywhere else.
 */
async function requireHuddleAgent(
  ctx: MutationCtx,
  apiKey: string,
  scope: Scope,
  channelId: string,
  mode: "write" | "presence",
): Promise<{ agent: Doc<"agents">; pubkey: string }> {
  const { agent } = await requireAgentByKey(ctx, apiKey, mode);
  if (agent.parentType !== scope.scopeType || agent.parentId !== scope.scopeId) {
    throw new ConvexError("This agent does not belong to that community");
  }
  const { membership } = await resolveChannelForActor(ctx, scope, channelId, agent._id);
  if (!membership) throw new ConvexError("Channel not found");
  const pubkey = await requirePubkey(ctx, "agent", agent._id, agent.name);
  return { agent, pubkey };
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/**
 * Burst an emoji into the call.
 *
 * 24810 is in the ephemeral band, so `publishCore` signs it and hands it back
 * **without writing a row** (§16.22) — which is exactly right for a reaction in
 * a live call: it is a gesture, not a record, and a permanent log of every
 * thumbs-up in every call is a table that grows at the rate of a gesture.
 *
 * Signed in the mutation and fanned out by the scheduler, rather than published
 * straight to Ably from an action. The signature is what makes a reaction
 * attributable at all — an action cannot sign, because signing needs the write
 * transaction — and the scheduler hop is what keeps the mutation off the
 * network. Ably being unconfigured is a supported state: `publishFromClient`
 * returns without doing anything and the call is unaffected.
 */
export const react = mutation({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    huddleId: v.string(),
    emoji: v.string(),
  },
  handler: async (ctx, args): Promise<{ delivered: boolean }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel } = await requireRoomMembership(ctx, scope, args.channelId);
    const actor = await userActor(ctx, subject);
    const pubkey = await requirePubkey(ctx, "user", subject, actor.name);

    const emoji = normalizeReaction(args.emoji);
    if (!emoji) throw new ConvexError("A reaction needs an emoji");

    const snapshot = huddleById(
      await readHuddles(ctx, scope, channel.channelId, pubkey),
      args.huddleId,
    );
    if (!snapshot?.live) throw new ConvexError("That huddle has ended");
    if (!isInHuddle(snapshot, pubkey)) throw new ConvexError("You are not in this huddle");

    const senderName = normalizeSenderName(actor.name);
    await publishOrThrow(
      ctx,
      {
        actor,
        scope,
        kind: KIND_HUDDLE_REACTION,
        tags: [
          ["h", channel.channelId],
          ["e", snapshot.huddleId],
          ["reaction", emoji],
          ["sender_name", senderName],
        ],
        content: emoji,
      },
      { allowEphemeral: true },
    );

    await ctx.scheduler.runAfter(0, api.realtime.publishFromClient, {
      channel: buzzRoomChannel(channel.channelId),
      name: "huddle.reaction",
      data: { huddleId: snapshot.huddleId, emoji, pubkey, senderName, at: Date.now() },
    });
    return { delivered: true };
  },
});

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

/**
 * `api.buzz.channels.get`, named by hand — same reason as `channelsApi` above.
 */
const channelGet = anyApi.buzz.channels as unknown as {
  get: FunctionReference<
    "query",
    "public",
    { scopeType: "user" | "workspace"; scopeId: string; channelId: string },
    { channelId: string } | null
  >;
};

/**
 * A caption line, for the transcript pane.
 *
 * An action, and **never a write** — the rule `presence.signal` already
 * established for typing, and it applies harder here. A caption is speech, and
 * a durable record of everything said in every call is a governance decision
 * nobody made; Buzz's own list of what a huddle deliberately lacks ends with
 * "no recording". So a caption rides the room's realtime channel, lives in the
 * pane for the length of the call, and is gone with it.
 *
 * There is no caption *kind* for the same reason — adding one would make the
 * absence of recording a policy that a future caller could quietly reverse,
 * rather than a fact about the vocabulary.
 *
 * Both a speech-to-text tap (when a provider is wired) and an agent describing
 * what it just said reach the pane through this one function.
 */
export const caption = action({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    huddleId: v.string(),
    pubkey: v.string(),
    name: v.string(),
    text: v.string(),
    isAgent: v.optional(v.boolean()),
  },
  handler: async (ctx: ActionCtx, args): Promise<null> => {
    const room = await ctx.runQuery(channelGet.get, {
      scopeType: args.scopeType,
      scopeId: args.scopeId,
      channelId: args.channelId,
    });
    if (!room) throw new ConvexError("Channel not found");
    const text = args.text.trim();
    if (!text) return null;

    await ctx.runAction(api.realtime.publishFromClient, {
      channel: buzzRoomChannel(args.channelId),
      name: "huddle.caption",
      data: {
        huddleId: args.huddleId,
        pubkey: args.pubkey,
        name: normalizeSenderName(args.name),
        isAgent: args.isAgent ?? false,
        text,
        at: Date.now(),
      },
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type HuddleRosterName = { name: string; isAgent: boolean };

export type HuddleView = {
  huddles: HuddleSnapshot[];
  /** pubkey → who that is. Everything the roster needs to draw a name. */
  names: Record<string, HuddleRosterName>;
  /** The caller's own key, so the bar knows whether it is in the call. */
  viewerPubkey: string | null;
};

/**
 * Every huddle this room has a record of, folded, with names.
 *
 * Through `readEventsCore` rather than `ctx.db`, so the per-event read gates
 * run — "get the rows and return them" is the read-leak shape. Huddle kinds are
 * open-gated today, so nothing is withheld; routing through the core is what
 * keeps that true if the registry ever narrows one.
 *
 * The names map is resolved server-side because a pubkey is not a name and a
 * client cannot turn one into a name without a second round trip per
 * participant. `describePubkey` reads retired keys too, so somebody who rotated
 * their identity after a call still has a name on that call's record.
 */
export const forChannel = query({
  args: { ...scopeArgs, channelId: v.string() },
  handler: async (ctx, args): Promise<HuddleView> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireChannelAccess(ctx, scope, args.channelId);
    const viewerPubkey = await pubkeyFor(ctx, "user", subject);
    const huddles = await readHuddles(ctx, scope, args.channelId, viewerPubkey ?? "");

    const wanted = new Set<string>();
    for (const huddle of huddles) {
      if (huddle.startedByPubkey) wanted.add(huddle.startedByPubkey);
      for (const participant of huddle.participants) wanted.add(participant.pubkey);
    }
    const names: Record<string, HuddleRosterName> = {};
    for (const pubkey of wanted) {
      const described = await describePubkey(ctx, pubkey);
      // A pubkey with no key row is somebody whose identity this deployment has
      // never seen — impossible today, and drawn as an unknown participant
      // rather than dropped, because a roster that silently omits somebody who
      // is audibly in the call is worse than one that says "Someone".
      names[pubkey] = described
        ? { name: described.name, isAgent: described.isAgent }
        : { name: "Someone", isAgent: false };
    }

    return { huddles, names, viewerPubkey };
  },
});
