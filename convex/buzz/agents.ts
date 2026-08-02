// An agent in a room, and what it is doing there.
//
// Two halves, and they are two halves of one idea (02-agents.md §0: "an agent
// is a member of the workspace, not a bot attached to it").
//
//   **Membership.** An agent joins a room through the same machinery a person
//   joins with — `channels.addMembers`, called here rather than reimplemented,
//   so the 9000 event, the "Scout joined" system row, the member notification,
//   the member count and the re-join-reverses-removal rule all behave
//   identically for both kinds of principal. There is no agent branch inside
//   that mutation and there is no second membership table. Once it is in, the
//   mention fan-out in ./notifications.ts already pings its `notifyUrl` through
//   `enqueueAgentPingDelivery` — HMAC-signed, SSRF-guarded, the same path a
//   task mention takes. Nothing in this file re-parses a mention or re-invents
//   a pinger.
//
//   **The turn.** Per D9 nothing runs server-side: the ping reaches the agent's
//   own runtime and it answers over MCP. So what lives here is the *record* of
//   a turn and its lifecycle, which exists for one reason — a room has to be
//   able to say "Scout is working on this" and, more importantly, to stop
//   saying it when Scout's laptop closed. The rules for that are pure and live
//   in `src/lib/buzz/turn.ts`; this file is the transactions around them.
//
// The thing that makes both halves one idea: **an agent is scoped by identity,
// not by permission flags** (§10.3). Its events are signed by its own key, so
// "who did this" is answered by cryptography rather than by a boolean column
// somebody could set. Every governance check below narrows *what that identity
// may do*; none of them changes whose signature ends up on the log.
//
// Governance is not re-rolled here either. `requireAgentByKey` is the one gate
// — role, the daily budget, the burst cap and x402 metering all come from it,
// counted in the same `agentUsage` row the Work side uses. This file adds
// exactly two fences of its own, and both are about rooms rather than about
// budgets: the community fence (an agent may only act in its own scope) and the
// list-fence refusal (below).

import { ConvexError, v } from "convex/values";
import { anyApi } from "convex/server";
import type { FunctionReference } from "convex/server";
import { mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireAgentByKey } from "../_agentAuth";
import type { Actor } from "../_agentAuth";
import { requireChannelAccess } from "./channels";
import { publishCore, type Scope } from "./log";
import { pubkeyFor } from "./identity";
import {
  MAX_TURN_DURATION_MS,
  TURN_ABANDON_AFTER_MS,
  nextTurnState,
  turnLiveness,
  workingAgents,
  type ChatTurn,
  type TurnEvent,
  type TurnLiveness,
} from "../../src/lib/buzz/turn";

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/**
 * The working signal on the wire (02-agents.md §5.5, fallback pipe).
 *
 * Ephemeral by kind number, which is the whole reason Buzz picked it: a beat
 * every ten seconds for the length of a turn would otherwise be thousands of
 * rows in an append-only log saying nothing except "still here". `publishCore`
 * signs it and hands it back without writing it, so the fan-out happens and the
 * log stays a log.
 */
const KIND_TYPING_INDICATOR = 20002;

/**
 * The owner control frame (§2.4). Ephemeral, p-gated, owner → agent.
 *
 * This is the *message to the process*, and it is best-effort by design: a
 * harness that is not listening never gets it, which is exactly why cancelling
 * also writes the record below rather than waiting for an acknowledgement.
 */
const KIND_AGENT_OBSERVER_FRAME = 24200;

/**
 * The durable per-turn record (NIP-AM, §1.1). Stored, p-gated, result-gated.
 *
 * Published once, at the end, by the agent — so a completed turn is answerable
 * from the log alone rather than from a projection somebody has to trust. It
 * carries no `h` tag: 44200 is a global-scope kind, so the log would refuse to
 * bind it to a room anyway, and the channel travels in the content where it
 * cannot be mistaken for a room membership.
 *
 * Not encrypted, unlike Buzz's NIP-44 envelope. The gate is the relay filter
 * (`eventVisibleToReader` checks `#p` per event, even on an id lookup), which
 * is the same posture every other private kind in this log takes — we sign
 * server-side and gate on read (D2), and adding one encrypted kind would mean
 * one kind nobody else in the product can read.
 */
const KIND_AGENT_TURN_METRIC = 44200;

/**
 * A person intervened. Stored, open, in the room it happened in.
 *
 * The control frame above is ephemeral, and a cancellation that leaves no trace
 * is a governance act with no record — the one class of act that most needs
 * one. So a cancel publishes both: the frame the harness listens for, and this,
 * the sentence the room can still read tomorrow.
 */
const KIND_AUDIT_ENTRY = 48001;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const scopeArgs = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

/**
 * `channels.addMembers` / `channels.removeMember`, as callables.
 *
 * Through `anyApi` for the reason ./keys.ts states: the checked-in
 * `convex/_generated/api.d.ts` is a hand-rolled stub that predates
 * `convex/buzz/`, and only `npx convex dev` may rewrite it. The cast keeps real
 * argument and return types at the two call sites, which is the part that would
 * actually cost something. **Replace with `api.buzz.channels.*` the first time
 * the CLI regenerates the stub.**
 *
 * Calling them at all — rather than writing a membership row here — is the
 * Actor-pattern rule applied to rooms: one write path per fact, and "who is in
 * this room" is one fact. A second inserter would be a second place for the
 * system message, the member notification and the soft-delete reversal to be
 * got subtly differently, and the difference would only ever show up for
 * agents, which is to say in the case nobody is looking at.
 */
