// Telling somebody, and being able to say why.
//
// The rules are not in this file. They are in `src/lib/buzz/notify.ts`, pure
// and exhaustively tested (`tests/buzz-notify.test.ts`), and this module
// **imports** them rather than restating them. That is a deliberate departure
// from the convention `messages.ts` follows for `mentionedActorIds`, and the
// reason is specific rather than general: a notification that does not arrive
// leaves no error, no row and no trace, so a second copy of the ordering would
// not be caught by anything — it would be found months later by a person
// wondering why their laptop and their phone disagree about a muted thread.
// The module is plain ES with no DOM, no Node built-ins and no clock, so it
// bundles into the Convex runtime unchanged. If you ever need to move it, move
// it. Do not copy it.
//
// What this file does own:
//
//   - **Storage** for the two things §7 says a person owns: their notification
//     settings, and their mutes. Both live in tables declared at the bottom of
//     this file (see `buzzNotificationTables`) rather than in `_tables.ts`,
//     because that file is being edited concurrently; folding them in is two
//     lines and changes nothing else.
//   - **Fan-out**: who, out of a room full of people and agents, this event is
//     actually about — and then delivering to them through machinery that
//     already exists. A mentioned person gets the Work side's Resend mention
//     email and an in-app row; a mentioned agent gets pinged on `notifyUrl`
//     through `enqueueAgentPingDelivery`, HMAC-signed and SSRF-guarded, exactly
//     like a mention on a task. There is no second mailer and no second pinger.
//   - **`explain`**, which answers "why didn't I get notified" against the same
//     predicate the delivery path ran. It exists because that question is the
//     one a chat product generates at volume and because a boolean cannot
//     answer it.
//
// ## What the server can and cannot decide
//
// §7.6 has eleven suppressions and four of them are facts only a browser holds:
// which room is on screen (7), whether this is the first load of a feed (5),
// what has already been delivered in this session (4), and what the OS
// permission is (1's second half). The server passes those fields absent, which
// `decide` treats as "not suppressed" — and that is the right direction: the
// server's deliveries are durable (an email, a queued agent ping), and a
// durable message suppressed because somebody *had a tab open* is a message
// nobody ever reads. The browser applies the session half to the live path.
//
// ## Who this fans out to, and why it is not "everyone in the room"
//
// D9: an agent answers on its own runtime, and **a mention is what pings it**.
// So the recipient set is derived from the event, not from the membership list:
// the `p` tags for an ordinary message, the participants for a DM, and the
// room's members (capped) for a broadcast. A message in a busy channel must not
// cost one delivery per member — and it does not need to, because everything
// the predicate would deliver on steps 4–8 is *unread state*, which the room
// already shows. Out-of-band delivery is for what the room cannot show you:
// you were named, you were sent a direct message, or the room was addressed as
// a whole.

import { ConvexError, v } from "convex/values";
import { defineTable } from "convex/server";
import { internal } from "../_generated/api";
import { internalMutation, mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireIdentity, requireScopeAccess } from "../_authz";
import { enqueueAgentPingDelivery } from "../agentPingDeliveries";
import { requireChannelAccess } from "./channels";
import { principalForPubkey, pubkeyFor } from "./identity";
import type { EventRow, Scope } from "./log";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  SOUND_NAMES,
  SOUND_SLOTS,
  decide,
  isHighPriorityEventForUser,
  normalizeNotificationSettings,
  setAllSlotAlertsEnabled,
  setSlotAlertEnabled,
  setSlotSound,
  threadReferenceFrom,
  truncateNotificationBody,
  type NotificationSettings,
  type NotifyEvent,
  type SoundName,
  type SoundSlot,
} from "../../src/lib/buzz/notify";
// C12: the room key the unified inbox files a Chat mention under.
import { roomKey } from "../../src/lib/buzz/bridge";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const scopeArgs = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

const slotArg = v.union(...SOUND_SLOTS.map((slot) => v.literal(slot)));
const soundArg = v.union(...SOUND_NAMES.map((name) => v.literal(name)));

/** What a mute is set on. A channel and a thread are muted independently (§7.5). */
const muteTargetArg = v.union(v.literal("channel"), v.literal("thread"));
type MuteTarget = "channel" | "thread";

