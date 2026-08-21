// Rooms.
//
// A channel here is a **projection of the log**, and that sentence is the whole
// design of this file. Every mutation below publishes the event that explains
// the change — 9007 creates, 9000/9001 move members, 9002 edits metadata, 9021
// joins, 9022 leaves — and patches the row in the *same transaction*. Nothing
// patches a row without publishing, and nothing publishes without patching. The
// row exists so a rail can be drawn in one read; the log exists so "who renamed
// this and when" is answerable forever. Let them diverge and the second question
// silently stops having an answer, which nobody notices until they need it.
//
// Two shapes are load-bearing and are not this file's inventions:
//
//   - The channel vocabulary is a **product of three axes** (01-core-comms
//     §1.1): `channelType` × `visibility` × TTL. Public, private, DM, group DM
//     and ephemeral are readings of that product, not members of an enum. The
//     UI contract (`src/lib/buzz/channel-types.ts`) collapses them into a
//     `kind` field, and its own comment is careful to say that `kind` is a
//     *rendering hint* — how to title and sort a room — rather than a different
//     object with different rules. This file is where that stays true: there is
//     one channel table, one set of permissions, one write path.
//   - Tenancy is the scope, checked by `_authz.requireScopeAccess` (D4). A
//     channel is not a second security boundary bolted beside the first; it is
//     a room inside a community you already had to be able to reach.
//
// What C3 deliberately does not build, so it is a decision rather than a gap:
//
//   - **Read state.** `unread` and `mentions` were returned as 0 until C5, and
//     the dishonest options were both available and both refused: a made up
//     number, or the scan-per-channel the existing `chat.channels` does (it
//     `.collect()`s a channel's whole history per row, which is fine at Work
//     volume and is not fine here). C5 landed `readState.ts`, and the numbers
//     now come from there in bounded index ranges — see `list` below.
//   - **Hard delete.** Archive is reversible and covers what a room needs; a
//     real delete has to delete a *log*, which is a kind-5/9005 conversation
//     C4 owns.
//   - **39000–39002 roster rollups.** Relay-signed snapshots exist in Buzz so
//     third-party NIP-29 clients can discover groups over the relay. We do not
//     serve a relay, and our channel rows are that projection already; a second
//     copy would only be a copy that can go stale.
//
// One gap this phase leaves open, recorded here rather than discovered later.
// **`log.read` does not consult channel membership.** Its fence is the scope,
// so a community member who knows a private room's id can read that room's
// events directly through the log even though every surface in this file
// refuses them. `_kinds.ts` says membership enforcement "arrives with C3", and
// it cannot: the check belongs in `readEventsCore`, which owns the read, and
// the memberships table did not exist when that was written. `requireChannelAccess`
// below is the function it needs — one call, after the scope fence, for a read
// whose `subscriptionChannel` is non-null. Until then, treat a private room as
// private in the product and porous in the log.

import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireScopeAccess } from "../_authz";
import type { Actor } from "../_agentAuth";
// Type-only, and it is the contract three surfaces read: the rail draws it, the
// browser searches it, the room header describes it. Imported rather than
// restated so a field cannot mean one thing here and another there.
import type { ChatChannelSummary } from "../../src/lib/buzz/channel-types";
import { publishCore, type PublishArgs, type Scope } from "./log";
import { pubkeyFor } from "./identity";
import { asRelay, communityNonce } from "./relay";
// C5's read state, which is what turned the honest zeros below into numbers.
// The import runs the other way too — `readState.ts` needs this file's
// `requireChannelAccess` — and the cycle is inert: both edges are hoisted
// `async function`s called only inside handlers, so neither module needs the
// other at evaluation time. The alternative was a second answer to "may this
// person see this room" living in readState.ts, which is the kind of duplicate
// that agrees on the day it is written and not afterwards.
import { unreadForChannels, type ChannelUnread } from "./readState";

// ---------------------------------------------------------------------------
// The kinds this file writes
// ---------------------------------------------------------------------------
//
// Named constants rather than bare numbers at the call sites, with the registry
// names from `_kinds.ts` so the two files cross-read. The registry remains the
// authority on how each is stored and gated; these are only how they are
// spelled here.

/** Add a member (or change their role). `h` + `p` + optional `role`. */
const KIND_NIP29_PUT_USER = 9000;
/** Remove a member. `h` + `p`. */
const KIND_NIP29_REMOVE_USER = 9001;
/** Edit metadata: name / about / visibility / topic / purpose / archived / ttl. */
const KIND_NIP29_EDIT_METADATA = 9002;
/** Create the room. The one kind that cannot require an `h`: it makes one. */
const KIND_NIP29_CREATE_GROUP = 9007;
/** Join an open room. Refused on a private one — that is an invitation's job. */
const KIND_NIP29_JOIN_REQUEST = 9021;
/** Leave. The last-owner guard applies. */
const KIND_NIP29_LEAVE_REQUEST = 9022;
/** Relay-signed state row rendered in the timeline ("Ada joined"). */
const KIND_SYSTEM_MESSAGE = 40099;
/** The room's shared document. Written once here, from a template (§1.2). */
const KIND_CANVAS = 40100;
/** A DM conversation was created. */
const KIND_DM_CREATED = 41001;
/** Relay-signed, community-global, p-gated: "you were added to a room". */
const KIND_MEMBER_ADDED_NOTIFICATION = 44100;
/** Relay-signed, community-global, p-gated: "you were removed from a room". */
const KIND_MEMBER_REMOVED_NOTIFICATION = 44101;

// ---------------------------------------------------------------------------
// Names (§1.1)
// ---------------------------------------------------------------------------

/**
 * Buzz's `canonicalChannelName`, verbatim: strip leading `#` and whitespace,
 * trim the end.
 *
 * The `#` is display-only and storage never holds it — a room typed as
 * `#design` and a room typed as `design` are the same room, and a store that
 * kept the sigil would eventually hold both.
 */