type MemberInput = { actorId: string; actorType: "user" | "agent" };
const channelsApi = anyApi.buzz.channels as unknown as {
  addMembers: FunctionReference<
    "mutation",
    "public",
    {
      scopeType: "user" | "workspace";
      scopeId: string;
      channelId: string;
      members: MemberInput[];
      role?: "admin" | "member" | "guest" | "bot";
    },
    { added: string[]; errors: { actorId: string; error: string }[] }
  >;
  removeMember: FunctionReference<
    "mutation",
    "public",
    { scopeType: "user" | "workspace"; scopeId: string; channelId: string; actorId: string },
    { removed: boolean }
  >;
};

// ---------------------------------------------------------------------------
// Fences
// ---------------------------------------------------------------------------

type AgentRow = Doc<"agents">;

/**
 * An agent acts only inside its own community.
 *
 * The same sentence `presence.agentHeartbeat` enforces, and the reason it is
 * repeated rather than centralised is that it is one comparison against two
 * fields the caller already holds — a helper would be indirection over a `===`.
 * What matters is that it is checked on *every* entry point, which is why it is
 * the first line of each of them.
 */
function assertCommunity(agent: AgentRow, scope: Scope): void {
  if (agent.parentType !== scope.scopeType || agent.parentId !== scope.scopeId) {
    throw new ConvexError("This agent does not belong to that community");
  }
}

/**
 * A fence written in lists cannot describe a room.
 *
 * `allowedListIds` narrows an agent to specific lists on the Work side, and
 * `requireUnrestricted` refuses it every structure-level operation for the same
 * reason: the fence has nothing to say about objects that are not lists, so
 * letting the agent through would silently mean "unfenced here". A room is
 * exactly such an object — worse than a sprint, because a room is a stream of
 * everything its members say, including about lists this agent was deliberately
 * kept away from.
 *
 * So the refusal is total, and it names the fix rather than the rule: clear the
 * restriction, or give the agent a room of its own. Fail-closed, because the
 * alternative reads as a working feature right up until somebody notices the
 * restricted agent has been reading #leadership for a month.
 *
 * Deliberately not `requireUnrestricted` itself: that helper's message ("This
 * agent is restricted to specific lists") answers a question about lists, and
 * a person who just tried to add a bot to a channel would have no idea what it
 * meant.
 */
function assertMayJoinRooms(agent: AgentRow): void {
  if (agent.allowedListIds !== undefined) {
    throw new ConvexError(
      `${agent.name} is restricted to specific lists, and a list allow-list cannot describe a room — a room carries everything its members say. Clear the restriction, or give this agent its own room.`,
    );
  }
}

/** A paused agent is not a participant. Pausing has to mean something. */
function assertActive(agent: AgentRow): void {
  if (agent.status !== "active") {
    throw new ConvexError(`${agent.name} is paused`);
  }
}

/**
 * The current membership row for an actor in a room, active or soft-removed.
 *
 * A direct index read rather than a borrowed helper: `channels.ts` keeps its
 * equivalent private, and copying an index range is not the same kind of
 * duplication as copying an authorization *rule* — the rule here is
 * `requireChannelAccess`, which is imported.
 */
async function membershipRow(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  channelId: string,
  actorId: string,
): Promise<Doc<"buzzMemberships"> | null> {
  return await ctx.db
    .query("buzzMemberships")
    .withIndex("by_channel_actor", (q) =>
      q
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("channelId", channelId)
        .eq("actorId", actorId),
    )
    .unique();
}

function isActiveMember(row: Doc<"buzzMemberships"> | null): boolean {
  return row !== null && row.removedAt === undefined;
}

/**
 * The signing identity an agent must already have to be in a room.
 *
 * Not minted here, and that is a rule rather than a limitation (see
 * ./identity.ts): a mutation has no CSPRNG, and more importantly minting is
 * governed — `keys.mint` goes through `agents._assertManageAccess`, so only
 * somebody who can manage the agent can give it an identity. Attaching is a
 * lesser act than that (any member of a room may add a bot to it, exactly as
 * they may add a person), so folding a mint into it would quietly raise the bar
 * for attaching or lower the bar for minting. Neither is right, so the two stay
 * separate and this refusal names the call that fixes it.
 */
async function requireAgentPubkey(
  ctx: QueryCtx | MutationCtx,
  agent: AgentRow,
): Promise<string> {
  const pubkey = await pubkeyFor(ctx, "agent", agent._id);
  if (!pubkey) {
    throw new ConvexError(
      `${agent.name} has no Chat signing key yet. Mint one with buzz.keys.mint({ principal: { type: "agent", agentId } }) — a Node action, because a mutation has no CSPRNG — then attach it.`,
    );
  }
  return pubkey;
}

// ---------------------------------------------------------------------------
// Reads: which agents belong in this room
// ---------------------------------------------------------------------------

export type AttachableAgent = {
  agentId: Id<"agents">;
  name: string;
  /** Already an active member of this room. */
  attached: boolean;
  /** Has a Chat identity; `false` means mint before attaching. */
  hasKey: boolean;
  pubkey: string | null;
  /** Why this agent cannot be attached, or null if it can. */
  blockedReason: string | null;
  lastSeenAt?: number;
};