/**
 * How many members a broadcast reaches out-of-band.
 *
 * A cap rather than a `.collect()` because a broadcast is the one path whose
 * fan-out is proportional to the room. Past this the message is still in the
 * room and still unread-tracked; what stops is the email. A room of a thousand
 * where one person can generate a thousand emails is a room with a spam cannon
 * in it.
 */
const BROADCAST_FANOUT_CAP = 200;

// ---------------------------------------------------------------------------
// Settings storage
// ---------------------------------------------------------------------------

/**
 * Settings are stored per **person**, not per community.
 *
 * "How loud is this product" is a fact about somebody's attention, the way type
 * size and motion are (the PERSONAL_KEYS argument in `appearance.ts`), and a
 * workspace that could turn your alerts down is the same class of harm as one
 * that shrinks your text. Mutes are the opposite and are scoped: muting
 * #standup means nothing outside the community that has a #standup.
 */
async function settingsRow(
  ctx: QueryCtx | MutationCtx,
  subject: string,
): Promise<Doc<"buzzNotificationSettings"> | null> {
  return await ctx.db
    .query("buzzNotificationSettings")
    .withIndex("by_user", (q) => q.eq("userClerkId", subject))
    .unique();
}

/**
 * Somebody's settings, always complete.
 *
 * A missing row is not an error and not a special case — it is the defaults,
 * which is what "never opened the settings screen" means. `normalize` runs on
 * every read for the same reason `normalizeAppearance` does: a row written by a
 * newer build must never be able to lock somebody out of their own
 * notifications, and a half-understood row read as-is is exactly how that
 * happens.
 */
export async function settingsFor(
  ctx: QueryCtx | MutationCtx,
  subject: string,
): Promise<NotificationSettings> {
  const row = await settingsRow(ctx, subject);
  return normalizeNotificationSettings(row?.settings);
}

async function writeSettings(
  ctx: MutationCtx,
  subject: string,
  next: NotificationSettings,
): Promise<NotificationSettings> {
  const row = await settingsRow(ctx, subject);
  if (row) {
    await ctx.db.patch(row._id, { settings: next, updatedAt: Date.now() });
  } else {
    await ctx.db.insert("buzzNotificationSettings", {
      userClerkId: subject,
      settings: next,
      updatedAt: Date.now(),
    });
  }
  return next;
}

/** The signed-in person's settings. Defaults before they have ever saved. */
export const settings = query({
  args: {},
  handler: async (ctx): Promise<NotificationSettings> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return DEFAULT_NOTIFICATION_SETTINGS;
    return await settingsFor(ctx, identity.subject);
  },
});

/**
 * The three plain switches.
 *
 * One mutation with a key rather than three, because they are the same act on
 * the same row and three would be three round trips from a settings screen that
 * saves on every toggle. `desktopEnabled` is written whatever the browser
 * permission says: the permission dance belongs to the client (§7.3), and a
 * server that refused to record the intent would make "I turned it on and it
 * turned itself off" unexplainable.
 */
export const setFlag = mutation({
  args: {
    key: v.union(
      v.literal("desktopEnabled"),
      v.literal("homeBadgeEnabled"),
      v.literal("notifyWhileViewing"),
    ),
    value: v.boolean(),
  },
  handler: async (ctx, args): Promise<NotificationSettings> => {
    const { subject } = await requireIdentity(ctx);
    const current = await settingsFor(ctx, subject);
    return await writeSettings(ctx, subject, { ...current, [args.key]: args.value });
  },
});

/** One slot's switch. The pure helper clears the master-switch snapshot. */
export const setSlotAlert = mutation({
  args: { slot: slotArg, enabled: v.boolean() },
  handler: async (ctx, args): Promise<NotificationSettings> => {
    const { subject } = await requireIdentity(ctx);
    const current = await settingsFor(ctx, subject);
    return await writeSettings(
      ctx,
      subject,
      setSlotAlertEnabled(current, args.slot as SoundSlot, args.enabled),
    );
  },
});

/**
 * The master switch — snapshot on the way down, restore on the way up.
 *
 * Routed through the same pure function the UI uses rather than a bulk write,
 * because the semantics are the whole point: turning it off and on again must
 * give you back the picks you made, not a row of trues.
 */
export const setAllSlotAlerts = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, args): Promise<NotificationSettings> => {
    const { subject } = await requireIdentity(ctx);
    const current = await settingsFor(ctx, subject);
    return await writeSettings(ctx, subject, setAllSlotAlertsEnabled(current, args.enabled));
  },
});

