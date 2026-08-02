// Liveness for the Chat dashboard: heartbeats, typing, and custom status.
//
// Three states of a person, three different homes, and the split is not a
// design preference — it is 06-protocol §16.22 read literally:
//
//   **status** is durable, so it is an event (kind 30315, addressable, `d` =
//   `general`). It survives a closed tab because somebody who wrote "out sick"
//   means it tomorrow morning. It is signed, replaceable, and exportable, like
//   everything else in the log.
//
//   **presence** is ephemeral, so it never touches the log. Buzz keeps it in
//   Redis under `buzz:{community}:presence:{pubkey}` with `EX 180` against a
//   60s heartbeat; we keep it in the `presence` table with the same 180s
//   window, swept opportunistically. Same shape, same TTL, same reason: three
//   heartbeat windows means one missed beat is not a state change.
//
//   **typing** is ephemeral *and* fast, so it is not stored anywhere at all.
//   It rides Ably, exactly as `realtime.chatSignal` already does for the Work
//   side, and for the reason stated there: a table every keystroke touches is
//   a table that dominates the write log. Ably being unconfigured is a
//   supported state — the room still works and nobody's dots appear.
//
// ---------------------------------------------------------------------------
// Why this reuses `convex/presence.ts` rather than owning a table
//
// That file already models both kinds of principal (`actorType: "user" |
// "agent"`), already sweeps stale rows with no cron, and already rides Convex
// subscriptions rather than a realtime service. An agent appearing in a
// community's presence the same way a person does is not a feature this file
// had to build — it is what happens when the agent writes to the same table
// through the same `markPresence`. Forking it would have produced a second
// answer to "who is here", drawn by different components, that drifts.
//
// The integration cost is what 07-integration-map §3 predicted: one literal
// (`"community"`) added to the surface union, and one branch in
// `requireSurface`. The surface id is `"<scopeType>:<scopeId>"` — a scope,
// which is what a Buzz community is (D4).
//
// Presence is **community-wide, never room-wide**, and that is a security
// property rather than a simplification. A row keyed by a room would be read
// through `presence.forActor`, whose access check is `requireSurface`; making
// that branch resolve a channel would mean a community member could learn who
// is standing in a private room. Room-level liveness rides the Ably channel
// instead, where the token is only minted after `channels.get` has said the
// caller may see the room at all.
//
// One number is duplicated on purpose: `PRESENCE_TTL_MS` and the heartbeat
// interval also live in `src/lib/buzz/presence.ts`. A value import across the
// convex/src boundary would work but is not a dependency direction this repo
// has anywhere else, so instead `tests/buzz-presence.test.ts` asserts the two
// copies agree — drift becomes a failing test rather than a silent retune.

import { ConvexError, v } from "convex/values";
import { action, mutation, query } from "../_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { anyApi } from "convex/server";
import type { FunctionReference } from "convex/server";
import { api } from "../_generated/api";
import { requireScopeAccess } from "../_authz";
import { requireAgentByKey, type Actor } from "../_agentAuth";
import { clearActorPresence, markPresence } from "../presence";
import { publishCore, readEventsCore, type Scope } from "./log";
import { pubkeyFor } from "./identity";

// ---------------------------------------------------------------------------
// The numbers (01-core-comms §5.1, 06-protocol §14)
// ---------------------------------------------------------------------------

/** A client republishes this often while it is not offline. */
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 60_000;
/** Three heartbeat windows. One missed beat must not be a state change. */
export const PRESENCE_TTL_MS = 3 * PRESENCE_HEARTBEAT_INTERVAL_MS;

/** Buzz's `KIND_USER_STATUS`, and the one coordinate it is written under. */
const KIND_USER_STATUS = 30315;
const USER_STATUS_D_TAG = "general";
/** Long enough for a sentence, short enough to sit beside a name. */
export const USER_STATUS_MAX_LENGTH = 120;

/** The Ably channel a room's ephemeral signals ride. */
export function buzzRoomChannel(channelId: string): string {
  // The `operate:chat:` prefix is not decoration: `realtime.publishFromClient`
  // refuses any other namespace from a client-reachable path. `buzz:` after it
  // keeps a Chat room and a Work channel from ever colliding on an id.
  return `operate:chat:buzz:${channelId}`;
}