/**
 * Every agent in this community, and whether it can be in this room.
 *
 * Returns the blocked ones too, with the reason, rather than filtering them
 * out. An agent that is missing from a picker is indistinguishable from an
 * agent that does not exist, and the two most common blocks — "no Chat identity
 * yet" and "restricted to lists" — are both things a person can fix in about
 * ten seconds if anybody tells them.
 *
 * Ordered so the picker's default is the right one: attachable before blocked,
 * then most recently seen, then by name. This is Buzz's reuse rule
 * (§3.2 `pickPreferredManagedAgent`: running-or-deployed first, then most
 * recent) reduced to what our model actually has — we have no process to start,
 * so "running" is "has been heard from", and the preference exists for the same
 * purpose: **offer the agent that already exists instead of encouraging a
 * second one.**
 */
export const attachable = query({
  args: { ...scopeArgs, channelId: v.string() },
  handler: async (ctx, args): Promise<AttachableAgent[]> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { channel } = await requireChannelAccess(ctx, scope, args.channelId);

    const agents = await ctx.db
      .query("agents")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", scope.scopeType).eq("parentId", scope.scopeId),
      )
      .collect();

    const rows: AttachableAgent[] = [];
    for (const agent of agents) {
      const pubkey = await pubkeyFor(ctx, "agent", agent._id);
      const member = await membershipRow(ctx, scope, channel.channelId, agent._id);
      const attached = isActiveMember(member);
      rows.push({
        agentId: agent._id,
        name: agent.name,
        attached,
        hasKey: pubkey !== null,
        pubkey,
        blockedReason: attachBlockReason(agent, pubkey, attached),
        ...(agent.lastSeenAt !== undefined ? { lastSeenAt: agent.lastSeenAt } : {}),
      });
    }

    return rows.sort((left, right) => {
      const leftOk = left.blockedReason === null && !left.attached;
      const rightOk = right.blockedReason === null && !right.attached;
      if (leftOk !== rightOk) return leftOk ? -1 : 1;
      const seen = (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0);
      if (seen !== 0) return seen;
      return left.name.localeCompare(right.name);
    });
  },
});

function attachBlockReason(
  agent: AgentRow,
  pubkey: string | null,
  attached: boolean,
): string | null {
  if (attached) return "Already in this room";
  if (agent.status !== "active") return "Paused";
  if (agent.allowedListIds !== undefined) return "Restricted to specific lists";
  if (pubkey === null) return "No Chat identity yet";
  return null;
}

export type MentionableAgent = {
  agentId: Id<"agents">;
  name: string;
  pubkey: string;
};

/**
 * The agents a composer in this room may name.
 *
 * Membership **is** the rule. Buzz reaches the same answer through
 * `respondTo` + "shares at least one channel with us" (§3.5); our agents carry
 * no `respondTo` mode, so what is left of that rule is the half that was doing
 * the work — an agent is mentionable where it is present, and nowhere else.
 *
 * A paused agent is a member and is deliberately **not** offered: a mention
 * pings a runtime, and pausing has to mean the runtime stops being asked. It
 * stays in the member list, because it is still in the room.
 *
 * A member with no key cannot appear at all: `messages.resolveMentions` turns a
 * token into a `p` tag by looking the pubkey up, and a token naming a keyless
 * principal silently produces no tag — which reads to the author as a mention
 * that was ignored.
 */
export const mentionable = query({
  args: { ...scopeArgs, channelId: v.string() },
  handler: async (ctx, args): Promise<MentionableAgent[]> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { channel } = await requireChannelAccess(ctx, scope, args.channelId);

    const members = await ctx.db
      .query("buzzMemberships")
      .withIndex("by_channel", (q) =>
        q
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId)
          .eq("channelId", channel.channelId)
          .eq("removedAt", undefined),
      )
      .collect();

    const out: MentionableAgent[] = [];
    for (const member of members) {
      if (member.actorType !== "agent") continue;
      const agentId = ctx.db.normalizeId("agents", member.actorId);
      const agent = agentId ? await ctx.db.get(agentId) : null;
      if (!agent || agent.status !== "active") continue;
      const pubkey = await pubkeyFor(ctx, "agent", agent._id);
      if (!pubkey) continue;
      out.push({ agentId: agent._id, name: agent.name, pubkey });
    }
    return out.sort((left, right) => left.name.localeCompare(right.name));
  },
});

// ---------------------------------------------------------------------------
// Attach / detach
// ---------------------------------------------------------------------------

/**
 * Put an agent in a room.
 *
 * A **human** act, always: there is no key-authenticated way into this file's
 * membership half, which is the mechanical form of "an agent must not be able
 * to summon its own access". The same rule ./identity.ts states about minting,
 * for the same reason — governance that an agent can grant itself is not
 * governance, it is a default.
 *
 * The checks, in the order they fail:
 *   1. the caller can see the room, and is in it (`requireChannelAccess`, then
 *      membership) — you cannot add somebody to a conversation you are not in;
 *   2. the agent is this community's (`assertCommunity`) — the identity fence,
 *      and the reason an agent cannot be attached to a room it cannot see: a
 *      room lives in a community and an agent belongs to exactly one;
 *   3. the agent is active and not list-fenced;
 *   4. the agent already has a Chat identity.
 *
 * Then `channels.addMembers` does the rest, with `role: "bot"` — Buzz's default
 * (§3.1) and a *role*, not a synonym for being an agent: an agent can be made
 * an admin afterwards through `channels.setRole`, and a human can hold `bot`.
 *
 * **Idempotent.** Attaching an agent that is already in the room is a no-op
 * that says so, rather than an error. Re-attaching one that was removed
 * reverses the removal (that is `addMembers`' behaviour, not a second rule
 * here) — Buzz's §3.1 reuse rule, whose point is that adding an agent that
 * already exists must never produce a second one.
 */