export const setSound = mutation({
  args: { slot: slotArg, sound: soundArg },
  handler: async (ctx, args): Promise<NotificationSettings> => {
    const { subject } = await requireIdentity(ctx);
    const current = await settingsFor(ctx, subject);
    return await writeSettings(
      ctx,
      subject,
      setSlotSound(current, args.slot as SoundSlot, args.sound as SoundName),
    );
  },
});

// ---------------------------------------------------------------------------
// Mutes (§7.5)
// ---------------------------------------------------------------------------

/**
 * A mute row carries `muted: boolean` and a timestamp, and an unmute keeps the
 * row rather than deleting it.
 *
 * That looks like clutter and is the merge rule: mutes sync across devices, and
 * a deleted row is indistinguishable from a row that never existed — so a stale
 * device that still has the mute would re-mute the channel on the next sync,
 * forever. A row saying "unmuted, at this time" is the only thing that can beat
 * it. `mergeMuteStores` in the pure module is the other half.
 */
async function muteRow(
  ctx: QueryCtx | MutationCtx,
  subject: string,
  scope: Scope,
  targetType: MuteTarget,
  targetId: string,
): Promise<Doc<"buzzMutes"> | null> {
  return await ctx.db
    .query("buzzMutes")
    .withIndex("by_user_target", (q) =>
      q
        .eq("userClerkId", subject)
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("targetType", targetType)
        .eq("targetId", targetId),
    )
    .unique();
}

async function mutedSets(
  ctx: QueryCtx | MutationCtx,
  subject: string,
  scope: Scope,
): Promise<{ channels: Set<string>; threads: Set<string> }> {
  const rows = await ctx.db
    .query("buzzMutes")
    .withIndex("by_user_scope", (q) =>
      q
        .eq("userClerkId", subject)
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId),
    )
    .collect();
  const channels = new Set<string>();
  const threads = new Set<string>();
  for (const row of rows) {
    if (!row.muted) continue;
    (row.targetType === "channel" ? channels : threads).add(row.targetId);
  }
  return { channels, threads };
}

/** What this person has muted in this community. */
export const mutes = query({
  args: scopeArgs,
  handler: async (ctx, args): Promise<{ channels: string[]; threads: string[] }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const sets = await mutedSets(ctx, subject, scope);
    return { channels: [...sets.channels], threads: [...sets.threads] };
  },
});

/**
 * Mute or unmute a room.
 *
 * Access-checked against the room itself rather than only the community: a mute
 * is a per-person row, so writing one for a channel you cannot see leaks
 * nothing directly — but it lets you ask whether `#acquisition` exists by
 * watching which writes are refused, and "does that room exist" is precisely
 * what `requireChannelAccess` refuses to answer.
 */
export const setChannelMuted = mutation({
  args: { ...scopeArgs, channelId: v.string(), muted: v.boolean() },
  handler: async (ctx, args): Promise<{ muted: boolean }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireChannelAccess(ctx, scope, args.channelId);
    await upsertMute(ctx, subject, scope, "channel", args.channelId, args.muted);
    return { muted: args.muted };
  },
});

/**
 * Mute or unmute a thread, by its root message id.
 *
 * By root and never by parent: a thread has one root however deep a reply is
 * (`messageTags` always carries it), so muting the root is muting the
 * conversation. Muting an intermediate message would silence a branch and leave
 * the rest of the thread loud, which is not a thing anybody means.
 */
export const setThreadMuted = mutation({
  args: { ...scopeArgs, channelId: v.string(), rootId: v.string(), muted: v.boolean() },
  handler: async (ctx, args): Promise<{ muted: boolean }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireChannelAccess(ctx, scope, args.channelId);
    await upsertMute(ctx, subject, scope, "thread", args.rootId, args.muted);
    return { muted: args.muted };
  },
});

async function upsertMute(
  ctx: MutationCtx,
  subject: string,
  scope: Scope,
  targetType: MuteTarget,
  targetId: string,
  muted: boolean,
): Promise<void> {
  const existing = await muteRow(ctx, subject, scope, targetType, targetId);
  const updatedAt = Date.now();
  if (existing) {
    await ctx.db.patch(existing._id, { muted, updatedAt });
    return;
  }
  await ctx.db.insert("buzzMutes", {
    userClerkId: subject,
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    targetType,
    targetId,
    muted,
    updatedAt,
  });
}