const COMMUNITY_SURFACE = "community" as const;

/**
 * A community, as a presence surface id.
 *
 * Must stay in step with the `"community"` branch of `requireSurface` in
 * `convex/presence.ts`, which parses it back. Written twice rather than
 * imported once because the import would be circular — this file imports
 * `markPresence` from that one.
 */
export function communitySurfaceId(scope: Scope): string {
  return `${scope.scopeType}:${scope.scopeId}`;
}

const scopeArgs = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

const presenceState = v.union(v.literal("online"), v.literal("away"));

// ---------------------------------------------------------------------------
// Writing a heartbeat
// ---------------------------------------------------------------------------

/**
 * "I am at my machine, in this community."
 *
 * The reported state is carried in the row's `detail` — the field
 * `convex/presence.ts` describes as "in its own words". For a community
 * surface the only thing a heartbeat has to say beyond *that* it happened is
 * whether the human beside the client has stepped away, which the client works
 * out from OS idle (or in-app activity) and this mutation does not second-guess.
 *
 * Offline is the absence of a row, never a claim — the same as Buzz, where
 * `"offline"` is a Redis `DEL`. See `leave` below.
 */
export const heartbeat = mutation({
  args: { ...scopeArgs, state: presenceState },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    await markPresence(
      ctx,
      COMMUNITY_SURFACE,
      communitySurfaceId(scope),
      await userActor(ctx, subject),
      // A community is not a document you can be writing in. `editing` is the
      // caret on a page; typing in a room is an Ably signal, not this.
      { editing: false, detail: args.state },
    );
    return { ok: true as const };
  },
});

/** Go dark now, rather than waiting out the TTL. Closing a tab, or "Appear offline". */
export const leave = mutation({
  args: scopeArgs,
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    await clearActorPresence(ctx, COMMUNITY_SURFACE, communitySurfaceId(scope), subject);
    return { ok: true as const };
  },
});

/**
 * The same heartbeat, from an agent's own runtime.
 *
 * Key-authenticated in `"presence"` mode, so announcing yourself never spends
 * the budget for doing work — telling the room you are here is not an action
 * the room asked for. It writes the *same* row a person's heartbeat writes,
 * with `actorType: "agent"`, which is the entire reason an agent shows up in
 * the roster beside people rather than in a panel about machines.
 *
 * The agent's own scope is the fence: an agent scoped to one workspace cannot
 * announce itself in another community's roster, whatever it passes.
 */
export const agentHeartbeat = mutation({
  args: { apiKey: v.string(), ...scopeArgs, state: v.optional(presenceState) },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "presence");
    if (agent.parentType !== args.scopeType || agent.parentId !== args.scopeId) {
      throw new ConvexError("This agent does not belong to that community");
    }
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    await markPresence(
      ctx,
      COMMUNITY_SURFACE,
      communitySurfaceId(scope),
      { type: "agent", id: agent._id, name: agent.name },
      { editing: false, detail: args.state ?? "online" },
    );
    return { ok: true as const };
  },
});

/** An agent putting a community down — a harness shutting itself off. */
export const agentLeave = mutation({
  args: { apiKey: v.string(), ...scopeArgs },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "presence");
    if (agent.parentType !== args.scopeType || agent.parentId !== args.scopeId) {
      throw new ConvexError("This agent does not belong to that community");
    }
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    await clearActorPresence(ctx, COMMUNITY_SURFACE, communitySurfaceId(scope), agent._id);
    return { ok: true as const };
  },
});

// ---------------------------------------------------------------------------
// Reading the roster
// ---------------------------------------------------------------------------

export type PresenceEntry = {
  actorId: string;
  actorType: "user" | "agent";
  name: string;
  /** Their signing identity, so a caller can line them up with the log. */
  pubkey: string | null;
  status: "online" | "away" | "offline";
  /** ms of their last beat, or null when there is no row at all. */
  lastSeenAt: number | null;
  statusText: string | null;
  statusEmoji: string | null;
  /** ms, or null for "until they clear it". Expiry is applied before returning. */
  statusExpiresAt: number | null;
};