export const attach = mutation({
  args: { ...scopeArgs, channelId: v.string(), agentId: v.id("agents") },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { channel, membership } = await requireChannelAccess(ctx, scope, args.channelId);
    if (!membership) {
      throw new ConvexError("Join this channel before adding an agent to it");
    }

    const agent = await ctx.db.get(args.agentId);
    if (!agent) throw new ConvexError("Agent not found");
    assertCommunity(agent, scope);
    assertActive(agent);
    assertMayJoinRooms(agent);
    const pubkey = await requireAgentPubkey(ctx, agent);

    const existing = await membershipRow(ctx, scope, channel.channelId, agent._id);
    if (existing !== null && existing.removedAt === undefined) {
      return { attached: false, alreadyAttached: true, pubkey, role: existing.role };
    }

    const result = await ctx.runMutation(channelsApi.addMembers, {
      ...scope,
      channelId: channel.channelId,
      members: [{ actorId: agent._id, actorType: "agent" }],
      role: "bot",
    });
    if (!result.added.includes(agent._id)) {
      // `addMembers` collects per-member refusals rather than throwing, because
      // its caller is adding a list of people and one bad row must not lose the
      // rest. This caller is adding exactly one, so a collected refusal *is*
      // the outcome and swallowing it would report success for nothing.
      throw new ConvexError(result.errors[0]?.error ?? "The agent could not be added");
    }
    return { attached: true, alreadyAttached: false, pubkey, role: "bot" as const };
  },
});

/**
 * Take an agent out of a room.
 *
 * Routed through `channels.removeMember`, so the 9001, the "Scout was removed"
 * row, the notification and the soft delete are the ones every removal uses.
 * Soft, therefore reversible, and "Scout was in this room until March" stays
 * answerable — which is the whole reason removal is soft over there.
 *
 * A live turn is **not** cancelled by detaching. It is tempting, and it is
 * wrong twice: a turn already running on somebody else's machine does not stop
 * because a row changed, so cancelling here would be a claim the server cannot
 * back; and the turn record is the honest account of what happened, which
 * includes an agent that was removed mid-sentence. The record decays on its own
 * (`turnLiveness`), which is the only mechanism here that is always true.
 */
export const detach = mutation({
  args: { ...scopeArgs, channelId: v.string(), agentId: v.id("agents") },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { channel } = await requireChannelAccess(ctx, scope, args.channelId);

    const agent = await ctx.db.get(args.agentId);
    if (!agent) throw new ConvexError("Agent not found");
    assertCommunity(agent, scope);

    const existing = await membershipRow(ctx, scope, channel.channelId, agent._id);
    if (!isActiveMember(existing)) {
      return { detached: false, alreadyDetached: true };
    }
    await ctx.runMutation(channelsApi.removeMember, {
      ...scope,
      channelId: channel.channelId,
      actorId: agent._id,
    });
    return { detached: true, alreadyDetached: false };
  },
});

// ---------------------------------------------------------------------------
// The turn: the agent's side
// ---------------------------------------------------------------------------

type TurnRow = Doc<"buzzTurns">;

/** The stored row, as the pure state machine sees it. */
function toChatTurn(row: TurnRow, agentName?: string): ChatTurn {
  return {
    turnId: row.turnId,
    channelId: row.channelId,
    agentId: row.agentId,
    agentPubkey: row.agentPubkey,
    ...(agentName !== undefined ? { agentName } : {}),
    state: row.state,
    startedAt: row.startedAt,
    lastActivityAt: row.lastActivityAt,
    ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
    ...(row.narration !== undefined ? { narration: row.narration } : {}),
    ...(row.error !== undefined ? { error: row.error } : {}),
    ...(row.cancelledByActorId !== undefined
      ? { cancelledByActorId: row.cancelledByActorId }
      : {}),
    ...(row.triggerEventId !== undefined ? { triggerEventId: row.triggerEventId } : {}),
  };
}

async function turnRow(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  agentId: string,
  turnId: string,
): Promise<TurnRow | null> {
  return await ctx.db
    .query("buzzTurns")
    .withIndex("by_agent_turn", (q) =>
      q
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("agentId", agentId)
        .eq("turnId", turnId),
    )
    .unique();
}

/**
 * The room an agent may report a turn in.
 *
 * The agent-side mirror of `requireChannelAccess`, and it has to exist
 * separately for one structural reason: that function starts at
 * `requireScopeAccess`, which reads a Clerk identity, and an agent has none —
 * it authenticated with a key. What it must NOT be is a weaker check, so the
 * three questions it asks are the same three: is this scope yours, does the
 * room exist, are you in it.
 *
 * "Not in it" and "does not exist" answer identically, exactly as they do on
 * the human side: whether a private room called `#acquisition` exists is itself
 * the information being protected, and an agent is a principal somebody else
 * may be steering.
 */