// ---------------------------------------------------------------------------
// "Why didn't I get notified?"
// ---------------------------------------------------------------------------

/**
 * Run the predicate against a real event, for the person asking, and say what
 * it decided and which numbered rule decided it.
 *
 * This is not a debug endpoint. It is the answer to the single most common
 * support question a chat product generates, and it is only trustworthy
 * because it is the *same* function the delivery path ran — a hand-written
 * explanation would drift from the behaviour it describes and then be believed.
 *
 * The session half of §7.6 (items 4, 5, 7, and the permission half of 1) is
 * absent here for the same reason it is absent from the fan-out: the server
 * does not know what your screen was doing. The client can pass what it knows
 * and re-run `decide` locally to refine the answer.
 */
export const explain = query({
  args: { ...scopeArgs, channelId: v.string(), eventId: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel } = await requireChannelAccess(ctx, scope, args.channelId);
    const row = await eventRow(ctx, scope, args.eventId);
    if (!row || row.channelId !== channel.channelId) {
      throw new ConvexError("Message not found");
    }

    const me = (await pubkeyFor(ctx, "user", subject)) ?? "";
    const decision = decide(toNotifyEvent(row), {
      me,
      settings: await settingsFor(ctx, subject),
      isDm: channel.channelType === "dm",
      channelId: channel.channelId,
      relationship: await relationshipFor(ctx, subject, scope, me, row),
    });
    return {
      deliver: decision.deliver,
      item: decision.item,
      reason: decision.reason,
      slot: decision.slot,
      predicateStep: decision.predicate?.step ?? null,
      explanation: decision.explanation,
    };
  },
});

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

/**
 * Tell whoever this event is about.
 *
 * Exported so `messages.post` can call it in its own transaction with one line
 * — `await notifyForEvent(ctx, { scope, channelId, eventId })` — and provided
 * as an internal mutation (`fanout`, below) so the hook can equally be a
 * scheduler call. Neither has been wired yet: `convex/buzz/messages.ts` belongs
 * to another phase and is not edited here. See the report.
 *
 * Every failure mode is a no-op rather than a throw. A notification is a
 * courtesy attached to somebody else's write, and there is no version of "the
 * message could not be sent because the email about it could not be addressed"
 * that is the right behaviour.
 */
export async function notifyForEvent(
  ctx: MutationCtx,
  args: { scope: Scope; channelId: string; eventId: string },
): Promise<{ delivered: number }> {
  const channel = await ctx.db
    .query("buzzChannels")
    .withIndex("by_scope_channel", (q) =>
      q
        .eq("scopeType", args.scope.scopeType)
        .eq("scopeId", args.scope.scopeId)
        .eq("channelId", args.channelId),
    )
    .unique();
  if (!channel) return { delivered: 0 };

  const row = await eventRow(ctx, args.scope, args.eventId);
  if (!row || row.channelId !== channel.channelId) return { delivered: 0 };

  const event = toNotifyEvent(row);
  const isDm = channel.channelType === "dm";
  const author = await principalForPubkey(ctx, row.pubkey);
  const authorName = await displayNameFor(ctx, author);
  // Hoisted out of the loop deliberately: "who started this thread" is a fact
  // about the event, not about the reader, so reading it per recipient would
  // turn a broadcast into one extra read per member for an answer that cannot
  // differ between them.
  const threadRoot = await threadRootOf(ctx, args.scope, row);

  let delivered = 0;
  for (const recipient of await recipientsFor(ctx, args.scope, channel, row)) {
    if (recipient.pubkey === row.pubkey) continue;

    // A person's settings; an agent has none, and deliberately does not get a
    // settings row it could turn itself down with. Governance over an agent is
    // `agents.ts`'s job (role, list fences, budgets) and a second, agent-owned
    // mute switch would be a way for an agent to opt out of being managed.
    const settings =
      recipient.type === "user"
        ? await settingsFor(ctx, recipient.principalId)
        : DEFAULT_NOTIFICATION_SETTINGS;
    const muted =
      recipient.type === "user"
        ? await mutedSets(ctx, recipient.principalId, args.scope)
        : { channels: new Set<string>(), threads: new Set<string>() };

    const decision = decide(event, {
      me: recipient.pubkey,
      settings,
      isDm,
      channelId: channel.channelId,
      relationship: {
        mutedChannelIds: muted.channels,
        mutedRootIds: muted.threads,
        authoredRootIds: authoredRootsFor(threadRoot, recipient.pubkey),
      },
    });
    if (!decision.deliver) continue;

    // The out-of-band bar, on top of the predicate. Everything the predicate
    // delivers on steps 4–8 is *unread state*, which the room already shows
    // the moment it is opened; an email for it is noise that trains people to
    // filter the ones that matter. What the room cannot show you is that you
    // were named, addressed as part of a broadcast, or sent a direct message —
    // so that is the set that leaves the building.
    if (!isDm && !isHighPriorityEventForUser(event, recipient.pubkey)) continue;

    if (recipient.type === "agent") {
      await pingAgent(ctx, {
        scope: args.scope,
        agentId: recipient.principalId as Id<"agents">,
        channel,
        row,
        authorName,
      });
    } else {
      await mailPerson(ctx, {
        subject: recipient.principalId,
        channel,
        row,
        authorName,
        slot: decision.slot,
        reason: decision.reason,
      });
    }
    delivered += 1;
  }

  return { delivered };
}

