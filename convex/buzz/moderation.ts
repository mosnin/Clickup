// Moderation: the one surface where the audit trail is the product.
//
// Everything else in Chat is built so the record and the effect are the same
// object — a message *is* its event, a removal *is* a 9005. Moderation is the
// exception, on purpose (§6.1): a report and a moderator's decision are
// **private structural state**, filed into tables this module owns and never
// published to the log. Two reasons, both load bearing:
//
//   • **A report is a signal, never a trigger.** Reporting somebody must not
//     itself publish anything. A 1984 in the log would be an event the reported
//     author can read, and the reporter's identity would then be one query bug
//     away from reaching them. It cannot leak through a future bug because it
//     was never in the public store. That is exactly why kinds 1984 and
//     9040–9044 are `handled: true` in `_kinds.ts` and `publishCore` refuses
//     them outright — this module is what "handled" means for them.
//   • **A decision has to outlive the thing it was about.** The message is
//     removed, the author rotates a key, the room is archived; the row saying
//     who did what to whom and why is still there, append-only, never updated
//     and never pruned.
//
// ## What a moderator can and cannot see
//
// This is the invariant to hold on to, because a moderation queue is the
// easiest place in a product to build a read-anything backdoor and call it
// accountability.
//
//   • **CAN**: that a report exists, who filed it, the category they chose, the
//     note they wrote, and the whole audit trail of acts — for every target
//     they were already entitled to read.
//   • **CANNOT**: the content of a reported event they could not otherwise
//     read, and the *existence* of the room it lives in. Every queue read runs
//     the same two gates every other read in the application runs —
//     `channels.resolveChannelForActor` for the room, `log.eventVisibleToReader`
//     for the event — and a report that fails either is **withheld entirely**
//     rather than redacted. Redacting still hands over `channelId`, and a
//     channel id is the room's identity: telling a community admin "there is a
//     report in a room you are not in" leaks precisely what
//     `resolveChannelForActor` exists to protect ("whether a private room
//     called #acquisition exists is itself the information being protected").
//
//     What the queue does report is a **count** of what it withheld, which
//     leaks a number and nothing else. Silence would be worse: a moderator
//     would read an empty queue as "nothing to do" when the honest answer is
//     "two things, and not for you". A private room's own owners and admins are
//     still its moderators through `messages.remove`, and `escalate` is the
//     lane out of community discretion for anything neither can reach.
//
// There is no "moderator override" branch anywhere in this file, and its
// absence is the design. A branch like that turns one role into a reader of
// every private room in the workspace, and it is never written as one — it
// arrives as a convenience in a query nobody re-reads.
//
// ## Who may moderate
//
// `channels.mayGovernCommunity`, imported rather than restated. 9040–9044 carry
// no `h` tag — they are community-wide commands — so "may this person ban
// somebody here" is exactly "may this person govern this community", which that
// function already answers. Guard rails on top (§6.2): an admin cannot act on
// an owner or on another admin, and nobody may act on themselves.
//
// The vocabulary (categories, statuses, actions, severity, the timeout parse
// contract) lives in `src/lib/buzz/moderation.ts` and is imported, not copied —
// the same arrangement `notifications.ts` has with `notify.ts`, for the same
// reason: a ranking that disagreed between the screen and the server would put
// the wrong report at the top and leave no error behind.
//
// Spec: docs/buzz-parity/03-workflows-projects.md §6.

import { ConvexError, v } from "convex/values";
import { defineTable } from "convex/server";
import { mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireScopeAccess } from "../_authz";
import { mayGovernCommunity, resolveChannelForActor } from "./channels";
import { describePubkey, principalForPubkey, pubkeyFor } from "./identity";
import { asRelay } from "./relay";
import { eventVisibleToReader, publishCore, type EventRow, type Scope } from "./log";
import {
  QUEUE_ACTIONS,
  REPORT_TYPES,
  RESOLUTION_ACTIONS,
  reportStatusForAction,
  type ModerationAction as ModerationActionContract,
  type ModerationReport as ModerationReportContract,
  type CommunityRestriction as CommunityRestrictionContract,
  type ReportType,
  type ResolutionAction,
} from "../../src/lib/buzz/moderation";

// ---------------------------------------------------------------------------
// The kinds this module handles rather than stores
// ---------------------------------------------------------------------------

/** NIP-09 / NIP-29 removal. The record that a message was taken down. */
const KIND_NIP29_DELETE_EVENT = 9005;
/** The room's own state row. Relay-signed: a member must not be able to forge it. */
const KIND_SYSTEM_MESSAGE = 40099;

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * The three tables §6 needs, declared here rather than in `_tables.ts`.
 *
 * Same reason `buzzNotificationTables` is: `_tables.ts` is the one file every
 * Chat phase touches, and a schema edit from this one would be a merge conflict
 * in it. Folding them in is `...buzzModerationTables` beside `...buzzTables` in
 * `convex/schema.ts` and nothing else — no migration, because there are no rows
 * yet.
 *
 * None of the three is part of the signed log, and that is the point rather
 * than an implementation detail (see the header).
 */