export function canonicalChannelName(name: string): string {
  return name.replace(/^[#\s]+/u, "").trimEnd();
}

/**
 * The canonical form the *store* keys on: lowercase, dashed, no punctuation.
 *
 * Buzz's canonicalisation preserves case and spaces, and compares
 * case-insensitively when it needs to (`channelNamesMatch`). Ours goes one step
 * further, because the UI contract says `name` is "what `#name` resolves
 * against" and keeps the typed form in `displayName`. That makes `Release
 * Notes` and `release-notes` the same room, which is a *stricter* collision
 * rule than Buzz's — deliberately, because two rooms that `#release-notes`
 * could plausibly mean is exactly the ambiguity a mention token cannot survive.
 *
 * Both are kept: `canonicalChannelName` is what a person sees, `channelSlug` is
 * what the system resolves.
 */
export function channelSlug(name: string): string {
  return canonicalChannelName(name)
    .toLowerCase()
    // Any run of whitespace or punctuation becomes one dash, so "Release /
    // Notes" and "release-notes" converge instead of merely looking alike.
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/** Buzz's `channelNamesMatch`, expressed over the canonical form we store. */
export function channelNamesMatch(left: string, right: string): boolean {
  return channelSlug(left) === channelSlug(right);
}

// ---------------------------------------------------------------------------
// Ephemeral rooms (§1.1)
// ---------------------------------------------------------------------------

/** Seven days of *inactivity*, not seven days of existence. */
export const DEFAULT_EPHEMERAL_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * The units a TTL may be written in. Days down to seconds.
 *
 * Adding one means teaching `formatTtlDuration` the same unit in the same
 * commit — a parser that accepts a unit the formatter never emits produces a
 * value that cannot be shown back to the person who typed it.
 */
const TTL_UNITS: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };

/**
 * `"1d12h"` → seconds, or null.
 *
 * The rules are Buzz's and each one refuses something that would otherwise be a
 * silent misreading: whitespace is stripped and case ignored (so `1D 12H`
 * works), a **unit is required** (a bare `30` could mean seconds or minutes and
 * guessing is how somebody gets a room that vanishes in half a minute), a unit
 * may not repeat (`1h1h` is a typo, not two hours), nothing may be left over,
 * and the total must be positive (`0d` is not "no TTL", it is a mistake — an
 * unlimited room is expressed by having no TTL at all).
 */
export function parseTtlDuration(input: string): number | null {
  const cleaned = input.replace(/\s+/gu, "").toLowerCase();
  if (cleaned.length === 0) return null;

  const pattern = /(\d+)([dhms])/gu;
  const seen = new Set<string>();
  let total = 0;
  let consumed = 0;
  for (const match of cleaned.matchAll(pattern)) {
    if (seen.has(match[2])) return null;
    seen.add(match[2]);
    total += Number(match[1]) * TTL_UNITS[match[2]];
    consumed += match[0].length;
  }
  // Leftover characters mean the string was not entirely a duration. Refusing
  // is the difference between "1d12x" being an error and being read as one day.
  if (consumed !== cleaned.length) return null;
  return total > 0 ? total : null;
}

/** The inverse: `90061` → `"1d1h1m1s"`. `<= 0` is the empty string. */
export function formatTtlDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  let remaining = Math.floor(seconds);
  let out = "";
  for (const [unit, size] of Object.entries(TTL_UNITS)) {
    const count = Math.floor(remaining / size);
    if (count > 0) {
      out += `${count}${unit}`;
      remaining -= count * size;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Templates (§1.7)
// ---------------------------------------------------------------------------

/**
 * A furnished room: a name, a blurb, a visibility, and a canvas to start from.
 *
 * In code, like `LIST_TEMPLATES` and `BUILTIN_SKILLS` — a table for custom
 * templates is a schema written ahead of its first caller until somebody
 * actually authors one. Buzz's shape also carries `agents.personas` and
 * `agents.teams`; those name concepts C6 introduces, and a field describing
 * something that does not exist yet would be a promise this phase cannot keep.
 */
export type ChannelTemplate = {
  id: string;
  name: string;
  description: string;
  channelType: "stream" | "forum";
  visibility: "open" | "private";
  /** Supports `{channel.name}` and `{template.name}`. Null when there is none. */
  canvasTemplate: string | null;
  isBuiltin: boolean;
};

export const CHANNEL_TEMPLATES: readonly ChannelTemplate[] = [
  {
    id: "project",
    name: "Project",
    description: "Scope, decisions and status for one piece of work.",
    channelType: "stream",
    visibility: "open",
    canvasTemplate:
      "# {channel.name}\n\n## What we are doing\n\n## Decisions\n\n## Open questions\n",
    isBuiltin: true,
  },
  {
    id: "incident",
    name: "Incident",
    description: "One incident, from page to write-up.",
    channelType: "stream",
    visibility: "private",
    canvasTemplate:
      "# {channel.name}\n\n## Impact\n\n## Timeline\n\n## Mitigation\n\n## Follow-ups\n",
    isBuiltin: true,
  },
  {
    id: "standup",
    name: "Standup",
    description: "A daily written standup for one team.",
    channelType: "stream",
    visibility: "open",
    canvasTemplate: "# {channel.name}\n\n## Working on\n\n## Blocked by\n",
    isBuiltin: true,
  },
  {
    id: "proposals",
    name: "Proposals",
    description: "Long-form proposals and the argument about them.",
    channelType: "forum",
    visibility: "open",
    canvasTemplate: null,
    isBuiltin: true,
  },
];

export function channelTemplate(id: string): ChannelTemplate | undefined {
  return CHANNEL_TEMPLATES.find((t) => t.id === id);
}

/** Substitute the two variables a canvas template may use. */
export function renderChannelCanvas(
  template: ChannelTemplate,
  channelName: string,
): string | null {
  if (!template.canvasTemplate) return null;
  return template.canvasTemplate
    .replaceAll("{channel.name}", channelName)
    .replaceAll("{template.name}", template.name);
}

// ---------------------------------------------------------------------------
// Roles (§1.6)
// ---------------------------------------------------------------------------

export type ChannelRole = Doc<"buzzMemberships">["role"];

/** Buzz's `roleOrder`. Lower sorts first. */
const ROLE_ORDER: Record<ChannelRole, number> = {
  owner: 0,
  admin: 1,
  member: 2,
  guest: 3,
  bot: 4,
};

const roleValidator = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
  v.literal("guest"),
  v.literal("bot"),
);

const scopeArgs = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

type ChannelRow = Doc<"buzzChannels">;
type MembershipRow = Doc<"buzzMemberships">;

function scopeOf(channel: ChannelRow): Scope {
  return { scopeType: channel.scopeType, scopeId: channel.scopeId };
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * The community-level governance bar.
 *
 * `_authz.mayGovernSpace` is the app's one answer to "may this person change
 * something everyone sees", and this is the same rule — but it cannot be
 * *called*, because it takes a `spaces` document and a Buzz community is a
 * scope (a workspace, or a person). The two branches mirror it exactly: your
 * personal community is yours, and a workspace is governed by its owner. The
 * admin clause is this codebase's established shape for the same question
 * (`agents.ts`, `integrations.ts`, `webhooks.ts` all read the membership role
 * the same way).
 *
 * Exported because moderation (C7c) asks the same question and must not answer
 * it a second time: 9040–9044 are global commands with no `h` tag, so "may this
 * person ban somebody here" is exactly "may this person govern this community".
 * A copy in `moderation.ts` would be a second roster rule, and the two would
 * disagree the first time either changed.
 */
export async function mayGovernCommunity(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  subject: string,
): Promise<boolean> {
  if (scope.scopeType === "user") return scope.scopeId === subject;
  const workspaceId = ctx.db.normalizeId("workspaces", scope.scopeId);
  if (!workspaceId) return false;
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q.eq("userClerkId", subject).eq("workspaceId", workspaceId),
    )
    .unique();
  return membership?.role === "owner" || membership?.role === "admin";
}

/**
 * May this person change something everyone in the *room* sees?
 *
 * A room has its own owners and admins — that is Buzz's model and it is what
 * lets a member create a room and run it without being a workspace admin. The
 * community governor is kept as a second answer so a workspace owner is never
 * locked out of a room inside their own workspace, which is the same reason
 * `mayGovernSpace` lets a workspace owner govern any space in it.
 */
async function mayGovernChannel(
  ctx: QueryCtx | MutationCtx,
  channel: ChannelRow,
  subject: string,
  membership: MembershipRow | null,
): Promise<boolean> {
  if (membership && (membership.role === "owner" || membership.role === "admin")) {
    return true;
  }
  return await mayGovernCommunity(ctx, scopeOf(channel), subject);
}

async function channelRow(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  channelId: string,
): Promise<ChannelRow | null> {
  return await ctx.db
    .query("buzzChannels")
    .withIndex("by_scope_channel", (q) =>
      q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("channelId", channelId),
    )
    .unique();
}

async function membershipRow(
  ctx: QueryCtx | MutationCtx,
  channel: ChannelRow,
  actorId: string,
): Promise<MembershipRow | null> {
  return await ctx.db
    .query("buzzMemberships")
    .withIndex("by_channel_actor", (q) =>
      q
        .eq("scopeType", channel.scopeType)
        .eq("scopeId", channel.scopeId)
        .eq("channelId", channel.channelId)
        .eq("actorId", actorId),
    )
    .unique();
}

/**
 * A membership that is currently in force — a soft-removed row is not one.
 *
 * Deliberately a plain boolean rather than a type predicate: a removed row is
 * still a *row*, and a predicate would narrow the false branch to `null`,
 * hiding the row every re-join path needs to reverse instead of duplicate.
 */
function isActive(membership: MembershipRow | null): boolean {
  return membership !== null && membership.removedAt === undefined;
}

/**
 * May this reader see that this room exists at all? (§1.3)
 *
 * The rule Buzz's browser filters on, applied server-side because it is an
 * access rule wearing a filter's clothes: an archived room is visible only to
 * its members, a private room only to its members, an open room to the whole
 * community, and a DM only to its participants.
 */
function visibleToReader(channel: ChannelRow, membership: MembershipRow | null): boolean {
  if (isActive(membership)) return true;
  if (channel.archivedAt !== undefined) return false;
  if (channel.channelType === "dm") return false;
  return channel.visibility === "open";
}

/**
 * Resolve a room for a reader, or refuse.
 *
 * The 07-integration-map §7 shape: `requireScopeAccess` for the tenancy fence,
 * then the room's own visibility. It lives here rather than in `_authz.ts`
 * because it is built out of that file's primitives rather than being a new
 * one.
 *
 * A room the reader may not see reports "not found" rather than "forbidden",
 * and the two cases are deliberately indistinguishable: whether a private room
 * called `#acquisition` exists is itself the information being protected.
 */
export async function requireChannelAccess(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  channelId: string,
): Promise<{ subject: string; channel: ChannelRow; membership: MembershipRow | null }> {
  const { subject } = await requireScopeAccess(ctx, scope);
  return { subject, ...(await resolveChannelForActor(ctx, scope, channelId, subject)) };
}

/**
 * The room half of the answer above, for a principal that is **not** a Clerk
 * session.
 *
 * Split out because an agent authenticates by API key rather than by identity,
 * so it cannot pass through `requireScopeAccess` — and the alternative, an
 * agent-side copy of "archived rooms are members-only, private rooms are
 * members-only, DMs are participants-only", is a second answer to the question
 * this file exists to answer once. The two halves stay separable and stay
 * paired: **the caller owes the tenancy fence.** For a person that is
 * `requireScopeAccess`; for an agent it is `_agentAuth`'s "does this agent
 * belong to this community", which is the same boundary reached through the
 * other door (D4). Called without one, this function answers only "is this room
 * visible to this actor", which is not enough.
 */
export async function resolveChannelForActor(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  channelId: string,
  actorId: string,
): Promise<{ channel: ChannelRow; membership: MembershipRow | null }> {
  const channel = await channelRow(ctx, scope, channelId);
  if (!channel) throw new ConvexError("Channel not found");
  const membership = await membershipRow(ctx, channel, actorId);
  if (!visibleToReader(channel, membership)) throw new ConvexError("Channel not found");
  return { channel, membership: isActive(membership) ? membership : null };
}

/**
 * Who is acting on a room, in the one shape every write path here takes.
 *
 * `actor` is what signs (it goes to `publishCore`); `actorType`/`actorId` are
 * what a membership row and a key lookup are keyed by. They are carried
 * together rather than derived from each other because `Actor.id` is a Clerk
 * subject for a person and an `agents` document id for an agent, and a core
 * that had to re-derive "which table is this id in" would be re-deciding
 * something its caller already knew for certain.
 */
export type ChannelPrincipal = {
  actor: Actor;
  actorType: "user" | "agent";
  actorId: string;
};

/**
 * The role a principal takes when it joins under its own steam.
 *
 * An agent lands as `bot`, which is not a demotion — it is the membership
 * signal the whole UI reads (02-agents §3.4: `role === "bot"` and `isAgent` are
 * the two things that make an agent render as an agent rather than as a
 * stranger with an odd name).
 */
function defaultJoinRole(actorType: "user" | "agent"): ChannelRole {
  return actorType === "agent" ? "bot" : "member";
}

/** The same, plus "and you are in it". */
async function requireMembership(
  ctx: MutationCtx,
  scope: Scope,
  channelId: string,
): Promise<{ subject: string; channel: ChannelRow; membership: MembershipRow }> {
  const resolved = await requireChannelAccess(ctx, scope, channelId);
  if (!resolved.membership) throw new ConvexError("You are not in this channel");
  return { subject: resolved.subject, channel: resolved.channel, membership: resolved.membership };
}

/**
 * DM immutability (§1.2, §1.5), enforced here and not in the UI.
 *
 * A DM's identity **is** its participant set — that is what `participantKey`
 * stores and what makes opening one twice idempotent. So adding a person does
 * not extend a conversation, it names a different one; and a DM has no name or
 * topic to change, because its title is derived from who is in it. A client
 * that forgets any of this must be refused rather than believed: this is the
 * kind of rule that is enforced in three UI branches and missed in the fourth.
 */
function refuseOnDm(channel: ChannelRow, what: string): void {
  if (channel.channelType === "dm") {
    throw new ConvexError(`A direct message cannot ${what}`);
  }
}

/** The acting principal, in the shape every write path in this app takes. */
async function userActor(ctx: QueryCtx | MutationCtx, subject: string): Promise<Actor> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", subject))
    .unique();
  return { type: "user", id: subject, name: user?.name ?? user?.email ?? subject };
}

/**
 * The pubkey a member's events are signed with, or a refusal naming them.
 *
 * A room membership is recorded in the log as `["p", <pubkey>]`, so a principal
 * with no Chat identity cannot be added: there is no value to put in the tag,
 * and inventing one (an actor id, say) would put a string in a `p` tag that
 * every read gate compares against pubkeys and silently never matches. The
 * honest answer is to refuse and say why — their key is minted the first time
 * they open Chat.
 */
async function requirePubkey(
  ctx: MutationCtx,
  principalType: "user" | "agent",
  principalId: string,
  label: string,
): Promise<string> {
  const pubkey = await pubkeyFor(ctx, principalType, principalId);
  if (!pubkey) {
    throw new ConvexError(
      `${label} has not opened Chat yet, so they have no signing identity to add to a room.`,
    );
  }
  return pubkey;
}

// ---------------------------------------------------------------------------
// Writing the log
// ---------------------------------------------------------------------------

/**
 * Publish, and refuse to continue if the change has no explanation in the log.
 *
 * `publishCore` reports three non-error outcomes and they do not mean the same
 * thing here. `duplicate` is fine: the identical signed event is already in the
 * log, so the projection this file is about to write *is* explained — that is
 * what makes resubmitting a signed event idempotent rather than an error.
 * `dominated` and `ephemeral` wrote nothing at all, and patching a row on the
 * strength of an event that does not exist is precisely the divergence this
 * file is built to prevent, so they stop the transaction.
 *
 * `fresh` says which it was, for the two callers that need a genuinely new
 * event: a room's id *is* its creation event's id, so a duplicate there would
 * silently point a second room at the first one's identity.
 */
async function publishOrThrow(
  ctx: MutationCtx,
  args: PublishArgs,
): Promise<{ eventId: string; fresh: boolean }> {
  const outcome = await publishCore(ctx, args);
  if (outcome.status === "dominated" || outcome.status === "ephemeral") {
    throw new ConvexError(
      `The channel log refused this change (${outcome.status}); nothing was written.`,
    );
  }
  return { eventId: outcome.event.id, fresh: outcome.status === "inserted" };
}

type SystemMessageType =
  | "channel_created"
  | "member_joined"
  | "member_added"
  | "member_left"
  | "member_removed"
  | "role_changed"
  | "name_changed"
  | "description_changed"
  | "visibility_changed"
  | "topic_changed"
  | "purpose_changed"
  | "ttl_changed"
  | "archived"
  | "unarchived";

/**
 * The relay-signed row a room shows in its timeline ("Ada joined").
 *
 * Signed by the community relay rather than by the person it describes, which
 * is the entire point (see relay.ts): a member cannot write "Ada was removed"
 * about Ada. The content shape is Buzz's — `{type, actor, target}` — and the
 * attribution lives in the payload rather than in the signature, because the
 * signer is the room and the actor is the person.
 */
async function publishSystemMessage(
  ctx: MutationCtx,
  scope: Scope,
  channelId: string,
  payload: { type: SystemMessageType; actor: string; target?: string; value?: string },
): Promise<void> {
  await publishOrThrow(
    ctx,
    asRelay(scope, {
      kind: KIND_SYSTEM_MESSAGE,
      tags: [["h", channelId]],
      content: JSON.stringify(payload),
    }),
  );
}

/**
 * "You were added to / removed from a room", addressed to one pubkey.
 *
 * Stored community-globally with the channel as *metadata* rather than as its
 * room (§3.8): that is what lets an agent subscribe to "rooms I am put into"
 * without already knowing the room ids — which it cannot, since it has not been
 * added to them yet. `p`-gated, so only the person it names can read it.
 */
async function publishMemberNotification(
  ctx: MutationCtx,
  scope: Scope,
  channelId: string,
  targetPubkey: string,
  actorPubkey: string,
  added: boolean,
): Promise<void> {
  await publishOrThrow(
    ctx,
    asRelay(scope, {
      kind: added ? KIND_MEMBER_ADDED_NOTIFICATION : KIND_MEMBER_REMOVED_NOTIFICATION,
      tags: [
        ["p", targetPubkey],
        ["h", channelId],
      ],
      content: JSON.stringify({
        type: added ? "member_added" : "member_removed",
        channel_id: channelId,
        actor: actorPubkey,
      }),
    }),
  );
}

/** Fields of a room a mutation may change. Never `_id`, never the scope. */
type ChannelPatch = Partial<Omit<ChannelRow, "_id" | "_creationTime" | "scopeType" | "scopeId">>;

/** Bump the room's clocks. The TTL is measured from `lastActivityAt`. */
async function touch(ctx: MutationCtx, channel: ChannelRow, patch: ChannelPatch = {}) {
  const now = Date.now();
  await ctx.db.patch(channel._id, { ...patch, updatedAt: now, lastActivityAt: now });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** How a room is drawn, derived rather than stored (see channel-types.ts). */
function summaryKind(channel: ChannelRow): ChatChannelSummary["kind"] {
  if (channel.channelType === "forum") return "forum";
  if (channel.channelType !== "dm") return "channel";
  return channel.memberCount > 2 ? "group_dm" : "dm";
}

function toSummary(
  channel: ChannelRow,
  membership: MembershipRow | null,
  // Required rather than defaulted: a default is how one of the two call sites
  // below quietly keeps drawing zeros while the other draws numbers, and a rail
  // and a room header disagreeing about whether there is anything unread is
  // exactly the contradiction §4.6 spends a paragraph on.
  unread: ChannelUnread,
): ChatChannelSummary {
  return {
    channelId: channel.channelId,
    name: channel.name,
    displayName: channel.displayName,
    kind: summaryKind(channel),
    // The store speaks Buzz's `open`/`private`; the UI contract speaks
    // `public`/`private`. Translated in exactly one place — a second
    // translation is how half a product ends up asking for the wrong word.
    visibility: channel.visibility === "open" ? "public" : "private",
    ...(channel.topic ? { topic: channel.topic } : {}),
    ...(channel.description ? { description: channel.description } : {}),
    memberCount: channel.memberCount,

    // Real, as of C5. Two numbers because they are drawn differently: `unread`
    // is the dot (anything conversational you have not seen), `mentions` is the
    // count you are expected to act on (a DM, or a message that names you).
    // Both come from `readState.unreadForChannels`, which answers them in
    // bounded index ranges — never by counting a channel's history per rail
    // row, which is the shape the existing Work-side `chat.channels` has and
    // the one this file refused to reproduce while it had no read state.
    unread: unread.unread,
    mentions: unread.mentions,
    // Mutes are NIP-78 app data (kind 30078, `d: channel-mutes`) — a *log*
    // record, not a column here — and C5 reads them.
    muted: false,

    joined: isActive(membership),
    ...(channel.archivedAt !== undefined ? { archivedAt: channel.archivedAt } : {}),
    ...(channel.ttlSeconds !== undefined ? { ttlSeconds: channel.ttlSeconds } : {}),
    lastActivityAt: channel.lastActivityAt,
  };
}

/** Buzz's `sortChannels`: streams, then forums, then DMs; then by name. */
const CHANNEL_TYPE_ORDER: Record<ChannelRow["channelType"], number> = {
  stream: 0,
  forum: 1,
  dm: 2,
};

/**
 * Every room in this community the caller may see.
 *
 * Two index reads for the rooms themselves, whatever the room count: every
 * channel in the scope, and every membership *this actor* holds in the scope.
 * The membership map is built once and looked up per row, because the
 * alternative — a membership query per channel — is the shape that reads fine
 * at ten rooms and times out at a thousand.
 *
 * The unread numbers add one read for the caller's read state, plus a bounded
 * index range for each **joined** room whose newest activity is not already
 * covered by the caller's marker — usually none of them, because
 * `lastActivityAt` is denormalized here for exactly this comparison. See
 * `readState.unreadForChannels`.
 *
 * `activeChannelId` is optional and is the room the caller is standing in: its
 * badge is suppressed (§4.5) because the mark-as-read for it is in flight and a
 * number on the thing you are looking at only ever flickers.
 */
export const list = query({
  args: { ...scopeArgs, activeChannelId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ChatChannelSummary[]> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    return await listChannelsCore(ctx, scope, { actorType: "user", actorId: subject }, args);
  },
});

/**
 * The rail, for anybody: the query above with the reader passed in.
 *
 * An agent asking "what rooms am I in" is asking the rail's question, and the
 * answer has to be the rail's answer — same visibility rule, same hidden-DM
 * rule, same unread numbers from the same bounded ranges. An agent surface that
 * listed rooms its own way would be the one place a private room could show up
 * because the second copy of `visibleToReader` forgot a clause.
 */
export async function listChannelsCore(
  ctx: QueryCtx,
  scope: Scope,
  reader: { actorType: "user" | "agent"; actorId: string },
  args: { activeChannelId?: string } = {},
): Promise<ChatChannelSummary[]> {
  const channels = await ctx.db
    .query("buzzChannels")
    .withIndex("by_scope_name", (q) =>
      q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId),
    )
    .collect();

  const memberships = await ctx.db
    .query("buzzMemberships")
    .withIndex("by_actor", (q) =>
      q
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("actorId", reader.actorId)
        .eq("removedAt", undefined),
    )
    .collect();
  const mine = new Map(memberships.map((m) => [m.channelId, m]));

  const drawn = channels
    .map((channel) => ({ channel, membership: mine.get(channel.channelId) ?? null }))
    .filter(({ channel, membership }) => visibleToReader(channel, membership))
    // A DM the caller has hidden is gone from the rail and nowhere else: the
    // membership stands, the other participant sees no change, and the next
    // message brings it back (C4).
    .filter(({ membership }) => membership?.hiddenAt === undefined);

  // One read for the reader's identity, one for their read state, and a
  // bounded range only for the rooms that could plausibly hold something new.
  const readerPubkey = await pubkeyFor(ctx, reader.actorType, reader.actorId);
  const unread = await unreadForChannels(
    ctx,
    scope,
    readerPubkey,
    drawn.map(({ channel, membership }) => ({
      channelId: channel.channelId,
      channelType: channel.channelType,
      lastActivityAt: channel.lastActivityAt,
      joined: isActive(membership),
    })),
    args.activeChannelId !== undefined ? { activeChannelId: args.activeChannelId } : {},
  );

  return drawn
    .map(({ channel, membership }) => ({
      channel,
      summary: toSummary(
        channel,
        membership,
        unread.get(channel.channelId) ?? { unread: 0, mentions: 0 },
      ),
    }))
    .sort(
      (a, b) =>
        CHANNEL_TYPE_ORDER[a.channel.channelType] - CHANNEL_TYPE_ORDER[b.channel.channelType] ||
        a.summary.name.localeCompare(b.summary.name),
    )
    .map(({ summary }) => summary);
}

/**
 * One room, with the fields the management panel shows (§1.5).
 *
 * A superset of the summary rather than a different object, so the header and
 * the panel cannot disagree about what a room is called.
 */
export const get = query({
  args: { ...scopeArgs, channelId: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel, membership } = await requireChannelAccess(ctx, scope, args.channelId);
    // The same numbers the rail draws, from the same function — a header that
    // computed its own would be a second answer to "is there anything unread
    // here", and the two would disagree in front of the reader.
    const readerPubkey = await pubkeyFor(ctx, "user", subject);
    const unread = await unreadForChannels(ctx, scope, readerPubkey, [
      {
        channelId: channel.channelId,
        channelType: channel.channelType,
        lastActivityAt: channel.lastActivityAt,
        joined: isActive(membership),
      },
    ]);
    return {
      ...toSummary(
        channel,
        membership,
        unread.get(channel.channelId) ?? { unread: 0, mentions: 0 },
      ),
      channelType: channel.channelType,
      description: channel.description,
      topic: channel.topic ?? null,
      topicSetAt: channel.topicSetAt ?? null,
      purpose: channel.purpose ?? null,
      purposeSetAt: channel.purposeSetAt ?? null,
      createdByActorId: channel.createdByActorId,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
      templateId: channel.templateId ?? null,
      /** What *you* may do here — so the UI never offers a button that refuses. */
      myRole: membership?.role ?? null,
      canGovern: await mayGovernChannel(ctx, channel, subject, membership),
    };
  },
});

/**
 * Who is in the room, in Buzz's order (§1.6).
 *
 * `compareMembersByRole`: yourself first, then by role, then by name. The
 * classification the sidebar draws (people vs bots) is a rendering decision and
 * stays in the UI — what the server owes it is the two facts it cannot derive,
 * `role` and `actorType`.
 */
export const members = query({
  args: { ...scopeArgs, channelId: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel } = await requireChannelAccess(ctx, scope, args.channelId);

    const rows = await ctx.db
      .query("buzzMemberships")
      .withIndex("by_channel", (q) =>
        q
          .eq("scopeType", channel.scopeType)
          .eq("scopeId", channel.scopeId)
          .eq("channelId", channel.channelId)
          .eq("removedAt", undefined),
      )
      .collect();

    const resolved = await Promise.all(
      rows.map(async (row) => {
        let name = row.actorId;
        if (row.actorType === "agent") {
          // normalizeId rather than a cast: a deleted agent must read as
          // "unknown agent" rather than crash the member list it appears in.
          const agentId = ctx.db.normalizeId("agents", row.actorId);
          const agent = agentId ? await ctx.db.get(agentId) : null;
          name = agent?.name ?? "Unknown agent";
        } else {
          const user = await ctx.db
            .query("users")
            .withIndex("by_clerk_id", (q) => q.eq("clerkId", row.actorId))
            .unique();
          name = user?.name ?? user?.email ?? "Someone";
        }
        return {
          actorId: row.actorId,
          actorType: row.actorType,
          role: row.role,
          joinedAt: row.joinedAt,
          name,
          isSelf: row.actorId === subject,
        };
      }),
    );

    return resolved.sort((left, right) => {
      if (left.isSelf !== right.isSelf) return left.isSelf ? -1 : 1;
      const byRole = ROLE_ORDER[left.role] - ROLE_ORDER[right.role];
      if (byRole !== 0) return byRole;
      return left.name.localeCompare(right.name);
    });
  },
});

