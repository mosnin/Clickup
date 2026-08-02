// The bridge. Two applications, one product.
//
// D11 is emphatic that the Work dashboard and the Chat dashboard stay two
// applications: two message stores, two unread counts, nothing migrated. This
// file is what makes that a *seam* rather than a wall — the place where a task
// referenced in a room stays live, a message becomes a task without leaving the
// room, a mention in a channel lands in the inbox you already read, and the
// switcher can say how much is waiting on the other side.
//
// ## The one rule
//
// **The bridge is not a third store.** Everything below is either a read across
// a source that already owns the fact, or a reference resolved at the moment
// somebody looks at it. There is exactly one table here and it holds one
// pointer — which project a room is bound to — because a pointer is the one
// thing neither side can hold on its own. Nothing else is written. A task's
// status copied into the Chat log would be correct the day it was written and
// silently wrong every day after, and a stale status inside a room is worse
// than no status at all: the reader cannot tell which one they are looking at,
// so it poisons the numbers that *are* live.
//
// The concrete consequence, and it is the reason "a channel bound to a project
// posts its task events" is implemented as a read: **the Work events are not
// posted into the log.** They are ranged out of `events` — the table Work
// already writes them to — every time the room is drawn. A synthesized Chat
// event per Work event would be a copy that drifts, a second retention policy,
// and a second place a deleted task keeps existing.
//
// ## Two sides, two authz, never a third
//
// Every read here crosses a boundary, and each half is checked by the side that
// owns it: Work objects through `_authz` (`requireTaskAccess`,
// `requireListAccess`, `requireProjectAccess`), Chat rooms through
// `buzz/channels.requireChannelAccess`, which is itself `requireScopeAccess`
// plus the room's own visibility rule. There is no bridge-level access check
// and there must never be one — a third answer to "may this person see this"
// is a third thing to keep correct, and it would be the one nobody remembers to
// update.
//
// The leak this shape exists to prevent is specific: a message body is prose
// somebody wrote, so its *label* ("look at #[Payroll rewrite](task:t7)") is
// readable by everyone in the room whatever the task's permissions are. What
// must never happen is the resolver handing back the task's **current** title,
// status or link to a reader who cannot open it — that would turn a label
// written once into a live feed out of a space they were never in. So an
// unresolvable reference comes back `found: false` and the chip renders as
// unfinished.

import { ConvexError, v } from "convex/values";
import { defineTable } from "convex/server";
import { mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  canAccessSpace,
  getSpaceForList,
  requireIdentity,
  requireListAccess,
  requireProjectAccess,
  requireScopeAccess,
  requireTaskAccess,
} from "../_authz";
import type { Actor } from "../_agentAuth";
import { emitEvent } from "../events";
import { REF_KINDS, type RefKind, bodyPreview } from "../_refs";
import { createTaskCore } from "../tasks";
import {
  listChannelsCore,
  mayGovernCommunity,
  requireChannelAccess,
  type ChannelPrincipal,
} from "./channels";
import { postMessageCore } from "./messages";
import { describePubkey, pubkeyFor } from "./identity";
import { unreadForChannels } from "./readState";
import { searchMessagesCore, type SearchHit } from "./search";
import type { EventRow, Scope } from "./log";
import { isChatNotification, parseRoomKey, taskRefToken } from "../../src/lib/buzz/bridge";

const scopeArgs = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

/** Nothing here reads more of a table than a screen can draw. */
const MAX_REFS = 40;
const MAX_TASK_CARDS = 40;
const MAX_WORK_FEED = 25;
const MAX_SEARCH_HITS = 8;
/** The badge is capped in the pure lib; this caps what it costs to compute. */
const BADGE_SCAN = 120;

// ---------------------------------------------------------------------------
// The one table: a pointer, and only a pointer
// ---------------------------------------------------------------------------

/**
 * Which project a room is about.
 *
 * The only durable thing C12 adds, and it is deliberately the smallest object
 * that cannot live on either side alone: Work's `projects` row must not learn
 * about Chat (D11 — the Work side is not refactored to make room), and a Buzz
 * channel row must not grow Work columns (`_tables.ts` says so in as many
 * words). So the edge gets its own row, holding the two ids and who drew it.
 *
 * What it deliberately does **not** hold: the project's name, its list ids, its
 * task counts, its last activity. Every one of those is a read away and every
 * one of them would be wrong the first time somebody renamed something from the
 * other dashboard.
 *
 * Declared here rather than in `convex/buzz/_tables.ts` for the reason
 * `buzzNotificationTables` states: that file is edited by every Chat phase at
 * once, and a schema edit from this one would be a merge conflict in the single
 * file they all touch. Folding it in is `...buzzBridgeTables` in `schema.ts`
 * and nothing else.
 */
export const buzzBridgeTables = {
  buzzRoomBindings: defineTable({
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    channelId: v.string(),
    projectId: v.id("projects"),
    /** Clerk subject or `agents` id — the actor shape the app already uses. */
    boundByActorId: v.string(),
    boundAt: v.number(),
  })
    // Scope-leading, like every index in the Chat schema and for the same
    // reason: a channel id is unique inside a community, so a lookup keyed on
    // the channel alone answers with another tenant's room the day two collide.
    .index("by_scope_channel", ["scopeType", "scopeId", "channelId"])
    // "Which rooms are about this project" — the Work side's question.
    .index("by_project", ["projectId"]),
};

async function bindingRow(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  channelId: string,
): Promise<Doc<"buzzRoomBindings"> | null> {
  return await ctx.db
    .query("buzzRoomBindings")
    .withIndex("by_scope_channel", (q) =>
      q
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("channelId", channelId),
    )
    .unique();
}

// ---------------------------------------------------------------------------
// The tenancy fence, in both directions
// ---------------------------------------------------------------------------

/**
 * The scope a Work space belongs to, in the shape Chat speaks.
 *
 * `spaces.parentType` is already `"user" | "workspace"` and `parentId` is
 * already a Clerk subject or a workspace id — the same pair `requireScopeAccess`
 * takes and the same pair every Buzz table leads its indexes on. That is not a
 * coincidence, it is D4: a Buzz community *is* one of these. So "are these two
 * objects in the same tenant" is a string comparison rather than a mapping
 * table, and there is no translation layer to get backwards.
 */