export const buzzModerationTables = {
  /**
   * One report. Private: `reporterPubkey` is visible to moderators and **must
   * never reach any surface the reported author can see** (§6.4). It is read by
   * exactly one query in this file, which is moderator-gated, and by nothing
   * else in the codebase. Accountability runs both ways to moderators, never to
   * the reported party.
   */
  buzzModerationReports: defineTable({
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    reporterPubkey: v.string(),
    targetKind: v.union(v.literal("event"), v.literal("pubkey"), v.literal("blob")),
    /** An event id, a pubkey, or a blob hash — read together with `targetKind`. */
    target: v.string(),
    /**
     * Derived from the target event's stored row at ingest, **never from the
     * client**. Absent for pubkey and blob targets, which are not room-scoped.
     */
    channelId: v.optional(v.string()),
    /**
     * One of `REPORT_TYPES`, validated on the way in and stored as a string, so
     * a category added by a newer build cannot make an older row unreadable.
     */
    reportType: v.string(),
    /** The reporter's note to moderators. Never shown to the reported author. */
    note: v.optional(v.string()),
    status: v.string(),
    resolvedByPubkey: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    /** The audit row that carried the decision out. */
    actionId: v.optional(v.id("buzzModerationActions")),
    createdAt: v.number(),
  })
    // The queue's read: newest first, inside one community.
    .index("by_scope_created", ["scopeType", "scopeId", "createdAt"])
    // Idempotence: one reporter, one target, one open report.
    .index("by_reporter_target", [
      "scopeType",
      "scopeId",
      "reporterPubkey",
      "targetKind",
      "target",
    ])
    .index("by_scope_target", ["scopeType", "scopeId", "targetKind", "target"]),

  /**
   * The audit trail. **Append-only** in the strongest sense available: nothing
   * in this module patches or deletes one of these rows, and retention
   * (`maintenance.prune`) does not know the table. A moderation record that
   * could be pruned is a record that disappears exactly when somebody asks for
   * it.
   */
  buzzModerationActions: defineTable({
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    actorPubkey: v.string(),
    /** `ban` | `unban` | `timeout` | `untimeout` | `delete` | `resolve:<action>`. */
    action: v.string(),
    targetPubkey: v.optional(v.string()),
    targetEventId: v.optional(v.string()),
    channelId: v.optional(v.string()),
    reasonCode: v.optional(v.string()),
    /** Sanitized. This is the half that reaches the room's tombstone. */
    publicReason: v.optional(v.string()),
    /** Moderator-only. Never leaves this module's gated queries. */
    privateReason: v.optional(v.string()),
    /**
     * The principal behind `actorPubkey` *at the time of the act*. The audit
     * trail is the one place a historical identity matters more than a current
     * one: key rotation must not re-attribute a decision somebody else made.
     */
    matchedPrincipal: v.optional(v.string()),
    reportId: v.optional(v.id("buzzModerationReports")),
    createdAt: v.number(),
  })
    .index("by_scope_created", ["scopeType", "scopeId", "createdAt"])
    .index("by_scope_target", ["scopeType", "scopeId", "targetPubkey"]),

  /**
   * The live restriction, one row per (community, pubkey).
   *
   * Kept and flipped rather than deleted when a restriction is lifted (see
   * `unban`): "banned in March, lifted in April" is a sentence an audit trail
   * has to be able to say, and a deleted row says nothing. Expiry is **derived**
   * (`restrictionState`), never swept, so a missed cron cannot hold somebody
   * past their sentence.
   */
  buzzCommunityRestrictions: defineTable({
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    pubkey: v.string(),
    banned: v.boolean(),
    /** Unix **seconds**, matching the `expiration` tag. Absent = permanent. */
    banExpiresAt: v.optional(v.number()),
    banReason: v.optional(v.string()),
    /** Unix seconds. A write-block with a stated end. */
    mutedUntil: v.optional(v.number()),
    muteReason: v.optional(v.string()),
    actorPubkey: v.string(),
    updatedAt: v.number(),
  })
    .index("by_scope_pubkey", ["scopeType", "scopeId", "pubkey"])
    .index("by_scope", ["scopeType", "scopeId"]),
};

type RestrictionRow = Doc<"buzzCommunityRestrictions">;
type ReportId = Id<"buzzModerationReports">;
type ActionId = Id<"buzzModerationActions">;

// ---------------------------------------------------------------------------
// Argument validators, built from the shared vocabulary
// ---------------------------------------------------------------------------

const scopeArgs = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

/**
 * Validated against the exported vocabulary rather than retyped.
 *
 * A literal union written out by hand is a second copy of the list, and the day
 * a category is added the mutation refuses a value the dialog just offered.
 */