async function requireAgentRoom(
  ctx: QueryCtx | MutationCtx,
  agent: AgentRow,
  scope: Scope,
  channelId: string,
): Promise<Doc<"buzzChannels">> {
  assertCommunity(agent, scope);
  const channel = await ctx.db
    .query("buzzChannels")
    .withIndex("by_scope_channel", (q) =>
      q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("channelId", channelId),
    )
    .unique();
  if (!channel) throw new ConvexError("Channel not found");
  const membership = await membershipRow(ctx, scope, channelId, agent._id);
  if (!isActiveMember(membership)) throw new ConvexError("Channel not found");
  return channel;
}

/** The agent, as the log's author. */
function agentActorOf(agent: AgentRow): Actor {
  return { type: "agent", id: agent._id, name: agent.name };
}

/**
 * Publish, and refuse to write a row the log does not explain.
 *
 * Same contract as `channels.publishOrThrow` and for the same reason, with one
 * difference that matters here: `ephemeral` is an **accepted** outcome, not a
 * refusal. A typing indicator and a control frame are signed and fanned out and
 * deliberately never stored (§16.22) — treating that as failure would make the
 * working signal impossible to send.
 */
async function publishSigned(
  ctx: MutationCtx,
  args: Parameters<typeof publishCore>[1],
): Promise<string> {
  const outcome = await publishCore(ctx, args);
  if (outcome.status === "dominated") {
    throw new ConvexError("The channel log refused this event; nothing was written.");
  }
  return outcome.event.id;
}

/**
 * Start a turn.
 *
 * The **only** turn call authenticated in `"write"` mode, and the asymmetry is
 * the point. Starting a turn is the governed act: it is where a read-only agent
 * is refused, where the daily budget and the 60/minute burst cap bite, and
 * where a runaway harness is stopped after a minute rather than after a day.
 * Everything after it — streaming, finishing — is `"presence"`, because once a
 * turn is under way, *reporting on it must never be able to fail for budget
 * reasons*: a refusal there would leave a spinner running forever, caused by
 * the very governance that was supposed to contain the agent. That is the same
 * rule the live-runs work states as "telling people what you're doing never
 * consumes the budget for doing it".
 *
 * `turnId` is optional. When the harness has one (Buzz's is process-local and
 * resets on restart, §"Non-obvious rules" 1), it passes it and restarting is
 * idempotent. When it has none, the id of the event that announced the turn is
 * used — a hash, so it is unique and unforgeable, the same trick
 * `channels.create` uses for a room id and for the same reason: a mutation has
 * no CSPRNG and a client-chosen id is one a client can collide on purpose.
 *
 * Restarting a live turn returns it unchanged apart from its clock. Restarting
 * a finished one is refused — a completion is authoritative and outlives
 * everything that arrives after it (§5.4).
 */
export const startTurn = mutation({
  args: {
    apiKey: v.string(),
    ...scopeArgs,
    channelId: v.string(),
    turnId: v.optional(v.string()),
    triggerEventId: v.optional(v.string()),
    narration: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const channel = await requireAgentRoom(ctx, agent, scope, args.channelId);
    // Checked again here and not only at attach: a fence added *after* an agent
    // joined must take effect without anybody remembering to detach it.
    assertMayJoinRooms(agent);
    const pubkey = await requireAgentPubkey(ctx, agent);
    const now = Date.now();

    const eventId = await publishSigned(ctx, {
      actor: agentActorOf(agent),
      scope,
      kind: KIND_TYPING_INDICATOR,
      tags: [["h", channel.channelId]],
      content: "",
    });

    const turnId = normalizeTurnId(args.turnId) ?? eventId;
    const existing = await turnRow(ctx, scope, agent._id, turnId);
    if (existing) {
      const step = nextTurnState(toChatTurn(existing), { type: "start", at: now });
      if (!step.ok) throw new ConvexError(step.reason);
      await ctx.db.patch(existing._id, {
        lastActivityAt: step.turn.lastActivityAt,
        lastEventId: eventId,
      });
      return { turnId, started: false, resumed: true, state: existing.state };
    }

    await ctx.db.insert("buzzTurns", {
      ...scope,
      channelId: channel.channelId,
      turnId,
      agentId: agent._id,
      agentPubkey: pubkey,
      state: "started",
      startedAt: now,
      lastActivityAt: now,
      ...(args.narration ? { narration: clampNarration(args.narration) } : {}),
      ...(args.triggerEventId ? { triggerEventId: args.triggerEventId } : {}),
      lastEventId: eventId,
    });
    return { turnId, started: true, resumed: false, state: "started" as const };
  },
});

/**
 * Still working — and here is the current sentence.
 *
 * One call for both jobs (Buzz's `turn_liveness` and its `agent_message_chunk`
 * frames) because on this substrate they are the same write: the projection row
 * is the stream, so patching `lastActivityAt` *is* publishing the beat, and
 * patching `narration` beside it costs nothing extra. A separate heartbeat
 * endpoint would be a second call a harness could forget to make.
 *
 * The narration is replaced, never appended. A turn record is not a transcript
 * — the transcript is the room, where the agent's actual messages are.
 */