/**
 * Who is in this community right now, with what they have said about it.
 *
 * `seed` is a seed list, not a filter: Buzz's `get_presence` omits offline and
 * unknown pubkeys entirely, and its client seeds every requested pubkey to
 * offline so a member list can render a grey dot rather than a gap. Doing that
 * seeding here means one answer instead of one per caller. It carries
 * `actorType` because an agent's id resolves through a different table than a
 * person's, and guessing wrong would drop their key and their status.
 *
 * Deliberately **includes the caller**. `presence.viewers` excludes you because
 * a rail of who-else-is-here that shows your own face reads as somebody else
 * being present; a roster is the opposite surface — your own dot is how you
 * check that "Appear offline" actually took.
 */
export const roster = query({
  args: {
    ...scopeArgs,
    seed: v.optional(
      v.array(
        v.object({
          actorId: v.string(),
          actorType: v.union(v.literal("user"), v.literal("agent")),
        }),
      ),
    ),
  },
  handler: async (ctx, args): Promise<PresenceEntry[]> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    await requireScopeAccess(ctx, scope);
    const now = Date.now();

    const rows = await ctx.db
      .query("presence")
      .withIndex("by_surface", (q) =>
        q.eq("surfaceType", COMMUNITY_SURFACE).eq("surfaceId", communitySurfaceId(scope)),
      )
      .collect();

    const byActor = new Map<
      string,
      { actorType: "user" | "agent"; name: string; state: string | null; updatedAt: number | null }
    >();
    for (const row of rows) {
      // A row past the TTL is not evidence of anything, and `markPresence`'s
      // sweep will remove it the next time somebody writes. Dropping it here
      // rather than reporting it as offline keeps "offline" meaning exactly
      // what the seed list means it to mean.
      if (now - row.updatedAt >= PRESENCE_TTL_MS) continue;
      byActor.set(row.actorId, {
        actorType: row.actorType,
        name: row.name,
        state: row.detail ?? null,
        updatedAt: row.updatedAt,
      });
    }
    for (const wanted of args.seed ?? []) {
      if (!byActor.has(wanted.actorId)) {
        byActor.set(wanted.actorId, {
          actorType: wanted.actorType,
          name: "",
          state: null,
          updatedAt: null,
        });
      }
    }
    if (byActor.size === 0) return [];

    // Pubkeys first, because the status read is one query over all of them.
    const pubkeys = new Map<string, string>();
    for (const [actorId, entry] of byActor) {
      const pubkey = await pubkeyFor(ctx, entry.actorType, actorId);
      if (pubkey) pubkeys.set(actorId, pubkey);
    }
    const statuses = await readStatuses(ctx, scope, [...pubkeys.values()]);

    const out: PresenceEntry[] = [];
    for (const [actorId, entry] of byActor) {
      const pubkey = pubkeys.get(actorId) ?? null;
      const status = pubkey ? liveStatus(statuses.get(pubkey), now) : null;
      out.push({
        actorId,
        actorType: entry.actorType,
        name: entry.name || (await displayName(ctx, entry.actorType, actorId)),
        pubkey,
        status:
          entry.updatedAt === null
            ? "offline"
            : entry.state === "away"
              ? "away"
              : // A live beat whose claim we cannot read still proves a client
                // is running; the only thing left open is whether the person
                // is beside it, and "online" is the honest default there.
                "online",
        lastSeenAt: entry.updatedAt,
        statusText: status?.text ?? null,
        statusEmoji: status?.emoji ?? null,
        statusExpiresAt: status?.expiresAt ?? null,
      });
    }
    // Agents first and then by name — the same order `presence.readViewers`
    // uses, so the two rails cannot disagree about who leads.
    return out.sort((a, b) => {
      if (a.actorType !== b.actorType) return a.actorType === "agent" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  },
});

/** The caller's own current status, for the editor's initial state. */
export const myStatus = query({
  args: scopeArgs,
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const pubkey = await pubkeyFor(ctx, "user", subject);
    if (!pubkey) return null;
    const found = await readStatuses(ctx, scope, [pubkey]);
    const status = liveStatus(found.get(pubkey), Date.now());
    return status
      ? { text: status.text, emoji: status.emoji, expiresAt: status.expiresAt }
      : null;
  },
});