function isReportType(value: string): value is ReportType {
  return (REPORT_TYPES as readonly string[]).includes(value);
}
function isResolutionAction(value: string): value is ResolutionAction {
  return (RESOLUTION_ACTIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Authority (§6.2)
// ---------------------------------------------------------------------------

export type CommunityRole = "owner" | "admin" | "member";

/**
 * Somebody's standing in this community.
 *
 * Read off the workspace roster the rest of the app already uses, never a
 * moderation-specific table: a second roster is a second answer to "who is an
 * admin here", and the day the two disagree the person who was demoted still
 * has the ban button.
 *
 * An agent is always `member`. Agents are not in `memberships`, and an agent
 * holding community moderation authority would be an agent that can silence the
 * people who govern it.
 */
async function communityRoleOf(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  principal: { type: "user" | "agent"; id: string } | null,
): Promise<CommunityRole> {
  if (!principal || principal.type !== "user") return "member";
  if (scope.scopeType === "user") {
    return scope.scopeId === principal.id ? "owner" : "member";
  }
  const workspaceId = ctx.db.normalizeId("workspaces", scope.scopeId);
  if (!workspaceId) return "member";
  const workspace = await ctx.db.get(workspaceId);
  if (workspace?.ownerClerkId === principal.id) return "owner";
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q.eq("userClerkId", principal.id).eq("workspaceId", workspaceId),
    )
    .unique();
  if (membership?.role === "owner") return "owner";
  if (membership?.role === "admin") return "admin";
  return "member";
}

type Moderator = { subject: string; pubkey: string; role: CommunityRole };

/**
 * The moderator gate: tenancy fence first, then governance.
 *
 * Returns the moderator's own pubkey too, because every read below needs it for
 * `eventVisibleToReader` and every write needs it for the audit row. A
 * moderator who has not opened Chat yet reads as `""`, which is nobody — the
 * gated kinds are simply not there for them, which is the right answer rather
 * than an error state.
 */
async function requireModerator(ctx: QueryCtx | MutationCtx, scope: Scope): Promise<Moderator> {
  const { subject } = await requireScopeAccess(ctx, scope);
  if (!(await mayGovernCommunity(ctx, scope, subject))) {
    // Not "not found": the caller is already inside the community, so the
    // existence of a queue is not the secret. Its contents are.
    throw new ConvexError("Only this community's owners and admins can moderate");
  }
  return {
    subject,
    pubkey: (await pubkeyFor(ctx, "user", subject)) ?? "",
    role: await communityRoleOf(ctx, scope, { type: "user", id: subject }),
  };
}

/**
 * §6.2's guard rails, in the order they fail.
 *
 * The first is not politeness: a moderator who could act on themselves could
 * lift their own ban, which turns a restriction into a suggestion. The second
 * is what keeps one compromised admin account from removing the people who
 * could stop it.
 */
async function assertMayActOn(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  actor: Moderator,
  targetPubkey: string,
): Promise<void> {
  if (targetPubkey === actor.pubkey) throw new ConvexError("You cannot moderate yourself");
  const target = await principalForPubkey(ctx, targetPubkey);
  const targetRole = await communityRoleOf(ctx, scope, target);
  if (targetRole === "owner") {
    throw new ConvexError("This community's owner cannot be restricted");
  }
  if (actor.role === "admin" && targetRole === "admin") {
    throw new ConvexError("An admin cannot restrict another admin");
  }
}

// ---------------------------------------------------------------------------
// Reachability: the gates every read in this file runs
// ---------------------------------------------------------------------------

async function eventById(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  eventId: string,
): Promise<EventRow | null> {
  return await ctx.db
    .query("buzzEvents")
    .withIndex("by_scope_event_id", (q) =>
      q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("eventId", eventId),
    )
    .first();
}

/**
 * May this reader reach this event at all?
 *
 * Both halves, always, in this order: the **room** (`resolveChannelForActor`,
 * which refuses a room the reader may not even know exists) and then the
 * **event** (`eventVisibleToReader`, the one per-event gate every read surface
 * in the application runs). A moderation queue that ran neither would be a
 * read-anything endpoint; one that ran only the second would still hand over
 * the fact that a private room exists.
 *
 * Returns the row when it is reachable and `null` when it is not — never a
 * partially-populated row, because "here is the report, minus the bits you may
 * not see" is exactly the shape that leaks a channel id.
 */
async function reachableEvent(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  subject: string,
  readerPubkey: string,
  eventId: string,
): Promise<EventRow | null> {
  const row = await eventById(ctx, scope, eventId);
  if (!row) return null;
  if (row.channelId !== undefined) {
    try {
      await resolveChannelForActor(ctx, scope, row.channelId, subject);
    } catch {
      return null;
    }
  }
  return eventVisibleToReader(row, readerPubkey) ? row : null;
}

/** Display names, cached per read: a queue of forty rows is four authors. */
function nameCache(ctx: QueryCtx | MutationCtx): (pubkey: string) => Promise<string> {
  const names = new Map<string, string>();
  return async (pubkey: string) => {
    const cached = names.get(pubkey);
    if (cached !== undefined) return cached;
    const name = (await describePubkey(ctx, pubkey))?.name ?? "Unknown";
    names.set(pubkey, name);
    return name;
  };
}

// ---------------------------------------------------------------------------
// Reporting (§6.1)
// ---------------------------------------------------------------------------

/**
 * File a report. Any member may; nothing is published.
 *
 * Three things this does that a naive version would not:
 *
 *   1. **The channel is derived from the target's stored row, never from the
 *      caller.** A client-supplied `channelId` would let a reporter file
 *      against a room the event is not in — a wrong triage group, and a way to
 *      make a private room's id appear in a queue.
 *   2. **The reporter must be able to reach the target.** Otherwise `report` is
 *      an existence oracle: file against a guessed event id and read the answer.
 *      That is why "not reachable" and "no such event" are the same refusal.
 *   3. **It is idempotent.** One reporter, one target, one open report. Buzz's
 *      dialog resets on open so a stale selection cannot leak into the next
 *      report; the server's half of that is refusing to accumulate five rows
 *      because somebody clicked five times — which would also quintuple the
 *      target's apparent report count during triage.
 */
export const report = mutation({
  args: {
    ...scopeArgs,
    targetKind: v.union(v.literal("event"), v.literal("pubkey"), v.literal("blob")),
    target: v.string(),
    reportType: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ reportId: ReportId; created: boolean }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    if (!isReportType(args.reportType)) throw new ConvexError("Unknown report category");

    const reporterPubkey = await pubkeyFor(ctx, "user", subject);
    if (!reporterPubkey) {
      throw new ConvexError("Open Chat once before reporting — a report is filed as you");
    }
    if (args.target.trim().length === 0) throw new ConvexError("A report needs a target");

    let channelId: string | undefined;
    if (args.targetKind === "event") {
      const row = await reachableEvent(ctx, scope, subject, reporterPubkey, args.target);
      if (!row) throw new ConvexError("That message could not be found");
      if (row.pubkey === reporterPubkey) {
        throw new ConvexError("You cannot report your own message");
      }
      channelId = row.channelId;
    } else if (args.targetKind === "pubkey" && args.target === reporterPubkey) {
      throw new ConvexError("You cannot report yourself");
    }

    const existing = await ctx.db
      .query("buzzModerationReports")
      .withIndex("by_reporter_target", (q) =>
        q
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId)
          .eq("reporterPubkey", reporterPubkey)
          .eq("targetKind", args.targetKind)
          .eq("target", args.target),
      )
      .collect();
    const open = existing.find((row) => row.status === "open");
    if (open) return { reportId: open._id, created: false };

    const reportId = await ctx.db.insert("buzzModerationReports", {
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      reporterPubkey,
      targetKind: args.targetKind,
      target: args.target,
      ...(channelId !== undefined ? { channelId } : {}),
      reportType: args.reportType,
      ...(args.note?.trim() ? { note: args.note.trim() } : {}),
      status: "open",
      createdAt: Date.now(),
    });
    return { reportId, created: true };
  },
});

