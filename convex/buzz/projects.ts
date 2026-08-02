// Projects, and the branch rooms that hang off them.
//
// **A branch is a room, and the room is the record of why the code exists.**
// That is 03-workflows-projects §2.3's product intent, and building it is the
// whole of this file. A patch is a signed event in a channel. A check result is
// a signed event in the same channel. A review decision and the merge are two
// more. They sit in the log beside the conversation that produced them, so
// "search the conversation, the patch, the workflow run and the approval in one
// place" is true by construction rather than by a join somebody has to remember.
//
// **There is no second store, and there are no new tables.** The precedent is
// `forum.ts`, which put a titled, listed, threaded object on the message log
// with nothing but a `subject` tag and a kind: a forum post is a message with a
// different kind, and a patch is an event with a different kind. If this file
// ever grows a `patches` table, the design has failed — a git artefact filed
// outside the log is a git artefact that cannot be searched with the argument
// about it, which was the entire reason to do it this way.
//
// What is honestly missing, stated here rather than implied by silence:
//
//   - **There is no git hosting.** No Smart HTTP transport, no pre-receive hook,
//     no push policy, no manifest, no `mergeProjectPullRequest`. §2.4 describes
//     all of it and none of it exists here. So this file builds the *room* side:
//     the vocabulary, the binding, the panels, and an explicit door for the
//     things a real forge would report.
//   - **The ingestion path is that door**, and it is deliberate rather than a
//     stub: `report` is key-authenticated, so the principal that posts a patch
//     or a CI result is an agent with its own signing key, its own governance
//     and its own budget — the same principal model everything else in Chat
//     uses. A CI runner reaches it either directly with an agent key, or through
//     the workflow engine's `call_webhook` / `POST /hooks/{id}` door that
//     `workflows.ts` already serves. Nothing here fakes a repository.
//   - **Issues (1621) are named and not built.** See `KIND_GIT_ISSUE` in
//     `src/lib/buzz/project.ts` for why.
//
// The vocabulary — which kind means what, which tag carries which fact, and how
// a window of events folds into a branch — lives in `src/lib/buzz/project.ts`,
// pure, so the server and the client read a room the same way and the tests can
// read it without a database.

import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Actor } from "../_agentAuth";
import { agentActor, requireAgentByKey } from "../_agentAuth";
import { requireScopeAccess } from "../_authz";
// Reused, never re-rolled. `requireChannelAccess` is the tenancy fence plus the
// room's own visibility rule; `mayGovernCommunity` is the app's one answer to
// "may this person change something everybody sees"; `requireNotRestricted` is
// the one seam a ban bites at. A second copy of any of them is a second answer.
import {
  mayGovernCommunity,
  requireChannelAccess,
  resolveChannelForActor,
  type ChannelPrincipal,
} from "./channels";
import { requireNotRestricted } from "./moderation";
import { describePubkey, pubkeyFor } from "./identity";
import {
  eventVisibleToReader,
  publishCore,
  readEventsCore,
  toNostrEvent,
  type EventRow,
  type Scope,
} from "./log";
import type { NostrEvent } from "./_nostr";
import {
  ADDRESS_TAG,
  BRANCH_TAG,
  COMMIT_TAG,
  D_TAG,
  KIND_GIT_PATCH,
  KIND_GIT_PR_UPDATE,
  KIND_GIT_PULL_REQUEST,
  KIND_GIT_REPO_ANNOUNCEMENT,
  KIND_GIT_REPO_STATE,
  KIND_PROJECT,
  MERGE_COMMIT_TAG,
  ROOM_FORGE_KINDS,
  STATUS_SUBJECT_TAG,
  SUBJECT_TAG,
  TARGET_BRANCH_TAG,
  asCommitOid,
  buildBranchRoom,
  classifyForgeEvent,
  normalizeBranchName,
  parseRepoAddress,
  projectFromEvent,
  projectSlug,
  projectTags,
  repoAddress,
  statusKindFor,
  type Project,
  type StatusOutcome,
  type StatusSubject,
} from "../../src/lib/buzz/project";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** How many announcements one community's project list will read. */
const MAX_PROJECTS = 100;
/** How many branch rooms one project's detail will resolve. */
const MAX_BRANCH_ROOMS = 50;
/**
 * How many forge events one room hands back.
 *
 * A cap rather than a `.collect()`, and it is the same reasoning `messages.ts`
 * gives for `AUX_PER_TARGET`: a branch that a CI system reports on every commit
 * for a year is an unbounded fan-in, and a panel must not be able to load all of
 * it because one branch stayed open. Newest first, so what is dropped is the
 * oldest — which is the half a reader is least likely to be asking about.
 */
const FORGE_PER_ROOM = 120;
/** A patch body is a diff, and a diff that will not fit on a screen is a file. */
const MAX_PATCH_BYTES = 128 * 1024;
/** A title is a line. */
const MAX_TITLE_CHARS = 200;
/** A review note is a paragraph; the argument itself belongs in the room. */
const MAX_NOTE_CHARS = 2000;

const scopeArgs = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

type ChannelRow = Doc<"buzzChannels">;

// ---------------------------------------------------------------------------
// The wire shapes
// ---------------------------------------------------------------------------

/** A resolved principal, in the shape the client projectors already speak. */
export type ProjectActor = { pubkey: string; label: string; isAgent: boolean };