/** The template gallery (§1.7). Built-ins, from code. */
export const templates = query({
  args: {},
  handler: async (): Promise<ChannelTemplate[]> => [...CHANNEL_TEMPLATES],
});

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

/**
 * Create a room.
 *
 * The order matters and is not arbitrary: the 9007 is published **first**, and
 * its event id becomes the channel id. A Convex mutation has no CSPRNG, so the
 * alternatives were a client-supplied uuid (an id a client can collide on
 * purpose) or a counter (an id that leaks how many rooms a community has). An
 * event id is a hash: unforgeable, unique, and it makes the room's identity
 * literally derived from the log entry announcing it.
 *
 * Everything after that — the row, the owner membership, the 9000, the system
 * message, the canvas — is in the same transaction. There is no window in which
 * a room exists with no owner, or an owner exists with no room.
 */
export const create = mutation({
  args: {
    ...scopeArgs,
    name: v.string(),
    description: v.optional(v.string()),
    visibility: v.optional(v.union(v.literal("open"), v.literal("private"))),
    // `dm` is absent on purpose: `CreateChannelInput` excludes it (§1.2),
    // because a DM is opened around people rather than created around a name.
    channelType: v.optional(v.union(v.literal("stream"), v.literal("forum"))),
    ttlSeconds: v.optional(v.number()),
    templateId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const actor = await userActor(ctx, subject);

    const template = args.templateId ? channelTemplate(args.templateId) : undefined;
    if (args.templateId && !template) throw new ConvexError("Unknown channel template");

    const displayName = canonicalChannelName(args.name);
    const slug = channelSlug(args.name);
    if (slug.length === 0) throw new ConvexError("A channel needs a name");

    const clash = await ctx.db
      .query("buzzChannels")
      .withIndex("by_scope_name", (q) =>
        q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("name", slug),
      )
      .first();
    if (clash) throw new ConvexError(`#${slug} already exists in this community`);

    // The template supplies defaults; an explicit argument always wins, because
    // a person who chose a visibility and then picked a template did not mean
    // to un-choose it (§1.2's `visibilityTouchedRef`, decided server-side so
    // both dialogs cannot diverge).
    const visibility = args.visibility ?? template?.visibility ?? "open";
    const channelType = args.channelType ?? template?.channelType ?? "stream";
    const description = args.description ?? template?.description ?? "";
    const ttlSeconds =
      args.ttlSeconds !== undefined && args.ttlSeconds > 0 ? Math.floor(args.ttlSeconds) : undefined;

    const creatorPubkey = await requirePubkey(ctx, "user", subject, actor.name);

    // The creation event carries **nothing the room would hide**, and that is
    // forced rather than chosen. The room's id is this event's id, so the event
    // cannot carry an `h` tag naming the room — it does not exist yet — which
    // makes it a community-wide record that every member can read. A private
    // room whose *name* is announced to the whole workspace is not private in
    // the way people mean the word, so the name, the blurb and the visibility
    // go in the channel-scoped 9002 below instead, and this event says only
    // that somebody made a room.
    //
    // The nonce is what keeps it unique without saying anything: an event id is
    // a hash of its own contents, so two rooms made by one person in the same
    // second would otherwise be the same event.
    const created = await publishOrThrow(ctx, {
      actor,
      scope,
      kind: KIND_NIP29_CREATE_GROUP,
      tags: [
        ["channel_type", channelType],
        ["nonce", communityNonce(scope, slug)],
      ],
      content: "",
    });
    // A room's id is its creation event's id, so it must be a *new* event.
    // A duplicate would mean an identical 9007 already exists and this room
    // would adopt the identity of that one.
    if (!created.fresh) throw new ConvexError("That channel was just created");
    const channelId = created.eventId;

    const now = Date.now();
    await ctx.db.insert("buzzChannels", {
      ...scope,
      channelId,
      name: slug,
      displayName,
      channelType,
      visibility,
      description,
      ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
      createdByActorId: subject,
      createdAt: now,
      updatedAt: now,
      memberCount: 1,
      lastActivityAt: now,
      ...(args.templateId ? { templateId: args.templateId } : {}),
    });

    await ctx.db.insert("buzzMemberships", {
      ...scope,
      channelId,
      actorId: subject,
      actorType: "user",
      role: "owner",
      joinedAt: now,
    });

    // The room's metadata, channel-scoped so it is readable exactly where the
    // room is. Initial metadata through the same event that later edits it,
    // rather than a second vocabulary for "the first time": one kind, one
    // handler, one thing to keep right.
    await publishOrThrow(ctx, {
      actor,
      scope,
      kind: KIND_NIP29_EDIT_METADATA,
      tags: [
        ["h", channelId],
        ["name", displayName],
        ["visibility", visibility],
        ...(description ? [["about", description]] : []),
        ...(ttlSeconds !== undefined ? [["ttl", String(ttlSeconds)]] : []),
      ],
      content: "",
    });

    await publishOrThrow(ctx, {
      actor,
      scope,
      kind: KIND_NIP29_PUT_USER,
      tags: [
        ["h", channelId],
        ["p", creatorPubkey],
        ["role", "owner"],
      ],
      content: "",
    });

    await publishSystemMessage(ctx, scope, channelId, {
      type: "channel_created",
      actor: creatorPubkey,
      value: displayName,
    });

    // The template's canvas, rendered and written as the room's 40100. Buzz
    // applies it post-create and best-effort; ours is in the transaction
    // because it can only fail if the whole write fails — and a room that was
    // created "from the incident template" without the incident canvas is a
    // template that did nothing.
    const canvas = template ? renderChannelCanvas(template, displayName) : null;
    if (canvas) {
      await publishOrThrow(ctx, {
        actor,
        scope,
        kind: KIND_CANVAS,
        tags: [["h", channelId]],
        content: canvas,
      });
    }

    return { channelId, name: slug };
  },
});

