// The canvas: one markdown document per room.
//
// 04-huddle-media.md §3. Not a drawing surface, not a block editor, not a CRDT
// — a slow-moving "what this room is about" narrative, stored as kind 40100
// with the room in an `h` tag, and read back as "the newest one wins". That is
// the whole data model, and the reason it can be this small is that the log
// already is the store: a canvas has no table, no revision table and no
// projection column, because every version it has ever had is an event that is
// still there.
//
// ## Last-write-wins, kept — and made visible
//
// Buzz clobbers unconditionally (§3.4): no `expectedUpdatedAt`, no lock, no
// merge. Our Pages editor solved the same problem the other way, with
// optimistic concurrency and a *Take theirs / Keep mine* banner. Those two
// answers are not in competition, because the thing they are protecting is not
// the same thing:
//
//   - `pages.content` is a **mutable column**. A save that lands on top of
//     somebody else's is genuinely destructive — the bytes they wrote are gone
//     unless a revision happened to be snapshotted — so the write has to be
//     refused and the conflict resolved by a person.
//   - A canvas **is the log**. A write appends; the version it replaced is
//     still an event, still signed by its author, still readable, still
//     restorable. Nothing is destroyed, so there is nothing for a refusal to
//     save.
//
// So we keep last-write-wins, for three reasons in increasing order of weight.
// It is Buzz's documented semantics and this is a parity build. It is the only
// rule an **agent** can obey: an agent writing over MCP has no editor open and
// no version token to send, and a surface that refuses a write unless the
// caller quotes the version it read is a surface only a browser can use — the
// exact split D9 exists to avoid. And a refusal here would be protecting
// against a loss that cannot happen.
//
// What last-write-wins is *not* allowed to be is silent, and that is the half
// this file owns. Every write reports the version it replaced (`replaced`) and
// whether the writer had seen it (`unseen`), so the UI can say "you replaced
// Ada's edit from four minutes ago" and offer it back. Restoring is an ordinary
// write of the older content — the same shape `pages.restoreRevision` uses, and
// for the same reason: a rewind that is not itself an edit is a rewind that
// cannot be undone.
//
// ## Why `created_at` is bumped
//
// "Newest wins" is decided by `created_at`, which NIP-01 measures in **seconds**
// — and two saves in one second are ordinary. On a tie `readEventsCore` falls
// back to comparing event ids, which is a hash and therefore an arbitrary
// order: the canvas would show whichever of the two happens to hash lower, not
// the one written second. So a write's timestamp is `max(now, head + 1)`,
// making the head of a room's canvas strictly increasing. This is the same rule
// Buzz applies to reminder replacement (03-workflows-projects §4.1) and it is
// applied here for exactly the same reason.

import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { agentActor, requireAgentByKey } from "../_agentAuth";
import type { Actor } from "../_agentAuth";
import { requireChannelAccess, resolveChannelForActor } from "./channels";
import { describePubkey, pubkeyFor } from "./identity";
import { publishCore, readEventsCore, type Scope } from "./log";
import type { NostrEvent } from "./_nostr";

/** `KIND_CANVAS` (`crates/buzz-core/src/kind.rs:482`). Channel-scoped, open. */
const KIND_CANVAS = 40100;

/**
 * How many past versions a history read hands back.
 *
 * Bounded because a canvas is a whole document and fifty of them is megabytes
 * over the wire — the same reason `pages.history` returns excerpts rather than
 * full markdown. Here the excerpt is the *list*: history carries a preview and
 * a size, and `readVersion` fetches one in full.
 */
export const CANVAS_HISTORY_DEFAULT = 20;
export const CANVAS_HISTORY_MAX = 50;
/** Enough to recognise a version, short enough that fifty of them are cheap. */
const PREVIEW_CHARS = 180;

const scopeArgs = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type CanvasAuthor = {
  pubkey: string;
  name: string;
  isAgent: boolean;
};

/**
 * The room's canvas as a reader sees it.
 *
 * **Every field is explicitly null when there is no canvas**, and the object
 * itself is never null. That is Buzz's rule (§3.2) and its reason survives the
 * change of language: a caller distinguishes "no canvas yet" from "a canvas
 * that happens to be empty" by looking at `updatedAt`/`author`, and an absent
 * key deserializes as `undefined`, which is a third state nobody wrote a branch
 * for.
 */