/** One branch room, as raw events plus the room facts a client cannot derive. */
export type BranchRoomWire = {
  channelId: string;
  name: string;
  displayName: string;
  visibility: "public" | "private";
  /** Whether the reader is in it — a branch room's list doubles as a way in. */
  joined: boolean;
  archivedAt?: number;
  memberCount: number;
  lastActivityAt: number;
  /**
   * The room's forge events, newest first, raw.
   *
   * Raw for the reason `messages.ts` states at length: the fold from "these
   * events" to "what a person reads" is a pure function over an array
   * (`buildBranchRoom`), and a server that folded could not be tested without a
   * database and could not answer an optimistic row. One fold, on the client,
   * shared by the branch panel and the project detail.
   */
  events: NostrEvent[];
};

export type ProjectListPage = {
  projects: {
    project: Project;
    /** Branch rooms **this reader may see**. See `branchRoomsFor`. */
    branchRooms: number;
    lastActivityAt: number;
  }[];
  /** NIP-MP groupings (30621). A grouping confers no authority — see `group`. */
  groups: {
    slug: string;
    name: string;
    by: string;
    memberAddresses: string[];
  }[];
  actors: ProjectActor[];
};

export type ProjectDetail = {
  project: Project;
  /** The newest 30618, if anybody has published ref state. Usually nobody has. */
  refState: NostrEvent | null;
  rooms: BranchRoomWire[];
  actors: ProjectActor[];
  /** What *you* may do here, so the UI never offers a button that refuses. */
  canGovern: boolean;
};

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

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

/**
 * The writer's own pubkey, or a refusal naming the bootstrap that mints it.
 *
 * Needed before publishing because a forge event carries the author in its tags
 * as well as in its signature. `publishCore` would refuse a moment later for the
 * same reason; this is that refusal, arriving early enough to build the tags.
 */
async function requireOwnPubkey(
  ctx: MutationCtx,
  principal: ChannelPrincipal,
): Promise<string> {
  const pubkey = await pubkeyFor(ctx, principal.actorType, principal.actorId);
  if (!pubkey) {
    throw new ConvexError(
      `${principal.actor.name} has no Chat signing key yet; keys are minted by the buzz.keys.mint action when Chat is opened.`,
    );
  }
  return pubkey;
}

/**
 * Publish, and refuse to continue on an outcome that wrote nothing.
 *
 * The same three-way reading `messages.ts` and `channels.ts` both make, for the
 * same reason: `duplicate` is the identical signed event already in the log,
 * which is what makes a retried post idempotent; `dominated` and `ephemeral`
 * wrote no row at all, and a caller that went on to report success would be
 * reporting on an event that does not exist.
 */