function scopeOfSpace(space: Doc<"spaces">): Scope {
  return { scopeType: space.parentType, scopeId: space.parentId };
}

function sameScope(a: Scope, b: Scope): boolean {
  return a.scopeType === b.scopeType && a.scopeId === b.scopeId;
}

/**
 * Refuse to join two objects that live in different tenants.
 *
 * The subtle case, and the reason this is a hard refusal rather than a filter:
 * a person who belongs to two workspaces passes both sides' access checks
 * *individually*. Binding a room in Acme to a project in Beta would then be
 * authorized in every local sense and would still take Acme's conversation and
 * publish it into Beta's activity feed forever. Membership in both is not
 * permission to connect them.
 */
function requireSameTenant(room: Scope, work: Scope, what: string): void {
  if (!sameScope(room, work)) {
    throw new ConvexError(
      `That ${what} is in a different community from this room`,
    );
  }
}

/** The acting person, in the shape every Chat write path takes. */
async function userPrincipal(
  ctx: QueryCtx | MutationCtx,
  subject: string,
): Promise<ChannelPrincipal> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", subject))
    .unique();
  const actor: Actor = {
    type: "user",
    id: subject,
    name: user?.name ?? user?.email ?? subject,
  };
  return { actor, actorType: "user", actorId: subject };
}

// ---------------------------------------------------------------------------
// Bridge 1a — references, resolved live and only for a reader entitled to them
// ---------------------------------------------------------------------------

export type ResolvedRef = {
  kind: RefKind;
  id: string;
  /** What the author wrote. Always echoed: it is already in the message. */
  label: string;
  /** Where it lives, or null when this reader may not follow it. */
  href: string | null;
  /**
   * The object's **current** name, or null.
   *
   * Separate from `label` on purpose. The label is prose and the reader can
   * already see it; the title is live state and is exactly the thing a reader
   * without access must not be handed. `found: false` and `title: null` are
   * therefore the same fact stated twice, deliberately, so a renderer cannot
   * accidentally use one without the other.
   */
  title: string | null;
  found: boolean;
};

const refValidator = v.object({
  kind: v.string(),
  id: v.string(),
  label: v.string(),
});

function isRefKind(value: string): value is RefKind {
  return (REF_KINDS as readonly string[]).includes(value);
}

/**
 * Turn the reference tokens in a body into working chips.
 *
 * `scope` is the community the reader is standing in, and it is what a `room`
 * reference resolves against: a Buzz channel id is unique inside a community,
 * so a room reference pasted from another workspace resolves to nothing here.
 * That reads as "unfinished", which is the honest answer — it *is* a reference
 * to something that does not exist in this room's world.
 */
export const resolveRefs = query({
  args: { ...scopeArgs, refs: v.array(refValidator) },
  handler: async (ctx, args): Promise<ResolvedRef[]> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    // The tenancy fence first, exactly like every other read surface. A caller
    // who cannot reach the community gets an unresolved answer for everything
    // rather than a per-object probe.
    try {
      await requireScopeAccess(ctx, scope);
    } catch {
      return args.refs.map((ref) => unresolved(ref));
    }

    const out: ResolvedRef[] = [];
    for (const ref of args.refs.slice(0, MAX_REFS)) {
      if (!isRefKind(ref.kind)) {
        out.push(unresolved(ref));
        continue;
      }
      out.push(await resolveOne(ctx, scope, { ...ref, kind: ref.kind }));
    }
    return out;
  },
});

function unresolved(ref: { kind: string; id: string; label: string }): ResolvedRef {
  return {
    kind: (isRefKind(ref.kind) ? ref.kind : "task") as RefKind,
    id: ref.id,
    label: ref.label,
    href: null,
    title: null,
    found: false,
  };
}

/**
 * One reference, resolved by whichever side owns the object.
 *
 * Every branch does the same three things in the same order: normalize the id
 * (a hand-typed token is a string, not an id), ask the owning side's authz, and
 * only then read a name. A branch that read the row before asking would have
 * the answer in memory at the moment it decided not to return it, which is one
 * refactor away from returning it.
 */
async function resolveOne(
  ctx: QueryCtx,
  scope: Scope,
  ref: { kind: RefKind; id: string; label: string },
): Promise<ResolvedRef> {
  const base = { kind: ref.kind, id: ref.id, label: ref.label };
  try {
    if (ref.kind === "room") {
      // Chat's own check: the tenancy fence plus the room's visibility rule.
      // A private room reports "not found" rather than "forbidden", and this
      // preserves that — whether `#acquisition` exists is the information.
      const { channel } = await requireChannelAccess(ctx, scope, ref.id);
      return {
        ...base,
        href: `/chat/c/${channel.channelId}`,
        title: channel.displayName || `#${channel.name}`,
        found: true,
      };
    }

    if (ref.kind === "task") {
      const id = ctx.db.normalizeId("tasks", ref.id);
      if (!id) return unresolved(ref);
      const { task } = await requireTaskAccess(ctx, id);
      return {
        ...base,
        href: `/dashboard/l/${task.listId}/t/${task._id}`,
        title: task.title,
        found: true,
      };
    }

    if (ref.kind === "list") {
      const id = ctx.db.normalizeId("lists", ref.id);
      if (!id) return unresolved(ref);
      const { list } = await requireListAccess(ctx, id);
      return { ...base, href: `/dashboard/l/${list._id}`, title: list.name, found: true };
    }

    if (ref.kind === "project") {
      const id = ctx.db.normalizeId("projects", ref.id);
      if (!id) return unresolved(ref);
      const { project } = await requireProjectAccess(ctx, id);
      return {
        ...base,
        href: `/dashboard/p/${project._id}`,
        title: project.name,
        found: true,
      };
    }

    if (ref.kind === "page") {
      const id = ctx.db.normalizeId("pages", ref.id);
      if (!id) return unresolved(ref);
      const page = await ctx.db.get(id);
      if (!page) return unresolved(ref);
      await requireScopeAccess(ctx, {
        scopeType: page.scopeType,
        scopeId: page.scopeId,
      });
      return {
        ...base,
        href: `/dashboard/pages/${page._id}`,
        title: page.title,
        found: true,
      };
    }

    if (ref.kind === "sprint") {
      const id = ctx.db.normalizeId("sprints", ref.id);
      if (!id) return unresolved(ref);
      const sprint = await ctx.db.get(id);
      if (!sprint) return unresolved(ref);
      await requireScopeAccess(ctx, {
        scopeType: "workspace",
        scopeId: sprint.workspaceId,
      });
      return {
        ...base,
        href: `/dashboard/w/${sprint.workspaceId}?tab=sprints`,
        title: sprint.name,
        found: true,
      };
    }

    // goal
    const id = ctx.db.normalizeId("goals", ref.id);
    if (!id) return unresolved(ref);
    const goal = await ctx.db.get(id);
    if (!goal) return unresolved(ref);
    await requireScopeAccess(ctx, {
      scopeType: goal.parentType,
      scopeId: goal.parentId,
    });
    return {
      ...base,
      href:
        goal.parentType === "workspace"
          ? `/dashboard/w/${goal.parentId}?tab=goals`
          : "/dashboard/personal",
      title: goal.title,
      found: true,
    };
  } catch {
    // Every authz helper in this app throws. Catching to "unresolved" rather
    // than letting it out is what makes one forbidden reference in a message
    // render as one quiet chip instead of blanking the transcript.
    return unresolved(ref);
  }
}