/**
 * Open a DM, or return the one that already exists.
 *
 * Idempotent by participant set, which is the same fact as DM immutability seen
 * from the other side: if the set identifies the conversation, then opening it
 * twice must find the first one, and adding somebody must be refused rather
 * than mutate it into a conversation the other participants did not agree to.
 */
export const openDm = mutation({
  args: { ...scopeArgs, actorIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const actor = await userActor(ctx, subject);

    const participants = [...new Set([subject, ...args.actorIds])].sort();
    if (participants.length < 2) throw new ConvexError("A DM needs somebody else in it");
    // Buzz caps a DM at 8 participants (kind 41010). Beyond that it is a
    // channel, and a channel is the thing with a name, a topic and members you
    // can add — which is exactly what a conversation that size turns out to
    // need.
    if (participants.length > 8) throw new ConvexError("A DM holds at most 8 people");

    const participantKey = participants.join(",");
    const existing = await ctx.db
      .query("buzzChannels")
      .withIndex("by_scope_participants", (q) =>
        q
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId)
          .eq("participantKey", participantKey),
      )
      .first();
    if (existing) {
      // Re-opening un-hides it for the caller, which is what "open" means when
      // the conversation is already there.
      const mine = await membershipRow(ctx, existing, subject);
      if (mine?.hiddenAt !== undefined) await ctx.db.patch(mine._id, { hiddenAt: undefined });
      return { channelId: existing.channelId, created: false };
    }

    const pubkeys = new Map<string, string>();
    for (const participant of participants) {
      pubkeys.set(participant, await requirePubkey(ctx, "user", participant, participant));
    }

    // Same reasoning as `create`, and it bites harder here: who is talking to
    // whom is the most sensitive thing a DM has, so the participants are named
    // in the channel-scoped 41001 below and never in the community-wide event
    // that mints the id.
    const created = await publishOrThrow(ctx, {
      actor,
      scope,
      kind: KIND_NIP29_CREATE_GROUP,
      tags: [
        ["channel_type", "dm"],
        ["nonce", communityNonce(scope, participantKey)],
      ],
      content: "",
    });
    if (!created.fresh) throw new ConvexError("That conversation was just created");
    const channelId = created.eventId;

    const now = Date.now();
    await ctx.db.insert("buzzChannels", {
      ...scope,
      channelId,
      // A DM has no name, and that absence is the point: its title is derived
      // from who is in it, so a stored name would go wrong the moment somebody
      // is renamed. The uniqueness check skips empty names for the same reason.
      name: "",
      displayName: "",
      channelType: "dm",
      visibility: "private",
      description: "",
      createdByActorId: subject,
      createdAt: now,
      updatedAt: now,
      memberCount: participants.length,
      lastActivityAt: now,
      participantKey,
    });

    for (const participant of participants) {
      await ctx.db.insert("buzzMemberships", {
        ...scope,
        channelId,
        actorId: participant,
        actorType: "user",
        // Nobody owns a DM. An owner is somebody who can rename, archive and
        // remove people, and none of those exist here.
        role: "member",
        joinedAt: now,
      });
    }

    await publishOrThrow(ctx, {
      actor,
      scope,
      kind: KIND_DM_CREATED,
      tags: [
        ["h", channelId],
        ...participants.map((p) => ["p", pubkeys.get(p) as string]),
      ],
      content: "",
    });

    for (const participant of participants) {
      if (participant === subject) continue;
      await publishMemberNotification(
        ctx,
        scope,
        channelId,
        pubkeys.get(participant) as string,
        pubkeys.get(subject) as string,
        true,
      );
    }

    return { channelId, created: true };
  },
});

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/**
 * Join an open room.
 *
 * A private room cannot be joined — it is joined by being *added* (§3.2, kind
 * 9021: "private ⇒ rejected at ingest") — and a non-member is told "not found"
 * rather than "private", because whether `#acquisition` exists is itself the
 * thing a private room is keeping. `requireChannelAccess` does both, which is
 * why the check is not written again here.
 */