async function publishOrThrow(
  ctx: MutationCtx,
  args: Parameters<typeof publishCore>[1],
): Promise<{ eventId: string; createdAt: number; fresh: boolean }> {
  const outcome = await publishCore(ctx, args);
  if (outcome.status === "dominated" || outcome.status === "ephemeral") {
    throw new ConvexError(
      `The channel log refused this event (${outcome.status}); nothing was written.`,
    );
  }
  return {
    eventId: outcome.event.id,
    createdAt: outcome.event.created_at,
    fresh: outcome.status === "inserted",
  };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Resolve pubkeys to labels, once each.
 *
 * Server-side for the reason `forum.ts` gives about cards: a chat row sits in a
 * run of rows and reads fine while a profile resolves, but "merged by
 * a1b2c3d4…9f0e" is a sentence about a decision nobody can attribute. A merge is
 * the most attribution-sensitive row this product draws.
 */
async function resolveActors(
  ctx: QueryCtx,
  pubkeys: Iterable<string>,
): Promise<ProjectActor[]> {
  const out: ProjectActor[] = [];
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

function pubkeysIn(events: readonly NostrEvent[]): Set<string> {
  const found = new Set<string>();
  for (const event of events) {
    found.add(event.pubkey);
    for (const tag of event.tags) if (tag[0] === "p" && tag[1]) found.add(tag[1]);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Reading projects
// ---------------------------------------------------------------------------

/**
 * The community's announcements, newest first.
 *
 * Through `readEventsCore` rather than a hand-rolled index range, because that
 * function *is* the read path — the gates, the channel boundary, the
 * superseded/deleted filters and the replaceable-coordinate rules all live in
 * it. A second reader for one kind is a second place for a rule to go missing.
 */
async function announcements(
  ctx: QueryCtx,
  scope: Scope,
  readerPubkey: string,
): Promise<Project[]> {
  const events = await readEventsCore(ctx, {
    scope,
    filters: [{ kinds: [KIND_GIT_REPO_ANNOUNCEMENT], limit: MAX_PROJECTS }],
    readerPubkey,
  });
  const out: Project[] = [];
  for (const event of events) {
    const project = projectFromEvent(event);
    // A malformed announcement is dropped rather than drawn as a broken card —
    // but only when it cannot be attributed at all. Everything else falls back
    // (`projectFromEvent`), because a project that vanishes is worse than one
    // that renders plainly.
    if (project) out.push(project);
  }
  return out;
}

async function projectByAddress(
  ctx: QueryCtx,
  scope: Scope,
  readerPubkey: string,
  address: string,
): Promise<Project | null> {
  const parsed = parseRepoAddress(address);
  if (!parsed) return null;
  const events = await readEventsCore(ctx, {
    scope,
    filters: [
      {
        kinds: [KIND_GIT_REPO_ANNOUNCEMENT],
        authors: [parsed.owner],
        tags: [{ name: D_TAG, values: [parsed.dtag] }],
        limit: 1,
      },
    ],
    readerPubkey,
  });
  return events[0] ? projectFromEvent(events[0]) : null;
}

/**
 * The rooms bound to a repository, filtered to the ones this reader may enter.
 *
 * One index range over `(a = repoAddress, kind 1618)`, whose rows carry the
 * channel the binding was published in — so "which rooms are branches of this
 * repo" is answered without loading a single event, and the tenancy fence is in
 * the shape of the index rather than in a `.filter()` afterwards.
 *
 * The visibility check is `resolveChannelForActor`, caught. That function was
 * written for a single lookup and answers a refusal by throwing, which is right
 * there and awkward here; catching it is deliberately preferred to re-rolling
 * "archived rooms are members-only, private rooms are members-only" as a second
 * predicate. A room the reader may not see is simply not in the list, and the
 * count they are shown is the count of what they can reach — a number computed
 * over every room would leak a private branch's existence through arithmetic.
 */
async function branchRoomsFor(
  ctx: QueryCtx,
  scope: Scope,
  address: string,
  actorId: string,
): Promise<{ channel: ChannelRow; joined: boolean }[]> {
  const tagRows = await ctx.db
    .query("buzzEventTags")
    .withIndex("by_tag_kind", (q) =>
      q
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("name", ADDRESS_TAG)
        .eq("value", address)
        .eq("kind", KIND_GIT_PULL_REQUEST),
    )
    .order("desc")
    .take(MAX_BRANCH_ROOMS * 2);

  const seen = new Set<string>();
  const rooms: { channel: ChannelRow; joined: boolean }[] = [];
  for (const tagRow of tagRows) {
    const channelId = tagRow.channelId;
    if (!channelId || seen.has(channelId)) continue;
    seen.add(channelId);
    if (rooms.length >= MAX_BRANCH_ROOMS) break;
    try {
      const resolved = await resolveChannelForActor(ctx, scope, channelId, actorId);
      rooms.push({ channel: resolved.channel, joined: resolved.membership !== null });
    } catch {
      // Not visible to this reader, or gone. Both are "not in your list".
    }
  }
  return rooms;
}

/**
 * A room's forge events, newest first, capped.
 *
 * One index range per kind on `by_scope_channel_kind` rather than one range over
 * the whole room, because a busy branch room is mostly conversation: reading the
 * timeline and filtering would load a thousand messages to find nine patches.
 *
 * `eventVisibleToReader` runs on every row even though every forge kind is
 * `open` today — the point of having one per-event gate (§16.12) is that it
 * keeps being true when a gated kind starts appearing in a room.
 */
async function forgeRowsForRoom(
  ctx: QueryCtx,
  scope: Scope,
  channel: ChannelRow,
  readerPubkey: string,
): Promise<EventRow[]> {
  const rows: EventRow[] = [];
  for (const kind of ROOM_FORGE_KINDS) {
    const page = await ctx.db
      .query("buzzEvents")
      .withIndex("by_scope_channel_kind", (q) =>
        q
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId)
          .eq("channelId", channel.channelId)
          .eq("kind", kind)
          .eq("supersededAt", undefined),
      )
      .order("desc")
      .take(FORGE_PER_ROOM);
    for (const row of page) {
      if (row.deletedAt !== undefined) continue;
      if (!eventVisibleToReader(row, readerPubkey)) continue;
      rows.push(row);
    }
  }
  return rows
    .sort((a, b) => b.createdAt - a.createdAt || a.eventId.localeCompare(b.eventId))
    .slice(0, FORGE_PER_ROOM);
}

function toRoomWire(
  channel: ChannelRow,
  joined: boolean,
  rows: readonly EventRow[],
): BranchRoomWire {
  return {
    channelId: channel.channelId,
    name: channel.name,
    displayName: channel.displayName,
    visibility: channel.visibility === "open" ? "public" : "private",
    joined,
    ...(channel.archivedAt !== undefined ? { archivedAt: channel.archivedAt } : {}),
    memberCount: channel.memberCount,
    lastActivityAt: channel.lastActivityAt,
    events: rows.map(toNostrEvent),
  };
}

/**
 * Every project in this community, with the branch-room count each reader is
 * entitled to see.
 *
 * Deliberately no per-room fold here: the list answers "what exists and where is
 * it moving", and folding twenty rooms per project to draw a number would be a
 * page read per room on a screen nobody is reading rooms on.
 */
export const list = query({
  args: { ...scopeArgs },
  handler: async (ctx, args): Promise<ProjectListPage> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const readerPubkey = (await pubkeyFor(ctx, "user", subject)) ?? "";

    const projects = await announcements(ctx, scope, readerPubkey);
    const wanted = new Set<string>();
    const rows: ProjectListPage["projects"] = [];
    for (const project of projects) {
      const rooms = await branchRoomsFor(ctx, scope, project.repoAddress, subject);
      // `createdAt` is the event's NIP-01 timestamp — seconds — and a room's
      // clock is this app's milliseconds. Converted here rather than compared
      // raw, which would sort every project below every room forever.
      let lastActivityAt = project.createdAt * 1000;
      for (const { channel } of rooms) {
        if (channel.lastActivityAt > lastActivityAt) lastActivityAt = channel.lastActivityAt;
      }
      for (const maintainer of project.maintainers) wanted.add(maintainer);
      rows.push({ project, branchRooms: rooms.length, lastActivityAt });
    }

    const groupEvents = await readEventsCore(ctx, {
      scope,
      filters: [{ kinds: [KIND_PROJECT], limit: MAX_PROJECTS }],
      readerPubkey,
    });
    const groups = groupEvents.map((event) => {
      wanted.add(event.pubkey);
      return {
        slug: event.tags.find((t) => t[0] === D_TAG)?.[1] ?? event.id,
        name: event.tags.find((t) => t[0] === "name")?.[1] ?? "",
        by: event.pubkey,
        memberAddresses: event.tags
          .filter((t) => t[0] === ADDRESS_TAG && t[1])
          .map((t) => t[1])
          // A grouping that names a coordinate of another kind names nothing.
          .filter((address) => parseRepoAddress(address) !== null),
      };
    });

    return {
      projects: rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt),
      groups,
      actors: await resolveActors(ctx, wanted),
    };
  },
});

/**
 * One project: its announcement, its ref state, and every branch room in it that
 * this reader may enter, with those rooms' forge events.
 */
export const get = query({
  args: { ...scopeArgs, projectId: v.string() },
  handler: async (ctx, args): Promise<ProjectDetail | null> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const readerPubkey = (await pubkeyFor(ctx, "user", subject)) ?? "";

    // The canonical route id is `<owner-hex>:<dtag>`; the address is what every
    // other event joins on. One conversion, here.
    const separator = args.projectId.indexOf(":");
    if (separator <= 0) return null;
    const address = repoAddress(
      args.projectId.slice(0, separator),
      args.projectId.slice(separator + 1),
    );
    const project = await projectByAddress(ctx, scope, readerPubkey, address);
    if (!project) return null;

    const stateEvents = await readEventsCore(ctx, {
      scope,
      filters: [
        {
          kinds: [KIND_GIT_REPO_STATE],
          // Only the owner may assert ref state (§2.5 `fetchRepoState` restricts
          // authors to the owner and the relay). A 30618 signed by anybody else
          // is a claim about somebody's repository that they did not make.
          authors: [project.owner],
          tags: [{ name: D_TAG, values: [project.dtag] }],
          limit: 1,
        },
      ],
      readerPubkey,
    });

    const channels = await branchRoomsFor(ctx, scope, address, subject);
    const rooms: BranchRoomWire[] = [];
    const wanted = new Set<string>(project.maintainers);
    for (const { channel, joined } of channels) {
      const rows = await forgeRowsForRoom(ctx, scope, channel, readerPubkey);
      const wire = toRoomWire(channel, joined, rows);
      for (const pubkey of pubkeysIn(wire.events)) wanted.add(pubkey);
      rooms.push(wire);
    }

    return {
      project,
      refState: stateEvents[0] ?? null,
      rooms: rooms.sort((a, b) => b.lastActivityAt - a.lastActivityAt),
      actors: await resolveActors(ctx, wanted),
      canGovern: await mayGovernProject(ctx, scope, subject, readerPubkey, project),
    };
  },
});