// ---------------------------------------------------------------------------
// Bridge 1b — a task referenced in a room stays live
// ---------------------------------------------------------------------------

export type TaskCardWire = {
  taskId: string;
  listId: string;
  listName: string;
  title: string;
  statusName: string;
  statusColor: string;
  statusCategory: "open" | "in_progress" | "complete" | "closed";
  assigneeNames: string[];
  dueDate?: number;
  blocked: boolean;
};

/**
 * The live state of every task a screenful of messages points at.
 *
 * One subscription for the whole transcript rather than one per chip: Convex
 * pushes a patch when any of them changes, so "stays live" costs a single
 * query. Tasks the reader cannot open are **omitted**, not returned empty —
 * the chip falls back to the author's label, which is prose the reader could
 * already read, and the reader learns nothing new about a space they are not
 * in.
 */
export const taskCards = query({
  args: { taskIds: v.array(v.string()) },
  handler: async (ctx, { taskIds }): Promise<TaskCardWire[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const out: TaskCardWire[] = [];
    const names = new Map<string, string>();
    for (const raw of taskIds.slice(0, MAX_TASK_CARDS)) {
      const id = ctx.db.normalizeId("tasks", raw);
      if (!id) continue;
      let task: Doc<"tasks">;
      let list: Doc<"lists">;
      try {
        const resolved = await requireTaskAccess(ctx, id);
        task = resolved.task;
        list = resolved.list;
      } catch {
        continue;
      }
      const status = await ctx.db.get(task.statusId);
      const assigneeNames: string[] = [];
      for (const actorId of task.assigneeClerkIds) {
        assigneeNames.push(await actorName(ctx, actorId, names));
      }
      out.push({
        taskId: task._id,
        listId: list._id,
        listName: list.name,
        title: task.title,
        statusName: status?.name ?? "Unknown",
        statusColor: status?.color ?? "#d4d4d8",
        statusCategory: status?.category ?? "open",
        assigneeNames,
        ...(task.dueDate !== undefined ? { dueDate: task.dueDate } : {}),
        blocked: await hasOpenBlocker(ctx, task),
      });
    }
    return out;
  },
});

async function hasOpenBlocker(ctx: QueryCtx, task: Doc<"tasks">): Promise<boolean> {
  for (const id of task.blockedByTaskIds ?? []) {
    const blocker = await ctx.db.get(id);
    if (!blocker) continue;
    const status = await ctx.db.get(blocker.statusId);
    if (status?.category !== "complete" && status?.category !== "closed") {
      return true;
    }
  }
  return false;
}

/**
 * A name for an actor id, whichever kind of principal it is.
 *
 * The `agents` id / Clerk subject duality the whole app runs on: one string
 * shape, two tables, and `normalizeId` is the only honest way to tell them
 * apart. Cached across a request because a transcript's tasks share assignees.
 */
async function actorName(
  ctx: QueryCtx,
  actorId: string,
  cache: Map<string, string>,
): Promise<string> {
  const hit = cache.get(actorId);
  if (hit !== undefined) return hit;
  let name = "Someone";
  const agentId = ctx.db.normalizeId("agents", actorId);
  if (agentId) {
    name = (await ctx.db.get(agentId))?.name ?? "An agent";
  } else {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", actorId))
      .unique();
    name = user?.name ?? user?.email ?? "Someone";
  }
  cache.set(actorId, name);
  return name;
}

// ---------------------------------------------------------------------------
// Bridge 1c — a message becomes a task, without leaving the room
// ---------------------------------------------------------------------------

/**
 * Turn something somebody said into something somebody does.
 *
 * Three properties worth stating, because each of them is a thing a shortcut
 * would have got wrong:
 *
 *  - **It goes through `createTaskCore`.** So automations run, the `task.created`
 *    event is emitted, notifications are scheduled and assignee validation
 *    applies — identically to a task typed into a list. That is the Actor
 *    pattern doing its job: the room is a different door, not a different
 *    product.
 *  - **The link back is a message, not a column.** The room gets an ordinary
 *    reply carrying `#[Title](task:id)`, threaded under the message it came
 *    from. So the connection is in the log, visible to everyone, searchable,
 *    and — because the chip resolves live — always showing the task's current
 *    state rather than the state it had when somebody clicked.
 *  - **Both fences, and then the fence between them.** The reader must be in
 *    the room *and* able to write to the list *and* the two must be in the same
 *    community. The third check is not implied by the first two: a person in
 *    two workspaces passes both and would still be moving one tenant's words
 *    into the other's activity log.
 */