// ---------------------------------------------------------------------------
// The queue (§6.4)
// ---------------------------------------------------------------------------

export type ModerationQueue = {
  reports: ModerationReportContract[];
  /**
   * How many rows this reader is not entitled to see. A number and nothing
   * else — no room, no author, no category. See the header for why silence
   * would be worse than a count.
   */
  withheld: number;
};

/** How much of a reported message the queue shows. Enough to judge, not to host. */
const PREVIEW_CHARS = 280;

/**
 * The reports this moderator may act on, newest first.
 *
 * Ordering is `createdAt` desc — the index's own order — and the *total* order
 * (severity, then recency, then key) is applied by `groupReports` on the client,
 * which is where the grouping it belongs to lives. The split is deliberate: the
 * server decides **what may be seen**, which is not a presentation question, and
 * the pure module decides **how it is triaged**, which is testable without a
 * database.
 */
export const queue = query({
  args: { ...scopeArgs, status: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<ModerationQueue> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, pubkey } = await requireModerator(ctx, scope);
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    const describe = nameCache(ctx);

    const rows = await ctx.db
      .query("buzzModerationReports")
      .withIndex("by_scope_created", (q) =>
        q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId),
      )
      .order("desc")
      .take(limit);

    const wanted = args.status && args.status !== "all" ? args.status : null;
    const reports: ModerationReportContract[] = [];
    let withheld = 0;

    for (const row of rows) {
      if (wanted && row.status !== wanted) continue;

      let target: EventRow | null = null;
      if (row.targetKind === "event") {
        target = await reachableEvent(ctx, scope, subject, pubkey, row.target);
        if (!target) {
          withheld += 1;
          continue;
        }
      }

      reports.push({
        id: row._id,
        reporterPubkey: row.reporterPubkey,
        reporterName: await describe(row.reporterPubkey),
        targetKind: row.targetKind,
        target: row.target,
        ...(row.channelId !== undefined ? { channelId: row.channelId } : {}),
        reportType: row.reportType,
        ...(row.note !== undefined ? { note: row.note } : {}),
        status: row.status,
        createdAt: row.createdAt,
        ...(row.resolvedAt !== undefined ? { resolvedAt: row.resolvedAt } : {}),
        ...(row.resolvedByPubkey !== undefined
          ? { resolvedByPubkey: row.resolvedByPubkey }
          : {}),
        ...(target
          ? {
              targetPubkey: target.pubkey,
              targetName: await describe(target.pubkey),
              removed: target.deletedAt !== undefined,
              // A removed message shows no preview. The tombstone is the point:
              // the room learns the rules are real without the offence being
              // republished by the act of removing it.
              ...(target.deletedAt === undefined
                ? { preview: target.content.slice(0, PREVIEW_CHARS) }
                : {}),
            }
          : {}),
        ...(row.targetKind === "pubkey"
          ? { targetPubkey: row.target, targetName: await describe(row.target) }
          : {}),
      });
    }

    return { reports, withheld };
  },
});

/**
 * The audit trail. Append-only, and gated exactly like the queue.
 *
 * An audit row naming an event carries its channel, so reading one is a read
 * into a room by another name. The same `reachableEvent` test decides, and an
 * unreachable row is withheld and counted. That is the second half of "the
 * record must not itself become a way to read content the moderator was not
 * entitled to see" — a trail that leaked would be a trail worth attacking.
 */