export const join = mutation({
  args: { ...scopeArgs, channelId: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    return await joinChannelCore(ctx, scope, args.channelId, {
      actor: await userActor(ctx, subject),
      actorType: "user",
      actorId: subject,
    });
  },
});

/**
 * Joining, for anybody — a person through the mutation above, an agent through
 * its key-authenticated surface.
 *
 * The whole body used to be that mutation's handler and is unchanged apart from
 * the principal it reads from. That matters more here than almost anywhere
 * else: a join is four writes that must all happen or none (the 9021, the
 * membership row, the room's member count, and the two notifications), and a
 * second implementation for agents would be a second place for one of the four
 * to go missing.
 */
export async function joinChannelCore(
  ctx: MutationCtx,
  scope: Scope,
  channelId: string,
  principal: ChannelPrincipal,
): Promise<{ joined: boolean }> {
  const { channel, membership } = await resolveChannelForActor(
    ctx,
    scope,
    channelId,
    principal.actorId,
  );
  refuseOnDm(channel, "be joined; a direct message is opened, not joined");
  // Already in it. Not an error — a second click on Join means the same
  // thing the first one did.
  if (membership) return { joined: false };
  if (channel.visibility !== "open") {
    throw new ConvexError("This channel is private; somebody in it has to add you");
  }
  // Joining a room nobody is using produces a membership that means nothing
  // and a rail entry that confuses.
  if (channel.archivedAt !== undefined) throw new ConvexError("This channel is archived");

  const existing = await membershipRow(ctx, channel, principal.actorId);
  const role = defaultJoinRole(principal.actorType);

  const pubkey = await requirePubkey(
    ctx,
    principal.actorType,
    principal.actorId,
    principal.actor.name,
  );

  await publishOrThrow(ctx, {
    actor: principal.actor,
    scope,
    kind: KIND_NIP29_JOIN_REQUEST,
    tags: [
      ["h", channel.channelId],
      ["p", pubkey],
    ],
    content: "",
  });

  if (existing) {
    // Re-joining reverses the soft delete rather than inserting a second row,
    // so "was in this room, left, came back" stays one membership with one
    // history instead of two rows that disagree about when they joined.
    await ctx.db.patch(existing._id, {
      removedAt: undefined,
      removedByActorId: undefined,
      joinedAt: Date.now(),
      role,
    });
  } else {
    await ctx.db.insert("buzzMemberships", {
      ...scope,
      channelId: channel.channelId,
      actorId: principal.actorId,
      actorType: principal.actorType,
      role,
      joinedAt: Date.now(),
    });
  }
  await touch(ctx, channel, { memberCount: channel.memberCount + 1 });

  await publishSystemMessage(ctx, scope, channel.channelId, {
    type: "member_joined",
    actor: pubkey,
    target: pubkey,
  });
  await publishMemberNotification(ctx, scope, channel.channelId, pubkey, pubkey, true);
  return { joined: true };
}