export const createTaskFromMessage = mutation({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    eventId: v.string(),
    listId: v.id("lists"),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel } = await requireChannelAccess(
      ctx,
      scope,
      args.channelId,
    );
    const { list, space } = await requireListAccess(ctx, args.listId);
    requireSameTenant(scope, scopeOfSpace(space), "list");

    const source = await eventInRoom(ctx, scope, channel.channelId, args.eventId);
    if (!source) throw new ConvexError("That message is not in this room");

    // The title is the message, shortened, unless somebody typed one. Through
    // `bodyPreview` so mention and reference tokens collapse to their labels:
    // a task called "@[Ada](user_x) can you look at this" is a task nobody can
    // read in a list view.
    const title = (args.title ?? bodyPreview(source.content, 90)).trim();
    if (title.length === 0) throw new ConvexError("A task needs a title");

    const principal = await userPrincipal(ctx, subject);
    const taskId = await createTaskCore(
      ctx,
      {
        listId: list._id,
        title,
        // The full text as the description, so the task carries the sentence
        // that produced it. Not a link back to the event id: an id is not
        // context, and the room may be one somebody later loses access to.
        description: source.content,
      },
      principal.actor,
    );

    await postMessageCore(ctx, scope, channel.channelId, principal, {
      body: taskRefToken(taskId, title),
      parentId: source.eventId,
    });

    return { taskId, listId: list._id };
  },
});

async function eventInRoom(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  channelId: string,
  eventId: string,
): Promise<EventRow | null> {
  const row = await ctx.db
    .query("buzzEvents")
    .withIndex("by_scope_event_id", (q) =>
      q
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("eventId", eventId),
    )
    .first();
  if (!row || row.channelId !== channelId) return null;
  return row.deletedAt === undefined ? row : null;
}

// ---------------------------------------------------------------------------
// Bridge 1d — a room bound to a project
// ---------------------------------------------------------------------------

export type RoomBindingWire = {
  /** True when a binding row exists, whatever this reader may see of it. */
  bound: boolean;
  projectId: string | null;
  projectName: string | null;
  spaceName: string | null;
  boundAt: number | null;
  /** Whether this reader may bind or unbind. */
  mayGovern: boolean;
};

export const roomBinding = query({
  args: { ...scopeArgs, channelId: v.string() },
  handler: async (ctx, args): Promise<RoomBindingWire | null> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    let subject: string;
    try {
      ({ subject } = await requireChannelAccess(ctx, scope, args.channelId));
    } catch {
      return null;
    }
    const row = await bindingRow(ctx, scope, args.channelId);
    const mayGovern = await mayGovernCommunity(ctx, scope, subject);
    if (!row) {
      return {
        bound: false,
        projectId: null,
        projectName: null,
        spaceName: null,
        boundAt: null,
        mayGovern,
      };
    }
    // The binding row is not the authority on whether the reader may see the
    // project. Work's own check is, and it is asked here rather than trusted —
    // otherwise binding a room would be a way to publish a project's name to
    // everyone who can reach the room.
    try {
      const { project, space } = await requireProjectAccess(ctx, row.projectId);
      return {
        bound: true,
        projectId: project._id,
        projectName: project.name,
        spaceName: space.name,
        boundAt: row.boundAt,
        mayGovern,
      };
    } catch {
      return {
        bound: true,
        projectId: null,
        projectName: null,
        spaceName: null,
        boundAt: row.boundAt,
        mayGovern,
      };
    }
  },
});

/** The projects a room could be bound to: this community's, and only this one's. */
export const bindableProjects = query({
  args: { ...scopeArgs },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    try {
      await requireScopeAccess(ctx, scope);
    } catch {
      return [];
    }
    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", scope.scopeType).eq("parentId", scope.scopeId),
      )
      .collect();
    const out: { projectId: string; name: string; spaceName: string }[] = [];
    for (const space of spaces) {
      if (space.archivedAt !== undefined) continue;
      const projects = await ctx.db
        .query("projects")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      for (const project of projects) {
        if (project.archivedAt !== undefined) continue;
        out.push({
          projectId: project._id,
          name: project.name,
          spaceName: space.name,
        });
      }
    }
    return out;
  },
});

/**
 * Point a room at a project.
 *
 * Governance is the community's, not the room's: binding decides what appears
 * in the room for everyone in it and takes a project's activity across the
 * seam, so it uses the same bar `moderation` and `channels.update` use.
 */
export const bindProject = mutation({
  args: { ...scopeArgs, channelId: v.string(), projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel } = await requireChannelAccess(
      ctx,
      scope,
      args.channelId,
    );
    if (!(await mayGovernCommunity(ctx, scope, subject))) {
      throw new ConvexError("Only an owner or admin can bind a room to a project");
    }
    const { project, space } = await requireProjectAccess(ctx, args.projectId);
    requireSameTenant(scope, scopeOfSpace(space), "project");

    const existing = await bindingRow(ctx, scope, args.channelId);
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        projectId: project._id,
        boundByActorId: subject,
        boundAt: now,
      });
    } else {
      await ctx.db.insert("buzzRoomBindings", {
        ...scope,
        channelId: channel.channelId,
        projectId: project._id,
        boundByActorId: subject,
        boundAt: now,
      });
    }

    // Into Work's log, because binding is a fact about the project as much as
    // about the room — and it is the shape of every other cross-side write
    // here: one row in a table that already exists, never a Chat-side copy.
    await emitEvent(ctx, {
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      type: "chat.room_bound",
      actor: (await userPrincipal(ctx, subject)).actor,
      entityType: "project",
      entityId: project._id,
      entityTitle: project.name,
      payload: { channelId: channel.channelId, channelName: channel.name },
    });
    return { projectId: project._id };
  },
});

export const unbindProject = mutation({
  args: { ...scopeArgs, channelId: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireChannelAccess(ctx, scope, args.channelId);
    if (!(await mayGovernCommunity(ctx, scope, subject))) {
      throw new ConvexError("Only an owner or admin can unbind a room");
    }
    const existing = await bindingRow(ctx, scope, args.channelId);
    if (existing) await ctx.db.delete(existing._id);
  },
});

// ---------------------------------------------------------------------------
// Bridge 1e / 3 — the bound project's Work events, read into the room
// ---------------------------------------------------------------------------

export type WorkFeedRow = {
  eventId: string;
  type: string;
  actorName: string;
  actorType: "user" | "agent" | "system";
  entityType: string;
  entityId: string;
  entityTitle?: string;
  listId?: string;
  createdAt: number;
};