export const streamTurn = mutation({
  args: {
    apiKey: v.string(),
    ...scopeArgs,
    channelId: v.string(),
    turnId: v.string(),
    narration: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "presence");
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const channel = await requireAgentRoom(ctx, agent, scope, args.channelId);
    const now = Date.now();

    const row = await requireOwnTurn(ctx, scope, agent, channel.channelId, args.turnId);
    const event: TurnEvent = {
      type: "partial",
      at: now,
      ...(args.narration !== undefined ? { narration: clampNarration(args.narration) } : {}),
    };
    const step = nextTurnState(toChatTurn(row), event);
    if (!step.ok) throw new ConvexError(step.reason);

    const eventId = await publishSigned(ctx, {
      actor: agentActorOf(agent),
      scope,
      kind: KIND_TYPING_INDICATOR,
      tags: [["h", channel.channelId]],
      content: "",
    });

    await ctx.db.patch(row._id, {
      state: step.turn.state,
      lastActivityAt: step.turn.lastActivityAt,
      ...(step.turn.narration !== undefined ? { narration: step.turn.narration } : {}),
      lastEventId: eventId,
    });
    return { turnId: row.turnId, state: step.turn.state };
  },
});

/**
 * The turn is over, one way or another.
 *
 * One terminal entry point rather than three, because the three outcomes differ
 * only in what they carry: an error, a summary, nothing. Three mutations would
 * be three places to publish the record and three chances for one of them to
 * forget.
 *
 * `cancelled` is accepted from the agent because a harness that received the
 * control frame and stopped should be able to say so — but it is not the only
 * way a turn gets cancelled (see `cancelTurn`), and reporting it for a turn a
 * person already cancelled is a no-op rather than an error.
 *
 * **A late completion is not an error.** A harness finishing a turn a human
 * cancelled, or finishing twice after a retry, gets `applied: false` and the
 * state that actually holds. Throwing would make every harness special-case a
 * race it cannot avoid, and the usual way that is special-cased is by retrying
 * — which is how a benign race becomes a retry loop.
 */
export const finishTurn = mutation({
  args: {
    apiKey: v.string(),
    ...scopeArgs,
    channelId: v.string(),
    turnId: v.string(),
    outcome: v.union(v.literal("finished"), v.literal("failed"), v.literal("cancelled")),
    narration: v.optional(v.string()),
    error: v.optional(v.string()),
    tokensUsed: v.optional(v.number()),
    costUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "presence");
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const channel = await requireAgentRoom(ctx, agent, scope, args.channelId);
    const now = Date.now();

    const row = await requireOwnTurn(ctx, scope, agent, channel.channelId, args.turnId);
    const event: TurnEvent =
      args.outcome === "failed"
        ? { type: "fail", at: now, error: clampNarration(args.error ?? "The turn failed") }
        : args.outcome === "cancelled"
          ? { type: "cancel", at: now }
          : {
              type: "finish",
              at: now,
              ...(args.narration !== undefined
                ? { narration: clampNarration(args.narration) }
                : {}),
            };

    const step = nextTurnState(toChatTurn(row), event);
    if (!step.ok) {
      return { turnId: row.turnId, applied: false, state: row.state, reason: step.reason };
    }

    // The durable record, signed by the agent's own key. Published before the
    // patch so a row can never claim a turn ended without the log saying so.
    const eventId = await publishSigned(ctx, {
      actor: agentActorOf(agent),
      scope,
      kind: KIND_AGENT_TURN_METRIC,
      tags: turnMetricTags(row.agentPubkey, await triggerAuthor(ctx, scope, row)),
      content: JSON.stringify({
        turn_id: row.turnId,
        channel_id: row.channelId,
        state: step.turn.state,
        started_at: row.startedAt,
        ended_at: step.turn.endedAt,
        ...(step.turn.error !== undefined ? { error: step.turn.error } : {}),
        ...(args.tokensUsed !== undefined ? { tokens_used: args.tokensUsed } : {}),
        ...(args.costUsd !== undefined ? { cost_usd: args.costUsd } : {}),
      }),
    });

    await ctx.db.patch(row._id, {
      state: step.turn.state,
      lastActivityAt: step.turn.lastActivityAt,
      endedAt: step.turn.endedAt,
      ...(step.turn.narration !== undefined ? { narration: step.turn.narration } : {}),
      ...(step.turn.error !== undefined ? { error: step.turn.error } : {}),
      ...(args.tokensUsed !== undefined ? { tokensUsed: args.tokensUsed } : {}),
      ...(args.costUsd !== undefined ? { costUsd: args.costUsd } : {}),
      lastEventId: eventId,
    });
    return { turnId: row.turnId, applied: true, state: step.turn.state, reason: null };
  },
});

/**
 * The `#p` tags on a turn metric — who may read it at all.
 *
 * 44200 is p-gated *and* result-gated, so knowing the event id is not
 * authorization (§16.14): the reader must be named. Two names, and no more.
 * The agent, because an agent reviewing its own history is the first consumer.
 * Whoever triggered the turn, because they asked for the work and the receipt
 * for it is theirs. A turn record carries how long an agent worked and what it
 * cost, which is exactly the metadata a wider `#p` list would hand to a room.
 */