/**
 * One room's forge events — what the branch panel subscribes to.
 *
 * `requireChannelAccess` first, and that is the whole visibility story: the
 * room's rule is the events' rule, because the events are *in* the room. A
 * community member who is not in a private branch room gets the same "Channel
 * not found" they get for its messages, and for the same reason — whether a
 * branch called `acquisition-spike` exists is itself the information.
 */
export const roomForge = query({
  args: { ...scopeArgs, channelId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ events: NostrEvent[]; actors: ProjectActor[]; project: Project | null }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel } = await requireChannelAccess(ctx, scope, args.channelId);
    const readerPubkey = (await pubkeyFor(ctx, "user", subject)) ?? "";

    const rows = await forgeRowsForRoom(ctx, scope, channel, readerPubkey);
    const events = rows.map(toNostrEvent);

    // The project the binding names, so the panel can say which repository this
    // branch is of without a second round trip.
    let project: Project | null = null;
    for (const event of events) {
      const item = classifyForgeEvent(event);
      if (item?.type !== "binding") continue;
      project = await projectByAddress(ctx, scope, readerPubkey, item.repoAddress);
      if (project) break;
    }

    return {
      events,
      actors: await resolveActors(ctx, pubkeysIn(events)),
      project,
    };
  },
});

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

/**
 * May this person speak for the repository?
 *
 * Three answers, in order of specificity, and the first one is the one that
 * matters: the **announcement's own owner and maintainers**. §2.1 says the
 * grouping event's signer "gains no authority over any member — push policy
 * always reads the repository's own announcement", so authority is read from the
 * 30617 and from nowhere else. A 30621 naming your repo is a bookmark somebody
 * else made.
 *
 * The community governor is kept as a fallback for the same reason
 * `mayGovernChannel` keeps it: a workspace owner must not be locked out of
 * something inside their own workspace.
 */
async function mayGovernProject(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  subject: string,
  readerPubkey: string,
  project: Project,
): Promise<boolean> {
  if (readerPubkey && project.maintainers.includes(readerPubkey)) return true;
  return await mayGovernCommunity(ctx, scope, subject);
}

/**
 * Membership, and a room that still accepts writes.
 *
 * The same two clauses `messages.requireWritable` applies, restated because that
 * file does not export it — and restated rather than loosened: an archived
 * branch room is the *point* of archiving on merge (§2.3, "on merge the channel
 * archives, becoming the permanent record of why the code exists"), so a room
 * that stopped accepting patches is the feature working.
 */
function requireWritableRoom(
  channel: ChannelRow,
  membership: Doc<"buzzMemberships"> | null,
): Doc<"buzzMemberships"> {
  if (!membership) {
    throw new ConvexError(
      channel.visibility === "open"
        ? "Join this channel before posting in it"
        : "You are not in this channel",
    );
  }
  if (channel.archivedAt !== undefined) throw new ConvexError("This channel is archived");
  return membership;
}