/**
 * What has been happening in the project this room is about.
 *
 * A **read**, and that is the whole design. "A channel bound to a project posts
 * that project's task events into the room" is the product sentence; posting
 * them would mean a signed Chat event per Work event — a second copy with its
 * own retention, its own deletion problem, and a guaranteed divergence the
 * first time a task is renamed. Ranging `events` instead means the room shows
 * what Work *currently says* happened, and a task deleted in Work stops being
 * quoted in the room without anybody writing a reconciler.
 *
 * The over-read-then-filter shape is `events.forProject`'s, for the same
 * reason it gives: most of a scope's events belong to other projects, so a
 * window of `limit` would usually come back empty.
 */
export const roomWorkFeed = query({
  args: { ...scopeArgs, channelId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<WorkFeedRow[]> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    try {
      await requireChannelAccess(ctx, scope, args.channelId);
    } catch {
      return [];
    }
    const row = await bindingRow(ctx, scope, args.channelId);
    if (!row) return [];
    // Work's check, on the project, for this reader — not the binder. A room
    // full of people does not make a private project readable.
    let listIds: Set<string>;
    try {
      const { project } = await requireProjectAccess(ctx, row.projectId);
      const lists = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "project").eq("parentId", project._id),
        )
        .collect();
      listIds = new Set(lists.map((l) => l._id as string));
    } catch {
      return [];
    }

    const want = Math.min(args.limit ?? 12, MAX_WORK_FEED);
    const recent = await ctx.db
      .query("events")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId),
      )
      .order("desc")
      .take(Math.max(want * 20, 200));

    return recent
      .filter(
        (e) =>
          (e.listId !== undefined && listIds.has(e.listId)) ||
          (e.entityType === "project" && e.entityId === row.projectId),
      )
      .slice(0, want)
      .map((e) => ({
        eventId: e._id,
        type: e.type,
        actorName: e.actorName,
        actorType: e.actorType,
        entityType: e.entityType,
        entityId: e.entityId,
        ...(e.entityTitle !== undefined ? { entityTitle: e.entityTitle } : {}),
        ...(e.listId !== undefined ? { listId: e.listId as string } : {}),
        createdAt: e.createdAt,
      }));
  },
});

/**
 * A room message that names a Work object, recorded in Work's activity log.
 *
 * Called from `postMessageCore` — the one place anything is said in a room —
 * and deliberately **only** for messages carrying a reference. Work's feed is
 * about Work objects: an event per chat message would bury it under a
 * conversation, and Chat already has a log of its own that is better at being
 * one. A message that names a task is the moment the two dashboards actually
 * touch, and that is the moment worth recording on both sides.
 *
 * No content is copied beyond the preview the feed needs to be readable, and
 * the preview is derived from the body at write time exactly as `messages.refs`
 * is — this is an activity record, not a second copy of the message.
 */