export type CanvasHead = {
  content: string | null;
  /** The id of the 40100 that is currently the canvas. Its revision. */
  eventId: string | null;
  /** Milliseconds — `timeAgo` is the app's one relative-time voice. */
  updatedAt: number | null;
  author: CanvasAuthor | null;
};

const EMPTY_CANVAS: CanvasHead = {
  content: null,
  eventId: null,
  updatedAt: null,
  author: null,
};

export type CanvasVersion = {
  eventId: string;
  updatedAt: number;
  author: CanvasAuthor | null;
  preview: string;
  /** Characters, not bytes — this is a length shown to a person, not a quota. */
  length: number;
};

export type CanvasWrite = {
  /**
   * `unchanged` when the submitted markdown is byte-identical to the head.
   *
   * Not written, deliberately. A canvas that logged a version every time
   * somebody opened the editor and pressed Save without typing would bury the
   * edits that mattered under versions that said nothing — and the log is the
   * only history this document has.
   */
  status: "written" | "unchanged";
  eventId: string;
  /** The version this one displaced, or null if the room had no canvas. */
  replaced: { eventId: string; updatedAt: number; author: CanvasAuthor | null } | null;
  /**
   * True when the writer named the version it was editing and the head had
   * already moved past it.
   *
   * This is the whole of "make a lost edit visible": the write still lands
   * (last-write-wins), and the caller is told, in the same response, that it
   * landed on top of something it had not read.
   */
  unseen: boolean;
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The newest 40100 in a room, or null.
 *
 * Through `readEventsCore` rather than a hand-rolled index read, because that
 * is the one function that applies the channel boundary and the per-event read
 * gate (log.ts §16.9, §16.12). A canvas is an open-gated kind today, so nothing
 * is being withheld — which is exactly why it would be so easy to skip the core
 * here and so expensive later, when the read that skipped it is the one a
 * private kind gets added behind.
 *
 * `limit: 1` is not a convenience: the channel plan reads the
 * `(scope, channel, kind, live, createdAt)` index in descending order and takes
 * one row, so "the newest" is an index range and not a sort over the room's
 * whole canvas history.
 */
async function headEvent(
  ctx: QueryCtx,
  scope: Scope,
  channelId: string,
  readerPubkey: string,
): Promise<NostrEvent | null> {
  const found = await readEventsCore(ctx, {
    scope,
    filters: [
      {
        kinds: [KIND_CANVAS],
        tags: [{ name: "h", values: [channelId] }],
        limit: 1,
      },
    ],
    readerPubkey,
  });
  return found[0] ?? null;
}

async function describeAuthor(
  ctx: QueryCtx,
  pubkey: string,
): Promise<CanvasAuthor | null> {
  const described = await describePubkey(ctx, pubkey);
  if (!described) return null;
  return { pubkey, name: described.name, isAgent: described.isAgent };
}

/** The head, in the shape every surface returns. */
export async function readCanvasCore(
  ctx: QueryCtx,
  scope: Scope,
  channelId: string,
  readerPubkey: string,
): Promise<CanvasHead> {
  const event = await headEvent(ctx, scope, channelId, readerPubkey);
  if (!event) return EMPTY_CANVAS;
  return {
    content: event.content,
    eventId: event.id,
    updatedAt: event.created_at * 1000,
    author: await describeAuthor(ctx, event.pubkey),
  };
}

/**
 * The versions behind the head, newest first.
 *
 * Every one of them is restorable by writing its content back, which is what
 * makes last-write-wins survivable rather than merely documented.
 */
export async function readCanvasHistoryCore(
  ctx: QueryCtx,
  scope: Scope,
  channelId: string,
  readerPubkey: string,
  limit: number,
): Promise<CanvasVersion[]> {
  const bounded = Math.min(Math.max(Math.floor(limit) || 0, 1), CANVAS_HISTORY_MAX);
  const events = await readEventsCore(ctx, {
    scope,
    filters: [
      {
        kinds: [KIND_CANVAS],
        tags: [{ name: "h", values: [channelId] }],
        limit: bounded,
      },
    ],
    readerPubkey,
  });
  const out: CanvasVersion[] = [];
  const authors = new Map<string, CanvasAuthor | null>();
  for (const event of events) {
    if (!authors.has(event.pubkey)) {
      authors.set(event.pubkey, await describeAuthor(ctx, event.pubkey));
    }
    out.push({
      eventId: event.id,
      updatedAt: event.created_at * 1000,
      author: authors.get(event.pubkey) ?? null,
      preview: event.content.slice(0, PREVIEW_CHARS),
      length: [...event.content].length,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type WriteCanvasArgs = {
  scope: Scope;
  channelId: string;
  actor: Actor;
  /** The writer's own pubkey — used for the read gate on the head lookup. */
  actorPubkey: string;
  content: string;
  /**
   * The revision the writer was editing, if it knows one.
   *
   * Optional on purpose, and the optionality is the design: a browser has it,
   * an agent writing from a shell does not, and neither is refused. It changes
   * *what the caller is told*, never whether the write happens.
   */
  basedOn?: string;
};

/**
 * Replace a room's canvas.
 *
 * The caller owes the access check — this is the core both the Clerk surface
 * and the API-key surface call, and neither of them can be the one that
 * decides who may write, because then there would be two answers.
 */
export async function writeCanvasCore(
  ctx: MutationCtx,
  args: WriteCanvasArgs,
): Promise<CanvasWrite> {
  const head = await headEvent(ctx, args.scope, args.channelId, args.actorPubkey);
  const replaced = head
    ? {
        eventId: head.id,
        updatedAt: head.created_at * 1000,
        author: await describeAuthor(ctx, head.pubkey),
      }
    : null;
  const unseen =
    args.basedOn !== undefined && head !== null && head.id !== args.basedOn;

  if (head && head.content === args.content) {
    return { status: "unchanged", eventId: head.id, replaced, unseen };
  }

  const nowSecs = Math.floor(Date.now() / 1000);
  // Strictly after the head — see the note at the top of the file. A room would
  // have to be saved nine hundred times in one second for this to walk out of
  // the ±15 minute drift window, and if it ever did the refusal would be loud
  // rather than a canvas that silently stopped updating.
  const createdAt = head ? Math.max(nowSecs, head.created_at + 1) : nowSecs;

  const outcome = await publishCore(ctx, {
    actor: args.actor,
    scope: args.scope,
    kind: KIND_CANVAS,
    tags: [["h", args.channelId]],
    content: args.content,
    createdAt,
  });
  if (outcome.status === "dominated" || outcome.status === "ephemeral") {
    // Neither is reachable for a regular kind, and both mean nothing was
    // written. Returning a success shape here would tell a person their canvas
    // was saved when the log holds no such event.
    throw new ConvexError(
      `The channel log refused this canvas (${outcome.status}); nothing was written.`,
    );
  }

  return { status: "written", eventId: outcome.event.id, replaced, unseen };
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

type ChannelRow = Doc<"buzzChannels">;

/**
 * May this principal write the room's narrative?
 *
 * The same bar `channels.setTopic` uses — an active member, and not in an
 * archived room (§3.3's `canEdit && !isArchived`). Not owners-and-admins: the
 * canvas is what the room is *about*, and a room whose charter only two people
 * may touch is a room where the charter goes stale. Archived is the hard stop
 * because an archived room is a record, and a record you can still edit is not
 * one.
 */
function assertWritable(channel: ChannelRow, membership: unknown): void {
  if (channel.archivedAt !== undefined) {
    throw new ConvexError("This room is archived, so its canvas is read-only.");
  }
  if (!membership) {
    throw new ConvexError("Only members of this room can change its canvas.");
  }
}

/** The acting person, in the Actor shape every write path in this app takes. */
async function userActor(ctx: QueryCtx | MutationCtx, subject: string): Promise<Actor> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", subject))
    .unique();
  return { type: "user", id: subject, name: user?.name ?? user?.email ?? subject };
}

// ---------------------------------------------------------------------------
// The Clerk-authenticated surface
// ---------------------------------------------------------------------------

/**
 * The room's canvas.
 *
 * A live subscription, which is what makes "somebody changed this under you"
 * something the editor can say *before* you save rather than only after: the
 * pane holds a local draft and watches this query, so a head that moves while
 * you type is visible immediately.
 */
export const read = query({
  args: { ...scopeArgs, channelId: v.string() },
  handler: async (ctx, args): Promise<CanvasHead & { canEdit: boolean }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel, membership } = await requireChannelAccess(
      ctx,
      scope,
      args.channelId,
    );
    const readerPubkey = (await pubkeyFor(ctx, "user", subject)) ?? "";
    const head = await readCanvasCore(ctx, scope, args.channelId, readerPubkey);
    return {
      ...head,
      canEdit: channel.archivedAt === undefined && membership !== null,
    };
  },
});

/** What the canvas said before. Newest first, head included. */
export const history = query({
  args: { ...scopeArgs, channelId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<CanvasVersion[]> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireChannelAccess(ctx, scope, args.channelId);
    const readerPubkey = (await pubkeyFor(ctx, "user", subject)) ?? "";
    return await readCanvasHistoryCore(
      ctx,
      scope,
      args.channelId,
      readerPubkey,
      args.limit ?? CANVAS_HISTORY_DEFAULT,
    );
  },
});

/**
 * One past version, in full.
 *
 * Access-checked against the **room** rather than against the event id, which
 * is the same rule `pages.readRevision` follows: an old version is room content
 * and leaks exactly the text a member could read anyway, so the question is
 * "may you see this room", not "do you know this hash".
 */
export const readVersion = query({
  args: { ...scopeArgs, channelId: v.string(), eventId: v.string() },
  handler: async (ctx, args): Promise<{ content: string } | null> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireChannelAccess(ctx, scope, args.channelId);
    const readerPubkey = (await pubkeyFor(ctx, "user", subject)) ?? "";
    const found = await readEventsCore(ctx, {
      scope,
      filters: [
        {
          ids: [args.eventId],
          kinds: [KIND_CANVAS],
          tags: [{ name: "h", values: [args.channelId] }],
          limit: 1,
        },
      ],
      readerPubkey,
    });
    return found[0] ? { content: found[0].content } : null;
  },
});

/**
 * Replace the canvas. Restoring an old version is this, with old content.
 */
export const write = mutation({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    content: v.string(),
    basedOn: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CanvasWrite> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel, membership } = await requireChannelAccess(
      ctx,
      scope,
      args.channelId,
    );
    assertWritable(channel, membership);
    const actor = await userActor(ctx, subject);
    const actorPubkey = (await pubkeyFor(ctx, "user", subject)) ?? "";
    return await writeCanvasCore(ctx, {
      scope,
      channelId: args.channelId,
      actor,
      actorPubkey,
      content: args.content,
      basedOn: args.basedOn,
    });
  },
});