/**
 * The same, as a callable.
 *
 * Internal because the only legitimate caller is a write path that has already
 * decided an event exists — a public "notify about this event" is a way to make
 * somebody's phone buzz on demand.
 */
export const fanout = internalMutation({
  args: { ...scopeArgs, channelId: v.string(), eventId: v.string() },
  handler: async (ctx, args) => {
    return await notifyForEvent(ctx, {
      scope: { scopeType: args.scopeType, scopeId: args.scopeId },
      channelId: args.channelId,
      eventId: args.eventId,
    });
  },
});

// ---------------------------------------------------------------------------
// Who an event is about
// ---------------------------------------------------------------------------

type Recipient = {
  type: "user" | "agent";
  principalId: string;
  pubkey: string;
};

/**
 * The candidate set, derived from the **event** rather than the room.
 *
 * Three cases, in order of how big they can get:
 *
 *   - a **DM** is its participants, and there are two of them (or a handful);
 *   - a **broadcast** is the room, capped, because a broadcast is the one thing
 *     that is genuinely addressed to everybody;
 *   - everything else is the event's `p` tags, which the relay caps at 50.
 *
 * Note what is absent: "every member, every message". That is the shape that
 * turns one message in a thousand-person room into a thousand deliveries, and
 * it buys nothing — the predicate's steps 4–8 are unread state, and the room
 * shows those itself.
 */
async function recipientsFor(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  channel: Doc<"buzzChannels">,
  row: EventRow,
): Promise<Recipient[]> {
  const broadcast = row.tags.some((tag) => tag[0] === "broadcast" && tag[1] === "1");
  if (channel.channelType === "dm" || broadcast) {
    const members = await ctx.db
      .query("buzzMemberships")
      .withIndex("by_channel", (q) =>
        q
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId)
          .eq("channelId", channel.channelId)
          .eq("removedAt", undefined),
      )
      .take(BROADCAST_FANOUT_CAP);
    const out: Recipient[] = [];
    for (const member of members) {
      const pubkey = await pubkeyFor(ctx, member.actorType, member.actorId);
      if (!pubkey) continue;
      out.push({ type: member.actorType, principalId: member.actorId, pubkey });
    }
    return out;
  }

  const out: Recipient[] = [];
  const seen = new Set<string>();
  for (const tag of row.tags) {
    if (tag[0] !== "p" || !tag[1]) continue;
    const pubkey = tag[1].toLowerCase();
    if (seen.has(pubkey)) continue;
    seen.add(pubkey);
    const principal = await principalForPubkey(ctx, pubkey);
    if (!principal) continue;
    out.push({ type: principal.type, principalId: principal.id, pubkey });
  }
  return out;
}

/**
 * The thread this event sits in, and who started it.
 *
 * One indexed read, and it is the only one of §7.1's three thread
 * relationships the server can answer today: participation and follows are read
 * state, which lives in `readState.ts` (another phase). They are passed empty
 * rather than guessed, and the consequence is bounded — the out-of-band bar in
 * `notifyForEvent` only lets mentions, broadcasts and DMs through anyway, none
 * of which reach steps 6–8.
 */
async function threadRootOf(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  row: EventRow,
): Promise<{ rootId: string; authorPubkey: string } | null> {
  const { rootId, parentId } = threadReferenceFrom(row.tags);
  const root = rootId ?? parentId;
  if (!root) return null;
  const head = await eventRow(ctx, scope, root);
  return head ? { rootId: root, authorPubkey: head.pubkey } : null;
}