export async function emitForBridgedMessage(
  ctx: MutationCtx,
  scope: Scope,
  channel: { channelId: string; name: string },
  row: { eventId: string; pubkey: string; content: string },
  refs: readonly { kind: string; id: string; label: string }[],
): Promise<void> {
  if (refs.length === 0) return;
  const author = await describePubkey(ctx, row.pubkey);
  const actor: Actor = {
    type: author?.isAgent ? "agent" : "user",
    id: author?.id ?? row.pubkey,
    name: author?.name ?? "Someone",
  };
  for (const ref of refs.slice(0, 4)) {
    await emitEvent(ctx, {
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      type: "chat.reference",
      actor,
      entityType: ref.kind,
      entityId: ref.id,
      entityTitle: ref.label,
      ...(ref.kind === "list" && ctx.db.normalizeId("lists", ref.id)
        ? { listId: ctx.db.normalizeId("lists", ref.id) as Id<"lists"> }
        : {}),
      payload: {
        channelId: channel.channelId,
        channelName: channel.name,
        eventId: row.eventId,
        preview: bodyPreview(row.content, 120),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Bridge 2 — one inbox
// ---------------------------------------------------------------------------

/**
 * A room mention, resolved for the Inbox.
 *
 * Called by the one branch C12 adds to `mentions.feedForCurrent`. It lives here
 * rather than there so the Work file's diff is three lines and so the room key
 * grammar stays in one place — `mentions.parentId` is a bare string, and the
 * two ends of that string agreeing is what makes the deep link work.
 *
 * Note what it does **not** do: it does not check whether the reader may see
 * the room. It is answering about a mention row addressed to that reader by
 * name — the fact that they were named is already theirs. Losing access to a
 * room later is not a reason to make their own inbox unreadable, and the link
 * refuses on arrival like every other Chat route.
 */
export async function resolveRoomMention(
  ctx: QueryCtx,
  parentId: string,
): Promise<{ href: string; label: string }> {
  const parsed = parseRoomKey(parentId);
  if (!parsed) return { href: "/chat", label: "Chat" };
  const channel = await ctx.db
    .query("buzzChannels")
    .withIndex("by_scope_channel", (q) =>
      q
        .eq("scopeType", parsed.scope.scopeType)
        .eq("scopeId", parsed.scope.scopeId)
        .eq("channelId", parsed.channelId),
    )
    .unique();
  return {
    href: `/chat/c/${parsed.channelId}`,
    label: channel
      ? channel.channelType === "dm"
        ? "Direct message"
        : `#${channel.name}`
      : "Chat",
  };
}

// ---------------------------------------------------------------------------
// Bridge 4 — one fleet, made visible
// ---------------------------------------------------------------------------

export type FleetMember = {
  agentId: string;
  name: string;
  status: "active" | "paused";
  /** What it is doing in Work, if anything. Read from `agents`, live. */
  workTaskId: string | null;
  workTaskTitle: string | null;
  workListId: string | null;
  statusText: string | null;
  lastSeenAt: number | null;
  /** Which rooms it is mid-turn in right now. Read from `buzzTurns`, live. */
  rooms: { channelId: string; channelName: string }[];
  /** Whether it is a member of the room this was asked about. */
  inThisRoom: boolean;
};

/** A turn older than this is a harness that crashed, not an agent working. */
const TURN_LIVE_WINDOW_MS = 3 * 60_000;

/**
 * The fleet, seen from both sides at once.
 *
 * After C6 there is one agent identity and one set of governance controls, so
 * this phase is surfacing rather than plumbing — and the surfacing is the
 * point. "Scout is on Payroll rewrite" and "Scout is answering in #billing" are
 * two halves of one sentence, and until they are drawn together the shared
 * fleet is a claim in a design document.
 *
 * Both halves are reads of the rows that already hold them: `agents.currentTaskId`
 * (written by the Work claim path) and `buzzTurns` (written by the Chat turn
 * path). Neither is copied into the other.
 */
export const fleet = query({
  args: { ...scopeArgs, channelId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<FleetMember[]> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    try {
      await requireScopeAccess(ctx, scope);
    } catch {
      return [];
    }

    const agents = await ctx.db
      .query("agents")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", scope.scopeType).eq("parentId", scope.scopeId),
      )
      .collect();
    if (agents.length === 0) return [];

    const now = Date.now();
    const channelNames = new Map<string, string>();
    const rooms = new Map<string, { channelId: string; channelName: string }[]>();
    for (const agent of agents) {
      // `by_agent` ranged on the recency window rather than a scope-wide state
      // index: "everything this agent is doing, anywhere" is the index Chat
      // already has, and one bounded range per agent is cheaper than an index
      // that would have to be added and backfilled for a strip of chips.
      rooms.set(
        agent._id,
        await liveRoomsFor(ctx, scope, agent._id, now, channelNames),
      );
    }

    const members = new Set<string>();
    if (args.channelId) {
      const rows = await ctx.db
        .query("buzzMemberships")
        .withIndex("by_channel", (q) =>
          q
            .eq("scopeType", scope.scopeType)
            .eq("scopeId", scope.scopeId)
            .eq("channelId", args.channelId as string)
            .eq("removedAt", undefined),
        )
        .collect();
      for (const row of rows) members.add(row.actorId);
    }

    const out: FleetMember[] = [];
    for (const agent of agents) {
      let taskTitle: string | null = null;
      let listId: string | null = null;
      if (agent.currentTaskId) {
        // Work's own check, on the reader — an agent working a task in a space
        // this person cannot reach must not name it here.
        try {
          const { task, list } = await requireTaskAccess(ctx, agent.currentTaskId);
          taskTitle = task.title;
          listId = list._id;
        } catch {
          taskTitle = null;
        }
      }
      out.push({
        agentId: agent._id,
        name: agent.name,
        status: agent.status,
        workTaskId: taskTitle ? (agent.currentTaskId as string) : null,
        workTaskTitle: taskTitle,
        workListId: listId,
        statusText: agent.statusText ?? null,
        lastSeenAt: agent.lastSeenAt ?? null,
        rooms: rooms.get(agent._id) ?? [],
        inThisRoom: members.has(agent._id),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * Which rooms is one agent live in, right now.
 *
 * One bounded index range on `by_agent` over the liveness window: a turn nobody
 * has heard from in three minutes can never resume, so it falls out of the read
 * on its own with no sweeper and no write. Terminal states are filtered after,
 * over a window rather than over the table.
 */
async function liveRoomsFor(
  ctx: QueryCtx,
  scope: Scope,
  agentId: string,
  now: number,
  channelNames: Map<string, string>,
): Promise<{ channelId: string; channelName: string }[]> {
  const turns = await ctx.db
    .query("buzzTurns")
    .withIndex("by_agent", (q) =>
      q
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("agentId", agentId)
        .gte("lastActivityAt", now - TURN_LIVE_WINDOW_MS),
    )
    .take(40);
  const out: { channelId: string; channelName: string }[] = [];
  for (const turn of turns) {
    if (turn.state !== "started" && turn.state !== "streaming") continue;
    if (out.some((r) => r.channelId === turn.channelId)) continue;
    if (!channelNames.has(turn.channelId)) {
      const channel = await ctx.db
        .query("buzzChannels")
        .withIndex("by_scope_channel", (q) =>
          q
            .eq("scopeType", scope.scopeType)
            .eq("scopeId", scope.scopeId)
            .eq("channelId", turn.channelId),
        )
        .unique();
      channelNames.set(turn.channelId, channel?.name ?? "a room");
    }
    out.push({
      channelId: turn.channelId,
      channelName: channelNames.get(turn.channelId) ?? "a room",
    });
  }
  return out;
}

/**
 * The other direction: which rooms is *this* agent live in?
 *
 * Mounted on the Work-side agent page, so "vice versa" is a real surface rather
 * than a symmetry claimed in a comment. Access is the agent's own scope, which
 * is the same fence its detail page already stands behind.
 */
export const agentRooms = query({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const agent = await ctx.db.get(agentId);
    if (!agent) return [];
    const scope: Scope = { scopeType: agent.parentType, scopeId: agent.parentId };
    try {
      await requireScopeAccess(ctx, scope);
    } catch {
      return [];
    }
    return await liveRoomsFor(ctx, scope, agentId, Date.now(), new Map());
  },
});

// ---------------------------------------------------------------------------
// The badge — the single number that makes two modes read as one product
// ---------------------------------------------------------------------------

export type SwitcherCounts = {
  work: number;
  chat: number;
  workMentions: number;
  workUpdates: number;
  workApprovals: number;
  chatRoomMentions: number;
  chatUpdates: number;
};

/**
 * How much is waiting on each side.
 *
 * The partition is `src/lib/buzz/bridge.partitionCounts` and its rule is: a
 * thing belongs to the side it **happened on**, never to the table it landed
 * in. A Chat mention writes a row in Work's `mentions` table — that is the
 * unified inbox and it is deliberate — and it still counts on the Chat side,
 * because opening the room is what makes it stop needing you. Counting it on
 * both would make the two badges add up to more than the number of things that
 * have happened, which is the failure people notice immediately and never trust
 * again.
 *
 * Every input is a bounded read of a queue that already exists. Nothing here
 * maintains a counter, because a counter is a store, and a badge disagreeing
 * with the list it summarises is the classic denormalization bug.
 */
export const switcherCounts = query({
  args: {},
  handler: async (ctx): Promise<SwitcherCounts> => {
    const identity = await ctx.auth.getUserIdentity();
    const empty: SwitcherCounts = {
      work: 0,
      chat: 0,
      workMentions: 0,
      workUpdates: 0,
      workApprovals: 0,
      chatRoomMentions: 0,
      chatUpdates: 0,
    };
    if (!identity) return empty;
    const subject = identity.subject;

    const mentions = await ctx.db
      .query("mentions")
      .withIndex("by_user", (q) => q.eq("mentionedClerkId", subject))
      .collect();
    let workMentions = 0;
    for (const row of mentions) {
      if (row.readAt) continue;
      // The room-parented ones are Chat's, and Chat counts them from its own
      // read state below — where they clear when the room is opened.
      if (row.parentType === "room") continue;
      workMentions += 1;
    }

    const updates = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userClerkId", subject))
      .order("desc")
      .take(BADGE_SCAN);
    let workUpdates = 0;
    let chatUpdates = 0;
    for (const row of updates) {
      if (row.readAt !== undefined) continue;
      if (isChatNotification(row.type)) chatUpdates += 1;
      else workUpdates += 1;
    }

    const workApprovals = await countApprovals(ctx);

    // Chat's own number, from Chat's own read state, per community the reader
    // belongs to. `unreadForChannels` is the function the rail draws from, so
    // the badge and the rail cannot disagree.
    let chatRoomMentions = 0;
    for (const scope of await scopesFor(ctx, subject)) {
      chatRoomMentions += await roomMentionsIn(ctx, scope, subject);
    }

    return {
      work: workMentions + workUpdates + workApprovals,
      chat: chatRoomMentions + chatUpdates,
      workMentions,
      workUpdates,
      workApprovals,
      chatRoomMentions,
      chatUpdates,
    };
  },
});

async function scopesFor(ctx: QueryCtx, subject: string): Promise<Scope[]> {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userClerkId", subject))
    .collect();
  const out: Scope[] = [{ scopeType: "user", scopeId: subject }];
  for (const m of memberships) {
    const workspace = await ctx.db.get(m.workspaceId);
    if (workspace && workspace.suspendedAt === undefined) {
      out.push({ scopeType: "workspace", scopeId: workspace._id });
    }
  }
  return out;
}

async function roomMentionsIn(
  ctx: QueryCtx,
  scope: Scope,
  subject: string,
): Promise<number> {
  const pubkey = await pubkeyFor(ctx, "user", subject);
  if (!pubkey) return 0;
  const memberships = await ctx.db
    .query("buzzMemberships")
    .withIndex("by_actor", (q) =>
      q
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("actorId", subject)
        .eq("removedAt", undefined),
    )
    .collect();
  if (memberships.length === 0) return 0;

  const inputs: {
    channelId: string;
    channelType: "stream" | "forum" | "dm";
    lastActivityAt: number;
    joined: boolean;
  }[] = [];
  for (const membership of memberships) {
    if (membership.hiddenAt !== undefined) continue;
    const channel = await ctx.db
      .query("buzzChannels")
      .withIndex("by_scope_channel", (q) =>
        q
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId)
          .eq("channelId", membership.channelId),
      )
      .unique();
    if (!channel) continue;
    inputs.push({
      channelId: channel.channelId,
      channelType: channel.channelType,
      lastActivityAt: channel.lastActivityAt,
      joined: true,
    });
  }
  const unread = await unreadForChannels(ctx, scope, pubkey, inputs);
  let total = 0;
  for (const entry of unread.values()) total += entry.mentions;
  return total;
}

/**
 * Tasks gated on this reader's approval.
 *
 * `tasks.pendingApprovals` answers the same question and is a query, so it
 * cannot be called from one. This is the same index range and the same
 * `requireTaskAccess` per row — a read of the same source, not a second
 * definition of what an approval is. It counts rather than resolving, so it is
 * strictly cheaper than the list the Inbox already draws.
 */
async function countApprovals(ctx: QueryCtx): Promise<number> {
  const gated = await ctx.db
    .query("tasks")
    .withIndex("by_approval", (q) => q.eq("requiresApproval", true))
    .take(BADGE_SCAN);
  let count = 0;
  for (const task of gated) {
    if (task.approvedAt !== undefined) continue;
    const status = await ctx.db.get(task.statusId);
    if (status?.category === "complete" || status?.category === "closed") continue;
    try {
      await requireTaskAccess(ctx, task._id);
    } catch {
      continue;
    }
    count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Bridge 3 — one search
// ---------------------------------------------------------------------------

export type UnifiedHit =
  | { kind: "message"; id: string; label: string; context: string; href: string }
  | { kind: "task"; id: string; label: string; context: string; href: string }
  | { kind: "page"; id: string; label: string; context: string; href: string }
  | { kind: "room"; id: string; label: string; context: string; href: string };

/**
 * One search across both dashboards.
 *
 * Four sources, each queried through its own side's own function: Chat's
 * `searchMessagesCore` (which owns the searchable-kind allowlist and the
 * per-event read gates) and `listChannelsCore` (which owns the room visibility
 * rule), and Work's tasks and pages, filtered by `_authz`. The point of calling
 * four rather than building an index is that an index over both would be a
 * fifth store with a fifth copy of every visibility rule — and search is the
 * single worst place for one to be missing, because an index answers instantly
 * and confidently and nothing in a result row says which gate it skipped.
 *
 * Scoped to one community at a time, because that is what the ⌘K palette knows
 * and because a cross-community search is a read that skips the tenancy fence
 * by construction.
 */
export const search = query({
  args: { ...scopeArgs, text: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<UnifiedHit[]> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const text = args.text.trim();
    if (text.length < 2) return [];
    let subject: string;
    try {
      ({ subject } = await requireScopeAccess(ctx, scope));
    } catch {
      return [];
    }
    const limit = Math.min(args.limit ?? MAX_SEARCH_HITS, MAX_SEARCH_HITS);
    const out: UnifiedHit[] = [];

    const messages = await searchMessagesCore(
      ctx,
      scope,
      { actorType: "user", actorId: subject },
      { text, limit },
    );
    for (const hit of messages.hits.slice(0, limit)) {
      out.push({
        kind: "message",
        id: hit.eventId,
        label: messageLabel(hit),
        context: hit.channelName ? `#${hit.channelName}` : "Chat",
        href: `/chat/c/${hit.channelId}?m=${hit.eventId}`,
      });
    }

    const needle = text.toLowerCase();

    // Rooms — the kind this union declared from the start and nothing emitted,
    // so ⌘K could find what was said in `#design` but not `#design`.
    //
    // Through `listChannelsCore` rather than a walk of `buzzChannels`, for the
    // reason that function's own comment gives: it is what the rail draws, so
    // the visibility rule, the hidden-DM rule and the archived rule are the
    // ones already in use rather than a second copy that can forget a clause.
    // Search is where a forgotten clause hurts most — a private room surfacing
    // in a palette announces that it exists, which is the whole thing
    // `requireChannelAccess` refuses to say. It is also the query the Chat
    // sidebar holds open continuously, so this is not a new cost class.
    //
    // Listed above tasks and pages because a room is what a two-word query
    // usually means: "design" is far more often the place than a task with the
    // word in its title.
    const rooms = await listChannelsCore(ctx, scope, {
      actorType: "user",
      actorId: subject,
    });
    let roomHits = 0;
    for (const room of rooms) {
      if (roomHits >= limit) break;
      // Both names, because they are different strings and people reach for
      // either: a room is `release-notes` in the URL and "Release notes" on
      // screen, and a DM has no name of its own at all.
      if (
        !room.name.toLowerCase().includes(needle) &&
        !room.displayName.toLowerCase().includes(needle)
      ) {
        continue;
      }
      const direct = room.kind === "dm" || room.kind === "group_dm";
      out.push({
        kind: "room",
        id: room.channelId,
        label: direct ? room.displayName || room.name : `#${room.name}`,
        context: direct
          ? "Direct message"
          : room.kind === "forum"
            ? "Forum"
            : "Channel",
        href: `/chat/c/${room.channelId}`,
      });
      roomHits += 1;
    }

    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", scope.scopeType).eq("parentId", scope.scopeId),
      )
      .collect();
    for (const space of spaces) {
      if (space.archivedAt !== undefined) continue;
      if (out.filter((h) => h.kind === "task").length >= limit) break;
      const lists = await listsInSpace(ctx, space);
      for (const list of lists) {
        if (out.filter((h) => h.kind === "task").length >= limit) break;
        const tasks = await ctx.db
          .query("tasks")
          .withIndex("by_list", (q) => q.eq("listId", list._id))
          .collect();
        for (const task of tasks) {
          if (!task.title.toLowerCase().includes(needle)) continue;
          out.push({
            kind: "task",
            id: task._id,
            label: task.title,
            context: list.name,
            href: `/dashboard/l/${list._id}/t/${task._id}`,
          });
          if (out.filter((h) => h.kind === "task").length >= limit) break;
        }
      }
    }

    const pages = await ctx.db
      .query("pages")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId),
      )
      .collect();
    for (const page of pages) {
      if (page.archivedAt !== undefined) continue;
      if (!page.title.toLowerCase().includes(needle)) continue;
      out.push({
        kind: "page",
        id: page._id,
        label: page.title,
        context: "Page",
        href: `/dashboard/pages/${page._id}`,
      });
      if (out.filter((h) => h.kind === "page").length >= limit) break;
    }

    return out;
  },
});

function messageLabel(hit: SearchHit): string {
  const text = bodyPreview(hit.content, 90);
  return text || "(no text)";
}

async function listsInSpace(
  ctx: QueryCtx,
  space: Doc<"spaces">,
): Promise<Doc<"lists">[]> {
  const bare = await ctx.db
    .query("lists")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", "space").eq("parentId", space._id),
    )
    .collect();
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_space", (q) => q.eq("spaceId", space._id))
    .collect();
  const out = [...bare];
  for (const project of projects) {
    if (project.archivedAt !== undefined) continue;
    out.push(
      ...(await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "project").eq("parentId", project._id),
        )
        .collect()),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Where a message becomes a task: the lists this reader may write to
// ---------------------------------------------------------------------------

/**
 * The lists a room's message could become a task in.
 *
 * Narrowed to the room's own community by construction rather than by a filter
 * — the query only ever walks that scope's spaces — so the tenancy fence is not
 * something the picker has to remember. If the room is bound to a project, that
 * project's lists come first, because that is what the binding is for.
 */
export const targetLists = query({
  args: { ...scopeArgs, channelId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    try {
      await requireScopeAccess(ctx, scope);
    } catch {
      return [];
    }
    const identity = await requireIdentity(ctx);
    const boundProjectId = args.channelId
      ? (await bindingRow(ctx, scope, args.channelId))?.projectId
      : undefined;

    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", scope.scopeType).eq("parentId", scope.scopeId),
      )
      .collect();
    const out: {
      listId: string;
      name: string;
      context: string;
      preferred: boolean;
    }[] = [];
    for (const space of spaces) {
      if (space.archivedAt !== undefined) continue;
      if (!(await canAccessSpace(ctx, space, identity))) continue;
      const bare = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();
      for (const list of bare) {
        out.push({
          listId: list._id,
          name: list.name,
          context: space.name,
          preferred: false,
        });
      }
      const projects = await ctx.db
        .query("projects")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      for (const project of projects) {
        if (project.archivedAt !== undefined) continue;
        const lists = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "project").eq("parentId", project._id),
          )
          .collect();
        for (const list of lists) {
          out.push({
            listId: list._id,
            name: list.name,
            context: project.name,
            preferred: project._id === boundProjectId,
          });
        }
      }
    }
    return out.sort(
      (a, b) =>
        Number(b.preferred) - Number(a.preferred) || a.name.localeCompare(b.name),
    );
  },
});

/** Kept beside `getSpaceForList` so the two ways of naming a scope stay one. */
export async function scopeForListId(
  ctx: QueryCtx,
  listId: Id<"lists">,
): Promise<Scope | null> {
  const list = await ctx.db.get(listId);
  if (!list) return null;
  const space = await getSpaceForList(ctx, list);
  return space ? scopeOfSpace(space) : null;
}