// ---------------------------------------------------------------------------
// The forge write core
// ---------------------------------------------------------------------------

/**
 * What can be recorded in a branch room.
 *
 * A closed union rather than "publish this kind with these tags", for the reason
 * `_kinds.ts` gives about the registry itself: agents write here. A general door
 * would let an API key publish a `state`/`merged` status wearing a check
 * result's clothes, or a binding pointing at somebody else's repository. Every
 * member of this union is a statement whose grammar is checked below.
 */
export type ForgeInput =
  | { type: "patch"; title: string; body: string; commit?: string }
  | { type: "check"; outcome: "passed" | "failed" | "running"; note?: string; commit?: string }
  | { type: "review"; outcome: "approved" | "changes_requested"; note?: string; commit?: string }
  | { type: "state"; outcome: "open" | "draft" | "closed"; note?: string }
  | { type: "merge"; mergeCommit?: string; note?: string };

function clamp(value: string, max: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, max);
}

/**
 * Record something in a branch room. **The one write path.**
 *
 * A person clicking Approve and a CI runner reporting a failed build reach this
 * function with different `principal`s and nothing else different — the Actor
 * pattern (CLAUDE.md), and here it buys something specific: the room's
 * membership rule, the moderation ban, the binding lookup, the self-review
 * refusal and the merge authority check are each written once. A forked agent
 * path that got four of the five right would let a key post a merge decision
 * into a room it was banned from.
 *
 * Two rules are decided here and nowhere else:
 *
 *   - **Only a machine may assert a check result.** A person typing "checks
 *     passed" produces a row that renders identically to one a build produced,
 *     and the room's whole value is that its record is the record. An agent's
 *     events are signed by the agent's own key, so a check result is
 *     attributable to the runner that made it, forever.
 *   - **Nobody reviews their own branch** (§2.7's `canReviewProjectPullRequest`,
 *     "viewer ≠ PR author"). Not a courtesy: an approval count that an author
 *     can raise alone is not a signal, and `mergeReadiness` reads it.
 */
export async function recordForgeCore(
  ctx: MutationCtx,
  scope: Scope,
  channelId: string,
  principal: ChannelPrincipal,
  input: ForgeInput,
): Promise<{ eventId: string; createdAt: number }> {
  const { channel, membership } = await resolveChannelForActor(
    ctx,
    scope,
    channelId,
    principal.actorId,
  );
  const active = requireWritableRoom(channel, membership);

  const authorPubkey = await requireOwnPubkey(ctx, principal);
  // The one seam a community restriction bites at, exactly as `postMessageCore`
  // uses it: a member who has been banned must not be able to keep writing into
  // the record by using a different verb.
  await requireNotRestricted(ctx, scope, authorPubkey);

  const readerPubkey = authorPubkey;
  const rows = await forgeRowsForRoom(ctx, scope, channel, readerPubkey);
  const room = buildBranchRoom(channel.channelId, rows.map(toNostrEvent));
  if (!room.binding) {
    throw new ConvexError(
      "This room is not bound to a branch yet; bind it to a repository first.",
    );
  }
  const binding = room.binding;

  if (input.type === "check" && principal.actorType !== "agent") {
    throw new ConvexError(
      "A check result is reported by the runner that produced it; post it with an agent key.",
    );
  }
  if (input.type === "review" && authorPubkey === binding.by) {
    throw new ConvexError("You cannot review your own branch");
  }
  if (input.type === "merge") {
    const project = await projectByAddress(ctx, scope, readerPubkey, binding.repoAddress);
    // A merge is the decision the whole room exists to reach, so it is the one
    // statement that takes authority over the repository — or over the room. A
    // room owner/admin counts because a branch room's owners are the people
    // running that piece of work; a project maintainer counts because it is
    // their repository.
    const governs =
      active.role === "owner" ||
      active.role === "admin" ||
      (project !== null &&
        (await mayGovernProject(ctx, scope, principal.actorId, authorPubkey, project)));
    if (!governs) {
      throw new ConvexError(
        "Only this room's owners and admins, or the repository's maintainers, can record a merge",
      );
    }
  }

  const tags: string[][] = [
    ["h", channel.channelId],
    [ADDRESS_TAG, binding.repoAddress],
  ];
  let kind: number;
  let content: string;

  if (input.type === "patch") {
    const body = input.body;
    if (body.trim().length === 0) throw new ConvexError("A patch needs a diff in it");
    if (new TextEncoder().encode(body).length > MAX_PATCH_BYTES) {
      throw new ConvexError("That patch is too large to post; link to it instead");
    }
    kind = KIND_GIT_PATCH;
    content = body;
    const title = clamp(input.title, MAX_TITLE_CHARS);
    if (title) tags.push([SUBJECT_TAG, title]);
    const commit = asCommitOid(input.commit);
    if (commit) tags.push([COMMIT_TAG, commit]);
  } else {
    const subject: StatusSubject =
      input.type === "check" ? "ci" : input.type === "review" ? "review" : "state";
    const outcome: StatusOutcome = input.type === "merge" ? "merged" : input.outcome;
    // `ForgeInput` already rules out a meaningless pair (there is no "merged"
    // build, no "provisional" review), so this can only be null if the union and
    // `STATUS_OUTCOMES` ever disagree — and the honest response to that is a
    // refusal naming both, not a `NaN` kind refused by the log as "not an
    // integer" three layers away from the mistake.
    const statusKind = statusKindFor(subject, outcome);
    if (statusKind === null) {
      throw new ConvexError(`invalid: ${outcome} is not a ${subject} outcome`);
    }
    kind = statusKind;
    content = clamp(input.note ?? "", MAX_NOTE_CHARS);
    tags.push([STATUS_SUBJECT_TAG, subject]);
    // Every status names what it judges: the binding. A status with no root is a
    // verdict with no subject, and a reader cannot tell whose branch it is about.
    tags.push(["e", binding.id]);
    if (input.type === "merge") {
      const mergeCommit = asCommitOid(input.mergeCommit);
      if (mergeCommit) tags.push([MERGE_COMMIT_TAG, mergeCommit]);
    } else if (input.type !== "state") {
      // The commit a judgement was made against, defaulting to the tip the room
      // currently believes in. Without it every review reads as "current"
      // forever, including the ones made three pushes ago.
      const commit = asCommitOid(input.commit) ?? room.tip;
      if (commit) tags.push([COMMIT_TAG, commit]);
    }
  }

  const published = await publishOrThrow(ctx, {
    actor: principal.actor,
    scope,
    kind,
    tags,
    content,
  });

  // The room's clock, so a branch that is moving sorts up the rail. `updatedAt`
  // is deliberately untouched — a patch is not a change to what the room *is*.
  await ctx.db.patch(channel._id, { lastActivityAt: Date.now() });

  // A patch that names a commit the room has not seen moves the tip, and that is
  // a 1619 rather than an inference: §2.2's PR-update event exists exactly so a
  // reader can see the tip move without reconstructing it from patch order.
  if (input.type === "patch") {
    const commit = asCommitOid(input.commit);
    if (commit && commit !== room.tip) {
      await publishOrThrow(ctx, {
        actor: principal.actor,
        scope,
        kind: KIND_GIT_PR_UPDATE,
        tags: [
          ["h", channel.channelId],
          [ADDRESS_TAG, binding.repoAddress],
          ["e", binding.id],
          [COMMIT_TAG, commit],
        ],
        content: "",
      });
    }
  }

  return published;
}