function authoredRootsFor(
  thread: { rootId: string; authorPubkey: string } | null,
  readerPubkey: string,
): Set<string> {
  if (!thread || readerPubkey.length === 0) return new Set();
  return thread.authorPubkey === readerPubkey ? new Set([thread.rootId]) : new Set();
}

async function relationshipFor(
  ctx: QueryCtx | MutationCtx,
  subject: string,
  scope: Scope,
  me: string,
  row: EventRow,
) {
  const muted = await mutedSets(ctx, subject, scope);
  return {
    mutedChannelIds: muted.channels,
    mutedRootIds: muted.threads,
    authoredRootIds: authoredRootsFor(await threadRootOf(ctx, scope, row), me),
  };
}

// ---------------------------------------------------------------------------
// Delivery — through machinery that already exists
// ---------------------------------------------------------------------------

/**
 * A mentioned agent is pinged on its own runtime (D9).
 *
 * `enqueueAgentPingDelivery` is the app's one outbound-ping path: it writes the
 * receipt row, HMAC-signs the body with the agent's `notifySecret`, retries with
 * backoff and refuses a private or loopback address through the SSRF guard. An
 * agent with no `notifyUrl` still gets a `poll_required` receipt, which is how
 * an agent that polls over MCP finds out it was named. Rebuilding any of that
 * here would be a second answer to a question that has one — and the second one
 * would be the one without the SSRF guard.
 *
 * `sourceKind: "mention"` is exact: being named in a room is a mention, and the
 * receipt table's `sourceId` is a string, so a Chat event id fits without a
 * schema change.
 */
async function pingAgent(
  ctx: MutationCtx,
  args: {
    scope: Scope;
    agentId: Id<"agents">;
    channel: Doc<"buzzChannels">;
    row: EventRow;
    authorName: string;
  },
): Promise<void> {
  const agent = await ctx.db.get(args.agentId);
  if (!agent) return;
  const { rootId, parentId } = threadReferenceFrom(args.row.tags);
  await enqueueAgentPingDelivery(ctx, {
    scopeType: args.scope.scopeType,
    scopeId: args.scope.scopeId,
    workspaceId:
      args.scope.scopeType === "workspace"
        ? (args.scope.scopeId as Id<"workspaces">)
        : undefined,
    sourceKind: "mention",
    sourceId: args.row.eventId,
    agentId: args.agentId,
    push: agent.notifyUrl !== undefined,
    type: "chat.mention",
    payload: {
      channelId: args.channel.channelId,
      channelName: args.channel.name,
      eventId: args.row.eventId,
      rootId: rootId ?? parentId ?? null,
      byName: args.authorName,
      snippet: truncateNotificationBody(args.row.content, "(no text)"),
    },
  });
}

/**
 * A mentioned person gets the in-app row and the Work side's mention email.
 *
 * Both already exist and both are reused rather than reinvented:
 * `internal.notifications.sendMentionEmail` is the Resend action tasks and
 * comments already send through — scheduled with `runAfter(0)` so a flaky
 * provider cannot roll back the message somebody just sent. A second mailer
 * would mean a second `RESEND_FROM_EMAIL` to keep correct and a second place
 * for an unsubscribe to not work.
 *
 * **C12 changed which in-app queue this writes to, and it is one row, not two.**
 * It used to be `notificationCenter.notify`, which lands in the Inbox's
 * "Updates" section. It is now a `mentions` row, which lands in "Mentions" —
 * the queue that is *about* being addressed by name, that carries per-row
 * mark-read, and that the Inbox already resolves into a working deep link.
 * Writing both would be one thing that happened counted twice, in front of the
 * person it happened to, because the Inbox's badge adds the two queues.
 */