export const audit = query({
  args: { ...scopeArgs, limit: v.optional(v.number()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ entries: ModerationActionContract[]; withheld: number }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, pubkey } = await requireModerator(ctx, scope);
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    const describe = nameCache(ctx);

    const rows = await ctx.db
      .query("buzzModerationActions")
      .withIndex("by_scope_created", (q) =>
        q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId),
      )
      .order("desc")
      .take(limit);

    const entries: ModerationActionContract[] = [];
    let withheld = 0;
    for (const row of rows) {
      if (row.targetEventId !== undefined) {
        const reachable = await reachableEvent(ctx, scope, subject, pubkey, row.targetEventId);
        if (!reachable) {
          withheld += 1;
          continue;
        }
      }
      entries.push({
        id: row._id,
        actorPubkey: row.actorPubkey,
        actorName: await describe(row.actorPubkey),
        action: row.action,
        ...(row.targetPubkey !== undefined
          ? { targetPubkey: row.targetPubkey, targetName: await describe(row.targetPubkey) }
          : {}),
        ...(row.targetEventId !== undefined ? { targetEventId: row.targetEventId } : {}),
        ...(row.channelId !== undefined ? { channelId: row.channelId } : {}),
        ...(row.publicReason !== undefined ? { publicReason: row.publicReason } : {}),
        ...(row.privateReason !== undefined ? { privateReason: row.privateReason } : {}),
        ...(row.reportId !== undefined ? { reportId: row.reportId } : {}),
        createdAt: row.createdAt,
      });
    }
    return { entries, withheld };
  },
});