// ---------------------------------------------------------------------------
// Announcing a project
// ---------------------------------------------------------------------------

/**
 * Announce a repository, or replace your own announcement.
 *
 * 30617 is addressable, so re-announcing with the same slug replaces rather than
 * duplicates — `publishCore` decides that by coordinate and this file does not
 * get an opinion. What it does own is the slug: derived from the name, refused
 * when empty, and never invented, because the slug is half the address every
 * branch room joins on and a generated one would make the address unreadable.
 *
 * Anybody in the community may announce, and that is deliberate rather than an
 * oversight. A 30617 is keyed by `(author, d)`, so announcing does not claim
 * anybody else's name — it claims yours. Two people announcing `api` are two
 * repositories at two addresses, which is what a fork *is*.
 */
export const announce = mutation({
  args: {
    ...scopeArgs,
    name: v.string(),
    slug: v.optional(v.string()),
    description: v.optional(v.string()),
    cloneUrls: v.optional(v.array(v.string())),
    webUrl: v.optional(v.string()),
    projectChannelId: v.optional(v.string()),
    visibility: v.optional(v.union(v.literal("listed"), v.literal("unlisted"))),
  },
  handler: async (ctx, args): Promise<{ projectId: string; eventId: string }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const principal = await userPrincipal(ctx, subject);
    const authorPubkey = await requireOwnPubkey(ctx, principal);
    await requireNotRestricted(ctx, scope, authorPubkey);

    const name = clamp(args.name, MAX_TITLE_CHARS);
    const dtag = projectSlug(args.slug ?? name);
    if (!name || !dtag) throw new ConvexError("A project needs a name");

    // A bound project channel must be a room the announcer can actually reach —
    // otherwise the tag names a room nobody can open, and §2.3's binding is what
    // a real forge would read as its ACL.
    if (args.projectChannelId) {
      await resolveChannelForActor(ctx, scope, args.projectChannelId, subject);
    }

    const published = await publishOrThrow(ctx, {
      actor: principal.actor,
      scope,
      kind: KIND_GIT_REPO_ANNOUNCEMENT,
      tags: projectTags({
        dtag,
        name,
        ...(args.description ? { description: clamp(args.description, 500) } : {}),
        ...(args.cloneUrls ? { cloneUrls: args.cloneUrls.filter(Boolean).slice(0, 8) } : {}),
        ...(args.webUrl ? { webUrl: args.webUrl } : {}),
        ...(args.projectChannelId ? { projectChannelId: args.projectChannelId } : {}),
        ...(args.visibility ? { visibility: args.visibility } : {}),
      }),
      content: args.description ?? "",
    });

    return { projectId: `${authorPubkey}:${dtag}`, eventId: published.eventId };
  },
});

/**
 * Retire an announcement.
 *
 * Owner only, and enforced by the coordinate rather than by a role: 30617 is
 * keyed by `(author, d)`, so the only principal whose announcement this *is* is
 * its author. §2.5 makes the same call from the read side — `isDeletedByA` only
 * honours a deletion signed by the project owner, "otherwise anyone could hide
 * someone else's project".
 *
 * Two halves, exactly as `messages.remove` has them: the kind-5 is the record of
 * who retired what, kept forever; the soft delete on the row is the effect, so
 * the announcement stops being served rather than being served and hidden by a
 * client. Branch rooms are untouched — the argument about the code outlives the
 * repository entry, which is the point of the room being the record.
 */