async function mailPerson(
  ctx: MutationCtx,
  args: {
    subject: string;
    channel: Doc<"buzzChannels">;
    row: EventRow;
    authorName: string;
    slot: SoundSlot;
    reason: string;
  },
): Promise<void> {
  const isDm = args.channel.channelType === "dm";
  const label = isDm
    ? "a direct message"
    : `#${args.channel.name || args.channel.displayName}`;
  const snippet = truncateNotificationBody(args.row.content, "(no text)");

  // `parentId` is the room key (scope + channel id) because a Buzz channel id
  // is only unique inside a community, and the Inbox has no other way to know
  // which one this came from. `messageId` is absent because a Chat message is a
  // signed event rather than a `messages` row — the shape page mentions already
  // established, which is why `snippet` and `byName` are on the row.
  await ctx.db.insert("mentions", {
    mentionedClerkId: args.subject,
    parentType: "room",
    parentId: roomKey(
      { scopeType: args.channel.scopeType, scopeId: args.channel.scopeId },
      args.channel.channelId,
    ),
    snippet,
    byName: args.authorName,
    createdAt: Date.now(),
  });

  const recipient = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", args.subject))
    .unique();
  if (!recipient?.email) return;
  await ctx.scheduler.runAfter(0, internal.notifications.sendMentionEmail, {
    toEmail: recipient.email,
    toName: recipient.name,
    fromName: args.authorName,
    snippet,
    contextLabel: label,
  });
}

// ---------------------------------------------------------------------------
// Small shared reads
// ---------------------------------------------------------------------------

async function eventRow(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  eventId: string,
): Promise<EventRow | null> {
  const row = await ctx.db
    .query("buzzEvents")
    .withIndex("by_scope_event_id", (q) =>
      q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("eventId", eventId),
    )
    .first();
  // A deleted message notifies nobody. The 9005 that removed it is still in the
  // log; the content is not, and an email quoting a message that has been
  // retracted is the one delivery that cannot be taken back.
  return row && row.deletedAt === undefined ? row : null;
}

/** The event, in the shape the pure predicate reads. */
function toNotifyEvent(row: EventRow): NotifyEvent {
  return {
    id: row.eventId,
    pubkey: row.pubkey,
    kind: row.kind,
    created_at: row.createdAt,
    tags: row.tags,
    content: row.content,
  };
}

async function displayNameFor(
  ctx: QueryCtx | MutationCtx,
  principal: { type: "user" | "agent"; id: string } | null,
): Promise<string> {
  if (!principal) return "Someone";
  if (principal.type === "agent") {
    const agentId = ctx.db.normalizeId("agents", principal.id);
    const agent = agentId ? await ctx.db.get(agentId) : null;
    return agent?.name ?? "An agent";
  }
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", principal.id))
    .unique();
  return user?.name ?? user?.email ?? "Someone";
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * The two tables §7 needs, declared here rather than in `_tables.ts`.
 *
 * `_tables.ts` is being edited by three concurrent phases; a schema edit from
 * this one would be a merge conflict in the one file every Chat phase touches.
 * Folding them in is `...buzzNotificationTables` beside `...buzzTables` in
 * `convex/schema.ts` (or a spread inside `buzzTables`) and nothing else — no
 * migration, because there are no rows yet.
 */
export const buzzNotificationTables = {
  /**
   * One row per person. Absent means "never opened the settings screen", which
   * is the defaults — so there is no bootstrap and no row to create on signup.
   *
   * `settings` is stored as an opaque object and validated on **read** by
   * `normalizeNotificationSettings`, deliberately. Enumerating eight slots and
   * twelve sound names in the schema would put a second copy of the vocabulary
   * in a file that cannot import the first, and the day they disagree the
   * mutation refuses a write the UI just made. The normalizer is total, drops
   * what it does not know, and runs on every read including rows written by a
   * newer build — which is the actual guarantee wanted here.
   */
  buzzNotificationSettings: defineTable({
    userClerkId: v.string(),
    settings: v.any(),
    updatedAt: v.number(),
  }).index("by_user", ["userClerkId"]),

  /**
   * One row per (person, community, target). An unmute keeps the row and flips
   * the boolean — see `muteRow` for why deleting it breaks device sync.
   *
   * Scoped, unlike settings: muting #standup is a statement about one
   * community's #standup, and a channel id is only unique inside a scope.
   */
  buzzMutes: defineTable({
    userClerkId: v.string(),
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    targetType: v.union(v.literal("channel"), v.literal("thread")),
    /** A channel id, or a thread's root event id. */
    targetId: v.string(),
    muted: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_user_target", [
      "userClerkId",
      "scopeType",
      "scopeId",
      "targetType",
      "targetId",
    ])
    // Every mute in one community, for the predicate's relationship sets.
    .index("by_user_scope", ["userClerkId", "scopeType", "scopeId"]),
};