// ---------------------------------------------------------------------------
// Writing a status
// ---------------------------------------------------------------------------

/**
 * Publish a custom status.
 *
 * An event and not a row, because a status is durable and replaceable and
 * every other durable fact in Chat is an event. The `d` tag pins it to one
 * coordinate per author, so setting a status replaces the previous one rather
 * than accumulating a history of moods nobody asked to keep.
 *
 * `expiration` is NIP-40's tag, not a field of ours. Buzz has no expiry at all
 * and that is its most-reported failure mode — a Tuesday "In a meeting" still
 * showing on Thursday teaches everyone to ignore all of them. Using the
 * standard tag means the expiry survives export as something other tools
 * already understand, and it is applied **on read** (see `liveStatus`) so no
 * cron ever publishes a clear on somebody's behalf.
 */
export const setStatus = mutation({
  args: {
    ...scopeArgs,
    text: v.string(),
    emoji: v.string(),
    /** ms, or absent for "until I clear it". */
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);

    const text = args.text.trim().slice(0, USER_STATUS_MAX_LENGTH);
    const emoji = args.emoji.trim();
    if (!text && !emoji) {
      // The shape that means "cleared". Routed to `clearStatus` rather than
      // accepted here, so there is one way to say it and one event shape for
      // readers to recognise.
      throw new ConvexError("A status needs some text or an emoji — use clearStatus to remove one");
    }
    return await publishStatus(ctx, scope, await userActor(ctx, subject), {
      text,
      emoji,
      expiresAt: args.expiresAt,
    });
  },
});

/**
 * Clear it. An explicit publish of the empty shape, never a delete.
 *
 * The log is append-only, so "I took my status down" is itself a fact worth
 * having; and a reader that had cached the old one needs an event newer than
 * it to know. Deleting the row would leave both without an answer.
 */
export const clearStatus = mutation({
  args: scopeArgs,
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    return await publishStatus(ctx, scope, await userActor(ctx, subject), { text: "", emoji: "" });
  },
});

/**
 * Publish a status, for anybody.
 *
 * Exported because an agent says the same kind of thing about itself ("planning
 * the migration", "blocked on review") and it must land as the *same* kind-30315
 * at the same coordinate, signed by the agent's own key — that is what puts an
 * agent's working state next to a person's in the roster instead of in a panel
 * about machines (02-agents §3.4).
 */
export async function publishStatus(
  ctx: MutationCtx,
  scope: Scope,
  actor: Actor,
  input: { text: string; emoji: string; expiresAt?: number },
): Promise<{ eventId: string }> {
  const outcome = await publishCore(ctx, {
    actor,
    scope,
    kind: KIND_USER_STATUS,
    tags: [
      ["d", USER_STATUS_D_TAG],
      ...(input.emoji ? [["emoji", input.emoji]] : []),
      ...(input.expiresAt && input.expiresAt > Date.now()
        ? [["expiration", String(Math.floor(input.expiresAt / 1000))]]
        : []),
    ],
    content: input.text,
  });
  if (outcome.status === "dominated") {
    // §16.5: newest `created_at` wins and an equal second is broken by the
    // lower event id. Two saves inside one second can therefore lose, and the
    // honest answer is to say so — silently returning success would leave the
    // dialog showing a status the log does not hold.
    throw new ConvexError("Your status was changed a moment ago — try again");
  }
  if (outcome.status === "ephemeral") {
    throw new ConvexError("A status must be a stored event");
  }
  return { eventId: outcome.event.id };
}

// ---------------------------------------------------------------------------
// Typing — Ably only, never a write
// ---------------------------------------------------------------------------

/**
 * `api.buzz.channels.get`, named by hand.
 *
 * Same treatment as `buzz/keys.ts`: the checked-in `_generated/api.d.ts` is a
 * stub that predates `convex/buzz/`, and only `npx convex dev` may rewrite it.
 * `anyApi` resolves the same path at runtime. **Delete this and use
 * `api.buzz.channels.get` the first time the CLI regenerates the stub.**
 */
const channelsApi = anyApi.buzz.channels as unknown as {
  get: FunctionReference<
    "query",
    "public",
    { scopeType: "user" | "workspace"; scopeId: string; channelId: string },
    { channelId: string } | null
  >;
};