// ---------------------------------------------------------------------------
// The API-key surface — an agent has the same canvas a person has
// ---------------------------------------------------------------------------
//
// §3.5: agents get the same surface through the CLI rather than a bespoke tool,
// and that is the shape kept here — the same core, the same membership bar, the
// same last-write-wins. What is deliberately *not* kept is Buzz's oddity that
// `buzz canvas get` returns a bare string rather than an envelope: the revision
// id is the one thing an agent needs to know it is not overwriting something it
// never read, and a bare string cannot carry it.
//
// The fence is the agent's own community. There is no scope argument below, so
// there is no field a caller could put another workspace into; the room is
// resolved under the scope the key resolves to, and a room elsewhere is not
// refused, it is simply not there.

function communityFor(agent: Doc<"agents">): Scope {
  return { scopeType: agent.parentType, scopeId: agent.parentId };
}

/** Read the canvas of a room this agent can reach. */
export const agentRead = query({
  args: { apiKey: v.string(), channelId: v.string() },
  handler: async (ctx, args): Promise<CanvasHead & { canEdit: boolean }> => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "read");
    const scope = communityFor(agent);
    const { channel, membership } = await resolveChannelForActor(
      ctx,
      scope,
      args.channelId,
      agent._id,
    );
    const readerPubkey = (await pubkeyFor(ctx, "agent", agent._id)) ?? "";
    const head = await readCanvasCore(ctx, scope, args.channelId, readerPubkey);
    return {
      ...head,
      canEdit: channel.archivedAt === undefined && membership !== null,
    };
  },
});

/**
 * Replace the canvas of a room this agent is in.
 *
 * `"write"` mode is the whole of governance: a readonly agent is refused before
 * the daily budget or the burst cap is touched, so a refused canvas write costs
 * it nothing. Nothing here restates a limit, and nothing here should start.
 */
export const agentWrite = mutation({
  args: {
    apiKey: v.string(),
    channelId: v.string(),
    content: v.string(),
    basedOn: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CanvasWrite> => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const scope = communityFor(agent);
    const { channel, membership } = await resolveChannelForActor(
      ctx,
      scope,
      args.channelId,
      agent._id,
    );
    assertWritable(channel, membership);
    const actorPubkey = (await pubkeyFor(ctx, "agent", agent._id)) ?? "";
    return await writeCanvasCore(ctx, {
      scope,
      channelId: args.channelId,
      actor: agentActor(agent),
      actorPubkey,
      content: args.content,
      basedOn: args.basedOn,
    });
  },
});