/**
 * Leave a room — or, for a DM, hide it.
 *
 * A DM cannot be left because leaving would change its participant set, which
 * is its identity. Hiding is the honest equivalent and it is per-viewer: the
 * other participant sees nothing, which is the difference between closing a
 * conversation and ending one.
 */
export const leave = mutation({
  args: { ...scopeArgs, channelId: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    return await leaveChannelCore(ctx, scope, args.channelId, {
      actor: await userActor(ctx, subject),
      actorType: "user",
      actorId: subject,
    });
  },
});

/** Leaving, for anybody. The mutation above, minus where the principal came from. */
export async function leaveChannelCore(
  ctx: MutationCtx,
  scope: Scope,
  channelId: string,
  principal: ChannelPrincipal,
): Promise<{ left: boolean; hidden: boolean }> {
  const { channel, membership } = await resolveChannelForActor(
    ctx,
    scope,
    channelId,
    principal.actorId,
  );
  if (!membership) throw new ConvexError("You are not in this channel");

  if (channel.channelType === "dm") {
    await ctx.db.patch(membership._id, { hiddenAt: Date.now() });
    return { left: false, hidden: true };
  }

  // The last-owner guard applies to an agent exactly as it does to a person:
  // a room whose only owner walks out is a room nobody can govern, and it is
  // no less orphaned for having been abandoned by a machine.
  await assertNotLastOwner(ctx, channel, membership);

  const pubkey = await requirePubkey(
    ctx,
    principal.actorType,
    principal.actorId,
    principal.actor.name,
  );

  await publishOrThrow(ctx, {
    actor: principal.actor,
    scope,
    kind: KIND_NIP29_LEAVE_REQUEST,
    tags: [
      ["h", channel.channelId],
      ["p", pubkey],
    ],
    content: "",
  });

  await ctx.db.patch(membership._id, {
    removedAt: Date.now(),
    removedByActorId: principal.actorId,
  });
  await touch(ctx, channel, { memberCount: Math.max(0, channel.memberCount - 1) });

  await publishSystemMessage(ctx, scope, channel.channelId, {
    type: "member_left",
    actor: pubkey,
    target: pubkey,
  });
  await publishMemberNotification(ctx, scope, channel.channelId, pubkey, pubkey, false);
  return { left: true, hidden: false };
}