const TOKEN_TTL_MS = 30 * 60 * 1000;
const ABLY_REST = "https://rest.ably.io";

/**
 * A subscribe-only Ably token for one room's ephemeral signals.
 *
 * The access check happens here, against Convex, before the token exists — so
 * the token itself carries no identity anything downstream has to re-check,
 * and a leaked one is worth one room for half an hour. `channels.get` is the
 * check rather than a re-rolled one: a private room answers "not found" there,
 * which is what must happen here too.
 */
export const roomToken = action({
  args: { ...scopeArgs, channelId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ token: string; channel: string; expiresAt: number } | null> => {
    const room = await ctx.runQuery(channelsApi.get, {
      scopeType: args.scopeType,
      scopeId: args.scopeId,
      channelId: args.channelId,
    });
    if (!room) throw new ConvexError("Channel not found");

    const parts = ablyKeyParts();
    if (!parts) return null; // Unconfigured is a supported state.

    const channel = buzzRoomChannel(args.channelId);
    const response = await fetch(
      `${ABLY_REST}/keys/${encodeURIComponent(parts.keyName)}/requestToken`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${base64Ascii(parts.key)}`,
        },
        body: JSON.stringify({
          capability: JSON.stringify({ [channel]: ["subscribe"] }),
          ttl: TOKEN_TTL_MS,
        }),
      },
    );
    if (!response.ok) {
      console.error(`[buzz/presence] token request failed: ${response.status}`);
      return null;
    }
    const details = (await response.json()) as { token: string; expires?: number };
    return {
      token: details.token,
      channel,
      expiresAt: details.expires ?? Date.now() + TOKEN_TTL_MS,
    };
  },
});

/**
 * "I am typing here."
 *
 * An action, and never a database write — the rule the Work side already
 * learned (`realtime.chatSignal`) and the reason it is worth repeating: at one
 * broadcast per three seconds per typist, a table would take more writes from
 * people *about* to say something than from people saying it. A dropped signal
 * costs an indicator that does not appear, which is why this can be
 * fire-and-forget.
 */
export const signal = action({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    kind: v.union(v.literal("typing"), v.literal("here")),
    /** Absent for the room itself; set inside a thread. */
    threadHeadId: v.optional(v.string()),
    pubkey: v.string(),
    name: v.string(),
    isAgent: v.optional(v.boolean()),
  },
  handler: async (ctx: ActionCtx, args): Promise<null> => {
    const room = await ctx.runQuery(channelsApi.get, {
      scopeType: args.scopeType,
      scopeId: args.scopeId,
      channelId: args.channelId,
    });
    if (!room) throw new ConvexError("Channel not found");

    await ctx.runAction(api.realtime.publishFromClient, {
      channel: buzzRoomChannel(args.channelId),
      name: args.kind,
      data: {
        pubkey: args.pubkey,
        name: args.name,
        isAgent: args.isAgent ?? false,
        channelId: args.channelId,
        threadHeadId: args.threadHeadId ?? null,
        sentAt: Date.now(),
      },
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** The acting principal, in the shape every write path in this app takes. */
async function userActor(ctx: QueryCtx | MutationCtx, subject: string): Promise<Actor> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", subject))
    .unique();
  return { type: "user", id: subject, name: user?.name ?? user?.email ?? subject };
}

async function displayName(
  ctx: QueryCtx,
  actorType: "user" | "agent",
  actorId: string,
): Promise<string> {
  if (actorType === "agent") {
    const agentId = ctx.db.normalizeId("agents", actorId);
    const agent = agentId ? await ctx.db.get(agentId) : null;
    return agent?.name ?? "Unknown agent";
  }
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", actorId))
    .unique();
  return user?.name ?? user?.email ?? "Someone";
}

type StoredStatus = { text: string; emoji: string; updatedAt: number; expiresAt: number | null };

/**
 * How many live statuses one roster read will look at.
 *
 * 30315 is addressable, so a superseded status leaves the live index range and
 * the community holds **exactly one row per author who has ever set one**.
 * That makes this a bound on community size rather than on history, which is
 * the difference between a cap and a truncation bug. Past it, the roster still
 * draws everyone's dot and some people's status is missing — the honest
 * degradation, and the point at which this should page a filtered read instead.
 */
const MAX_STATUS_SCAN = 500;

/**
 * The live 30315s in this community, keyed by author.
 *
 * Through `readEventsCore` rather than `ctx.db`, so the per-event read gates
 * run — the read-leak shape 07-integration-map §7 warns about is exactly "get
 * the row and return it". A status is an open-gated kind, so nothing is
 * withheld today; routing through the core is what keeps that true if the
 * registry ever narrows it.
 *
 * The filter deliberately carries **no `authors`**: `candidatesFor`'s author
 * plan ranges an author's whole output newest-first, so asking for one
 * person's status returns their last N *messages*. The kind plan ranges
 * `(channel: none, kind, live)` instead, which is precisely the set wanted,
 * and the intersection with the authors we care about happens here.
 */
async function readStatuses(
  ctx: QueryCtx,
  scope: Scope,
  pubkeys: string[],
): Promise<Map<string, StoredStatus>> {
  const out = new Map<string, StoredStatus>();
  if (pubkeys.length === 0) return out;
  const wanted = new Set(pubkeys);

  const events = await readEventsCore(ctx, {
    scope,
    filters: [{ kinds: [KIND_USER_STATUS], limit: MAX_STATUS_SCAN }],
    // A status is community-readable; the reader's own key decides nothing
    // here, and passing one would be a second answer to a gate the core owns.
    readerPubkey: "",
  });

  for (const event of events) {
    if (!wanted.has(event.pubkey)) continue;
    if (!event.tags.some((tag) => tag[0] === "d" && tag[1] === USER_STATUS_D_TAG)) continue;
    const parsed = parseStatusEvent(event);
    if (!parsed) continue;
    const existing = out.get(event.pubkey);
    // Newest wins. The coordinate should leave exactly one live event per
    // author, but a read that assumes that and is wrong shows a stale status
    // with no way to notice.
    if (!existing || parsed.updatedAt > existing.updatedAt) out.set(event.pubkey, parsed);
  }
  return out;
}

/**
 * A 30315, read as a status. The mirror of `parseUserStatusEvent` in
 * `src/lib/buzz/presence.ts`, which is where the tested copy lives.
 */
function parseStatusEvent(event: {
  content: string;
  tags: string[][];
  created_at: number;
}): StoredStatus | null {
  const text = (event.content ?? "").trim().slice(0, USER_STATUS_MAX_LENGTH);
  const emoji = (event.tags.find((tag) => tag[0] === "emoji")?.[1] ?? "").trim();
  if (!text && !emoji) return null;
  const expirationSecs = Number(event.tags.find((tag) => tag[0] === "expiration")?.[1]);
  return {
    text,
    emoji,
    updatedAt: event.created_at * 1000,
    expiresAt:
      Number.isFinite(expirationSecs) && expirationSecs > 0
        ? Math.floor(expirationSecs) * 1000
        : null,
  };
}

/** Expiry applied on read, so a lapsed status is simply not there. */
function liveStatus(status: StoredStatus | undefined, now: number): StoredStatus | null {
  if (!status) return null;
  if (status.expiresAt !== null && status.expiresAt <= now) return null;
  return status;
}

function ablyKeyParts(): { keyName: string; key: string } | null {
  const key = process.env.ABLY_API_KEY;
  if (!key || !key.includes(":")) return null;
  return { keyName: key.split(":")[0], key };
}

/**
 * Base64 for an ASCII string.
 *
 * Hand-rolled rather than `btoa` or `Buffer`: this file is a default-runtime
 * module (it holds mutations and queries as well as actions), and the one
 * thing it must not do is depend on which of those two globals that runtime
 * happens to expose. An Ably key is ASCII by construction.
 */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64Ascii(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i += 3) {
    const a = input.charCodeAt(i);
    const b = i + 1 < input.length ? input.charCodeAt(i + 1) : NaN;
    const c = i + 2 < input.length ? input.charCodeAt(i + 2) : NaN;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)];
    out += Number.isNaN(b) ? "=" : B64[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)];
    out += Number.isNaN(c) ? "=" : B64[c & 63];
  }
  return out;
}