function turnMetricTags(agentPubkey: string, triggeredBy: string | null): string[][] {
  const tags: string[][] = [
    ["p", agentPubkey],
    ["agent", agentPubkey],
  ];
  if (triggeredBy !== null && triggeredBy !== agentPubkey) tags.push(["p", triggeredBy]);
  return tags;
}

/**
 * Who wrote the message that set this turn going, if it recorded one.
 *
 * Best-effort by construction: `triggerEventId` is supplied by the harness and
 * may name an event that was deleted, or nothing at all. A missing trigger
 * narrows the receipt's audience rather than failing the turn's completion —
 * refusing to record that a turn ended because we could not work out who asked
 * for it would be the tail wagging the dog.
 */
async function triggerAuthor(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  row: TurnRow,
): Promise<string | null> {
  if (!row.triggerEventId) return null;
  const event = await ctx.db
    .query("buzzEvents")
    .withIndex("by_scope_event_id", (q) =>
      q
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("eventId", row.triggerEventId as string),
    )
    .first();
  return event?.pubkey ?? null;
}

/**
 * The turn must be this agent's, in this room, or it does not exist.
 *
 * Another agent's turn id answers "not found" rather than "forbidden" —
 * existence is information, and a turn id is guessable when a harness numbers
 * its turns from one. This is the same rule the live-runs work states: "another
 * agent's run id answers not found".
 */
async function requireOwnTurn(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  agent: AgentRow,
  channelId: string,
  turnId: string,
): Promise<TurnRow> {
  const row = await turnRow(ctx, scope, agent._id, turnId);
  if (!row || row.channelId !== channelId) throw new ConvexError("Turn not found");
  return row;
}

/** A turn id is a label, not a payload. */
function normalizeTurnId(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 128) throw new ConvexError("A turn id must be 128 characters or fewer");
  return trimmed;
}

/**
 * One line, and it stays one line.
 *
 * Not a validation error, because a harness that pastes a stack trace into its
 * narration has not done anything wrong — it has just made a sentence too long
 * to draw. Refusing would fail a turn over a display concern.
 */
const NARRATION_MAX = 280;
function clampNarration(raw: string): string {
  const line = raw.replace(/\s+/g, " ").trim();
  return line.length <= NARRATION_MAX ? line : `${line.slice(0, NARRATION_MAX - 1)}…`;
}

// ---------------------------------------------------------------------------
// The turn: the human's side
// ---------------------------------------------------------------------------

/**
 * Stop it.
 *
 * Two events, because a cancellation is two different things at once. The
 * **control frame** (24200, ephemeral, `#p`-addressed to the agent) is the
 * message to the process — Buzz's `{type:"cancel_turn", channelId}`, best-effort
 * by design, which a harness that is listening will act on and a harness that
 * has crashed will never see. The **audit entry** (48001, stored, in the room)
 * is the record: a person reached into an agent's work and stopped it, and that
 * has to be answerable tomorrow, from the log, not from a column.
 *
 * The row moves to `cancelled` immediately rather than waiting for the harness
 * to acknowledge. That is a deliberate difference from Buzz, and it is our
 * substrate's fault in a useful direction: their badge is a client-side
 * derivation that prunes itself, ours is a row the whole room reads, so a
 * "cancelling…" state that a dead harness never resolves would be a *second*
 * kind of stuck spinner — the exact failure this design exists to remove. The
 * agent's own later `finishTurn` is then a no-op that tells it what happened.
 *
 * Governed by room membership: anybody in the room may stop an agent working in
 * it. That is the lower bar on purpose. The higher bar (pausing the agent
 * everywhere) already exists in `agents.update` and is workspace-governed;
 * making a single stuck turn need an admin would mean the person watching the
 * spinner is rarely the person who can clear it.
 */
export const cancelTurn = mutation({
  args: { ...scopeArgs, channelId: v.string(), agentId: v.id("agents"), turnId: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel, membership } = await requireChannelAccess(
      ctx,
      scope,
      args.channelId,
    );
    if (!membership) throw new ConvexError("You are not in this channel");

    const agent = await ctx.db.get(args.agentId);
    if (!agent) throw new ConvexError("Agent not found");
    assertCommunity(agent, scope);

    const row = await turnRow(ctx, scope, agent._id, args.turnId);
    if (!row || row.channelId !== channel.channelId) throw new ConvexError("Turn not found");

    const now = Date.now();
    const step = nextTurnState(toChatTurn(row), {
      type: "cancel",
      at: now,
      byActorId: subject,
    });
    if (!step.ok) {
      return { turnId: row.turnId, applied: false, state: row.state, reason: step.reason };
    }

    const actor: Actor = { type: "user", id: subject, name: subject };
    await publishSigned(ctx, {
      actor,
      scope,
      kind: KIND_AGENT_OBSERVER_FRAME,
      // Exactly one `p`, one `agent`, one `frame` (§2.1). The shape is the
      // protocol, not a convention: a frame with two recipients is a control
      // message whose addressee is ambiguous.
      tags: [
        ["p", row.agentPubkey],
        ["agent", row.agentPubkey],
        ["frame", "control"],
      ],
      content: JSON.stringify({
        type: "cancel_turn",
        channelId: channel.channelId,
        turnId: row.turnId,
      }),
    });
    const auditId = await publishSigned(ctx, {
      actor,
      scope,
      kind: KIND_AUDIT_ENTRY,
      tags: [
        ["h", channel.channelId],
        ["p", row.agentPubkey],
      ],
      content: JSON.stringify({
        type: "turn_cancelled",
        turn_id: row.turnId,
        agent: row.agentPubkey,
      }),
    });

    await ctx.db.patch(row._id, {
      state: "cancelled",
      lastActivityAt: step.turn.lastActivityAt,
      endedAt: step.turn.endedAt,
      cancelledByActorId: subject,
      lastEventId: auditId,
    });
    return { turnId: row.turnId, applied: true, state: "cancelled" as const, reason: null };
  },
});