/** Who is currently restricted here. Moderator-only, like everything above. */
export const restrictions = query({
  args: { ...scopeArgs },
  handler: async (ctx, args): Promise<CommunityRestrictionContract[]> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    await requireModerator(ctx, scope);
    const describe = nameCache(ctx);
    const rows = await ctx.db
      .query("buzzCommunityRestrictions")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId),
      )
      .collect();

    const now = Math.floor(Date.now() / 1000);
    const out: CommunityRestrictionContract[] = [];
    for (const row of rows) {
      const state = restrictionState(row, now);
      if (state.kind === "none") continue;
      out.push({
        pubkey: row.pubkey,
        name: await describe(row.pubkey),
        banned: state.kind === "banned",
        timedOut: state.kind === "timed_out",
        ...(state.expiresAt !== undefined ? { expiresAt: state.expiresAt } : {}),
        ...(row.banReason !== undefined
          ? { reason: row.banReason }
          : row.muteReason !== undefined
            ? { reason: row.muteReason }
            : {}),
        actorPubkey: row.actorPubkey,
        updatedAt: row.updatedAt,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

// ---------------------------------------------------------------------------
// Enforcement (§6.3)
// ---------------------------------------------------------------------------

export type RestrictionState =
  | { kind: "none" }
  | { kind: "banned"; expiresAt?: number }
  | { kind: "timed_out"; expiresAt: number };

/**
 * The rejection a timed-out author gets, in the exact shape the composer parses.
 *
 * A **load-bearing string** (§6.3, `src/lib/buzz/moderation.ts`
 * `TIMEOUT_REJECTION_PREFIX`). There is deliberately no proactive "am I
 * restricted" read — v1 is reactive — so this sentence is the only channel by
 * which a composer learns it is timed out. Change the prefix and the banner
 * silently stops appearing, which presents as messages that vanish with no
 * explanation: the shadow ban this design exists to refuse.
 */
export function timeoutRejection(expiresAtSeconds: number): string {
  return `restricted: you are timed out until ${expiresAtSeconds}`;
}

/** A ban states no expiry when it is permanent, because there is none to state. */
export function banRejection(expiresAtSeconds?: number): string {
  return expiresAtSeconds === undefined
    ? "restricted: you are banned from this community"
    : `restricted: you are banned from this community until ${expiresAtSeconds}`;
}

/**
 * What a restriction row means *right now*.
 *
 * Pure, and expiry is computed rather than swept: a cron flipping `banned` to
 * false on expiry would be a second writer of the same fact, and a missed run
 * would hold somebody past their sentence with nothing in the trail saying why.
 * Deriving means a restriction stops biting the second it expires, whatever the
 * scheduler is doing.
 *
 * A ban outranks a timeout when both are in force. They are not additive, and
 * telling somebody they are timed out for ten minutes when they are in fact
 * banned is a lie in the direction that gets discovered later.
 */
export function restrictionState(
  row: Pick<RestrictionRow, "banned" | "banExpiresAt" | "mutedUntil">,
  nowSeconds: number,
): RestrictionState {
  if (row.banned && (row.banExpiresAt === undefined || row.banExpiresAt > nowSeconds)) {
    return row.banExpiresAt === undefined
      ? { kind: "banned" }
      : { kind: "banned", expiresAt: row.banExpiresAt };
  }
  if (row.mutedUntil !== undefined && row.mutedUntil > nowSeconds) {
    return { kind: "timed_out", expiresAt: row.mutedUntil };
  }
  return { kind: "none" };
}

async function restrictionRow(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  pubkey: string,
): Promise<RestrictionRow | null> {
  return await ctx.db
    .query("buzzCommunityRestrictions")
    .withIndex("by_scope_pubkey", (q) =>
      q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("pubkey", pubkey),
    )
    .unique();
}

/**
 * **The enforcement seam.** One function, called from the write path.
 *
 * §6.3's first rule is that enforcement is not scattered as filters: a ban
 * checked in four composers is a ban missing from the fifth. So there is
 * exactly one predicate and the write paths call it. Today that is `pulse.post`
 * and `pulse.upvote`; the room composer's call site is marked in
 * `messages.postMessageCore` and is one line, deliberately left for the same
 * edit that spreads `buzzModerationTables` into `convex/schema.ts` — a module
 * that queries a table the schema does not declare fails at its first read, and
 * `messages.ts` is imported by most of the Chat suite.
 *
 * It is deliberately *not* called from `publishCore`, for a structural reason
 * rather than an aesthetic one: this module reads `eventVisibleToReader` out of
 * `log.ts`, so a call in the other direction would make the log and moderation
 * mutually importing, and the log has to be loadable on its own. The harder
 * seam §6.3 describes — refuse at authentication, so a banned principal cannot
 * write *anything* — belongs above both, in `_authz`/`identity`, and is the one
 * place it should ever move to.
 *
 * A restriction never applies to the community's own owner. Not a courtesy: it
 * is the guard that stops a community being locked out of itself by a row
 * nobody is left with the authority to remove.
 */
export async function requireNotRestricted(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  pubkey: string,
): Promise<void> {
  if (!pubkey) return;
  const row = await restrictionRow(ctx, scope, pubkey);
  if (!row) return;
  const state = restrictionState(row, Math.floor(Date.now() / 1000));
  if (state.kind === "none") return;
  const principal = await principalForPubkey(ctx, pubkey);
  if ((await communityRoleOf(ctx, scope, principal)) === "owner") return;
  throw new ConvexError(
    state.kind === "banned" ? banRejection(state.expiresAt) : timeoutRejection(state.expiresAt),
  );
}

// ---------------------------------------------------------------------------
// Commands (§6.2)
// ---------------------------------------------------------------------------

/**
 * Write the audit row. Every act does; nothing else writes to that table.
 *
 * The decision and its enforcement are recorded **separately** —
 * `resolveReport` writes the enforcement's own row first and the resolution's
 * second — so the trail can never claim something happened that did not.
 */
async function recordAction(
  ctx: MutationCtx,
  scope: Scope,
  entry: {
    actorPubkey: string;
    action: string;
    targetPubkey?: string;
    targetEventId?: string;
    channelId?: string;
    reasonCode?: string;
    publicReason?: string;
    privateReason?: string;
    reportId?: ReportId;
  },
): Promise<ActionId> {
  const principal = await principalForPubkey(ctx, entry.actorPubkey);
  return await ctx.db.insert("buzzModerationActions", {
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    actorPubkey: entry.actorPubkey,
    action: entry.action,
    ...(entry.targetPubkey !== undefined ? { targetPubkey: entry.targetPubkey } : {}),
    ...(entry.targetEventId !== undefined ? { targetEventId: entry.targetEventId } : {}),
    ...(entry.channelId !== undefined ? { channelId: entry.channelId } : {}),
    ...(entry.reasonCode !== undefined ? { reasonCode: entry.reasonCode } : {}),
    ...(entry.publicReason !== undefined ? { publicReason: entry.publicReason } : {}),
    ...(entry.privateReason !== undefined ? { privateReason: entry.privateReason } : {}),
    ...(entry.reportId !== undefined ? { reportId: entry.reportId } : {}),
    ...(principal ? { matchedPrincipal: principal.id } : {}),
    createdAt: Date.now(),
  });
}

async function upsertRestriction(
  ctx: MutationCtx,
  scope: Scope,
  pubkey: string,
  patch: {
    banned?: boolean;
    banExpiresAt?: number | undefined;
    banReason?: string | undefined;
    mutedUntil?: number | undefined;
    muteReason?: string | undefined;
  },
  actorPubkey: string,
): Promise<void> {
  const existing = await restrictionRow(ctx, scope, pubkey);
  if (existing) {
    await ctx.db.patch(existing._id, {
      ...patch,
      actorPubkey,
      updatedAt: Date.now(),
    });
    return;
  }
  await ctx.db.insert("buzzCommunityRestrictions", {
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    pubkey,
    banned: patch.banned ?? false,
    ...(patch.banExpiresAt !== undefined ? { banExpiresAt: patch.banExpiresAt } : {}),
    ...(patch.banReason !== undefined ? { banReason: patch.banReason } : {}),
    ...(patch.mutedUntil !== undefined ? { mutedUntil: patch.mutedUntil } : {}),
    ...(patch.muteReason !== undefined ? { muteReason: patch.muteReason } : {}),
    actorPubkey,
    updatedAt: Date.now(),
  });
}

async function applyBan(
  ctx: MutationCtx,
  scope: Scope,
  actorPubkey: string,
  args: { pubkey: string; expiresAt?: number; reason?: string; reportId?: ReportId },
): Promise<ActionId> {
  await upsertRestriction(
    ctx,
    scope,
    args.pubkey,
    {
      banned: true,
      banExpiresAt: args.expiresAt,
      banReason: args.reason?.trim() || undefined,
    },
    actorPubkey,
  );
  return await recordAction(ctx, scope, {
    actorPubkey,
    action: "ban",
    targetPubkey: args.pubkey,
    ...(args.reason?.trim() ? { publicReason: args.reason.trim() } : {}),
    ...(args.reportId !== undefined ? { reportId: args.reportId } : {}),
  });
}

/** Ban. `expiresAt` (unix seconds) makes it temporary; absent is permanent. */
export const ban = mutation({
  args: {
    ...scopeArgs,
    pubkey: v.string(),
    expiresAt: v.optional(v.number()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const moderator = await requireModerator(ctx, scope);
    await assertMayActOn(ctx, scope, moderator, args.pubkey);
    await applyBan(ctx, scope, moderator.pubkey, args);
    return { banned: true };
  },
});

export const unban = mutation({
  args: { ...scopeArgs, pubkey: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const moderator = await requireModerator(ctx, scope);
    // The row is kept and the flag flipped, never deleted — see the table's
    // comment. Lifting a restriction is itself an auditable act.
    await upsertRestriction(
      ctx,
      scope,
      args.pubkey,
      { banned: false, banExpiresAt: undefined, banReason: undefined },
      moderator.pubkey,
    );
    await recordAction(ctx, scope, {
      actorPubkey: moderator.pubkey,
      action: "unban",
      targetPubkey: args.pubkey,
      ...(args.reason?.trim() ? { publicReason: args.reason.trim() } : {}),
    });
    return { banned: false };
  },
});

/**
 * Time somebody out. `expiresAt` is **required** (§6.2).
 *
 * Required because a timeout with no expiry is a ban wearing a softer word, and
 * the difference between the two is the whole reason both exist: a ban ends a
 * relationship, a timeout states when it resumes.
 */
export const timeout = mutation({
  args: {
    ...scopeArgs,
    pubkey: v.string(),
    expiresAt: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const moderator = await requireModerator(ctx, scope);
    await assertMayActOn(ctx, scope, moderator, args.pubkey);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(args.expiresAt) || args.expiresAt <= now) {
      throw new ConvexError("A timeout has to end in the future");
    }
    await upsertRestriction(
      ctx,
      scope,
      args.pubkey,
      {
        mutedUntil: args.expiresAt,
        muteReason: args.reason?.trim() || undefined,
      },
      moderator.pubkey,
    );
    await recordAction(ctx, scope, {
      actorPubkey: moderator.pubkey,
      action: "timeout",
      targetPubkey: args.pubkey,
      ...(args.reason?.trim() ? { publicReason: args.reason.trim() } : {}),
    });
    return { until: args.expiresAt };
  },
});

export const untimeout = mutation({
  args: { ...scopeArgs, pubkey: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const moderator = await requireModerator(ctx, scope);
    await upsertRestriction(
      ctx,
      scope,
      args.pubkey,
      { mutedUntil: undefined, muteReason: undefined },
      moderator.pubkey,
    );
    await recordAction(ctx, scope, {
      actorPubkey: moderator.pubkey,
      action: "untimeout",
      targetPubkey: args.pubkey,
    });
    return { until: null };
  },
});

/**
 * Resolve a report — the 9044, executed rather than published.
 *
 * **Ordering is the invariant** (§6.4): enforcement runs *before* the
 * resolution is recorded. A resolution says "reviewed and acted on", so it must
 * not exist for an action that did not happen. A failed enforcement throws, the
 * transaction rolls back, and the report is still open: no false claim, no
 * orphan decision row. Convex's transaction gives the rollback for free; the
 * ordering is written out anyway, because the property is about what the trail
 * asserts and not about what the database does.
 *
 * Two actions in the wire vocabulary are refused here, for different reasons
 * and neither by omission:
 *
 *   • **`timeout`** — the queue collects no duration, and a timeout with a
 *     default duration is a sentence nobody chose. It is a direct command
 *     (`moderation.timeout`) with the presets, from the per-message menu.
 *   • **`kick`** — removing somebody from a room is a *room* act with the
 *     room's own rules (`channels.removeMember`: the last-owner guard, the
 *     9001, the member-removed notification, and the requirement that the
 *     remover is in the room). A community moderator resolving a report
 *     generally is not in that room, and a second removal path skipping those
 *     rules would be a second answer to who may remove whom.
 */
export const resolveReport = mutation({
  args: {
    ...scopeArgs,
    reportId: v.id("buzzModerationReports"),
    action: v.string(),
    reason: v.optional(v.string()),
    privateReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const moderator = await requireModerator(ctx, scope);
    if (!isResolutionAction(args.action)) throw new ConvexError("Unknown resolution");
    const action = args.action;

    const row = await ctx.db.get(args.reportId);
    // The tenancy fence re-applied to the row that was actually loaded, not
    // only to the arguments: a Convex id travels, so a report id from another
    // community must not resolve here just because the caller governs this one.
    if (!row || row.scopeType !== scope.scopeType || row.scopeId !== scope.scopeId) {
      throw new ConvexError("Report not found");
    }
    if (row.status !== "open") throw new ConvexError("That report is already resolved");
    if (!QUEUE_ACTIONS.includes(action)) {
      throw new ConvexError(
        action === "timeout"
          ? "Time somebody out from the message menu, where the duration is chosen"
          : "Removing somebody from a room is done in that room, by its owners and admins",
      );
    }

    // The moderator must still be able to reach the target. A report can
    // outlive their access to the room it came from, and acting on something
    // you can no longer see is the read-leak this file exists to refuse, with a
    // side effect attached.
    let target: EventRow | null = null;
    if (row.targetKind === "event") {
      target = await reachableEvent(ctx, scope, moderator.subject, moderator.pubkey, row.target);
      if (!target) throw new ConvexError("That message could not be found");
    }

    // ── enforcement first ────────────────────────────────────────────────
    let enforcementId: ActionId | undefined;
    if (action === "delete") {
      if (!target || target.channelId === undefined) {
        throw new ConvexError("Only a message in a room can be removed");
      }
      enforcementId = await removeReportedMessage(ctx, scope, moderator.pubkey, target, {
        reason: args.reason,
        privateReason: args.privateReason,
        reportId: row._id,
      });
    } else if (action === "ban") {
      // §6.4: the row carries only the event id — the reporter's `p` tag is
      // dropped at ingest, on purpose — so the author comes from the stored
      // event's own `pubkey`. Signer truth, never a `p` or an `actor` override:
      // a delegated display author is not who wrote it.
      const targetPubkey = row.targetKind === "pubkey" ? row.target : target?.pubkey;
      if (!targetPubkey) throw new ConvexError("This report has no author to ban");
      await assertMayActOn(ctx, scope, moderator, targetPubkey);
      enforcementId = await applyBan(ctx, scope, moderator.pubkey, {
        pubkey: targetPubkey,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
        reportId: row._id,
      });
    }

    // ── then the decision ────────────────────────────────────────────────
    const decisionId = await recordAction(ctx, scope, {
      actorPubkey: moderator.pubkey,
      action: `resolve:${action}`,
      ...(row.targetKind === "event" ? { targetEventId: row.target } : {}),
      ...(target?.channelId !== undefined ? { channelId: target.channelId } : {}),
      ...(target ? { targetPubkey: target.pubkey } : {}),
      ...(args.reason?.trim() ? { publicReason: args.reason.trim() } : {}),
      ...(args.privateReason?.trim() ? { privateReason: args.privateReason.trim() } : {}),
      reportId: row._id,
    });

    await ctx.db.patch(row._id, {
      status: reportStatusForAction(action),
      resolvedByPubkey: moderator.pubkey,
      resolvedAt: Date.now(),
      actionId: enforcementId ?? decisionId,
    });

    return { status: reportStatusForAction(action) };
  },
});

/**
 * Remove a reported message: the three effects, in order.
 *
 * Deliberately the *same* three `messages.remove` produces — the 9005 that is
 * the record, the soft delete that is the effect, and the relay-signed
 * tombstone the room reads — because a message removed by a community moderator
 * and one removed by a room admin have to be the same object afterwards. The
 * only thing that differs is the **authority**: `messages.remove` is the author
 * or one of the room's owners and admins and requires the actor to be in the
 * room; this is the community's roster, acting on a report, from outside. That
 * is why this is not a call to that mutation, and it is also why the effects
 * are enumerated here rather than described — if a fourth is ever added to
 * either, it belongs in both.
 *
 * The tombstone is honest and sanitized: "removed by a community moderator"
 * plus the public reason, never the removed text.
 */
async function removeReportedMessage(
  ctx: MutationCtx,
  scope: Scope,
  actorPubkey: string,
  target: EventRow,
  meta: { reason?: string; privateReason?: string; reportId: ReportId },
): Promise<ActionId> {
  const channelId = target.channelId;
  if (channelId === undefined) throw new ConvexError("Only a message in a room can be removed");

  const principal = await principalForPubkey(ctx, actorPubkey);
  const outcome = await publishCore(ctx, {
    actor: {
      type: "user",
      id: principal?.id ?? actorPubkey,
      name: (await describePubkey(ctx, actorPubkey))?.name ?? "A moderator",
    },
    scope,
    kind: KIND_NIP29_DELETE_EVENT,
    tags: [
      ["h", channelId],
      ["e", target.eventId],
    ],
    content: "",
  });
  // `duplicate` is fine — the identical signed removal is already in the log,
  // so the patch below is explained. `dominated` and `ephemeral` wrote nothing,
  // and soft-deleting a message on the strength of an event that does not exist
  // is the divergence the log's one-writer rule exists to prevent.
  if (outcome.status === "dominated" || outcome.status === "ephemeral") {
    throw new ConvexError("The channel log refused this removal; nothing was written");
  }

  await ctx.db.patch(target._id, { deletedAt: Date.now() });

  await publishCore(
    ctx,
    asRelay(scope, {
      kind: KIND_SYSTEM_MESSAGE,
      tags: [["h", channelId]],
      content: JSON.stringify({
        type: "message_moderated",
        actor: actorPubkey,
        target: target.pubkey,
        ...(meta.reason?.trim() ? { reason: meta.reason.trim() } : {}),
      }),
    }),
  );

  return await recordAction(ctx, scope, {
    actorPubkey,
    action: "delete",
    targetPubkey: target.pubkey,
    targetEventId: target.eventId,
    channelId,
    ...(meta.reason?.trim() ? { publicReason: meta.reason.trim() } : {}),
    ...(meta.privateReason?.trim() ? { privateReason: meta.privateReason.trim() } : {}),
    reportId: meta.reportId,
  });
}