/**
 * The last-owner guard (§3.2).
 *
 * A room with members and no owner cannot be renamed, archived or moderated by
 * anyone in it — it is a room nobody can govern, and there is no repair path
 * that does not involve a workspace admin noticing. Refusing is a small
 * annoyance; the alternative is an orphaned room, permanently.
 */
async function assertNotLastOwner(
  ctx: MutationCtx,
  channel: ChannelRow,
  membership: MembershipRow,
): Promise<void> {
  if (membership.role !== "owner") return;
  const active = await ctx.db
    .query("buzzMemberships")
    .withIndex("by_channel", (q) =>
      q
        .eq("scopeType", channel.scopeType)
        .eq("scopeId", channel.scopeId)
        .eq("channelId", channel.channelId)
        .eq("removedAt", undefined),
    )
    .collect();
  const owners = active.filter((row) => row.role === "owner");
  if (owners.length > 1) return;
  // One owner is fine if they are the only person left: an empty room needs no
  // governor. It is only a problem when others would be left behind.
  if (active.length <= 1) return;
  throw new ConvexError("Make somebody else an owner first — this room would have none");
}

/**
 * Add people (or agents) to a room.
 *
 * Returns `{added, errors}` rather than throwing on the first failure, because
 * partial success is the normal outcome (§1.6): adding six people where one has
 * never opened Chat should add five and say so, not refuse the batch. Each
 * error names the principal so the UI can render it beside them.
 */
export const addMembers = mutation({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    members: v.array(
      v.object({
        actorId: v.string(),
        actorType: v.union(v.literal("user"), v.literal("agent")),
      }),
    ),
    // `owner` is absent by design (§1.6): ownership is granted by an owner
    // through `setRole`, never handed out in a bulk add.
    role: v.optional(
      v.union(v.literal("admin"), v.literal("member"), v.literal("guest"), v.literal("bot")),
    ),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel, membership } = await requireMembership(ctx, scope, args.channelId);
    refuseOnDm(channel, "have members added — that would be a different conversation");
    if (channel.archivedAt !== undefined) throw new ConvexError("This channel is archived");

    // An open room is Buzz's `channel_add_policy: anyone`; a private one is
    // owner/admin. The asymmetry is the point of the visibility axis: a private
    // room whose membership anyone could extend is not private.
    if (
      channel.visibility === "private" &&
      !(await mayGovernChannel(ctx, channel, subject, membership))
    ) {
      throw new ConvexError("Only this channel's owners and admins can add people to it");
    }

    const actor = await userActor(ctx, subject);
    const actorPubkey = await requirePubkey(ctx, "user", subject, actor.name);
    const role = args.role ?? "member";

    const added: string[] = [];
    const errors: { actorId: string; error: string }[] = [];
    let count = channel.memberCount;

    for (const target of args.members) {
      try {
        const existing = await membershipRow(ctx, channel, target.actorId);
        if (isActive(existing)) continue;
        const targetPubkey = await requirePubkey(
          ctx,
          target.actorType,
          target.actorId,
          target.actorId,
        );

        await publishOrThrow(ctx, {
          actor,
          scope,
          kind: KIND_NIP29_PUT_USER,
          tags: [
            ["h", channel.channelId],
            ["p", targetPubkey],
            ["role", role],
          ],
          content: "",
        });

        if (existing) {
          await ctx.db.patch(existing._id, {
            removedAt: undefined,
            removedByActorId: undefined,
            role,
            joinedAt: Date.now(),
            invitedByActorId: subject,
          });
        } else {
          await ctx.db.insert("buzzMemberships", {
            ...scope,
            channelId: channel.channelId,
            actorId: target.actorId,
            actorType: target.actorType,
            role,
            joinedAt: Date.now(),
            invitedByActorId: subject,
          });
        }
        count += 1;

        await publishSystemMessage(ctx, scope, channel.channelId, {
          type: "member_added",
          actor: actorPubkey,
          target: targetPubkey,
        });
        await publishMemberNotification(
          ctx,
          scope,
          channel.channelId,
          targetPubkey,
          actorPubkey,
          true,
        );
        added.push(target.actorId);
      } catch (error) {
        // Only the *expected* refusals are collected — a principal with no Chat
        // identity, mostly. A ConvexError is a refusal we wrote; anything else
        // is a bug and must not be flattened into a per-row message that hides
        // it.
        if (!(error instanceof ConvexError)) throw error;
        errors.push({ actorId: target.actorId, error: String(error.data) });
      }
    }

    if (added.length > 0) await touch(ctx, channel, { memberCount: count });
    return { added, errors };
  },
});

/**
 * Remove somebody from a room.
 *
 * Self-removal is allowed (it is `leave` by another name, and a UI that only
 * offers "remove" should still let you remove yourself); anything else is
 * governance. The last-owner guard applies either way.
 */
export const removeMember = mutation({
  args: { ...scopeArgs, channelId: v.string(), actorId: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel, membership } = await requireMembership(ctx, scope, args.channelId);
    refuseOnDm(channel, "have members removed — its participants are fixed");

    const target = await membershipRow(ctx, channel, args.actorId);
    if (!target || !isActive(target)) {
      throw new ConvexError("That person is not in this channel");
    }

    if (
      args.actorId !== subject &&
      !(await mayGovernChannel(ctx, channel, subject, membership))
    ) {
      throw new ConvexError("Only this channel's owners and admins can remove people");
    }
    await assertNotLastOwner(ctx, channel, target);

    const actor = await userActor(ctx, subject);
    const actorPubkey = await requirePubkey(ctx, "user", subject, actor.name);
    const targetPubkey = await requirePubkey(
      ctx,
      target.actorType,
      target.actorId,
      target.actorId,
    );

    await publishOrThrow(ctx, {
      actor,
      scope,
      kind: KIND_NIP29_REMOVE_USER,
      tags: [
        ["h", channel.channelId],
        ["p", targetPubkey],
      ],
      content: "",
    });

    await ctx.db.patch(target._id, { removedAt: Date.now(), removedByActorId: subject });
    await touch(ctx, channel, { memberCount: Math.max(0, channel.memberCount - 1) });

    await publishSystemMessage(ctx, scope, channel.channelId, {
      type: "member_removed",
      actor: actorPubkey,
      target: targetPubkey,
    });
    await publishMemberNotification(
      ctx,
      scope,
      channel.channelId,
      targetPubkey,
      actorPubkey,
      false,
    );
    return { removed: true };
  },
});

/**
 * Change somebody's role in the room.
 *
 * Governance-checked, and granting `owner` is narrower still: an admin may
 * promote to admin, but only an owner (or the community's governor) may make
 * another owner, because ownership is the role that can remove the person
 * granting it.
 */