// ---------------------------------------------------------------------------
// Reading turns
// ---------------------------------------------------------------------------

export type RoomTurn = ChatTurn & {
  /** Server-side classification, for a reader that is not ticking a clock. */
  liveness: TurnLiveness;
};

/**
 * The turns this room currently holds.
 *
 * Two index ranges — one per non-terminal state — bounded to the recovery
 * window. That bound is the whole sweeper: a turn whose harness died is dropped
 * out of the read by the range rather than by a cron marking it, so there is no
 * scheduled job whose failure looks like an agent working very hard for three
 * days, and no write to make on the way past.
 *
 * The rows are returned raw, plus a `liveness` computed at query time. Both,
 * deliberately: the client re-runs `turnIsLive` against its own ticking clock
 * (a Convex query re-runs when data changes, not when time passes, so a
 * server-computed boolean would freeze the moment the writes stop — which is
 * exactly when it matters), while `liveness` gives a server-rendered or
 * non-ticking reader something correct to draw immediately.
 */
export const turnsFor = query({
  args: { ...scopeArgs, channelId: v.string() },
  handler: async (ctx, args): Promise<RoomTurn[]> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { channel } = await requireChannelAccess(ctx, scope, args.channelId);
    const now = Date.now();
    const rows = await liveTurnRows(ctx, scope, channel.channelId, now);

    const names = new Map<string, string>();
    const out: RoomTurn[] = [];
    for (const row of rows) {
      if (!names.has(row.agentId)) {
        const agentId = ctx.db.normalizeId("agents", row.agentId);
        const agent = agentId ? await ctx.db.get(agentId) : null;
        names.set(row.agentId, agent?.name ?? "Unknown agent");
      }
      const turn = toChatTurn(row, names.get(row.agentId));
      out.push({ ...turn, liveness: turnLiveness(turn, now) });
    }
    return out.sort((left, right) => left.startedAt - right.startedAt);
  },
});

/**
 * Is anybody working in here, and since when?
 *
 * The single place every working affordance reads from (§5.5: "every surface
 * that shows a working affordance must read from this module rather than
 * picking one of the underlying pipes"). One agent per room per entry, anchored
 * to the **earliest** live turn — an elapsed counter says how long this has been
 * going on, and anchoring it to the latest heartbeat would reset it every ten
 * seconds.
 *
 * `now` comes back with the answer because the anchor is only meaningful
 * against the clock it was measured on, and the reader's may be minutes off.
 */
export const working = query({
  args: { ...scopeArgs, channelId: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { channel } = await requireChannelAccess(ctx, scope, args.channelId);
    const now = Date.now();
    const rows = await liveTurnRows(ctx, scope, channel.channelId, now);

    const names = new Map<string, string>();
    const turns: ChatTurn[] = [];
    for (const row of rows) {
      if (!names.has(row.agentId)) {
        const agentId = ctx.db.normalizeId("agents", row.agentId);
        const agent = agentId ? await ctx.db.get(agentId) : null;
        names.set(row.agentId, agent?.name ?? "Unknown agent");
      }
      turns.push(toChatTurn(row, names.get(row.agentId)));
    }

    const agents = workingAgents(turns, now);
    return {
      working: agents.length > 0,
      agents,
      /** The oldest live turn in the room — what a room-level counter anchors to. */
      anchorAt: agents.reduce<number | null>(
        (earliest, entry) =>
          earliest === null ? entry.anchorAt : Math.min(earliest, entry.anchorAt),
        null,
      ),
      now,
    };
  },
});

/**
 * The non-terminal turns worth showing, as index ranges.
 *
 * The lower bound is the recovery window rather than "everything non-terminal",
 * because a turn nobody has heard from in three minutes can never come back
 * (`nextTurnState` refuses it) and therefore has nothing left to say. Reading
 * it would mean every room paying, forever, for every harness that ever
 * crashed in it.
 *
 * The `MAX_TURN_DURATION_MS` case is not expressible as a range — a turn can be
 * two hours old and heartbeating — so it is filtered after, over at most a
 * window's worth of rows rather than over the table.
 */
async function liveTurnRows(
  ctx: QueryCtx,
  scope: Scope,
  channelId: string,
  now: number,
): Promise<TurnRow[]> {
  const floor = now - TURN_ABANDON_AFTER_MS;
  const rows: TurnRow[] = [];
  for (const state of ["started", "streaming"] as const) {
    const page = await ctx.db
      .query("buzzTurns")
      .withIndex("by_channel_state", (q) =>
        q
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId)
          .eq("channelId", channelId)
          .eq("state", state)
          .gte("lastActivityAt", floor),
      )
      .collect();
    rows.push(...page);
  }
  return rows.filter((row) => now - row.startedAt < MAX_TURN_DURATION_MS);
}