export const retire = mutation({
  args: { ...scopeArgs, projectId: v.string() },
  handler: async (ctx, args): Promise<{ retired: boolean }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const principal = await userPrincipal(ctx, subject);
    const authorPubkey = await requireOwnPubkey(ctx, principal);

    const separator = args.projectId.indexOf(":");
    if (separator <= 0) throw new ConvexError("Project not found");
    const owner = args.projectId.slice(0, separator);
    const dtag = args.projectId.slice(separator + 1);
    const project = await projectByAddress(
      ctx,
      scope,
      authorPubkey,
      repoAddress(owner, dtag),
    );
    if (!project) throw new ConvexError("Project not found");
    if (project.owner !== authorPubkey) {
      throw new ConvexError("Only the person who announced a project can retire it");
    }

    await publishOrThrow(ctx, {
      actor: principal.actor,
      scope,
      kind: 5,
      tags: [[ADDRESS_TAG, project.repoAddress]],
      content: "",
    });

    const row = await ctx.db
      .query("buzzEvents")
      .withIndex("by_scope_event_id", (q) =>
        q
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId)
          .eq("eventId", project.eventId),
      )
      .first();
    if (row) await ctx.db.patch(row._id, { deletedAt: Date.now() });
    return { retired: true };
  },
});

/**
 * Group several repositories under one name (NIP-MP, kind 30621).
 *
 * The rule that makes this safe is the one §2.1 states and this file enforces by
 * *not* reading it anywhere: **the signer of a grouping gains no authority over
 * any member.** Membership cannot live in each 30617 because Alice cannot sign
 * for Bob's repo, so a grouping is one person's list — and `mayGovernProject`
 * reads the repository's own announcement and never a grouping. A grouping is a
 * bookmark that renders as a heading.
 */
export const group = mutation({
  args: {
    ...scopeArgs,
    name: v.string(),
    slug: v.optional(v.string()),
    memberAddresses: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<{ slug: string; eventId: string }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const principal = await userPrincipal(ctx, subject);
    const authorPubkey = await requireOwnPubkey(ctx, principal);
    await requireNotRestricted(ctx, scope, authorPubkey);

    const name = clamp(args.name, MAX_TITLE_CHARS);
    const slug = projectSlug(args.slug ?? name);
    if (!name || !slug) throw new ConvexError("A collection needs a name");

    const addresses = [...new Set(args.memberAddresses)]
      .filter((address) => parseRepoAddress(address) !== null)
      .slice(0, 50);
    if (addresses.length === 0) throw new ConvexError("A collection needs a repository in it");

    const published = await publishOrThrow(ctx, {
      actor: principal.actor,
      scope,
      kind: KIND_PROJECT,
      tags: [
        [D_TAG, slug],
        ["name", name],
        ...addresses.map((address) => [ADDRESS_TAG, address]),
      ],
      content: "",
    });
    return { slug, eventId: published.eventId };
  },
});

// ---------------------------------------------------------------------------
// Binding a room to a branch
// ---------------------------------------------------------------------------

/**
 * Make this room the room for a branch.
 *
 * **Not one transaction with the room's creation, and that is a choice.**
 * `channels.create` is a mutation rather than an exported core, and forking room
 * creation to get atomicity would mean a second copy of the 9007-mints-the-id
 * rule, the owner membership, the metadata event and the canvas — five writes
 * that must all happen, in the file that says so. So the UI creates the room and
 * then binds it, and the failure mode is a room with no binding: a room, which
 * anybody in it can bind afterwards by calling this again. The alternative's
 * failure mode is a second room-creation path drifting from the first.
 *
 * One branch per room, and the binding cannot be replaced. A room whose branch
 * could be changed later is a room whose record of *why the code exists* can be
 * pointed at different code after the fact.
 */
export const bindBranch = mutation({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    repoAddress: v.string(),
    branch: v.string(),
    targetBranch: v.optional(v.string()),
    title: v.optional(v.string()),
    commit: v.optional(v.string()),
    reviewers: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<{ eventId: string }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const principal = await userPrincipal(ctx, subject);
    const { channel, membership } = await resolveChannelForActor(
      ctx,
      scope,
      args.channelId,
      subject,
    );
    requireWritableRoom(channel, membership);

    const authorPubkey = await requireOwnPubkey(ctx, principal);
    await requireNotRestricted(ctx, scope, authorPubkey);

    const branch = normalizeBranchName(args.branch);
    if (!branch) throw new ConvexError("That is not a branch name");
    const target = args.targetBranch ? normalizeBranchName(args.targetBranch) : null;
    if (args.targetBranch && !target) throw new ConvexError("That is not a branch name");

    const project = await projectByAddress(ctx, scope, authorPubkey, args.repoAddress);
    // Refused rather than bound to a coordinate nobody has announced: a room
    // pointing at a repository that does not exist in this community renders a
    // branch of nothing, and it is also how a binding would smuggle in an
    // address from another workspace.
    if (!project) throw new ConvexError("No such project in this community");

    const existing = buildBranchRoom(
      channel.channelId,
      (await forgeRowsForRoom(ctx, scope, channel, authorPubkey)).map(toNostrEvent),
    );
    if (existing.binding) {
      throw new ConvexError(
        `This room is already the room for ${existing.binding.branch}`,
      );
    }

    const reviewers = (args.reviewers ?? [])
      .filter((value) => /^[0-9a-f]{64}$/.test(value))
      .slice(0, 20);
    const commit = asCommitOid(args.commit);

    const published = await publishOrThrow(ctx, {
      actor: principal.actor,
      scope,
      kind: KIND_GIT_PULL_REQUEST,
      tags: [
        ["h", channel.channelId],
        [ADDRESS_TAG, project.repoAddress],
        [BRANCH_TAG, branch],
        ...(target ? [[TARGET_BRANCH_TAG, target]] : []),
        [SUBJECT_TAG, clamp(args.title ?? branch, MAX_TITLE_CHARS) || branch],
        ...(commit ? [[COMMIT_TAG, commit]] : []),
        ...reviewers.map((pubkey) => ["p", pubkey]),
      ],
      content: "",
    });

    await ctx.db.patch(channel._id, { lastActivityAt: Date.now() });
    return { eventId: published.eventId };
  },
});