export const setRole = mutation({
  args: { ...scopeArgs, channelId: v.string(), actorId: v.string(), role: roleValidator },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel, membership } = await requireMembership(ctx, scope, args.channelId);
    refuseOnDm(channel, "have roles — everybody in a direct message is a participant");

    if (!(await mayGovernChannel(ctx, channel, subject, membership))) {
      throw new ConvexError("Only this channel's owners and admins can change roles");
    }
    if (args.role === "owner" && membership.role !== "owner") {
      if (!(await mayGovernCommunity(ctx, scope, subject))) {
        throw new ConvexError("Only an owner can make another owner");
      }
    }

    const target = await membershipRow(ctx, channel, args.actorId);
    if (!target || !isActive(target)) {
      throw new ConvexError("That person is not in this channel");
    }
    if (target.role === args.role) return { changed: false };
    // Demoting the last owner orphans the room exactly as removing them would.
    if (target.role === "owner") await assertNotLastOwner(ctx, channel, target);

    const actor = await userActor(ctx, subject);
    const actorPubkey = await requirePubkey(ctx, "user", subject, actor.name);
    const targetPubkey = await requirePubkey(
      ctx,
      target.actorType,
      target.actorId,
      target.actorId,
    );

    // 9000 again, with the new role: Buzz's put-user is an upsert, so "add" and
    // "change role" are the same event rather than two that could disagree.
    await publishOrThrow(ctx, {
      actor,
      scope,
      kind: KIND_NIP29_PUT_USER,
      tags: [
        ["h", channel.channelId],
        ["p", targetPubkey],
        ["role", args.role],
      ],
      content: "",
    });

    await ctx.db.patch(target._id, { role: args.role });
    await touch(ctx, channel);
    await publishSystemMessage(ctx, scope, channel.channelId, {
      type: "role_changed",
      actor: actorPubkey,
      target: targetPubkey,
      value: args.role,
    });
    return { changed: true };
  },
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/**
 * The edit dialog's fields (§1.5 B): name, description, visibility, TTL.
 *
 * One mutation because it is one form and one 9002 — writing four events for a
 * single Save would put four rows in the room's timeline for one act. Topic and
 * purpose are deliberately *not* here: they have a different permission (any
 * member) and a different meaning, and folding them in would quietly grant
 * everyone the ability to rename the room.
 */
export const update = mutation({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    visibility: v.optional(v.union(v.literal("open"), v.literal("private"))),
    /** Null clears the TTL, i.e. makes the room permanent. */
    ttlSeconds: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel, membership } = await requireMembership(ctx, scope, args.channelId);
    refuseOnDm(channel, "be renamed or re-configured");
    if (!(await mayGovernChannel(ctx, channel, subject, membership))) {
      throw new ConvexError("Only this channel's owners and admins can edit it");
    }

    const actor = await userActor(ctx, subject);
    const actorPubkey = await requirePubkey(ctx, "user", subject, actor.name);

    const tags: string[][] = [["h", channel.channelId]];
    const patch: Partial<ChannelRow> = {};
    const announcements: { type: SystemMessageType; value?: string }[] = [];

    if (args.name !== undefined) {
      const displayName = canonicalChannelName(args.name);
      const slug = channelSlug(args.name);
      if (slug.length === 0) throw new ConvexError("A channel needs a name");
      if (slug !== channel.name) {
        const clash = await ctx.db
          .query("buzzChannels")
          .withIndex("by_scope_name", (q) =>
            q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("name", slug),
          )
          .first();
        if (clash) throw new ConvexError(`#${slug} already exists in this community`);
      }
      tags.push(["name", displayName]);
      patch.name = slug;
      patch.displayName = displayName;
      announcements.push({ type: "name_changed", value: displayName });
    }

    if (args.description !== undefined && args.description !== channel.description) {
      tags.push(["about", args.description]);
      patch.description = args.description;
      announcements.push({ type: "description_changed" });
    }

    if (args.visibility !== undefined && args.visibility !== channel.visibility) {
      tags.push(["visibility", args.visibility]);
      patch.visibility = args.visibility;
      announcements.push({ type: "visibility_changed", value: args.visibility });
    }

    if (args.ttlSeconds !== undefined) {
      const next =
        args.ttlSeconds === null || args.ttlSeconds <= 0 ? undefined : Math.floor(args.ttlSeconds);
      if (next !== channel.ttlSeconds) {
        // An empty `ttl` value clears it, which is the shape §3.2 documents —
        // absent would have meant "unchanged", and the two must not look alike.
        tags.push(["ttl", next === undefined ? "" : String(next)]);
        patch.ttlSeconds = next;
        announcements.push({ type: "ttl_changed", value: formatTtlDuration(next ?? 0) });
      }
    }

    if (tags.length === 1) return { changed: false };

    await publishOrThrow(ctx, {
      actor,
      scope,
      kind: KIND_NIP29_EDIT_METADATA,
      tags,
      content: "",
    });
    await touch(ctx, channel, patch);
    for (const announcement of announcements) {
      await publishSystemMessage(ctx, scope, channel.channelId, {
        type: announcement.type,
        actor: actorPubkey,
        ...(announcement.value !== undefined ? { value: announcement.value } : {}),
      });
    }
    return { changed: true };
  },
});

/**
 * Topic and purpose — "what we're on right now" and the room's charter.
 *
 * Any member may set either (§3.2), which is why they are not in `update`.
 * They are separate fields rather than one because the header resolver shows
 * the *first* non-blank of topic, description, purpose: collapsing them would
 * make a room that is between things unable to say so without erasing what it
 * is for.
 */
export const setTopic = mutation({
  args: { ...scopeArgs, channelId: v.string(), topic: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    return await setNarrative(ctx, scope, args.channelId, "topic", args.topic);
  },
});

export const setPurpose = mutation({
  args: { ...scopeArgs, channelId: v.string(), purpose: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    return await setNarrative(ctx, scope, args.channelId, "purpose", args.purpose);
  },
});

async function setNarrative(
  ctx: MutationCtx,
  scope: Scope,
  channelId: string,
  field: "topic" | "purpose",
  raw: string,
): Promise<{ changed: boolean }> {
  const { subject, channel } = await requireMembership(ctx, scope, channelId);
  refuseOnDm(channel, "have a topic; a direct message is titled by who is in it");

  const value = raw.trim();
  if ((channel[field] ?? "") === value) return { changed: false };

  const actor = await userActor(ctx, subject);
  const actorPubkey = await requirePubkey(ctx, "user", subject, actor.name);

  await publishOrThrow(ctx, {
    actor,
    scope,
    kind: KIND_NIP29_EDIT_METADATA,
    tags: [
      ["h", channel.channelId],
      [field, value],
    ],
    content: "",
  });

  const now = Date.now();
  await touch(
    ctx,
    channel,
    field === "topic"
      ? { topic: value, topicSetByActorId: subject, topicSetAt: now }
      : { purpose: value, purposeSetByActorId: subject, purposeSetAt: now },
  );
  await publishSystemMessage(ctx, scope, channel.channelId, {
    type: field === "topic" ? "topic_changed" : "purpose_changed",
    actor: actorPubkey,
    value,
  });
  return { changed: true };
}

/**
 * Archive or unarchive.
 *
 * Reversible, and it is the reason there is no delete here: an archived room
 * keeps its history and stays reachable by the people who were in it, which is
 * what "we are done with this" actually means most of the time.
 */
export const setArchived = mutation({
  args: { ...scopeArgs, channelId: v.string(), archived: v.boolean() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel, membership } = await requireMembership(ctx, scope, args.channelId);
    refuseOnDm(channel, "be archived");
    if (!(await mayGovernChannel(ctx, channel, subject, membership))) {
      throw new ConvexError("Only this channel's owners and admins can archive it");
    }
    if ((channel.archivedAt !== undefined) === args.archived) return { changed: false };

    const actor = await userActor(ctx, subject);
    const actorPubkey = await requirePubkey(ctx, "user", subject, actor.name);

    await publishOrThrow(ctx, {
      actor,
      scope,
      kind: KIND_NIP29_EDIT_METADATA,
      tags: [
        ["h", channel.channelId],
        ["archived", args.archived ? "true" : "false"],
      ],
      content: "",
    });

    await touch(ctx, channel, { archivedAt: args.archived ? Date.now() : undefined });
    await publishSystemMessage(ctx, scope, channel.channelId, {
      type: args.archived ? "archived" : "unarchived",
      actor: actorPubkey,
    });
    return { changed: true };
  },
});