// ---------------------------------------------------------------------------
// The human doors
// ---------------------------------------------------------------------------

/** Post a patch into the branch room. */
export const postPatch = mutation({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    title: v.string(),
    body: v.string(),
    commit: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    return await recordForgeCore(
      ctx,
      scope,
      args.channelId,
      await userPrincipal(ctx, subject),
      {
        type: "patch",
        title: args.title,
        body: args.body,
        ...(args.commit ? { commit: args.commit } : {}),
      },
    );
  },
});

/** Approve, or ask for changes. Refused on your own branch — see the core. */
export const postReview = mutation({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    outcome: v.union(v.literal("approved"), v.literal("changes_requested")),
    note: v.optional(v.string()),
    commit: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    return await recordForgeCore(
      ctx,
      scope,
      args.channelId,
      await userPrincipal(ctx, subject),
      {
        type: "review",
        outcome: args.outcome,
        ...(args.note ? { note: args.note } : {}),
        ...(args.commit ? { commit: args.commit } : {}),
      },
    );
  },
});

/** Move the branch between draft, open and closed. */
export const setBranchState = mutation({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    outcome: v.union(v.literal("open"), v.literal("draft"), v.literal("closed")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    return await recordForgeCore(
      ctx,
      scope,
      args.channelId,
      await userPrincipal(ctx, subject),
      { type: "state", outcome: args.outcome, ...(args.note ? { note: args.note } : {}) },
    );
  },
});

/**
 * Record the merge.
 *
 * The decision, not the operation. There is no git here to merge with, and
 * pretending otherwise would be the one lie this phase must not tell — so what
 * this writes is a signed statement by a named principal that the merge was
 * made, which is exactly what §2.3 means by "the channel becomes the permanent
 * record of why the code exists". It is attributable (signed by the merger's own
 * key), unforgeable by a non-member (`resolveChannelForActor` +
 * `requireWritableRoom`), and unforgeable by an ordinary member (the authority
 * check in the core).
 */
export const postMerge = mutation({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    mergeCommit: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    return await recordForgeCore(
      ctx,
      scope,
      args.channelId,
      await userPrincipal(ctx, subject),
      {
        type: "merge",
        ...(args.mergeCommit ? { mergeCommit: args.mergeCommit } : {}),
        ...(args.note ? { note: args.note } : {}),
      },
    );
  },
});

// ---------------------------------------------------------------------------
// The ingestion door
// ---------------------------------------------------------------------------

/**
 * The door a CI runner or a coding agent posts through.
 *
 * **This is the ingestion path, and it is explicit rather than implied.** There
 * is no git hosting in this deployment, so the events that a forge would emit —
 * a patch, a build result, a review — arrive from something outside it. That
 * something authenticates the way everything else machine-shaped in this
 * codebase does: an agent API key, resolved by `requireAgentByKey`, which
 * applies the agent's role, its daily budget, its burst cap and its metering
 * before this function sees it. A webhook with no principal was the alternative
 * and it is worse in the way that matters here: an unattributable patch in the
 * record is a patch the record cannot answer questions about.
 *
 * Reaching it from a workflow is already possible with nothing new: a
 * `diff_posted` or `schedule` workflow's `call_webhook` step calls the CI system,
 * and the CI system calls back here (or `POST /hooks/{id}`, the workflow
 * engine's own door, which posts into the room as the workflow's owner).
 *
 * Note what is deliberately absent: a `scope` argument. The community comes from
 * the key, so there is no field a caller could put somebody else's community
 * into — the same rule the human surfaces get from `requireScopeAccess`, reached
 * through the other door (D4).
 */
export const report = mutation({
  args: {
    apiKey: v.string(),
    channelId: v.string(),
    report: v.union(
      v.object({
        type: v.literal("patch"),
        title: v.string(),
        body: v.string(),
        commit: v.optional(v.string()),
      }),
      v.object({
        type: v.literal("check"),
        outcome: v.union(v.literal("passed"), v.literal("failed"), v.literal("running")),
        note: v.optional(v.string()),
        commit: v.optional(v.string()),
      }),
      v.object({
        type: v.literal("review"),
        outcome: v.union(v.literal("approved"), v.literal("changes_requested")),
        note: v.optional(v.string()),
        commit: v.optional(v.string()),
      }),
      v.object({
        type: v.literal("state"),
        outcome: v.union(v.literal("open"), v.literal("draft"), v.literal("closed")),
        note: v.optional(v.string()),
      }),
      v.object({
        type: v.literal("merge"),
        mergeCommit: v.optional(v.string()),
        note: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const scope: Scope = { scopeType: agent.parentType, scopeId: agent.parentId };
    const principal: ChannelPrincipal = {
      actor: agentActor(agent),
      actorType: "agent",
      actorId: agent._id,
    };
    return await recordForgeCore(ctx, scope, args.channelId, principal, args.report);
  },
});
